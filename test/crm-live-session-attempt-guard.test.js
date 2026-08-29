import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = server.indexOf("function ngDailyLiveSessionAttemptMatches");
const end = server.indexOf("function ngDailyLiveSessionText");
const source = server.slice(start, end);

const ensureCrmArray = (db, key) => {
  if (!Array.isArray(db[key])) db[key] = [];
  return db[key];
};

const helpers = new Function(
  "ensureCrmArray",
  "withTimestamps",
  "uuid",
  "normalizeAutomationChannel",
  `${source}; return { ngDailyLiveSessionAlreadyAttempted, ngStartDailyLiveSessionAttempt };`,
)(
  ensureCrmArray,
  (value) => ({ ...value, created_at: "2026-08-28T20:00:00.000Z", updated_at: "2026-08-28T20:00:00.000Z" }),
  () => "attempt-1",
  (value) => value,
);

test("a failed provider log blocks another automated attempt for the same lead, action, and day", () => {
  const lead = { id: "lead-1", current_channel: "whatsapp" };
  const db = {
    message_logs: [{
      lead_id: lead.id,
      status: "failed",
      metadata: { daily_live_session_action: "post_session_recording", daily_live_session_date: "2026-08-28" },
    }],
  };

  assert.equal(helpers.ngDailyLiveSessionAlreadyAttempted(db, lead, "post_session_recording", "2026-08-28"), true);
  assert.equal(helpers.ngDailyLiveSessionAlreadyAttempted(db, lead, "session_link", "2026-08-28"), false);
  assert.equal(helpers.ngDailyLiveSessionAlreadyAttempted(db, lead, "post_session_recording", "2026-08-29"), false);
});

test("the scheduler claims an action before provider delivery and the claim is durable", () => {
  const lead = { id: "lead-1", current_channel: "whatsapp" };
  const db = {};

  const claim = helpers.ngStartDailyLiveSessionAttempt(db, lead, "post_session_recording", "2026-08-28", "run_due");

  assert.equal(claim.status, "claimed");
  assert.equal(claim.metadata.daily_live_session_action, "post_session_recording");
  assert.equal(claim.metadata.daily_live_session_date, "2026-08-28");
  assert.equal(db.message_delivery_locks.length, 1);
  assert.equal(helpers.ngDailyLiveSessionAlreadyAttempted(db, lead, "post_session_recording", "2026-08-28"), true);
});

test("scheduler code finishes failed claims and never depends on successful logs alone", () => {
  const scheduler = server.slice(server.indexOf("async function ngRunDailyLiveSessionScheduler"), server.indexOf("function ngGoogleMeetAppointmentDateTime"));
  assert.match(scheduler, /const attempt = ngStartDailyLiveSessionAttempt/);
  assert.match(scheduler, /ngFinishDeliveryLock\(attempt, "failed"/);
  assert.match(scheduler, /reason: "already_attempted_today"/);
  assert.doesNotMatch(server, /function ngDailyLiveSessionAlreadySent/);
});

test("failed automated deliveries do not replace the real inbox preview", () => {
  const inbox = server.slice(server.indexOf("function ngInboxAutomatedDeliveryFailure"), server.indexOf("function parseInboundSocialPayload"));
  const helperSource = server.slice(server.indexOf("function ngInboxAutomatedDeliveryFailure"), server.indexOf("function buildConversationInbox"));
  const isAutomatedFailure = new Function(`${helperSource}; return ngInboxAutomatedDeliveryFailure;`)();
  assert.equal(isAutomatedFailure({ status: "failed", metadata: { source: "daily_live_session_scheduler", daily_live_session_action: "post_session_recording" } }), true);
  assert.equal(isAutomatedFailure({ status: "failed", metadata: { source: "full_ai_auto", ai_auto: true } }), true);
  assert.equal(isAutomatedFailure({ status: "failed", metadata: {} }), true);
  assert.equal(isAutomatedFailure({ status: "failed", source: "whatsapp", metadata: {} }), true);
  assert.equal(isAutomatedFailure({ status: "logged", provider_error: "Provider rejected", source: "whatsapp", metadata: {} }), true);
  assert.equal(isAutomatedFailure({ status: "logged", provider_error: "Provider rejected", source: "whatsapp", metadata: { source: "compact_conversations_inbox" } }), false);
  assert.equal(isAutomatedFailure({ status: "failed", source: "whatsapp", metadata: { source: "compact_conversations_inbox" } }), false);
  assert.equal(isAutomatedFailure({ status: "failed", metadata: { source: "compact_conversations_inbox" } }), false);
  assert.match(inbox, /inboxMessages\.filter\(\(message\) => !ngInboxAutomatedDeliveryFailure\(message\)\)/);
});
