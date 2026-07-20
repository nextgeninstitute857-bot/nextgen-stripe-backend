import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCrossSystemWeakAreaSummary,
  calculateLearningPartnerCompatibility,
  computeLearningStreak,
  rankLearningLeaderboard,
  resolveStrictLmsIdentity,
  sanitizeLearningPartnerProfile,
} from "../lib/learning-progress-services.js";

test("shared streak counts real activity while rest days only bridge gaps", () => {
  const streak = computeLearningStreak({
    activityDates: ["2026-07-16", "2026-07-17", "2026-07-19", "2099-01-01"],
    today: "2026-07-20",
    isFreezeDate: (date) => date === "2026-07-18",
  });
  assert.equal(streak.study_streak, 3);
  assert.equal(streak.best_streak, 3);
  assert.equal(streak.total_study_days, 3);
  assert.equal(streak.current_start_date, "2026-07-16");
  assert.equal(streak.freeze_days_create_activity, false);
  assert.deepEqual(streak.activity_dates, ["2026-07-16", "2026-07-17", "2026-07-19"]);
});

test("leaderboard ranking is deterministic and never mutates source rows", () => {
  const source = [
    { studentId: "b", points: 50, improvementScore: 4 },
    { studentId: "c", points: 40, improvementScore: 20 },
    { studentId: "a", points: 50, improvementScore: 4 },
  ];
  const before = structuredClone(source);
  const ranked = rankLearningLeaderboard(source, { scoreFields: ["points", "improvementScore"] });
  assert.deepEqual(ranked.map((row) => [row.rank, row.studentId]), [[1, "a"], [2, "b"], [3, "c"]]);
  assert.deepEqual(source, before);
});

test("strict LMS identity accepts explicit or unique exact email only", () => {
  const lmsUsers = [
    { id: "lms-1", email: "doctor@example.com", role: "student", status: "active" },
    { id: "lms-2", email: "other@example.com", role: "student", status: "active" },
  ];
  assert.deepEqual(resolveStrictLmsIdentity({
    aylaUser: { email: "Doctor@Example.com" },
    student: {},
    lmsUsers,
  }), { linked: true, method: "exact_email", reason: null, lmsUserId: "lms-1" });
  assert.equal(resolveStrictLmsIdentity({
    aylaUser: { email: "doctor@example.com" },
    student: { lms_user_id: "lms-2" },
    lmsUsers,
  }).reason, "explicit_lms_email_mismatch");
  assert.equal(resolveStrictLmsIdentity({
    aylaUser: { email: "doctor@example.com" },
    lmsUsers: [...lmsUsers, { id: "duplicate", email: "doctor@example.com", role: "student" }],
  }).reason, "ambiguous_exact_email");
  assert.equal(resolveStrictLmsIdentity({
    aylaUser: { email: "admin@example.com" },
    lmsUsers: [{ id: "admin", email: "admin@example.com", role: "admin" }],
  }).linked, false);
});

test("weak areas require verified evidence and identify shared underlying topics", () => {
  const summary = buildCrossSystemWeakAreaSummary([
    { topic: "Perfusion", system: "Cardiovascular", source: "aylamed_questions", weaknessScore: 90, verified: true },
    { topic: "Perfusion", system: "Renal", source: "aylamed_questions", weaknessScore: 80, verified: true },
    { topic: "Perfusion", system: "Cardiovascular", source: "lms:course-1", weaknessScore: 60, verified: true },
    { topic: "Fabricated", system: "Neurology", source: "client", weaknessScore: 100, verified: false },
  ]);
  assert.equal(summary.verifiedEvidenceOnly, true);
  assert.equal(summary.sharedUnderlyingTopics[0].topic, "Perfusion");
  assert.deepEqual(summary.sharedUnderlyingTopics[0].systems, ["Cardiovascular", "Renal"]);
  assert.deepEqual(summary.sharedUnderlyingTopics[0].sources, ["aylamed_questions", "lms:course-1"]);
  assert.doesNotMatch(JSON.stringify(summary), /Fabricated/);
});

test("partner enrichment removes contacts and scores only safe preferences", () => {
  const privateProfile = {
    email: "private@example.com",
    whatsapp: "+100000000",
    telegram_username: "private_handle",
    exam_type: "USMLE Step 1",
    timezone: "Asia/Karachi",
    target_exam_date: "2026-08-10",
    current_subjects: ["Perfusion"],
    preferred_time_blocks: ["Evening"],
    language_preference: ["English"],
    study_style: "Accountability",
    available_hours_per_day: 3,
  };
  const safe = sanitizeLearningPartnerProfile(privateProfile);
  assert.doesNotMatch(JSON.stringify(safe), /private@example|100000000|private_handle|email|whatsapp|telegram/i);
  const score = calculateLearningPartnerCompatibility(safe, {
    examTrack: "USMLE Step 1",
    timezone: "Asia/Karachi",
    targetDate: "2026-08-20",
    subjects: ["Perfusion"],
    availability: ["Evening"],
    languages: ["English"],
    studyStyle: "Accountability",
    dailyHours: 3,
  });
  assert.ok(score.score >= 80, JSON.stringify(score));
  assert.match(score.reasons.join(" "), /exam track/i);
});
