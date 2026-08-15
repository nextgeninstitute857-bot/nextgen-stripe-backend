import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  abortContentR2Multipart,
  completeContentR2Multipart,
  createContentR2Multipart,
  deleteContentR2Object,
  headContentR2Object,
  listContentR2Parts,
  signContentR2UploadPart,
  uploadContentR2Part,
} from "./content-r2-storage.js";
import {
  contentUploadPurposeAllowed,
  normalizeContentUploadPurpose,
} from "./qbank-bulk-ingestion.js";

function statusError(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function cleanUploadId(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(clean)) throw statusError("Invalid upload ID");
  return clean;
}

function cleanFilename(value, purpose = "question_zip") {
  const clean = path.basename(String(value || "upload.zip").trim() || "upload.zip").slice(0, 240);
  const requiredExtension = purpose === "book_pdf" ? ".pdf" : ".zip";
  if (!clean.toLowerCase().endsWith(requiredExtension)) {
    throw statusError(`Only ${requiredExtension.toUpperCase().slice(1)} uploads are accepted for ${purpose}`);
  }
  return clean;
}

function cleanMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 32 * 1024) throw statusError("Upload metadata exceeds 32 KB", 413);
  return JSON.parse(serialized);
}

function ranges(indices) {
  if (!indices.length) return [];
  const result = [];
  let start = indices[0], end = indices[0];
  for (const index of indices.slice(1)) {
    if (index === end + 1) end = index;
    else { result.push({ start, end }); start = index; end = index; }
  }
  result.push({ start, end });
  return result;
}

export class CloudContentUploadStore {
  constructor({
    directory,
    maxUploadBytes = 50 * 1024 ** 3,
    partSize = 64 * 1024 ** 2,
    sessionTtlMs = 72 * 60 * 60 * 1000,
    now = () => new Date(),
  } = {}) {
    if (!directory) throw new Error("CloudContentUploadStore directory is required");
    this.directory = path.resolve(directory);
    this.maxUploadBytes = Math.max(5 * 1024 ** 2, Math.min(50 * 1024 ** 3, Number(maxUploadBytes) || 50 * 1024 ** 3));
    this.partSize = Math.max(5 * 1024 ** 2, Math.min(5 * 1024 ** 3, Number(partSize) || 64 * 1024 ** 2));
    this.sessionTtlMs = Math.max(60 * 60 * 1000, Math.min(30 * 24 * 60 * 60 * 1000, Number(sessionTtlMs) || 72 * 60 * 60 * 1000));
    this.now = now;
    this.locks = new Map();
  }

  async initialize() { await fs.mkdir(this.directory, { recursive: true }); return this; }
  sessionDir(id) { return path.join(this.directory, cleanUploadId(id)); }
  manifestFile(id) { return path.join(this.sessionDir(id), "manifest.json"); }

  async withLock(id, work) {
    const clean = cleanUploadId(id);
    const previous = this.locks.get(clean) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(clean, queued);
    await previous;
    try { return await work(); }
    finally { release(); if (this.locks.get(clean) === queued) this.locks.delete(clean); }
  }

