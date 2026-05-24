import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import axios from "axios";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

dotenv.config();

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json({ limit: "10mb" }));
app.use(cors({ origin: "*" }));

const POCKETBASE_URL = process.env.POCKETBASE_URL;
const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_ZOOM_DURATION_MINUTES = 120;
const PENDING_ZOOM_PREFIX = "PENDING_ZOOM_";

const DATA_DIR = process.env.DATA_DIR || "/tmp";
const LIVE_DB_PATH = path.join(DATA_DIR, "live-session-db.json");

/* -------------------------------------------------------------------------- */
/* Persistent JSON database                                                    */
/* -------------------------------------------------------------------------- */

const DEFAULT_FEATURE_CATALOG = {
  video_library: {
    key: "video_library",
    name: "Video Library",
    description: "Access to recorded video lessons",
    is_active: true,
    free_for_all: false,
  },
  live_classes: {
    key: "live_classes",
    name: "Live Classes",
    description: "Access to scheduled Zoom live classes",
    is_active: true,
    free_for_all: false,
  },
  recordings: {
    key: "recordings",
    name: "Class Recordings",
    description: "Access to published class recordings",
    is_active: true,
    free_for_all: false,
  },
  community: {
    key: "community",
    name: "Community Messages",
    description: "Access to session community discussion",
    is_active: true,
    free_for_all: false,
  },
  mini_mock: {
    key: "mini_mock",
    name: "Mini Mock / Quiz",
    description: "Access to session mini mock score tracking",
    is_active: true,
    free_for_all: false,
  },
  notes_transcripts: {
    key: "notes_transcripts",
    name: "Notes & Transcripts",
    description: "Access to class notes and transcript links",
    is_active: true,
    free_for_all: false,
  },
  leaderboard: {
    key: "leaderboard",
    name: "Leaderboard",
    description: "Access to attendance, tasks, and quiz leaderboard",
    is_active: true,
    free_for_all: false,
  },
  roadmap: {
    key: "roadmap",
    name: "Roadmap",
    description: "Access to course roadmap and daily tasks",
    is_active: true,
    free_for_all: true,
  },
  support: {
    key: "support",
    name: "Student Support",
    description: "Access to support and announcements",
    is_active: true,
    free_for_all: false,
  },
};

const DEFAULT_DEMO_SETTINGS = {
  enabled: true,
  duration_days: 2,
  allow_live_classes: true,
  allow_roadmap: true,
  allow_community: true,
  allow_mini_mock: true,
  allow_leaderboard: true,
  allow_recordings: false,
  allow_notes_transcripts: false,
  allow_video_library: false,
  max_live_sessions: null,
  updated_at: null,
};

const DEFAULT_LIVE_DB = {
  recordings: {},
  attendance: {},
  streaks: {},
  courseProgress: {},
  leaderboard: {},
  communityMessages: {},
  quizAttempts: {},
  notes: {},

  plans: {},
  coupons: {},
  couponRedemptions: {},
  featureCatalog: DEFAULT_FEATURE_CATALOG,
  demoSettings: DEFAULT_DEMO_SETTINGS,

  googleAuthUsers: {},

  roadmaps: {},
  roadmapProgress: {},
  roadmapEvents: {},

  updatedAt: null,
};

let writeQueue = Promise.resolve();

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readLiveDb() {
  try {
    await ensureDataDir();
    const raw = await fs.readFile(LIVE_DB_PATH, "utf8");
    const parsed = JSON.parse(raw);

    return {
      ...DEFAULT_LIVE_DB,
      ...parsed,
      recordings: parsed.recordings || {},
      attendance: parsed.attendance || {},
      streaks: parsed.streaks || {},
      courseProgress: parsed.courseProgress || {},
      leaderboard: parsed.leaderboard || {},
      communityMessages: parsed.communityMessages || {},
      quizAttempts: parsed.quizAttempts || {},
      notes: parsed.notes || {},
      plans: parsed.plans || {},
      coupons: parsed.coupons || {},
      couponRedemptions: parsed.couponRedemptions || {},
      googleAuthUsers: parsed.googleAuthUsers || {},
      roadmaps: parsed.roadmaps || {},
      roadmapProgress: parsed.roadmapProgress || {},
      roadmapEvents: parsed.roadmapEvents || {},
      featureCatalog: {
        ...DEFAULT_FEATURE_CATALOG,
        ...(parsed.featureCatalog || {}),
      },
      demoSettings: {
        ...DEFAULT_DEMO_SETTINGS,
        ...(parsed.demoSettings || {}),
      },
    };
  } catch (error) {
    if (error.code === "ENOENT") return { ...DEFAULT_LIVE_DB };
    console.error("Live DB read error:", error.message);
    return { ...DEFAULT_LIVE_DB };
  }
}

