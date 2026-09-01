import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const between = (start, end) => server.slice(server.indexOf(start), server.indexOf(end));

test("Ayla rejects unreleased, stale, and unnamed Zoom links", () => {
  const source = between("function ngAylaLiveSessionLinkViolations", "function ngAylaPricingDraftIsGrounded");
  const violations = new Function("uniqueList", `${source}; return ngAylaLiveSessionLinkViolations;`)((items) => [...new Set(items)]);
  const exact = "https://us06web.zoom.us/j/22222222222?pwd=correct";
  const snapshot = { live_session: { title: "Central Nervous System — Day 7", date: "2026-08-29", url: exact } };

  assert.deepEqual(violations("Tomorrow: https://us06web.zoom.us/j/11111111111?pwd=old", { live_session: { ...snapshot.live_session, url: "" } }), ["live_session_link_not_released_for_exact_session"]);
  assert.deepEqual(violations("Central Nervous System — Day 7 on 2026-08-29 https://us06web.zoom.us/j/11111111111?pwd=old", snapshot), ["wrong_or_stale_live_session_link"]);
  assert.deepEqual(violations(`Join ${exact}`, snapshot), ["live_session_link_missing_exact_session_name", "live_session_link_missing_exact_session_date"]);
  assert.deepEqual(violations(`Central Nervous System — Day 7 on 2026-08-29\n${exact}`, snapshot), []);
});

test("Ayla accepts only the latest published recording with its exact LMS title", () => {
  const source = between("function ngAylaRecordingLinkViolations", "function ngAylaPricingDraftIsGrounded");
  const violations = new Function("uniqueList", `${source}; return ngAylaRecordingLinkViolations;`)((items) => [...new Set(items)]);
  const exact = "https://us06web.zoom.us/rec/play/cns-day-6";
  const title = "Central Nervous System — Day 6 — Neurology / CNS";
  const snapshot = { latest_recording: { title, url: exact } };

  assert.deepEqual(violations(`Old recording: https://us06web.zoom.us/rec/share/june-17`, snapshot), ["wrong_or_stale_recording_link"]);
  assert.deepEqual(violations(`Recording: ${exact}`, snapshot), ["recording_link_missing_exact_title"]);
  assert.deepEqual(violations(`${title}\nRecording:\n${exact}`, snapshot), []);
  assert.deepEqual(violations(`Old recording: https://us06web.zoom.us/rec/share/june-17`, { latest_recording: null }), ["recording_link_not_published"]);
});

test("the trusted Zoom link is released only during its exact class window", () => {
  const source = between("function ngAylaTrustedLiveSessionJoinLink", "async function ngAylaLiveLmsSalesGrounding");
  const trusted = new Function(
    "getSessionStartUtc",
    "DEFAULT_TIMEZONE",
    "DEFAULT_ZOOM_DURATION_MINUTES",
    "hasRealZoomMeetingId",
    "ngManualLiveJoinUrl",
    "ngInspectZoomAttendeeJoinUrl",
    `${source}; return ngAylaTrustedLiveSessionJoinLink;`,
  )(
    (date, time) => new Date(`${date}T${time}:00Z`),
    "UTC",
    120,
    (id) => /^\d{11}$/.test(String(id)),
    (session) => session.zoom_join_url,
    (url, { meetingId }) => ({ valid: url.includes(meetingId) }),
  );
  const session = {
    id: "day-7",
    status: "scheduled",
    scheduled_date: "2026-08-29",
    scheduled_time: "13:00",
    scheduled_timezone: "UTC",
    duration_minutes: 120,
    zoom_meeting_id: "22222222222",
    zoom_join_url: "https://us06web.zoom.us/j/22222222222?pwd=correct",
  };

  assert.equal(trusted(session, new Date("2026-08-29T12:59:59Z")).reason, "not_started");
  assert.equal(trusted(session, new Date("2026-08-29T12:59:59Z")).url, "");
  assert.equal(trusted(session, new Date("2026-08-29T13:00:00Z")).url, session.zoom_join_url);
  assert.equal(trusted({ ...session, status: "completed" }, new Date("2026-08-29T13:10:00Z")).url, "");
  assert.equal(trusted({ ...session, zoom_join_url: "https://us06web.zoom.us/j/11111111111?pwd=old" }, new Date("2026-08-29T13:10:00Z")).reason, "meeting_link_mismatch");
});

