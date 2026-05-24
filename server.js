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
/* Render persistent JSON storage                                              */
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
    description: "Access to attendance and quiz leaderboard",
    is_active: true,
    free_for_all: false,
  },
  roadmap: {
    key: "roadmap",
    name: "Roadmap",
    description: "Access to course roadmap",
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
      featureCatalog: {
        ...DEFAULT_FEATURE_CATALOG,
        ...(parsed.featureCatalog || {}),
      },
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ...DEFAULT_LIVE_DB };
    }

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
      updatedAt: new Date().toISOString(),
    };

    const tempPath = `${LIVE_DB_PATH}.tmp`;

    await fs.writeFile(tempPath, JSON.stringify(nextDb, null, 2), "utf8");
    await fs.rename(tempPath, LIVE_DB_PATH);
  });

  return writeQueue;
}

function getTodayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
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

    if (diffDays === 1) {
      streak += 1;
    } else if (diffDays > 1) {
      break;
    }
  }

  return streak;
}

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

function normalizeCouponCode(code) {
  return String(code || "").trim().toUpperCase();
}

function centsFromDollars(value) {
  const number = Number(value || 0);
  if (Number.isNaN(number)) return 0;
  return Math.max(0, Math.round(number * 100));
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
    included_features: Array.isArray(plan.included_features)
      ? plan.included_features
      : [],
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

  if (coupon.discount_type === "fixed") {
    return Math.min(price, centsFromDollars(value));
  }

  return 0;
}

function validateCouponForPlan({ coupon, plan, courseId }) {
  if (!coupon) {
    return {
      valid: false,
      error: "Coupon not found",
    };
  }

  if (coupon.is_active === false) {
    return {
      valid: false,
      error: "Coupon is inactive",
    };
  }

  if (isCouponExpired(coupon)) {
    return {
      valid: false,
      error: "Coupon has expired",
    };
  }

  if (coupon.max_uses && Number(coupon.used_count || 0) >= Number(coupon.max_uses)) {
    return {
      valid: false,
      error: "Coupon usage limit reached",
    };
  }

  if (coupon.plan_id && String(coupon.plan_id) !== String(plan.id)) {
    return {
      valid: false,
      error: "Coupon is not valid for this plan",
    };
  }

  if (coupon.course_id && String(coupon.course_id) !== String(courseId || plan.course_id || "")) {
    return {
      valid: false,
      error: "Coupon is not valid for this course",
    };
  }

  return {
    valid: true,
    error: null,
  };
}

function buildCheckoutPricing({ plan, coupon, courseId }) {
  const originalAmountCents = Number(plan.price_cents || 0);

  const couponValidation = coupon
    ? validateCouponForPlan({ coupon, plan, courseId })
    : { valid: true, error: null };

  if (!couponValidation.valid) {
    return {
      valid: false,
      error: couponValidation.error,
    };
  }

  const discountCents = coupon
    ? calculateDiscountCents(originalAmountCents, coupon)
    : 0;

  const finalAmountCents = Math.max(0, originalAmountCents - discountCents);

  return {
    valid: true,
    original_amount_cents: originalAmountCents,
    discount_cents: discountCents,
    final_amount_cents: finalAmountCents,
    coupon_code: coupon?.code || null,
  };
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
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
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

function getSessionStartUtc(
  scheduledDate,
  scheduledTime,
  timezone = DEFAULT_TIMEZONE
) {
  if (!scheduledDate || !scheduledTime) {
    return null;
  }

  const dateStr = String(scheduledDate).split(" ")[0];
  const timeStr = String(scheduledTime).trim();

  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);

  if (!year || !month || !day || Number.isNaN(hour) || Number.isNaN(minute)) {
    return null;
  }

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = getTimezoneOffsetMs(timezone, utcGuess);

  return new Date(utcGuess.getTime() - offset);
}

function toDateString(date) {
  return date.toISOString().split("T")[0];
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function buildClassDates({ startDate, classCount, skipSundays }) {
  const dates = [];

  if (!startDate || !classCount) {
    return dates;
  }

  let cursor = new Date(`${startDate}T00:00:00`);

  while (dates.length < Number(classCount)) {
    const isSunday = cursor.getDay() === 0;

    if (!(skipSundays && isSunday)) {
      dates.push(toDateString(cursor));
    }

    cursor = addDays(cursor, 1);
  }

  return dates;
}

function getNextClassDateAfter(dateString, skipSundays = true) {
  let cursor = addDays(new Date(`${dateString}T00:00:00`), 1);

  while (skipSundays && cursor.getDay() === 0) {
    cursor = addDays(cursor, 1);
  }

  return toDateString(cursor);
}

/* -------------------------------------------------------------------------- */
/* Auth / external helpers                                                     */
/* -------------------------------------------------------------------------- */

function isAdminOrInstructor(user, session) {
  return (
    user?.role === "admin" ||
    user?.role === "instructor" ||
    session?.instructor_id === user?.id
  );
}

function isSessionLocked(session) {
  return (
    session.status === "completed" ||
    session.status === "cancelled" ||
    hasRealZoomMeetingId(session.zoom_meeting_id)
  );
}

async function getPocketBaseUserFromToken(token) {
  const userRefresh = await axios.post(
    `${POCKETBASE_URL}/api/collections/users/auth-refresh`,
    {},
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
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

async function getZoomAccessToken() {
  const response = await axios.post(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${process.env.ZOOM_ACCOUNT_ID}`,
    {},
    {
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`
          ).toString("base64"),
      },
    }
  );

  return response.data.access_token;
}

