import test from "node:test";
import assert from "node:assert/strict";

import {
  lmsApplySessionNotePublicationState,
  lmsAutoPublishSessionNotesEnabled,
  lmsSynchronizeSessionNoteContent,
  reconcileLmsSessionNoteInvariants,
} from "../lib/lms-session-notes.js";

test("session notes auto-publish by default without enabling auto-published flashcards", () => {
  assert.equal(lmsAutoPublishSessionNotesEnabled({}), true);
  assert.equal(lmsAutoPublishSessionNotesEnabled({
    NEXTGEN_AUTO_PUBLISH_SESSION_CONTENT: "false",
  }), true);
  assert.equal(lmsAutoPublishSessionNotesEnabled({
    NEXTGEN_AUTO_PUBLISH_SESSION_CONTENT: "false",
    NEXTGEN_AUTO_PUBLISH_SESSION_NOTES: "true",
  }), true);
  assert.equal(lmsAutoPublishSessionNotesEnabled({
    NEXTGEN_AUTO_PUBLISH_SESSION_NOTES: "false",
  }), false);
});

test("manual editor content is synchronized across every student-visible note field", () => {
  const content = lmsSynchronizeSessionNoteContent({
    notes: "Old editor text",
    cleaned_notes: "Stale generated text",
    student_notes: "Stale generated text",
  }, {
    notes: "The corrected Day 10 tutor note",
  });

  assert.deepEqual(content, {
    notes: "The corrected Day 10 tutor note",
    cleaned_notes: "The corrected Day 10 tutor note",
    student_notes: "The corrected Day 10 tutor note",
  });
});

test("publish and unpublish produce internally consistent statuses", () => {
  const published = lmsApplySessionNotePublicationState({
    notes: "Published text",
    status: "draft",
    published: false,
    is_published: false,
  }, {
    publishMode: "publish",
    userId: "admin",
    now: "2026-07-31T00:00:00.000Z",
  });
  assert.equal(published.status, "published");
  assert.equal(published.published, true);
  assert.equal(published.is_published, true);

  const draft = lmsApplySessionNotePublicationState(published, {
    publishMode: "save",
    body: { published: false, is_published: false },
    userId: "admin",
    now: "2026-07-31T00:01:00.000Z",
  });
  assert.equal(draft.status, "draft");
  assert.equal(draft.published, false);
  assert.equal(draft.is_published, false);
  assert.notEqual(draft.auto_publish_disabled, true);

  const deliberatelyUnpublished = lmsApplySessionNotePublicationState(published, {
    publishMode: "unpublish",
    userId: "admin",
    now: "2026-07-31T00:02:00.000Z",
  });
  assert.equal(deliberatelyUnpublished.auto_publish_disabled, true);
});

test("startup reconciliation repairs old publish conflicts and promotes prepared Zoom notes only", () => {
  const longNotes = "# MSK Day 4\n\n" + "Transcript-only teaching point. ".repeat(30);
  const db = {
    notes: {
      day10: {
        session_id: "day10",
        notes: "# Cardiology Day 10\n\nCorrected editor content",
        cleaned_notes: "Old generated content",
        student_notes: "Old generated content",
        updated_by: "admin",
        published: true,
        is_published: true,
        status: "draft",
      },
      msk4: {
        session_id: "msk4",
        notes: longNotes,
        cleaned_notes: longNotes,
        student_notes: longNotes,
        source: "zoom_transcript",
        auto_imported: true,
        status: "draft",
        published: false,
        is_published: false,
        recording_key: "recording-msk4",
      },
      intentionalManualDraft: {
        session_id: "manual",
        notes: longNotes,
        status: "draft",
        published: false,
        is_published: false,
        recording_key: "recording-manual",
        source: "manual",
      },
      deliberatelyUnpublished: {
        session_id: "unpublished",
        notes: longNotes,
        cleaned_notes: longNotes,
        student_notes: longNotes,
        status: "draft",
        published: false,
        is_published: false,
        recording_key: "recording-unpublished",
        source: "zoom_transcript",
        auto_imported: true,
        auto_publish_disabled: true,
      },
    },
    recordings: {
      "recording-msk4": { recording_key: "recording-msk4", session_id: "msk4", published: true },
      "recording-manual": { recording_key: "recording-manual", session_id: "manual", published: true },
      "recording-unpublished": { recording_key: "recording-unpublished", session_id: "unpublished", published: true },
    },
  };

  const result = reconcileLmsSessionNoteInvariants(db, {
    autoPublish: true,
    now: "2026-07-31T00:00:00.000Z",
  });

  assert.equal(result.changed, true);
  assert.equal(result.content_aliases_synced, 1);
  assert.equal(result.publication_conflicts_fixed, 1);
  assert.equal(result.auto_published, 1);
  assert.equal(db.notes.day10.cleaned_notes, db.notes.day10.notes);
  assert.equal(db.notes.day10.status, "published");
  assert.equal(db.notes.msk4.status, "published");
  assert.equal(db.notes.intentionalManualDraft.status, "draft");
  assert.equal(db.notes.deliberatelyUnpublished.status, "draft");
});
