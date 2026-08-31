import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const between = (start, end) => server.slice(server.indexOf(start), server.indexOf(end));

test("published recordings expose notes availability only for published nonempty lecture notes", () => {
  const source = between("function ngPublicRecordingNotesMeta", "function sanitizePublicRecording");
  const notesMeta = new Function(
    "ngResolveStudentNotesForSession",
    "ngStudentNotesIsPublished",
    "ngStudentNotesVisibleText",
    `${source}; return ngPublicRecordingNotesMeta;`,
  )(
    (db, session) => ({ note: db.notes?.[session.id] || null }),
    (note) => note?.published === true && Boolean(String(note?.cleaned_notes || "").trim()),
    (note) => String(note?.cleaned_notes || "").trim(),
  );

  const recording = { session_id: "day-6", course_id: "course-1" };
  const db = {
    liveSessions: { "day-6": { id: "day-6", course_id: "course-1" } },
    notes: { "day-6": { published: true, cleaned_notes: "Lecture notes" } },
  };

  assert.deepEqual(notesMeta(db, recording), {
    notes_available: true,
    has_notes: true,
    notes_status: "available",
    notes_meta: {
      available: true,
      published: true,
      notes_available: true,
      updated_at: null,
    },
  });

  db.notes["day-6"] = { published: true, cleaned_notes: "" };
  assert.equal(notesMeta(db, recording).notes_available, false);
  assert.equal(notesMeta(db, recording).notes_status, "preparing");
});

test("recording endpoints calculate notes metadata from the live notes store", () => {
  assert.match(server, /sanitizePublicRecording\(recording, ngPublicRecordingNotesMeta\(db, recording\)\)/);
});
