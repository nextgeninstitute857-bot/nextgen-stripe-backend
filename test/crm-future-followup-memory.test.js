import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("future promises keep distinct dates instead of overwriting one active reminder", () => {
  assert.match(server, /payload\.replace_active === true/);
  assert.match(server, /const sameDate =/);
  assert.match(server, /const sameType =/);
  assert.match(server, /lead\.availability_status = "available_later"/);
  assert.match(server, /"promised_availability", "future_followup_scheduled"/);
});

test("future reminders retain country, timezone, source campaign, and original words", () => {
  assert.match(server, /country: payload\.country \|\| lead\.country/);
  assert.match(server, /timezone: payload\.timezone \|\| lead\.timezone/);
  assert.match(server, /campaign_name: lead\.campaign_name/);
  assert.match(server, /original_text: payload\.original_text/);
});

test("availability parser supports explicit dates and multi-month promises", () => {
  assert.match(server, /const isoDate = lower\.match/);
  assert.match(server, /const dayMonth = lower\.match/);
  assert.match(server, /const monthDay = lower\.match/);
  assert.match(server, /date\.setMonth\(date\.getMonth\(\) \+ count\)/);
  assert.match(server, /const timeMatch = lower\.match/);
  assert.match(server, /candidate\.setHours\(promisedHour, promisedMinute/);
});

test("due promises trigger a durable admin-only scheduler", () => {
  assert.match(server, /async function ng41SendDueFutureFollowupReminders/);
  assert.match(server, /admin_reminder_sent_at/);
  assert.match(server, /type: "promised_availability_due"/);
  assert.match(server, /ngStartFutureFollowupReminderScheduler\(\)/);
  assert.match(server, /\/admin\/crm\/future-followups\/run-due-reminders/);
});
