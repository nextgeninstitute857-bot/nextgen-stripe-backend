import crypto from "node:crypto";

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

function positiveNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function mediaAcceleratorConfig(source = process.env) {
  return {
    concurrency: boundedInteger(source.NEXTGEN_CONTENT_MEDIA_CONCURRENCY, 4, 1, 8),
    checkpoint_batch_size: boundedInteger(source.NEXTGEN_CONTENT_MEDIA_CHECKPOINT_BATCH_SIZE, 25, 1, 250),
    checkpoint_interval_ms: boundedInteger(source.NEXTGEN_CONTENT_MEDIA_CHECKPOINT_INTERVAL_MS, 5_000, 1_000, 60_000),
    progress_interval_ms: boundedInteger(source.NEXTGEN_CONTENT_MEDIA_PROGRESS_INTERVAL_MS, 15_000, 5_000, 60_000),
  };
}

function normalizedReference(reference = {}) {
  return [
    String(reference.questionId || ""),
    String(reference.mediaRef || "").trim().replace(/\\/g, "/").toLowerCase(),
    String(reference.placement || ""),
  ].join("\u0000");
}

export function mediaInventoryCacheKey({ zipSha256 = "", references = [] } = {}) {
  const hash = crypto.createHash("sha256");
  hash.update(String(zipSha256 || "").trim().toLowerCase());
  const rows = (Array.isArray(references) ? references : [])
    .map(normalizedReference)
    .sort();
  for (const row of rows) hash.update("\n").update(row);
  return hash.digest("hex");
}

function normalizedInventory(value = {}) {
  const candidateEntries = positiveNumber(value.candidateEntries ?? value.candidate_entries);
  const candidateUncompressedBytes = positiveNumber(
    value.candidateUncompressedBytes ?? value.candidate_uncompressed_bytes,
  );
  if (!candidateEntries || !candidateUncompressedBytes) return null;
  return {
    entries: Math.max(candidateEntries, positiveNumber(value.entries, candidateEntries)),
    uncompressedBytes: Math.max(
      candidateUncompressedBytes,
      positiveNumber(value.uncompressedBytes ?? value.uncompressed_bytes, candidateUncompressedBytes),
    ),
    candidateEntries,
    candidateUncompressedBytes,
  };
}

export function resolveMediaInventoryCheckpoint(checkpoint = {}, cacheKey = "") {
  const stored = checkpoint?.media_inventory;
  const current = normalizedInventory(stored);
  if (current && String(stored.cache_key || "") === String(cacheKey || "")) {
    return { inventory: current, source: "validated_cache" };
  }

  // Version-2 media jobs predate the explicit inventory cache. Their totals
  // belong to the same immutable ZIP and domain job, so they are safe to adopt
  // once by the recovering handler and then upgrade to a keyed checkpoint.
  const legacy = normalizedInventory({
    candidate_entries: checkpoint?.files_total,
    candidate_uncompressed_bytes: checkpoint?.bytes_total,
  });
  if (legacy && Number(checkpoint?.version || 0) === 2) {
    return { inventory: legacy, source: "legacy_v2_totals" };
  }
  return { inventory: null, source: "miss" };
}

export function buildMediaCheckpoint({
  previous = {},
  cacheKey,
  inventory,
  progress = {},
} = {}) {
  const normalized = normalizedInventory(inventory);
  if (!normalized) throw new Error("A valid media inventory is required for a durable checkpoint");
  return {
    ...previous,
    version: 3,
    media_inventory: {
      cache_key: String(cacheKey || ""),
      entries: normalized.entries,
      uncompressed_bytes: normalized.uncompressedBytes,
      candidate_entries: normalized.candidateEntries,
      candidate_uncompressed_bytes: normalized.candidateUncompressedBytes,
    },
    media_entry_index: Math.max(0, Number(progress.media_entry_index || previous.media_entry_index || 0)),
    files_processed: Math.max(0, Number(progress.files_processed || 0)),
    files_total: normalized.candidateEntries,
    bytes_processed: Math.max(0, Number(progress.bytes_processed || 0)),
    bytes_total: normalized.candidateUncompressedBytes,
  };
}

export function mediaFinalizationConfig(source = process.env) {
  return {
    batch_size: boundedInteger(
      source.NEXTGEN_CONTENT_MEDIA_FINALIZATION_BATCH_SIZE,
      250,
      25,
      1_000,
    ),
  };
}

export function mediaFinalizationCacheKey({
  mediaJobId = "",
  inventoryCacheKey = "",
} = {}) {
  return crypto.createHash("sha256")
    .update("content-media-finalization-v1\n")
    .update(String(mediaJobId || ""))
    .update("\n")
    .update(String(inventoryCacheKey || ""))
    .digest("hex");
}

