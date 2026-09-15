import test from "node:test";
import assert from "node:assert/strict";

import { summarizeRoadmapProgress } from "../lib/lms-roadmap-progress.js";

test("course progress advances for a partially completed teaching day", () => {
  const summary = summarizeRoadmapProgress([
    { completed: false, required_completed_count: 1, required_task_count: 9 },
    ...Array.from({ length: 27 }, () => ({ completed: false, required_completed_count: 0, required_task_count: 9 })),
  ]);

  assert.equal(summary.completed_days, 0);
  assert.equal(summary.completed_tasks, 1);
  assert.equal(summary.total_tasks, 252);
  assert.equal(summary.progress_percentage, 0.4);
});

test("completed days count once even when task counters are stale", () => {
  const summary = summarizeRoadmapProgress([
    { completed: true, required_completed_count: 2, required_task_count: 9 },
    { completed: false, required_completed_count: 4, required_task_count: 8 },
  ]);

  assert.equal(summary.completed_days, 1);
  assert.equal(summary.completed_tasks, 13);
  assert.equal(summary.total_tasks, 17);
  assert.equal(summary.completed_day_equivalents, 1.5);
  assert.equal(summary.progress_percentage, 75);
});

test("course progress is safe for empty roadmaps", () => {
  assert.deepEqual(summarizeRoadmapProgress([]), {
    total_days: 0,
    completed_days: 0,
    completed_day_equivalents: 0,
    remaining_days: 0,
    completed_tasks: 0,
    total_tasks: 0,
    progress_percentage: 0,
  });
});
