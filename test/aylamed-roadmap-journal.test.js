import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendAylaRoadmapJournalRecord,
  applyAylaRoadmapJournalRecords,
  createAylaRoadmapJournalRecord,
  readAylaRoadmapJournalRecords,
} from "../lib/aylamed-roadmap-journal.js";

test("roadmap plan journals survive replay and ignore torn writes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ayla-roadmap-journal-"));
  const journal = path.join(dir, "roadmap.jsonl");
  try {
    const plan = { id: "plan-1", date: "2026-08-20", updatedAt: "2026-08-20T12:00:00.000Z" };
    const assignment = { id: "assignment-1", dailyPlanId: plan.id, status: "pending" };
    await appendAylaRoadmapJournalRecord(journal, createAylaRoadmapJournalRecord({
      roadmapStateVersion: 1,
      upserts: {
        aylaDailyPlans: { [plan.id]: plan },
        aylaResourceAssignments: { [assignment.id]: assignment },
      },
    }));
    await fs.appendFile(journal, '{"payload":', "utf8");
    const records = await readAylaRoadmapJournalRecords(journal);
    assert.equal(records.length, 1);
    const replay = applyAylaRoadmapJournalRecords({ roadmap_state_version: 0 }, records);
    assert.equal(replay.applied, 1);
    assert.deepEqual(replay.db.aylaDailyPlans[plan.id], plan);
    assert.deepEqual(replay.db.aylaResourceAssignments[assignment.id], assignment);
    assert.equal(replay.db.roadmap_state_version, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("checkpointed roadmap journal versions are idempotent", () => {
  const record = createAylaRoadmapJournalRecord({
    roadmapStateVersion: 4,
    upserts: { aylaDailyPlans: { plan: { id: "plan" } } },
  }).payload;
  const replay = applyAylaRoadmapJournalRecords({
    roadmap_state_version: 4,
    aylaDailyPlans: { plan: { id: "plan", checkpointed: true } },
  }, [record]);
  assert.equal(replay.applied, 0);
  assert.equal(replay.db.aylaDailyPlans.plan.checkpointed, true);
});