test("daily session timing follows the real LMS date and includes Saturday classes", () => {
  const source = between("function ngDailyLiveSessionActionNow", "function ngLeadIsPaidOrGroupAddedForLiveSession");
  let clock = { weekday: "Saturday", hour: 12, minute: 55 };
  const actionNow = new Function(
    "ngDailySessionTimeParts",
    "ngDailySessionDateKey",
    "DEFAULT_ZOOM_DURATION_MINUTES",
    `${source}; return ngDailyLiveSessionActionNow;`,
  )(() => clock, () => "2026-08-29", 120);
  const saturday = { id: "day-7", date: "2026-08-29", time: "13:00", status: "scheduled", duration_minutes: 120 };

  assert.equal(actionNow({}, new Date(), saturday), "five_minute_reminder");
  clock = { weekday: "Saturday", hour: 13, minute: 16 };
  assert.equal(actionNow({}, new Date(), saturday), "session_link");
  clock = { weekday: "Saturday", hour: 14, minute: 59 };
  assert.equal(actionNow({}, new Date(), saturday), "session_link");
  clock = { weekday: "Saturday", hour: 15, minute: 1 };
  assert.equal(actionNow({}, new Date(), saturday), "post_session_recording");
  clock = { weekday: "Saturday", hour: 23, minute: 59 };
  assert.equal(actionNow({}, new Date(), saturday), "post_session_recording");
  assert.equal(actionNow({}, new Date(), { ...saturday, date: "2026-08-28" }), null);
  assert.equal(actionNow({}, new Date(), { ...saturday, status: "cancelled" }), null);
});

test("daily messages name the exact session and never fall back to an old Zoom URL", () => {
  const source = between("function ngDailyLiveSessionText", "async function ngRunDailyLiveSessionScheduler");
  const textFor = new Function(
    "ngBuildNoSessionRecordingFallbackText",
    `${source}; return ngDailyLiveSessionText;`,
  )(() => "fallback");
  const assets = {
    liveSessionTitle: "Central Nervous System — Day 7 — Neurology / CNS",
    liveSessionDate: "2026-08-29",
    sessionTime: "1:00 PM Eastern",
    liveSessionLink: "https://us06web.zoom.us/j/22222222222?pwd=correct",
    recordingTitle: "Central Nervous System — Day 6 — Neurology / CNS",
    recordingLink: "https://us06web.zoom.us/rec/share/cns-day-6",
  };

  assert.match(textFor("five_minute_reminder", assets), /Central Nervous System — Day 7/);
  assert.match(textFor("five_minute_reminder", assets), /2026-08-29/);
  assert.match(textFor("session_link", assets), /22222222222/);
  assert.match(textFor("post_session_recording", assets), /Central Nervous System — Day 6/);
  assert.doesNotMatch(textFor("post_session_recording", assets), /recent live-session recording/);
  assert.match(textFor("post_session_recording", assets), /in case you missed today’s live session, you can catch up here/i);
  assert.match(textFor("post_session_recording", assets), /how you liked the teaching style/i);
  assert.match(textFor("post_session_recording", assets), /join the program/i);
  assert.match(textFor("post_session_recording", assets), /book a mentor call/i);
  assert.doesNotMatch(textFor("post_session_recording", assets), /correctly labelled|matching recording|Google Meet|interested in joining/i);
});

test("daily session time is formatted for students", () => {
  const source = between("function ngDailyLiveSessionTimeLabel", "function ngLeadIsPaidOrGroupAddedForLiveSession");
  const label = new Function(`${source}; return ngDailyLiveSessionTimeLabel;`)();

  assert.equal(label({ time: "12:00", timezone: "America/New_York" }), "12:00 PM Eastern");
  assert.equal(label({ scheduled_time: "09:05", scheduled_timezone: "America/New_York" }), "9:05 AM Eastern");
  assert.equal(label({}, "12:00 PM Eastern"), "12:00 PM Eastern");
});

