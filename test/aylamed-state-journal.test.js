import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  appendAylaStateJournal, applyAylaStateJournal, createAylaStateJournalRecord,
  readAylaStateJournal, checkpointAylaState,
} from "../lib/aylamed-state-journal.js";
import { appendAylaQbankJournalRecord, createAylaDiagnosticJournalRecord } from "../lib/aylamed-qbank-journal.js";
import { atomicSnapshot, persistenceHarness } from "./helpers/aylamed-state-persistence-harness.js";

async function fixture(t, initial = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ayla-state-delta-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await atomicSnapshot(path.join(directory, "aylamed-db.json"), {
    aylaQbankSessions: {}, aylaQbankEvents: {}, aylaDailyPlans: {}, aylaResourceAssignments: {}, aylaRevisionQueue: {},
    ...initial,
  });
  return { directory, journal: path.join(directory, "aylamed-state-deltas.jsonl") };
}

function transition(before, value) {
  const after = { ...before, value, state_journal_version: (before.state_journal_version || 0) + 1 };
  return { after, record: createAylaStateJournalRecord(before, after) };
}

function faultyIo(behavior) {
  return { ...fs, async open(...args) {
    const handle = await fs.open(...args);
    return new Proxy(handle, { get(target, key) {
      if (behavior[key]) return (...values) => behavior[key](target, ...values);
      const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
    } });
  } };
}

test("real server create, answer, delete and array mutations durably replay without rewriting snapshot", async (t) => {
  const f = await fixture(t, { resources: { book: { pages: ["preserved"] } } });
  const app = await persistenceHarness(f.directory); t.after(app.stop);
  const original = await fs.readFile(app.snapshotPath, "utf8");
  await app.mutate((db) => { db.aylaQbankSessions.s = { id: "s", answers: {}, flags: [1, 2] }; });
  await app.mutate((db) => { db.aylaQbankSessions.s.answers.q = { selectedAnswerId: 3 }; db.aylaQbankSessions.s.flags.pop(); });
  await app.mutate((db) => { delete db.aylaQbankSessions.s.flags; db.aylaRevisionQueue.r = { due: true }; });
  assert.equal(await fs.readFile(app.snapshotPath, "utf8"), original);
  const restart = await persistenceHarness(f.directory); t.after(restart.stop);
  const recovered = await restart.read();
  assert.equal(recovered.aylaQbankSessions.s.answers.q.selectedAnswerId, 3);
  assert.equal(recovered.aylaQbankSessions.s.flags, undefined);
  assert.equal(recovered.aylaRevisionQueue.r.due, true);
  assert.equal(recovered.state_journal_version, 3);
  assert.deepEqual(recovered.resources.book.pages, ["preserved"]);
  assert.ok((await fs.stat(f.journal)).size < 4000);
});

test("all real server mutation paths share durable order after legacy diagnostic recovery", async (t) => {
  const f = await fixture(t);
  const session = { id: "diag", purpose: "baseline_diagnostic", mode: "test", answers: { one: 1 } };
  await appendAylaQbankJournalRecord(path.join(f.directory, "diagnostic.jsonl"), createAylaDiagnosticJournalRecord({
    session, event: { id: "e1", sessionId: "diag" }, qbankStateVersion: 1,
  }));
  const app = await persistenceHarness(f.directory); t.after(app.stop);
  await app.mutate((db) => { db.aylaQbankSessions.practice = { id: "practice", status: "in_progress" }; });
  await app.roadmap((db) => { db.aylaDailyPlans.p = { id: "p", status: "pending" }; });
  await app.diagnostic((db) => {
    const next = { ...db.aylaQbankSessions.diag, answers: { one: 1, two: 2 } };
    const event = { id: "e2", sessionId: "diag" };
    db.aylaQbankSessions.diag = next; db.aylaQbankEvents.e2 = event;
    return { __diagnosticJournal: { session: next, event } };
  });
  await app.mutate((db) => { db.aylaDailyPlans.p.status = "completed"; db.aylaQbankSessions.practice.status = "submitted"; });
  const restart = await persistenceHarness(f.directory); t.after(restart.stop);
  const recovered = await restart.read();
  assert.deepEqual(recovered.aylaQbankSessions.diag.answers, { one: 1, two: 2 });
  assert.equal(recovered.aylaDailyPlans.p.status, "completed");
  assert.equal(recovered.aylaQbankSessions.practice.status, "submitted");
  assert.equal(recovered.state_journal_version, 4);
});

