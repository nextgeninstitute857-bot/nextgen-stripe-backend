import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const AYLA_STATE_JOURNAL_TYPE = "aylamed_state_delta_v1";
export const AYLA_STATE_JOURNAL_VERSION_KEY = "state_journal_version";
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function journalError(message, code = "AYLA_STATE_JOURNAL_CORRUPT") {
  return Object.assign(new Error(message), { code, statusCode: 503 });
}

function version(value = 0) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw journalError("Invalid AylaMed journal version");
  return result;
}

// Copy-on-write retains untouched object identities, so an answer never scans
// the contents of the large, unchanged reading/resource collections.
export function aylaStateDelta(before, after) {
  const operations = [];
  const visit = (left, right, keys) => {
    if (Object.is(left, right)) return;
    if (object(left) && object(right)) {
      for (const key of Object.keys(left)) {
        if (!own(right, key) || right[key] === undefined) operations.push({ op: "delete", path: [...keys, key] });
      }
      for (const key of Object.keys(right)) {
        if (right[key] === undefined) continue;
        if (own(left, key)) visit(left[key], right[key], [...keys, key]);
        else operations.push({ op: "set", path: [...keys, key], value: right[key] });
      }
    } else {
      operations.push({ op: "set", path: keys, value: right });
    }
  };
  visit(before, after, []);
  return operations;
}

export function createAylaStateJournalRecord(before, after) {
  const baseVersion = version(before?.[AYLA_STATE_JOURNAL_VERSION_KEY]);
  const nextVersion = version(after?.[AYLA_STATE_JOURNAL_VERSION_KEY]);
  if (nextVersion !== baseVersion + 1) throw journalError("AylaMed journal versions must be consecutive");
  // Normalize once to precisely the same JSON representation replay will use.
  const payload = JSON.parse(JSON.stringify({
    type: AYLA_STATE_JOURNAL_TYPE,
    baseVersion,
    version: nextVersion,
    operations: aylaStateDelta(before, after),
  }));
  const record = { payload, checksum: digest(payload) };
  validateRecord(record);
  return record;
}

function validateRecord(record) {
  const p = record?.payload;
  if (p?.type !== AYLA_STATE_JOURNAL_TYPE || record.checksum !== digest(p)
    || version(p.version) !== version(p.baseVersion) + 1 || !Array.isArray(p.operations)) {
    throw journalError("Invalid checksummed AylaMed state journal record");
  }
  for (const op of p.operations) {
    if (!Array.isArray(op.path) || !op.path.length || op.path.length > 256
      || !op.path.every((key) => typeof key === "string")
      || !["set", "delete"].includes(op.op) || (op.op === "set" && !own(op, "value"))) {
      throw journalError("Invalid AylaMed state journal operation");
    }
  }
  if (!p.operations.some((op) => op.op === "set" && op.path.length === 1
    && op.path[0] === AYLA_STATE_JOURNAL_VERSION_KEY && op.value === p.version)) {
    throw journalError("AylaMed state delta must include its version");
  }
}

export async function syncAylaDirectory(directory, io = fs) {
  // Windows cannot open directories for fsync; Linux production requires it
  // when creating the journal or committing an atomic checkpoint rename.
  if (process.platform === "win32") return;
  const handle = await io.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function readAylaStateJournal(filePath, { repairTail = true, io = fs } = {}) {
  let raw;
  try { raw = await io.readFile(filePath); }
  catch (error) { if (error.code === "ENOENT") return { records: [], bytes: 0, repairedBytes: 0 }; throw error; }
  const end = raw.lastIndexOf(10) + 1;
  const records = [];
  for (const line of raw.subarray(0, end).toString("utf8").split("\n")) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { throw journalError("Corrupt complete AylaMed journal line; refusing partial recovery"); }
    validateRecord(record);
    records.push(record);
  }
  const repairedBytes = raw.length - end;
  if (repairedBytes && repairTail) {
    const handle = await io.open(filePath, "r+");
    try { await handle.truncate(end); await handle.sync(); } finally { await handle.close(); }
  }
  return { records, bytes: end, repairedBytes };
}