async function writeLiveDb(db) {
  writeQueue = writeQueue.then(async () => {
    await ensureDataDir();

    const nextDb = {
      ...DEFAULT_LIVE_DB,
      ...db,
      featureCatalog: {
        ...DEFAULT_FEATURE_CATALOG,
        ...(db.featureCatalog || {}),
      },
      demoSettings: {
        ...DEFAULT_DEMO_SETTINGS,
        ...(db.demoSettings || {}),
      },
      updatedAt: new Date().toISOString(),
    };

    const tempPath = `${LIVE_DB_PATH}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(nextDb, null, 2), "utf8");
    await fs.rename(tempPath, LIVE_DB_PATH);
  });

  return writeQueue;
}

/* -------------------------------------------------------------------------- */
/* Generic helpers                                                             */
/* -------------------------------------------------------------------------- */

function getTodayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function toDateString(date) {
  return date.toISOString().split("T")[0];
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isNaN(number) ? fallback : number;
}

function clamp(number, min, max) {
  return Math.max(min, Math.min(max, number));
}

function buildUserSessionKey(userId, sessionId) {
  return `${userId}:${sessionId}`;
}

function buildCourseUserKey(courseId, userId) {
  return `${courseId}:${userId}`;
}

function buildLeaderboardKey(courseId, userId) {
  return `${courseId}:${userId}`;
}

function buildRoadmapDayKey(courseId, dayNumber) {
  return `${courseId}:day:${dayNumber}`;
}

function buildRoadmapProgressKey(courseId, userId, dayId) {
  return `${courseId}:${userId}:${dayId}`;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    return value
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function calculateStreakFromAttendance(attendanceItems) {
  const dates = [...new Set(attendanceItems.map((item) => item.date))]
    .filter(Boolean)
    .sort();

  if (dates.length === 0) return 0;

  let streak = 1;

  for (let i = dates.length - 1; i > 0; i -= 1) {
    const current = new Date(`${dates[i]}T00:00:00Z`);
    const previous = new Date(`${dates[i - 1]}T00:00:00Z`);
    const diffDays = Math.round(
      (current.getTime() - previous.getTime()) / (24 * 60 * 60 * 1000)
    );

    if (diffDays === 1) streak += 1;
    else if (diffDays > 1) break;
  }

  return streak;
}

function buildClassDates({ startDate, classCount, skipSundays }) {
  const dates = [];
  if (!startDate || !classCount) return dates;

  let cursor = new Date(`${startDate}T00:00:00`);

  while (dates.length < Number(classCount)) {
    const isSunday = cursor.getDay() === 0;
    if (!(skipSundays && isSunday)) dates.push(toDateString(cursor));
    cursor = addDays(cursor, 1);
  }

  return dates;
}

function getNextClassDateAfter(dateString, skipSundays = true) {
  let cursor = addDays(new Date(`${dateString}T00:00:00`), 1);
  while (skipSundays && cursor.getDay() === 0) cursor = addDays(cursor, 1);
  return toDateString(cursor);
}

function buildPendingZoomId(courseId, classNumber) {
  return `${PENDING_ZOOM_PREFIX}${courseId}_${classNumber}_${Date.now()}`;
}

function isPendingZoomId(value) {
  return String(value || "").startsWith(PENDING_ZOOM_PREFIX);
}

function hasRealZoomMeetingId(value) {
  return Boolean(value) && !isPendingZoomId(value);
}

/* -------------------------------------------------------------------------- */
/* Timezone helpers                                                            */
/* -------------------------------------------------------------------------- */

function getTimezoneOffsetMs(timeZone, date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }

  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return asUtc - date.getTime();
}

function getSessionStartUtc(scheduledDate, scheduledTime, timezone = DEFAULT_TIMEZONE) {
  if (!scheduledDate || !scheduledTime) return null;

  const dateStr = String(scheduledDate).split(" ")[0];
  const timeStr = String(scheduledTime).trim();
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);

  if (!year || !month || !day || Number.isNaN(hour) || Number.isNaN(minute)) return null;

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = getTimezoneOffsetMs(timezone, utcGuess);

  return new Date(utcGuess.getTime() - offset);
}

/* -------------------------------------------------------------------------- */
/* Sanitizers                                                                  */
/* -------------------------------------------------------------------------- */

function sanitizePublicRecording(recording) {
  return {
    meeting_id: recording.meeting_id || null,
    uuid: recording.uuid || null,
    topic: recording.topic || null,
    start_time: recording.start_time || null,
    duration: recording.duration || null,
    recording_url: recording.recording_url || recording.share_url || null,
    share_url: recording.share_url || null,
    file_type: recording.file_type || null,
    recording_type: recording.recording_type || null,
    status: recording.status || null,
    published: Boolean(recording.published),
    session_id: recording.session_id || null,
    course_id: recording.course_id || null,
  };
}

function sanitizePlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description || "",
    price_cents: Number(plan.price_cents || 0),
    currency: plan.currency || "usd",
    billing_type: plan.billing_type || "one_time",
    course_id: plan.course_id || null,
    included_features: Array.isArray(plan.included_features) ? plan.included_features : [],
    access_days: plan.access_days || null,
    is_active: plan.is_active !== false,
    is_featured: Boolean(plan.is_featured),
    created_at: plan.created_at || null,
    updated_at: plan.updated_at || null,
  };
}

function sanitizeCoupon(coupon) {
  return {
    id: coupon.id,
    code: coupon.code,
    description: coupon.description || "",
    discount_type: coupon.discount_type || "percentage",
    discount_value: Number(coupon.discount_value || 0),
    max_uses: coupon.max_uses || null,
    used_count: Number(coupon.used_count || 0),
    expires_at: coupon.expires_at || null,
    course_id: coupon.course_id || null,
    plan_id: coupon.plan_id || null,
    is_active: coupon.is_active !== false,
    created_at: coupon.created_at || null,
    updated_at: coupon.updated_at || null,
  };
}

function sanitizeRoadmapDay(day, { includePrivate = true } = {}) {
  const base = {
    id: day.id,
    course_id: day.course_id,
    week_number: day.week_number,
    day_number: day.day_number,
    date: day.date,
    title: day.title,
    description: day.description || "",
    subtopics: day.subtopics || [],
    resources: day.resources || [],
    resource_links: day.resource_links || [],
    uworld_target: day.uworld_target || "",
    first_aid_topics: day.first_aid_topics || "",
    homework: day.homework || "",
    mini_mock_title: day.mini_mock_title || "",
    live_session_id: day.live_session_id || null,
    recording_meeting_id: day.recording_meeting_id || null,
    status: day.status || "scheduled",
    is_locked: Boolean(day.is_locked),
    is_published: day.is_published !== false,
    is_holiday: Boolean(day.is_holiday),
    moved_from_date: day.moved_from_date || null,
    moved_to_date: day.moved_to_date || null,
    updated_at: day.updated_at || null,
  };

  if (includePrivate) {
    base.admin_notes = day.admin_notes || "";
  }

  return base;
}

/* -------------------------------------------------------------------------- */
/* Coupon / pricing helpers                                                    */
/* -------------------------------------------------------------------------- */

function normalizeCouponCode(code) {
  return String(code || "").trim().toUpperCase();
}

function centsFromDollars(value) {
  const number = Number(value || 0);
  if (Number.isNaN(number)) return 0;
  return Math.max(0, Math.round(number * 100));
}

function isCouponExpired(coupon) {
  if (!coupon?.expires_at) return false;
  return new Date(coupon.expires_at).getTime() < Date.now();
}

function calculateDiscountCents(planPriceCents, coupon) {
  if (!coupon) return 0;

  const price = Number(planPriceCents || 0);
  const value = Number(coupon.discount_value || 0);

  if (price <= 0 || value <= 0) return 0;

  if (coupon.discount_type === "percentage") {
    const percentage = Math.min(100, Math.max(0, value));
    return Math.min(price, Math.round(price * (percentage / 100)));
  }

  if (coupon.discount_type === "fixed") return Math.min(price, centsFromDollars(value));

  return 0;
}

function validateCouponForPlan({ coupon, plan, courseId }) {
  if (!coupon) return { valid: false, error: "Coupon not found" };
  if (coupon.is_active === false) return { valid: false, error: "Coupon is inactive" };
  if (isCouponExpired(coupon)) return { valid: false, error: "Coupon has expired" };
  if (coupon.max_uses && Number(coupon.used_count || 0) >= Number(coupon.max_uses)) {
    return { valid: false, error: "Coupon usage limit reached" };
  }
  if (coupon.plan_id && String(coupon.plan_id) !== String(plan.id)) {
    return { valid: false, error: "Coupon is not valid for this plan" };
  }
  if (coupon.course_id && String(coupon.course_id) !== String(courseId || plan.course_id || "")) {
    return { valid: false, error: "Coupon is not valid for this course" };
  }

  return { valid: true, error: null };
}

function buildCheckoutPricing({ plan, coupon, courseId }) {
  const originalAmountCents = Number(plan.price_cents || 0);
  const couponValidation = coupon
    ? validateCouponForPlan({ coupon, plan, courseId })
    : { valid: true, error: null };

  if (!couponValidation.valid) return { valid: false, error: couponValidation.error };

  const discountCents = coupon ? calculateDiscountCents(originalAmountCents, coupon) : 0;
  const finalAmountCents = Math.max(0, originalAmountCents - discountCents);

  return {
    valid: true,
    original_amount_cents: originalAmountCents,
    discount_cents: discountCents,
    final_amount_cents: finalAmountCents,
    coupon_code: coupon?.code || null,
  };
}

/* -------------------------------------------------------------------------- */
/* Auth / external helpers                                                     */
/* -------------------------------------------------------------------------- */

function isAdminOrInstructor(user, session) {
  return user?.role === "admin" || user?.role === "instructor" || session?.instructor_id === user?.id;
}

function isSessionLocked(session) {
  return session.status === "completed" || session.status === "cancelled" || hasRealZoomMeetingId(session.zoom_meeting_id);
}

async function getPocketBaseUserFromToken(token) {
  const userRefresh = await axios.post(
    `${POCKETBASE_URL}/api/collections/users/auth-refresh`,
    {},
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return userRefresh.data.record;
}

async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) {
    const error = new Error("User not authenticated");
    error.statusCode = 401;
    throw error;
  }

  if (!POCKETBASE_URL) {
    const error = new Error("POCKETBASE_URL is missing in backend environment variables");
    error.statusCode = 500;
    throw error;
  }

  const user = await getPocketBaseUserFromToken(token);

  if (!user?.id) {
    const error = new Error("Invalid user token");
    error.statusCode = 401;
    throw error;
  }

  return { user, token };
}

async function requireAdmin(req) {
  const { user, token } = await getAuthenticatedUser(req);

  if (user.role !== "admin") {
    const error = new Error("Only admins can perform this action");
    error.statusCode = 403;
    throw error;
  }

  return { user, token };
}

async function requireAdminOrInstructor(req) {
  const { user, token } = await getAuthenticatedUser(req);

  if (user.role !== "admin" && user.role !== "instructor") {
    const error = new Error("Only admins or instructors can perform this action");
    error.statusCode = 403;
    throw error;
  }

  return { user, token };
}

async function pocketBasePasswordLogin(email, password) {
  const response = await axios.post(`${POCKETBASE_URL}/api/collections/users/auth-with-password`, {
    identity: email,
    password,
  });
  return response.data;
}

async function createPocketBaseStudent({ email, name, password }) {
  const response = await axios.post(`${POCKETBASE_URL}/api/collections/users/records`, {
    email,
    name,
    password,
    passwordConfirm: password,
    role: "student",
  });
  return response.data;
}

async function getEnrollmentForCourse({ userId, courseId, token }) {
  try {
    const filter = encodeURIComponent(`user_id="${userId}" && course_id="${courseId}" && access_granted=true`);
    const response = await axios.get(
      `${POCKETBASE_URL}/api/collections/enrollments/records?perPage=20&filter=${filter}&sort=-created`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    return response.data?.items?.[0] || null;
  } catch {
    return null;
  }
}

function isDemoEnrollmentActive(enrollment, demoSettings) {
  if (!enrollment?.is_demo) return true;
  if (!demoSettings.enabled) return false;
  if (!enrollment.demo_expiry) return true;
  const expiryTime = new Date(`${enrollment.demo_expiry}T23:59:59`).getTime();
  return expiryTime >= Date.now();
}

async function grantEnrollmentAccessForCheckout({ token, enrollmentId, studentId, courseId }) {
  const headers = { Authorization: `Bearer ${token}` };
  const accessPayload = {
    user_id: studentId,
    course_id: courseId,
    access_granted: true,
    progress_percentage: 0,
    is_demo: false,
  };

  if (enrollmentId) {
    try {
      const existingResponse = await axios.get(
        `${POCKETBASE_URL}/api/collections/enrollments/records/${enrollmentId}`,
        { headers }
      );
      const existing = existingResponse.data;

      if (String(existing.user_id) === String(studentId) && String(existing.course_id) === String(courseId)) {
        const updateResponse = await axios.patch(
          `${POCKETBASE_URL}/api/collections/enrollments/records/${enrollmentId}`,
          { access_granted: true, is_demo: false },
          { headers }
        );
        return { granted: true, method: "updated_requested_enrollment", enrollment: updateResponse.data };
      }
    } catch (error) {
      console.warn("Requested enrollment update failed, falling back:", error.response?.data || error.message);
    }
  }

  try {
    const filter = encodeURIComponent(`user_id="${studentId}" && course_id="${courseId}" && is_demo=false`);
    const listResponse = await axios.get(
      `${POCKETBASE_URL}/api/collections/enrollments/records?perPage=20&filter=${filter}&sort=-created`,
      { headers }
    );

    const existing = listResponse.data?.items?.[0];

    if (existing?.id) {
      try {
        const updateResponse = await axios.patch(
          `${POCKETBASE_URL}/api/collections/enrollments/records/${existing.id}`,
          { access_granted: true, is_demo: false },
          { headers }
        );
        return { granted: true, method: "updated_existing_enrollment", enrollment: updateResponse.data };
      } catch (updateError) {
        console.warn("Existing enrollment update failed, will create new:", updateError.response?.data || updateError.message);
      }
    }
  } catch (error) {
    console.warn("Existing enrollment lookup failed, will create new:", error.response?.data || error.message);
  }

  try {
    const createResponse = await axios.post(`${POCKETBASE_URL}/api/collections/enrollments/records`, accessPayload, { headers });
    return { granted: true, method: "created_new_access_enrollment", enrollment: createResponse.data };
  } catch (createError) {
    const error = new Error(
      createError.response?.data?.message ||
        createError.response?.data?.error ||
        createError.message ||
        "Failed to grant enrollment access"
    );
    error.statusCode = createError.response?.status || 500;
    error.details = createError.response?.data || null;
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Zoom helpers                                                                */
/* -------------------------------------------------------------------------- */

async function getZoomAccessToken() {
  const response = await axios.post(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${process.env.ZOOM_ACCOUNT_ID}`,
    {},
    {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString("base64"),
      },
    }
  );

  return response.data.access_token;
}

