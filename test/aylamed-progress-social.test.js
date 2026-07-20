import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("server wires v214 through shared read-only LMS/Ayla progress services", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const NEXTGEN_BACKEND_BUILD = "v219-safe-shared-student-profile"/);
  assert.match(server, /const AYLA_BACKEND_BUILD = "aylamed-safe-shared-student-profile-v219"/);
  assert.match(server, /schema_version: 13/);
  assert.match(server, /function ngStudentStudyActivityDates/);
  assert.match(server, /function ngComputeStudentStudyStreakWithFreeze[\s\S]*?computeLearningStreak/);
  assert.match(server, /function ngPublicLeaderboardList[\s\S]*?rankLearningLeaderboard/);
  assert.match(server, /function aylaV214LmsContext/);
  assert.match(server, /resolveStrictLmsIdentity/);
  assert.match(server, /app\.get\("\/api\/ayla\/students\/:studentId\/progress"/);
  assert.match(server, /app\.get\("\/api\/ayla\/students\/:studentId\/revision"/);
  assert.match(server, /cross_product_points_combined: false/);
  assert.match(server, /lms_leaderboard_unchanged: true/);
  assert.match(server, /mutateAylaDb\(async \(db\) => \{[\s\S]*?aylaStudyPartnerRequests/);

  const integration = server.slice(server.indexOf("function aylaV214LmsContext"), server.indexOf("function aylaV189MatchScore"));
  assert.doesNotMatch(integration, /writeLiveDb\s*\(/);
  assert.doesNotMatch(integration, /writeCrmDb\s*\(/);
  assert.doesNotMatch(integration, /correctAnswer\s*:|correct_answer\s*:|answerKey\s*:/);
});
