import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  aylaSuccessStoryConsumptionEligibility,
  normalizeAylaSuccessStoryDraft,
  reviewAylaSuccessStory,
  selectAylaSuccessStoryStrategies,
} from "../lib/aylamed-success-story-training.js";
import {
  buildAylaPersonalTutorDecision,
  formatAylaPersonalTutorAnswer,
  validateAylaPersonalTutorPlanCommand,
} from "../lib/aylamed-personal-tutor.js";

const now = "2026-07-20T12:00:00.000Z";

function approvedStory(overrides = {}) {
  const draft = normalizeAylaSuccessStoryDraft({
    title: "Perfusion recovery strategy",
    exam_track_id: "USMLE Step 1",
    challenge_tags: ["Cardiology", "Perfusion", "overload"],
    strategy_tags: ["focused blocks", "error log"],
    strategy_steps: [
      { action: "Complete one focused perfusion block before opening a new system", why_it_helped: "It reduced context switching", use_when: "Repeated misses cross Cardiology and Renal", caution: "Reduce the block when the current roadmap is overloaded" },
      { action: "Write one why-wrong line after each reviewed miss" },
    ],
    applicability_notes: "Use this only alongside the current verified roadmap assignment.",
    limitations: "The tactic may not fit every learner and outcomes vary.",
    evidence_basis: "mixed_verified_evidence",
    outcome_summary: "Verified completion and question accuracy improved during the reviewed period.",
    source_reference: "SUCCESS_2026_0042",
    consent_verified: true,
    anonymized: true,
    ...overrides,
  }, {}, now);
  draft.id = overrides.id || "story-approved";
  draft.created_by = "admin-1";
  return reviewAylaSuccessStory(draft, { action: "approve", reviewer: { id: "admin-2", email: "reviewer@example.com" } }, now);
}

test("only approved anonymized exact-exam stories produce outcome-free strategy guidance", () => {
  const approved = approvedStory();
  const crossExam = approvedStory({ id: "story-plab", exam_track_id: "PLAB" });
  const draft = normalizeAylaSuccessStoryDraft({
    title: "Draft tactic",
    exam_track_id: "USMLE Step 1",
    challenge_tags: ["Perfusion"],
    strategy_steps: ["Use a short review block"],
  }, {}, now);
  draft.id = "story-draft";
  const tamperedPii = { ...approvedStory({ id: "story-pii" }), strategy_steps: [{ id: "step_1", action: "Email named.student@example.com for the method" }] };

  const selected = selectAylaSuccessStoryStrategies({
    stories: [draft, crossExam, tamperedPii, approved],
    examTrack: "usmle-step-1",
    focus: ["Cardiology", "Perfusion"],
    limit: 5,
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].strategy_id, "story-approved");
  assert.equal(selected[0].exam_track_id, "usmle_step_1");
  assert.equal(selected[0].advisory_only, true);
  assert.equal(selected[0].outcome_summary_included, false);
  assert.equal(selected[0].outcome_promised, false);
  assert.equal(Object.hasOwn(selected[0], "outcome_summary"), false);
  assert.doesNotMatch(JSON.stringify(selected[0]), /Verified completion|reviewer@example\.com|SUCCESS_2026_0042|named\.student/);
  assert.equal(aylaSuccessStoryConsumptionEligibility(crossExam, "usmle-step-1").eligible, false);
});

