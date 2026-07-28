import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AYLA_STEP1_PILOT,
  buildAylaStep1PilotScenarios,
} from "../lib/aylamed-pilot.js";
import {
  AYLA_STUDENT_FEATURES,
  resolveAylaExamFeatureEntitlement,
  resolveAylaStudentShell,
} from "../lib/aylamed-student-shell.js";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const registry = fs.readFileSync(
  new URL("../lib/content-registry-postgres.js", import.meta.url),
  "utf8",
);

test("private Step 1 pilot content is scoped through catalog, sessions, and roadmap", () => {
  assert.match(server, /const AYLA_PRIVATE_PILOT_BUILD = "v250-private-pilot-content-delivery"/);
  assert.match(server, /const AYLA_STEP1_PILOT_DESTINATION_SCOPE = "private_step1_pilot"/);
  assert.match(server, /function aylaStep1PilotDestinationScope\(student = \{\}\)/);
  assert.match(server, /async function aylaV250EligibleQbankQuestions/);
  assert.match(server, /destinationScope: session\.destinationScope \|\| ""/);
  assert.match(server, /const focusedRegistryInternal = focused\(registryQbank\.questions\)/);
  assert.match(server, /category === "flashcards"/);
});

test("all five pilots receive the exact 11-feature matrix while social features stay locked", () => {
  const scenarios = buildAylaStep1PilotScenarios("2026-07-28");
  const plan = {
    id: AYLA_STEP1_PILOT.planId,
    included_features: [...AYLA_STEP1_PILOT.features],
    is_full_access: false,
  };
  assert.equal(scenarios.length, 5);
  assert.equal(AYLA_STEP1_PILOT.features.length, 11);
  for (const [index, scenario] of scenarios.entries()) {
    const userId = `pilot-user-${index + 1}`;
    const studentId = `pilot-student-${index + 1}`;
    const student = {
      id: studentId,
      ayla_user_id: userId,
      examTrackId: "usmle_step_1",
      pilotTest: true,
      scenarioKey: scenario.key,
    };
    const enrollment = {
      id: `pilot-enrollment-${index + 1}`,
      user_id: userId,
      student_id: studentId,
      plan_id: plan.id,
      exam_track_id: "usmle_step_1",
      status: "active",
      access_granted: true,
      access_expires_at: "2099-01-01T00:00:00.000Z",
    };
    const shell = resolveAylaStudentShell({
      userId,
      students: [student],
      enrollments: [enrollment],
      plansById: { [plan.id]: plan },
      activeStudentId: studentId,
      now: new Date("2026-07-28T12:00:00.000Z"),
    });
    assert.ok(shell.active_dashboard, scenario.key);
    for (const feature of AYLA_STEP1_PILOT.features.filter((key) => key !== "diagnostic")) {
      assert.equal(shell.active_dashboard.features[feature], true, `${scenario.key}:${feature}`);
    }
    assert.equal(shell.active_dashboard.features.leaderboard, false, `${scenario.key}:leaderboard`);
    assert.equal(shell.active_dashboard.features.study_partner, false, `${scenario.key}:study_partner`);
    const diagnostic = resolveAylaExamFeatureEntitlement({
      enrollments: [enrollment],
      plansById: { [plan.id]: plan },
      userId,
      requestedExamTrack: "usmle_step_1",
      legacyExamTrack: "usmle_step_1",
      legacyStudentId: studentId,
      feature: "diagnostic",
      now: new Date("2026-07-28T12:00:00.000Z"),
    });
    assert.equal(diagnostic.allowed, true, `${scenario.key}:diagnostic`);
  }
  assert.deepEqual(
    AYLA_STUDENT_FEATURES.filter((row) => ["leaderboard", "study_partner"].includes(row.key))
      .map((row) => row.key)
      .sort(),
    ["leaderboard", "study_partner"],
  );
});

test("private QBank activation disables unscoped delivery and preserves ordinary-student isolation", () => {
  const activation = server.slice(
    server.indexOf("const AYLA_STEP1_PILOT_COLLECTION_NAMESPACE"),
    server.indexOf('app.get("/api/ayla/admin/pilot/step1/preview"'),
  );
  assert.match(activation, /destination_scope: ""[\s\S]*enabled: false/);
  assert.match(activation, /destination_scope: AYLA_STEP1_PILOT_DESTINATION_SCOPE[\s\S]*enabled: true/);
  assert.match(activation, /function aylaStep1PilotCollectionMatches/);
  assert.match(activation, /\\buworld\\b/);
  assert.match(activation, /ordinaryStudentDelivery: false/);
  assert.match(activation, /source_rights_status/);
  assert.match(activation, /ready_for_owner_approval/);
  assert.match(activation, /sourceType: "content_registry_flashcard"/);
  assert.match(activation, /answerMode: "reveal_only"/);
  assert.match(activation, /flashcardsActivated/);
  assert.match(activation, /aylaQueuePrivatePilotVimeoClassificationRecovery/);
  assert.match(activation, /qbank_taxonomy_now_available/);
  assert.match(activation, /privatePilotClassificationRecoveryCount/);
  assert.match(activation, /vimeoEmbedDomainFingerprint/);
  assert.match(activation, /row\.pilotOnly === true \|\| row\.accessScope === "private_pilot"/);
  assert.match(activation, /ensureVimeoEmbedDomains/);
});

test("flashcard registry SQL does not expose a scoped pilot collection to unscoped LMS reads", () => {
  assert.match(
    registry,
    /getContentRegistryFlashcardQuestion\(\{ questionId, examTrack, destinationScope = '' \}\)/,
  );
  assert.match(
    registry,
    /d\.destination_scope='' OR d\.destination_scope=\$3/,
  );
  assert.match(
    registry,
    /d\.destination_scope='' OR d\.destination_scope=\$5/,
  );
});

test("notebook-generated cards are visible and force a safe roadmap refresh", () => {
  const route = server.slice(
    server.indexOf('app.post("/api/ayla/students/:studentId/notebooks/:id/generate-flashcards"'),
    server.indexOf('app.get("/api/ayla/community/profile"'),
  );
  assert.match(route, /\["numbered", "numbered_point", "text", "quote"\]/);
  assert.match(route, /aylaV189BuildDailyPlan\(db, student/);
  assert.match(route, /available in the flashcard queue/);
  assert.match(server, /aylaV189RelevantResources\(db, student, \["flashcard"\]\)/);
  assert.match(server, /aylaPilotContentVisibleToStudent\(storedResource, student\)/);
});
