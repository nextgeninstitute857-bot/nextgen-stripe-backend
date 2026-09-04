import assert from "node:assert/strict";
import test from "node:test";

import {
  AYLA_MCCQE_ROADMAP_BALANCE_VERSION,
  aylaRoadmapFitsWithin,
  aylaRoadmapQuestionTarget,
  aylaRoadmapReviewCardEligible,
  aylaRoadmapReviewCardIssue,
  buildAylaRoadmapBalancePolicy,
} from "../lib/aylamed-roadmap-balance.js";

test("MCCQE protects the declared day from tutor-driven overload", () => {
  const policy = buildAylaRoadmapBalancePolicy({
    examTrack: "mccqe",
    capacityMinutes: 180,
    isStudyDay: true,
    workloadFactor: 1.08,
  });

  assert.equal(policy.version, AYLA_MCCQE_ROADMAP_BALANCE_VERSION);
  assert.equal(policy.hardDailyCap, true);
  assert.equal(policy.effectiveCapacityMinutes, 180);
  assert.equal(policy.priorityCarryCapMinutes, 62);
  assert.equal(policy.qbankTargetMinutes, 58);
  assert.equal(policy.dueFlashcardCap, 15);
  assert.equal(aylaRoadmapQuestionTarget(policy), 19);
  assert.equal(aylaRoadmapQuestionTarget(policy, 1.2), 19);
});

test("MCCQE reductions lower every workload budget while rest days remain protected", () => {
  const reduced = buildAylaRoadmapBalancePolicy({
    examTrack: "mccqe_part_1",
    capacityMinutes: 180,
    isStudyDay: true,
    workloadFactor: 0.82,
  });
  const rest = buildAylaRoadmapBalancePolicy({
    examTrack: "mccqe",
    capacityMinutes: 35,
    isStudyDay: false,
  });

  assert.equal(reduced.effectiveCapacityMinutes, 148);
  assert.equal(reduced.priorityCarryCapMinutes, 51);
  assert.equal(rest.effectiveCapacityMinutes, 35);
  assert.equal(rest.priorityCarryCapMinutes, 35);
  assert.equal(rest.qbankTargetMinutes, 0);
});

test("the hard ceiling rejects the assignment that would overload the day", () => {
  assert.equal(aylaRoadmapFitsWithin(150, 30, 180), true);
  assert.equal(aylaRoadmapFitsWithin(151, 30, 180), false);
});

test("other exam tracks retain their existing adaptive capacity behavior", () => {
  const policy = buildAylaRoadmapBalancePolicy({
    examTrack: "usmle_step_1",
    capacityMinutes: 180,
    isStudyDay: true,
    workloadFactor: 1.08,
  });

  assert.equal(policy.enabled, false);
  assert.equal(policy.hardDailyCap, false);
  assert.equal(policy.effectiveCapacityMinutes, 194);
  assert.equal(aylaRoadmapQuestionTarget(policy), null);
});

test("MCCQE review blocks count only cards the student can actually study", () => {
  const valid = {
    front: "What finding most strongly supports Turner syndrome?",
    back: "Short stature with gonadal dysgenesis.",
    provider: "AylaMed",
  };
  const questionStem = {
    front: `${"Clinical detail ".repeat(92)}Which of the following is most likely?`,
    back: "A",
    provider: "AylaMed",
  };
  const external = {
    front: "Recall the key diagnostic clue.",
    back: "The verified clue.",
    provider: "UWorld",
  };

  assert.equal(aylaRoadmapReviewCardEligible(valid), true);
  assert.equal(aylaRoadmapReviewCardIssue(questionStem), "full_question_stem");
  assert.equal(aylaRoadmapReviewCardIssue(external), "external_source_review_required");
});