async function createZoomMeetingForLiveSession(session, timezone = DEFAULT_TIMEZONE) {
  const accessToken = await getZoomAccessToken();

  const sessionStartUtc = getSessionStartUtc(
    session.scheduled_date,
    session.scheduled_time,
    timezone
  );

  if (!sessionStartUtc) {
    throw new Error("Session scheduled date/time is invalid");
  }

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
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  return response.data;
}

async function getLastScheduledSessionForCourse(courseId, token) {
  const response = await axios.get(
    `${POCKETBASE_URL}/api/collections/live_sessions/records?perPage=1&filter=${encodeURIComponent(
      `course_id="${courseId}"`
    )}&sort=-scheduled_date,-scheduled_time`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return response.data?.items?.[0] || null;
}

async function tryCreateAnnouncement(token, payload) {
  try {
    const response = await axios.post(
      `${POCKETBASE_URL}/api/collections/announcements/records`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    return response.data;
  } catch (firstError) {
    console.warn(
      "Announcement create failed. Retrying with title/content only:",
      firstError.response?.data || firstError.message
    );

    try {
      const response = await axios.post(
        `${POCKETBASE_URL}/api/collections/announcements/records`,
        {
          title: payload.title,
          content: payload.content,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      return response.data;
    } catch (secondError) {
      console.warn(
        "Announcement fallback failed:",
        secondError.response?.data || secondError.message
      );

      return null;
    }
  }
}

async function fetchPocketBaseSession(sessionId, token) {
  const response = await axios.get(
    `${POCKETBASE_URL}/api/collections/live_sessions/records/${sessionId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return response.data;
}

/* -------------------------------------------------------------------------- */
/* Basic routes                                                                */
/* -------------------------------------------------------------------------- */

app.get("/", (req, res) => {
  res.send("NextGen Backend Running");
});

app.get("/health", async (req, res) => {
  const liveDbExists = await fs
    .access(LIVE_DB_PATH)
    .then(() => true)
    .catch(() => false);

  res.json({
    success: true,
    message: "Backend running",
    data_dir: DATA_DIR,
    live_db_path: LIVE_DB_PATH,
    live_db_exists: liveDbExists,
  });
});

/* -------------------------------------------------------------------------- */
/* Live classroom access                                                       */
/* -------------------------------------------------------------------------- */

app.get("/hcgi/api/live-class/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!sessionId) {
      return res.status(400).json({
        allowed: false,
        error: "sessionId is required",
      });
    }

    const { user, token } = await getAuthenticatedUser(req);
    const userId = user.id;

    let session = await fetchPocketBaseSession(sessionId, token);

    if (!session?.id) {
      return res.status(404).json({
        allowed: false,
        error: "Session not found",
      });
    }

    const courseId = session.course_id;

    if (!courseId) {
      return res.status(400).json({
        allowed: false,
        error: "Session missing course_id",
      });
    }

    let allowed = false;
    let reason = "You don't have access to this session";

    if (user.role === "admin") {
      allowed = true;
    } else if (user.role === "instructor" || session.instructor_id === userId) {
      allowed = true;
    } else {
      try {
        const filter = encodeURIComponent(
          `user_id="${userId}" && course_id="${courseId}" && access_granted=true`
        );

        const enrollmentResponse = await axios.get(
          `${POCKETBASE_URL}/api/collections/enrollments/records?filter=${filter}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (enrollmentResponse.data?.items?.length > 0) {
          allowed = true;
        }
      } catch {
        allowed = false;
      }
    }

    if (!allowed) {
      return res.json({
        allowed: false,
        reason,
      });
    }

    if (session.status === "cancelled") {
      return res.json({
        allowed: true,
        can_join: false,
        join_reason:
          "Tutor is unavailable today, or this session has been cancelled.",
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

    const sessionStartUtc = getSessionStartUtc(
      session.scheduled_date,
      session.scheduled_time,
      DEFAULT_TIMEZONE
    );

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

      if (!canJoin) {
        joinReason = "Classroom opens 1 minute before class starts";
      }
    }

    const userCanGenerateZoom = isAdminOrInstructor(user, session);

    if (
      canJoin &&
      !hasRealZoomMeetingId(session.zoom_meeting_id) &&
      session.status !== "completed" &&
      session.status !== "cancelled"
    ) {
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

      console.log("Generating Zoom meeting for live session:", session.id);

      const meeting = await createZoomMeetingForLiveSession(
        session,
        DEFAULT_TIMEZONE
      );

      const updateResponse = await axios.patch(
        `${POCKETBASE_URL}/api/collections/live_sessions/records/${session.id}`,
        {
          zoom_meeting_id: String(meeting.id),
          meeting_password: meeting.password || "pending",
          zoom_meeting_url: meeting.join_url || "pending",
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      session = updateResponse.data;

      console.log("Zoom meeting generated and saved for session:", session.id);
    }

    const sessionHasRealZoom = hasRealZoomMeetingId(session.zoom_meeting_id);

    return res.json({
      allowed: true,
      can_join: canJoin && sessionHasRealZoom,
      join_reason:
        canJoin && sessionHasRealZoom
          ? "Classroom is open"
          : joinReason || "Waiting for Zoom meeting generation",
      join_opens_at: joinOpensAt,
      session: {
        id: session.id,
        topic: session.topic || null,
        zoom_meeting_id:
          canJoin && sessionHasRealZoom ? session.zoom_meeting_id : null,
        meeting_password:
          canJoin && sessionHasRealZoom ? session.meeting_password || null : null,
        scheduled_date: session.scheduled_date || null,
        scheduled_time: session.scheduled_time || null,
        scheduled_timezone: DEFAULT_TIMEZONE,
        course_id: session.course_id || null,
        instructor_id: session.instructor_id || null,
        instructor_name: session.instructor_name || null,
        status: session.status || "scheduled",
        zoom_join_url:
          canJoin && sessionHasRealZoom ? session.zoom_meeting_url || null : null,
        recording_url: session.recording_url || null,
      },
    });
  } catch (error) {
    console.error("Live classroom error:", error.response?.data || error.message);

    return res.status(error.statusCode || error.response?.status || 500).json({
      allowed: false,
      error:
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Failed to load live classroom",
      details: error.response?.data || null,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Course schedule sync                                                        */
/* -------------------------------------------------------------------------- */

app.post("/course-schedule/sync", async (req, res) => {
  try {
    const { user, token } = await getAuthenticatedUser(req);

    if (!user?.id || user.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Only admins can sync course schedules",
      });
    }

    const {
      course_id,
      course_name,
      instructor_name,
      schedule_start_date,
      class_count,
      class_time,
      skip_sundays = true,
    } = req.body;

    if (!course_id) {
      return res.status(400).json({
        success: false,
        error: "course_id is required",
      });
    }

    if (!schedule_start_date || !class_count || !class_time) {
      return res.status(400).json({
        success: false,
        error: "schedule_start_date, class_count, and class_time are required",
      });
    }

    const desiredDates = buildClassDates({
      startDate: schedule_start_date,
      classCount: Number(class_count),
      skipSundays: Boolean(skip_sundays),
    });

    const existingResponse = await axios.get(
      `${POCKETBASE_URL}/api/collections/live_sessions/records?perPage=500&filter=${encodeURIComponent(
        `course_id="${course_id}"`
      )}&sort=scheduled_date,scheduled_time`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
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
          continue;
        }

        await axios.patch(
          `${POCKETBASE_URL}/api/collections/live_sessions/records/${existing.id}`,
          payload,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        updatedCount += 1;
      } else {
        await axios.post(
          `${POCKETBASE_URL}/api/collections/live_sessions/records`,
          {
            ...payload,
            zoom_meeting_id: buildPendingZoomId(course_id, classNumber),
            meeting_password: "pending",
            zoom_meeting_url: "pending",
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        createdCount += 1;
      }
    }

    return res.json({
      success: true,
      message: "Course live schedule synced successfully",
      course_id,
      total_desired_sessions: desiredDates.length,
      created: createdCount,
      updated: updatedCount,
      skipped_locked_sessions: skippedCount,
      timezone: DEFAULT_TIMEZONE,
      timezone_label: "Eastern Time (EST/EDT)",
      class_time,
      skip_sundays: Boolean(skip_sundays),
    });
  } catch (error) {
    console.error("Course schedule sync error:", error.response?.data || error.message);

    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error:
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Failed to sync course schedule",
      details: error.response?.data || null,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Holiday / tutor unavailable                                                 */
/* -------------------------------------------------------------------------- */

app.post("/course-schedule/holiday", async (req, res) => {
  try {
    const { user, token } = await getAuthenticatedUser(req);

    if (!user?.id || (user.role !== "admin" && user.role !== "instructor")) {
      return res.status(403).json({
        success: false,
        error: "Only admins or instructors can mark holidays",
      });
    }

    const {
      session_id,
      reason = "Tutor is unavailable today.",
      notify_students = true,
      create_replacement = true,
      skip_sundays = true,
    } = req.body;

    if (!session_id) {
      return res.status(400).json({
        success: false,
        error: "session_id is required",
      });
    }

    const session = await fetchPocketBaseSession(session_id, token);

    if (!session?.id) {
      return res.status(404).json({
        success: false,
        error: "Session not found",
      });
    }

    if (hasRealZoomMeetingId(session.zoom_meeting_id)) {
      return res.status(400).json({
        success: false,
        error: "Cannot mark tutor unavailable after Zoom meeting has already been generated",
      });
    }

    if (session.status === "completed") {
      return res.status(400).json({
        success: false,
        error: "Cannot mark completed session as tutor unavailable",
      });
    }

    await axios.patch(
      `${POCKETBASE_URL}/api/collections/live_sessions/records/${session.id}`,
      {
        status: "cancelled",
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    let replacementSession = null;

    if (create_replacement && session.course_id) {
      const lastSession = await getLastScheduledSessionForCourse(
        session.course_id,
        token
      );

      const lastDate =
        lastSession?.scheduled_date ||
        session.scheduled_date ||
        toDateString(new Date());

      const replacementDate = getNextClassDateAfter(
        lastDate,
        Boolean(skip_sundays)
      );

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
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      replacementSession = createResponse.data;
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
      announcement_id: announcement?.id || null,
    });
  } catch (error) {
    console.error("Holiday error:", error.response?.data || error.message);

    return res.status(error.statusCode || error.response?.status || 500).json({
      success: false,
      error:
        error.response?.data?.message ||
        error.response?.data?.error ||
        error.message ||
        "Failed to mark tutor unavailable",
      details: error.response?.data || null,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Plans / Coupons / Feature Control                                           */
/* -------------------------------------------------------------------------- */

app.get("/features", async (req, res) => {
  try {
    const db = await readLiveDb();

    return res.json({
      success: true,
      features: Object.values(db.featureCatalog || {}),
    });
  } catch (error) {
    console.error("Features load error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Failed to load features",
    });
  }
});

app.get("/plans", async (req, res) => {
  try {
    const { course_id } = req.query;
    const db = await readLiveDb();

    let plans = Object.values(db.plans || {})
      .filter((plan) => plan.is_active !== false)
      .map(sanitizePlan);

    if (course_id) {
      plans = plans.filter(
        (plan) => !plan.course_id || String(plan.course_id) === String(course_id)
      );
    }

    plans = plans.sort((a, b) => {
      if (a.price_cents === b.price_cents) return a.name.localeCompare(b.name);
      return a.price_cents - b.price_cents;
    });

    return res.json({
      success: true,
      count: plans.length,
      plans,
      features: Object.values(db.featureCatalog || {}),
    });
  } catch (error) {
    console.error("Public plans load error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Failed to load plans",
    });
  }
});

app.get("/admin/plans", async (req, res) => {
  try {
    await requireAdmin(req);

    const db = await readLiveDb();

    return res.json({
      success: true,
      plans: Object.values(db.plans || {}).map(sanitizePlan),
      features: Object.values(db.featureCatalog || {}),
    });
  } catch (error) {
    console.error("Admin plans load error:", error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load plans",
    });
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

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        error: "Plan name is required",
      });
    }

    const finalPriceCents =
      price_cents !== undefined ? Number(price_cents) : centsFromDollars(price);

    if (Number.isNaN(finalPriceCents) || finalPriceCents < 0) {
      return res.status(400).json({
        success: false,
        error: "Plan price must be valid",
      });
    }

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

    return res.json({
      success: true,
      plan: sanitizePlan(plan),
    });
  } catch (error) {
    console.error("Create plan error:", error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to create plan",
    });
  }
});

app.patch("/admin/plans/:planId", async (req, res) => {
  try {
    await requireAdmin(req);

    const { planId } = req.params;
    const db = await readLiveDb();

    if (!db.plans[planId]) {
      return res.status(404).json({
        success: false,
        error: "Plan not found",
      });
    }

    const allowedFields = [
      "name",
      "description",
      "price_cents",
      "currency",
      "billing_type",
      "course_id",
      "included_features",
      "access_days",
      "is_active",
      "is_featured",
    ];

    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (updates.price_cents !== undefined) {
      updates.price_cents = Number(updates.price_cents);
    }

    if (updates.included_features !== undefined && !Array.isArray(updates.included_features)) {
      updates.included_features = [];
    }

    db.plans[planId] = {
      ...db.plans[planId],
      ...updates,
      updated_at: new Date().toISOString(),
    };

    await writeLiveDb(db);

    return res.json({
      success: true,
      plan: sanitizePlan(db.plans[planId]),
    });
  } catch (error) {
    console.error("Update plan error:", error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to update plan",
    });
  }
});

app.get("/admin/coupons", async (req, res) => {
  try {
    await requireAdmin(req);

    const db = await readLiveDb();

    return res.json({
      success: true,
      coupons: Object.values(db.coupons || {}).map(sanitizeCoupon),
    });
  } catch (error) {
    console.error("Admin coupons load error:", error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load coupons",
    });
  }
});

app.post("/admin/coupons", async (req, res) => {
  try {
    const { user } = await requireAdmin(req);

    const {
      code,
      description = "",
      discount_type = "percentage",
      discount_value,
      max_uses = null,
      expires_at = null,
      course_id = null,
      plan_id = null,
      is_active = true,
    } = req.body;

    const normalizedCode = normalizeCouponCode(code);

    if (!normalizedCode) {
      return res.status(400).json({
        success: false,
        error: "Coupon code is required",
      });
    }

    if (!["percentage", "fixed"].includes(discount_type)) {
      return res.status(400).json({
        success: false,
        error: "discount_type must be percentage or fixed",
      });
    }

    const numericValue = Number(discount_value);

    if (Number.isNaN(numericValue) || numericValue <= 0) {
      return res.status(400).json({
        success: false,
        error: "discount_value must be valid",
      });
    }

    if (discount_type === "percentage" && numericValue > 100) {
      return res.status(400).json({
        success: false,
        error: "Percentage coupon cannot exceed 100",
      });
    }

    const db = await readLiveDb();

    const existing = Object.values(db.coupons || {}).find(
      (coupon) => coupon.code === normalizedCode
    );

    if (existing) {
      return res.status(400).json({
        success: false,
        error: "Coupon code already exists",
      });
    }

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

    return res.json({
      success: true,
      coupon: sanitizeCoupon(coupon),
    });
  } catch (error) {
    console.error("Create coupon error:", error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to create coupon",
    });
  }
});

app.patch("/admin/coupons/:couponId", async (req, res) => {
  try {
    await requireAdmin(req);

    const { couponId } = req.params;
    const db = await readLiveDb();

    if (!db.coupons[couponId]) {
      return res.status(404).json({
        success: false,
        error: "Coupon not found",
      });
    }

    const allowedFields = [
      "description",
      "discount_type",
      "discount_value",
      "max_uses",
      "expires_at",
      "course_id",
      "plan_id",
      "is_active",
    ];

    const updates = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (updates.discount_value !== undefined) {
      updates.discount_value = Number(updates.discount_value);
    }

    if (updates.max_uses !== undefined && updates.max_uses !== null) {
      updates.max_uses = Number(updates.max_uses);
    }

    db.coupons[couponId] = {
      ...db.coupons[couponId],
      ...updates,
      updated_at: new Date().toISOString(),
    };

    await writeLiveDb(db);

    return res.json({
      success: true,
      coupon: sanitizeCoupon(db.coupons[couponId]),
    });
  } catch (error) {
    console.error("Update coupon error:", error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to update coupon",
    });
  }
});

app.post("/coupons/validate", async (req, res) => {
  try {
    const { plan_id, coupon_code, course_id = null } = req.body;

    if (!plan_id) {
      return res.status(400).json({
        success: false,
        error: "plan_id is required",
      });
    }

    const db = await readLiveDb();
    const plan = db.plans[plan_id];

    if (!plan || plan.is_active === false) {
      return res.status(404).json({
        success: false,
        error: "Plan not found or inactive",
      });
    }

    const code = normalizeCouponCode(coupon_code);

    if (!code) {
      const pricing = buildCheckoutPricing({ plan, coupon: null, courseId: course_id });

      return res.json({
        success: true,
        valid: true,
        coupon: null,
        pricing,
      });
    }

    const coupon = Object.values(db.coupons || {}).find(
      (item) => item.code === code
    );

    const validation = validateCouponForPlan({
      coupon,
      plan,
      courseId: course_id,
    });

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        valid: false,
        error: validation.error,
      });
    }

    const pricing = buildCheckoutPricing({
      plan,
      coupon,
      courseId: course_id,
    });

    return res.json({
      success: true,
      valid: true,
      coupon: sanitizeCoupon(coupon),
      pricing,
    });
  } catch (error) {
    console.error("Coupon validate error:", error.message);

    return res.status(500).json({
      success: false,
      error: error.message || "Failed to validate coupon",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Stripe                                                                      */
/* -------------------------------------------------------------------------- */

app.post("/stripe/create-checkout", async (req, res) => {
  try {
    const {
      enrollmentId,
      studentId,
      courseId,
      plan_id = null,
      coupon_code = null,
      successUrl,
      cancelUrl,

      // legacy fallback
      amount,
    } = req.body;

    if (!enrollmentId || !studentId || !courseId) {
      return res.status(400).json({
        success: false,
        error: "enrollmentId, studentId, and courseId are required",
      });
    }

    const db = await readLiveDb();

    let plan = null;

    if (plan_id) {
      plan = db.plans[plan_id];

      if (!plan || plan.is_active === false) {
        return res.status(404).json({
          success: false,
          error: "Plan not found or inactive",
        });
      }
    } else {
      const coursePlans = Object.values(db.plans || {}).filter(
        (item) =>
          item.is_active !== false &&
          (!item.course_id || String(item.course_id) === String(courseId))
      );

      plan =
        coursePlans.sort((a, b) => Number(a.price_cents || 0) - Number(b.price_cents || 0))[0] ||
        null;
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

    const coupon = code
      ? Object.values(db.coupons || {}).find((item) => item.code === code)
      : null;

    const pricing = buildCheckoutPricing({
      plan,
      coupon,
      courseId,
    });

    if (!pricing.valid) {
      return res.status(400).json({
        success: false,
        error: pricing.error,
      });
    }

    const finalAmountCents = pricing.final_amount_cents;

    if (finalAmountCents <= 0) {
      const redemptionId = crypto.randomUUID();

      if (coupon?.id) {
        db.coupons[coupon.id] = {
          ...db.coupons[coupon.id],
          used_count: Number(db.coupons[coupon.id].used_count || 0) + 1,
          updated_at: new Date().toISOString(),
        };

        db.couponRedemptions[redemptionId] = {
          id: redemptionId,
          coupon_id: coupon.id,
          coupon_code: coupon.code,
          plan_id: plan.id,
          enrollment_id: enrollmentId,
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
        message: "Final amount is zero. Grant access without Stripe checkout.",
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: plan.currency || "usd",
            product_data: {
              name: plan.name || "NextGen USMLE Enrollment",
              description: plan.description || "Course enrollment",
            },
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

    return res.json({
      success: true,
      free_checkout: false,
      url: session.url,
      plan: sanitizePlan(plan),
      pricing,
    });
  } catch (err) {
    console.error("Stripe Error:", err.response?.data || err.message);

    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Zoom                                                                        */
/* -------------------------------------------------------------------------- */

app.get("/zoom/zak", async (req, res) => {
  try {
    const accessToken = await getZoomAccessToken();

    const response = await axios.get(
      "https://api.zoom.us/v2/users/me/token?type=zak",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    res.json({
      zak: response.data.token,
    });
  } catch (error) {
    console.error("ZAK Error:", error.response?.data || error.message);

    res.status(500).json({
      error: error.response?.data || error.message,
    });
  }
});

app.post("/zoom/create-meeting", async (req, res) => {
  try {
    const {
      topic,
      start_time,
      duration = DEFAULT_ZOOM_DURATION_MINUTES,
      timezone = DEFAULT_TIMEZONE,
    } = req.body;

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
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    res.json({
      success: true,
      meeting: response.data,
    });
  } catch (error) {
    console.error("Zoom Error:", error.response?.data || error.message);

    res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
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

    const signature = jwt.sign(payload, process.env.ZOOM_MEETING_SDK_SECRET, {
      algorithm: "HS256",
    });

    res.json({
      signature,
    });
  } catch (error) {
    console.error("Signature Error:", error.response?.data || error.message);

    res.status(500).json({
      error: error.message,
    });
  }
});

app.post("/zoom/webhook", async (req, res) => {
  try {
    const event = req.body.event;

    console.log("Zoom webhook received:", event);
    console.log("Zoom webhook body:", JSON.stringify(req.body, null, 2));

    if (event === "endpoint.url_validation") {
      const plainToken = req.body.payload.plainToken;

      const encryptedToken = crypto
        .createHmac("sha256", process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
        .update(plainToken)
        .digest("hex");

      return res.status(200).json({
        plainToken,
        encryptedToken,
      });
    }

    if (event === "recording.completed") {
      const recordingObject = req.body.payload.object;
      const recordingFiles = recordingObject.recording_files || [];

      const videoFile =
        recordingFiles.find((file) => file.file_type === "MP4") ||
        recordingFiles[0];

      const recordingPayload = {
        meeting_id: String(recordingObject.id),
        uuid: recordingObject.uuid,
        topic: recordingObject.topic,
        start_time: recordingObject.start_time,
        duration: recordingObject.duration,
        share_url: recordingObject.share_url || null,
        recording_url:
          videoFile?.play_url ||
          recordingObject.share_url ||
          videoFile?.download_url ||
          null,
        download_url: videoFile?.download_url || null,
        file_type: videoFile?.file_type || null,
        recording_type: videoFile?.recording_type || null,
        status: videoFile?.status || null,
        published: false,
        received_at: new Date().toISOString(),
      };

      const db = await readLiveDb();

      db.recordings[recordingPayload.meeting_id] = {
        ...(db.recordings[recordingPayload.meeting_id] || {}),
        ...recordingPayload,
      };

      await writeLiveDb(db);

      console.log("Recording completed and metadata saved:");
      console.log("Meeting ID:", recordingPayload.meeting_id);
      console.log("Zoom UUID:", recordingPayload.uuid);
      console.log("Topic:", recordingPayload.topic);
      console.log("Recording URL:", recordingPayload.recording_url);

      return res.status(200).json({
        received: true,
        saved: true,
        note: "Recording metadata saved. Actual video remains on Zoom Cloud.",
      });
    }

    return res.status(200).json({
      received: true,
    });
  } catch (error) {
    console.error("Zoom webhook error:", error.response?.data || error.message);

    return res.status(200).json({
      success: false,
      error: error.response?.data || error.message,
    });
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

    const response = await axios.get(
      `https://api.zoom.us/v2/users/me/recordings?from=${from}&to=${to}&page_size=100`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

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

    return res.json({
      success: true,
      from,
      to,
      count: recordings.length,
      recordings,
    });
  } catch (error) {
    console.error("Zoom recordings fetch error:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Recording publish / unpublish                                                */
/* -------------------------------------------------------------------------- */

app.post("/live/recordings/publish", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);

    if (user.role !== "admin" && user.role !== "instructor") {
      return res.status(403).json({
        success: false,
        error: "Only admins or instructors can publish recordings",
      });
    }

    const {
      meeting_id,
      session_id = null,
      course_id = null,
      topic = null,
      recording_url = null,
      share_url = null,
      published = true,
    } = req.body;

    if (!meeting_id) {
      return res.status(400).json({
        success: false,
        error: "meeting_id is required",
      });
    }

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

    return res.json({
      success: true,
      recording: db.recordings[key],
    });
  } catch (error) {
    console.error("Publish recording error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to publish recording",
    });
  }
});

app.post("/live/recordings/unpublish", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);

    if (user.role !== "admin" && user.role !== "instructor") {
      return res.status(403).json({
        success: false,
        error: "Only admins or instructors can unpublish recordings",
      });
    }

    const { meeting_id } = req.body;

    if (!meeting_id) {
      return res.status(400).json({
        success: false,
        error: "meeting_id is required",
      });
    }

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

    return res.json({
      success: true,
      recording: db.recordings[key],
    });
  } catch (error) {
    console.error("Unpublish recording error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to unpublish recording",
    });
  }
});

app.get("/live/recordings/published", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id } = req.query;

    const db = await readLiveDb();

    let recordings = Object.values(db.recordings || {}).filter((recording) =>
      Boolean(recording.published)
    );

    if (course_id) {
      recordings = recordings.filter(
        (recording) => String(recording.course_id || "") === String(course_id)
      );
    }

    recordings = recordings.map(sanitizePublicRecording);

    return res.json({
      success: true,
      user_id: user.id,
      count: recordings.length,
      recordings,
    });
  } catch (error) {
    console.error("Published recordings error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load published recordings",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Attendance / streaks / progress / leaderboard                               */
/* -------------------------------------------------------------------------- */

app.post("/live/attendance/mark", async (req, res) => {
  try {
    const { user, token } = await getAuthenticatedUser(req);

    const {
      session_id,
      course_id: bodyCourseId = null,
      source = "classroom_opened",
    } = req.body;

    if (!session_id) {
      return res.status(400).json({
        success: false,
        error: "session_id is required",
      });
    }

    let courseId = bodyCourseId;
    let session = null;

    try {
      session = await fetchPocketBaseSession(session_id, token);
      courseId = courseId || session.course_id || null;
    } catch {
      // Allows attendance to be marked by provided course_id if session fetch fails.
    }

    if (!courseId) {
      return res.status(400).json({
        success: false,
        error: "course_id is required when session cannot provide course_id",
      });
    }

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

    const userAttendanceForCourse = Object.values(db.attendance).filter(
      (item) => item.user_id === user.id && item.course_id === courseId
    );

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
    const attendedSessions = new Set(
      userAttendanceForCourse.map((item) => item.session_id)
    );

    db.courseProgress[progressKey] = {
      course_id: courseId,
      user_id: user.id,
      attended_sessions: attendedSessions.size,
      last_session_id: session_id,
      last_attended_at: new Date().toISOString(),
    };

    const leaderboardKey = buildLeaderboardKey(courseId, user.id);

    db.leaderboard[leaderboardKey] = {
      ...(db.leaderboard[leaderboardKey] || {}),
      course_id: courseId,
      user_id: user.id,
      user_name: user.name || user.username || user.email || "Student",
      attendance_points: attendedSessions.size * 10,
      quiz_points: db.leaderboard[leaderboardKey]?.quiz_points || 0,
      total_points:
        attendedSessions.size * 10 + (db.leaderboard[leaderboardKey]?.quiz_points || 0),
      updated_at: new Date().toISOString(),
    };

    await writeLiveDb(db);

    return res.json({
      success: true,
      attendance: db.attendance[key],
      streak: db.streaks[streakKey],
      progress: db.courseProgress[progressKey],
      leaderboard: db.leaderboard[leaderboardKey],
    });
  } catch (error) {
    console.error("Attendance mark error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to mark attendance",
    });
  }
});

app.get("/live/attendance/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id } = req.query;

    const db = await readLiveDb();

    let attendance = Object.values(db.attendance).filter(
      (item) => item.user_id === user.id
    );

    if (course_id) {
      attendance = attendance.filter(
        (item) => String(item.course_id) === String(course_id)
      );
    }

    return res.json({
      success: true,
      count: attendance.length,
      attendance,
    });
  } catch (error) {
    console.error("My attendance error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load attendance",
    });
  }
});

app.get("/live/streaks/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id } = req.query;

    const db = await readLiveDb();

    let streaks = Object.values(db.streaks).filter(
      (item) => item.user_id === user.id
    );

    if (course_id) {
      streaks = streaks.filter(
        (item) => String(item.course_id) === String(course_id)
      );
    }

    return res.json({
      success: true,
      count: streaks.length,
      streaks,
    });
  } catch (error) {
    console.error("My streaks error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load streaks",
    });
  }
});

app.get("/live/progress/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id } = req.query;

    const db = await readLiveDb();

    let progress = Object.values(db.courseProgress).filter(
      (item) => item.user_id === user.id
    );

    if (course_id) {
      progress = progress.filter(
        (item) => String(item.course_id) === String(course_id)
      );
    }

    return res.json({
      success: true,
      count: progress.length,
      progress,
    });
  } catch (error) {
    console.error("My progress error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load progress",
    });
  }
});

app.get("/live/leaderboard", async (req, res) => {
  try {
    await getAuthenticatedUser(req);

    const { course_id } = req.query;
    const db = await readLiveDb();

    let leaderboard = Object.values(db.leaderboard || {});

    if (course_id) {
      leaderboard = leaderboard.filter(
        (item) => String(item.course_id) === String(course_id)
      );
    }

    leaderboard = leaderboard
      .map((item) => ({
        ...item,
        total_points:
          Number(item.attendance_points || 0) + Number(item.quiz_points || 0),
      }))
      .sort((a, b) => b.total_points - a.total_points)
      .slice(0, 50)
      .map((item, index) => ({
        rank: index + 1,
        ...item,
      }));

    return res.json({
      success: true,
      count: leaderboard.length,
      leaderboard,
    });
  } catch (error) {
    console.error("Leaderboard error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load leaderboard",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Community messages                                                          */
/* -------------------------------------------------------------------------- */

app.get("/live/community/:sessionId", async (req, res) => {
  try {
    await getAuthenticatedUser(req);

    const { sessionId } = req.params;
    const db = await readLiveDb();

    const messages = db.communityMessages[sessionId] || [];

    return res.json({
      success: true,
      session_id: sessionId,
      count: messages.length,
      messages,
    });
  } catch (error) {
    console.error("Community load error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load community messages",
    });
  }
});

app.post("/live/community/:sessionId", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { sessionId } = req.params;
    const { message, course_id = null } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({
        success: false,
        error: "message is required",
      });
    }

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

    return res.json({
      success: true,
      message: item,
    });
  } catch (error) {
    console.error("Community post error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to post community message",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Quiz / mini mock attempts                                                   */
/* -------------------------------------------------------------------------- */

app.post("/live/quiz/attempt", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);

    const {
      session_id,
      course_id,
      quiz_id = "session-mini-mock",
      score,
      total,
      answers = null,
    } = req.body;

    if (!session_id || !course_id) {
      return res.status(400).json({
        success: false,
        error: "session_id and course_id are required",
      });
    }

    if (score === undefined || total === undefined) {
      return res.status(400).json({
        success: false,
        error: "score and total are required",
      });
    }

    const numericScore = Number(score);
    const numericTotal = Number(total);

    if (
      Number.isNaN(numericScore) ||
      Number.isNaN(numericTotal) ||
      numericTotal <= 0
    ) {
      return res.status(400).json({
        success: false,
        error: "score and total must be valid numbers",
      });
    }

    const db = await readLiveDb();

    const attempt = {
      id: crypto.randomUUID(),
      user_id: user.id,
      user_name: user.name || user.username || user.email || "Student",
      session_id,
      course_id,
      quiz_id,
      score: numericScore,
      total: numericTotal,
      percentage: Math.round((numericScore / numericTotal) * 100),
      answers,
      created_at: new Date().toISOString(),
    };

    const attemptKey = buildCourseUserKey(course_id, user.id);

    db.quizAttempts[attemptKey] = [
      ...(db.quizAttempts[attemptKey] || []),
      attempt,
    ];

    const userAttempts = db.quizAttempts[attemptKey] || [];
    const quizPoints = userAttempts.reduce((sum, item) => {
      return sum + Math.round(Number(item.percentage || 0) / 10);
    }, 0);

    const leaderboardKey = buildLeaderboardKey(course_id, user.id);
    const current = db.leaderboard[leaderboardKey] || {};

    db.leaderboard[leaderboardKey] = {
      ...current,
      course_id,
      user_id: user.id,
      user_name: user.name || user.username || user.email || "Student",
      attendance_points: current.attendance_points || 0,
      quiz_points: quizPoints,
      total_points: Number(current.attendance_points || 0) + quizPoints,
      updated_at: new Date().toISOString(),
    };

    await writeLiveDb(db);

    return res.json({
      success: true,
      attempt,
      leaderboard: db.leaderboard[leaderboardKey],
    });
  } catch (error) {
    console.error("Quiz attempt error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to save quiz attempt",
    });
  }
});

app.get("/live/quiz/attempts/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id } = req.query;

    const db = await readLiveDb();

    let attempts = [];

    for (const item of Object.values(db.quizAttempts || {})) {
      attempts = attempts.concat(item || []);
    }

    attempts = attempts.filter((item) => item.user_id === user.id);

    if (course_id) {
      attempts = attempts.filter(
        (item) => String(item.course_id) === String(course_id)
      );
    }

    return res.json({
      success: true,
      count: attempts.length,
      attempts,
    });
  } catch (error) {
    console.error("Quiz attempts load error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load quiz attempts",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Notes / transcript metadata                                                 */
/* -------------------------------------------------------------------------- */

app.post("/live/notes/:sessionId", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);

    if (user.role !== "admin" && user.role !== "instructor") {
      return res.status(403).json({
        success: false,
        error: "Only admins or instructors can save notes",
      });
    }

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

    return res.json({
      success: true,
      notes: db.notes[sessionId],
    });
  } catch (error) {
    console.error("Save notes error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to save notes",
    });
  }
});

app.get("/live/notes/:sessionId", async (req, res) => {
  try {
    await getAuthenticatedUser(req);

    const { sessionId } = req.params;
    const db = await readLiveDb();

    return res.json({
      success: true,
      notes: db.notes[sessionId] || null,
    });
  } catch (error) {
    console.error("Load notes error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load notes",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Debug route for admin                                                       */
/* -------------------------------------------------------------------------- */

app.get("/live/debug/storage", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);

    if (user.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Only admins can view storage debug",
      });
    }

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
      },
      updatedAt: db.updatedAt || null,
    });
  } catch (error) {
    console.error("Storage debug error:", error.response?.data || error.message);

    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load storage debug",
    });
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
