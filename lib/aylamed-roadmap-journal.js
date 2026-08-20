import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const AYLA_ROADMAP_JOURNAL_BUILD = "v263-roadmap-plan-journal";
export const AYLA_ROADMAP_JOURNAL_RECORD_TYPE = "roadmap_state_v1";
export const AYLA_ROADMAP_STATE_COLLECTIONS = Object.freeze([
  "aylaDailyPlans",
  "aylaResourceAssignments",
  "aylaRevisionQueue",
]);

function checksum(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function validUpserts(upserts = {}) {
  return AYLA_ROADMAP_STATE_COLLECTIONS.some((collection) => {
    const rows = upserts[collection];
    return rows && typeof rows === "object" && !Array.isArray(rows) && Object.keys(rows).length > 0;
  });
}

export function createAylaRoadmapJournalRecord({
  upserts,
  roadmapStateVersion = 0,
  recordedAt = new Date(),
} = {}) {
  if (!validUpserts(upserts)) throw new TypeError("At least one roadmap state upsert is required");
  const payload = {
    type: AYLA_ROADMAP_JOURNAL_RECORD_TYPE,
    upserts: Object.fromEntries(AYLA_ROADMAP_STATE_COLLECTIONS.map((collection) => [
      collection,
      upserts[collection] && typeof upserts[collection] === "object" ? upserts[collection] : {},
    ])),
    roadmapStateVersion: Math.max(0, Number(roadmapStateVersion || 0)),
    recordedAt: new Date(recordedAt).toISOString(),
  };
  return { payload, checksum: checksum(payload) };
}

export async function appendAylaRoadmapJournalRecord(filePath, record) {
  if (!record?.payload || record.checksum !== checksum(record.payload)) {
    throw new TypeError("A valid checksummed roadmap journal record is required");
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "a");
  try {
    await handle.write(`${JSON.stringify(record)}\n`, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readAylaRoadmapJournalRecords(filePath) {
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
        record?.payload?.type === AYLA_ROADMAP_JOURNAL_RECORD_TYPE
        && record.checksum === checksum(record.payload)
        && validUpserts(record.payload.upserts)
      ) records.push(record.payload);
    } catch {
      // Ignore only an incomplete final append; every earlier checksummed row
      // remains durable and replayable.
    }
  }
  return records;
}

export function applyAylaRoadmapJournalRecords(db = {}, records = []) {
  for (const collection of AYLA_ROADMAP_STATE_COLLECTIONS) {
    db[collection] = db[collection] && typeof db[collection] === "object" && !Array.isArray(db[collection])
      ? db[collection]
      : {};
  }
  let maximumVersion = Math.max(0, Number(db.roadmap_state_version || 0));
  let applied = 0;
  for (const record of records) {
    if (record?.type !== AYLA_ROADMAP_JOURNAL_RECORD_TYPE) continue;
    const version = Math.max(0, Number(record.roadmapStateVersion || 0));
    if (version <= maximumVersion || !validUpserts(record.upserts)) continue;
    for (const collection of AYLA_ROADMAP_STATE_COLLECTIONS) {
      Object.assign(db[collection], record.upserts[collection] || {});
    }
    maximumVersion = version;
    applied += 1;
  }
  db.roadmap_state_version = maximumVersion;
  return { db, applied };
}

export async function clearAylaRoadmapJournal(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "w");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
