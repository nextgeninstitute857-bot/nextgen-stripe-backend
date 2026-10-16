import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Ayla calmer: unpaid leads get the live-class sequence for one week, then a
// Monday invite for three more weeks, then nothing; only the morning invite by
// default; LMS students are never treated as leads; no-phone leads stay out of
// WhatsApp; two same-day failures stop retries.
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const source = server.slice(
  server.indexOf("function ngLmsActiveStudentKeys"),
  server.indexOf("function ngDailyLiveSessionAttemptMatches"),
);
const guardSource = server.slice(
  server.indexOf("function ngDailyLiveSessionAttemptMatches"),
  server.indexOf("function ngDailyLiveSessionPendingLeadBatch"),
);

const ensureCrmArray = (db, key) => {
  if (!Array.isArray(db[key])) db[key] = [];
  return db[key];
};
const weekdayOf = (date) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(date).getUTCDay()];

const helpers = new Function(
  "isPaidEnrollmentActive", "ng41LeadPhone", "ngLatestInbound", "ngLeadConversationMessages",
  "ngDailySessionTimeParts", "normalizeCrmLeadStageValue", "ngLeadIsPaidOrGroupAddedForLiveSession",
  "ngAylaLeadGoogleMeetState", "ngAylaFindActiveGoogleMeetAppointment", "ng41IsSuppressed",
  `${source}; return { ngLmsActiveStudentKeys, ngLeadIsLmsStudent, ngDailyLiveSessionEligibleLead };`,
)(
  (enrollment) => enrollment.status === "active",
  (lead) => lead.whatsapp || lead.phone || "",
  (messages) => [...messages].reverse().find((m) => m.direction === "inbound"),
  (db, leadId) => (db.messages || []).filter((m) => m.lead_id === leadId),
  (date) => ({ weekday: weekdayOf(date), hour: 9, minute: 0 }),
  (value, fallback) => value || fallback,
  () => false,
  () => false,
  () => null,
  () => false,
);

const guards = new Function("ensureCrmArray", `${guardSource}; return { ngDailyLiveSessionAlreadyAttempted };`)(ensureCrmArray);

const now = new Date("2026-10-19T13:00:00Z"); // a Monday
const tuesday = new Date("2026-10-20T13:00:00Z");
const daysAgo = (n, from = now) => new Date(from.getTime() - n * 86400000).toISOString();
const lead = (extra = {}) => ({ id: "lead-1", stage: "new_lead", whatsapp: "+1 555 010 0001", current_channel: "whatsapp", ...extra });
const ok = (l, action = "daily_session_invite", when = now, settings = {}, db = {}, lmsStudents = null) =>
  helpers.ngDailyLiveSessionEligibleLead(db, l, settings, { action, now: when, lmsStudents });

test("a new lead gets only the morning invite by default", () => {
  const l = lead({ created_at: daysAgo(2) });
  assert.equal(ok(l, "daily_session_invite"), true);
  assert.equal(ok(l, "five_minute_reminder"), false);
  assert.equal(ok(l, "session_link"), false);
  assert.equal(ok(l, "post_session_recording"), false);
});

test("leads who asked for reminders (or the full-sequence switch) get the whole sequence in week 1", () => {
  assert.equal(ok(lead({ created_at: daysAgo(2), live_session_reminders_opt_in: true }), "session_link"), true);
  assert.equal(ok(lead({ created_at: daysAgo(2) }), "post_session_recording", now, { daily_session_full_sequence: true }), true);
});

test("after the first week: one Monday invite for three weeks, then nothing", () => {
  const l = lead({ created_at: daysAgo(10) });
  assert.equal(ok(l, "daily_session_invite", now), true); // Monday
  assert.equal(ok(lead({ created_at: daysAgo(11, tuesday) }), "daily_session_invite", tuesday), false); // Tuesday
  assert.equal(ok(lead({ created_at: daysAgo(10), live_session_reminders_opt_in: true }), "session_link", now), false);
  assert.equal(ok(lead({ created_at: daysAgo(40) }), "daily_session_invite", now), false);
});

