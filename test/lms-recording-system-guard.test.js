import assert from "node:assert/strict";
import test from "node:test";

import {
  explicitRecordingSystem,
  preservesExplicitSystemOverride,
  reconcilePublishedRecordingSystemMismatches,
} from "../lib/lms-recording-system-guard.js";

test("recognises explicit systems but not generic personal-room titles", () => {
  assert.equal(explicitRecordingSystem("MSK — Day 11"), "msk");
  assert.equal(explicitRecordingSystem("Cardiology Day 11"), "cardiology");
  assert.equal(explicitRecordingSystem("NextGen Institute's Personal Meeting Room"), "");
});

test("unpublishes a cross-system recording and clears student-facing links", () => {
  const key = "zoom-recording:1:msk-day-11:2026-07-17";
  const db = {
    recordings: {
      [key]: {
        recording_key: key,
        meeting_id: "1",
        uuid: "msk-day-11==",
        start_time: "2026-07-17T16:51:00Z",
        recording_url: "https://zoom.example/msk-11",
        session_id: "cardio-11",
        published: true,
      },
    },
    liveSessions: {
      "cardio-11": {
        id: "cardio-11",
        system: "Cardiology",
        topic: "Cardiology — Day 11",
        recording_key: key,
        recording_url: "https://zoom.example/msk-11",
        recording_published: true,
      },
    },
    notes: {
      "cardio-11": {
        session_id: "cardio-11",
        recording_key: key,
        recording_url: "https://zoom.example/msk-11",
        recording_published: true,
      },
    },
  };

  const result = reconcilePublishedRecordingSystemMismatches(db, [{
    id: "1",
    uuid: "msk-day-11==",
    start_time: "2026-07-17T16:51:00Z",
    topic: "MSK — Day 11 — FA 2026 pp. 489–492",
  }], { now: "2026-08-24T12:00:00Z" });

  assert.equal(result.conflicts, 1);
  assert.equal(db.recordings[key].published, false);
  assert.equal(db.liveSessions["cardio-11"].recording_url, null);
  assert.equal(db.notes["cardio-11"].recording_url, null);
});

test("keeps same-system and personal-room recordings unchanged", () => {
  const db = {
    recordings: {
      cardio: { uuid: "cardio", session_id: "cardio", published: true },
      personal: { uuid: "personal", session_id: "cardio", published: true },
    },
    liveSessions: { cardio: { id: "cardio", system: "Cardiology" } },
    notes: {},
  };

  const result = reconcilePublishedRecordingSystemMismatches(db, [
    { uuid: "cardio", topic: "Cardiology — Day 10" },
    { uuid: "personal", topic: "NextGen Institute's Personal Meeting Room" },
  ]);

  assert.equal(result.changed, false);
  assert.equal(db.recordings.cardio.published, true);
  assert.equal(db.recordings.personal.published, true);
});

test("preserves a deliberately reviewed same-session correction despite a stale Zoom title", () => {
  const key = "zoom-recording:derm-day-1";
  const recording = {
    recording_key: key,
    uuid: "derm-day-1",
    session_id: "derm-1",
    system: "Dermatology",
    topic: "Dermatology — Day 1",
    assignment_locked: true,
    assignment_source: "admin_explicit_session",
    published: true,
  };
  const session = { id: "derm-1", system: "Dermatology", topic: "Dermatology — Day 1" };
  const db = { recordings: { [key]: recording }, liveSessions: { "derm-1": session }, notes: {} };

  assert.equal(preservesExplicitSystemOverride(recording, session), true);
  const result = reconcilePublishedRecordingSystemMismatches(db, [{
    uuid: "derm-day-1",
    topic: "Central Nervous System — Day 1",
  }]);

  assert.equal(result.changed, false);
  assert.equal(result.conflicts, 0);
  assert.equal(db.recordings[key].published, true);
});
