import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("WhatsApp webhook ignores Meta status callbacks before creating CRM leads", () => {
  const handler = server.slice(
    server.indexOf("async function handleUniversalWebhook"),
    server.indexOf('app.get("/webhooks/social/:platform/:integrationId?"'),
  );

  assert.match(server, /const CRM_AYLA_REPLY_BUILD = "v275-natural-greeting-single-send"/);
  assert.match(handler, /if \(!inboundMessages\.length\)/);
  assert.match(handler, /event: statuses\.length \? "message_status" : "ignored_non_message"/);
  assert.ok(
    handler.indexOf("if (!inboundMessages.length)") < handler.indexOf("upsertSocialLead"),
    "status-only callbacks must be returned before lead creation",
  );
});

test("bare WhatsApp greetings stay conversational before the sales sequence", () => {
  const signals = server.slice(
    server.indexOf("function ngAylaLatestMessageSignals"),
    server.indexOf("function ngBuildAylaBackendSalesBrain"),
  );
  const salesBrain = server.slice(
    server.indexOf("function ngBuildAylaBackendSalesBrain"),
    server.indexOf("function ngBuildAylaCommandContext"),
  );
  const replyPrompt = server.slice(
    server.indexOf("async function ngGenerateStudentAutoReply"),
    server.indexOf('app.post("/admin/crm/conversations/:leadId/ai-auto-send"'),
  );

  assert.match(signals, /bareGreeting/);
  assert.match(signals, /bare_greeting: bareGreeting/);
  assert.match(signals, /short_reply: shortReply/);
  assert.match(salesBrain, /BARE GREETING TURN/);
  assert.match(salesBrain, /Do not pitch the LMS, demo, live session, recording, UWorld library, Google Meet, pricing/);
  assert.match(replyPrompt, /Do not begin the sales sequence/);
  assert.match(replyPrompt, /Do not say "Thank you, Doctor" in response to a bare hello/);
  assert.match(replyPrompt, /if \(latestSignals\.bare_greeting\)/);
  assert.match(replyPrompt, /intent: "natural_bare_greeting"/);
  assert.match(replyPrompt, /Do not mention or pitch any programme, LMS, demo, live session, recording, UWorld, Google Meet, price, feature, or offer/);
  assert.ok(
    replyPrompt.indexOf("if (latestSignals.bare_greeting)") < replyPrompt.indexOf("const backendSalesBrain"),
    "the greeting-only AI turn must run before the sales brain is constructed",
  );
});

test("AI generation keeps one long-lived lock per inbound message", () => {
  const guard = server.slice(
    server.indexOf("const NG_AI_AUTO_COOLDOWN_SECONDS"),
    server.indexOf("function ngNormalizeLeadAiMode"),
  );

  assert.match(guard, /const NG_AI_AUTO_LOCK_TTL_SECONDS = Number\(process\.env\.AI_AUTO_LOCK_TTL_SECONDS \|\| 180\)/);
  assert.match(guard, /ttlSeconds: options\.lockTtlSeconds \|\| NG_AI_AUTO_LOCK_TTL_SECONDS/);
});

test("WhatsApp inbound messages are persisted and acknowledged before AI work", () => {
  const handler = server.slice(
    server.indexOf("async function handleUniversalWebhook"),
    server.indexOf('app.get("/webhooks/social/:platform/:integrationId?"'),
  );

  assert.match(handler, /source: "whatsapp_fast_ack"/);
  assert.match(handler, /source: "whatsapp_fast_ack_wakeup"/);
  assert.match(handler, /delayMs: 1000/);
  assert.ok(
    handler.indexOf('source: "whatsapp_fast_ack"') < handler.indexOf("let aiAutoResult = null"),
    "WhatsApp must return before the inline AI path",
  );
});

test("heartbeat scans recent pending leads instead of slicing the first stored leads", () => {
  const runner = server.slice(
    server.indexOf("async function ngAylaRunPendingFullAiAuto"),
    server.indexOf("function ngScheduleAylaAutoReplyAfterInbound"),
  );

  assert.match(runner, /\.sort\(\(a, b\) =>/);
  assert.match(runner, /if \(results\.length >= maxResults\) break/);
  assert.doesNotMatch(runner, /\.slice\(0,/);
});

test("WhatsApp provider authorization failures open a shared circuit breaker", () => {
  assert.match(server, /const NG_WHATSAPP_PROVIDER_BLOCK =/);
  assert.match(server, /function ngWhatsAppProviderBlockStatus\(\)/);
  assert.match(server, /function ngBlockWhatsAppProvider\(/);
  assert.match(server, /text\.includes\("api access blocked"\)/);
  assert.match(server, /provider_configuration_blocked: true/);
  assert.match(server, /if \(!dryRun && ngWhatsAppProviderBlockStatus\(\)\.blocked\) return \[\]/);
  assert.match(server, /whatsapp_provider_block: ngWhatsAppProviderBlockStatus\(\)/);
});

test("WhatsApp webhook verification accepts the masked CRM integration secret", () => {
  const verifier = server.slice(
    server.indexOf("async function getMetaWebhookVerifyTokens"),
    server.indexOf("function verifyTelegramSecretHeader"),
  );

  assert.match(verifier, /readCrmDb\(\)/);
  assert.match(verifier, /ensureCrmArray\(db, "integrations"\)/);
  assert.match(verifier, /integration\.api_secret/);
  assert.match(verifier, /expectedTokens\.has\(String\(token\)\)/);
  assert.match(verifier, /process\.env\.WHATSAPP_WEBHOOK_VERIFY_TOKEN/);
});

test("integration edits preserve stored credentials when the UI submits blanks", () => {
  const updateRoute = server.slice(
    server.indexOf('app.put("/admin/crm/integrations/:id"'),
    server.indexOf('app.delete("/admin/crm/integrations/:id"'),
  );

  assert.match(updateRoute, /\["api_key", "api_secret", "access_token"\]/);
  assert.match(updateRoute, /if \(!value \|\| value\.includes\("\*\*\*"\)\) delete payload\[key\]/);
  assert.match(updateRoute, /normalizeCrmCollectionPayload\("integrations", payload,/);
});

test("WhatsApp runtime sends prefer the saved CRM integration credentials", () => {
  const resolver = server.slice(
    server.indexOf("async function resolveWhatsAppCloudConfig"),
    server.indexOf("async function sendWhatsAppCloudMessage"),
  );
  const sender = server.slice(
    server.indexOf("async function sendWhatsAppCloudMessage"),
    server.indexOf("async function sendTelegramMessage"),
  );

  assert.match(resolver, /getIntegrationByPlatform\(crmDb, "whatsapp"\)/);
  assert.match(resolver, /selectedIntegration\?\.api_key/);
  assert.match(resolver, /selectedIntegration\?\.access_token/);
  assert.ok(
    resolver.indexOf("selectedIntegration?.api_key") < resolver.indexOf("process.env.WHATSAPP_ACCESS_TOKEN"),
    "the stored CRM token must be preferred over the legacy environment fallback",
  );
  assert.match(sender, /resolveWhatsAppCloudConfig\(\{ db, integration \}\)/);
  assert.match(sender, /ngClearWhatsAppProviderBlock\(\)/);
  assert.match(server, /caption: resolvedCaption,[\s\S]*?db,[\s\S]*?integration,/);
});
