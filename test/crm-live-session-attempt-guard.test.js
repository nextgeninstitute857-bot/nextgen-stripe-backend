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

test("a final provider failure permits a same-day recovery retry", () => {
  const lead = { id: "lead-1", current_channel: "whatsapp" };
  const db = {
    message_logs: [{
      id: "failed-log-1",
      lead_id: lead.id,
      status: "failed",
      metadata: { daily_live_session_action: "post_session_recording", daily_live_session_date: "2026-08-28" },
    }],
    message_delivery_locks: [{
      lead_id: lead.id,
      status: "sent",
      message_log_id: "failed-log-1",
      metadata: { daily_live_session_action: "post_session_recording", daily_live_session_date: "2026-08-28" },
    }],
  };

  assert.equal(helpers.ngDailyLiveSessionAlreadyAttempted(db, lead, "post_session_recording", "2026-08-28"), false);
  assert.equal(helpers.ngDailyLiveSessionAlreadyAttempted(db, lead, "session_link", "2026-08-28"), false);
  assert.equal(helpers.ngDailyLiveSessionAlreadyAttempted(db, lead, "post_session_recording", "2026-08-29"), false);
});

test("Meta healthy-ecosystem rejection blocks repeated same-day attempts", () => {
  const lead = { id: "lead-1", current_channel: "whatsapp" };
  const metadata = { daily_live_session_action: "post_session_recording", daily_live_session_date: "2026-09-01" };
  const db = {
    message_logs: [{
      id: "engagement-failure",
      lead_id: lead.id,
      status: "failed",
      provider_error: "This message was not delivered to maintain healthy ecosystem engagement.",
      metadata,
    }],
  };

  assert.equal(helpers.ngDailyLiveSessionAlreadyAttempted(db, lead, "post_session_recording", "2026-09-01"), true);
  assert.equal(helpers.ngDailyLiveSessionAlreadyAttempted(db, lead, "post_session_recording", "2026-09-02"), false);
});

test("accepted or in-flight delivery attempts still block duplicate sends", () => {
  const lead = { id: "lead-1", current_channel: "whatsapp" };
  const metadata = { daily_live_session_action: "session_link", daily_live_session_date: "2026-08-31" };

  assert.equal(helpers.ngDailyLiveSessionAlreadyAttempted({
    message_logs: [{ id: "sent-log", lead_id: lead.id, status: "delivered", metadata }],
  }, lead, "session_link", "2026-08-31"), true);

  assert.equal(helpers.ngDailyLiveSessionAlreadyAttempted({
    message_delivery_locks: [{ lead_id: lead.id, status: "claimed", metadata }],
  }, lead, "session_link", "2026-08-31"), true);
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

test("daily live-session batches advance past leads already attempted today", () => {
  const batchSource = server.slice(
    server.indexOf("function ngDailyLiveSessionPendingLeadBatch"),
    server.indexOf("function ngStartDailyLiveSessionAttempt"),
  );
  const pendingBatch = new Function(
    "ensureCrmArray",
    "ngDailyLiveSessionEligibleLead",
    "ngDailyLiveSessionAlreadyAttempted",
    `${batchSource}; return ngDailyLiveSessionPendingLeadBatch;`,
  )(
    (db, collection) => db[collection] || [],
    (_db, lead) => lead.eligible !== false,
    (db, lead, action, dateKey) => (db.attempted || []).includes(`${lead.id}|${action}|${dateKey}`),
  );
  const dateKey = "2026-08-30";
  const action = "daily_session_invite";
  const leads = Array.from({ length: 120 }, (_, index) => ({ id: `lead-${index + 1}`, eligible: true }));
  const attempted = leads.slice(0, 50).map((lead) => `${lead.id}|${action}|${dateKey}`);

  const secondBatch = pendingBatch({ leads, attempted }, {}, { action, dateKey, limit: 50 });

  assert.equal(secondBatch.length, 50);
  assert.equal(secondBatch[0].id, "lead-51");
  assert.equal(secondBatch[49].id, "lead-100");
});

test("failed deliveries stay in audit data and do not replace the real inbox preview", () => {
  const inbox = server.slice(server.indexOf("function ngInboxFailedDeliveryRecord"), server.indexOf("function parseInboundSocialPayload"));
  const helperSource = server.slice(server.indexOf("function ngInboxFailedDeliveryRecord"), server.indexOf("function buildConversationInbox"));
  const isFailedDelivery = new Function(`${helperSource}; return ngInboxFailedDeliveryRecord;`)();
  assert.equal(isFailedDelivery({ status: "failed" }), true);
  assert.equal(isFailedDelivery({ status: "logged", provider_error: "Provider rejected" }), true);
  assert.equal(isFailedDelivery({ status: "delivered" }), false);
  assert.match(inbox, /inboxMessages\.filter\(\(message\) => !ngInboxFailedDeliveryRecord\(message\)\)/);
});