async function createZoomMeetingForLiveSession(session, timezone = DEFAULT_TIMEZONE) {
  const accessToken = await getZoomAccessToken();
  const sessionStartUtc = getSessionStartUtc(session.scheduled_date, session.scheduled_time, timezone);

  if (!sessionStartUtc) throw new Error("Session scheduled date/time is invalid");

  const response = await axios.post(
    "https://api.zoom.us/v2/users/me/meetings",
    {
      topic: session.topic || "Live Class",
      type: 2,
      start_time: sessionStartUtc.toISOString(),
      duration: DEFAULT_ZOOM_DURATION_MINUTES,
      timezone,
      settings: {
        host_video: true,
        participant_video: true,
        join_before_host: false,
        waiting_room: true,
        auto_recording: "cloud",
      },
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return response.data;
}

async function fetchPocketBaseSession(sessionId, token) {
  const response = await axios.get(
    `${POCKETBASE_URL}/api/collections/live_sessions/records/${sessionId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data;
}

async function getLastScheduledSessionForCourse(courseId, token) {
  const response = await axios.get(
    `${POCKETBASE_URL}/api/collections/live_sessions/records?perPage=1&filter=${encodeURIComponent(
      `course_id="${courseId}"`
    )}&sort=-scheduled_date,-scheduled_time`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return response.data?.items?.[0] || null;
}

async function tryCreateAnnouncement(token, payload) {
  try {
    const response = await axios.post(`${POCKETBASE_URL}/api/collections/announcements/records`, payload, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  } catch (firstError) {
    console.warn("Announcement create failed. Retrying with title/content only:", firstError.response?.data || firstError.message);
    try {
      const response = await axios.post(
        `${POCKETBASE_URL}/api/collections/announcements/records`,
        { title: payload.title, content: payload.content },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return response.data;
    } catch (secondError) {
      console.warn("Announcement fallback failed:", secondError.response?.data || secondError.message);
      return null;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Roadmap helpers                                                             */
/* -------------------------------------------------------------------------- */

const STEP1_TOPIC_ROTATION = [
  "Orientation, study method, and diagnostic planning",
  "Biochemistry and molecular biology",
  "Genetics and inheritance patterns",
  "Immunology foundations",
  "Microbiology: bacteria and antibiotics",
  "Microbiology: viruses, fungi, parasites",
  "Pathology general principles",
  "Pharmacology general principles",
  "Cardiovascular physiology",
  "Cardiovascular pathology and pharmacology",
  "Respiratory physiology",
  "Respiratory pathology and pharmacology",
  "Renal physiology",
  "Renal pathology and pharmacology",
  "Endocrinology physiology",
  "Endocrinology pathology and pharmacology",
  "Gastrointestinal physiology",
  "Gastrointestinal pathology and pharmacology",
  "Neurology and neuroanatomy",
  "Neuropathology and neuropharmacology",
  "Psychiatry and behavioral science",
  "Reproductive system",
  "Hematology and oncology",
  "Musculoskeletal, dermatology, and connective tissue",
  "Biostatistics and ethics",
  "Mixed UWorld block review",
  "Weak-area targeted review",
  "Mini mock and review",
];

const STEP2_TOPIC_ROTATION = [
  "Internal medicine overview and diagnostic approach",
  "Cardiology clinical cases",
  "Pulmonology clinical cases",
  "Nephrology clinical cases",
  "Endocrinology clinical cases",
  "Gastroenterology clinical cases",
  "Infectious disease clinical cases",
  "Neurology clinical cases",
  "Psychiatry clinical cases",
  "OB/GYN clinical cases",
  "Pediatrics clinical cases",
  "Surgery clinical cases",
  "Emergency medicine and ethics",
  "Biostatistics and screening",
  "Mixed CMS/NBME-style block review",
  "Weak-area targeted review",
  "Mini mock and review",
];

function getTemplateTopic(template, dayNumber) {
  const pool = template === "usmle_step_2_ck" ? STEP2_TOPIC_ROTATION : STEP1_TOPIC_ROTATION;
  return pool[(dayNumber - 1) % pool.length];
}

function buildRoadmapDates({ startDate, durationDays, skipSundays }) {
  return buildClassDates({ startDate, classCount: durationDays, skipSundays });
}

function buildDefaultRoadmapDay({ courseId, courseName, date, dayNumber, durationDays, template, classTime }) {
  const weekNumber = Math.ceil(dayNumber / 7);
  const topic = getTemplateTopic(template, dayNumber);
  const isWeeklyReview = dayNumber % 7 === 0;

  return {
    id: buildRoadmapDayKey(courseId, dayNumber),
    course_id: courseId,
    week_number: weekNumber,
    day_number: dayNumber,
    date,
    title: isWeeklyReview ? `Week ${weekNumber} Review + Mini Mock` : topic,
    description: isWeeklyReview
      ? "Weekly consolidation, incorrect-question review, and mini mock performance tracking."
      : `Daily live-session plan for ${courseName || "the course"}: ${topic}.`,
    subtopics: isWeeklyReview ? ["Weak areas", "Incorrect questions", "Mini mock review"] : [],
    resources: isWeeklyReview ? ["UWorld incorrects", "First Aid weak topics"] : ["First Aid", "UWorld", "Class notes"],
    resource_links: [],
    uworld_target: isWeeklyReview ? "Mixed review block / incorrects" : "30-40 MCQs or assigned block",
    first_aid_topics: isWeeklyReview ? "Review marked/high-yield topics" : topic,
    homework: isWeeklyReview ? "Review missed questions and update weak-area notes" : "Complete assigned MCQs and review explanations",
    mini_mock_title: isWeeklyReview ? `Week ${weekNumber} Mini Mock` : "",
    live_session_id: null,
    recording_meeting_id: null,
    class_time: classTime || null,
    status: "scheduled",
    is_locked: false,
    is_published: true,
    is_holiday: false,
    admin_notes: "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    total_duration_days: durationDays,
    template,
  };
}

function getRoadmapForCourse(db, courseId) {
  return db.roadmaps[String(courseId)] || null;
}

function setRoadmapForCourse(db, courseId, roadmap) {
  db.roadmaps[String(courseId)] = roadmap;
}

function buildProgressSummary({ db, courseId, userId }) {
  const roadmap = getRoadmapForCourse(db, courseId);
  const days = roadmap?.days || [];
  const publishedDays = days.filter((day) => day.is_published !== false);
  const progressItems = Object.values(db.roadmapProgress || {}).filter(
    (item) => String(item.course_id) === String(courseId) && String(item.user_id) === String(userId)
  );

  const completedDayIds = new Set(progressItems.filter((item) => item.completed).map((item) => item.day_id));
  const completedDays = publishedDays.filter((day) => completedDayIds.has(day.id));
  const totalDays = publishedDays.length;
  const completedCount = completedDays.length;
  const remainingDays = Math.max(0, totalDays - completedCount);
  const progressPercentage = totalDays > 0 ? Math.round((completedCount / totalDays) * 100) : 0;
  const todayKey = getTodayKey();

  const todayDay =
    publishedDays.find((day) => day.date === todayKey) ||
    publishedDays.find((day) => day.status === "scheduled" && !completedDayIds.has(day.id)) ||
    publishedDays[0] ||
    null;

  return {
    course_id: courseId,
    total_days: totalDays,
    completed_days: completedCount,
    remaining_days: remainingDays,
    progress_percentage: progressPercentage,
    current_week: todayDay?.week_number || null,
    current_day: todayDay?.day_number || null,
    today_day: todayDay ? sanitizeRoadmapDay(todayDay, { includePrivate: false }) : null,
    completed_day_ids: [...completedDayIds],
  };
}

function getStudentAttempts(db, courseId, userId) {
  let attempts = [];
  for (const item of Object.values(db.quizAttempts || {})) attempts = attempts.concat(item || []);
  return attempts.filter((item) => String(item.course_id) === String(courseId) && String(item.user_id) === String(userId));
}

function calculatePerformanceFromAttempts(attempts) {
  if (!attempts.length) {
    return {
      attempts_count: 0,
      average_score: 0,
      best_score: 0,
      latest_score: 0,
      focus_areas: [],
    };
  }

  const percentages = attempts.map((item) => Number(item.percentage || 0));
  const average = Math.round(percentages.reduce((sum, item) => sum + item, 0) / percentages.length);
  const best = Math.max(...percentages);
  const latest = percentages[percentages.length - 1];

  const topicScores = {};
  for (const attempt of attempts) {
    const topic = attempt.topic || attempt.subject || attempt.quiz_id || "General";
    if (!topicScores[topic]) topicScores[topic] = [];
    topicScores[topic].push(Number(attempt.percentage || 0));
  }

  const focusAreas = Object.entries(topicScores)
    .map(([name, scores]) => ({
      name,
      score: Math.round(scores.reduce((sum, item) => sum + item, 0) / scores.length),
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);

  return {
    attempts_count: attempts.length,
    average_score: average,
    best_score: best,
    latest_score: latest,
    focus_areas: focusAreas,
  };
}

function updateLeaderboardForUser(db, { courseId, userId, userName }) {
  const attendance = Object.values(db.attendance || {}).filter(
    (item) => String(item.course_id) === String(courseId) && String(item.user_id) === String(userId)
  );
  const progressSummary = buildProgressSummary({ db, courseId, userId });
  const attempts = getStudentAttempts(db, courseId, userId);
  const performance = calculatePerformanceFromAttempts(attempts);

  const attendancePoints = new Set(attendance.map((item) => item.session_id)).size * 10;
  const taskPoints = progressSummary.completed_days * 5;
  const quizPoints = attempts.reduce((sum, item) => sum + Math.round(Number(item.percentage || 0) / 10), 0);
  const totalPoints = attendancePoints + taskPoints + quizPoints;
  const leaderboardKey = buildLeaderboardKey(courseId, userId);

  db.leaderboard[leaderboardKey] = {
    ...(db.leaderboard[leaderboardKey] || {}),
    course_id: courseId,
    user_id: userId,
    user_name: userName || db.leaderboard[leaderboardKey]?.user_name || "Student",
    attendance_points: attendancePoints,
    task_points: taskPoints,
    quiz_points: quizPoints,
    total_points: totalPoints,
    average_score: performance.average_score,
    roadmap_progress_percentage: progressSummary.progress_percentage,
    updated_at: new Date().toISOString(),
  };

  return db.leaderboard[leaderboardKey];
}

function adjustRoadmapForHoliday({ db, session, replacementSession, shiftFutureDays, createReplacement, reason }) {
  if (!session?.course_id) return null;

  const roadmap = getRoadmapForCourse(db, session.course_id);
  if (!roadmap?.days?.length) return null;

  const sessionId = String(session.id);
  const dayIndex = roadmap.days.findIndex((day) => String(day.live_session_id || "") === sessionId);

  if (dayIndex < 0) return null;

  const cancelledDay = roadmap.days[dayIndex];
  const originalDate = cancelledDay.date;

  roadmap.days[dayIndex] = {
    ...cancelledDay,
    status: "holiday",
    is_holiday: true,
    holiday_reason: reason || "Tutor unavailable",
    title: cancelledDay.title?.includes("Holiday") ? cancelledDay.title : `${cancelledDay.title} - Holiday`,
    updated_at: new Date().toISOString(),
  };

  let replacementDay = null;

  if (replacementSession && createReplacement) {
    const maxDayNumber = roadmap.days.reduce((max, day) => Math.max(max, Number(day.day_number || 0)), 0);
    const replacementDate = replacementSession.scheduled_date || getNextClassDateAfter(roadmap.days[roadmap.days.length - 1].date, Boolean(roadmap.settings?.skip_sundays));

    replacementDay = {
      ...cancelledDay,
      id: buildRoadmapDayKey(session.course_id, maxDayNumber + 1),
      week_number: Math.ceil((maxDayNumber + 1) / 7),
      day_number: maxDayNumber + 1,
      date: replacementDate,
      title: cancelledDay.title?.replace(" - Holiday", "") || `Replacement Class ${maxDayNumber + 1}`,
      status: "scheduled",
      is_holiday: false,
      live_session_id: replacementSession.id,
      moved_from_date: originalDate,
      moved_to_date: replacementDate,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    roadmap.days.push(replacementDay);
  }

  if (shiftFutureDays) {
    for (let index = dayIndex + 1; index < roadmap.days.length; index += 1) {
      const day = roadmap.days[index];
      if (!day.date || day.is_holiday) continue;
      const nextDate = getNextClassDateAfter(day.date, Boolean(roadmap.settings?.skip_sundays));
      roadmap.days[index] = {
        ...day,
        moved_from_date: day.moved_from_date || day.date,
        date: nextDate,
        moved_to_date: nextDate,
        status: day.status === "completed" ? day.status : "moved",
        updated_at: new Date().toISOString(),
      };
    }
  }

  roadmap.updated_at = new Date().toISOString();
  setRoadmapForCourse(db, session.course_id, roadmap);

  return {
    cancelled_day: roadmap.days[dayIndex],
    replacement_day: replacementDay,
    shifted: Boolean(shiftFutureDays),
  };
}

/* -------------------------------------------------------------------------- */
/* Basic routes                                                                */
/* -------------------------------------------------------------------------- */

app.get("/", (req, res) => {
  res.send("NextGen Backend Running");
});

app.get("/health", async (req, res) => {
  const liveDbExists = await fs.access(LIVE_DB_PATH).then(() => true).catch(() => false);
  res.json({
    success: true,
    message: "Backend running",
    data_dir: DATA_DIR,
    live_db_path: LIVE_DB_PATH,
    live_db_exists: liveDbExists,
  });
});

/* -------------------------------------------------------------------------- */
/* Google login through Render backend                                         */
/* -------------------------------------------------------------------------- */

async function verifyGoogleIdToken(idToken) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    const error = new Error("GOOGLE_CLIENT_ID is missing in Render environment variables");
    error.statusCode = 500;
    throw error;
  }

  if (!idToken) {
    const error = new Error("Google ID token is required");
    error.statusCode = 400;
    throw error;
  }

  const response = await axios.get("https://oauth2.googleapis.com/tokeninfo", {
    params: { id_token: idToken },
  });

  const profile = response.data;

  if (String(profile.aud) !== String(process.env.GOOGLE_CLIENT_ID)) {
    const error = new Error("Google token audience mismatch");
    error.statusCode = 401;
    throw error;
  }

  if (String(profile.email_verified) !== "true") {
    const error = new Error("Google email is not verified");
    error.statusCode = 401;
    throw error;
  }

  if (!profile.email) {
    const error = new Error("Google account email is missing");
    error.statusCode = 400;
    throw error;
  }

  return {
    email: String(profile.email).toLowerCase(),
    name: profile.name || profile.given_name || String(profile.email).split("@")[0],
    picture: profile.picture || null,
    google_sub: profile.sub || null,
  };
}

app.post("/auth/google", async (req, res) => {
  try {
    if (!POCKETBASE_URL) {
      return res.status(500).json({ success: false, error: "POCKETBASE_URL is missing" });
    }

    const { id_token } = req.body;
    const profile = await verifyGoogleIdToken(id_token);
    const db = await readLiveDb();
    const emailKey = profile.email;
    const existingGoogleUser = db.googleAuthUsers[emailKey];

    if (existingGoogleUser?.password) {
      try {
        const authData = await pocketBasePasswordLogin(emailKey, existingGoogleUser.password);
        return res.json({ success: true, token: authData.token, record: authData.record, created: false });
      } catch (loginError) {
        console.warn("Stored Google user login failed:", loginError.response?.data || loginError.message);
      }
    }

    const generatedPassword = `NGG_${crypto.randomBytes(24).toString("hex")}_9aZ!`;

    try {
      const createdUser = await createPocketBaseStudent({
        email: emailKey,
        name: profile.name,
        password: generatedPassword,
      });

      const authData = await pocketBasePasswordLogin(emailKey, generatedPassword);

      db.googleAuthUsers[emailKey] = {
        email: emailKey,
        user_id: authData.record?.id || createdUser.id,
        password: generatedPassword,
        google_sub: profile.google_sub,
        name: profile.name,
        picture: profile.picture,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await writeLiveDb(db);

      return res.json({ success: true, token: authData.token, record: authData.record, created: true });
    } catch (createError) {
      return res.status(409).json({
        success: false,
        error:
          "A normal account with this email may already exist. Please use email/password login for this email, or use another Google email.",
        details: createError.response?.data || createError.message,
      });
    }
  } catch (error) {
    console.error("Google auth error:", error.response?.data || error.message);
    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error:
        error.response?.data?.error_description ||
        error.response?.data?.message ||
        error.message ||
        "Google login failed",
      details: error.response?.data || null,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Live classroom access                                                       */
/* -------------------------------------------------------------------------- */

app.get("/hcgi/api/live-class/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) return res.status(400).json({ allowed: false, error: "sessionId is required" });

    const { user, token } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    let session = await fetchPocketBaseSession(sessionId, token);

    if (!session?.id) return res.status(404).json({ allowed: false, error: "Session not found" });

    const courseId = session.course_id;
    if (!courseId) return res.status(400).json({ allowed: false, error: "Session missing course_id" });

    let allowed = false;
    let reason = "You don't have access to this session";
    const enrollment = await getEnrollmentForCourse({ userId: user.id, courseId, token });

    if (user.role === "admin" || user.role === "instructor" || session.instructor_id === user.id) {
      allowed = true;
    } else if (enrollment?.id) {
      if (enrollment.is_demo) {
        const demoSettings = { ...DEFAULT_DEMO_SETTINGS, ...(db.demoSettings || {}) };
        if (!isDemoEnrollmentActive(enrollment, demoSettings)) {
          allowed = false;
          reason = "Demo access is expired or disabled";
        } else if (!demoSettings.allow_live_classes) {
          allowed = false;
          reason = "Live classes are not available in demo access";
        } else {
          allowed = true;
        }
      } else {
        allowed = true;
      }
    }

    if (!allowed) return res.json({ allowed: false, reason });

    if (session.status === "cancelled") {
      return res.json({
        allowed: true,
        can_join: false,
        join_reason: "Tutor is unavailable today, or this session has been cancelled.",
        join_opens_at: null,
        session: {
          id: session.id,
          topic: session.topic || null,
          zoom_meeting_id: null,
          meeting_password: null,
          scheduled_date: session.scheduled_date || null,
          scheduled_time: session.scheduled_time || null,
          scheduled_timezone: DEFAULT_TIMEZONE,
          course_id: session.course_id || null,
          instructor_id: session.instructor_id || null,
          instructor_name: session.instructor_name || null,
          status: session.status || "cancelled",
          zoom_join_url: null,
          recording_url: session.recording_url || null,
        },
      });
    }

    const sessionStartUtc = getSessionStartUtc(session.scheduled_date, session.scheduled_time, DEFAULT_TIMEZONE);
    let canJoin = false;
    let joinReason = null;
    let joinOpensAt = null;

    if (session.status === "completed") {
      canJoin = false;
      joinReason = "Session is completed";
    } else if (!sessionStartUtc) {
      canJoin = false;
      joinReason = "Session date/time is not configured correctly";
    } else {
      const now = new Date();
      const joinOpenTime = new Date(sessionStartUtc.getTime() - 60 * 1000);
      joinOpensAt = joinOpenTime.toISOString();
      canJoin = now.getTime() >= joinOpenTime.getTime();
      if (!canJoin) joinReason = "Classroom opens 1 minute before class starts";
    }

    const userCanGenerateZoom = isAdminOrInstructor(user, session);

    if (canJoin && !hasRealZoomMeetingId(session.zoom_meeting_id) && session.status !== "completed" && session.status !== "cancelled") {
      if (!userCanGenerateZoom) {
        return res.json({
          allowed: true,
          can_join: false,
          join_reason: "Waiting for tutor to open the classroom",
          join_opens_at: joinOpensAt,
          session: {
            id: session.id,
            topic: session.topic || null,
            zoom_meeting_id: null,
            meeting_password: null,
            scheduled_date: session.scheduled_date || null,
            scheduled_time: session.scheduled_time || null,
            scheduled_timezone: DEFAULT_TIMEZONE,
            course_id: session.course_id || null,
            instructor_id: session.instructor_id || null,
            instructor_name: session.instructor_name || null,
            status: session.status || "scheduled",
            zoom_join_url: null,
            recording_url: session.recording_url || null,
          },
        });
      }

      const meeting = await createZoomMeetingForLiveSession(session, DEFAULT_TIMEZONE);
      const updateResponse = await axios.patch(
        `${POCKETBASE_URL}/api/collections/live_sessions/records/${session.id}`,
        {
          zoom_meeting_id: String(meeting.id),
          meeting_password: meeting.password || "pending",
          zoom_meeting_url: meeting.join_url || "pending",
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      session = updateResponse.data;
    }

    const sessionHasRealZoom = hasRealZoomMeetingId(session.zoom_meeting_id);

    return res.json({
      allowed: true,
      can_join: canJoin && sessionHasRealZoom,
      join_reason: canJoin && sessionHasRealZoom ? "Classroom is open" : joinReason || "Waiting for Zoom meeting generation",
      join_opens_at: joinOpensAt,
      session: {
        id: session.id,
        topic: session.topic || null,
        zoom_meeting_id: canJoin && sessionHasRealZoom ? session.zoom_meeting_id : null,
        meeting_password: canJoin && sessionHasRealZoom ? session.meeting_password || null : null,
        scheduled_date: session.scheduled_date || null,
        scheduled_time: session.scheduled_time || null,
        scheduled_timezone: DEFAULT_TIMEZONE,
        course_id: session.course_id || null,
        instructor_id: session.instructor_id || null,
        instructor_name: session.instructor_name || null,
        status: session.status || "scheduled",
        zoom_join_url: canJoin && sessionHasRealZoom ? session.zoom_meeting_url || null : null,
        recording_url: session.recording_url || null,
      },
    });
  } catch (error) {
    console.error("Live classroom error:", error.response?.data || error.message);
    return res.status(error.statusCode || error.response?.status || 500).json({
      allowed: false,
      error: error.response?.data?.message || error.response?.data?.error || error.message || "Failed to load live classroom",
      details: error.response?.data || null,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Course schedule sync + holiday                                               */
/* -------------------------------------------------------------------------- */

app.post("/course-schedule/sync", async (req, res) => {
  try {
    const { user, token } = await getAuthenticatedUser(req);
    if (!user?.id || user.role !== "admin") {
      return res.status(403).json({ success: false, error: "Only admins can sync course schedules" });
    }

    const {
      course_id,
      course_name,
      instructor_name,
      schedule_start_date,
      class_count,
      class_time,
      skip_sundays = true,
      generate_roadmap = false,
      roadmap_template = "usmle_step_1",
      preserve_existing_edits = true,
    } = req.body;

    if (!course_id) return res.status(400).json({ success: false, error: "course_id is required" });
    if (!schedule_start_date || !class_count || !class_time) {
      return res.status(400).json({ success: false, error: "schedule_start_date, class_count, and class_time are required" });
    }

    const desiredDates = buildClassDates({
      startDate: schedule_start_date,
      classCount: Number(class_count),
      skipSundays: Boolean(skip_sundays),
    });

    const existingResponse = await axios.get(
      `${POCKETBASE_URL}/api/collections/live_sessions/records?perPage=500&filter=${encodeURIComponent(`course_id="${course_id}"`)}&sort=scheduled_date,scheduled_time`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const existingSessions = existingResponse.data?.items || [];
    const sortedSessions = [...existingSessions].sort((a, b) => {
      const aTime = `${a.scheduled_date || ""} ${a.scheduled_time || ""}`;
      const bTime = `${b.scheduled_date || ""} ${b.scheduled_time || ""}`;
      return aTime.localeCompare(bTime);
    });

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const linkedSessions = [];

    for (let index = 0; index < desiredDates.length; index += 1) {
      const classNumber = index + 1;
      const scheduledDate = desiredDates[index];
      const existing = sortedSessions[index];
      const payload = {
        topic: `${course_name || "Course"} - Class ${classNumber}`,
        instructor_name: instructor_name || "Admin",
        scheduled_date: scheduledDate,
        scheduled_time: class_time,
        course_id,
        status: "scheduled",
      };

      if (existing) {
        if (isSessionLocked(existing)) {
          skippedCount += 1;
          linkedSessions.push(existing);
          continue;
        }

        const updateResponse = await axios.patch(
          `${POCKETBASE_URL}/api/collections/live_sessions/records/${existing.id}`,
          payload,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        linkedSessions.push(updateResponse.data);
        updatedCount += 1;
      } else {
        const createResponse = await axios.post(
          `${POCKETBASE_URL}/api/collections/live_sessions/records`,
          {
            ...payload,
            zoom_meeting_id: buildPendingZoomId(course_id, classNumber),
            meeting_password: "pending",
            zoom_meeting_url: "pending",
          },
          { headers: { Authorization: `Bearer ${token}` } }
        );
        linkedSessions.push(createResponse.data);
        createdCount += 1;
      }
    }

    let roadmapGenerated = null;

    if (generate_roadmap) {
      const db = await readLiveDb();
      const existingRoadmap = getRoadmapForCourse(db, course_id);
      const existingDaysByNumber = {};

      if (preserve_existing_edits && existingRoadmap?.days?.length) {
        for (const day of existingRoadmap.days) existingDaysByNumber[day.day_number] = day;
      }

      const days = desiredDates.map((date, index) => {
        const dayNumber = index + 1;
        const defaultDay = buildDefaultRoadmapDay({
          courseId: course_id,
          courseName: course_name,
          date,
          dayNumber,
          durationDays: Number(class_count),
          template: roadmap_template,
          classTime: class_time,
        });
        const previous = existingDaysByNumber[dayNumber] || {};
        const linkedSession = linkedSessions[index] || null;

        return {
          ...defaultDay,
          ...previous,
          id: previous.id || defaultDay.id,
          course_id,
          week_number: Math.ceil(dayNumber / 7),
          day_number: dayNumber,
          date,
          live_session_id: linkedSession?.id || previous.live_session_id || null,
          class_time,
          updated_at: new Date().toISOString(),
        };
      });

      const roadmap = {
        id: `roadmap:${course_id}`,
        course_id,
        course_name: course_name || existingRoadmap?.course_name || "Course",
        settings: {
          duration_days: Number(class_count),
          start_date: schedule_start_date,
          class_time,
          skip_sundays: Boolean(skip_sundays),
          template: roadmap_template,
        },
        days,
        created_at: existingRoadmap?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      setRoadmapForCourse(db, course_id, roadmap);
      await writeLiveDb(db);
      roadmapGenerated = { total_days: days.length };
    }

    return res.json({
      success: true,
      message: "Course live schedule synced successfully",
      course_id,
      total_desired_sessions: desiredDates.length,
      created: createdCount,
      updated: updatedCount,
      skipped_locked_sessions: skippedCount,
      roadmap_generated: roadmapGenerated,
      timezone: DEFAULT_TIMEZONE,
      timezone_label: "Eastern Time (EST/EDT)",
      class_time,
      skip_sundays: Boolean(skip_sundays),
    });
  } catch (error) {
    console.error("Course schedule sync error:", error.response?.data || error.message);
    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.response?.data?.error || error.message || "Failed to sync course schedule",
      details: error.response?.data || null,
    });
  }
});

app.post("/course-schedule/holiday", async (req, res) => {
  try {
    const { user, token } = await requireAdminOrInstructor(req);
    const {
      session_id,
      reason = "Tutor is unavailable today.",
      notify_students = true,
      create_replacement = true,
      skip_sundays = true,
      adjust_roadmap = true,
      shift_future_days = false,
    } = req.body;

    if (!session_id) return res.status(400).json({ success: false, error: "session_id is required" });

    const session = await fetchPocketBaseSession(session_id, token);
    if (!session?.id) return res.status(404).json({ success: false, error: "Session not found" });
    if (hasRealZoomMeetingId(session.zoom_meeting_id)) {
      return res.status(400).json({ success: false, error: "Cannot mark tutor unavailable after Zoom meeting has already been generated" });
    }
    if (session.status === "completed") {
      return res.status(400).json({ success: false, error: "Cannot mark completed session as tutor unavailable" });
    }

    await axios.patch(
      `${POCKETBASE_URL}/api/collections/live_sessions/records/${session.id}`,
      { status: "cancelled" },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    let replacementSession = null;

    if (create_replacement && session.course_id) {
      const lastSession = await getLastScheduledSessionForCourse(session.course_id, token);
      const lastDate = lastSession?.scheduled_date || session.scheduled_date || toDateString(new Date());
      const replacementDate = getNextClassDateAfter(lastDate, Boolean(skip_sundays));

      const createResponse = await axios.post(
        `${POCKETBASE_URL}/api/collections/live_sessions/records`,
        {
          topic: `${session.topic || "Class"} - Replacement`,
          instructor_name: session.instructor_name || "Admin",
          scheduled_date: replacementDate,
          scheduled_time: session.scheduled_time,
          course_id: session.course_id,
          status: "scheduled",
          zoom_meeting_id: buildPendingZoomId(session.course_id, "replacement"),
          meeting_password: "pending",
          zoom_meeting_url: "pending",
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      replacementSession = createResponse.data;
    }

    let roadmapAdjustment = null;

    if (adjust_roadmap) {
      const db = await readLiveDb();
      roadmapAdjustment = adjustRoadmapForHoliday({
        db,
        session,
        replacementSession,
        shiftFutureDays: Boolean(shift_future_days),
        createReplacement: Boolean(create_replacement),
        reason,
      });
      await writeLiveDb(db);
    }

    let announcement = null;

    if (notify_students) {
      announcement = await tryCreateAnnouncement(token, {
        title: "Class Holiday: Tutor Unavailable",
        content: `${session.topic || "Today's class"} has been cancelled because the tutor is unavailable. Reason: ${reason}`,
        course_id: session.course_id,
        type: "holiday",
      });
    }

    return res.json({
      success: true,
      message: "Session marked as tutor unavailable",
      session_id: session.id,
      replacement_session_id: replacementSession?.id || null,
      roadmap_adjustment: roadmapAdjustment,
      announcement_id: announcement?.id || null,
      updated_by: user.id,
    });
  } catch (error) {
    console.error("Holiday error:", error.response?.data || error.message);
    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error: error.response?.data?.message || error.response?.data?.error || error.message || "Failed to mark tutor unavailable",
      details: error.response?.data || null,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Demo / Plans / Coupons                                                      */
/* -------------------------------------------------------------------------- */

app.get("/demo/settings", async (req, res) => {
  try {
    const db = await readLiveDb();
    return res.json({ success: true, demo_settings: { ...DEFAULT_DEMO_SETTINGS, ...(db.demoSettings || {}) } });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Failed to load demo settings" });
  }
});

app.get("/admin/demo/settings", async (req, res) => {
  try {
    await requireAdmin(req);
    const db = await readLiveDb();
    return res.json({ success: true, demo_settings: { ...DEFAULT_DEMO_SETTINGS, ...(db.demoSettings || {}) } });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load demo settings" });
  }
});

app.patch("/admin/demo/settings", async (req, res) => {
  try {
    const { user } = await requireAdmin(req);
    const db = await readLiveDb();
    const currentSettings = { ...DEFAULT_DEMO_SETTINGS, ...(db.demoSettings || {}) };
    const allowedFields = [
      "enabled",
      "duration_days",
      "allow_live_classes",
      "allow_roadmap",
      "allow_community",
      "allow_mini_mock",
      "allow_leaderboard",
      "allow_recordings",
      "allow_notes_transcripts",
      "allow_video_library",
      "max_live_sessions",
    ];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (updates.duration_days !== undefined) updates.duration_days = Math.max(1, Number(updates.duration_days || 2));
    if (updates.max_live_sessions !== undefined) {
      updates.max_live_sessions = updates.max_live_sessions === null || updates.max_live_sessions === "" ? null : Math.max(1, Number(updates.max_live_sessions));
    }

    db.demoSettings = { ...currentSettings, ...updates, updated_by: user.id, updated_at: new Date().toISOString() };
    await writeLiveDb(db);
    return res.json({ success: true, demo_settings: db.demoSettings });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to update demo settings" });
  }
});

app.get("/features", async (req, res) => {
  try {
    const db = await readLiveDb();
    return res.json({ success: true, features: Object.values(db.featureCatalog || {}) });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Failed to load features" });
  }
});

app.get("/plans", async (req, res) => {
  try {
    const { course_id } = req.query;
    const db = await readLiveDb();
    let plans = Object.values(db.plans || {}).filter((plan) => plan.is_active !== false).map(sanitizePlan);
    if (course_id) plans = plans.filter((plan) => !plan.course_id || String(plan.course_id) === String(course_id));
    plans = plans.sort((a, b) => (a.price_cents === b.price_cents ? a.name.localeCompare(b.name) : a.price_cents - b.price_cents));
    return res.json({ success: true, count: plans.length, plans, features: Object.values(db.featureCatalog || {}) });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Failed to load plans" });
  }
});

app.get("/admin/plans", async (req, res) => {
  try {
    await requireAdmin(req);
    const db = await readLiveDb();
    return res.json({ success: true, plans: Object.values(db.plans || {}).map(sanitizePlan), features: Object.values(db.featureCatalog || {}) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load plans" });
  }
});

app.post("/admin/plans", async (req, res) => {
  try {
    const { user } = await requireAdmin(req);
    const {
      name,
      description = "",
      price_cents,
      price,
      currency = "usd",
      billing_type = "one_time",
      course_id = null,
      included_features = [],
      access_days = null,
      is_active = true,
      is_featured = false,
    } = req.body;

    if (!name || !String(name).trim()) return res.status(400).json({ success: false, error: "Plan name is required" });

    const finalPriceCents = price_cents !== undefined ? Number(price_cents) : centsFromDollars(price);
    if (Number.isNaN(finalPriceCents) || finalPriceCents < 0) return res.status(400).json({ success: false, error: "Plan price must be valid" });

    const db = await readLiveDb();
    const id = crypto.randomUUID();
    const plan = {
      id,
      name: String(name).trim(),
      description,
      price_cents: finalPriceCents,
      currency: String(currency || "usd").toLowerCase(),
      billing_type,
      course_id,
      included_features: Array.isArray(included_features) ? included_features : [],
      access_days,
      is_active: Boolean(is_active),
      is_featured: Boolean(is_featured),
      created_by: user.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    db.plans[id] = plan;
    await writeLiveDb(db);
    return res.json({ success: true, plan: sanitizePlan(plan) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to create plan" });
  }
});

app.patch("/admin/plans/:planId", async (req, res) => {
  try {
    await requireAdmin(req);
    const { planId } = req.params;
    const db = await readLiveDb();
    if (!db.plans[planId]) return res.status(404).json({ success: false, error: "Plan not found" });

    const allowedFields = ["name", "description", "price_cents", "currency", "billing_type", "course_id", "included_features", "access_days", "is_active", "is_featured"];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (updates.price_cents !== undefined) updates.price_cents = Number(updates.price_cents);
    if (updates.included_features !== undefined && !Array.isArray(updates.included_features)) updates.included_features = [];

    db.plans[planId] = { ...db.plans[planId], ...updates, updated_at: new Date().toISOString() };
    await writeLiveDb(db);
    return res.json({ success: true, plan: sanitizePlan(db.plans[planId]) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to update plan" });
  }
});

app.delete("/admin/plans/:planId", async (req, res) => {
  try {
    await requireAdmin(req);
    const { planId } = req.params;
    const db = await readLiveDb();
    if (!db.plans[planId]) return res.status(404).json({ success: false, error: "Plan not found" });
    const deletedPlan = db.plans[planId];
    delete db.plans[planId];
    await writeLiveDb(db);
    return res.json({ success: true, deleted_plan: sanitizePlan(deletedPlan), message: "Plan deleted successfully. Existing students/enrollments are not deleted." });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to delete plan" });
  }
});

app.get("/admin/coupons", async (req, res) => {
  try {
    await requireAdmin(req);
    const db = await readLiveDb();
    return res.json({ success: true, coupons: Object.values(db.coupons || {}).map(sanitizeCoupon) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load coupons" });
  }
});

app.post("/admin/coupons", async (req, res) => {
  try {
    const { user } = await requireAdmin(req);
    const { code, description = "", discount_type = "percentage", discount_value, max_uses = null, expires_at = null, course_id = null, plan_id = null, is_active = true } = req.body;
    const normalizedCode = normalizeCouponCode(code);

    if (!normalizedCode) return res.status(400).json({ success: false, error: "Coupon code is required" });
    if (!["percentage", "fixed"].includes(discount_type)) return res.status(400).json({ success: false, error: "discount_type must be percentage or fixed" });

    const numericValue = Number(discount_value);
    if (Number.isNaN(numericValue) || numericValue <= 0) return res.status(400).json({ success: false, error: "discount_value must be valid" });
    if (discount_type === "percentage" && numericValue > 100) return res.status(400).json({ success: false, error: "Percentage coupon cannot exceed 100" });

    const db = await readLiveDb();
    const existing = Object.values(db.coupons || {}).find((coupon) => coupon.code === normalizedCode);
    if (existing) return res.status(400).json({ success: false, error: "Coupon code already exists" });

    const id = crypto.randomUUID();
    const coupon = {
      id,
      code: normalizedCode,
      description,
      discount_type,
      discount_value: numericValue,
      max_uses: max_uses ? Number(max_uses) : null,
      used_count: 0,
      expires_at,
      course_id,
      plan_id,
      is_active: Boolean(is_active),
      created_by: user.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    db.coupons[id] = coupon;
    await writeLiveDb(db);
    return res.json({ success: true, coupon: sanitizeCoupon(coupon) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to create coupon" });
  }
});

app.patch("/admin/coupons/:couponId", async (req, res) => {
  try {
    await requireAdmin(req);
    const { couponId } = req.params;
    const db = await readLiveDb();
    if (!db.coupons[couponId]) return res.status(404).json({ success: false, error: "Coupon not found" });

    const allowedFields = ["description", "discount_type", "discount_value", "max_uses", "expires_at", "course_id", "plan_id", "is_active"];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (updates.discount_value !== undefined) updates.discount_value = Number(updates.discount_value);
    if (updates.max_uses !== undefined && updates.max_uses !== null) updates.max_uses = Number(updates.max_uses);

    db.coupons[couponId] = { ...db.coupons[couponId], ...updates, updated_at: new Date().toISOString() };
    await writeLiveDb(db);
    return res.json({ success: true, coupon: sanitizeCoupon(db.coupons[couponId]) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to update coupon" });
  }
});

app.delete("/admin/coupons/:couponId", async (req, res) => {
  try {
    await requireAdmin(req);
    const { couponId } = req.params;
    const db = await readLiveDb();
    if (!db.coupons[couponId]) return res.status(404).json({ success: false, error: "Coupon not found" });
    const deletedCoupon = db.coupons[couponId];
    delete db.coupons[couponId];
    await writeLiveDb(db);
    return res.json({ success: true, deleted_coupon: sanitizeCoupon(deletedCoupon), message: "Coupon deleted successfully" });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to delete coupon" });
  }
});

app.post("/coupons/validate", async (req, res) => {
  try {
    const { plan_id, coupon_code, course_id = null } = req.body;
    if (!plan_id) return res.status(400).json({ success: false, error: "plan_id is required" });

    const db = await readLiveDb();
    const plan = db.plans[plan_id];
    if (!plan || plan.is_active === false) return res.status(404).json({ success: false, error: "Plan not found or inactive" });

    const code = normalizeCouponCode(coupon_code);
    if (!code) {
      const pricing = buildCheckoutPricing({ plan, coupon: null, courseId: course_id });
      return res.json({ success: true, valid: true, coupon: null, pricing });
    }

    const coupon = Object.values(db.coupons || {}).find((item) => item.code === code);
    const validation = validateCouponForPlan({ coupon, plan, courseId: course_id });
    if (!validation.valid) return res.status(400).json({ success: false, valid: false, error: validation.error });

    const pricing = buildCheckoutPricing({ plan, coupon, courseId: course_id });
    return res.json({ success: true, valid: true, coupon: sanitizeCoupon(coupon), pricing });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to validate coupon" });
  }
});

/* -------------------------------------------------------------------------- */
/* Stripe checkout                                                             */
/* -------------------------------------------------------------------------- */

app.post("/stripe/create-checkout", async (req, res) => {
  try {
    const { user, token } = await getAuthenticatedUser(req);
    const { enrollmentId, studentId, courseId, plan_id = null, coupon_code = null, successUrl, cancelUrl, amount } = req.body;

    if (!enrollmentId || !studentId || !courseId) return res.status(400).json({ success: false, error: "enrollmentId, studentId, and courseId are required" });
    if (String(user.id) !== String(studentId) && user.role !== "admin") return res.status(403).json({ success: false, error: "Checkout user mismatch" });

    const db = await readLiveDb();
    let plan = null;

    if (plan_id) {
      plan = db.plans[plan_id];
      if (!plan || plan.is_active === false) return res.status(404).json({ success: false, error: "Plan not found or inactive" });
    } else {
      const coursePlans = Object.values(db.plans || {}).filter((item) => item.is_active !== false && (!item.course_id || String(item.course_id) === String(courseId)));
      plan = coursePlans.sort((a, b) => Number(a.price_cents || 0) - Number(b.price_cents || 0))[0] || null;
    }

    if (!plan) {
      plan = {
        id: "legacy_course_price",
        name: "NextGen USMLE Enrollment",
        description: "Legacy course checkout",
        price_cents: Math.round(Number(amount || 0) * 100),
        currency: "usd",
        billing_type: "one_time",
        course_id: courseId,
        included_features: [],
        is_active: true,
      };
    }

    const code = normalizeCouponCode(coupon_code);
    const coupon = code ? Object.values(db.coupons || {}).find((item) => item.code === code) : null;
    const pricing = buildCheckoutPricing({ plan, coupon, courseId });
    if (!pricing.valid) return res.status(400).json({ success: false, error: pricing.error });

    const finalAmountCents = pricing.final_amount_cents;

    if (finalAmountCents <= 0) {
      const accessGrant = await grantEnrollmentAccessForCheckout({ token, enrollmentId, studentId, courseId });
      const redemptionId = crypto.randomUUID();

      if (coupon?.id) {
        db.coupons[coupon.id] = { ...db.coupons[coupon.id], used_count: Number(db.coupons[coupon.id].used_count || 0) + 1, updated_at: new Date().toISOString() };
        db.couponRedemptions[redemptionId] = {
          id: redemptionId,
          coupon_id: coupon.id,
          coupon_code: coupon.code,
          plan_id: plan.id,
          enrollment_id: accessGrant.enrollment?.id || enrollmentId,
          requested_enrollment_id: enrollmentId,
          student_id: studentId,
          course_id: courseId,
          original_amount_cents: pricing.original_amount_cents,
          discount_cents: pricing.discount_cents,
          final_amount_cents: 0,
          redeemed_at: new Date().toISOString(),
        };
      }

      await writeLiveDb(db);

      return res.json({
        success: true,
        free_checkout: true,
        url: null,
        plan: sanitizePlan(plan),
        pricing,
        access_grant: { granted: true, method: accessGrant.method, enrollment_id: accessGrant.enrollment?.id || null },
        message: "Final amount is zero. Access granted without Stripe checkout.",
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: plan.currency || "usd",
            product_data: { name: plan.name || "NextGen USMLE Enrollment", description: plan.description || "Course enrollment" },
            unit_amount: finalAmountCents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        enrollmentId,
        studentId,
        courseId,
        planId: plan.id,
        couponCode: coupon?.code || "",
        originalAmountCents: String(pricing.original_amount_cents),
        discountCents: String(pricing.discount_cents),
        finalAmountCents: String(finalAmountCents),
      },
      success_url: successUrl || "https://live.nextgenusmlelms.com/payment-success",
      cancel_url: cancelUrl || "https://live.nextgenusmlelms.com/payment-cancel",
    });

    return res.json({ success: true, free_checkout: false, url: session.url, plan: sanitizePlan(plan), pricing });
  } catch (err) {
    console.error("Stripe Error:", err.response?.data || err.details || err.message);
    return res.status(err.statusCode || err.response?.status || 500).json({
      success: false,
      error: err.response?.data?.message || err.response?.data?.error || err.message || "Checkout failed",
      details: err.response?.data || err.details || null,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Roadmap engine                                                              */
/* -------------------------------------------------------------------------- */

app.post("/admin/roadmap/generate", async (req, res) => {
  try {
    const { token } = await requireAdmin(req);
    const {
      course_id,
      course_name = "Course",
      start_date,
      duration_days,
      class_time = null,
      skip_sundays = true,
      template = "usmle_step_1",
      preserve_existing_edits = true,
      link_existing_sessions = true,
      create_missing_sessions = false,
      instructor_name = "Admin",
    } = req.body;

    if (!course_id) return res.status(400).json({ success: false, error: "course_id is required" });
    if (!start_date) return res.status(400).json({ success: false, error: "start_date is required" });
    if (!duration_days || Number(duration_days) < 1) return res.status(400).json({ success: false, error: "duration_days must be at least 1" });

    const db = await readLiveDb();
    const existingRoadmap = getRoadmapForCourse(db, course_id);
    const existingDaysByNumber = {};

    if (preserve_existing_edits && existingRoadmap?.days?.length) {
      for (const day of existingRoadmap.days) existingDaysByNumber[day.day_number] = day;
    }

    let existingSessions = [];

    if (link_existing_sessions) {
      try {
        const sessionResponse = await axios.get(
          `${POCKETBASE_URL}/api/collections/live_sessions/records?perPage=500&filter=${encodeURIComponent(`course_id="${course_id}"`)}&sort=scheduled_date,scheduled_time`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        existingSessions = sessionResponse.data?.items || [];
      } catch (error) {
        console.warn("Roadmap existing session link failed:", error.response?.data || error.message);
      }
    }

    const dates = buildRoadmapDates({ startDate: start_date, durationDays: Number(duration_days), skipSundays: Boolean(skip_sundays) });
    const linkedSessions = [];

    for (let index = 0; index < dates.length; index += 1) {
      const date = dates[index];
      let linkedSession = existingSessions.find((session) => session.scheduled_date === date) || null;

      if (!linkedSession && create_missing_sessions && class_time) {
        try {
          const createResponse = await axios.post(
            `${POCKETBASE_URL}/api/collections/live_sessions/records`,
            {
              topic: `${course_name} - Class ${index + 1}`,
              instructor_name,
              scheduled_date: date,
              scheduled_time: class_time,
              course_id,
              status: "scheduled",
              zoom_meeting_id: buildPendingZoomId(course_id, index + 1),
              meeting_password: "pending",
              zoom_meeting_url: "pending",
            },
            { headers: { Authorization: `Bearer ${token}` } }
          );
          linkedSession = createResponse.data;
        } catch (error) {
          console.warn("Roadmap missing session create failed:", error.response?.data || error.message);
        }
      }

      linkedSessions.push(linkedSession);
    }

    const days = dates.map((date, index) => {
      const dayNumber = index + 1;
      const defaultDay = buildDefaultRoadmapDay({
        courseId: course_id,
        courseName: course_name,
        date,
        dayNumber,
        durationDays: Number(duration_days),
        template,
        classTime: class_time,
      });
      const previous = existingDaysByNumber[dayNumber] || {};
      const linkedSession = linkedSessions[index] || null;

      return {
        ...defaultDay,
        ...previous,
        id: previous.id || defaultDay.id,
        course_id,
        week_number: Math.ceil(dayNumber / 7),
        day_number: dayNumber,
        date,
        live_session_id: linkedSession?.id || previous.live_session_id || null,
        class_time,
        updated_at: new Date().toISOString(),
      };
    });

    const roadmap = {
      id: `roadmap:${course_id}`,
      course_id,
      course_name,
      settings: {
        duration_days: Number(duration_days),
        start_date,
        class_time,
        skip_sundays: Boolean(skip_sundays),
        template,
      },
      days,
      created_at: existingRoadmap?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    setRoadmapForCourse(db, course_id, roadmap);
    await writeLiveDb(db);

    return res.json({ success: true, roadmap: { ...roadmap, days: roadmap.days.map((day) => sanitizeRoadmapDay(day)) } });
  } catch (error) {
    console.error("Generate roadmap error:", error.response?.data || error.message);
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to generate roadmap" });
  }
});

app.get("/roadmap/course/:courseId", async (req, res) => {
  try {
    const { courseId } = req.params;
    const { preview = "false" } = req.query;
    const db = await readLiveDb();
    const roadmap = getRoadmapForCourse(db, courseId);

    if (!roadmap) {
      return res.json({ success: true, roadmap: null, days: [], summary: { total_days: 0 } });
    }

    const includePrivate = false;
    let days = (roadmap.days || []).filter((day) => day.is_published !== false);

    if (preview === "true") days = days.slice(0, 14);

    return res.json({
      success: true,
      roadmap: {
        id: roadmap.id,
        course_id: roadmap.course_id,
        course_name: roadmap.course_name,
        settings: roadmap.settings,
        created_at: roadmap.created_at,
        updated_at: roadmap.updated_at,
      },
      days: days.map((day) => sanitizeRoadmapDay(day, { includePrivate })),
      summary: {
        total_days: (roadmap.days || []).length,
        shown_days: days.length,
        total_weeks: Math.ceil((roadmap.days || []).length / 7),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || "Failed to load roadmap" });
  }
});

app.get("/admin/roadmap/course/:courseId", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const { courseId } = req.params;
    const db = await readLiveDb();
    const roadmap = getRoadmapForCourse(db, courseId);

    if (!roadmap) return res.json({ success: true, roadmap: null, days: [] });

    return res.json({ success: true, roadmap: { ...roadmap, days: roadmap.days.map((day) => sanitizeRoadmapDay(day)) } });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load admin roadmap" });
  }
});

app.patch("/admin/roadmap/day/:dayId", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const { dayId } = req.params;
    const { course_id } = req.body;

    if (!course_id) return res.status(400).json({ success: false, error: "course_id is required" });

    const db = await readLiveDb();
    const roadmap = getRoadmapForCourse(db, course_id);
    if (!roadmap) return res.status(404).json({ success: false, error: "Roadmap not found" });

    const index = roadmap.days.findIndex((day) => String(day.id) === String(dayId));
    if (index < 0) return res.status(404).json({ success: false, error: "Roadmap day not found" });

    const allowedFields = [
      "date",
      "title",
      "description",
      "subtopics",
      "resources",
      "resource_links",
      "uworld_target",
      "first_aid_topics",
      "homework",
      "mini_mock_title",
      "live_session_id",
      "recording_meeting_id",
      "class_time",
      "status",
      "is_locked",
      "is_published",
      "admin_notes",
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (updates.subtopics !== undefined) updates.subtopics = normalizeArray(updates.subtopics);
    if (updates.resources !== undefined) updates.resources = normalizeArray(updates.resources);
    if (updates.resource_links !== undefined) updates.resource_links = normalizeArray(updates.resource_links);

    roadmap.days[index] = {
      ...roadmap.days[index],
      ...updates,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    };
    roadmap.updated_at = new Date().toISOString();

    setRoadmapForCourse(db, course_id, roadmap);
    await writeLiveDb(db);

    return res.json({ success: true, day: sanitizeRoadmapDay(roadmap.days[index]) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to update roadmap day" });
  }
});

app.post("/admin/roadmap/reorder", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const { course_id, ordered_day_ids } = req.body;
    if (!course_id || !Array.isArray(ordered_day_ids)) return res.status(400).json({ success: false, error: "course_id and ordered_day_ids are required" });

    const db = await readLiveDb();
    const roadmap = getRoadmapForCourse(db, course_id);
    if (!roadmap) return res.status(404).json({ success: false, error: "Roadmap not found" });

    const byId = {};
    for (const day of roadmap.days) byId[day.id] = day;

    const reordered = ordered_day_ids.map((id) => byId[id]).filter(Boolean);
    const missing = roadmap.days.filter((day) => !ordered_day_ids.includes(day.id));
    roadmap.days = [...reordered, ...missing].map((day, index) => ({
      ...day,
      day_number: index + 1,
      week_number: Math.ceil((index + 1) / 7),
      updated_at: new Date().toISOString(),
    }));
    roadmap.updated_at = new Date().toISOString();

    setRoadmapForCourse(db, course_id, roadmap);
    await writeLiveDb(db);

    return res.json({ success: true, days: roadmap.days.map((day) => sanitizeRoadmapDay(day)) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to reorder roadmap" });
  }
});

app.post("/roadmap/progress/mark", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id, day_id, task_key = "day", completed = true, completed_tasks = {}, notes = "" } = req.body;

    if (!course_id || !day_id) return res.status(400).json({ success: false, error: "course_id and day_id are required" });

    const db = await readLiveDb();
    const roadmap = getRoadmapForCourse(db, course_id);
    if (!roadmap) return res.status(404).json({ success: false, error: "Roadmap not found" });

    const day = roadmap.days.find((item) => String(item.id) === String(day_id));
    if (!day) return res.status(404).json({ success: false, error: "Roadmap day not found" });

    const key = buildRoadmapProgressKey(course_id, user.id, day_id);
    const previous = db.roadmapProgress[key] || {};

    db.roadmapProgress[key] = {
      ...previous,
      id: key,
      course_id,
      user_id: user.id,
      user_name: user.name || user.username || user.email || "Student",
      day_id,
      day_number: day.day_number,
      completed: Boolean(completed),
      completed_at: completed ? new Date().toISOString() : null,
      completed_tasks: {
        ...(previous.completed_tasks || {}),
        ...completed_tasks,
        [task_key]: Boolean(completed),
      },
      notes,
      updated_at: new Date().toISOString(),
    };

    const leaderboard = updateLeaderboardForUser(db, {
      courseId: course_id,
      userId: user.id,
      userName: user.name || user.username || user.email || "Student",
    });

    await writeLiveDb(db);

    return res.json({
      success: true,
      progress: db.roadmapProgress[key],
      summary: buildProgressSummary({ db, courseId: course_id, userId: user.id }),
      leaderboard,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to mark roadmap progress" });
  }
});

app.get("/roadmap/progress/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id } = req.query;
    if (!course_id) return res.status(400).json({ success: false, error: "course_id is required" });

    const db = await readLiveDb();
    const summary = buildProgressSummary({ db, courseId: course_id, userId: user.id });
    const items = Object.values(db.roadmapProgress || {}).filter((item) => String(item.course_id) === String(course_id) && String(item.user_id) === String(user.id));

    return res.json({ success: true, summary, progress_items: items });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load roadmap progress" });
  }
});

/* -------------------------------------------------------------------------- */
/* Reports / dashboard summary                                                 */
/* -------------------------------------------------------------------------- */

app.get("/student/report/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id } = req.query;
    if (!course_id) return res.status(400).json({ success: false, error: "course_id is required" });

    const db = await readLiveDb();
    const roadmap = buildProgressSummary({ db, courseId: course_id, userId: user.id });
    const attempts = getStudentAttempts(db, course_id, user.id);
    const performance = calculatePerformanceFromAttempts(attempts);
    const attendance = Object.values(db.attendance || {}).filter((item) => String(item.course_id) === String(course_id) && String(item.user_id) === String(user.id));
    const streak = db.streaks[buildCourseUserKey(course_id, user.id)] || null;
    const leaderboard = updateLeaderboardForUser(db, { courseId: course_id, userId: user.id, userName: user.name || user.email || "Student" });
    await writeLiveDb(db);

    return res.json({
      success: true,
      report: {
        user_id: user.id,
        user_name: user.name || user.email,
        course_id,
        roadmap,
        attendance: {
          attended_sessions: new Set(attendance.map((item) => item.session_id)).size,
          records: attendance.length,
        },
        streak: {
          current_streak: streak?.current_streak || 0,
          total_attended: streak?.total_attended || 0,
        },
        performance,
        leaderboard,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load student report" });
  }
});

app.get("/student/dashboard/summary", async (req, res) => {
  try {
    const { user, token } = await getAuthenticatedUser(req);
    const { course_id } = req.query;
    if (!course_id) return res.status(400).json({ success: false, error: "course_id is required" });

    const db = await readLiveDb();
    const enrollment = await getEnrollmentForCourse({ userId: user.id, courseId: course_id, token });
    const roadmap = buildProgressSummary({ db, courseId: course_id, userId: user.id });
    const attempts = getStudentAttempts(db, course_id, user.id);
    const performance = calculatePerformanceFromAttempts(attempts);
    const leaderboard = updateLeaderboardForUser(db, { courseId: course_id, userId: user.id, userName: user.name || user.email || "Student" });
    const leaderboardList = Object.values(db.leaderboard || {})
      .filter((item) => String(item.course_id) === String(course_id))
      .sort((a, b) => Number(b.total_points || 0) - Number(a.total_points || 0));
    const rankIndex = leaderboardList.findIndex((item) => String(item.user_id) === String(user.id));
    const streak = db.streaks[buildCourseUserKey(course_id, user.id)] || null;

    let plan = {
      name: enrollment?.is_demo ? "Demo" : enrollment ? "Active" : "No active plan",
      days_left: null,
      is_demo: Boolean(enrollment?.is_demo),
    };

    if (enrollment?.is_demo && enrollment.demo_expiry) {
      const diffMs = new Date(`${enrollment.demo_expiry}T23:59:59`).getTime() - Date.now();
      plan.days_left = Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
    }

    await writeLiveDb(db);

    return res.json({
      success: true,
      plan,
      roadmap,
      today: roadmap.today_day,
      performance: {
        study_streak: streak?.current_streak || 0,
        best_streak: streak?.current_streak || 0,
        total_study_time_hours: 0,
        average_mock_score: performance.average_score,
        latest_mock_score: performance.latest_score,
        best_mock_score: performance.best_score,
        attempts_count: performance.attempts_count,
      },
      focus_areas: performance.focus_areas,
      leaderboard: {
        rank: rankIndex >= 0 ? rankIndex + 1 : null,
        points: leaderboard.total_points || 0,
        attendance_points: leaderboard.attendance_points || 0,
        task_points: leaderboard.task_points || 0,
        quiz_points: leaderboard.quiz_points || 0,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load dashboard summary" });
  }
});

app.get("/admin/reports/course/:courseId", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const { courseId } = req.params;
    const db = await readLiveDb();
    const userIds = new Set();

    for (const item of Object.values(db.attendance || {})) {
      if (String(item.course_id) === String(courseId)) userIds.add(item.user_id);
    }
    for (const item of Object.values(db.roadmapProgress || {})) {
      if (String(item.course_id) === String(courseId)) userIds.add(item.user_id);
    }
    for (const item of Object.values(db.leaderboard || {})) {
      if (String(item.course_id) === String(courseId)) userIds.add(item.user_id);
    }

    const reports = [...userIds].map((userId) => {
      const leaderboard = db.leaderboard[buildLeaderboardKey(courseId, userId)] || {};
      const attempts = getStudentAttempts(db, courseId, userId);
      const performance = calculatePerformanceFromAttempts(attempts);
      const roadmap = buildProgressSummary({ db, courseId, userId });
      const attendance = Object.values(db.attendance || {}).filter((item) => String(item.course_id) === String(courseId) && String(item.user_id) === String(userId));

      return {
        user_id: userId,
        user_name: leaderboard.user_name || attendance[0]?.user_name || "Student",
        roadmap_progress_percentage: roadmap.progress_percentage,
        completed_days: roadmap.completed_days,
        remaining_days: roadmap.remaining_days,
        attended_sessions: new Set(attendance.map((item) => item.session_id)).size,
        average_score: performance.average_score,
        latest_score: performance.latest_score,
        attempts_count: performance.attempts_count,
        total_points: leaderboard.total_points || 0,
        attendance_points: leaderboard.attendance_points || 0,
        task_points: leaderboard.task_points || 0,
        quiz_points: leaderboard.quiz_points || 0,
      };
    });

    reports.sort((a, b) => Number(b.total_points || 0) - Number(a.total_points || 0));

    return res.json({ success: true, course_id: courseId, count: reports.length, reports });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load course report" });
  }
});

/* -------------------------------------------------------------------------- */
/* Zoom endpoints                                                              */
/* -------------------------------------------------------------------------- */

app.get("/zoom/zak", async (req, res) => {
  try {
    const accessToken = await getZoomAccessToken();
    const response = await axios.get("https://api.zoom.us/v2/users/me/token?type=zak", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    res.json({ zak: response.data.token });
  } catch (error) {
    console.error("ZAK Error:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.post("/zoom/create-meeting", async (req, res) => {
  try {
    const { topic, start_time, duration = DEFAULT_ZOOM_DURATION_MINUTES, timezone = DEFAULT_TIMEZONE } = req.body;
    const accessToken = await getZoomAccessToken();
    const response = await axios.post(
      "https://api.zoom.us/v2/users/me/meetings",
      {
        topic,
        type: 2,
        start_time,
        duration,
        timezone,
        settings: {
          host_video: true,
          participant_video: true,
          join_before_host: false,
          waiting_room: true,
          auto_recording: "cloud",
        },
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    res.json({ success: true, meeting: response.data });
  } catch (error) {
    console.error("Zoom Error:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

app.post("/zoom/generate-signature", async (req, res) => {
  try {
    const { meetingNumber, role } = req.body;
    const iat = Math.round(new Date().getTime() / 1000) - 30;
    const exp = iat + 60 * 60 * 2;
    const payload = {
      sdkKey: process.env.ZOOM_MEETING_SDK_KEY,
      mn: meetingNumber,
      role,
      iat,
      exp,
      appKey: process.env.ZOOM_MEETING_SDK_KEY,
      tokenExp: exp,
    };
    const signature = jwt.sign(payload, process.env.ZOOM_MEETING_SDK_SECRET, { algorithm: "HS256" });
    res.json({ signature });
  } catch (error) {
    console.error("Signature Error:", error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post("/zoom/webhook", async (req, res) => {
  try {
    const event = req.body.event;
    console.log("Zoom webhook received:", event);

    if (event === "endpoint.url_validation") {
      const plainToken = req.body.payload.plainToken;
      const encryptedToken = crypto.createHmac("sha256", process.env.ZOOM_WEBHOOK_SECRET_TOKEN).update(plainToken).digest("hex");
      return res.status(200).json({ plainToken, encryptedToken });
    }

    if (event === "recording.completed") {
      const recordingObject = req.body.payload.object;
      const recordingFiles = recordingObject.recording_files || [];
      const videoFile = recordingFiles.find((file) => file.file_type === "MP4") || recordingFiles[0];
      const recordingPayload = {
        meeting_id: String(recordingObject.id),
        uuid: recordingObject.uuid,
        topic: recordingObject.topic,
        start_time: recordingObject.start_time,
        duration: recordingObject.duration,
        share_url: recordingObject.share_url || null,
        recording_url: videoFile?.play_url || recordingObject.share_url || videoFile?.download_url || null,
        download_url: videoFile?.download_url || null,
        file_type: videoFile?.file_type || null,
        recording_type: videoFile?.recording_type || null,
        status: videoFile?.status || null,
        published: false,
        received_at: new Date().toISOString(),
      };

      const db = await readLiveDb();
      db.recordings[recordingPayload.meeting_id] = { ...(db.recordings[recordingPayload.meeting_id] || {}), ...recordingPayload };
      await writeLiveDb(db);
      return res.status(200).json({ received: true, saved: true, note: "Recording metadata saved. Actual video remains on Zoom Cloud." });
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Zoom webhook error:", error.response?.data || error.message);
    return res.status(200).json({ success: false, error: error.response?.data || error.message });
  }
});

app.get("/zoom/recordings", async (req, res) => {
  try {
    const accessToken = await getZoomAccessToken();
    const today = new Date();
    const to = today.toISOString().slice(0, 10);
    const fromDate = new Date();
    fromDate.setDate(today.getDate() - 30);
    const from = fromDate.toISOString().slice(0, 10);

    const response = await axios.get(`https://api.zoom.us/v2/users/me/recordings?from=${from}&to=${to}&page_size=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const db = await readLiveDb();
    const meetings = response.data?.meetings || [];
    const recordings = meetings.flatMap((meeting) => {
      const files = meeting.recording_files || [];
      return files
        .filter((file) => file.file_type === "MP4")
        .map((file) => {
          const meetingId = String(meeting.id);
          const saved = db.recordings[meetingId] || {};
          return {
            meeting_id: meetingId,
            uuid: meeting.uuid,
            topic: meeting.topic,
            start_time: meeting.start_time,
            duration: meeting.duration,
            share_url: meeting.share_url,
            recording_url: file.play_url || meeting.share_url || file.download_url,
            download_url: file.download_url,
            file_type: file.file_type,
            recording_type: file.recording_type,
            status: file.status,
            published: Boolean(saved.published),
            session_id: saved.session_id || null,
            course_id: saved.course_id || null,
          };
        });
    });

    return res.json({ success: true, from, to, count: recordings.length, recordings });
  } catch (error) {
    console.error("Zoom recordings fetch error:", error.response?.data || error.message);
    return res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

/* -------------------------------------------------------------------------- */
/* Recording publish / unpublish                                                */
/* -------------------------------------------------------------------------- */

app.post("/live/recordings/publish", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const { meeting_id, session_id = null, course_id = null, topic = null, recording_url = null, share_url = null, published = true } = req.body;
    if (!meeting_id) return res.status(400).json({ success: false, error: "meeting_id is required" });

    const db = await readLiveDb();
    const key = String(meeting_id);
    db.recordings[key] = {
      ...(db.recordings[key] || {}),
      meeting_id: key,
      session_id,
      course_id,
      topic,
      recording_url,
      share_url,
      published: Boolean(published),
      published_at: Boolean(published) ? new Date().toISOString() : null,
      published_by: user.id,
    };
    await writeLiveDb(db);
    return res.json({ success: true, recording: db.recordings[key] });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to publish recording" });
  }
});

app.post("/live/recordings/unpublish", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const { meeting_id } = req.body;
    if (!meeting_id) return res.status(400).json({ success: false, error: "meeting_id is required" });

    const db = await readLiveDb();
    const key = String(meeting_id);
    db.recordings[key] = {
      ...(db.recordings[key] || {}),
      meeting_id: key,
      published: false,
      unpublished_at: new Date().toISOString(),
      unpublished_by: user.id,
    };
    await writeLiveDb(db);
    return res.json({ success: true, recording: db.recordings[key] });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to unpublish recording" });
  }
});

