import test from "node:test";
import assert from "node:assert/strict";

import {
  LMS_RECORDING_LABEL_CORRECTIONS_BUILD,
  NEXTGEN_MISSED_HOLIDAY_RECORDING_LABEL_CORRECTIONS,
  reconcileKnownMissedHolidayRecordingLabels,
} from "../lib/lms-recording-label-corrections.js";

function recordingFor(rule, {
  recordingUrl = `https://zoom.example/${encodeURIComponent(rule.recordingKey)}`,
} = {}) {
  return {
    id: rule.recordingKey,
    recording_key: rule.recordingKey,
    meeting_id: rule.recordingKey.split(":")[1],
    session_id: rule.expectedSessionId,
    course_id: rule.courseId,
    system: rule.expectedSystem,
    system_day: rule.expectedSystemDay,
    day_number: rule.expectedSystemDay,
    topic: `${rule.expectedSystem} — Day ${rule.expectedSystemDay}`,
    start_time: `${rule.expectedStartDate}T16:00:00Z`,
    recording_url: recordingUrl,
    share_url: `${recordingUrl}/share`,
    transcript_url: `${recordingUrl}/transcript`,
    published: true,
  };
}

test("known missed-holiday recording labels are corrected without changing attachments", () => {
  assert.equal(LMS_RECORDING_LABEL_CORRECTIONS_BUILD, "v258-missed-holiday-recording-labels");

  const db = { recordings: {} };
  const originals = new Map();
  for (const rule of NEXTGEN_MISSED_HOLIDAY_RECORDING_LABEL_CORRECTIONS) {
    const recording = recordingFor(rule);
    db.recordings[rule.recordingKey] = recording;
    originals.set(rule.recordingKey, structuredClone(recording));
  }

  const result = reconcileKnownMissedHolidayRecordingLabels(db, {
    now: "2026-07-31T12:00:00.000Z",
  });

  assert.equal(result.changed, true);
  assert.equal(result.corrected, 2);
  assert.deepEqual(result.recording_keys, NEXTGEN_MISSED_HOLIDAY_RECORDING_LABEL_CORRECTIONS.map((rule) => rule.recordingKey));

  for (const rule of NEXTGEN_MISSED_HOLIDAY_RECORDING_LABEL_CORRECTIONS) {
    const before = originals.get(rule.recordingKey);
    const after = db.recordings[rule.recordingKey];

    assert.equal(after.recording_key, before.recording_key);
    assert.equal(after.meeting_id, before.meeting_id);
    assert.equal(after.session_id, before.session_id);
    assert.equal(after.course_id, before.course_id);
    assert.equal(after.recording_url, before.recording_url);
    assert.equal(after.share_url, before.share_url);
    assert.equal(after.transcript_url, before.transcript_url);
    assert.equal(after.published, true);

    assert.equal(after.topic, before.topic);
    assert.equal(after.system_day, before.system_day);
    assert.equal(after.day_number, before.day_number);
    assert.equal(after.corrected_topic, rule.correctedTopic);
    assert.equal(after.corrected_system_day, rule.correctedSystemDay);
    assert.equal(after.corrected_day_number, rule.correctedDayNumber);
    assert.equal(after.label_correction_locked, true);
    assert.equal(after.missed_holiday_date, rule.missedHolidayDate);
  }
});

test("recording label repair is idempotent and refuses a mismatched occurrence", () => {
  const [cardiologyRule, mskRule] = NEXTGEN_MISSED_HOLIDAY_RECORDING_LABEL_CORRECTIONS;
  const db = {
    recordings: {
      [cardiologyRule.recordingKey]: recordingFor(cardiologyRule),
      [mskRule.recordingKey]: {
        ...recordingFor(mskRule),
        session_id: "different-session",
      },
    },
  };

  const first = reconcileKnownMissedHolidayRecordingLabels(db, {
    now: "2026-07-31T12:00:00.000Z",
  });
  assert.equal(first.corrected, 1);
  assert.equal(first.skipped.length, 1);
  assert.equal(first.skipped[0].reason, "precondition_failed");
  assert.equal(first.skipped[0].preconditions.session, false);

  const snapshot = structuredClone(db.recordings[cardiologyRule.recordingKey]);
  const second = reconcileKnownMissedHolidayRecordingLabels(db, {
    now: "2026-07-31T13:00:00.000Z",
  });
  assert.equal(second.changed, false);
  assert.equal(second.corrected, 0);
  assert.equal(second.already_correct, 1);
  assert.deepEqual(db.recordings[cardiologyRule.recordingKey], snapshot);
});
