export const LMS_SESSION_NOTES_BUILD = "v256-session-notes-publish-invariants";

function text(value) {
  return String(value || "").trim();
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

export function lmsAutoPublishSessionNotesEnabled(env = process.env) {
  const explicit = text(env?.NEXTGEN_AUTO_PUBLISH_SESSION_NOTES).toLowerCase();
  if (explicit === "true") return true;
  if (explicit === "false") return false;

  const legacy = text(env?.NEXTGEN_AUTO_PUBLISH_SESSION_CONTENT).toLowerCase();
  if (legacy === "true") return true;

  // Recordings are already auto-published after an exact Zoom/session match.
  // Clean transcript-derived notes should follow that recording by default.
  return true;
}

export function lmsVisibleSessionNoteText(note = {}) {
  return [
    note.cleaned_notes,
    note.student_notes,
    note.notes,
    note.content,
    note.summary,
  ].map(text).find(Boolean) || "";
}

export function lmsSessionNoteBodyContent(body = {}) {
  const keys = ["notes", "cleaned_notes", "student_notes", "content"];
  const key = keys.find((candidate) => hasOwn(body, candidate));
  if (!key) return { supplied: false, value: "" };
  return { supplied: true, value: String(body[key] || "") };
}

export function lmsSynchronizeSessionNoteContent(previous = {}, body = {}) {
  const supplied = lmsSessionNoteBodyContent(body);
  if (!supplied.supplied) {
    return {
      notes: String(previous.notes || ""),
      cleaned_notes: String(previous.cleaned_notes || previous.student_notes || previous.notes || ""),
      student_notes: String(previous.student_notes || previous.cleaned_notes || previous.notes || ""),
    };
  }

  return {
    notes: supplied.value,
    cleaned_notes: supplied.value,
    student_notes: supplied.value,
  };
}

export function lmsApplySessionNotePublicationState(note = {}, {
  publishMode = "save",
  body = {},
  userId = null,
  now = new Date().toISOString(),
} = {}) {
  const next = { ...note };
  const publish = publishMode === "publish" || body.published === true || body.is_published === true;
  const unpublish = publishMode === "unpublish" || body.published === false || body.is_published === false;

  if (publish) {
    next.published = true;
    next.is_published = true;
    next.status = "published";
    next.published_at = next.published_at || now;
    next.published_by = next.published_by || userId || null;
    next.unpublished_at = null;
    next.unpublished_by = null;
    next.auto_publish_disabled = false;
  } else if (unpublish) {
    next.published = false;
    next.is_published = false;
    next.status = "draft";
    next.unpublished_at = now;
    next.unpublished_by = userId || null;
    if (publishMode === "unpublish") next.auto_publish_disabled = true;
  }

  return next;
}

function isSystemActor(value) {
  return text(value).toLowerCase().startsWith("system");
}

function recordingForSession(db = {}, note = {}, noteKey = "") {
  const recordingKey = text(note.recording_key);
  if (recordingKey && db.recordings?.[recordingKey]) return db.recordings[recordingKey];
  const sessionId = text(note.session_id || noteKey);
  if (!sessionId) return null;
  return Object.values(db.recordings || {}).find((recording) => (
    text(recording?.session_id) === sessionId &&
    recording?.published === true
  )) || null;
}

function isAutoPreparedNote(note = {}) {
  const source = text(note.source).toLowerCase();
  const processingStatus = text(note.content_processing_status).toLowerCase();
  return (
    note.auto_imported === true ||
    source.includes("zoom_transcript") ||
    source.includes("one_button_zoom") ||
    note.clean_notes_style === "strict_transcript_only_detailed" ||
    ["ready", "completed", "notes_ready"].includes(processingStatus)
  );
}

export function reconcileLmsSessionNoteInvariants(db = {}, {
  autoPublish = lmsAutoPublishSessionNotesEnabled(),
  now = new Date().toISOString(),
} = {}) {
  const result = {
    changed: false,
    checked: 0,
    content_aliases_synced: 0,
    publication_conflicts_fixed: 0,
    auto_published: 0,
    session_ids: [],
  };

  for (const [noteKey, original] of Object.entries(db.notes || {})) {
    if (!original || typeof original !== "object") continue;
    result.checked += 1;
    let note = original;
    let changed = false;

    const manualText = String(note.notes || "");
    const cleanedText = String(note.cleaned_notes || "");
    const studentText = String(note.student_notes || "");
    const manuallyEdited = Boolean(
      text(note.updated_by) &&
      !isSystemActor(note.updated_by) &&
      text(manualText) &&
      (manualText !== cleanedText || manualText !== studentText)
    );

    if (manuallyEdited) {
      note = {
        ...note,
        cleaned_notes: manualText,
        student_notes: manualText,
      };
      changed = true;
      result.content_aliases_synced += 1;
    }

    const status = text(note.status).toLowerCase();
    const explicitlyPublished = note.published === true || note.is_published === true;
    const explicitlyUnpublished = note.published === false || note.is_published === false;

    if (explicitlyPublished && ["draft", "unpublished"].includes(status)) {
      note = {
        ...note,
        published: true,
        is_published: true,
        status: "published",
        published_at: note.published_at || now,
        published_by: note.published_by || note.updated_by || "system:notes-invariant-repair",
        unpublished_at: null,
        unpublished_by: null,
      };
      changed = true;
      result.publication_conflicts_fixed += 1;
    } else if (explicitlyUnpublished && status === "published") {
      note = {
        ...note,
        published: false,
        is_published: false,
        status: "draft",
      };
      changed = true;
      result.publication_conflicts_fixed += 1;
    }

    const recording = recordingForSession(db, note, noteKey);
    const canAutoPublish = Boolean(
      autoPublish &&
      recording?.published === true &&
      note.auto_publish_disabled !== true &&
      isAutoPreparedNote(note) &&
      lmsVisibleSessionNoteText(note).length >= 300
    );
    const currentlyPublished = (
      (note.published === true || note.is_published === true) &&
      !["draft", "unpublished", "archived", "hidden"].includes(text(note.status).toLowerCase())
    );

    if (canAutoPublish && !currentlyPublished) {
      note = {
        ...note,
        published: true,
        is_published: true,
        status: "published",
        published_at: note.published_at || now,
        published_by: note.published_by || "system:zoom-recording-notes-automation",
        unpublished_at: null,
        unpublished_by: null,
        auto_published: true,
        auto_published_at: note.auto_published_at || now,
      };
      changed = true;
      result.auto_published += 1;
    }

    if (!changed) continue;
    db.notes[noteKey] = note;
    result.changed = true;
    result.session_ids.push(text(note.session_id || noteKey));
  }

  result.session_ids = [...new Set(result.session_ids.filter(Boolean))];
  return result;
}