app.get("/live/recordings/published", async (req, res) => {
  try {
    const { user, token } = await getAuthenticatedUser(req);
    const { course_id } = req.query;
    const db = await readLiveDb();

    if (course_id) {
      const enrollment = await getEnrollmentForCourse({ userId: user.id, courseId: course_id, token });
      if (enrollment?.is_demo && !db.demoSettings?.allow_recordings) {
        return res.json({ success: true, user_id: user.id, count: 0, recordings: [], demo_restricted: true });
      }
    }

    let recordings = Object.values(db.recordings || {}).filter((recording) => Boolean(recording.published));
    if (course_id) recordings = recordings.filter((recording) => String(recording.course_id || "") === String(course_id));
    recordings = recordings.map(sanitizePublicRecording);

    return res.json({ success: true, user_id: user.id, count: recordings.length, recordings });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load published recordings" });
  }
});

/* -------------------------------------------------------------------------- */
/* Attendance / streaks / leaderboard / community / quiz / notes               */
/* -------------------------------------------------------------------------- */

app.post("/live/attendance/mark", async (req, res) => {
  try {
    const { user, token } = await getAuthenticatedUser(req);
    const { session_id, course_id: bodyCourseId = null, source = "classroom_opened" } = req.body;
    if (!session_id) return res.status(400).json({ success: false, error: "session_id is required" });

    let courseId = bodyCourseId;
    try {
      const session = await fetchPocketBaseSession(session_id, token);
      courseId = courseId || session.course_id || null;
    } catch {
      // ok if body course_id exists
    }

    if (!courseId) return res.status(400).json({ success: false, error: "course_id is required when session cannot provide course_id" });

    const db = await readLiveDb();
    const key = buildUserSessionKey(user.id, session_id);
    const today = getTodayKey();

    db.attendance[key] = {
      id: key,
      user_id: user.id,
      user_name: user.name || user.username || user.email || "Student",
      session_id,
      course_id: courseId,
      date: today,
      source,
      marked_at: new Date().toISOString(),
    };

    const userAttendanceForCourse = Object.values(db.attendance).filter((item) => item.user_id === user.id && item.course_id === courseId);
    const streak = calculateStreakFromAttendance(userAttendanceForCourse);
    const streakKey = buildCourseUserKey(courseId, user.id);
    db.streaks[streakKey] = {
      course_id: courseId,
      user_id: user.id,
      current_streak: streak,
      total_attended: userAttendanceForCourse.length,
      updated_at: new Date().toISOString(),
    };

    const progressKey = buildCourseUserKey(courseId, user.id);
    const attendedSessions = new Set(userAttendanceForCourse.map((item) => item.session_id));
    db.courseProgress[progressKey] = {
      course_id: courseId,
      user_id: user.id,
      attended_sessions: attendedSessions.size,
      last_session_id: session_id,
      last_attended_at: new Date().toISOString(),
    };

    const leaderboard = updateLeaderboardForUser(db, { courseId, userId: user.id, userName: user.name || user.email || "Student" });
    await writeLiveDb(db);

    return res.json({ success: true, attendance: db.attendance[key], streak: db.streaks[streakKey], progress: db.courseProgress[progressKey], leaderboard });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to mark attendance" });
  }
});

