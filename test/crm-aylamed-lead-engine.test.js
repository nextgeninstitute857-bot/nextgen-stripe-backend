import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = fs.readFileSync(path.join(here, "..", "server.js"), "utf8");

test("Meta forms preserve their real acquisition platform", () => {
  const source = server.slice(
    server.indexOf('function normalizeCrmLeadSource'),
    server.indexOf('function normalizeCrmLeadAiMode'),
  );

  assert.match(source, /text\.includes\("instagram"\)\) return "instagram"/);
  assert.match(source, /text\.includes\("facebook"\)\) return "facebook"/);
  assert.match(source, /text\.includes\("meta"\).*return "meta"/s);
  assert.doesNotMatch(source, /if \(text\.includes\("meta"\)[^\n]+return "whatsapp"/);
  assert.ok(source.indexOf('return "instagram"') < source.indexOf('return "meta"'));
  assert.ok(source.indexOf('return "facebook"') < source.indexOf('return "meta"'));
});

test("AylaMed organic lead engine stays draft and covers every exam and source", () => {
  assert.match(server, /AYLAMED_LEAD_ENGINE_EXAMS/);
  for (const exam of ["usmle_step1", "usmle_step2_ck", "usmle_step3", "plab", "amc", "mccqe", "nclex"]) {
    assert.match(server, new RegExp(`key: "${exam}"`));
  }
  for (const platform of ["facebook", "instagram", "reddit"]) {
    assert.match(server, new RegExp(`key: "${platform}"`));
  }
  assert.match(server, /\/admin\/crm\/lead-engine\/aylamed\/bootstrap/);
  assert.match(server, /status: "draft"/);
  assert.match(server, /approval_mode: "draft_only"/);
  assert.match(server, /automation_enabled: false/);
  assert.match(server, /outreach_strategy: "organic_intent_monitoring"/);
  assert.match(server, /lookback_days: 30/);
  assert.match(server, /paid_ads_enabled: false/);
  assert.match(server, /\/login\?\$\{utm\.toString\(\)\}/);
  assert.match(server, /form_id: null/);
});

test("AylaMed public readiness and demo form is removed by the safe bootstrap", () => {
  const bootstrap = server.slice(
    server.indexOf('app.post("/admin/crm/lead-engine/aylamed/bootstrap"'),
    server.indexOf('app.post("/public/crm/forms/:formId/submit"'),
  );
  assert.match(bootstrap, /form_aylamed_exam_readiness/);
  assert.match(bootstrap, /aylamed-exam-readiness-demo/);
  assert.match(bootstrap, /forms_removed: formsRemoved/);
  assert.match(bootstrap, /public_signup_enabled: false/);
  assert.doesNotMatch(server, /function buildAylaMedLeadEngineForm/);
});

test("AylaMed records attribution through an explicit post-registration CRM bridge", () => {
  assert.match(server, /normalizeAylaMarketingAttribution/);
  assert.match(server, /upsertAylaMarketingLead/);
  assert.match(server, /\/api\/ayla\/marketing\/crm-lead/);
  assert.match(server, /marketingExamTrackId.*req\.body\.examTrackId/);
  assert.match(server, /marketingConsent: req\.body\.marketingConsent === true/);
  assert.match(server, /can_message: marketingConsent/);

  const bridge = server.slice(
    server.indexOf('app.post("/api/ayla/marketing/crm-lead"'),
    server.indexOf('app.get("/api/ayla/auth/me"'),
  );
  assert.match(bridge, /aylaGetAuthenticatedUser\(req\)/);
  assert.match(bridge, /upsertAylaMarketingLead/);

  const registration = server.slice(
    server.indexOf('app.post("/api/ayla/auth/register"'),
    server.indexOf('app.post("/api/ayla/admin/pilot-login-links"'),
  );
  assert.doesNotMatch(registration, /upsertAylaMarketingLead/);
});