export function resolveMediaFinalizationCheckpoint(
  checkpoint = {},
  cacheKey = "",
  assetsTotal = 0,
) {
  const stored = checkpoint?.media_finalization;
  const safeTotal = Math.max(0, Math.floor(Number(assetsTotal || 0)));
  const valid = stored
    && Number(stored.version || 0) === 1
    && String(stored.cache_key || "") === String(cacheKey || "")
    && Math.max(0, Math.floor(Number(stored.assets_total || 0))) === safeTotal;
  if (!valid) {
    return {
      source: "miss",
      assetsTotal: safeTotal,
      assetsCommitted: 0,
      linksVerified: 0,
      linksCreated: 0,
      linkConflicts: 0,
      duplicateObjects: 0,
      batchesCommitted: 0,
      batchSize: 0,
      completed: false,
    };
  }
  const assetsCommitted = Math.max(
    0,
    Math.min(safeTotal, Math.floor(Number(stored.assets_committed || 0))),
  );
  return {
    source: "validated_cache",
    assetsTotal: safeTotal,
    assetsCommitted,
    linksVerified: Math.max(0, Math.floor(Number(stored.links_verified || 0))),
    linksCreated: Math.max(0, Math.floor(Number(stored.links_created || 0))),
    linkConflicts: Math.max(0, Math.floor(Number(stored.link_conflicts || 0))),
    duplicateObjects: Math.max(0, Math.floor(Number(stored.duplicate_objects || 0))),
    batchesCommitted: Math.max(0, Math.floor(Number(stored.batches_committed || 0))),
    batchSize: Math.max(0, Math.floor(Number(stored.batch_size || 0))),
    completed: stored.completed === true && assetsCommitted === safeTotal,
  };
}

export function buildMediaFinalizationCheckpoint({
  previous = {},
  cacheKey = "",
  assetsTotal = 0,
  assetsCommitted = 0,
  linksVerified = 0,
  linksCreated = 0,
  linkConflicts = 0,
  duplicateObjects = 0,
  batchesCommitted = 0,
  batchSize = 0,
  completed = false,
} = {}) {
  const safeTotal = Math.max(0, Math.floor(Number(assetsTotal || 0)));
  const safeCommitted = Math.max(
    0,
    Math.min(safeTotal, Math.floor(Number(assetsCommitted || 0))),
  );
  return {
    ...previous,
    media_finalization: {
      version: 1,
      cache_key: String(cacheKey || ""),
      assets_total: safeTotal,
      assets_committed: safeCommitted,
      links_verified: Math.max(0, Math.floor(Number(linksVerified || 0))),
      links_created: Math.max(0, Math.floor(Number(linksCreated || 0))),
      link_conflicts: Math.max(0, Math.floor(Number(linkConflicts || 0))),
      duplicate_objects: Math.max(0, Math.floor(Number(duplicateObjects || 0))),
      batches_committed: Math.max(0, Math.floor(Number(batchesCommitted || 0))),
      batch_size: Math.max(0, Math.floor(Number(batchSize || 0))),
      completed: completed === true && safeCommitted === safeTotal,
    },
  };
}

export async function finalizeMediaInBatches({
  assets = [],
  matches = [],
  batchSize = 250,
  startOffset = 0,
  onBatch,
} = {}) {
  if (typeof onBatch !== "function") {
    throw new Error("Media finalization onBatch is required");
  }
  const rows = Array.isArray(assets) ? assets : [];
  const safeBatchSize = boundedInteger(batchSize, 250, 25, 1_000);
  const safeStart = Math.max(
    0,
    Math.min(rows.length, Math.floor(Number(startOffset || 0))),
  );
  const firstAssetIndexBySha = new Map();
  rows.forEach((asset, index) => {
    const sha256 = String(asset?.sha256 || "");
    if (sha256 && !firstAssetIndexBySha.has(sha256)) {
      firstAssetIndexBySha.set(sha256, index);
    }
  });
  const matchesBySha = new Map();
  const seenMatches = new Set();
  for (const match of Array.isArray(matches) ? matches : []) {
    const sha256 = String(match?.asset?.sha256 || "");
    if (!sha256 || !firstAssetIndexBySha.has(sha256)) continue;
    const key = [
      String(match?.questionId || ""),
      String(match?.mediaRef || ""),
    ].join("\u0000");
    const scopedKey = `${sha256}\u0000${key}`;
    if (seenMatches.has(scopedKey)) continue;
    seenMatches.add(scopedKey);
    if (!matchesBySha.has(sha256)) matchesBySha.set(sha256, []);
    matchesBySha.get(sha256).push(match);
  }

  const remaining = Math.max(0, rows.length - safeStart);
  const totalBatches = remaining
    ? Math.ceil(remaining / safeBatchSize)
    : 0;
  let batchNumber = 0;
  let assetsCommitted = safeStart;
  for (let offset = safeStart; offset < rows.length; offset += safeBatchSize) {
    const nextOffset = Math.min(rows.length, offset + safeBatchSize);
    const assetBatch = rows.slice(offset, nextOffset);
    const matchBatch = [];
    const batchShas = new Set(assetBatch.map((asset) => String(asset?.sha256 || "")).filter(Boolean));
    for (const sha256 of batchShas) {
      const firstIndex = firstAssetIndexBySha.get(sha256);
      if (firstIndex < offset || firstIndex >= nextOffset) continue;
      matchBatch.push(...(matchesBySha.get(sha256) || []));
    }
    batchNumber += 1;
    await onBatch({
      assets: assetBatch,
      matches: matchBatch,
      offset,
      nextOffset,
      batchNumber,
      totalBatches,
      batchSize: safeBatchSize,
    });
    assetsCommitted = nextOffset;
  }
  return {
    assetsTotal: rows.length,
    assetsCommitted,
    batchesCommitted: batchNumber,
    totalBatches,
    batchSize: safeBatchSize,
  };
}

