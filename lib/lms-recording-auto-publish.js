function text(value) {
  return String(value || "").trim().toLowerCase();
}

export const LMS_RECORDING_AUTO_PUBLISH_BUILD = "v317-recording-notes-auto-publish";

export function lmsAutoPublishRecordingsEnabled(env = process.env) {
  const explicit = text(env?.NEXTGEN_AUTO_PUBLISH_RECORDINGS);
  if (explicit === "true") return true;
  if (explicit === "false") return false;

  // A completed Zoom recording with an exact LMS session/course match is safe
  // to publish automatically. Prepared flashcards and assessments retain their
  // separate, review-first publication control.
  return true;
}

export function lmsCanAutoPublishRecording({
  env = process.env,
  matchedSession = null,
  videoFile = null,
  previous = {},
} = {}) {
  return Boolean(
    lmsAutoPublishRecordingsEnabled(env) &&
    matchedSession?.id &&
    matchedSession.course_id &&
    videoFile &&
    String(videoFile.status || "completed").trim().toLowerCase() === "completed" &&
    !previous.unpublished_at &&
    previous.auto_publish_disabled !== true
  );
}