test("concurrent queued writes and a throwing mutator preserve every successful answer exactly once", async (t) => {
  const f = await fixture(t); const app = await persistenceHarness(f.directory); t.after(app.stop);
  await app.mutate((db) => { db.aylaQbankSessions.s = { answers: {} }; });
  await Promise.all(Array.from({ length: 12 }, (_, index) => app.mutate((db) => { db.aylaQbankSessions.s.answers[index] = index; })));
  await assert.rejects(app.mutate((db) => { db.aylaQbankSessions.s.answers.bad = 99; throw new Error("rollback"); }), /rollback/);
  const prior = await app.read();
  await app.mutate((db) => { if (Object.hasOwn(db.aylaQbankSessions.s.answers, "3")) return "replayed"; });
  const after = await app.read();
  assert.equal(after.state_journal_version, prior.state_journal_version);
  const recovered = applyAylaStateJournal(JSON.parse(await fs.readFile(app.snapshotPath)), (await readAylaStateJournal(f.journal)).records).db;
  assert.equal(Object.keys(recovered.aylaQbankSessions.s.answers).length, 12);
  assert.equal(recovered.aylaQbankSessions.s.answers.bad, undefined);
});

test("partial append failure truncates and syncs back to the previous record before version reuse", async (t) => {
  const f = await fixture(t); const first = transition({}, "first");
  await appendAylaStateJournal(f.journal, first.record);
  const size = (await fs.stat(f.journal)).size;
  let writes = 0;
  const io = faultyIo({ async write(h, bytes, offset, length, position) {
    if (writes++) throw new Error("injected partial write failure");
    return h.write(bytes, offset, Math.min(17, length), position);
  } });
  const second = transition(first.after, "second");
  await assert.rejects(appendAylaStateJournal(f.journal, second.record, { io }), /partial write failure/);
  assert.equal((await fs.stat(f.journal)).size, size);
  await appendAylaStateJournal(f.journal, second.record);
  assert.equal(applyAylaStateJournal({}, (await readAylaStateJournal(f.journal)).records).db.value, "second");
});

test("a failed fsync does not publish server cache or ACK, and the next request sees durable state", async (t) => {
  const f = await fixture(t); let fail = true;
  const io = faultyIo({ async sync(h) { if (fail) { fail = false; throw new Error("injected fsync failure"); } await h.sync(); } });
  const app = await persistenceHarness(f.directory, { appendAylaStateJournal: (file, record) => appendAylaStateJournal(file, record, { io }) });
  t.after(app.stop);
  await assert.rejects(app.mutate((db) => { db.aylaQbankSessions.s = { saved: true }; }), /fsync failure/);
  assert.equal((await app.read()).aylaQbankSessions.s, undefined);
  await app.mutate((db) => { db.aylaQbankSessions.s = { saved: true }; });
  assert.equal((await app.read()).state_journal_version, 1);
});

test("pending fsync holds both the successful response and publication of new cache state", async (t) => {
  const f = await fixture(t); let release; let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const syncing = new Promise((resolve) => { entered = resolve; });
  let once = true;
  const io = faultyIo({ async sync(h) { if (once) { once = false; entered(); await blocked; } await h.sync(); } });
  const app = await persistenceHarness(f.directory, { appendAylaStateJournal: (file, record) => appendAylaStateJournal(file, record, { io }) }); t.after(app.stop);
  let acknowledged = false;
  const save = app.mutate((db) => { db.aylaQbankSessions.s = { saved: true }; }).then(() => { acknowledged = true; });
  await syncing;
  assert.equal(acknowledged, false);
  assert.equal((await app.read()).aylaQbankSessions.s, undefined);
  release(); await save;
  assert.equal((await app.read()).aylaQbankSessions.s.saved, true);
});