  async read(id) {
    try { return JSON.parse(await fs.readFile(this.manifestFile(id), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") throw statusError("Upload session not found", 404);
      throw statusError("Upload session manifest is unreadable", 500);
    }
  }

  async write(session) {
    const directory = this.sessionDir(session.id);
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `manifest.${process.pid}.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(session, null, 2), { flag: "wx" });
    await fs.rename(temporary, this.manifestFile(session.id));
  }

  async remoteParts(session) {
    if (session.status !== "uploading") return Array.isArray(session.parts) ? session.parts : [];
    return listContentR2Parts({ objectKey: session.object_key, uploadId: session.r2_upload_id });
  }

  async publicSession(session, providedParts = null) {
    const parts = providedParts || await this.remoteParts(session);
    const received = parts.map((part) => Number(part.PartNumber) - 1).filter((index) => index >= 0).sort((a, b) => a - b);
    const receivedSet = new Set(received);
    const missing = Array.from({ length: Number(session.part_count) }, (_, index) => index).filter((index) => !receivedSet.has(index));
    return {
      id: session.id,
      transport: "r2_multipart",
      purpose: session.purpose,
      original_filename: session.original_filename,
      total_bytes: session.total_bytes,
      part_size: session.part_size,
      part_count: session.part_count,
      chunk_size: session.part_size,
      chunk_count: session.part_count,
      status: session.status,
      object_key: session.object_key,
      etag: session.etag || null,
      received_bytes: parts.reduce((sum, part) => sum + Number(part.Size || 0), 0),
      received_parts: received.length,
      received_indices: received,
      missing_ranges: ranges(missing),
      fingerprint: session.fingerprint || null,
      expected_sha256: session.expected_sha256 || null,
      active_leases: (session.leases || []).length,
      metadata: structuredClone(session.metadata || {}),
      created_by: session.created_by,
      created_at: session.created_at,
      updated_at: session.updated_at,
      finalized_at: session.finalized_at || null,
      expires_at: session.expires_at,
    };
  }

  async create({ originalFilename, totalBytes, expectedSha256 = "", purpose = "question_zip", createdBy = "", metadata = {} } = {}) {
    await this.initialize();
    const bytes = Number(totalBytes);
    if (!Number.isInteger(bytes) || bytes < 1) throw statusError("total_bytes must be a positive integer");
    if (bytes > this.maxUploadBytes) throw statusError("Upload exceeds the configured 50 GB direct-upload limit", 413);
    const cleanPurpose = normalizeContentUploadPurpose(purpose);
    const sha = String(expectedSha256 || "").trim().toLowerCase();
    if (sha && !/^[0-9a-f]{64}$/.test(sha)) throw statusError("SHA-256 must contain 64 hexadecimal characters");
    const id = crypto.randomUUID();
    const filename = cleanFilename(originalFilename, cleanPurpose);
    const objectKey = `content-staging/${id}/${filename}`;
    const effectivePartSize = Math.min(bytes, Math.max(this.partSize, Math.ceil(bytes / 10_000)));
    const created = await createContentR2Multipart({
      objectKey,
      contentType: cleanPurpose === "book_pdf" ? "application/pdf" : "application/zip",
      metadata: {
      upload_id: id, purpose: cleanPurpose, created_by: String(createdBy || "").slice(0, 120),
      },
    });
    const now = this.now();
    const session = {
      version: 2, id, transport: "r2_multipart", purpose: cleanPurpose,
      original_filename: filename, total_bytes: bytes, part_size: effectivePartSize,
      part_count: Math.ceil(bytes / effectivePartSize), expected_sha256: sha,
      object_key: objectKey, r2_upload_id: created.uploadId, status: "uploading", parts: [], fingerprint: "",
      leases: [], metadata: cleanMetadata(metadata), created_by: String(createdBy || "").slice(0, 200),
      created_at: now.toISOString(), updated_at: now.toISOString(), finalized_at: null,
      expires_at: new Date(now.getTime() + this.sessionTtlMs).toISOString(),
    };
    await fs.mkdir(this.sessionDir(id), { recursive: false });
    await this.write(session);
    return this.publicSession(session, []);
  }

  async signParts(id, indices = []) {
    return this.withLock(id, async () => {
      const session = await this.read(id);
      if (session.status !== "uploading") throw statusError(`Parts cannot be signed while upload status is ${session.status}`, 409);
      if (this.now().getTime() > Date.parse(session.expires_at)) throw statusError("Upload session has expired", 410);
      const clean = [...new Set(indices.map(Number))].filter(Number.isInteger);
      if (!clean.length || clean.length > 50) throw statusError("Provide between 1 and 50 part indices");
      if (clean.some((index) => index < 0 || index >= Number(session.part_count))) throw statusError("Part index is outside this upload", 416);
      const parts = await Promise.all(clean.map(async (index) => ({
        index,
        part_number: index + 1,
        bytes: Math.min(Number(session.part_size), Number(session.total_bytes) - index * Number(session.part_size)),
        url: await signContentR2UploadPart({ objectKey: session.object_key, uploadId: session.r2_upload_id, partNumber: index + 1 }),
      })));
      session.updated_at = this.now().toISOString();
      session.expires_at = new Date(this.now().getTime() + this.sessionTtlMs).toISOString();
      await this.write(session);
      return parts;
    });
  }

  async uploadPart(id, index, body, { contentLength } = {}) {
    return this.withLock(id, async () => {
      const session = await this.read(id);
      if (session.status !== "uploading") {
        throw statusError(`Parts cannot be uploaded while upload status is ${session.status}`, 409);
      }
      if (this.now().getTime() > Date.parse(session.expires_at)) {
        throw statusError("Upload session has expired", 410);
      }
      const cleanIndex = Number(index);
      if (!Number.isInteger(cleanIndex) || cleanIndex < 0 || cleanIndex >= Number(session.part_count)) {
        throw statusError("Part index is outside this upload", 416);
      }
      const expectedBytes = Math.min(
        Number(session.part_size),
        Number(session.total_bytes) - cleanIndex * Number(session.part_size),
      );
      if (Number(contentLength) !== expectedBytes) {
        throw statusError(`Part ${cleanIndex} must contain exactly ${expectedBytes} bytes`, 400);
      }
      const uploaded = await uploadContentR2Part({
        objectKey: session.object_key,
        uploadId: session.r2_upload_id,
        partNumber: cleanIndex + 1,
        body,
        contentLength: expectedBytes,
      });
      session.updated_at = this.now().toISOString();
      session.expires_at = new Date(this.now().getTime() + this.sessionTtlMs).toISOString();
      await this.write(session);
      return uploaded;
    });
  }

  async get(id) { const session = await this.read(id); return this.publicSession(session); }

  async finalize(id) {
    return this.withLock(id, async () => {
      const session = await this.read(id);
      if (session.status === "finalized") return { session: await this.publicSession(session), source: this.source(session), sha256: session.fingerprint, deduplicated: true };
      if (session.status !== "uploading") throw statusError(`Upload cannot be finalized from status ${session.status}`, 409);
      const parts = await this.remoteParts(session);
      if (parts.length !== Number(session.part_count)) throw statusError(`Upload is incomplete; ${Number(session.part_count) - parts.length} part(s) are missing`, 409);
      let total = 0;
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const expectedBytes = Math.min(Number(session.part_size), Number(session.total_bytes) - index * Number(session.part_size));
        if (Number(part.PartNumber) !== index + 1 || Number(part.Size) !== expectedBytes) throw statusError(`Uploaded part ${index} has the wrong size or sequence`, 409);
        total += Number(part.Size);
      }
      if (total !== Number(session.total_bytes)) throw statusError("Final upload size does not match total_bytes", 409);
      const head = await completeContentR2Multipart({ objectKey: session.object_key, uploadId: session.r2_upload_id, parts });
      if (head.sizeBytes !== Number(session.total_bytes)) throw statusError("Completed R2 object size does not match total_bytes", 409);
      session.status = "finalized";
      session.parts = parts;
      session.etag = head.etag;
      session.fingerprint = crypto.createHash("sha256").update(`${session.object_key}:${head.sizeBytes}:${head.etag}`).digest("hex");
      session.finalized_at = this.now().toISOString();
      session.updated_at = session.finalized_at;
      session.expires_at = new Date(this.now().getTime() + this.sessionTtlMs).toISOString();
      await this.write(session);
      return { session: await this.publicSession(session, parts), source: this.source(session), sha256: session.fingerprint, deduplicated: false };
    });
  }

  source(session) {
    return { type: "r2", objectKey: session.object_key, sizeBytes: Number(session.total_bytes), etag: session.etag || "" };
  }

  async resolveFinalized(id, { allowedPurposes = [] } = {}) {
    return this.withLock(id, async () => {
      const session = await this.read(id);
      if (session.status !== "finalized") throw statusError("Upload must be finalized before it can be imported", 409);
      if (!contentUploadPurposeAllowed(session.purpose, allowedPurposes)) {
        throw statusError("Upload purpose does not match this import", 409);
      }
      const head = await headContentR2Object(session.object_key).catch(() => null);
      if (!head || head.sizeBytes !== Number(session.total_bytes)) throw statusError("Finalized R2 upload is no longer available", 410);
      session.updated_at = this.now().toISOString();
      session.expires_at = new Date(this.now().getTime() + this.sessionTtlMs).toISOString();
      await this.write(session);
      return {
        uploadId: session.id, source: this.source(session), file: null, sha256: session.fingerprint,
        originalFilename: session.original_filename, fields: structuredClone(session.metadata || {}), owned: false,
      };
    });
  }

  async acquire(id, leaseId) {
    return this.withLock(id, async () => {
      const session = await this.read(id);
      session.leases ||= [];
      const lease = String(leaseId || "").trim();
      if (!lease) throw statusError("Lease ID is required");
      if (!session.leases.includes(lease)) session.leases.push(lease);
      session.updated_at = this.now().toISOString();
      session.expires_at = new Date(this.now().getTime() + this.sessionTtlMs).toISOString();
      await this.write(session);
      return this.publicSession(session);
    });
  }

  async release(id, leaseId) {
    return this.withLock(id, async () => {
      const session = await this.read(id);
      session.leases = (session.leases || []).filter((item) => item !== String(leaseId || "").trim());
      session.updated_at = this.now().toISOString();
      await this.write(session);
      return this.publicSession(session);
    });
  }

  async cancel(id) {
    return this.withLock(id, async () => {
      const session = await this.read(id);
      if ((session.leases || []).length) throw statusError("Upload is in use by a background job", 409);
      if (session.status === "uploading") await abortContentR2Multipart({ objectKey: session.object_key, uploadId: session.r2_upload_id }).catch(() => {});
      if (session.status === "finalized") await deleteContentR2Object(session.object_key).catch(() => {});
      session.status = "cancelled";
      session.updated_at = this.now().toISOString();
      await this.write(session);
      return this.publicSession(session, []);
    });
  }

  async list({ limit = 50 } = {}) {
    await this.initialize();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const session = await this.read(entry.name).catch(() => null);
      if (session) sessions.push(session);
    }
    sessions.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return Promise.all(sessions.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))).map((session) => this.publicSession(session).catch(() => ({ id: session.id, status: session.status }))));
  }

  async summary() {
    const uploads = await this.list({ limit: 200 });
    return uploads.reduce((result, upload) => {
      result.total += 1;
      result.by_status[upload.status] = (result.by_status[upload.status] || 0) + 1;
      result.staged_bytes += Number(upload.received_bytes || 0);
      return result;
    }, { transport: "r2_multipart", total: 0, staged_bytes: 0, by_status: {} });
  }

  async reconcileLeases(activeIds = []) {
    const active = new Set(activeIds.map(String));
    const uploads = await this.list({ limit: 200 });
    let released = 0;
    for (const upload of uploads) {
      const session = await this.read(upload.id).catch(() => null);
      if (!session) continue;
      const next = (session.leases || []).filter((lease) => active.has(String(lease)));
      released += (session.leases || []).length - next.length;
      if (next.length !== (session.leases || []).length) { session.leases = next; await this.write(session); }
    }
    return { released };
  }

  async cleanupExpired() {
    await this.initialize();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    let removed = 0, retained = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const session = await this.read(entry.name).catch(() => null);
      if (!session || (session.leases || []).length || Date.parse(session.expires_at) > this.now().getTime()) { retained += 1; continue; }
      if (session.status === "uploading") await abortContentR2Multipart({ objectKey: session.object_key, uploadId: session.r2_upload_id }).catch(() => {});
      if (session.status === "finalized") await deleteContentR2Object(session.object_key).catch(() => {});
      await fs.rm(this.sessionDir(entry.name), { recursive: true, force: true });
      removed += 1;
    }
    return { removed, retained };
  }
}