app.get("/live/attendance/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id } = req.query;
    const db = await readLiveDb();
    let attendance = Object.values(db.attendance).filter((item) => item.user_id === user.id);
    if (course_id) attendance = attendance.filter((item) => String(item.course_id) === String(course_id));
    return res.json({ success: true, count: attendance.length, attendance });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load attendance" });
  }
});

app.get("/live/streaks/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id } = req.query;
    const db = await readLiveDb();
    let streaks = Object.values(db.streaks).filter((item) => item.user_id === user.id);
    if (course_id) streaks = streaks.filter((item) => String(item.course_id) === String(course_id));
    return res.json({ success: true, count: streaks.length, streaks });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load streaks" });
  }
});

app.get("/live/progress/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id } = req.query;
    const db = await readLiveDb();
    let progress = Object.values(db.courseProgress).filter((item) => item.user_id === user.id);
    if (course_id) progress = progress.filter((item) => String(item.course_id) === String(course_id));
    return res.json({ success: true, count: progress.length, progress });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load progress" });
  }
});

app.get("/live/leaderboard", async (req, res) => {
  try {
    await getAuthenticatedUser(req);
    const { course_id } = req.query;
    const db = await readLiveDb();
    let leaderboard = Object.values(db.leaderboard || {});
    if (course_id) leaderboard = leaderboard.filter((item) => String(item.course_id) === String(course_id));
    leaderboard = leaderboard
      .map((item) => ({ ...item, total_points: Number(item.attendance_points || 0) + Number(item.task_points || 0) + Number(item.quiz_points || 0) }))
      .sort((a, b) => b.total_points - a.total_points)
      .slice(0, 50)
      .map((item, index) => ({ rank: index + 1, ...item }));
    return res.json({ success: true, count: leaderboard.length, leaderboard });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load leaderboard" });
  }
});

