#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  MIXED_QBANK_UPLOAD_PURPOSE,
  normalizeBulkQbankManifest,
} from "../lib/qbank-bulk-ingestion.js";

const PREVIEW_TERMINAL = new Set([
  "preview_ready",
  "preview_with_warnings",
  "failed",
  "preview_failed",
  "preview_retrying",
  "preview_queue_failed",
]);
const DRAFT_TERMINAL = new Set([
  "draft_imported",
  "draft_imported_with_warnings",
  "failed",
  "draft_import_failed",
  "draft_import_retrying",
]);
const MEDIA_TERMINAL = new Set([
  "draft_imported",
  "draft_imported_with_warnings",
  "failed",
  "draft_import_failed",
  "draft_import_retrying",
  "queue_failed",
]);
const SUCCESSFUL_DRAFT = new Set([
  "draft_imported",
  "draft_imported_with_warnings",
]);

function argumentValue(name, fallback = "") {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasArgument(name) {
  return process.argv.includes(name)
    || process.argv.some((value) => value.startsWith(`${name}=`));
}

function usage() {
  return [
    "Usage:",
    "  node scripts/run-qbank-bulk-draft-import.mjs --manifest /path/to/manifest.json",
    "  node scripts/run-qbank-bulk-draft-import.mjs --manifest /path/to/manifest.json --execute-private-drafts",
    "",
    "Execution requires AYLAMED_CRM_BASE_URL and AYLAMED_CRM_ADMIN_TOKEN.",
    "Without --execute-private-drafts this command only validates local ZIP files and rights metadata.",
    "It never approves collections, enables student destinations, publishes content, or writes directly to PostgreSQL.",
  ].join("\n");
}

function statusError(message, statusCode = 400, code = "QBANK_BULK_RUN_FAILED") {
  return Object.assign(new Error(message), { statusCode, code });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cleanBaseUrl(value = "") {
  const clean = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(clean)) {
    throw statusError("AYLAMED_CRM_BASE_URL must be an absolute HTTP(S) URL");
  }
  return clean;
}

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

async function sha256File(filename) {
  const handle = await fs.open(filename, "r");
  const hash = crypto.createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function readJson(filename, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== null) return structuredClone(fallback);
    throw error;
  }
}

async function writeState(filename, state) {
  const directory = path.dirname(filename);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  await fs.writeFile(temporary, `${safeJson(state)}\n`, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, filename);
}

function resolveBankPaths(manifest, manifestDirectory) {
  return {
    ...manifest,
    banks: manifest.banks.map((bank) => ({
      ...bank,
      bundle_zip: path.resolve(manifestDirectory, bank.bundle_zip),
    })),
  };
}

async function inspectLocalBanks(manifest) {
  const inspected = [];
  for (const bank of manifest.banks) {
    const stat = await fs.stat(bank.bundle_zip).catch(() => null);
    if (!stat?.isFile()) {
      throw statusError(`Prepared ZIP is missing: ${bank.bundle_zip}`, 404, "QBANK_ZIP_NOT_FOUND");
    }
    if (stat.size < 1) {
      throw statusError(`Prepared ZIP is empty: ${bank.bundle_zip}`, 400, "QBANK_ZIP_EMPTY");
    }
    const headerHandle = await fs.open(bank.bundle_zip, "r");
    try {
      const header = Buffer.alloc(4);
      await headerHandle.read(header, 0, header.length, 0);
      if (header[0] !== 0x50 || header[1] !== 0x4b) {
        throw statusError(
          `Prepared bundle is not a ZIP file: ${bank.bundle_zip}`,
          400,
          "QBANK_INVALID_ZIP_HEADER",
        );
      }
    } finally {
      await headerHandle.close().catch(() => {});
    }
    inspected.push({
      ...bank,
      total_bytes: stat.size,
      sha256: await sha256File(bank.bundle_zip),
    });
  }
  return { ...manifest, banks: inspected };
}