test("approval blocks missing governance, personal identifiers, and guaranteed outcomes", () => {
  const missingConsent = normalizeAylaSuccessStoryDraft({
    title: "Time management tactic",
    exam_track_id: "USMLE Step 1",
    challenge_tags: ["time management"],
    strategy_steps: ["Review one block"],
    evidence_basis: "verified_platform_progress",
    outcome_summary: "Completion improved during the observed period.",
    source_reference: "STORY_100",
    anonymized: true,
  }, {}, now);
  assert.throws(() => reviewAylaSuccessStory(missingConsent, { action: "approve", reviewer: { id: "admin" } }, now), (error) => error.code === "SUCCESS_STORY_APPROVAL_BLOCKED" && error.details.reasons.includes("consent_verification_required"));

  const unsafe = normalizeAylaSuccessStoryDraft({
    title: "Guaranteed result tactic",
    exam_track_id: "USMLE Step 1",
    challenge_tags: ["planning"],
    strategy_steps: ["This always works and will definitely produce the same score"],
    evidence_basis: "admin_reviewed_student_report",
    outcome_summary: "The reviewed result guarantees the same outcome for every learner.",
    source_reference: "STORY_101",
    consent_verified: true,
    anonymized: true,
  }, {}, now);
  assert.throws(() => reviewAylaSuccessStory(unsafe, { action: "approve", reviewer: { id: "admin" } }, now), (error) => error.code === "SUCCESS_STORY_APPROVAL_BLOCKED" && error.details.reasons.includes("guaranteed_outcome"));
  assert.throws(() => normalizeAylaSuccessStoryDraft({ student_email: "student@example.com" }), (error) => error.code === "SUCCESS_STORY_DIRECT_IDENTIFIER_FORBIDDEN");
  assert.throws(() => normalizeAylaSuccessStoryDraft({ title: "Named source", exam_track_id: "USMLE Step 1", challenge_tags: ["planning"], strategy_steps: ["Email named.student@example.com for details"] }), (error) => error.code === "SUCCESS_STORY_PII_DETECTED");
});

test("Personal Tutor attaches strategy evidence without creating a second plan or an automatic plan command", () => {
  const [strategy] = selectAylaSuccessStoryStrategies({ stories: [approvedStory()], examTrack: "usmle_step_1", focus: ["Perfusion"] });
  const decision = buildAylaPersonalTutorDecision({
    date: "2026-07-20",
    student: { examTrackId: "usmle_step_1", dailyHours: 3, weakAreas: ["Cardiology"] },
    plan: { id: "plan-1", date: "2026-07-20", version: 5, status: "active", capacityMinutes: 180 },
    assignments: [{ id: "assignment-1", category: "internal_mcqs", title: "Perfusion block", system: "Cardiology", topic: "Perfusion", estimatedMinutes: 45, status: "pending", priority: "High" }],
    successStoryStrategies: [strategy],
  });
  assert.equal(decision.authority.oneStoredRoadmap, true);
  assert.equal(decision.authority.successStoriesAdvisoryOnly, true);
  assert.equal(decision.authority.successStoryOutcomesNeverCopied, true);
  assert.equal(decision.successStoryGuidance.count, 1);
  assert.equal(decision.successStoryGuidance.outcomeSummariesIncluded, false);
  assert.equal(decision.successStoryGuidance.changesRoadmapAutomatically, false);
  const recommendation = decision.recommendations.find((row) => row.kind === "adapt_approved_success_strategy");
  assert.ok(recommendation);
  assert.equal(recommendation.planChange, false);
  assert.equal(recommendation.directive, null);
  assert.throws(() => validateAylaPersonalTutorPlanCommand({ expectedPlanId: "plan-1", expectedPlanVersion: 5, recommendationId: recommendation.id }, decision), (error) => error.code === "TUTOR_RECOMMENDATION_IS_NAVIGATION_ONLY");
  assert.match(formatAylaPersonalTutorAnswer(decision), /guidance only; it does not promise the same outcome or replace your roadmap/i);
});

test("server wires versioned CRM governance and read-only tutor consumption", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const NEXTGEN_BACKEND_BUILD = "v219-safe-shared-student-profile"/);
  assert.match(server, /const AYLA_BACKEND_BUILD = "aylamed-safe-shared-student-profile-v219"/);
  assert.match(server, /schema_version: 14/);
  assert.match(server, /app\.get\("\/admin\/crm\/ai-training\/success-stories"/);
  assert.match(server, /app\.post\("\/admin\/crm\/ai-training\/success-stories"/);
  assert.match(server, /app\.put\("\/admin\/crm\/ai-training\/success-stories\/:storyId"/);
  assert.match(server, /app\.post\("\/admin\/crm\/ai-training\/success-stories\/:storyId\/review"/);
  assert.match(server, /STALE_SUCCESS_STORY_VERSION/);
  assert.match(server, /await readCrmDbSnapshotOnly\(\)/);
  assert.match(server, /successStoryOutcomesIncluded: false/);
});