test("a reply from the lead restarts their first week", () => {
  const db = { messages: [{ lead_id: "lead-1", direction: "inbound", created_at: daysAgo(1) }] };
  assert.equal(ok(lead({ created_at: daysAgo(60) }), "daily_session_invite", tuesday, {}, db), true);
});

test("LMS students with paid access are never sent the sales sequence", () => {
  const keys = helpers.ngLmsActiveStudentKeys({
    users: { u1: { id: "u1", email: "Student@Example.com", phone: "+1 (555) 010-0001" } },
    enrollments: { e1: { id: "e1", user_id: "u1", status: "active" }, e2: { id: "e2", user_id: "u2", is_demo: true, status: "active" } },
  });
  assert.equal(ok(lead({ created_at: daysAgo(1), email: "student@example.com", whatsapp: "" , current_channel: "instagram" }), "daily_session_invite", now, {}, {}, keys), false);
  assert.equal(ok(lead({ created_at: daysAgo(1) }), "daily_session_invite", now, {}, {}, keys), false); // same phone
  assert.equal(ok(lead({ created_at: daysAgo(1), whatsapp: "+234 800 000 0000" }), "daily_session_invite", now, {}, {}, keys), true);
});

test("leads without a phone number are kept out of WhatsApp", () => {
  assert.equal(ok(lead({ created_at: daysAgo(1), whatsapp: "", email: "a@b.co" })), false);
  assert.equal(ok(lead({ created_at: daysAgo(1), whatsapp: "", current_channel: "instagram" })), true);
});

test("two failures of the same message on the same day stop retries", () => {
  const meta = { daily_live_session_action: "daily_session_invite", daily_live_session_date: "2026-10-19" };
  const l = { id: "lead-1" };
  const db = { message_logs: [{ lead_id: "lead-1", status: "failed", metadata: meta }] };
  assert.equal(guards.ngDailyLiveSessionAlreadyAttempted(db, l, "daily_session_invite", "2026-10-19"), false);
  db.message_logs.push({ lead_id: "lead-1", status: "failed", metadata: meta });
  assert.equal(guards.ngDailyLiveSessionAlreadyAttempted(db, l, "daily_session_invite", "2026-10-19"), true);
  assert.equal(guards.ngDailyLiveSessionAlreadyAttempted(db, l, "daily_session_invite", "2026-10-20"), false);
});

const prefSource = server.slice(
  server.indexOf("function ngLiveSessionReminderPreference"),
  server.indexOf("function appendSocialConversation"),
);
const pref = new Function("nowIso", `${prefSource}; return { ngLiveSessionReminderPreference, ngApplyLiveSessionReminderPreference };`)(() => "2026-10-17T00:00:00.000Z");

test("a lead who asks for reminders is switched to the full sequence, and can switch it off", () => {
  for (const text of ["Please remind me before the class", "can you send me the link before class?", "Send me a reminder", "notify me when it starts"]) {
    assert.equal(pref.ngLiveSessionReminderPreference(text), true, text);
  }
  for (const text of ["Stop the reminders please", "don't send me links", "no more notifications"]) {
    assert.equal(pref.ngLiveSessionReminderPreference(text), false, text);
  }
  assert.equal(pref.ngLiveSessionReminderPreference("I don't have the link, send me the link before class"), true);
  for (const text of ["I'm at work at that time", "what is the price?", "I don't know the timing", ""]) {
    assert.equal(pref.ngLiveSessionReminderPreference(text), null, text);
  }
  const l = lead({ created_at: daysAgo(2) });
  assert.equal(pref.ngApplyLiveSessionReminderPreference(l, "remind me please"), true);
  assert.equal(l.live_session_reminders_opt_in, true);
  assert.equal(ok(l, "five_minute_reminder"), true);
  pref.ngApplyLiveSessionReminderPreference(l, "stop reminders");
  assert.equal(ok(l, "five_minute_reminder"), false);
});
