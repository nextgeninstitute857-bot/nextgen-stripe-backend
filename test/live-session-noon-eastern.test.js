import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = server.indexOf('const NEXTGEN_LIVE_CLASS_TIME = "12:00";');
const end = server.indexOf('app.post("/admin/live-sessions/shift-to-noon-eastern"');
const source = server.slice(start, end);

const helpers = new Function(
  "nowIso",
  "ngRoadmapDayIsNoClass",
  "hasRealZoomMeetingId",
  `${source}; return { ngReplaceNoonEasternTimeCopy, ngLegacyLiveClassTime, ngApplyNoonEasternScheduleShift };`,
)(
  () => "2026-08-28T23:00:00.000Z",
  (day) => ["holiday", "cancelled"].includes(String(day.status || "").toLowerCase()),
  (meetingId) => /^\d{9,11}$/.test(String(meetingId || "")),
);

test("time copy moves from 1 PM and 12:55 PM to noon and 11:55 AM Eastern", () => {
  assert.equal(helpers.ngReplaceNoonEasternTimeCopy("Class at 1 PM EST"), "Class at 12:00 PM Eastern");
  assert.equal(helpers.ngReplaceNoonEasternTimeCopy("Reminder 12:55 PM ET"), "Reminder 11:55 AM Eastern");
  assert.equal(helpers.ngReplaceNoonEasternTimeCopy("Live sessions run Monday to Friday at 1 PM EST"), "Live sessions run on scheduled roadmap teaching days at 12:00 PM Eastern");
  assert.equal(helpers.ngLegacyLiveClassTime("13:00"), true);
  assert.equal(helpers.ngLegacyLiveClassTime("12:00"), false);
});

test("future roadmap, sessions, CRM AI, and active marketing move safely to noon", () => {
  const liveDb = {
    courses: { course: { id: "course", name: "120-Day USMLE Step 1 Marathon", class_time: "13:00" } },
    roadmaps: {
      course: {
        course_id: "course",
        settings: { class_time: "13:00", timezone: "America/New_York" },
        days: [
          { id: "past", date: "2026-08-28", class_time: "13:00", status: "scheduled" },
          { id: "holiday", date: "2026-08-29", class_time: "13:00", status: "holiday" },
          { id: "future", date: "2026-08-31", class_time: "13:00", status: "scheduled" },
        ],
      },
    },
    liveSessions: {
      past: { id: "past", course_id: "course", scheduled_date: "2026-08-28", scheduled_time: "13:00", status: "completed", recording_url: "https://recording" },
      future: { id: "future", course_id: "course", scheduled_date: "2026-08-31", scheduled_time: "13:00", status: "scheduled" },
      prepared: { id: "prepared", course_id: "course", scheduled_date: "2026-09-01", scheduled_time: "13:00", status: "scheduled", zoom_meeting_id: "12345678901" },
    },
  };
  const crmDb = {
    settings: { live_session_time: "1:00 PM EST", default_live_session_time: "1 PM ET", live_session_days: "Monday to Friday" },
    campaigns: [{ id: "campaign", session_time: "1:00 PM EST", message: "Join class at 1 PM Eastern" }],
    live_conversion_settings: [{ id: "conversion", session_time: "13:00" }],
  };

  const report = helpers.ngApplyNoonEasternScheduleShift({ liveDb, crmDb, courseId: "course", effectiveDate: "2026-08-29", actorId: "admin" });

  assert.equal(liveDb.roadmaps.course.days[0].class_time, "13:00");
  assert.equal(liveDb.roadmaps.course.days[1].class_time, "13:00");
  assert.equal(liveDb.roadmaps.course.days[2].class_time, "12:00");
  assert.equal(liveDb.liveSessions.past.scheduled_time, "13:00");
  assert.equal(liveDb.liveSessions.future.scheduled_time, "12:00");
  assert.equal(liveDb.liveSessions.prepared.scheduled_time, "13:00");
  assert.equal(report.prepared_sessions.length, 1);
  assert.equal(crmDb.settings.live_session_time, "12:00 PM Eastern");
  assert.equal(crmDb.settings.live_session_days, "Scheduled roadmap teaching days");
  assert.equal(crmDb.campaigns[0].message, "Join class at 12:00 PM Eastern");
  assert.equal(crmDb.live_conversion_settings[0].session_time, "12:00");
});

test("admin apply requires explicit confirmation and blocks prepared Zoom meetings", () => {
  assert.match(server, /SHIFT_LIVE_SESSIONS_TO_NOON_EASTERN/);
  assert.match(server, /report\.prepared_sessions\.length/);
  assert.match(server, /Recordings, notes|without moving recordings or notes/);
  assert.match(server, /CRM_AYLA_REPLY_BUILD = "v310-crm-session-retry-guard"/);
});
