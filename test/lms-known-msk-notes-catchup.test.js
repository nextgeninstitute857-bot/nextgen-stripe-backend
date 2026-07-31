import test from "node:test";
import assert from "node:assert/strict";

import {
  NEXTGEN_KNOWN_MSK_TRANSCRIPT_NOTE_TARGETS,
  applyKnownMskTranscriptNoteCandidate,
  inspectKnownMskTranscriptNoteTarget,
  lmsKnownMskRecordingIdentity,
} from "../lib/lms-known-msk-notes-catchup.js";

function fixtureFor(target) {
  const recordingKey = `recording:${target.sessionId}`;
  const session = {
    id: target.sessionId,
    course_id: target.courseId,
    roadmap_day_id: target.roadmapDayId,
    scheduled_date: target.date,
    system: "MSK",
    system_day: target.systemDay,
    day_number: target.systemDay,
    instructional_day_number: target.systemDay,
    title: `MSK — Day ${target.systemDay}`,
    status: "completed",
  };
  const day = {
    id: target.roadmapDayId,
    course_id: target.courseId,
    date: target.date,
    system: "MSK",
    system_day: target.systemDay,
    live_session_id: target.sessionId,
    session_id: target.sessionId,
    title: `MSK — Day ${target.systemDay}`,
    status: "scheduled",
  };
  const recording = {
    id: recordingKey,
    recording_key: recordingKey,
    meeting_id: `meeting-${target.systemDay}`,
    session_id: target.sessionId,
    recording_url: `https://zoom.example/${target.systemDay}/recording`,
    share_url: `https://zoom.example/${target.systemDay}/share`,
    transcript_url: `https://zoom.example/${target.systemDay}/transcript`,
    transcript_download_url: `https://zoom.example/${target.systemDay}/transcript/download`,
    transcript_imported: true,
    published: true,
  };
  return {
    roadmaps: {
      [target.courseId]: { course_id: target.courseId, days: [day] },
    },
    liveSessions: { [target.sessionId]: session },
    recordings: { [recordingKey]: recording },
    notes: {},
    users: { preserved: { id: "preserved" } },
    assessmentAttempts: { preserved: { id: "preserved" } },
    pointEvents: { preserved: { id: "preserved" } },
  };
}

test("the catch-up targets only the three audited transcript-backed MSK sessions", () => {
  assert.deepEqual(
    NEXTGEN_KNOWN_MSK_TRANSCRIPT_NOTE_TARGETS.map((target) => target.sessionId),
    [
      "4184f0c1-a396-44c5-96b9-c00244ee66bc",
      "78f27b9f-9547-42ea-990b-3c0ba272f39e",
      "dd2943e0-16cc-4e65-9296-918414715d33",
    ],
  );
});

test("a transcript-only candidate publishes one note without changing its recording or deleting records", () => {
  const target = NEXTGEN_KNOWN_MSK_TRANSCRIPT_NOTE_TARGETS[0];
  const db = fixtureFor(target);
  const recordingBefore = structuredClone(db.recordings);
  const countsBefore = Object.fromEntries(Object.entries(db).map(([key, value]) => [key, Object.keys(value || {}).length]));
  const inspection = inspectKnownMskTranscriptNoteTarget(db, target);
  assert.equal(inspection.status, "pending");

  const result = applyKnownMskTranscriptNoteCandidate(db, {
    target,
    candidate: {
      transcriptText: "Transcript-only MSK teaching detail. ".repeat(30),
      cleanedNotes: "# Clean Tutor Notes\n\n## 1. MSK Topic\n\n- **Key point:** ".repeat(35),
      recordingIdentity: inspection.recording_identity,
      model: "test-model",
    },
    now: "2026-07-31T16:00:00.000Z",
  });

  assert.equal(result.applied, true);
  assert.equal(result.deleted_records, 0);
  assert.equal(db.notes[target.sessionId].status, "published");
  assert.equal(db.notes[target.sessionId].published, true);
  assert.equal(db.notes[target.sessionId].is_published, true);
  assert.equal(db.notes[target.sessionId].system_day, target.systemDay);
  assert.equal(db.notes[target.sessionId].source, "system_known_msk_zoom_transcript_ai");
  assert.deepEqual(db.recordings, recordingBefore);
  assert.deepEqual(
    Object.fromEntries(Object.entries(db).map(([key, value]) => [key, Object.keys(value || {}).length])),
    { ...countsBefore, notes: 1 },
  );

  const second = applyKnownMskTranscriptNoteCandidate(db, {
    target,
    candidate: {
      transcriptText: "Transcript-only MSK teaching detail. ".repeat(30),
      cleanedNotes: "# Clean Tutor Notes\n\nAlready generated. ".repeat(30),
      recordingIdentity: inspection.recording_identity,
    },
  });
  assert.equal(second.applied, false);
  assert.equal(second.already_published, true);
});

test("the catch-up fails closed on identity drift and preserves deliberate unpublishing", () => {
  const target = NEXTGEN_KNOWN_MSK_TRANSCRIPT_NOTE_TARGETS[1];
  const db = fixtureFor(target);
  const inspection = inspectKnownMskTranscriptNoteTarget(db, target);
  const recordingBefore = structuredClone(db.recordings);

  const drifted = applyKnownMskTranscriptNoteCandidate(db, {
    target,
    candidate: {
      transcriptText: "Transcript detail. ".repeat(40),
      cleanedNotes: "# Clean Tutor Notes\n\n- Detailed point. ".repeat(35),
      recordingIdentity: {
        ...lmsKnownMskRecordingIdentity(
          db.recordings[inspection.recording_storage_key],
          inspection.recording_storage_key,
        ),
        recording_url: "https://unexpected.example/changed",
      },
    },
  });
  assert.equal(drifted.applied, false);
  assert.equal(drifted.reason, "recording_identity_changed");
  assert.deepEqual(db.recordings, recordingBefore);
  assert.equal(db.notes[target.sessionId], undefined);

  db.notes[target.sessionId] = {
    session_id: target.sessionId,
    status: "unpublished",
    published: false,
    is_published: false,
    auto_publish_disabled: true,
  };
  const deliberate = inspectKnownMskTranscriptNoteTarget(db, target);
  assert.equal(deliberate.status, "manual_unpublish");
});

test("the catch-up refuses a mismatched date or roadmap/session link", () => {
  const target = NEXTGEN_KNOWN_MSK_TRANSCRIPT_NOTE_TARGETS[2];
  const db = fixtureFor(target);
  db.liveSessions[target.sessionId].scheduled_date = "2026-07-31";
  db.liveSessions[target.sessionId].roadmap_day_id = "wrong-day";

  const inspection = inspectKnownMskTranscriptNoteTarget(db, target);
  assert.equal(inspection.status, "unsafe");
  assert.match(inspection.reason, /date_matches/);
  assert.match(inspection.reason, /session_day_link_matches/);
});
