import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("AylaMed production domains are allowed without changing LMS origins", () => {
  assert.match(server, /const allowedOrigins = \[[\s\S]{0,600}"https:\/\/aylamedapp\.com"/);
  assert.match(server, /const allowedOrigins = \[[\s\S]{0,650}"https:\/\/www\.aylamedapp\.com"/);
  assert.match(server, /"https:\/\/live\.nextgenusmlelms\.com"/);
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
