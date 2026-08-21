import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("WhatsApp webhook ignores Meta status callbacks before creating CRM leads", () => {
  const handler = server.slice(
    server.indexOf("async function handleUniversalWebhook"),
    server.indexOf('app.get("/webhooks/social/:platform/:integrationId?"'),
  );

  assert.match(server, /const CRM_AYLA_REPLY_BUILD = "v270-whatsapp-fast-ack-reliable-retry"/);
  assert.match(handler, /if \(!inboundMessages\.length\)/);
  assert.match(handler, /event: statuses\.length \? "message_status" : "ignored_non_message"/);
  assert.ok(
    handler.indexOf("if (!inboundMessages.length)") < handler.indexOf("upsertSocialLead"),
    "status-only callbacks must be returned before lead creation",
  );
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

