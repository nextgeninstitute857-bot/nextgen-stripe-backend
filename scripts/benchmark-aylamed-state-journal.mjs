import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { persistenceHarness, atomicSnapshot } from "../test/helpers/aylamed-state-persistence-harness.js";

// Synthetic data only. Measures persistence locally, not production HTTP p95.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ayla-state-benchmark-"));
const count = 20_000;
const requestedBytes = 111_000_000;
const text = "Synthetic study content. ".repeat(Math.ceil(requestedBytes / count / 25)).slice(0, Math.floor(requestedBytes / count));
let app;
try {
  const snapshotPath = path.join(directory, "aylamed-db.json");
  await atomicSnapshot(snapshotPath, {
    schema_version: 1,
    aylaResources: Object.fromEntries(Array.from({ length: count }, (_, index) => [`resource-${index}`, { id: `resource-${index}`, pageText: text }])),
    aylaQbankSessions: { session: { id: "session", answers: {} } },
    aylaQbankEvents: {}, aylaDailyPlans: {}, aylaResourceAssignments: {}, aylaRevisionQueue: {},
  });
  app = await persistenceHarness(directory);
  await app.read();
  const start = performance.now();
  await app.mutate((db) => { db.aylaQbankSessions.session.answers.q1 = { selectedAnswerId: 2, correct: false }; db.aylaQbankEvents.e1 = { id: "e1", type: "answer_recorded" }; });
  const firstDeltaMs = performance.now() - start;
  const deltaSamples = [];
  for (let index = 2; index <= 11; index++) {
    const started = performance.now();
    await app.mutate((db) => { db.aylaQbankSessions.session.answers[`q${index}`] = { selectedAnswerId: 2, correct: false }; });
    deltaSamples.push(performance.now() - started);
  }
  const server = await fs.readFile(fileURLToPath(new URL("../server.js", import.meta.url)), "utf8");
  const writerSource = server.slice(server.indexOf("async function ngWriteJsonAtomicStreaming("), server.indexOf("const NEXTGEN_RENDER_MEMORY_LIMIT_MB"));
  const writer = new Function("fs", "ensureDataDir", "NEXTGEN_JSON_WRITE_BUFFER_BYTES", `${writerSource}; return ngWriteJsonAtomicStreaming;`)(fs, () => fs.mkdir(directory, { recursive: true }), 512 * 1024);
  const beforeFull = performance.now();
  await writer(path.join(directory, "legacy-whole-state.json"), await app.read(), "synthetic legacy benchmark");
  const legacySnapshotMs = performance.now() - beforeFull;
  const restart = await persistenceHarness(directory);
  const recoveryStart = performance.now(); const recovered = await restart.read();
  const recoveryMs = performance.now() - recoveryStart; restart.stop();
  console.log(JSON.stringify({
    method: "Local synthetic benchmark: actual server mutation and legacy streaming writer, durable file sync; no production data or network calls",
    snapshotBytes: (await fs.stat(snapshotPath)).size,
    resourceCount: count,
    journalBytesFor11Answers: (await fs.stat(app.journalPath)).size,
    firstDeltaMs: Math.round(firstDeltaMs),
    subsequentDeltaMedianMs: Math.round(deltaSamples.slice().sort((a, b) => a - b)[Math.floor(deltaSamples.length / 2)]),
    subsequentDeltaMaxMs: Math.round(Math.max(...deltaSamples)),
    legacySnapshotMs: Math.round(legacySnapshotMs),
    recoveryMs: Math.round(recoveryMs),
    recoveredAnswerCount: Object.keys(recovered.aylaQbankSessions.session.answers).length,
    heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  }, null, 2));
} finally {
  app?.stop();
  await fs.rm(directory, { recursive: true, force: true });
}
