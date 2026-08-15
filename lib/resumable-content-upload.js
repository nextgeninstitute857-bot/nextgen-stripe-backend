import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import {
  contentUploadPurposeAllowed,
  normalizeContentUploadPurpose,
} from "./qbank-bulk-ingestion.js";

function statusError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function cleanInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function cleanUploadId(value) {
  const clean = String(value || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(clean)) throw statusError("Invalid upload ID", 400);
  return clean.toLowerCase();
}

function cleanSha256(value, required = false) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean && !required) return "";
  if (!/^[0-9a-f]{64}$/.test(clean)) throw statusError("SHA-256 must contain 64 hexadecimal characters", 400);
  return clean;
}

function cleanFilename(value, purpose = "question_zip") {
  const clean = path.basename(String(value || "upload.zip").trim() || "upload.zip").slice(0, 240);
  const requiredExtension = purpose === "book_pdf" ? ".pdf" : ".zip";
  if (!clean.toLowerCase().endsWith(requiredExtension)) {
    throw statusError(`Only ${requiredExtension.toUpperCase().slice(1)} uploads are accepted for ${purpose}`, 400);
  }
  return clean;
}

function cleanMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 32 * 1024) throw statusError("Upload metadata exceeds 32 KB", 413);
  return JSON.parse(serialized);
}

function ranges(indices) {
  if (!indices.length) return [];
  const output = [];
  let start = indices[0];
  let end = indices[0];
  for (const index of indices.slice(1)) {
    if (index === end + 1) end = index;
    else { output.push({ start, end }); start = index; end = index; }
  }
  output.push({ start, end });
  return output;
}

function publicSession(session) {
  const chunkCount = Number(session.chunk_count || 0);
  const received = Object.keys(session.chunks || {}).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  const receivedSet = new Set(received);
  const missing = Array.from({ length: chunkCount }, (_, index) => index).filter((index) => !receivedSet.has(index));
  return {
    id: session.id,
    purpose: session.purpose,
    original_filename: session.original_filename,
    total_bytes: session.total_bytes,
    chunk_size: session.chunk_size,
    chunk_count: chunkCount,
    expected_sha256: session.expected_sha256 || null,
    final_sha256: session.final_sha256 || null,
    status: session.status,
    received_bytes: Object.values(session.chunks || {}).reduce((sum, chunk) => sum + Number(chunk.bytes || 0), 0),
    received_chunks: received.length,
    received_indices: received,
    missing_ranges: ranges(missing),
    active_leases: Array.isArray(session.leases) ? session.leases.length : 0,
    metadata: structuredClone(session.metadata || {}),
    created_by: session.created_by,
    created_at: session.created_at,
    updated_at: session.updated_at,
    finalized_at: session.finalized_at || null,
    expires_at: session.expires_at,
  };
}

export class ResumableContentUploadStore {
  constructor({
    directory,
    maxUploadBytes = 5 * 1024 ** 3,
    chunkSize = 8 * 1024 ** 2,
    maxChunkBytes = 16 * 1024 ** 2,
    sessionTtlMs = 48 * 60 * 60 * 1000,
    now = () => new Date(),
  } = {}) {
    if (!directory) throw new Error("ResumableContentUploadStore directory is required");
    this.directory = path.resolve(directory);
    this.maxUploadBytes = cleanInteger(maxUploadBytes, 5 * 1024 ** 3, 1024, 50 * 1024 ** 3);
    this.chunkSize = cleanInteger(chunkSize, 8 * 1024 ** 2, 256 * 1024, 64 * 1024 ** 2);
    this.maxChunkBytes = cleanInteger(maxChunkBytes, 16 * 1024 ** 2, this.chunkSize, 128 * 1024 ** 2);
    this.sessionTtlMs = cleanInteger(sessionTtlMs, 48 * 60 * 60 * 1000, 60 * 1000, 30 * 24 * 60 * 60 * 1000);
    this.now = now;
    this.locks = new Map();
  }

  async initialize() {
    await fs.mkdir(this.directory, { recursive: true });
    return this;
  }

  sessionDir(id) {
    return path.join(this.directory, cleanUploadId(id));
  }

  manifestFile(id) {
    return path.join(this.sessionDir(id), "manifest.json");
  }

