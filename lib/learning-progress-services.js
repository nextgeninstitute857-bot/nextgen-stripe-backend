function cleanText(value = "", limit = 240) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function cleanList(value, limit = 20) {
  const rows = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(rows.map((item) => cleanText(item, 160)).filter(Boolean))].slice(0, limit);
}

function textKey(value = "") {
  return cleanText(value, 240).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function learningDateKey(value = null) {
  if (!value) return "";
  const text = cleanText(value, 80);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

export function previousLearningDate(value = "") {
  const key = learningDateKey(value);
  if (!key) return "";
  const date = new Date(`${key}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function canBridgeDates(previous, next, isFreezeDate) {
  let cursor = previousLearningDate(next);
  while (cursor && cursor > previous) {
    if (!isFreezeDate(cursor)) return false;
    cursor = previousLearningDate(cursor);
  }
  return cursor === previous;
}

/**
 * Shared, read-only streak calculation used by both LMS and AylaMed.
 * Activity days count toward the streak; configured rest/no-class days only
 * bridge gaps and never manufacture activity or points.
 */
export function computeLearningStreak({ activityDates = [], today = new Date(), isFreezeDate = () => false } = {}) {
  const todayKey = learningDateKey(today) || new Date().toISOString().slice(0, 10);
  const dateSet = new Set(
    (Array.isArray(activityDates) ? activityDates : [])
      .map(learningDateKey)
      .filter((value) => value && value <= todayKey),
  );
  const freeze = (dateKey) => {
    try {
      return Boolean(isFreezeDate(dateKey));
    } catch {
      return false;
    }
  };
  const sorted = [...dateSet].sort();

  let bestStreak = 0;
  let running = 0;
  let previous = "";
  for (const dateKey of sorted) {
    running = previous && canBridgeDates(previous, dateKey, freeze) ? running + 1 : 1;
    bestStreak = Math.max(bestStreak, running);
    previous = dateKey;
  }

  // A streak stays current through today before the student has studied. Rest
  // and no-class dates can be crossed without consuming that one-day grace.
  let anchor = "";
  let cursor = todayKey;
  let graceAvailable = true;
  while (cursor) {
    if (dateSet.has(cursor)) {
      anchor = cursor;
      break;
    }
    if (freeze(cursor)) {
      cursor = previousLearningDate(cursor);
      continue;
    }
    if (graceAvailable) {
      graceAvailable = false;
      cursor = previousLearningDate(cursor);
      continue;
    }
    break;
  }

  let currentStreak = 0;
  let currentStartDate = null;
  cursor = anchor;
  while (cursor) {
    if (dateSet.has(cursor)) {
      currentStreak += 1;
      currentStartDate = cursor;
      cursor = previousLearningDate(cursor);
      continue;
    }
    if (freeze(cursor)) {
      cursor = previousLearningDate(cursor);
      continue;
    }
    break;
  }

  return {
    study_streak: currentStreak,
    streak_days: currentStreak,
    best_streak: bestStreak,
    total_study_days: sorted.length,
    last_activity_date: sorted[sorted.length - 1] || null,
    current_start_date: currentStartDate,
    activity_dates: sorted,
    freeze_days_create_activity: false,
  };
}

/** Rank a copied list with deterministic numeric tie-breaks. */
export function rankLearningLeaderboard(entries = [], {
  scoreFields = ["points"],
  identityFields = ["studentId", "user_id", "id", "username", "user_name"],
  limit = null,
} = {}) {
  const rows = (Array.isArray(entries) ? entries : []).filter(Boolean).map((entry) => ({ ...entry }));
  rows.sort((left, right) => {
    for (const field of scoreFields) {
      const delta = Number(right?.[field] || 0) - Number(left?.[field] || 0);
      if (delta) return delta;
    }
    const leftId = identityFields.map((field) => cleanText(left?.[field], 200)).find(Boolean) || "";
    const rightId = identityFields.map((field) => cleanText(right?.[field], 200)).find(Boolean) || "";
    return leftId.localeCompare(rightId);
  });
  const sliced = limit ? rows.slice(0, Math.max(0, Number(limit) || 0)) : rows;
  return sliced.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function activeStudentUser(user = {}) {
  const role = cleanText(user.role || "student", 40).toLowerCase();
  const status = cleanText(user.status || "active", 40).toLowerCase();
  return !["admin", "instructor"].includes(role) && !["disabled", "deleted", "blocked", "revoked"].includes(status);
}

/**
 * Strict account bridge: an explicit live user id wins; otherwise exactly one
 * normalized email match is required. Fuzzy names and partial emails are never
 * accepted.
 */
export function resolveStrictLmsIdentity({ aylaUser = {}, student = {}, lmsUsers = [] } = {}) {
  const users = (Array.isArray(lmsUsers) ? lmsUsers : []).filter((user) => user?.id && activeStudentUser(user));
  const explicit = cleanText(
    student.lms_user_id || student.lmsUserId || aylaUser.lms_user_id || aylaUser.lmsUserId || "",
    200,
  );
  const aylaEmail = cleanText(aylaUser.email || student.email || "", 320).toLowerCase();

  if (explicit) {
    const match = users.find((user) => String(user.id) === explicit) || null;
    if (!match) return { linked: false, method: "explicit_id", reason: "explicit_lms_user_not_found", lmsUserId: null };
    const lmsEmail = cleanText(match.email || "", 320).toLowerCase();
    if (aylaEmail && lmsEmail && aylaEmail !== lmsEmail) {
      return { linked: false, method: "explicit_id", reason: "explicit_lms_email_mismatch", lmsUserId: null };
    }
    return { linked: true, method: "explicit_id", reason: null, lmsUserId: String(match.id) };
  }

  if (!aylaEmail) return { linked: false, method: "exact_email", reason: "aylamed_email_missing", lmsUserId: null };
  const matches = users.filter((user) => cleanText(user.email || "", 320).toLowerCase() === aylaEmail);
  if (matches.length !== 1) {
    return {
      linked: false,
      method: "exact_email",
      reason: matches.length ? "ambiguous_exact_email" : "exact_email_not_found",
      lmsUserId: null,
    };
  }
  return { linked: true, method: "exact_email", reason: null, lmsUserId: String(matches[0].id) };
}

/** Remove all LMS contact and authentication fields before cross-product use. */
export function sanitizeLearningPartnerProfile(profile = {}) {
  return {
    examTrack: cleanText(profile.exam_type || profile.examTrack || profile.exam_track || profile.exam, 120),
    currentStage: cleanText(profile.current_stage || profile.currentStage, 120),
    timezone: cleanText(profile.timezone, 120),
    country: cleanText(profile.country, 120),
    targetDate: learningDateKey(profile.target_exam_date || profile.targetDate) || null,
    resources: cleanList(profile.current_resources || profile.resources),
    subjects: cleanList(profile.current_subjects || profile.subjects),
    dailyHours: Math.max(0, Math.min(24, Number(profile.available_hours_per_day ?? profile.dailyHours ?? 0) || 0)),
    weeklyHours: Math.max(0, Math.min(168, Number(profile.available_hours_per_week ?? profile.weeklyHours ?? 0) || 0)),
    availability: cleanList(profile.preferred_time_blocks || profile.availability),
    studyStyle: cleanText(profile.study_style || profile.studyStyle, 120),
    lookingFor: cleanList(profile.looking_for || profile.lookingFor),
    languages: cleanList(profile.language_preference || profile.languages || profile.language),
    status: cleanText(profile.status || "active", 40).toLowerCase(),
    visibility: cleanText(profile.visibility || "students_only", 40).toLowerCase(),
    allowRequests: profile.allow_requests !== false,
  };
}

function overlap(left = [], right = []) {
  const rightKeys = new Set(cleanList(right).map(textKey));
  return cleanList(left).filter((item) => rightKeys.has(textKey(item)));
}

export function calculateLearningPartnerCompatibility(left = {}, right = {}) {
  const a = sanitizeLearningPartnerProfile(left);
  const b = sanitizeLearningPartnerProfile(right);
  let score = 0;
  const reasons = [];
  if (a.examTrack && b.examTrack && textKey(a.examTrack) === textKey(b.examTrack)) {
    score += 25;
    reasons.push("Same exam track");
  }
  if (a.targetDate && b.targetDate) {
    const difference = Math.abs(new Date(`${a.targetDate}T12:00:00.000Z`).getTime() - new Date(`${b.targetDate}T12:00:00.000Z`).getTime()) / 86400000;
    if (difference <= 14) { score += 20; reasons.push("Very near target dates"); }
    else if (difference <= 30) { score += 12; reasons.push("Near target dates"); }
  }
  const sharedAvailability = overlap(a.availability, b.availability);
  if (sharedAvailability.length) { score += Math.min(15, sharedAvailability.length * 6); reasons.push("Compatible study times"); }
  else if (a.timezone && b.timezone && textKey(a.timezone) === textKey(b.timezone)) { score += 8; reasons.push("Same timezone"); }
  const sharedSubjects = overlap(a.subjects, b.subjects);
  if (sharedSubjects.length) { score += Math.min(15, sharedSubjects.length * 5); reasons.push(`Shared study topics: ${sharedSubjects.slice(0, 3).join(", ")}`); }
  const sharedLanguages = overlap(a.languages, b.languages);
  if (sharedLanguages.length) { score += 8; reasons.push("Same language preference"); }
  if (a.studyStyle && b.studyStyle && textKey(a.studyStyle) === textKey(b.studyStyle)) { score += 7; reasons.push("Compatible study style"); }
  if (a.dailyHours && b.dailyHours && Math.abs(a.dailyHours - b.dailyHours) <= 1) { score += 10; reasons.push("Similar daily study capacity"); }
  return { score: Math.max(0, Math.min(100, score)), reasons: [...new Set(reasons)] };
}

/** Aggregate only verified learning evidence; client claims never become weakness. */
export function buildCrossSystemWeakAreaSummary(signals = []) {
  const groups = new Map();
  for (const signal of Array.isArray(signals) ? signals : []) {
    if (!signal || signal.verified !== true) continue;
    const topic = cleanText(signal.topic || signal.system, 180);
    const topicKey = textKey(topic);
    if (!topicKey) continue;
    if (!groups.has(topicKey)) {
      groups.set(topicKey, {
        topic,
        systems: new Set(),
        sources: new Set(),
        evidenceTypes: new Set(),
        evidenceCount: 0,
        weaknessScore: 0,
      });
    }
    const row = groups.get(topicKey);
    const system = cleanText(signal.system || "General", 140);
    const source = cleanText(signal.source || "unknown", 160);
    const evidenceType = cleanText(signal.evidenceType || signal.type || "performance", 100);
    if (system) row.systems.add(system);
    if (source) row.sources.add(source);
    if (evidenceType) row.evidenceTypes.add(evidenceType);
    const count = Math.max(1, Math.min(1000, Number(signal.evidenceCount || 1) || 1));
    row.evidenceCount += count;
    row.weaknessScore += Math.max(0, Math.min(100, Number(signal.weaknessScore ?? signal.weight ?? 1) || 0)) * count;
  }

  const weakAreas = [...groups.values()].map((row) => ({
    topic: row.topic,
    systems: [...row.systems].sort(),
    sources: [...row.sources].sort(),
    evidenceTypes: [...row.evidenceTypes].sort(),
    evidenceCount: row.evidenceCount,
    weaknessScore: Number((row.weaknessScore / Math.max(1, row.evidenceCount)).toFixed(1)),
    sharedUnderlyingTopic: row.systems.size >= 2 || row.sources.size >= 2,
  })).sort((left, right) => (
    Number(right.sharedUnderlyingTopic) - Number(left.sharedUnderlyingTopic)
    || right.sources.length - left.sources.length
    || right.systems.length - left.systems.length
    || right.weaknessScore - left.weaknessScore
    || right.evidenceCount - left.evidenceCount
    || left.topic.localeCompare(right.topic)
  ));

  return {
    weakAreas: weakAreas.slice(0, 20),
    sharedUnderlyingTopics: weakAreas.filter((row) => row.sharedUnderlyingTopic && row.evidenceCount >= 2).slice(0, 10),
    verifiedEvidenceOnly: true,
  };
}
