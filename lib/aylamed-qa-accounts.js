export const AYLA_PERMANENT_QA = Object.freeze({
  planId: "AYLA-PLAN-PERMANENT-QA",
  confirmation: "CREATE PERMANENT QA ACCOUNTS",
  examTracks: Object.freeze([
    "usmle_step_1",
    "usmle_step_2_ck",
    "usmle_step_3",
    "mccqe",
    "plab",
    "amc",
    "nclex",
  ]),
});

function dateOnly(value = new Date()) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function addDays(value, days) {
  const parsed = new Date(`${dateOnly(value)}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Number(days || 0));
  return dateOnly(parsed);
}

function examSlug(examTrack) {
  return String(examTrack || "").trim().toLowerCase().replace(/_/g, "-");
}

export function buildAylaPermanentQaScenarios({ examTrack, examLabel, systems = [], today = new Date() } = {}) {
  if (!AYLA_PERMANENT_QA.examTracks.includes(examTrack)) throw new Error("A supported QA exam track is required");
  const anchorDate = dateOnly(today);
  if (!anchorDate) throw new Error("A valid QA anchor date is required");
  const slug = examSlug(examTrack);
  const weakAreas = systems.slice(0, 2);
  return [
    {
      key: "one_week",
      name: `QA ${examLabel} — One Week`,
      email: `qa.${slug}.one-week@aylamedapp.com`,
      onboardingPath: "quick_profile",
      examDate: addDays(anchorDate, 7),
      dailyHours: 6,
      weeklyStudyDays: 7,
      studyStage: "first_pass_in_progress",
      qbankCompleted: 50,
      qbankAverage: 55,
      selectedWeakAreas: weakAreas,
      scenario: "Seven days to exam through Quick Profile",
    },
    {
      key: "one_month",
      name: `QA ${examLabel} — One Month`,
      email: `qa.${slug}.one-month@aylamedapp.com`,
      onboardingPath: "starting_fresh",
      examDate: addDays(anchorDate, 30),
      dailyHours: 4,
      weeklyStudyDays: 6,
      studyStage: "not_started",
      qbankCompleted: 0,
      qbankAverage: 0,
      selectedWeakAreas: [],
      scenario: "Thirty days to exam through Starting Fresh",
    },
    {
      key: "diagnostic_84_days",
      name: `QA ${examLabel} — Diagnostic`,
      email: `qa.${slug}.diagnostic@aylamedapp.com`,
      onboardingPath: "diagnostic_test",
      examDate: addDays(anchorDate, 84),
      dailyHours: 3,
      weeklyStudyDays: 6,
      studyStage: "first_pass_in_progress",
      qbankCompleted: 0,
      qbankAverage: 0,
      selectedWeakAreas: [],
      scenario: "Eighty-four days to exam through Diagnostic Test",
    },
  ].map((scenario) => ({ ...scenario, anchorDate, examTrack }));
}
