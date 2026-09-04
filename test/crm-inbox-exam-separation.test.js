import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("health exposes the exam-inbox routing release for deployment checks", () => {
  assert.match(server, /crm_exam_inbox_routing_build: "v322-exam-inboxes-zero-ai-filter"/);
});

test("conversation inbox exposes persistent exam and filtered routing fields", () => {
  const inboxBuilder = server.slice(
    server.indexOf("function buildConversationInbox"),
    server.indexOf("function parseInboundSocialPayload"),
  );

  assert.match(inboxBuilder, /exam_track: examTrack \|\| null/);
  assert.match(inboxBuilder, /inbox_bucket: isFiltered/);
  assert.match(inboxBuilder, /lead_relevance:/);
  assert.match(inboxBuilder, /ai_suppressed: isFiltered/);
});

test("inbound webhooks classify before the AI reply generator", () => {
  const guard = server.slice(
    server.indexOf("function ngShouldSkipAiAutoForInbound"),
    server.indexOf("function ngMarkAiAutoProcessed"),
  );
  const webhook = server.slice(
    server.indexOf("async function handleUniversalWebhook"),
    server.indexOf('app.get("/webhooks/social/:platform/:integrationId?")'),
  );

  assert.ok(guard.indexOf("applyLeadInboxRouting") < guard.indexOf("ngTryLockAiAuto"));
  assert.match(guard, /reason: "irrelevant_lead_filtered"/);
  assert.match(guard, /ai_credits_used: 0/);
  assert.ok(webhook.indexOf("ngShouldSkipAiAutoForInbound") < webhook.indexOf("ngGenerateStudentAutoReply"));
});
