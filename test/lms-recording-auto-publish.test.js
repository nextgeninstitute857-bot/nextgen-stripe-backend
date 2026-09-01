import test from "node:test";
import assert from "node:assert/strict";

import {
  LMS_RECORDING_AUTO_PUBLISH_BUILD,
  lmsCanAutoPublishRecording,
  lmsAutoPublishRecordingsEnabled,
} from "../lib/lms-recording-auto-publish.js";

test("exactly matched completed recordings auto-publish by default", () => {
  assert.equal(LMS_RECORDING_AUTO_PUBLISH_BUILD, "v317-recording-notes-auto-publish");
  assert.equal(lmsAutoPublishRecordingsEnabled({}), true);
  assert.equal(lmsAutoPublishRecordingsEnabled({
    NEXTGEN_AUTO_PUBLISH_SESSION_CONTENT: "false",
  }), true);
});

test("recording auto-publish can still be explicitly disabled", () => {
  assert.equal(lmsAutoPublishRecordingsEnabled({
    NEXTGEN_AUTO_PUBLISH_RECORDINGS: "false",
  }), false);
  assert.equal(lmsAutoPublishRecordingsEnabled({
    NEXTGEN_AUTO_PUBLISH_RECORDINGS: "true",
  }), true);
});

test("only completed recordings with an exact session/course match are eligible", () => {
  const eligible = {
    matchedSession: { id: "session-day-8", course_id: "course-usmle" },
    videoFile: { status: "completed" },
    previous: {},
  };

  assert.equal(lmsCanAutoPublishRecording(eligible), true);
  assert.equal(lmsCanAutoPublishRecording({ ...eligible, matchedSession: null }), false);
  assert.equal(lmsCanAutoPublishRecording({
    ...eligible,
    matchedSession: { id: "session-day-8" },
  }), false);
  assert.equal(lmsCanAutoPublishRecording({
    ...eligible,
    videoFile: { status: "processing" },
  }), false);
  assert.equal(lmsCanAutoPublishRecording({
    ...eligible,
    previous: { unpublished_at: "2026-09-01T20:00:00.000Z" },
  }), false);
  assert.equal(lmsCanAutoPublishRecording({
    ...eligible,
    previous: { auto_publish_disabled: true },
  }), false);
  assert.equal(lmsCanAutoPublishRecording({
    ...eligible,
    env: { NEXTGEN_AUTO_PUBLISH_RECORDINGS: "false" },
  }), false);
});