test("hard process termination after fsync but before cache publication recovers the answer", { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const harnessUrl = new URL("./helpers/aylamed-state-persistence-harness.js", import.meta.url).href;
  const journalUrl = new URL("../lib/aylamed-state-journal.js", import.meta.url).href;
  const script = `
    import { persistenceHarness } from ${JSON.stringify(harnessUrl)};
    import { appendAylaStateJournal } from ${JSON.stringify(journalUrl)};
    const app = await persistenceHarness(${JSON.stringify(f.directory)}, {
      appendAylaStateJournal: async (...args) => {
        await appendAylaStateJournal(...args);
        setInterval(() => {}, 1000);
        process.stdout.write('durable-before-publish');
        await new Promise(() => {});
      }
    });
    await app.mutate(db => { db.aylaQbankSessions.saved = { answer: 3 }; });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let errors = ""; child.stderr.on("data", (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve);
    child.once("exit", (code) => reject(new Error(`Child exited before durability marker: ${code} ${errors}`)));
    child.once("error", reject);
  });
  const exited = new Promise((resolve) => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
  const restart = await persistenceHarness(f.directory); t.after(restart.stop);
  assert.equal((await restart.read()).aylaQbankSessions.saved.answer, 3);
  assert.equal((await restart.read()).state_journal_version, 1);
});

test("uncertain failed rollback reloads a complete append before retry rather than reusing its version", async (t) => {
  const f = await fixture(t); let failed = false;
  const io = faultyIo({ async sync(h) { if (!failed) { failed = true; throw new Error("fsync outcome unknown"); } await h.sync(); }, async truncate() { throw new Error("rollback unavailable"); } });
  const app = await persistenceHarness(f.directory, { appendAylaStateJournal: (file, record) => appendAylaStateJournal(file, record, { io }) }); t.after(app.stop);
  await assert.rejects(app.mutate((db) => { db.aylaQbankSessions.s = { saved: true }; }), { code: "AYLA_STATE_JOURNAL_UNCERTAIN" });
  assert.equal((await app.read()).aylaQbankSessions.s.saved, true);
  await app.mutate((db) => { if (db.aylaQbankSessions.s?.saved) return "replayed"; });
  assert.equal((await app.read()).state_journal_version, 1);
});

test("torn final append is repaired before the next append, but corrupt complete records fail closed", async (t) => {
  const f = await fixture(t); const first = transition({}, "one"); const second = transition(first.after, "two");
  await appendAylaStateJournal(f.journal, first.record);
  await fs.appendFile(f.journal, '{"unfinished":');
  assert.ok((await readAylaStateJournal(f.journal)).repairedBytes > 0);
  await appendAylaStateJournal(f.journal, second.record);
  assert.equal((await readAylaStateJournal(f.journal)).records.length, 2);
  await fs.appendFile(f.journal, '{"complete":"invalid"}\n');
  await assert.rejects(readAylaStateJournal(f.journal), { code: "AYLA_STATE_JOURNAL_CORRUPT" });
});

test("checkpoint crash before rename keeps the journal; crash after rename cannot revert submitted state", async (t) => {
  const f = await fixture(t); const app = await persistenceHarness(f.directory); t.after(app.stop);
  await app.mutate((db) => { db.aylaQbankSessions.s = { status: "submitted", answers: { q: 2 } }; });
  const state = await app.read(); const options = { db: state, snapshotPath: app.snapshotPath, journalPath: f.journal };
  await assert.rejects(checkpointAylaState({ ...options, writeSnapshot: async (file, db) => { await fs.writeFile(`${file}.tmp`, JSON.stringify(db)); throw new Error("crash before rename"); } }), /before rename/);
  assert.equal(JSON.parse(await fs.readFile(app.snapshotPath)).aylaQbankSessions.s, undefined);
  assert.equal(applyAylaStateJournal(JSON.parse(await fs.readFile(app.snapshotPath)), (await readAylaStateJournal(f.journal)).records).db.aylaQbankSessions.s.status, "submitted");
  await assert.rejects(checkpointAylaState({ ...options, writeSnapshot: atomicSnapshot, clearLegacy: async () => { throw new Error("crash after rename"); } }), /after rename/);
  const recovered = applyAylaStateJournal(JSON.parse(await fs.readFile(app.snapshotPath)), (await readAylaStateJournal(f.journal)).records);
  assert.equal(recovered.applied, 0); assert.equal(recovered.db.aylaQbankSessions.s.status, "submitted");
  await checkpointAylaState({ ...options, writeSnapshot: atomicSnapshot });
  assert.equal((await readAylaStateJournal(f.journal)).records.length, 0);
});

test("version gaps and conflicting duplicate versions fail closed; identical records replay once", () => {
  const first = transition({}, "one"); const second = transition(first.after, "two");
  assert.equal(applyAylaStateJournal({}, [first.record, first.record, second.record]).applied, 2);
  assert.throws(() => applyAylaStateJournal({}, [second.record]), /version gap/);
  assert.throws(() => applyAylaStateJournal({}, [first.record, transition({}, "different").record]), /Conflicting duplicate/);
});

test("stale legacy whole-state checkpoints cannot overwrite a newly acknowledged answer", async (t) => {
  const f = await fixture(t); const app = await persistenceHarness(f.directory); t.after(app.stop);
  const stale = await app.read();
  await app.mutate((db) => { db.aylaQbankSessions.s = { saved: true }; });
  await assert.rejects(app.checkpoint(stale), { code: "AYLA_STATE_CHANGED", statusCode: 409 });
  assert.equal((await app.read()).aylaQbankSessions.s.saved, true);
  const current = await app.read(); await app.checkpoint(current);
  assert.equal((await app.read()).state_journal_version, 2);
  assert.equal((await readAylaStateJournal(f.journal)).records.length, 0);
});

test("a missing base checkpoint with existing deltas fails closed", async (t) => {
  const f = await fixture(t); const app = await persistenceHarness(f.directory); t.after(app.stop);
  await app.mutate((db) => { db.aylaQbankSessions.s = { saved: true }; });
  await fs.unlink(app.snapshotPath);
  const restarted = await persistenceHarness(f.directory); t.after(restarted.stop);
  await assert.rejects(restarted.read(), /checkpoint is missing/);
});

test("admin backup includes all acknowledged deltas, excludes unsaved cache edits and can prepare rollback checkpoint", async (t) => {
  const f = await fixture(t); const app = await persistenceHarness(f.directory); t.after(app.stop);
  const saving = app.mutate((db) => { db.aylaQbankSessions.s = { answer: 2 }; });
  const backupPromise = app.backup(); // Must wait for the preceding durable save.
  await saving; const backup = await backupPromise;
  assert.equal(backup.standalone_snapshot, true);
  assert.equal(JSON.parse(await fs.readFile(backup.backup_path)).aylaQbankSessions.s.answer, 2);
  assert.equal(JSON.parse(await fs.readFile(app.snapshotPath)).aylaQbankSessions.s, undefined);
  // Legacy callers can mutate their shallow request snapshot before saving.
  const unsaved = await app.read(); unsaved.aylaQbankSessions.s.answer = 99;
  const checkpointBackup = await app.backup({ checkpoint: true });
  assert.equal(checkpointBackup.primary_checkpoint_updated, true);
  assert.equal(JSON.parse(await fs.readFile(checkpointBackup.backup_path)).aylaQbankSessions.s.answer, 2);
  assert.equal(JSON.parse(await fs.readFile(app.snapshotPath)).aylaQbankSessions.s.answer, 2);
  assert.equal((await app.read()).aylaQbankSessions.s.answer, 2);
  assert.equal((await readAylaStateJournal(f.journal)).records.length, 0);
  const restart = await persistenceHarness(f.directory); t.after(restart.stop);
  assert.equal((await restart.read()).aylaQbankSessions.s.answer, 2);
});

test("idle compaction waits for the inactivity window and threshold then writes one atomic checkpoint", async (t) => {
  const f = await fixture(t); let now = 1000; let timer; let writes = 0;
  class Clock extends Date { static now() { return now; } }
  const app = await persistenceHarness(f.directory, {
    Date: Clock, AYLA_STATE_CHECKPOINT_RECORDS: 2, AYLA_STATE_CHECKPOINT_IDLE_MS: 100,
    setTimeout: (callback) => { timer = callback; return { unref() {} }; }, clearTimeout: () => { timer = null; },
    ngWriteJsonAtomicStreaming: async (...args) => { writes += 1; return atomicSnapshot(...args); },
  }); t.after(app.stop);
  await app.mutate((db) => { db.aylaQbankSessions.a = {}; }); assert.equal(timer, undefined);
  await app.mutate((db) => { db.aylaQbankSessions.b = {}; }); assert.equal(typeof timer, "function");
  now += 50; timer(); await app.flush(); assert.equal(writes, 0);
  now += 101; timer(); await app.flush(); assert.equal(writes, 1);
  assert.equal((await readAylaStateJournal(f.journal)).records.length, 0);
});
