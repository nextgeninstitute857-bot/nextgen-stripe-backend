import test from "node:test";
import assert from "node:assert/strict";
import { mutateJsonCopyOnWrite } from "../lib/json-copy-on-write.js";
import { runAylaQbankAdaptation } from "../lib/aylamed-qbank-adaptation.js";

function fixture(buildPlan) {
  let db = { state_journal_version: 1, aylaStudents: { p: { id: "p" } }, aylaQbankSessions: { s: {
    id: "s", studentId: "p", status: "submitted", adaptation: { status: "queued", date: "2026-09-09", updatedAt: "2026-09-08", attempts: 0 },
  } }, aylaDailyPlans: { completed: { status: "completed" } }, aylaQuestionAttempts: { saved: { id: "saved" } } };
  const readDb = async () => db;
  const mutateDb = async fn => {
    const prepared = await mutateJsonCopyOnWrite(db, fn);
    if (prepared.changed) db = { ...prepared.value, state_journal_version: db.state_journal_version + 1 };
    return prepared.result;
  };
  return { readDb, mutateDb, buildPlan, now: () => 1_000_000 };
}

test("queued jobs recover after restart and completed jobs do not run twice", async () => {
  let builds = 0;
  const ctx = fixture(async draft => {
    builds++;
    draft.aylaDailyPlans.next = { id: "next", status: "planned" };
    return { plan: { id: "next" } };
  });
  assert.equal((await runAylaQbankAdaptation(ctx)).status, "ready");
  const saved = await ctx.readDb();
  assert.equal(saved.aylaDailyPlans.completed.status, "completed");
  assert.equal(saved.aylaQbankSessions.s.adaptation.planId, "next");
  assert.equal((await runAylaQbankAdaptation({ ...ctx })).status, "idle");
  assert.equal(builds, 1);
});

test("plan preparation does not block answer saves and discards stale results", async () => {
  let release, started;
  const signal = new Promise(resolve => { started = resolve; });
  const pause = new Promise(resolve => { release = resolve; });
  const ctx = fixture(async draft => {
    draft.aylaDailyPlans.stale = { id: "stale" };
    started();
    await pause;
    return { plan: { id: "stale" } };
  });
  const running = runAylaQbankAdaptation(ctx);
  await signal;
  await ctx.mutateDb(draft => { draft.aylaQuestionAttempts.new = { id: "new" }; });
  release();
  assert.equal((await running).reason, "AYLA_ADAPTATION_STALE");
  const saved = await ctx.readDb();
  assert.equal(saved.aylaDailyPlans.stale, undefined);
  assert.equal(saved.aylaQuestionAttempts.new.id, "new");
  assert.equal(saved.aylaQbankSessions.s.adaptation.status, "retry_needed");
  assert.ok(saved.aylaQbankSessions.s.adaptation.nextAttemptAt > ctx.now());
});

test("a failed builder cannot publish partial plan changes or remove saved results", async () => {
  const ctx = fixture(async draft => {
    delete draft.aylaDailyPlans.completed;
    throw new Error("catalog temporarily unavailable");
  });
  assert.equal((await runAylaQbankAdaptation(ctx)).status, "retry_needed");
  const saved = await ctx.readDb();
  assert.equal(saved.aylaDailyPlans.completed.status, "completed");
  assert.equal(saved.aylaQuestionAttempts.saved.id, "saved");
  assert.equal(saved.aylaQbankSessions.s.status, "submitted");
});