export function mediaRateSnapshot({
  startedAtMs,
  nowMs = Date.now(),
  newlyUploaded = 0,
  filesProcessed = 0,
  filesTotal = 0,
} = {}) {
  const start = startedAtMs == null ? nowMs : startedAtMs;
  const elapsedMs = Math.max(1, Number(nowMs) - Number(start));
  const completed = Math.max(0, Number(filesProcessed || 0));
  const total = Math.max(0, Number(filesTotal || 0));
  const newFiles = Math.max(0, Number(newlyUploaded || 0));
  const filesPerMinute = newFiles > 0
    ? (newFiles * 60_000) / elapsedMs
    : 0;
  const remaining = Math.max(0, total - completed);
  const etaSeconds = filesPerMinute > 0
    ? Math.ceil((remaining / filesPerMinute) * 60)
    : null;
  return {
    files_per_minute: Number(filesPerMinute.toFixed(2)),
    eta_seconds: etaSeconds,
  };
}

export class BoundedTaskPool {
  constructor(limit = 4, { onError } = {}) {
    this.limit = boundedInteger(limit, 4, 1, 8);
    this.onError = typeof onError === "function" ? onError : null;
    this.active = new Set();
    this.failure = null;
    this.maximumActive = 0;
  }

  async schedule(task) {
    if (typeof task !== "function") throw new Error("A task function is required");
    while (this.active.size >= this.limit && !this.failure) {
      await Promise.race(this.active);
    }
    if (this.failure) throw this.failure;
    let operation;
    operation = Promise.resolve()
      .then(task)
      .catch((error) => {
        this.failure ||= error;
        this.onError?.(error);
      })
      .finally(() => this.active.delete(operation));
    this.active.add(operation);
    this.maximumActive = Math.max(this.maximumActive, this.active.size);
  }

  async drain() {
    while (this.active.size) await Promise.all([...this.active]);
    if (this.failure) throw this.failure;
  }

  get activeCount() {
    return this.active.size;
  }
}

export class MediaAssetBatcher {
  constructor({
    batchSize = 25,
    intervalMs = 5_000,
    onFlush,
    now = () => Date.now(),
  } = {}) {
    if (typeof onFlush !== "function") throw new Error("MediaAssetBatcher onFlush is required");
    this.batchSize = boundedInteger(batchSize, 25, 1, 250);
    this.intervalMs = boundedInteger(intervalMs, 5_000, 1_000, 60_000);
    this.onFlush = onFlush;
    this.now = now;
    this.pending = [];
    this.lastFlushAt = this.now();
    this.flushChain = Promise.resolve();
    this.failure = null;
  }

  async add(value) {
    if (this.failure) throw this.failure;
    this.pending.push(value);
    const overdue = this.now() - this.lastFlushAt >= this.intervalMs;
    if (this.pending.length >= this.batchSize || overdue) await this.flush();
  }

  async flush() {
    if (this.failure) throw this.failure;
    if (!this.pending.length) {
      await this.flushChain;
      if (this.failure) throw this.failure;
      return;
    }
    const batch = this.pending.splice(0, this.pending.length);
    this.lastFlushAt = this.now();
    this.flushChain = this.flushChain
      .then(async () => {
        if (this.failure) return;
        try {
          await this.onFlush(batch);
        } catch (error) {
          this.failure ||= error;
        }
      });
    await this.flushChain;
    if (this.failure) throw this.failure;
  }

  get pendingCount() {
    return this.pending.length;
  }
}