  chunkFile(id, index) {
    return path.join(this.sessionDir(id), `chunk-${String(index).padStart(8, "0")}.part`);
  }

  finalFile(id, purpose = "question_zip") {
    return path.join(this.sessionDir(id), purpose === "book_pdf" ? "final.pdf" : "final.zip");
  }

  async withLock(id, work) {
    const clean = cleanUploadId(id);
    const previous = this.locks.get(clean) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(clean, queued);
    await previous;
    try { return await work(); }
    finally {
      release();
      if (this.locks.get(clean) === queued) this.locks.delete(clean);
    }
  }

  async read(id) {
    const clean = cleanUploadId(id);
    let session;
    try { session = JSON.parse(await fs.readFile(this.manifestFile(clean), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") throw statusError("Upload session not found", 404);
      throw statusError("Upload session manifest is unreadable", 500);
    }
    return session;
  }

  async write(session) {
    const directory = this.sessionDir(session.id);
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `manifest.${process.pid}.${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(session, null, 2), { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, this.manifestFile(session.id));
  }

  async create({ originalFilename, totalBytes, expectedSha256 = "", purpose = "question_zip", createdBy = "", metadata = {} } = {}) {
    await this.initialize();
    const bytes = cleanInteger(totalBytes, 0, 0, this.maxUploadBytes + 1);
    if (bytes < 1) throw statusError("total_bytes must be a positive integer", 400);
    if (bytes > this.maxUploadBytes) throw statusError("Upload exceeds the configured upload limit", 413);
    const cleanPurpose = normalizeContentUploadPurpose(purpose);
    const id = crypto.randomUUID();
    const nowIso = this.now().toISOString();
    const session = {
      version: 1,
      id,
      purpose: cleanPurpose,
      original_filename: cleanFilename(originalFilename, cleanPurpose),
      total_bytes: bytes,
      chunk_size: Math.min(this.chunkSize, bytes),
      chunk_count: Math.ceil(bytes / Math.min(this.chunkSize, bytes)),
      expected_sha256: cleanSha256(expectedSha256),
      final_sha256: "",
      status: "uploading",
      chunks: {},
      leases: [],
      metadata: cleanMetadata(metadata),
      created_by: String(createdBy || "").slice(0, 200),
      created_at: nowIso,
      updated_at: nowIso,
      finalized_at: null,
      expires_at: new Date(this.now().getTime() + this.sessionTtlMs).toISOString(),
    };
    await fs.mkdir(this.sessionDir(id), { recursive: false });
    await this.write(session);
    return publicSession(session);
  }

  expectedChunkBytes(session, index) {
    const start = index * Number(session.chunk_size);
    return Math.min(Number(session.chunk_size), Number(session.total_bytes) - start);
  }

  async writeChunk(id, indexValue, readable, { contentLength, expectedSha256 = "" } = {}) {
    await this.initialize();
    const index = cleanInteger(indexValue, -1, -1, Number.MAX_SAFE_INTEGER);
    if (index < 0) throw statusError("Chunk index must be a non-negative integer", 400);
    const length = Number(contentLength);
    if (!Number.isInteger(length) || length < 1) throw statusError("Content-Length is required for each chunk", 411);
    if (length > this.maxChunkBytes) throw statusError("Chunk exceeds the configured chunk limit", 413);
    const headerSha = cleanSha256(expectedSha256);
    return this.withLock(id, async () => {
      const session = await this.read(id);
      if (session.status !== "uploading") throw statusError(`Chunks cannot be added while upload status is ${session.status}`, 409);
      if (this.now().getTime() > Date.parse(session.expires_at)) throw statusError("Upload session has expired", 410);
      if (index >= Number(session.chunk_count)) throw statusError("Chunk index is outside this upload", 416);
      const expectedBytes = this.expectedChunkBytes(session, index);
      if (length !== expectedBytes) throw statusError(`Chunk ${index} must contain exactly ${expectedBytes} bytes`, 400);
      const existing = session.chunks?.[index];
      if (existing) {
        if (headerSha && headerSha === existing.sha256 && Number(existing.bytes) === length) {
          return { session: publicSession(session), chunk: { index, ...existing }, deduplicated: true };
        }
        throw statusError("Chunk already exists with different content", 409);
      }

      const target = this.chunkFile(id, index);
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      const hash = crypto.createHash("sha256");
      let received = 0;
      const output = fsSync.createWriteStream(temporary, { flags: "wx" });
      try {
        for await (const chunk of readable) {
          received += chunk.length;
          if (received > expectedBytes || received > this.maxChunkBytes) throw statusError("Chunk body is larger than declared", 413);
          hash.update(chunk);
          if (!output.write(chunk)) await once(output, "drain");
        }
        output.end();
        await once(output, "close");
        if (received !== expectedBytes) throw statusError(`Chunk body ended at ${received} bytes; expected ${expectedBytes}`, 400);
        const digest = hash.digest("hex");
        if (headerSha && digest !== headerSha) throw statusError("Chunk SHA-256 does not match", 409);
        await fs.rename(temporary, target);
        session.chunks ||= {};
        session.chunks[index] = { bytes: received, sha256: digest, received_at: this.now().toISOString() };
        session.updated_at = this.now().toISOString();
        session.expires_at = new Date(this.now().getTime() + this.sessionTtlMs).toISOString();
        await this.write(session);
        return { session: publicSession(session), chunk: { index, ...session.chunks[index] }, deduplicated: false };
      } catch (error) {
        output.destroy();
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    });
  }

  async get(id) {
    return publicSession(await this.read(id));
  }

  async finalize(id, { expectedSha256 = "" } = {}) {
    await this.initialize();
    return this.withLock(id, async () => {
      const session = await this.read(id);
      if (session.status === "finalized") {
        await fs.access(this.finalFile(id, session.purpose)).catch(() => { throw statusError("Finalized upload file is missing", 410); });
        return { session: publicSession(session), file: this.finalFile(id, session.purpose), sha256: session.final_sha256, deduplicated: true };
      }
      if (session.status !== "uploading") throw statusError(`Upload cannot be finalized from status ${session.status}`, 409);
      if (this.now().getTime() > Date.parse(session.expires_at)) throw statusError("Upload session has expired", 410);
      const missing = Array.from({ length: Number(session.chunk_count) }, (_, index) => index).filter((index) => !session.chunks?.[index]);
      if (missing.length) throw statusError(`Upload is incomplete; ${missing.length} chunk(s) are missing`, 409);

      const finalPath = this.finalFile(id, session.purpose);
      const temporary = `${finalPath}.${crypto.randomUUID()}.part`;
      const output = fsSync.createWriteStream(temporary, { flags: "wx" });
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      try {
        for (let index = 0; index < Number(session.chunk_count); index += 1) {
          for await (const chunk of fsSync.createReadStream(this.chunkFile(id, index))) {
            bytes += chunk.length;
            if (bytes > Number(session.total_bytes)) throw statusError("Finalized upload is larger than declared", 409);
            hash.update(chunk);
            if (!output.write(chunk)) await once(output, "drain");
          }
        }
        output.end();
        await once(output, "close");
        if (bytes !== Number(session.total_bytes)) throw statusError("Finalized upload size does not match total_bytes", 409);
        const digest = hash.digest("hex");
        const requestedSha = cleanSha256(expectedSha256) || session.expected_sha256;
        if (requestedSha && digest !== requestedSha) throw statusError("Final upload SHA-256 does not match", 409);
        await fs.rename(temporary, finalPath);
        session.status = "finalized";
        session.final_sha256 = digest;
        session.finalized_at = this.now().toISOString();
        session.updated_at = session.finalized_at;
        session.expires_at = new Date(this.now().getTime() + this.sessionTtlMs).toISOString();
        await this.write(session);
        await Promise.all(Object.keys(session.chunks || {}).map((index) => fs.unlink(this.chunkFile(id, Number(index))).catch(() => {})));
        return { session: publicSession(session), file: finalPath, sha256: digest, deduplicated: false };
      } catch (error) {
        output.destroy();
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    });
  }

  async resolveFinalized(id, { allowedPurposes = [] } = {}) {
    return this.withLock(id, async () => {
      const session = await this.read(id);
      if (session.status !== "finalized") throw statusError("Upload must be finalized before it can be imported", 409);
      if (this.now().getTime() > Date.parse(session.expires_at)) throw statusError("Upload session has expired", 410);
      if (!contentUploadPurposeAllowed(session.purpose, allowedPurposes)) {
        throw statusError("Upload purpose does not match this import", 409);
      }
      const file = this.finalFile(id, session.purpose);
      await fs.access(file).catch(() => { throw statusError("Finalized upload file is no longer available", 410); });
      session.updated_at = this.now().toISOString();
      session.expires_at = new Date(this.now().getTime() + this.sessionTtlMs).toISOString();
      await this.write(session);
      return {
        uploadId: session.id,
        file,
        sha256: session.final_sha256,
        originalFilename: session.original_filename,
        fields: structuredClone(session.metadata || {}),
        owned: false,
      };
    });
  }

  async acquire(id, leaseId) {
    return this.withLock(id, async () => {
      const session = await this.read(id);
      const cleanLease = String(leaseId || "").trim();
      if (!cleanLease) throw statusError("Lease ID is required", 400);
      session.leases ||= [];
      if (!session.leases.includes(cleanLease)) session.leases.push(cleanLease);
      session.updated_at = this.now().toISOString();
      session.expires_at = new Date(this.now().getTime() + this.sessionTtlMs).toISOString();
      await this.write(session);
      return publicSession(session);
    });
  }

  async release(id, leaseId) {
    return this.withLock(id, async () => {
      const session = await this.read(id);
      session.leases = (session.leases || []).filter((item) => item !== String(leaseId || "").trim());
      session.updated_at = this.now().toISOString();
      await this.write(session);
      return publicSession(session);
    });
  }

  async cancel(id) {
    return this.withLock(id, async () => {
      const session = await this.read(id);
      if ((session.leases || []).length) throw statusError("Upload is in use by a background job", 409);
      session.status = "cancelled";
      session.updated_at = this.now().toISOString();
      await this.write(session);
      const directory = this.sessionDir(id);
      await fs.rm(directory, { recursive: true, force: true });
      return { id: session.id, status: "cancelled", recoverable: false };
    });
  }

  async list({ limit = 100 } = {}) {
    await this.initialize();
    const safeLimit = cleanInteger(limit, 100, 1, 500);
    const entries = await fs.readdir(this.directory, { withFileTypes: true }).catch(() => []);
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      try { sessions.push(publicSession(await this.read(entry.name))); }
      catch {}
      if (sessions.length >= safeLimit) break;
    }
    return sessions.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  async summary() {
    const sessions = await this.list({ limit: 500 });
    const counts = {};
    let receivedBytes = 0;
    for (const session of sessions) {
      counts[session.status] = Number(counts[session.status] || 0) + 1;
      receivedBytes += Number(session.received_bytes || 0);
    }
    return { sessions: sessions.length, counts, received_bytes: receivedBytes, active_leases: sessions.reduce((sum, row) => sum + row.active_leases, 0) };
  }

  async reconcileLeases(activeLeaseIds = [], { graceMs = 5 * 60 * 1000 } = {}) {
    const active = new Set([...activeLeaseIds].map((value) => String(value)));
    const sessions = await this.list({ limit: 500 });
    let removed = 0;
    for (const session of sessions) {
      if (!session.active_leases) continue;
      await this.withLock(session.id, async () => {
        const current = await this.read(session.id).catch(() => null);
        if (!current) return;
        const before = current.leases || [];
        const withinGrace = this.now().getTime() - Date.parse(current.updated_at || current.created_at || 0) < graceMs;
        current.leases = before.filter((lease) => active.has(String(lease)) || withinGrace);
        if (current.leases.length === before.length) return;
        removed += before.length - current.leases.length;
        current.updated_at = this.now().toISOString();
        await this.write(current);
      });
    }
    return { checked: sessions.length, removed };
  }

  async cleanupExpired() {
    const sessions = await this.list({ limit: 500 });
    let removed = 0;
    for (const session of sessions) {
      if (session.active_leases || Date.parse(session.expires_at) > this.now().getTime()) continue;
      await this.withLock(session.id, async () => {
        const current = await this.read(session.id).catch(() => null);
        if (!current || (current.leases || []).length || Date.parse(current.expires_at) > this.now().getTime()) return;
        await fs.rm(this.sessionDir(session.id), { recursive: true, force: true });
        removed += 1;
      });
    }
    return { checked: sessions.length, removed };
  }
}
