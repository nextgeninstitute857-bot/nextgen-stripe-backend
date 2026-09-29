import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline as pipelineStreams } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

// Bounded-memory, atomic JSON persistence for the large JSON databases.
//
// The database is walked two levels deep (database -> collection -> record)
// and every record is serialized with the native JSON.stringify, then flushed
// to a temporary file in small chunks. The previous writer serialized value by
// value with an await per value; for multi-million-value databases that kept
// the event loop busy for seconds on every save, so every request waited.
// Output is byte-identical to JSON.stringify(value).

export const JSON_WRITE_BUFFER_BYTES = Math.max(
  64 * 1024,
  Math.min(4 * 1024 * 1024, Number(process.env.NEXTGEN_JSON_WRITE_BUFFER_BYTES || 512 * 1024) || 512 * 1024),
);
// Records are serialized natively below this depth (0 = database, 1 = collection).
const STREAM_DEPTH = 2;

const writeStats = {};

export function jsonWriteStats() {
  return JSON.parse(JSON.stringify(writeStats));
}

function rememberWrite(label, startedAt, bytes, error) {
  const ms = Math.round(performance.now() - startedAt);
  const row = writeStats[label] || (writeStats[label] = { count: 0, failures: 0, total_ms: 0, max_ms: 0 });
  row.count += 1;
  if (error) row.failures += 1;
  row.total_ms += ms;
  row.max_ms = Math.max(row.max_ms, ms);
  row.last_ms = ms;
  row.avg_ms = Math.round(row.total_ms / row.count);
  row.last_bytes = bytes;
  row.last_at = new Date().toISOString();
}

export async function writeJsonAtomicStreaming(filePath, value, label = "database", { gzip = false } = {}) {
  const startedAt = performance.now();
  const tempPath = `${filePath}.tmp`;
  let handle = null;
  let streamInput = null;
  let streamPipeline = null;
  let pending = [];
  let pendingBytes = 0;
  let totalBytes = 0;

  const sink = async (text) => {
    if (streamInput) {
      if (!streamInput.write(text, "utf8")) await new Promise((resolve) => streamInput.once("drain", resolve));
    } else {
      await handle.write(text, null, "utf8");
    }
  };
  const flush = async () => {
    if (!pending.length) return;
    const chunk = pending.join("");
    pending = [];
    pendingBytes = 0;
    await sink(chunk);
  };
  const write = async (text) => {
    if (!text) return;
    const bytes = Buffer.byteLength(text, "utf8");
    totalBytes += bytes;
    if (bytes >= JSON_WRITE_BUFFER_BYTES) {
      await flush();
      await sink(text);
      return;
    }
    pending.push(text);
    pendingBytes += bytes;
    if (pendingBytes >= JSON_WRITE_BUFFER_BYTES) await flush();
  };

  const writeValue = async (item, depth, inArray) => {
    if (item !== null && typeof item === "object" && typeof item.toJSON !== "function" && depth < STREAM_DEPTH) {
      if (Array.isArray(item)) {
        await write("[");
        for (let index = 0; index < item.length; index += 1) {
          if (index) await write(",");
          await writeValue(item[index], depth + 1, true);
        }
        await write("]");
        return;
      }
      await write("{");
      let written = 0;
      for (const [key, child] of Object.entries(item)) {
        const childType = typeof child;
        if (childType === "undefined" || childType === "function" || childType === "symbol") continue;
        await write(`${written ? "," : ""}${JSON.stringify(key)}:`);
        await writeValue(child, depth + 1, false);
        written += 1;
      }
      await write("}");
      return;
    }
    const text = JSON.stringify(item);
    // Matches JSON.stringify: undefined/functions/symbols become null inside arrays.
    await write(text === undefined ? (inArray ? "null" : "null") : text);
  };

  let error = null;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (gzip) {
      streamInput = new PassThrough();
      streamPipeline = pipelineStreams(streamInput, createGzip({ level: 9 }), fsSync.createWriteStream(tempPath, { flags: "w" }));
    } else {
      handle = await fs.open(tempPath, "w");
    }
    await writeValue(value, 0, false);
    await flush();
    if (streamInput) {
      streamInput.end();
      await streamPipeline;
      streamInput = null;
      streamPipeline = null;
    } else {
      await handle.sync();
      await handle.close();
      handle = null;
    }
    await fs.rename(tempPath, filePath);
  } catch (caught) {
    error = caught;
    try { streamInput?.destroy(caught); } catch {}
    try { await streamPipeline; } catch {}
    try { if (handle) await handle.close(); } catch {}
    try { await fs.unlink(tempPath); } catch {}
    throw caught;
  } finally {
    rememberWrite(label, startedAt, totalBytes, error);
  }
}

// Event-loop delay: how long requests wait behind synchronous work.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
let loopWindowStartedAt = Date.now();

export function eventLoopDelayStats({ reset = false } = {}) {
  const ms = (nanos) => Math.round(nanos / 1e6);
  const stats = {
    window_seconds: Math.round((Date.now() - loopWindowStartedAt) / 1000),
    p50_ms: ms(loopDelay.percentile(50)),
    p99_ms: ms(loopDelay.percentile(99)),
    max_ms: ms(loopDelay.max),
    mean_ms: ms(loopDelay.mean),
  };
  if (reset) {
    loopDelay.reset();
    loopWindowStartedAt = Date.now();
  }
  return stats;
}
