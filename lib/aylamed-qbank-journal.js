import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const AYLA_QBANK_JOURNAL_BUILD = "v262-diagnostic-answer-journal";
export const AYLA_QBANK_JOURNAL_RECORD_TYPE = "diagnostic_answer_v1";
export const AYLA_DIAGNOSTIC_ANSWER_STATE_COLLECTIONS = Object.freeze([
  "aylaQbankSessions",
  "aylaQbankEvents",
]);

export function isolateAylaDiagnosticAnswerState(db = {}) {
  return {
    ...db,
    ...Object.fromEntries(AYLA_DIAGNOSTIC_ANSWER_STATE_COLLECTIONS.map((collection) => [
      collection,
      { ...(db?.[collection] && typeof db[collection] === "object" && !Array.isArray(db[collection])
        ? db[collection]
        : {}) },
    ])),
  };
}

function checksum(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function validDiagnosticSession(session = {}) {
  return Boolean(
    session
      && session.id
      && session.purpose === "baseline_diagnostic"
      && session.mode === "test",
  );
}

export function createAylaDiagnosticJournalRecord({
  session,
  event,
  qbankStateVersion = 0,
  recordedAt = new Date(),
} = {}) {
  if (!validDiagnosticSession(session)) {
    throw new TypeError("Only baseline diagnostic test answers may use the QBank journal");
  }
  if (!event?.id || String(event.sessionId || "") !== String(session.id)) {
    throw new TypeError("A matching diagnostic answer event is required");
  }
  const payload = {
    type: AYLA_QBANK_JOURNAL_RECORD_TYPE,
    session,
    event,
    qbankStateVersion: Math.max(0, Number(qbankStateVersion || 0)),
    recordedAt: new Date(recordedAt).toISOString(),
  };
  return { payload, checksum: checksum(payload) };
}

export async function appendAylaQbankJournalRecord(filePath, record) {
  const serialized = JSON.stringify(record);
  if (!record?.payload || record.checksum !== checksum(record.payload)) {
    throw new TypeError("A valid checksummed QBank journal record is required");
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "a");
  try {
    await handle.write(`${serialized}\n`, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readAylaQbankJournalRecords(filePath) {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (
        record?.payload?.type === AYLA_QBANK_JOURNAL_RECORD_TYPE
        && record.checksum === checksum(record.payload)
        && validDiagnosticSession(record.payload.session)
        && record.payload.event?.id
        && String(record.payload.event.sessionId || "") === String(record.payload.session.id)
      ) {
        records.push(record.payload);
      }
    } catch {
      // A process can stop between the append and fsync. Ignore only the
      // incomplete/invalid line; every earlier checksummed record still replays.
    }
  }
  return records;
}

export function applyAylaQbankJournalRecords(db = {}, records = []) {
  const next = db;
  next.aylaQbankSessions = next.aylaQbankSessions && typeof next.aylaQbankSessions === "object"
    ? next.aylaQbankSessions
    : {};
  next.aylaQbankEvents = next.aylaQbankEvents && typeof next.aylaQbankEvents === "object"
    ? next.aylaQbankEvents
    : {};
  // Records at or below the persisted database version were already included
  // in a completed checkpoint. Ignoring them makes a crash between the atomic
  // database rename and journal truncation safe, including after submission.
  let maximumVersion = Math.max(0, Number(next.qbank_state_version || 0));
  let applied = 0;
  for (const record of records) {
    if (
      record?.type !== AYLA_QBANK_JOURNAL_RECORD_TYPE
      || !validDiagnosticSession(record.session)
      || !record.event?.id
    ) continue;
    const recordVersion = Math.max(0, Number(record.qbankStateVersion || 0));
    if (recordVersion <= maximumVersion) continue;
    next.aylaQbankSessions[String(record.session.id)] = record.session;
    next.aylaQbankEvents[String(record.event.id)] = record.event;
    maximumVersion = recordVersion;
    applied += 1;
  }
  next.qbank_state_version = maximumVersion;
  return { db: next, applied };
}

export async function clearAylaQbankJournal(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "w");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
