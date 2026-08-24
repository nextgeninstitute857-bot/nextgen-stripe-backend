export const LMS_RECORDING_SYSTEM_GUARD_BUILD = "v299-recording-system-mismatch-guard";

const SYSTEM_ALIASES = Object.freeze([
  ["cardiology", /\b(?:cardiology|cardiovascular)\b/i],
  ["msk", /\b(?:msk|musculoskeletal)\b/i],
  ["dermatology", /\b(?:dermatology|derm)\b/i],
  ["central nervous system", /\b(?:central nervous system|neurology|cns)\b/i],
  ["reproductive", /\b(?:reproductive|reproduction)\b/i],
  ["endocrinology", /\b(?:endocrinology|endocrine)\b/i],
  ["gastrointestinal", /\b(?:gastrointestinal|gastroenterology|\bgit\b)\b/i],
  ["renal", /\b(?:renal|nephrology)\b/i],
  ["pulmonology", /\b(?:pulmonology|pulmonary|respiratory)\b/i],
  ["immunology", /\bimmunology\b/i],
  ["hematology", /\b(?:hematology|haematology)\b/i],
  ["psychiatry", /\bpsychiatry\b/i],
]);

const clean = (value) => String(value || "").trim();

export function explicitRecordingSystem(value = "") {
  const text = clean(value);
  if (!text || /personal meeting room/i.test(text)) return "";
  return SYSTEM_ALIASES.find(([, pattern]) => pattern.test(text))?.[0] || "";
}

function normalizedUuid(value = "") {
  return clean(value).replace(/=+$/g, "").replace(/\//g, "_").replace(/\+/g, "-");
}

function sameOccurrence(recording = {}, meeting = {}) {
  const recordingUuid = normalizedUuid(recording.uuid || recording.meeting_uuid);
  const meetingUuid = normalizedUuid(meeting.uuid || meeting.meeting_uuid);
  if (recordingUuid && meetingUuid) return recordingUuid === meetingUuid;

  if (clean(recording.meeting_id) !== clean(meeting.id || meeting.meeting_id)) return false;
  const recordingStart = new Date(recording.start_time || 0).getTime();
  const meetingStart = new Date(meeting.start_time || 0).getTime();
  return Number.isFinite(recordingStart) && Number.isFinite(meetingStart)
    && Math.abs(recordingStart - meetingStart) <= 2 * 60 * 1000;
}

export function reconcilePublishedRecordingSystemMismatches(db = {}, zoomMeetings = [], {
  now = new Date().toISOString(),
} = {}) {
  const result = {
    changed: false,
    checked: 0,
    conflicts: 0,
    unpublished: [],
    skipped_personal_room: 0,
  };

  for (const [storageKey, recording] of Object.entries(db.recordings || {})) {
    if (recording?.published !== true || !recording?.session_id) continue;
    result.checked += 1;

    const meeting = zoomMeetings.find((candidate) => sameOccurrence(recording, candidate));
    if (!meeting) continue;

    const sourceSystem = explicitRecordingSystem(meeting.topic);
    if (!sourceSystem) {
      if (/personal meeting room/i.test(clean(meeting.topic))) result.skipped_personal_room += 1;
      continue;
    }

    const session = db.liveSessions?.[String(recording.session_id)]
      || Object.values(db.liveSessions || {}).find((item) => clean(item?.id) === clean(recording.session_id))
      || null;
    if (!session) continue;

    const targetSystem = explicitRecordingSystem(
      session.system || session.topic || session.title || recording.system || recording.topic,
    );
    if (!targetSystem || sourceSystem === targetSystem) continue;

    db.recordings[storageKey] = {
      ...recording,
      published: false,
      recording_system_guard_blocked: true,
      recording_system_guard_reason: "zoom_topic_conflicts_with_assigned_session",
      recording_system_guard_source_topic: meeting.topic || null,
      recording_system_guard_source_system: sourceSystem,
      recording_system_guard_target_system: targetSystem,
      recording_system_guard_blocked_at: now,
      updated_at: now,
    };

    if (db.liveSessions?.[String(recording.session_id)]) {
      const linked = db.liveSessions[String(recording.session_id)];
      if (
        clean(linked.recording_key) === clean(storageKey)
        || clean(linked.recording_url) === clean(recording.recording_url)
      ) {
        db.liveSessions[String(recording.session_id)] = {
          ...linked,
          recording_key: null,
          recording_url: null,
          recording_published: false,
          recording_mapping_issue: "system_mismatch",
          updated_at: now,
        };
      }
    }

    if (db.notes?.[String(recording.session_id)]) {
      const note = db.notes[String(recording.session_id)];
      if (
        clean(note.recording_key) === clean(storageKey)
        || clean(note.recording_url) === clean(recording.recording_url)
      ) {
        db.notes[String(recording.session_id)] = {
          ...note,
          recording_key: null,
          recording_url: null,
          recording_published: false,
          recording_mapping_issue: "system_mismatch",
          updated_at: now,
        };
      }
    }

    result.changed = true;
    result.conflicts += 1;
    result.unpublished.push({
      recording_key: storageKey,
      session_id: recording.session_id,
      source_topic: meeting.topic || null,
      source_system: sourceSystem,
      target_system: targetSystem,
    });
  }

  return result;
}
