import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

function safeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number : 0;
}
function relativeLabel(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") ? relative : path.basename(target);
}

export async function boundedDirectoryUsage(target, { maxEntries = 5_000, maxDepth = 8 } = {}) {
  const root = path.resolve(target);
  const pending = [{ directory: root, depth: 0 }];
  let entries = 0;
  let files = 0;
  let directories = 0;
  let bytes = 0;
  let errors = 0;
  while (pending.length && entries < maxEntries) {
    const current = pending.shift();
    let rows;
    try { rows = await fs.readdir(current.directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code !== "ENOENT") errors += 1;
      continue;
    }
    directories += 1;
    for (const row of rows) {
      if (entries >= maxEntries) break;
      entries += 1;
      const fullPath = path.join(current.directory, row.name);
      if (row.isDirectory()) {
        if (current.depth < maxDepth) pending.push({ directory: fullPath, depth: current.depth + 1 });
      } else if (row.isFile()) {
        files += 1;
        try { bytes += safeNumber((await fs.stat(fullPath)).size); }
        catch { errors += 1; }
      }
    }
  }
  return {
    path_label: path.basename(root),
    bytes,
    files,
    directories,
    entries_scanned: entries,
    truncated: pending.length > 0 || entries >= maxEntries,
    errors,
  };
}

export async function storagePerformanceSnapshot({ dataDir, roots = {}, memory = {}, queue = null, uploads = null, storage = {} } = {}) {
  const resolvedDataDir = path.resolve(dataDir);
  const disk = await fs.statfs(resolvedDataDir).then((stat) => {
    const blockSize = safeNumber(stat.bsize || stat.frsize);
    const total = safeNumber(stat.blocks) * blockSize;
    const available = safeNumber(stat.bavail) * blockSize;
    return {
      total_bytes: total,
      available_bytes: available,
      used_bytes: Math.max(0, total - safeNumber(stat.bfree) * blockSize),
      percent_used: total ? Number(((total - available) / total * 100).toFixed(1)) : null,
    };
  }).catch((error) => ({ available: false, error: error.message }));

  const usageRows = {};
  for (const [key, target] of Object.entries(roots || {})) {
    const resolved = path.resolve(target);
    if (resolved !== resolvedDataDir && !resolved.startsWith(`${resolvedDataDir}${path.sep}`)) {
      usageRows[key] = { skipped: true, reason: "outside_data_dir" };
      continue;
    }
    usageRows[key] = await boundedDirectoryUsage(resolved);
    usageRows[key].path_label = relativeLabel(resolvedDataDir, resolved);
  }

  const resource = process.resourceUsage();
  const eventLoop = performance.eventLoopUtilization();
  const [queueSummary, uploadSummary] = await Promise.all([
    queue ? Promise.resolve(queue.summary()) : null,
    uploads ? uploads.summary() : null,
  ]);
  return {
    generated_at: new Date().toISOString(),
    disk,
    roots: usageRows,
    memory,
    process: {
      uptime_seconds: Math.round(process.uptime()),
      user_cpu_seconds: Number((safeNumber(resource.userCPUTime) / 1_000_000).toFixed(3)),
      system_cpu_seconds: Number((safeNumber(resource.systemCPUTime) / 1_000_000).toFixed(3)),
      max_rss_kb: safeNumber(resource.maxRSS),
      fs_read_ops: safeNumber(resource.fsRead),
      fs_write_ops: safeNumber(resource.fsWrite),
      event_loop_utilization: Number(safeNumber(eventLoop.utilization).toFixed(4)),
    },
    queue: queueSummary,
    uploads: uploadSummary,
    storage,
    safety: {
      binary_uploads_in_postgres: false,
      question_imports_run_in_student_requests: false,
      correct_answers_server_only_until_submission: true,
    },
  };
}
