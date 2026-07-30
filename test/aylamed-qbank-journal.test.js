import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendAylaQbankJournalRecord,
  applyAylaQbankJournalRecords,
  clearAylaQbankJournal,
  createAylaDiagnosticJournalRecord,
  readAylaQbankJournalRecords,
} from "../lib/aylamed-qbank-journal.js";

function diagnosticFixture(answerCount = 1) {
  const session = {
    id: "diagnostic-session",
    userId: "pilot-user",
    studentId: "pilot-student",
    purpose: "baseline_diagnostic",
    mode: "test",
    answers: Object.fromEntries(
      Array.from({ length: answerCount }, (_, index) => [
        `question-${index + 1}`,
        { selectedAnswerId: index + 1 },
      ]),
    ),
  };
  const event = {
    id: `event-${answerCount}`,
    sessionId: session.id,
    type: "answer_recorded",
  };
  return { session, event };
}

test("diagnostic answer journal appends checksummed records and replays the latest session", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ayla-journal-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "answers.jsonl");
  const first = diagnosticFixture(1);
  const second = diagnosticFixture(2);

  await appendAylaQbankJournalRecord(
    filePath,
    createAylaDiagnosticJournalRecord({ ...first, qbankStateVersion: 7 }),
  );
  await appendAylaQbankJournalRecord(
    filePath,
    createAylaDiagnosticJournalRecord({ ...second, qbankStateVersion: 8 }),
  );

  const records = await readAylaQbankJournalRecords(filePath);
  assert.equal(records.length, 2);
  const replay = applyAylaQbankJournalRecords({
    qbank_state_version: 2,
    aylaQbankSessions: {},
    aylaQbankEvents: {},
  }, records);
  assert.equal(replay.applied, 2);
  assert.equal(Object.keys(replay.db.aylaQbankSessions["diagnostic-session"].answers).length, 2);
  assert.deepEqual(Object.keys(replay.db.aylaQbankEvents).sort(), ["event-1", "event-2"]);
  assert.equal(replay.db.qbank_state_version, 8);
});

test("journal replay ignores an incomplete final append but preserves earlier fsynced answers", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ayla-journal-partial-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "answers.jsonl");
  const first = diagnosticFixture(1);
  await appendAylaQbankJournalRecord(
    filePath,
    createAylaDiagnosticJournalRecord({ ...first, qbankStateVersion: 3 }),
  );
  await fs.appendFile(filePath, "{\"payload\":", "utf8");

  const records = await readAylaQbankJournalRecords(filePath);
  assert.equal(records.length, 1);
  assert.equal(records[0].event.id, "event-1");
});

test("full database checkpoints clear the journal", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ayla-journal-clear-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "answers.jsonl");
  const fixture = diagnosticFixture(1);
  await appendAylaQbankJournalRecord(
    filePath,
    createAylaDiagnosticJournalRecord({ ...fixture, qbankStateVersion: 1 }),
  );

  await clearAylaQbankJournal(filePath);
  assert.deepEqual(await readAylaQbankJournalRecords(filePath), []);
});

test("a stale journal cannot roll back a newer completed database checkpoint", () => {
  const first = createAylaDiagnosticJournalRecord({
    ...diagnosticFixture(1),
    qbankStateVersion: 7,
  }).payload;
  const second = createAylaDiagnosticJournalRecord({
    ...diagnosticFixture(2),
    qbankStateVersion: 8,
  }).payload;
  const submittedSession = {
    ...diagnosticFixture(2).session,
    status: "completed",
    submittedAt: "2026-07-30T12:00:00.000Z",
  };
  const replay = applyAylaQbankJournalRecords({
    qbank_state_version: 9,
    aylaQbankSessions: { [submittedSession.id]: submittedSession },
    aylaQbankEvents: {},
  }, [first, second]);
  assert.equal(replay.applied, 0);
  assert.equal(replay.db.aylaQbankSessions[submittedSession.id].status, "completed");
  assert.equal(replay.db.qbank_state_version, 9);
});

test("journal rejects tutor-mode and mismatched events", () => {
  const fixture = diagnosticFixture(1);
  assert.throws(
    () => createAylaDiagnosticJournalRecord({
      ...fixture,
      session: { ...fixture.session, mode: "tutor" },
    }),
    /Only baseline diagnostic test answers/,
  );
  assert.throws(
    () => createAylaDiagnosticJournalRecord({
      ...fixture,
      event: { ...fixture.event, sessionId: "other-session" },
    }),
    /matching diagnostic answer event/,
  );
});

test("a complete 40-answer diagnostic replays without a full database checkpoint", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ayla-journal-forty-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "answers.jsonl");

  for (let answerCount = 1; answerCount <= 40; answerCount += 1) {
    await appendAylaQbankJournalRecord(
      filePath,
      createAylaDiagnosticJournalRecord({
        ...diagnosticFixture(answerCount),
        qbankStateVersion: answerCount,
      }),
    );
  }
  const records = await readAylaQbankJournalRecords(filePath);
  const replay = applyAylaQbankJournalRecords({}, records);
  assert.equal(records.length, 40);
  assert.equal(
    Object.keys(replay.db.aylaQbankSessions["diagnostic-session"].answers).length,
    40,
  );
  assert.equal(Object.keys(replay.db.aylaQbankEvents).length, 40);
  assert.equal(replay.db.qbank_state_version, 40);
});

test("server journals only baseline test answers and checkpoints on submission", () => {
  const serverSource = fsSync.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(
    serverSource,
    /session\.purpose === "baseline_diagnostic" && session\.mode === "test"/,
  );
  assert.match(serverSource, /appendAylaQbankJournalRecord\(AYLA_QBANK_JOURNAL_PATH/);
  assert.match(serverSource, /clearAylaQbankJournal\(AYLA_QBANK_JOURNAL_PATH\)/);
  assert.match(serverSource, /const mutation = await mutateAylaDb\(async \(db\) => \{/);
});
