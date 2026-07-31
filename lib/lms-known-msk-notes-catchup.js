export const LMS_KNOWN_MSK_NOTES_CATCHUP_BUILD = "v265-known-msk-transcript-notes-catchup";

export const NEXTGEN_KNOWN_MSK_TRANSCRIPT_NOTE_TARGETS = Object.freeze([
  Object.freeze({
    courseId: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c",
    roadmapDayId: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:displaced:037a3971-4f27-425a-8fa1-33a8d81ba39c",
    sessionId: "4184f0c1-a396-44c5-96b9-c00244ee66bc",
    date: "2026-07-27",
    systemDay: 2,
  }),
  Object.freeze({
    courseId: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c",
    roadmapDayId: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:15:99fd55b6-d102-434e-a647-d7f0a400db71",
    sessionId: "78f27b9f-9547-42ea-990b-3c0ba272f39e",
    date: "2026-07-28",
    systemDay: 3,
  }),
  Object.freeze({
    courseId: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c",
    roadmapDayId: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c:day:pushed:68d50440-edb7-4f8b-ab2d-b8bc6fc97e2a",
    sessionId: "dd2943e0-16cc-4e65-9296-918414715d33",
    date: "2026-07-30",
    systemDay: 4,
  }),
]);

function clean(value) {
  return String(value || "").trim();
}

function dateOnly(value) {
  return clean(value).slice(0, 10);
}

function isMsk(value) {
  return ["msk", "musculoskeletal"].includes(clean(value).toLowerCase());
}

export function lmsKnownMskNoteText(note = {}) {
  return [
    note.cleaned_notes,
    note.student_notes,
    note.notes,
    note.content,
    note.summary,
  ].map(clean).find(Boolean) || "";
}

export function lmsKnownMskNoteIsPublished(note = {}) {
  const status = clean(note.status).toLowerCase();
  return (
    (note.published === true || note.is_published === true) &&
    !["draft", "unpublished", "archived", "hidden"].includes(status) &&
    lmsKnownMskNoteText(note).length >= 300
  );
}

export function lmsKnownMskRecordingIdentity(recording = {}, storageKey = "") {
  return {
    storage_key: clean(storageKey || recording.recording_key || recording.id),
    recording_key: clean(recording.recording_key || recording.id || storageKey),
    meeting_id: clean(recording.meeting_id),
    session_id: clean(recording.session_id || recording.mapped_session_id),
    recording_url: clean(recording.recording_url),
    share_url: clean(recording.share_url),
    transcript_url: clean(recording.transcript_url),
    transcript_download_url: clean(recording.transcript_download_url),
    published: recording.published === true,
  };
}

export function lmsKnownMskRecordingIdentityMatches(left = {}, right = {}) {
  return Object.keys(lmsKnownMskRecordingIdentity()).every((key) => {
    if (key === "published") return left[key] === right[key];
    return clean(left[key]) === clean(right[key]);
  });
}

function roadmapForCourse(db = {}, courseId = "") {
  return db.roadmaps?.[courseId] || Object.values(db.roadmaps || {}).find((roadmap) => (
    clean(roadmap?.course_id || roadmap?.courseId) === clean(courseId) &&
    Array.isArray(roadmap?.days)
  )) || null;
}

function publishedTranscriptRecordingsForSession(db = {}, sessionId = "") {
  return Object.entries(db.recordings || {})
    .filter(([, recording]) => (
      recording?.published === true &&
      recording?.transcript_imported === true &&
      recording?.hidden_from_recordings !== true &&
      clean(recording?.session_id || recording?.mapped_session_id) === clean(sessionId)
    ))
    .map(([storageKey, recording]) => ({ storageKey, recording }));
}

export function inspectKnownMskTranscriptNoteTarget(db = {}, target = {}) {
  const roadmap = roadmapForCourse(db, target.courseId);
  const day = roadmap?.days?.find((item) => clean(item?.id) === clean(target.roadmapDayId)) || null;
  const session = db.liveSessions?.[target.sessionId] || null;
  const note = db.notes?.[target.sessionId] || null;
  const recordings = publishedTranscriptRecordingsForSession(db, target.sessionId);
  const recordingEntry = recordings.length === 1 ? recordings[0] : null;

  const checks = {
    roadmap_found: Boolean(roadmap),
    roadmap_day_found: Boolean(day),
    session_found: Boolean(session),
    course_matches: Boolean(
      session && clean(session.course_id) === clean(target.courseId) &&
      (!day || clean(day.course_id || target.courseId) === clean(target.courseId))
    ),
    date_matches: Boolean(
      session && day &&
      dateOnly(session.scheduled_date || session.date) === clean(target.date) &&
      dateOnly(day.date || day.scheduled_date) === clean(target.date)
    ),
    system_matches: Boolean(session && day && isMsk(session.system) && isMsk(day.system || day.chapter)),
    system_day_matches: Boolean(
      session && day &&
      Number(session.system_day || session.day_in_system || 0) === Number(target.systemDay) &&
      Number(day.system_day || day.day_in_system || 0) === Number(target.systemDay)
    ),
    session_day_link_matches: Boolean(
      session && day &&
      clean(session.roadmap_day_id) === clean(target.roadmapDayId) &&
      clean(day.live_session_id || day.session_id) === clean(target.sessionId)
    ),
    session_active: Boolean(
      session && !["cancelled", "canceled", "archived", "hidden", "deleted"].includes(clean(session.status).toLowerCase())
    ),
    one_published_transcript_recording: recordings.length === 1,
  };

  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  const result = {
    target,
    status: "unsafe",
    reason: failedChecks.join(",") || null,
    checks,
    recording_storage_key: recordingEntry?.storageKey || null,
    recording_identity: recordingEntry
      ? lmsKnownMskRecordingIdentity(recordingEntry.recording, recordingEntry.storageKey)
      : null,
    note_characters: lmsKnownMskNoteText(note || {}).length,
  };

  if (failedChecks.length) return result;
  if (lmsKnownMskNoteIsPublished(note || {})) {
    return { ...result, status: "already_published", reason: "already_published" };
  }
  if (note?.auto_publish_disabled === true || clean(note?.status).toLowerCase() === "unpublished") {
    return { ...result, status: "manual_unpublish", reason: "manual_unpublish_preserved" };
  }
  if (lmsKnownMskNoteText(note || {}).length >= 300) {
    return { ...result, status: "existing_draft", reason: "substantive_existing_draft_preserved" };
  }

  return { ...result, status: "pending", reason: "missing_substantive_published_note" };
}

