import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mutateJsonCopyOnWrite } from "../lib/json-copy-on-write.js";
import { runAylaQbankAdaptation } from "../lib/aylamed-qbank-adaptation.js";
import { atomicSnapshot, persistenceHarness } from "./helpers/aylamed-state-persistence-harness.js";

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

test("a job recovered after midnight updates tomorrow and preserves today's active plan", async () => {
  let builtDate;
  const ctx = fixture(async (draft, student, date) => {
    builtDate = date;
    draft.aylaDailyPlans[date] = { id: date };
    return { plan: { id: date } };
  });
  ctx.now = () => Date.parse("2026-09-09T01:00:00Z");
  await ctx.mutateDb(draft => { draft.aylaDailyPlans["2026-09-09"] = { id: "today", status: "in_progress" }; });
  assert.equal((await runAylaQbankAdaptation(ctx)).status, "ready");
  assert.equal(builtDate, "2026-09-10");
  const saved = await ctx.readDb();
  assert.equal(saved.aylaDailyPlans["2026-09-09"].status, "in_progress");
  assert.equal(saved.aylaQbankSessions.s.adaptation.date, "2026-09-10");
});

test("background planning reads content without proxies and isolates nested plan and revision edits", async () => {
  const resource = Object.freeze({ id: "book", pages: Object.freeze([{ text: "Preserved content" }]) });
  let original;
  const ctx = fixture(async draft => {
    // Large immutable content scans must not create a Proxy for every row/page.
    assert.equal(draft.aylaResources, original.aylaResources);
    assert.equal(draft.aylaResources.book, resource);
    assert.equal(draft.aylaStudents, original.aylaStudents);
    draft.aylaDailyPlans.completed.status = "still_completed";
    draft.aylaRevisionQueue.r.status = "assigned";
    assert.equal(original.aylaDailyPlans.completed.status, "completed");
    assert.equal(original.aylaRevisionQueue.r.status, "due");
    return { plan: { id: "next" } };
  });
  await ctx.mutateDb(draft => {
    draft.aylaResources = { book: resource };
    draft.aylaRevisionQueue = { r: { status: "due" } };
  });
  original = await ctx.readDb();
  assert.equal((await runAylaQbankAdaptation(ctx)).status, "ready");
  const saved = await ctx.readDb();
  assert.equal(saved.aylaRevisionQueue.r.status, "assigned");
  assert.equal(saved.aylaResources.book, resource);
});

test("scoped background plan and revision changes survive real durable replay with the ready job", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ayla-scoped-plan-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await atomicSnapshot(path.join(directory, "aylamed-db.json"), {
    aylaStudents: { p: { id: "p" } },
    aylaResources: { book: { id: "book", pages: ["preserved"] } },
    aylaRevisionQueue: { r: { id: "r", status: "due" } },
    aylaDailyPlans: {}, aylaResourceAssignments: {},
    aylaQbankSessions: { s: { id: "s", studentId: "p", status: "submitted", answers: { q: 2 },
      adaptation: { status: "queued", date: "2026-09-09", updatedAt: "2026-09-08", attempts: 0 } } },
  });
  const app = await persistenceHarness(directory); t.after(app.stop);
  const result = await runAylaQbankAdaptation({
    readDb: app.read, mutateDb: app.mutate, now: () => Date.parse("2026-09-08T12:00:00Z"),
    buildPlan: async draft => {
      draft.aylaDailyPlans.next = { id: "next", status: "active" };
      draft.aylaResourceAssignments.a = { id: "a", dailyPlanId: "next" };
      draft.aylaRevisionQueue.r.status = "assigned";
      draft.aylaRevisionQueue.r.assignedAssignmentId = "a";
      return { plan: { id: "next" } };
    },
  });
  assert.equal(result.status, "ready");
  const restart = await persistenceHarness(directory); t.after(restart.stop);
  const recovered = await restart.read();
  assert.equal(recovered.aylaDailyPlans.next.status, "active");
  assert.equal(recovered.aylaResourceAssignments.a.dailyPlanId, "next");
  assert.equal(recovered.aylaRevisionQueue.r.assignedAssignmentId, "a");
  assert.equal(recovered.aylaQbankSessions.s.adaptation.status, "ready");
  assert.equal(recovered.aylaQbankSessions.s.answers.q, 2);
  assert.deepEqual(recovered.aylaResources.book.pages, ["preserved"]);
});