export function applyAylaStateJournal(db, records) {
  let applied = 0;
  let maximumVersion = version(db?.[AYLA_STATE_JOURNAL_VERSION_KEY]);
  const seen = new Map();
  for (const record of records) {
    validateRecord(record);
    const p = record.payload;
    if (seen.has(p.version) && seen.get(p.version) !== record.checksum) {
      throw journalError("Conflicting duplicate AylaMed state journal version");
    }
    seen.set(p.version, record.checksum);
    if (p.version <= maximumVersion) continue; // Already in the atomic checkpoint.
    if (p.baseVersion !== maximumVersion) throw journalError("AylaMed state journal version gap; refusing incomplete recovery");
    for (const op of p.operations) {
      let target = db;
      for (const key of op.path.slice(0, -1)) {
        if (!own(target, key) || !object(target[key])) throw journalError("AylaMed state journal path does not match checkpoint");
        target = target[key];
      }
      const key = op.path.at(-1);
      if (op.op === "delete") delete target[key];
      else Object.defineProperty(target, key, { value: structuredClone(op.value), enumerable: true, writable: true, configurable: true });
    }
    maximumVersion = p.version;
    applied += 1;
  }
  db[AYLA_STATE_JOURNAL_VERSION_KEY] = maximumVersion;
  return { db, applied };
}

// Caller serializes append/checkpoint operations. A failed append is rolled
// back and synced before any subsequent writer can reuse its version.
export async function appendAylaStateJournal(filePath, record, { io = fs } = {}) {
  validateRecord(record);
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  await io.mkdir(path.dirname(filePath), { recursive: true });
  let handle;
  // Explicit offsets under the server's single writer queue permit reliable
  // rollback truncation on Windows too (append-only handles cannot truncate).
  try { handle = await io.open(filePath, "wx+"); }
  catch (error) { if (error.code !== "EEXIST") throw error; handle = await io.open(filePath, "r+"); }
  let start;
  try {
    start = (await handle.stat()).size;
    let offset = 0;
    while (offset < bytes.length) {
      const written = await handle.write(bytes, offset, bytes.length - offset, start + offset);
      if (!written.bytesWritten) throw journalError("AylaMed state journal write made no progress");
      offset += written.bytesWritten;
    }
    await handle.sync();
    // Also cover a file created by an earlier failed append whose directory
    // entry has not yet been synced.
    await syncAylaDirectory(path.dirname(filePath), io);
  } catch (error) {
    try {
      if (start === undefined) throw error;
      await handle.truncate(start);
      await handle.sync();
    } catch (rollbackError) {
      error = journalError(`AylaMed journal append outcome is uncertain: ${error.message}; rollback: ${rollbackError.message}`, "AYLA_STATE_JOURNAL_UNCERTAIN");
    }
    await handle.close().catch(() => {});
    throw error;
  }
  try { await handle.close(); }
  catch (error) { throw journalError(`AylaMed journal close outcome is uncertain: ${error.message}`, "AYLA_STATE_JOURNAL_UNCERTAIN"); }
  return { bytes: bytes.length };
}

export async function clearAylaStateJournal(filePath, { io = fs } = {}) {
  const handle = await io.open(filePath, "w");
  try { await handle.sync(); } finally { await handle.close(); }
}

// writeSnapshot must fsync a temporary file and atomically rename it. Keep
// journals intact if that fails. A crash after rename but before clearing is
// safe: the checkpoint's state_journal_version makes replay idempotent.
export async function checkpointAylaState({ db, snapshotPath, journalPath, writeSnapshot, clearLegacy = async () => {}, io = fs }) {
  await writeSnapshot(snapshotPath, db);
  await syncAylaDirectory(path.dirname(snapshotPath), io);
  await clearLegacy();
  await clearAylaStateJournal(journalPath, { io });
}
