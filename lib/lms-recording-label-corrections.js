export const LMS_RECORDING_LABEL_CORRECTIONS_BUILD = "v258-missed-holiday-recording-labels";

export const NEXTGEN_MISSED_HOLIDAY_RECORDING_LABEL_CORRECTIONS = Object.freeze([
  Object.freeze({
    recordingKey: "zoom-recording:87148181262:wifUbW_xTKOTCDtmhjmvFg:2026-07-23T16:52:02Z",
    courseId: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c",
    expectedSessionId: "0140b2ed-18d2-4a71-93dd-8839566d3ce5",
    expectedStartDate: "2026-07-23",
    expectedSystem: "Cardiology",
    expectedSystemDay: 15,
    correctedTopic: "Cardiology — Day 14",
    correctedSystemDay: 14,
    correctedDayNumber: 14,
    missedHolidayDate: "2026-07-22",
  }),
  Object.freeze({
    recordingKey: "zoom-recording:83509601689:A17uXMYsReyLnQRoG1jgKg:2026-07-30T16:58:41Z",
    courseId: "6cacc0bf-7ca2-401e-aeff-a0b67e3ffb1c",
    expectedSessionId: "dd2943e0-16cc-4e65-9296-918414715d33",
    expectedStartDate: "2026-07-30",
    expectedSystem: "MSK",
    expectedSystemDay: 5,
    correctedTopic: "MSK — Day 4 — FA 2026 pp. 461–464",
    correctedSystemDay: 4,
    correctedDayNumber: 20,
    missedHolidayDate: "2026-07-29",
  }),
]);

function clean(value) {
  return String(value || "").trim();
}

function sameSystem(left, right) {
  return clean(left).toLowerCase() === clean(right).toLowerCase();
}

export function reconcileKnownMissedHolidayRecordingLabels(db = {}, {
  corrections = NEXTGEN_MISSED_HOLIDAY_RECORDING_LABEL_CORRECTIONS,
  now = new Date().toISOString(),
} = {}) {
  const result = {
    changed: false,
    checked: 0,
    corrected: 0,
    already_correct: 0,
    skipped: [],
    recording_keys: [],
  };

  for (const rule of corrections) {
    result.checked += 1;
    const recording = db.recordings?.[rule.recordingKey] || null;
    if (!recording) {
      result.skipped.push({ recording_key: rule.recordingKey, reason: "recording_not_found" });
      continue;
    }

    const preconditions = {
      course: clean(recording.course_id) === clean(rule.courseId),
      session: clean(recording.session_id) === clean(rule.expectedSessionId),
      start_date: clean(recording.start_time).slice(0, 10) === clean(rule.expectedStartDate),
      system: sameSystem(recording.system, rule.expectedSystem),
      system_day: Number(recording.system_day || recording.day_in_system || 0) === Number(rule.expectedSystemDay),
      published: recording.published === true,
      url_preserved: Boolean(clean(recording.recording_url || recording.share_url)),
    };
    if (Object.values(preconditions).some((value) => value !== true)) {
      result.skipped.push({
        recording_key: rule.recordingKey,
        reason: "precondition_failed",
        preconditions,
      });
      continue;
    }

    const alreadyCorrect = (
      recording.label_correction_locked === true &&
      clean(recording.corrected_topic) === clean(rule.correctedTopic) &&
      Number(recording.corrected_system_day || 0) === Number(rule.correctedSystemDay)
    );
    if (alreadyCorrect) {
      result.already_correct += 1;
      continue;
    }

    db.recordings[rule.recordingKey] = {
      ...recording,
      original_topic_before_label_correction: recording.original_topic_before_label_correction || recording.topic || null,
      original_system_day_before_label_correction: recording.original_system_day_before_label_correction ?? recording.system_day ?? null,
      original_day_number_before_label_correction: recording.original_day_number_before_label_correction ?? recording.day_number ?? null,
      corrected_topic: rule.correctedTopic,
      corrected_system_day: Number(rule.correctedSystemDay),
      corrected_day_number: Number(rule.correctedDayNumber),
      label_correction_locked: true,
      label_correction_reason: "missed_holiday_day_number",
      missed_holiday_date: rule.missedHolidayDate,
      label_corrected_at: recording.label_corrected_at || now,
      label_corrected_by: recording.label_corrected_by || "system:missed-holiday-recording-label-repair",
      updated_at: now,
    };

    result.changed = true;
    result.corrected += 1;
    result.recording_keys.push(rule.recordingKey);
  }

  return result;
}