function createApi({ baseUrl, token }) {
  async function request(endpoint, {
    method = "GET",
    body,
    headers = {},
  } = {}) {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { error: text || `HTTP ${response.status}` }; }
    if (!response.ok || payload.success === false) {
      throw statusError(
        payload.error || `Request failed with HTTP ${response.status}`,
        response.status,
        payload.code || "QBANK_API_REQUEST_FAILED",
      );
    }
    return payload;
  }
  return request;
}

async function retry(operation, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || (Number(error.statusCode) >= 400 && Number(error.statusCode) < 500
        && ![408, 409, 425, 429].includes(Number(error.statusCode)))) {
        throw error;
      }
      await wait(Math.min(12_000, 750 * (2 ** (attempt - 1))));
    }
  }
  throw lastError;
}

async function readFileRange(filename, start, length) {
  const handle = await fs.open(filename, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead !== length) {
      throw statusError(`Read ${bytesRead} bytes from ${filename}; expected ${length}`);
    }
    return buffer;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function getUsableUpload({ api, bank, savedUploadId }) {
  if (!savedUploadId) return null;
  try {
    const result = await api(`/admin/crm/ai-training/content-uploads/${savedUploadId}`);
    const upload = result.upload;
    if (
      Number(upload?.total_bytes) === Number(bank.total_bytes)
      && upload?.original_filename === path.basename(bank.bundle_zip)
      && upload?.purpose === MIXED_QBANK_UPLOAD_PURPOSE
      && upload?.expected_sha256 === bank.sha256
      && ["uploading", "finalized"].includes(String(upload?.status || ""))
    ) {
      return upload;
    }
  } catch (error) {
    if (![404, 410].includes(Number(error.statusCode))) throw error;
  }
  return null;
}

async function uploadPreparedBundle({ api, bank, bankState, onState }) {
  let upload = await getUsableUpload({
    api,
    bank,
    savedUploadId: bankState.upload_id,
  });
  if (!upload) {
    const created = await api("/admin/crm/ai-training/content-uploads", {
      method: "POST",
      body: {
        original_filename: path.basename(bank.bundle_zip),
        total_bytes: bank.total_bytes,
        sha256: bank.sha256,
        purpose: MIXED_QBANK_UPLOAD_PURPOSE,
        metadata: {
          exam_track: bank.exam_track,
          source_namespace: bank.source_namespace,
          source_provider: bank.source_provider,
          source_profile: bank.source_profile,
          source_rights_status: bank.source_rights_status,
          collection_title: bank.collection_title,
          destinations: bank.destinations,
        },
      },
    });
    upload = created.upload;
    if (!upload?.id) throw statusError("The backend did not return an upload ID");
    bankState.upload_id = upload.id;
    await onState();
  }
  if (upload.status === "finalized") return upload;
  if (upload.transport !== "r2_multipart") {
    throw statusError("The v238 bulk runner requires direct R2 multipart uploads");
  }

  const received = new Set((upload.received_indices || []).map(Number));
  const missing = Array.from(
    { length: Number(upload.part_count || 0) },
    (_, index) => index,
  ).filter((index) => !received.has(index));
  for (const index of missing) {
    const indices = [index];
    const signed = await retry(() => api(
      `/admin/crm/ai-training/content-uploads/${upload.id}/parts/presign`,
      { method: "POST", body: { indices } },
    ));
    const part = (signed.parts || []).find((row) => Number(row.index) === index);
    if (!part?.url) throw statusError(`Upload part ${index + 1} could not be signed`);
    const start = index * Number(upload.part_size);
    const bytes = Number(part.bytes)
      || Math.min(Number(upload.part_size), Number(upload.total_bytes) - start);
    const body = await readFileRange(bank.bundle_zip, start, bytes);
    await retry(async () => {
      const response = await fetch(part.url, {
        method: "PUT",
        headers: { "Content-Length": String(body.length) },
        body,
      });
      if (!response.ok) {
        throw statusError(
          `R2 part ${index + 1} failed with HTTP ${response.status}`,
          response.status,
        );
      }
    });
  }
  const finalized = await api(
    `/admin/crm/ai-training/content-uploads/${upload.id}/finalize`,
    { method: "POST", body: { sha256: bank.sha256 } },
  );
  return finalized.upload;
}

async function pollDomainJob({
  api,
  endpoint,
  terminalStatuses,
  label,
  pollMilliseconds,
  maximumMinutes,
}) {
  const deadline = Date.now() + maximumMinutes * 60_000;
  while (Date.now() < deadline) {
    const result = await api(endpoint);
    const job = result.job;
    if (!job) throw statusError(`${label} did not return a job`);
    if (terminalStatuses.has(String(job.status || ""))) return { ...result, job };
    await wait(pollMilliseconds);
  }
  throw statusError(`${label} did not finish within ${maximumMinutes} minutes`, 408);
}

function assertPreviewCanImport(job) {
  if (!["preview_ready", "preview_with_warnings"].includes(String(job?.status || ""))) {
    throw statusError(`Question preview stopped in status ${job?.status || "unknown"}`, 409);
  }
  if (job.counts?.import_blocked === true || Number(job.counts?.blocking_issues || 0) > 0) {
    throw statusError(
      "The preview contains a specialized-format or exam-mapping blocker and cannot enter the ordinary MCQ importer",
      409,
      "QBANK_PREVIEW_BLOCKED",
    );
  }
}

async function runBank({
  api,
  bank,
  bankState,
  onState,
  pollMilliseconds,
  maximumMinutes,
  applySafeLinkRepairs,
}) {
  const upload = await uploadPreparedBundle({ api, bank, bankState, onState });
  bankState.upload_id = upload.id;
  bankState.upload_status = upload.status;
  await onState();

  let questionResult;
  if (bankState.question_job_id) {
    questionResult = await pollDomainJob({
      api,
      endpoint: `/admin/crm/ai-training/content-imports/${bankState.question_job_id}`,
      terminalStatuses: new Set([...PREVIEW_TERMINAL, ...DRAFT_TERMINAL]),
      label: `${bank.collection_title} question workflow`,
      pollMilliseconds,
      maximumMinutes,
    });
  } else {
    const preview = await api("/admin/crm/ai-training/content-imports/preview", {
      method: "POST",
      body: {
        upload_id: upload.id,
        exam_track: bank.exam_track,
        source_namespace: bank.source_namespace,
        source_provider: bank.source_provider,
        source_profile: bank.source_profile,
        source_rights_status: bank.source_rights_status,
        collection_title: bank.collection_title,
        destinations: bank.destinations,
      },
    });
    bankState.question_job_id = preview.job_id;
    await onState();
    questionResult = await pollDomainJob({
      api,
      endpoint: `/admin/crm/ai-training/content-imports/${preview.job_id}`,
      terminalStatuses: PREVIEW_TERMINAL,
      label: `${bank.collection_title} preview`,
      pollMilliseconds,
      maximumMinutes,
    });
  }

  let questionJob = questionResult.job;
  if (["preview_ready", "preview_with_warnings"].includes(String(questionJob.status || ""))) {
    bankState.preview_counts = structuredClone(questionJob.counts || {});
    assertPreviewCanImport(questionJob);
    await api(`/admin/crm/ai-training/content-imports/${questionJob.id}/import-draft`, {
      method: "POST",
      body: { upload_id: upload.id },
    });
    questionResult = await pollDomainJob({
      api,
      endpoint: `/admin/crm/ai-training/content-imports/${questionJob.id}`,
      terminalStatuses: DRAFT_TERMINAL,
      label: `${bank.collection_title} private draft import`,
      pollMilliseconds,
      maximumMinutes,
    });
    questionJob = questionResult.job;
  }
  if (!SUCCESSFUL_DRAFT.has(String(questionJob.status || ""))) {
    throw statusError(
      `${bank.collection_title} question import stopped in status ${questionJob.status || "unknown"}`,
      409,
    );
  }
  bankState.question_status = questionJob.status;
  await onState();

  const previewCounts = bankState.preview_counts || {};
  const packagedImages = Number(previewCounts.packaged_image_references || 0);
  const packagedAudio = Number(previewCounts.packaged_audio_references || 0);
  if (bank.attach_media && packagedImages + packagedAudio > 0) {
    let mediaResult;
    if (!bankState.media_job_id) {
      const started = await api(
        `/admin/crm/ai-training/content-imports/${questionJob.id}/media/import-draft`,
        { method: "POST", body: { upload_id: upload.id } },
      );
      bankState.media_job_id = started.media_job_id;
      await onState();
    }
    mediaResult = await pollDomainJob({
      api,
      endpoint: `/admin/crm/ai-training/content-media-imports/${bankState.media_job_id}`,
      terminalStatuses: MEDIA_TERMINAL,
      label: `${bank.collection_title} private media import`,
      pollMilliseconds,
      maximumMinutes,
    });
    if (!SUCCESSFUL_DRAFT.has(String(mediaResult.job.status || ""))) {
      throw statusError(
        `${bank.collection_title} media import stopped in status ${mediaResult.job.status || "unknown"}`,
        409,
      );
    }
    bankState.media_status = mediaResult.job.status;
    if (applySafeLinkRepairs) {
      const audited = await api(
        `/admin/crm/ai-training/content-media-imports/${bankState.media_job_id}/mapping-audit`,
      );
      bankState.media_audit = audited.audit || {};
      const repairable = Number(audited.audit?.repairable_links || 0);
      if (repairable > 0) {
        const repaired = await api(
          `/admin/crm/ai-training/content-media-imports/${bankState.media_job_id}/reconcile-draft-links`,
          {
            method: "POST",
            body: { audit_fingerprint: audited.audit.audit_fingerprint },
          },
        );
        bankState.media_links_repaired = Number(repaired.repair?.links_created || 0);
      }
    }
    await onState();
  } else {
    bankState.media_status = "skipped_no_packaged_image_or_audio_references";
  }

  const packagedVideos = Number(previewCounts.packaged_video_references || 0);
  if (bank.import_packaged_videos && packagedVideos > 0) {
    if (!bankState.video_job_id) {
      const started = await api(
        `/admin/crm/ai-training/content-imports/${questionJob.id}/videos/import-draft`,
        { method: "POST", body: { upload_id: upload.id } },
      );
      bankState.video_job_id = started.video_job_id;
      await onState();
    }
    const videoResult = await pollDomainJob({
      api,
      endpoint: `/admin/crm/ai-training/content-video-imports/${bankState.video_job_id}`,
      terminalStatuses: MEDIA_TERMINAL,
      label: `${bank.collection_title} private video import`,
      pollMilliseconds,
      maximumMinutes,
    });
    if (!SUCCESSFUL_DRAFT.has(String(videoResult.job.status || ""))) {
      throw statusError(
        `${bank.collection_title} video import stopped in status ${videoResult.job.status || "unknown"}`,
        409,
      );
    }
    bankState.video_status = videoResult.job.status;
  } else {
    bankState.video_status = packagedVideos > 0
      ? "skipped_by_manifest"
      : "skipped_no_packaged_video_references";
  }
  bankState.completed_at = new Date().toISOString();
  await onState();
  return bankState;
}

async function main() {
  if (hasArgument("--help") || hasArgument("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const manifestArgument = argumentValue("--manifest");
  if (!manifestArgument) throw statusError(`--manifest is required\n\n${usage()}`);
  const manifestFile = path.resolve(manifestArgument);
  const manifestDirectory = path.dirname(manifestFile);
  const rawManifest = await readJson(manifestFile);
  const normalized = resolveBankPaths(
    normalizeBulkQbankManifest(rawManifest),
    manifestDirectory,
  );
  const inspected = await inspectLocalBanks(normalized);
  const execute = hasArgument("--execute-private-drafts");
  if (!execute) {
    process.stdout.write(`${safeJson({
      mode: "dry_run",
      network_requests: 0,
      production_writes: 0,
      rights_verified: inspected.rights_verified,
      banks: inspected.banks.map((bank) => ({
        collection_title: bank.collection_title,
        exam_track: bank.exam_track,
        source_profile: bank.source_profile,
        source_rights_status: bank.source_rights_status,
        bundle_zip: bank.bundle_zip,
        total_bytes: bank.total_bytes,
        sha256: bank.sha256,
        destinations: bank.destinations,
      })),
    })}\n`);
    return;
  }

  const executableManifest = inspected;
  const baseUrl = cleanBaseUrl(
    argumentValue("--base-url", process.env.AYLAMED_CRM_BASE_URL),
  );
  const token = String(process.env.AYLAMED_CRM_ADMIN_TOKEN || "").trim();
  if (!token) throw statusError("AYLAMED_CRM_ADMIN_TOKEN is required for execution", 401);
  const stateFile = path.resolve(argumentValue(
    "--state-file",
    path.join(
      os.tmpdir(),
      `aylamed-v238-${crypto.createHash("sha1").update(manifestFile).digest("hex")}.state.json`,
    ),
  ));
  const state = await readJson(stateFile, {
    version: "v238",
    manifest_file: manifestFile,
    created_at: new Date().toISOString(),
    banks: {},
  });
  const api = createApi({ baseUrl, token });
  const pollMilliseconds = Math.max(
    1_000,
    Math.min(30_000, Number(argumentValue("--poll-ms", "3000")) || 3_000),
  );
  const maximumMinutes = Math.max(
    5,
    Math.min(24 * 60, Number(argumentValue("--max-minutes", "720")) || 720),
  );

  let stateWrite = Promise.resolve();
  const persist = () => {
    const snapshot = structuredClone(state);
    const write = stateWrite.then(() => writeState(stateFile, snapshot));
    stateWrite = write.catch(() => {});
    return write;
  };
  const queue = [...executableManifest.banks];
  let stopAfterCurrentBanks = false;
  let firstError = null;
  const worker = async () => {
    while (!stopAfterCurrentBanks && queue.length) {
      const bank = queue.shift();
      if (!bank) return;
      const key = `${bank.exam_track}:${bank.source_namespace}`;
      state.banks[key] ||= {
        collection_title: bank.collection_title,
        exam_track: bank.exam_track,
        source_namespace: bank.source_namespace,
        started_at: new Date().toISOString(),
      };
      try {
        await runBank({
          api,
          bank,
          bankState: state.banks[key],
          onState: persist,
          pollMilliseconds,
          maximumMinutes,
          applySafeLinkRepairs: executableManifest.apply_safe_link_repairs,
        });
      } catch (error) {
        state.banks[key].failed_at = new Date().toISOString();
        state.banks[key].error = {
          message: error.message,
          code: error.code || "QBANK_BULK_RUN_FAILED",
          status: Number(error.statusCode || 0),
        };
        await persist();
        firstError ||= error;
        stopAfterCurrentBanks = true;
        return;
      }
    }
  };
  await Promise.allSettled(Array.from(
    { length: executableManifest.concurrency },
    () => worker(),
  ));
  await stateWrite;
  if (firstError) throw firstError;
  state.completed_at = new Date().toISOString();
  await persist();
  process.stdout.write(`${safeJson({
    success: true,
    mode: "private_draft_only",
    state_file: stateFile,
    safeguards: {
      collections_approved: 0,
      student_destinations_enabled: 0,
      direct_database_writes: 0,
      one_prepared_zip_reused_per_bank: true,
    },
    banks: state.banks,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${safeJson({
    success: false,
    code: error.code || "QBANK_BULK_RUN_FAILED",
    status: Number(error.statusCode || 1),
    error: error.message || String(error),
  })}\n`);
  process.exitCode = 1;
});