test("the scheduler uses dedicated approved link templates", () => {
  const scheduler = between("async function ngRunDailyLiveSessionScheduler", "function ngGoogleMeetAppointmentDateTime");
  assert.match(server, /nextgen_live_session_link: \["name", "topic", "live_session_link"\]/);
  assert.match(scheduler, /session_link: settings\.session_link_template_key \|\| "nextgen_live_session_link"/);
  assert.match(scheduler, /configuredRecordingTemplate !== "nextgen_recording_notes_ready"/);
  assert.match(scheduler, /: "nextgen_class_recording_link"/);
  assert.match(scheduler, /sessionTime: ngDailyLiveSessionTimeLabel/);
  assert.match(scheduler, /liveSnapshot\.today_recording\?\.title/);
  assert.match(scheduler, /liveSnapshot\.today_recording\?\.url/);
  assert.doesNotMatch(scheduler, /recordingTitle: String\(liveSnapshot\.latest_recording/);
  assert.match(scheduler, /ngScheduledWhatsAppTemplateIsApproved\(db, templateId\)/);
  assert.match(scheduler, /ngRefreshDailySessionMetaTemplateApprovals\(db\)/);
  assert.match(scheduler, /whatsapp_template_inventory_unavailable/);
  assert.match(scheduler, /whatsapp_template_not_approved_yet/);
});

test("scheduled WhatsApp sends wait quietly until the exact Meta template is approved", () => {
  const source = between("function ngScheduledWhatsAppTemplateIsApproved", "function ngStartDailyLiveSessionAttempt");
  const isApproved = new Function(
    "getMessageTemplateByKey",
    `${source}; return ngScheduledWhatsAppTemplateIsApproved;`,
  )((db, key) => db.templates?.[key] || null);

  assert.equal(isApproved({ templates: { recording: { status: "draft", meta_status: "draft", active: true } } }, "recording"), false);
  assert.equal(isApproved({ templates: { recording: { status: "active", meta_status: "draft", active: true } } }, "recording"), false);
  assert.equal(isApproved({ templates: { recording: { status: "active", meta_status: "APPROVED", active: true } } }, "recording"), true);
  assert.equal(isApproved({ templates: { recording: { status: "draft", provider_status: "ACTIVE", active: true } } }, "recording"), true);
  assert.equal(isApproved({ templates: { recording: { status: "active", whatsapp_approved: true, active: true } } }, "recording"), true);
  assert.equal(isApproved({ templates: { recording: { meta_approved: true, active: true } } }, "recording"), true);
});

test("urgent LMS-clock reminder and start-link phases bypass the generic outbound cooldown", () => {
  const source = between("function ngDailyLiveSessionActionBypassesRecentCooldown", "function ngStartDailyLiveSessionAttempt");
  const bypasses = new Function(`${source}; return ngDailyLiveSessionActionBypassesRecentCooldown;`)();

  assert.equal(bypasses("five_minute_reminder"), true);
  assert.equal(bypasses("session_link"), true);
  assert.equal(bypasses("daily_session_invite"), false);
  assert.equal(bypasses("post_session_recording"), false);
});

test("scheduler and AI source use only the exact live LMS link", () => {
  assert.match(server, /CRM_AYLA_REPLY_BUILD = "v310-crm-session-retry-guard"/);
  assert.match(server, /CRM_LIVE_SESSION_SCHEDULER_BUILD = "v315-lms-clock-meta-live-preflight"/);
  assert.match(server, /crm_live_session_scheduler_build: CRM_LIVE_SESSION_SCHEDULER_BUILD/);
  assert.match(server, /reason: "matching_live_session_link_not_released"/);
  assert.match(server, /today_session: todaySession \?/);
  assert.match(server, /liveSessionLink: liveSnapshot\?\.live_session\?\.url \|\| ""/);
  assert.match(server, /ngAylaLiveSessionLinkViolations\(`\$\{candidate\.reply/);
  assert.match(server, /ngAylaRecordingLinkViolations\(`\$\{candidate\.reply/);
  assert.match(server, /recording_fallback_missing_exact_title_or_link/);
  assert.match(server, /latestRecordingTitle: String\(liveSnapshot\.latest_recording\?\.title/);
  assert.doesNotMatch(
    between("function ngBuildAylaBackendSalesBrain", "function ngBuildAylaCommandContext"),
    /liveSnapshot\?\.live_session\?\.url \|\| configuredAssets\.liveSessionLink/,
  );
});

test("Zoom recovery does not publish a recording while prepared-content publication is disabled", () => {
  const upsert = between("async function upsertZoomRecordingFromObject", "function ngFindRoadmapDayForLiveSession");
  assert.match(upsert, /const canAutoPublish = Boolean\(\s*ngAutoPublishPreparedContentEnabled\(\) &&/);
});

test("first Meta replies must carry the current session, one recording, and one qualification question", () => {
  assert.match(server, /isFirstMetaReply/);
  assert.match(server, /meta_first_reply_missing_exact_session_title/);
  assert.match(server, /meta_first_reply_missing_revised_time/);
  assert.match(server, /meta_first_reply_did_not_dispatch_recording/);
  assert.match(server, /meta_first_reply_missing_current_recording_link/);
  assert.match(server, /meta_first_reply_needs_one_question/);
  assert.match(server, /meta_first_reply_needs_qualifying_field/);
});
