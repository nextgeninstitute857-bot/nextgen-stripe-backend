import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("AylaMed production domains are allowed without changing LMS origins", () => {
  assert.match(server, /const allowedOrigins = \[[\s\S]{0,600}"https:\/\/aylamedapp\.com"/);
  assert.match(server, /const allowedOrigins = \[[\s\S]{0,650}"https:\/\/www\.aylamedapp\.com"/);
  assert.match(server, /"https:\/\/live\.nextgenusmlelms\.com"/);
});

test("native app origins are exact and credentialed through the shared API", () => {
  for (const origin of ["capacitor://localhost", "ionic://localhost", "https://localhost"]) {
    assert.match(server, new RegExp(`"${origin.replaceAll("/", "\\/")}"`));
  }
  assert.doesNotMatch(server, /host\.endsWith\("\.localhost"\)/);
});

test("AylaMed links use the production domain and correct password-reset route", () => {
  assert.match(server, /process\.env\.AYLA_PUBLIC_URL \|\| "https:\/\/aylamedapp\.com"/);
  assert.match(server, /const resetUrl = `\$\{base\}\/reset-password\?token=\$\{encodeURIComponent\(rawToken\)\}`/);
  assert.doesNotMatch(server, /const resetUrl = `\$\{base\}\/\?reset_token=/);
  assert.match(server, /"POST \/api\/ayla\/auth\/google"/);
});

test("AylaMed Vimeo privacy keeps staging access and uses the canonical production host", () => {
  assert.match(server, /function aylaPrivatePilotVimeoEmbedDomains\(\)[\s\S]{0,550}"https:\/\/paleturquoise-quail-255896\.hostingersite\.com"/);
  assert.match(server, /function aylaPrivatePilotVimeoEmbedDomains\(\)[\s\S]{0,600}"https:\/\/aylamedapp\.com"/);
  assert.doesNotMatch(server, /function aylaPrivatePilotVimeoEmbedDomains\(\)[\s\S]{0,650}"https:\/\/www\.aylamedapp\.com"/);
  assert.match(server, /vimeoEmbedDomainFailureCounts/);
});

test("USMLE shares one domain family while other exam domains remain API-scoped", () => {
  assert.match(server, /\.\.\.aylaConfiguredExamOrigins\(process\.env\)/);
  assert.match(server, /app\.use\("\/api\/ayla"[\s\S]*?aylaExamSiteRequestTrack/);
  assert.match(server, /app\.get\("\/api\/ayla\/exam-sites"/);
  assert.match(server, /aylaCurrentStudentShell\(db, rawUser, req\.aylaExamSite\)/);
  assert.match(server, /usmle_steps_share_one_website: true/);
  assert.match(server, /non_usmle_websites_are_independently_bound: true/);
  assert.match(server, /physical_database_copy_per_exam: false/);
  assert.match(server, /cross_exam_state_copy: false/);
});
