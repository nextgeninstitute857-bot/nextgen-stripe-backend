import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAylaAssessmentLearningGate,
  buildAylaWeakAreaStudyGate,
} from "../lib/aylamed-assessment-sequencing.js";

test("Starting Fresh studies before receiving a scored assessment", () => {
  const gate = buildAylaAssessmentLearningGate({
    startingFresh: true,
    completedLearningAssignments: 0,
    completedPracticeQuestions: 0,
  });

  assert.equal(gate.status, "study_first");
  assert.equal(gate.type, "learning_first");
  assert.equal(gate.prerequisites.requiredLearningAssignments, 2);
  assert.equal(gate.prerequisites.requiredPracticeQuestions, 10);
  assert.match(gate.reason, /will not overload you/);
});

test("learning evidence opens the adaptive assessment scheduler", () => {
  assert.equal(buildAylaAssessmentLearningGate({
    startingFresh: true,
    completedLearningAssignments: 2,
    completedPracticeQuestions: 0,
  }), null);
});

test("only one scored assessment is allowed per study day", () => {
  const gate = buildAylaAssessmentLearningGate({
    completedLearningAssignments: 5,
    completedPracticeQuestions: 20,
    assessmentsCompletedToday: 1,
  });

  assert.equal(gate.trigger, "one_scored_assessment_per_study_day");
});

test("weak areas require targeted study before a checkpoint", () => {
  const blocked = buildAylaWeakAreaStudyGate({ system: "Cardiovascular", accuracy: 42, completedTargetedLearning: 0 });
  assert.equal(blocked.status, "study_first");
  assert.match(blocked.reason, /assign targeted learning and revision first/);
  assert.equal(buildAylaWeakAreaStudyGate({ system: "Cardiovascular", accuracy: 42, completedTargetedLearning: 1 }), null);
});

