import { mutateJsonCollectionsCopyOnWrite } from "./json-copy-on-write.js";
import { AYLA_ROADMAP_STATE_COLLECTIONS } from "./aylamed-roadmap-journal.js";

const values = collection => Object.values(collection || {});
const get = (db, key, id) => db[key]?.[id] || values(db[key]).find(row => String(row.id) === String(id));

// The job lives beside the submitted session, in the same durable transaction.
// Plan computation never holds the save queue. An exact global revision check
// prevents a prepared plan from overwriting intervening answers or admin changes.
export async function runAylaQbankAdaptation({ readDb, mutateDb, buildPlan, now = () => Date.now() }) {
  const snapshot = await readDb();
  const session = values(snapshot.aylaQbankSessions)
    .filter(row => row.status === "submitted" && ["queued", "retry_needed"].includes(row.adaptation?.status)
      && Number(row.adaptation.nextAttemptAt || 0) <= now())
    .sort((a, b) => String(a.adaptation.updatedAt).localeCompare(String(b.adaptation.updatedAt)))[0];
  if (!session) return { status: "idle" };
  const job = session.adaptation;
  const today = new Date(now()).toISOString().slice(0, 10);
  const tomorrow = new Date(now() + 86_400_000).toISOString().slice(0, 10);
  const targetDate = job.date <= today ? tomorrow : job.date;
  const expected = Number(snapshot.state_journal_version || 0);
  try {
    const prepared = await mutateJsonCollectionsCopyOnWrite(snapshot,
      [...AYLA_ROADMAP_STATE_COLLECTIONS, "aylaQbankSessions"], async draft => {
      const student = get(draft, "aylaStudents", session.studentId);
      if (!student) throw new Error("Adaptation student is unavailable");
      const result = await buildPlan(draft, student, targetDate, session);
      const stored = get(draft, "aylaQbankSessions", session.id);
      stored.adaptation = {
        ...job, date: targetDate, status: "ready", updatedAt: new Date(now()).toISOString(),
        outcome: result.completedHistoryProtected ? "completed_history_protected" : result.reused ? "reused" : "refreshed",
        planId: result.plan?.id || null, nextAttemptAt: null,
      };
    });
    await mutateDb(current => {
      if (Number(current.state_journal_version || 0) !== expected) {
        throw Object.assign(new Error("Study state changed during plan preparation"), { code: "AYLA_ADAPTATION_STALE" });
      }
      for (const key of Object.keys(prepared.value)) {
        if (prepared.value[key] !== snapshot[key]) current[key] = prepared.value[key];
      }
    });
    return { status: "ready", sessionId: session.id };
  } catch (error) {
    await mutateDb(current => {
      const stored = get(current, "aylaQbankSessions", session.id);
      if (!stored || stored.adaptation?.updatedAt !== job.updatedAt || !["queued", "retry_needed"].includes(stored.adaptation?.status)) return;
      const attempts = Number(stored.adaptation.attempts || 0) + 1;
      stored.adaptation = {
        ...stored.adaptation, status: "retry_needed", attempts,
        updatedAt: new Date(now()).toISOString(),
        nextAttemptAt: now() + Math.min(300_000, 5_000 * (2 ** Math.min(attempts, 6))),
        lastErrorCode: error.code === "AYLA_ADAPTATION_STALE" ? error.code : "AYLA_ADAPTATION_RETRY",
      };
    });
    return { status: "retry_needed", sessionId: session.id, reason: error.code || "AYLA_ADAPTATION_RETRY" };
  }
}
