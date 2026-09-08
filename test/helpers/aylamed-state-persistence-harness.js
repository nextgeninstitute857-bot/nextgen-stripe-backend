import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as journal from "../../lib/aylamed-state-journal.js";
import * as diagnostic from "../../lib/aylamed-qbank-journal.js";
import * as roadmap from "../../lib/aylamed-roadmap-journal.js";
import { mutateJsonCopyOnWrite } from "../../lib/json-copy-on-write.js";

export async function atomicSnapshot(file, db) {
  const handle = await fs.open(`${file}.tmp`, "w");
  try { await handle.writeFile(JSON.stringify(db)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(`${file}.tmp`, file);
}

// Execute the actual server persistence functions with disk paths confined to
// a test directory. Avoid booting the unrelated CRM, messaging and AI workers.
export async function persistenceHarness(directory, overrides = {}) {
  const source = await fs.readFile(fileURLToPath(new URL("../../server.js", import.meta.url)), "utf8");
  const start = source.indexOf("let aylaWriteQueue =");
  const helpersEnd = source.indexOf("function aylaMergeSettings", start);
  const readStart = source.indexOf("async function readAylaDbFromDisk");
  const end = source.indexOf("async function readAylaCrmSnapshot", readStart);
  if ([start, helpersEnd, readStart, end].some((index) => index < 0)) throw new Error("Server persistence block not found");
  const snapshotPath = path.join(directory, "aylamed-db.json");
  const journalPath = path.join(directory, "aylamed-state-deltas.jsonl");
  const bindings = {
    ...journal, ...diagnostic, ...roadmap,
    fs, path, crypto, Date, setTimeout, clearTimeout, mutateJsonCopyOnWrite,
    console: { log() {}, error() {} },
    AYLA_DB_PATH: snapshotPath,
    DATA_DIR: directory,
    AYLA_STATE_JOURNAL_PATH: journalPath,
    AYLA_QBANK_JOURNAL_PATH: path.join(directory, "diagnostic.jsonl"),
    AYLA_ROADMAP_JOURNAL_PATH: path.join(directory, "roadmap.jsonl"),
    AYLA_STATE_CHECKPOINT_IDLE_MS: 60_000,
    AYLA_STATE_CHECKPOINT_BYTES: 8 * 1024 * 1024,
    AYLA_STATE_CHECKPOINT_RECORDS: 500,
    DEFAULT_AYLA_DB: { schema_version: 1 },
    AYLA_QBANK_STATE_COLLECTIONS: ["aylaQbankSessions", "aylaQbankEvents", "aylaRevisionQueue"],
    AYLA_CDM_STATE_COLLECTIONS: [],
    aylaMergeSettings: (value = {}) => ({ ...value }),
    aylaMergeAiUsageSettings: (value = {}) => ({ ...value }),
    cloneAylaDbForRequest: (value) => ({ ...value }),
    ensureDataDir: () => fs.mkdir(directory, { recursive: true }),
    ngWriteJsonAtomicStreaming: atomicSnapshot,
    preserveMccqeDemoLedgerSnapshot: (_latest, incoming) => incoming,
    mergeAylaContentHubProgressCollection: (latest, incoming) => ({ ...latest, ...incoming }),
    mergeAylaLibraryProgressCollection: (latest, incoming) => ({ ...latest, ...incoming }),
    mergeConcurrentAylaNotebookCollection: (latest, incoming) => ({ ...latest, ...incoming }),
    mergeConcurrentAylaQbankCollection: (latest, incoming) => ({ ...latest, ...incoming }),
    ...overrides,
  };
  const factory = new Function(...Object.keys(bindings), `${source.slice(start, helpersEnd)}\n${source.slice(readStart, end)}\nreturn {
    read: readAylaDb, mutate: mutateAylaDb, diagnostic: mutateAylaDiagnosticAnswer,
    roadmap: mutateAylaRoadmapState, checkpoint: writeAylaDb, backup: aylaCreateDurableBackup,
    flush: () => aylaWriteQueue,
    stop: () => { if (aylaStateCheckpointTimer) clearTimeout(aylaStateCheckpointTimer); }
  };`);
  return { ...factory(...Object.values(bindings)), snapshotPath, journalPath };
}
