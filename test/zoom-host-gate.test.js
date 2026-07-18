import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../server.js", import.meta.url));
const serverSource = fs.readFileSync(serverPath, "utf8");

test("Zoom meeting paths never enable join-before-host", () => {
  assert.doesNotMatch(serverSource, /join_before_host\s*:\s*true/);
  assert.doesNotMatch(serverSource, /ngOpenZoomMeetingEntryForStudents/);
});

test("new and existing meetings use the same host-required Zoom settings", () => {
  const creationSettingsHelper = serverSource.match(
    /function ngZoomHostRequiredMeetingSettings\(\)\s*\{[\s\S]*?^\}/m
  )?.[0] || "";
  const patchSettingsHelper = serverSource.match(
    /function ngZoomHostRequiredMeetingPatchSettings\(\)\s*\{[\s\S]*?^\}/m
  )?.[0] || "";

  for (const settingsHelper of [creationSettingsHelper, patchSettingsHelper]) {
    assert.match(settingsHelper, /join_before_host\s*:\s*false/);
    assert.match(settingsHelper, /waiting_room\s*:\s*false/);
    assert.match(settingsHelper, /auto_recording\s*:\s*["']cloud["']/);
  }

  const creationHelperUses = serverSource.match(/settings\s*:\s*ngZoomHostRequiredMeetingSettings\(\)/g) || [];
  assert.ok(
    creationHelperUses.length >= 2,
    `Expected the shared host-required settings in both meeting creation paths; found ${creationHelperUses.length}`
  );
  assert.match(serverSource, /settings\s*:\s*ngZoomHostRequiredMeetingPatchSettings\(\)/);
});

test("student links require a verified host gate without hiding the attendee URL", () => {
  assert.match(serverSource, /function ngStudentZoomEntryIsHostGated\(session = \{\}\)/);
  assert.match(serverSource, /session\.zoom_host_gate_verified_at/);
  assert.match(serverSource, /session\.join_before_host_disabled_at/);
  assert.match(serverSource, /const studentJoinReady = Boolean\(hasZoom && ngStudentZoomEntryIsHostGated\(session\)\)/);
  assert.match(serverSource, /student_entry_mode:\s*["']host_required["']/);
});

test("automatic preparation reinforces the host gate instead of opening an early meeting", () => {
  assert.match(serverSource, /function ngAutoZoomPrepIsAlreadyHostGated\(session = \{\}\)/);
  assert.match(serverSource, /session\.auto_zoom_host_gated_at = verifiedAt/);
  assert.match(serverSource, /ngRequireZoomHostBeforeStudentEntry\(session\.zoom_meeting_id\)/);
});

test("Zoom responses are verified instead of trusting successful API status alone", () => {
  assert.match(serverSource, /function ngAssertZoomHostRequiredSettings\(meeting = \{\}, context = ["']Zoom meeting["']\)/);
  assert.match(serverSource, /settings\.join_before_host !== false/);
  assert.match(serverSource, /settings\.waiting_room !== false/);
  assert.match(serverSource, /settings\.auto_recording \|\| ["']["']/);
  assert.match(serverSource, /const verification = await axios\.get\(/);
  assert.match(serverSource, /host-gate verification failed/);
});