export function applyKnownMskTranscriptNoteCandidate(db = {}, {
  target,
  candidate = {},
  actorId = "system:known-msk-transcript-notes-catchup",
  now = new Date().toISOString(),
} = {}) {
  const inspection = inspectKnownMskTranscriptNoteTarget(db, target);
  if (inspection.status === "already_published") {
    return { applied: false, already_published: true, reason: inspection.reason, inspection };
  }
  if (inspection.status !== "pending") {
    return { applied: false, already_published: false, reason: inspection.reason, inspection };
  }

  const cleanedNotes = clean(candidate.cleanedNotes || candidate.cleaned_notes || candidate.notes);
  const transcriptText = clean(candidate.transcriptText || candidate.transcript_text);
  if (cleanedNotes.length < 300 || transcriptText.length < 300) {
    return {
      applied: false,
      already_published: false,
      reason: "candidate_content_too_short",
      inspection,
    };
  }
  if (!lmsKnownMskRecordingIdentityMatches(inspection.recording_identity, candidate.recordingIdentity || {})) {
    return {
      applied: false,
      already_published: false,
      reason: "recording_identity_changed",
      inspection,
    };
  }

  const session = db.liveSessions[target.sessionId];
  const previous = db.notes?.[target.sessionId] || {};
  const publishedAt = previous.published_at || now;
  const note = {
    ...previous,
    session_id: target.sessionId,
    course_id: target.courseId,
    roadmap_day_id: target.roadmapDayId,
    day_number: session.day_number ?? previous.day_number ?? null,
    instructional_day_number: session.instructional_day_number ?? session.day_number ?? previous.instructional_day_number ?? null,
    system: session.system || "MSK",
    system_day: Number(target.systemDay),
    transcript_text: transcriptText,
    transcript_raw_vtt: String(candidate.transcriptRawVtt || candidate.transcript_raw_vtt || previous.transcript_raw_vtt || ""),
    transcript_url: candidate.transcriptUrl || candidate.transcript_url || previous.transcript_url || inspection.recording_identity.transcript_url || null,
    transcript_download_url: candidate.transcriptDownloadUrl || candidate.transcript_download_url || previous.transcript_download_url || inspection.recording_identity.transcript_download_url || null,
    recording_url: candidate.recordingUrl || candidate.recording_url || previous.recording_url || inspection.recording_identity.recording_url || null,
    recording_key: inspection.recording_identity.recording_key || previous.recording_key || null,
    meeting_id: inspection.recording_identity.meeting_id || previous.meeting_id || null,
    notes: cleanedNotes,
    cleaned_notes: cleanedNotes,
    student_notes: cleanedNotes,
    source: "system_known_msk_zoom_transcript_ai",
    clean_notes_style: "strict_transcript_only_detailed",
    auto_imported: true,
    published: true,
    is_published: true,
    status: "published",
    published_at: publishedAt,
    published_by: previous.published_by || actorId,
    unpublished_at: null,
    unpublished_by: null,
    auto_publish_disabled: false,
    auto_published: true,
    auto_published_at: previous.auto_published_at || now,
    content_processing_status: "completed",
    content_processing_error: null,
    content_processing_completed_at: now,
    ai_model: candidate.model || previous.ai_model || null,
    ai_usage: candidate.usage || previous.ai_usage || null,
    created_at: previous.created_at || now,
    updated_at: now,
    updated_by: actorId,
  };

  db.notes = db.notes || {};
  db.notes[target.sessionId] = note;
  return {
    applied: true,
    already_published: false,
    reason: "generated_and_published",
    session_id: target.sessionId,
    note_characters: cleanedNotes.length,
    recording_preserved: true,
    deleted_records: 0,
  };
}