app.get("/live/community/:sessionId", async (req, res) => {
  try {
    await getAuthenticatedUser(req);
    const { sessionId } = req.params;
    const db = await readLiveDb();
    const messages = db.communityMessages[sessionId] || [];
    return res.json({ success: true, session_id: sessionId, count: messages.length, messages });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load community messages" });
  }
});

app.post("/live/community/:sessionId", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { sessionId } = req.params;
    const { message, course_id = null } = req.body;
    if (!message || !String(message).trim()) return res.status(400).json({ success: false, error: "message is required" });

    const db = await readLiveDb();
    const item = {
      id: crypto.randomUUID(),
      session_id: sessionId,
      course_id,
      user_id: user.id,
      user_name: user.name || user.username || user.email || "Student",
      message: String(message).trim().slice(0, 2000),
      created_at: new Date().toISOString(),
    };
    db.communityMessages[sessionId] = [...(db.communityMessages[sessionId] || []), item];
    await writeLiveDb(db);
    return res.json({ success: true, message: item });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to post community message" });
  }
});

app.post("/live/quiz/attempt", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { session_id, course_id, quiz_id = "session-mini-mock", topic = "General", subject = null, score, total, answers = null } = req.body;
    if (!session_id || !course_id) return res.status(400).json({ success: false, error: "session_id and course_id are required" });
    if (score === undefined || total === undefined) return res.status(400).json({ success: false, error: "score and total are required" });

    const numericScore = Number(score);
    const numericTotal = Number(total);
    if (Number.isNaN(numericScore) || Number.isNaN(numericTotal) || numericTotal <= 0) return res.status(400).json({ success: false, error: "score and total must be valid numbers" });

    const db = await readLiveDb();
    const attempt = {
      id: crypto.randomUUID(),
      user_id: user.id,
      user_name: user.name || user.username || user.email || "Student",
      session_id,
      course_id,
      quiz_id,
      topic,
      subject,
      score: numericScore,
      total: numericTotal,
      percentage: Math.round((numericScore / numericTotal) * 100),
      answers,
      created_at: new Date().toISOString(),
    };

    const attemptKey = buildCourseUserKey(course_id, user.id);
    db.quizAttempts[attemptKey] = [...(db.quizAttempts[attemptKey] || []), attempt];
    const leaderboard = updateLeaderboardForUser(db, { courseId: course_id, userId: user.id, userName: user.name || user.email || "Student" });
    await writeLiveDb(db);
    return res.json({ success: true, attempt, leaderboard });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to save quiz attempt" });
  }
});

app.get("/live/quiz/attempts/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id } = req.query;
    const db = await readLiveDb();
    let attempts = [];
    for (const item of Object.values(db.quizAttempts || {})) attempts = attempts.concat(item || []);
    attempts = attempts.filter((item) => item.user_id === user.id);
    if (course_id) attempts = attempts.filter((item) => String(item.course_id) === String(course_id));
    return res.json({ success: true, count: attempts.length, attempts });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load quiz attempts" });
  }
});

app.post("/live/notes/:sessionId", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const { sessionId } = req.params;
    const { course_id = null, notes = "", transcript_url = null } = req.body;
    const db = await readLiveDb();
    db.notes[sessionId] = {
      session_id: sessionId,
      course_id,
      notes: String(notes || ""),
      transcript_url,
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    };
    await writeLiveDb(db);
    return res.json({ success: true, notes: db.notes[sessionId] });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to save notes" });
  }
});

app.get("/live/notes/:sessionId", async (req, res) => {
  try {
    const { user, token } = await getAuthenticatedUser(req);
    const { sessionId } = req.params;
    const db = await readLiveDb();
    const notes = db.notes[sessionId] || null;

    if (notes?.course_id) {
      const enrollment = await getEnrollmentForCourse({ userId: user.id, courseId: notes.course_id, token });
      if (enrollment?.is_demo && !db.demoSettings?.allow_notes_transcripts) {
        return res.json({ success: true, notes: null, demo_restricted: true });
      }
    }

    return res.json({ success: true, notes });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load notes" });
  }
});

/* -------------------------------------------------------------------------- */
/* Debug route                                                                 */
/* -------------------------------------------------------------------------- */

app.get("/live/debug/storage", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    if (user.role !== "admin") return res.status(403).json({ success: false, error: "Only admins can view storage debug" });

    const db = await readLiveDb();
    return res.json({
      success: true,
      data_dir: DATA_DIR,
      live_db_path: LIVE_DB_PATH,
      counts: {
        recordings: Object.keys(db.recordings || {}).length,
        attendance: Object.keys(db.attendance || {}).length,
        streaks: Object.keys(db.streaks || {}).length,
        courseProgress: Object.keys(db.courseProgress || {}).length,
        leaderboard: Object.keys(db.leaderboard || {}).length,
        communitySessions: Object.keys(db.communityMessages || {}).length,
        quizAttemptUsers: Object.keys(db.quizAttempts || {}).length,
        notes: Object.keys(db.notes || {}).length,
        plans: Object.keys(db.plans || {}).length,
        coupons: Object.keys(db.coupons || {}).length,
        couponRedemptions: Object.keys(db.couponRedemptions || {}).length,
        features: Object.keys(db.featureCatalog || {}).length,
        demoSettings: db.demoSettings ? 1 : 0,
        googleAuthUsers: Object.keys(db.googleAuthUsers || {}).length,
        roadmaps: Object.keys(db.roadmaps || {}).length,
        roadmapProgress: Object.keys(db.roadmapProgress || {}).length,
      },
      updatedAt: db.updatedAt || null,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load storage debug" });
  }
});

/* -------------------------------------------------------------------------- */
/* Start server                                                                */
/* -------------------------------------------------------------------------- */

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`LIVE_DB_PATH=${LIVE_DB_PATH}`);
});
