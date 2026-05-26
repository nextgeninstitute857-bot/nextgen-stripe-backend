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
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");

app.use(express.json({ limit: "20mb" }));
app.use(cors({ origin: "*" }));

const POCKETBASE_URL = process.env.POCKETBASE_URL;
const DATA_DIR = process.env.DATA_DIR || "/tmp";
const LIVE_DB_PATH = path.join(DATA_DIR, "live-session-db.json");
const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_ZOOM_DURATION_MINUTES = 120;
const PENDING_ZOOM_PREFIX = "PENDING_ZOOM_";

const DEFAULT_FEATURE_CATALOG = {
  video_library: { key: "video_library", name: "Video Library", description: "Access to recorded video lessons", is_active: true, free_for_all: false },
  live_classes: { key: "live_classes", name: "Live Classes", description: "Access to scheduled Zoom live classes", is_active: true, free_for_all: false },
  recordings: { key: "recordings", name: "Class Recordings", description: "Access to published class recordings", is_active: true, free_for_all: false },
  community: { key: "community", name: "Community Messages", description: "Access to session community discussion", is_active: true, free_for_all: false },
  assessments: { key: "assessments", name: "Assessments", description: "Access to tutor-created assessments", is_active: true, free_for_all: false },
  notes_transcripts: { key: "notes_transcripts", name: "Notes & Transcripts", description: "Access to class notes and transcript links", is_active: true, free_for_all: false },
  leaderboard: { key: "leaderboard", name: "Leaderboard", description: "Access to attendance, assessment, and task leaderboard", is_active: true, free_for_all: false },
  roadmap: { key: "roadmap", name: "Roadmap", description: "Access to course roadmap", is_active: true, free_for_all: true },
  support: { key: "support", name: "Student Support", description: "Access to support and announcements", is_active: true, free_for_all: false },
};

const DEFAULT_DEMO_SETTINGS = {
  enabled: true,
  duration_days: 2,
  allow_live_classes: true,
  allow_roadmap: true,
  allow_community: true,
  allow_assessments: true,
  allow_leaderboard: true,
  allow_recordings: true,
  allow_notes_transcripts: true,
  allow_video_library: false,
  max_live_sessions: null,
  updated_at: null,
};

const DEFAULT_LIVE_DB = {
  // Backend-owned LMS content. PocketBase is kept only for users/auth.
  courses: {},
  liveSessions: {},
  announcements: {},

  recordings: {},
  notes: {},
  attendance: {},
  streaks: {},
  courseProgress: {},
  leaderboard: {},
  communityMessages: {},
  quizAttempts: {},

  // Backend-only enrollments. PocketBase enrollments are intentionally bypassed.
  enrollments: {},

  plans: {},
  coupons: {},
  couponRedemptions: {},
  featureCatalog: DEFAULT_FEATURE_CATALOG,
  demoSettings: DEFAULT_DEMO_SETTINGS,
  googleAuthUsers: {},

  roadmaps: {},
  roadmapProgress: {},

  assessments: {},
  assessmentAttempts: {},

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
      courses: parsed.courses || {},
      liveSessions: parsed.liveSessions || {},
      announcements: parsed.announcements || {},
      recordings: parsed.recordings || {},
      notes: parsed.notes || {},
      attendance: parsed.attendance || {},
      streaks: parsed.streaks || {},
      courseProgress: parsed.courseProgress || {},
      leaderboard: parsed.leaderboard || {},
      communityMessages: parsed.communityMessages || {},
      quizAttempts: parsed.quizAttempts || {},
      enrollments: parsed.enrollments || {},
      plans: parsed.plans || {},
      coupons: parsed.coupons || {},
      couponRedemptions: parsed.couponRedemptions || {},
      googleAuthUsers: parsed.googleAuthUsers || {},
      roadmaps: parsed.roadmaps || {},
      roadmapProgress: parsed.roadmapProgress || {},
      assessments: parsed.assessments || {},
      assessmentAttempts: parsed.assessmentAttempts || {},
      featureCatalog: { ...DEFAULT_FEATURE_CATALOG, ...(parsed.featureCatalog || {}) },
      demoSettings: { ...DEFAULT_DEMO_SETTINGS, ...(parsed.demoSettings || {}) },
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
      featureCatalog: { ...DEFAULT_FEATURE_CATALOG, ...(db.featureCatalog || {}) },
      demoSettings: { ...DEFAULT_DEMO_SETTINGS, ...(db.demoSettings || {}) },
      updatedAt: new Date().toISOString(),
    };
    const tempPath = `${LIVE_DB_PATH}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(nextDb, null, 2), "utf8");
    await fs.rename(tempPath, LIVE_DB_PATH);
  });
  return writeQueue;
}

function todayKey(date = new Date()) { return date.toISOString().slice(0, 10); }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + Number(days || 0)); return d; }
function dateOnly(date) { return date.toISOString().slice(0, 10); }
function uuid() { return crypto.randomUUID(); }
function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split("\n").map((x) => x.trim()).filter(Boolean);
  return [];
}
function backendEnrollmentKey(courseId, userId, type) { return `${courseId}:${userId}:${type}`; }
function courseUserKey(courseId, userId) { return `${courseId}:${userId}`; }
function assessmentAttemptKey(assessmentId, userId) { return `${assessmentId}:${userId}`; }
function isPendingZoomId(value) { return String(value || "").startsWith(PENDING_ZOOM_PREFIX); }
function hasRealZoomMeetingId(value) { return Boolean(value) && !isPendingZoomId(value); }
function buildPendingZoomId(courseId, label) { return `${PENDING_ZOOM_PREFIX}${courseId}_${label}_${Date.now()}`; }

function getTimezoneOffsetMs(timeZone, date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const values = {};
  for (const part of parts) if (part.type !== "literal") values[part.type] = part.value;
  const asUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  return asUtc - date.getTime();
}

function getSessionStartUtc(scheduledDate, scheduledTime, timezone = DEFAULT_TIMEZONE) {
  if (!scheduledDate || !scheduledTime) return null;
  const [year, month, day] = String(scheduledDate).split(" ")[0].split("-").map(Number);
  const [hour, minute] = String(scheduledTime).split(":").map(Number);
  if (!year || !month || !day || Number.isNaN(hour) || Number.isNaN(minute)) return null;
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = getTimezoneOffsetMs(timezone, utcGuess);
  return new Date(utcGuess.getTime() - offset);
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


function normalizeStatus(value, fallback = "active") {
  const allowed = ["active", "draft", "archived", "inactive", "cancelled", "completed", "scheduled"];
  const clean = String(value || fallback).trim().toLowerCase();
  return allowed.includes(clean) ? clean : fallback;
}

function normalizeCoursePayload(body = {}, existing = {}) {
  return {
    ...existing,
    name: String(body.name ?? existing.name ?? "").trim(),
    description: String(body.description ?? existing.description ?? "").trim(),
    instructor_name: String(body.instructor_name ?? existing.instructor_name ?? "").trim(),
    instructor_bio: String(body.instructor_bio ?? existing.instructor_bio ?? "").trim(),
    total_duration: Number(body.total_duration ?? existing.total_duration ?? 0) || 0,
    image_url: String(body.image_url ?? existing.image_url ?? "").trim(),
    category: String(body.category ?? existing.category ?? "USMLE Step 1").trim() || "USMLE Step 1",
    course_type: String(body.course_type ?? existing.course_type ?? "Live Course").trim() || "Live Course",
    category_note: String(body.category_note ?? existing.category_note ?? "").trim(),
    status: normalizeStatus(body.status ?? existing.status ?? "active", "active"),
    demo_access_enabled: body.demo_access_enabled !== undefined ? Boolean(body.demo_access_enabled) : existing.demo_access_enabled !== false,
  };
}

function sanitizeCourse(course) {
  return {
    id: course.id,
    name: course.name || "",
    description: course.description || "",
    instructor_name: course.instructor_name || "",
    instructor_bio: course.instructor_bio || "",
    total_duration: Number(course.total_duration || 0),
    image_url: course.image_url || "",
    category: course.category || "USMLE Step 1",
    course_type: course.course_type || "Live Course",
    category_note: course.category_note || "",
    status: course.status || "active",
    demo_access_enabled: course.demo_access_enabled !== false,
    created_by: course.created_by || null,
    updated_by: course.updated_by || null,
    created_at: course.created_at || null,
    updated_at: course.updated_at || null,
  };
}

function normalizeLiveSessionPayload(body = {}, existing = {}) {
  return {
    ...existing,
    course_id: String(body.course_id ?? existing.course_id ?? "").trim(),
    topic: String(body.topic ?? existing.topic ?? body.title ?? existing.title ?? "").trim(),
    title: String(body.title ?? existing.title ?? body.topic ?? existing.topic ?? "").trim(),
    description: String(body.description ?? existing.description ?? "").trim(),
    scheduled_date: String(body.scheduled_date ?? existing.scheduled_date ?? "").trim(),
    scheduled_time: String(body.scheduled_time ?? existing.scheduled_time ?? "").trim(),
    scheduled_timezone: String(body.scheduled_timezone ?? existing.scheduled_timezone ?? DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE,
    duration_minutes: Number(body.duration_minutes ?? existing.duration_minutes ?? DEFAULT_ZOOM_DURATION_MINUTES) || DEFAULT_ZOOM_DURATION_MINUTES,
    instructor_id: body.instructor_id ?? existing.instructor_id ?? null,
    instructor_name: String(body.instructor_name ?? existing.instructor_name ?? "").trim(),
    status: normalizeStatus(body.status ?? existing.status ?? "scheduled", "scheduled"),
    zoom_meeting_id: body.zoom_meeting_id ?? existing.zoom_meeting_id ?? null,
    meeting_password: body.meeting_password ?? existing.meeting_password ?? null,
    zoom_meeting_url: body.zoom_meeting_url ?? existing.zoom_meeting_url ?? null,
    recording_url: body.recording_url ?? existing.recording_url ?? null,
  };
}

function sanitizeLiveSession(session) {
  return {
    id: session.id,
    course_id: session.course_id || null,
    topic: session.topic || session.title || "Live Class",
    title: session.title || session.topic || "Live Class",
    description: session.description || "",
    scheduled_date: session.scheduled_date || null,
    scheduled_time: session.scheduled_time || null,
    scheduled_timezone: session.scheduled_timezone || DEFAULT_TIMEZONE,
    duration_minutes: Number(session.duration_minutes || DEFAULT_ZOOM_DURATION_MINUTES),
    instructor_id: session.instructor_id || null,
    instructor_name: session.instructor_name || null,
    status: session.status || "scheduled",
    zoom_meeting_id: session.zoom_meeting_id || null,
    meeting_password: session.meeting_password || null,
    zoom_meeting_url: session.zoom_meeting_url || null,
    recording_url: session.recording_url || null,
    roadmap_day_id: session.roadmap_day_id || null,
    created_by: session.created_by || null,
    updated_by: session.updated_by || null,
    created_at: session.created_at || null,
    updated_at: session.updated_at || null,
  };
}

function sanitizeAnnouncement(item) {
  return {
    id: item.id,
    title: item.title || "",
    content: item.content || "",
    course_id: item.course_id || null,
    status: item.status || "active",
    created_by: item.created_by || null,
    updated_by: item.updated_by || null,
    created_at: item.created_at || item.created || null,
    updated_at: item.updated_at || null,
    created: item.created_at || item.created || null,
  };
}

function sortNewestFirst(a, b) {
  return String(b.created_at || b.created || "").localeCompare(String(a.created_at || a.created || ""));
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
    transcript_url: recording.transcript_url || null,
    transcript_imported: Boolean(recording.transcript_imported),
    file_type: recording.file_type || null,
    recording_type: recording.recording_type || null,
    status: recording.status || null,
    published: Boolean(recording.published),
    session_id: recording.session_id || null,
    course_id: recording.course_id || null,
  };
}

function normalizeCouponCode(code) { return String(code || "").trim().toUpperCase(); }
function centsFromDollars(value) { const n = Number(value || 0); return Number.isNaN(n) ? 0 : Math.max(0, Math.round(n * 100)); }
function isCouponExpired(coupon) { return Boolean(coupon?.expires_at) && new Date(coupon.expires_at).getTime() < Date.now(); }
function calculateDiscountCents(priceCents, coupon) {
  const price = Number(priceCents || 0);
  const value = Number(coupon?.discount_value || 0);
  if (!coupon || price <= 0 || value <= 0) return 0;
  if (coupon.discount_type === "percentage") return Math.min(price, Math.round(price * (Math.min(100, Math.max(0, value)) / 100)));
  if (coupon.discount_type === "fixed") return Math.min(price, centsFromDollars(value));
  return 0;
}
function validateCouponForPlan({ coupon, plan, courseId }) {
  if (!coupon) return { valid: false, error: "Coupon not found" };
  if (coupon.is_active === false) return { valid: false, error: "Coupon is inactive" };
  if (isCouponExpired(coupon)) return { valid: false, error: "Coupon has expired" };
  if (coupon.max_uses && Number(coupon.used_count || 0) >= Number(coupon.max_uses)) return { valid: false, error: "Coupon usage limit reached" };
  if (coupon.plan_id && String(coupon.plan_id) !== String(plan.id)) return { valid: false, error: "Coupon is not valid for this plan" };
  if (coupon.course_id && String(coupon.course_id) !== String(courseId || plan.course_id || "")) return { valid: false, error: "Coupon is not valid for this course" };
  return { valid: true, error: null };
}
function buildCheckoutPricing({ plan, coupon, courseId }) {
  const original = Number(plan.price_cents || 0);
  const validation = coupon ? validateCouponForPlan({ coupon, plan, courseId }) : { valid: true };
  if (!validation.valid) return { valid: false, error: validation.error };
  const discount = coupon ? calculateDiscountCents(original, coupon) : 0;
  return { valid: true, original_amount_cents: original, discount_cents: discount, final_amount_cents: Math.max(0, original - discount), coupon_code: coupon?.code || null };
}

async function getPocketBaseUserFromToken(token) {
  const response = await axios.post(`${POCKETBASE_URL}/api/collections/users/auth-refresh`, {}, { headers: { Authorization: `Bearer ${token}` } });
  return response.data.record;
}

async function getAuthenticatedUser(req) {
  const token = String(req.headers.authorization || "").replace("Bearer ", "").trim();
  if (!token) { const e = new Error("User not authenticated"); e.statusCode = 401; throw e; }
  if (!POCKETBASE_URL) { const e = new Error("POCKETBASE_URL is missing"); e.statusCode = 500; throw e; }
  const user = await getPocketBaseUserFromToken(token);
  if (!user?.id) { const e = new Error("Invalid user token"); e.statusCode = 401; throw e; }
  return { user, token };
}

async function requireAdmin(req) {
  const ctx = await getAuthenticatedUser(req);
  if (ctx.user.role !== "admin") { const e = new Error("Only admins can perform this action"); e.statusCode = 403; throw e; }
  return ctx;
}
async function requireAdminOrInstructor(req) {
  const ctx = await getAuthenticatedUser(req);
  if (ctx.user.role !== "admin" && ctx.user.role !== "instructor") { const e = new Error("Only admins or instructors can perform this action"); e.statusCode = 403; throw e; }
  return ctx;
}
function isAdminOrInstructor(user, session) { return user?.role === "admin" || user?.role === "instructor" || session?.instructor_id === user?.id; }

async function pocketBasePasswordLogin(email, password) {
  const response = await axios.post(`${POCKETBASE_URL}/api/collections/users/auth-with-password`, { identity: email, password });
  return response.data;
}
async function createPocketBaseStudent({ email, name, password }) {
  const response = await axios.post(`${POCKETBASE_URL}/api/collections/users/records`, { email, name, password, passwordConfirm: password, role: "student" });
  return response.data;
}

function createBackendEnrollment(db, { userId, userName, courseId, isDemo, accessGranted = true, demoExpiry = null, planId = null }) {
  const key = backendEnrollmentKey(courseId, userId, isDemo ? "demo" : "paid");
  const previous = db.enrollments[key] || {};
  db.enrollments[key] = {
    ...previous,
    id: key,
    backend_owned: true,
    user_id: userId,
    user_name: userName || previous.user_name || "Student",
    course_id: courseId,
    plan_id: planId || previous.plan_id || null,
    access_granted: Boolean(accessGranted),
    is_demo: Boolean(isDemo),
    demo_expiry: demoExpiry,
    progress_percentage: previous.progress_percentage || 0,
    created_at: previous.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return db.enrollments[key];
}
function getBackendEnrollment(db, { userId, courseId }) {
  const paid = db.enrollments[backendEnrollmentKey(courseId, userId, "paid")];
  if (paid?.access_granted) return paid;
  const demo = db.enrollments[backendEnrollmentKey(courseId, userId, "demo")];
  if (demo?.access_granted) return demo;
  return null;
}
function isDemoEnrollmentActive(enrollment, demoSettings) {
  if (!enrollment?.is_demo) return true;
  if (!demoSettings.enabled) return false;
  if (!enrollment.demo_expiry) return true;
  return new Date(`${enrollment.demo_expiry}T23:59:59`).getTime() >= Date.now();
}
async function getEnrollmentForCourse({ userId, courseId }) {
  const db = await readLiveDb();
  return getBackendEnrollment(db, { userId, courseId });
}

async function getZoomAccessToken() {
  const response = await axios.post(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${process.env.ZOOM_ACCOUNT_ID}`,
    {},
    { headers: { Authorization: "Basic " + Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString("base64") } }
  );
  return response.data.access_token;
}
async function fetchPocketBaseSession(sessionId, token) {
  const response = await axios.get(`${POCKETBASE_URL}/api/collections/live_sessions/records/${sessionId}`, { headers: { Authorization: `Bearer ${token}` } });
  return response.data;
}
async function createZoomMeetingForLiveSession(session, timezone = DEFAULT_TIMEZONE) {
  const accessToken = await getZoomAccessToken();
  const start = getSessionStartUtc(session.scheduled_date, session.scheduled_time, timezone);
  if (!start) throw new Error("Session scheduled date/time is invalid");
  const response = await axios.post("https://api.zoom.us/v2/users/me/meetings", {
    topic: session.topic || "Live Class", type: 2, start_time: start.toISOString(), duration: DEFAULT_ZOOM_DURATION_MINUTES, timezone,
    settings: { host_video: true, participant_video: true, join_before_host: false, waiting_room: true, auto_recording: "cloud" },
  }, { headers: { Authorization: `Bearer ${accessToken}` } });
  return response.data;
}

function stripVttToText(vtt) {
  return String(vtt || "")
    .replace(/^WEBVTT.*$/gim, "")
    .replace(/^\d+$/gm, "")
    .replace(/\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}.*$/gm, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findTranscriptFile(recordingFiles = []) {
  return recordingFiles.find((file) => ["TRANSCRIPT", "CC", "VTT"].includes(String(file.file_type || "").toUpperCase())) ||
    recordingFiles.find((file) => String(file.file_extension || "").toLowerCase() === "vtt") || null;
}
function findVideoFile(recordingFiles = []) {
  return recordingFiles.find((file) => String(file.file_type || "").toUpperCase() === "MP4") || recordingFiles[0] || null;
}
async function downloadZoomTextFile(file, accessToken) {
  const url = file?.download_url || file?.play_url;
  if (!url) return "";
  const response = await axios.get(url, {
    responseType: "text",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return typeof response.data === "string" ? response.data : String(response.data || "");
}
function findSessionByMeetingIdInNotesOrRecordings(db, meetingId) {
  const key = String(meetingId || "");
  const rec = db.recordings[key] || null;
  if (rec?.session_id) return rec.session_id;
  const session = Object.values(db.liveSessions || {}).find((s) => String(s.zoom_meeting_id || "") === key);
  return session?.id || null;
}

function sanitizeRoadmapDay(day) {
  return {
    id: day.id, course_id: day.course_id, week_number: day.week_number, day_number: day.day_number, date: day.date,
    title: day.title, description: day.description || "", resources: day.resources || [], resource_links: day.resource_links || [],
    uworld_target: day.uworld_target || "", first_aid_topics: day.first_aid_topics || "", homework: day.homework || "",
    status: day.status || "scheduled", live_session_id: day.live_session_id || null, is_published: day.is_published !== false,
  };
}
function buildProgressSummary({ db, courseId, userId }) {
  const roadmap = db.roadmaps[String(courseId)] || null;
  const days = (roadmap?.days || []).filter((d) => d.is_published !== false);
  const progressItems = Object.values(db.roadmapProgress || {}).filter((p) => String(p.course_id) === String(courseId) && String(p.user_id) === String(userId));
  const completedIds = new Set(progressItems.filter((p) => p.completed).map((p) => p.day_id));
  const total = days.length;
  const completed = days.filter((d) => completedIds.has(d.id)).length;
  const today = todayKey();
  const todayDay = days.find((d) => d.date === today) || days.find((d) => !completedIds.has(d.id)) || days[0] || null;
  return {
    course_id: courseId,
    total_days: total,
    completed_days: completed,
    remaining_days: Math.max(0, total - completed),
    progress_percentage: total ? Math.round((completed / total) * 100) : 0,
    current_week: todayDay?.week_number || null,
    current_day: todayDay?.day_number || null,
    today_day: todayDay ? sanitizeRoadmapDay(todayDay) : null,
  };
}
function getStudentAttempts(db, courseId, userId) {
  let attempts = [];
  for (const arr of Object.values(db.quizAttempts || {})) attempts = attempts.concat(arr || []);
  return attempts.filter((a) => String(a.course_id) === String(courseId) && String(a.user_id) === String(userId));
}
function performanceFromAttempts(attempts) {
  if (!attempts.length) return { attempts_count: 0, average_score: 0, best_score: 0, latest_score: 0, focus_areas: [] };
  const ps = attempts.map((a) => Number(a.percentage || 0));
  const topicScores = {};
  for (const a of attempts) { const t = a.topic || a.subject || "General"; (topicScores[t] ||= []).push(Number(a.percentage || 0)); }
  return {
    attempts_count: attempts.length,
    average_score: Math.round(ps.reduce((s, x) => s + x, 0) / ps.length),
    best_score: Math.max(...ps),
    latest_score: ps[ps.length - 1],
    focus_areas: Object.entries(topicScores).map(([name, scores]) => ({ name, score: Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) })).sort((a, b) => a.score - b.score).slice(0, 5),
  };
}
function updateLeaderboard(db, { courseId, userId, userName }) {
  const attendance = Object.values(db.attendance || {}).filter((a) => String(a.course_id) === String(courseId) && String(a.user_id) === String(userId));
  const attempts = getStudentAttempts(db, courseId, userId);
  const progress = buildProgressSummary({ db, courseId, userId });
  const attendancePoints = new Set(attendance.map((a) => a.session_id)).size * 10;
  const taskPoints = progress.completed_days * 5;
  const quizPoints = attempts.reduce((sum, a) => sum + Math.round(Number(a.percentage || 0) / 10), 0);
  const key = courseUserKey(courseId, userId);
  db.leaderboard[key] = { course_id: courseId, user_id: userId, user_name: userName || "Student", attendance_points: attendancePoints, task_points: taskPoints, quiz_points: quizPoints, total_points: attendancePoints + taskPoints + quizPoints, updated_at: new Date().toISOString() };
  return db.leaderboard[key];
}

function sanitizeAssessmentForStudent(assessment, attempt = null) {
  return {
    id: assessment.id, course_id: assessment.course_id, session_id: assessment.session_id || null, title: assessment.title,
    description: assessment.description || "", source_type: assessment.source_type || "manual_notes",
    question_count: (assessment.questions || []).length, duration_minutes: assessment.duration_minutes || null,
    is_published: Boolean(assessment.is_published), created_at: assessment.created_at || null, published_at: assessment.published_at || null,
    attempt_status: attempt ? "completed" : "not_started", attempt_score: attempt?.score ?? null, attempt_total: attempt?.total ?? null, attempt_percentage: attempt?.percentage ?? null,
  };
}
function sanitizeAssessmentForTaking(assessment) {
  return {
    id: assessment.id, course_id: assessment.course_id, session_id: assessment.session_id || null, title: assessment.title, description: assessment.description || "", duration_minutes: assessment.duration_minutes || null,
    questions: (assessment.questions || []).map((q, i) => ({ id: q.id || `q${i + 1}`, stem: q.stem, options: q.options || [], topic: q.topic || "General", difficulty: q.difficulty || "medium" })),
  };
}
function createDraftQuestions({ question_count = 10, topic = "Assessment" }) {
  const count = Math.max(1, Math.min(80, Number(question_count || 10)));
  return Array.from({ length: count }).map((_, i) => ({ id: `q${i + 1}`, stem: `Draft MCQ ${i + 1}: edit this question for ${topic}.`, options: ["Option A", "Option B", "Option C", "Option D"], correct_index: 0, explanation: "Add explanation before publishing.", topic, difficulty: "medium" }));
}
function gradeAssessment(assessment, answers = {}) {
  let score = 0;
  const graded = (assessment.questions || []).map((q, i) => {
    const id = q.id || `q${i + 1}`;
    const selected = answers[id];
    const correct = Number(q.correct_index);
    const ok = Number(selected) === correct;
    if (ok) score += 1;
    return { question_id: id, selected_index: selected ?? null, correct_index: correct, is_correct: ok, explanation: q.explanation || "", topic: q.topic || "General" };
  });
  const total = (assessment.questions || []).length;
  return { score, total, percentage: total ? Math.round((score / total) * 100) : 0, graded };
}

app.get("/", (req, res) => res.send("NextGen Backend Running"));
app.get("/health", async (req, res) => {
  const liveDbExists = await fs.access(LIVE_DB_PATH).then(() => true).catch(() => false);
  res.json({ success: true, message: "Backend running", data_dir: DATA_DIR, live_db_path: LIVE_DB_PATH, live_db_exists: liveDbExists });
});

async function verifyGoogleIdToken(idToken) {
  if (!process.env.GOOGLE_CLIENT_ID) { const e = new Error("GOOGLE_CLIENT_ID is missing"); e.statusCode = 500; throw e; }
  if (!idToken) { const e = new Error("Google ID token is required"); e.statusCode = 400; throw e; }
  const response = await axios.get("https://oauth2.googleapis.com/tokeninfo", { params: { id_token: idToken } });
  const profile = response.data;
  if (String(profile.aud) !== String(process.env.GOOGLE_CLIENT_ID)) { const e = new Error("Google token audience mismatch"); e.statusCode = 401; throw e; }
  if (String(profile.email_verified) !== "true") { const e = new Error("Google email is not verified"); e.statusCode = 401; throw e; }
  return { email: String(profile.email).toLowerCase(), name: profile.name || profile.given_name || String(profile.email).split("@")[0], picture: profile.picture || null, google_sub: profile.sub || null };
}
app.post("/auth/google", async (req, res) => {
  try {
    const profile = await verifyGoogleIdToken(req.body.id_token);
    const db = await readLiveDb();
    const existing = db.googleAuthUsers[profile.email];
    if (existing?.password) {
      const authData = await pocketBasePasswordLogin(profile.email, existing.password);
      return res.json({ success: true, token: authData.token, record: authData.record, created: false });
    }
    const generatedPassword = `NGG_${crypto.randomBytes(24).toString("hex")}_9aZ!`;
    const createdUser = await createPocketBaseStudent({ email: profile.email, name: profile.name, password: generatedPassword });
    const authData = await pocketBasePasswordLogin(profile.email, generatedPassword);
    db.googleAuthUsers[profile.email] = { email: profile.email, user_id: authData.record?.id || createdUser.id, password: generatedPassword, google_sub: profile.google_sub, name: profile.name, picture: profile.picture, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await writeLiveDb(db);
    res.json({ success: true, token: authData.token, record: authData.record, created: true });
  } catch (error) {
    console.error("Google auth error:", error.response?.data || error.message);
    res.status(error.statusCode || error.response?.status || 500).json({ success: false, error: error.response?.data?.error_description || error.response?.data?.message || error.message || "Google login failed", details: error.response?.data || null });
  }
});


// -----------------------------------------------------------------------------
// Backend-owned Courses, Live Sessions, and Announcements
// PocketBase is no longer used for these LMS records. It remains only for auth.
// -----------------------------------------------------------------------------

app.get("/courses", async (req, res) => {
  try {
    const db = await readLiveDb();
    let courses = Object.values(db.courses || {}).map(sanitizeCourse);
    if (req.query.status) courses = courses.filter((c) => String(c.status) === String(req.query.status));
    else courses = courses.filter((c) => c.status === "active");
    if (req.query.category) courses = courses.filter((c) => String(c.category) === String(req.query.category));
    courses.sort(sortNewestFirst);
    res.json({ success: true, count: courses.length, courses });
  } catch (e) { res.status(500).json({ success: false, error: e.message || "Failed to load courses" }); }
});

app.get("/courses/:courseId", async (req, res) => {
  try {
    const db = await readLiveDb();
    const course = db.courses[String(req.params.courseId)];
    if (!course || course.status === "archived") return res.status(404).json({ success: false, error: "Course not found" });
    res.json({ success: true, course: sanitizeCourse(course) });
  } catch (e) { res.status(500).json({ success: false, error: e.message || "Failed to load course" }); }
});

app.get("/admin/courses", async (req, res) => {
  try {
    await requireAdmin(req);
    const db = await readLiveDb();
    const courses = Object.values(db.courses || {}).map(sanitizeCourse).sort(sortNewestFirst);
    res.json({ success: true, count: courses.length, courses });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to load admin courses" }); }
});

app.post("/admin/courses", async (req, res) => {
  try {
    const { user } = await requireAdmin(req);
    const db = await readLiveDb();
    const id = uuid();
    const course = normalizeCoursePayload(req.body);
    course.id = id;
    course.created_by = user.id;
    course.created_at = new Date().toISOString();
    course.updated_at = new Date().toISOString();
    if (!course.name) return res.status(400).json({ success: false, error: "Course name is required" });
    if (!course.description) return res.status(400).json({ success: false, error: "Course description is required" });
    db.courses[id] = course;
    await writeLiveDb(db);
    res.json({ success: true, course: sanitizeCourse(course) });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to create course" }); }
});

app.patch("/admin/courses/:courseId", async (req, res) => {
  try {
    const { user } = await requireAdmin(req);
    const db = await readLiveDb();
    const existing = db.courses[String(req.params.courseId)];
    if (!existing) return res.status(404).json({ success: false, error: "Course not found" });
    const course = normalizeCoursePayload(req.body, existing);
    course.id = existing.id;
    course.created_by = existing.created_by || user.id;
    course.created_at = existing.created_at || new Date().toISOString();
    course.updated_by = user.id;
    course.updated_at = new Date().toISOString();
    if (!course.name) return res.status(400).json({ success: false, error: "Course name is required" });
    db.courses[course.id] = course;
    await writeLiveDb(db);
    res.json({ success: true, course: sanitizeCourse(course) });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to update course" }); }
});

app.delete("/admin/courses/:courseId", async (req, res) => {
  try {
    await requireAdmin(req);
    const db = await readLiveDb();
    const course = db.courses[String(req.params.courseId)];
    if (!course) return res.status(404).json({ success: false, error: "Course not found" });
    delete db.courses[String(req.params.courseId)];
    await writeLiveDb(db);
    res.json({ success: true, deleted_course: sanitizeCourse(course) });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to delete course" }); }
});

app.get("/live-sessions", async (req, res) => {
  try {
    const db = await readLiveDb();
    let sessions = Object.values(db.liveSessions || {}).map(sanitizeLiveSession);
    if (req.query.course_id) sessions = sessions.filter((s) => String(s.course_id) === String(req.query.course_id));
    if (req.query.status) sessions = sessions.filter((s) => String(s.status) === String(req.query.status));
    sessions.sort((a, b) => String(a.scheduled_date || "").localeCompare(String(b.scheduled_date || "")) || String(a.scheduled_time || "").localeCompare(String(b.scheduled_time || "")));
    res.json({ success: true, count: sessions.length, sessions });
  } catch (e) { res.status(500).json({ success: false, error: e.message || "Failed to load live sessions" }); }
});

app.get("/live-sessions/:sessionId", async (req, res) => {
  try {
    const db = await readLiveDb();
    const session = db.liveSessions[String(req.params.sessionId)];
    if (!session) return res.status(404).json({ success: false, error: "Live session not found" });
    res.json({ success: true, session: sanitizeLiveSession(session) });
  } catch (e) { res.status(500).json({ success: false, error: e.message || "Failed to load live session" }); }
});

app.get("/admin/live-sessions", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    let sessions = Object.values(db.liveSessions || {}).map(sanitizeLiveSession);
    if (req.query.course_id) sessions = sessions.filter((s) => String(s.course_id) === String(req.query.course_id));
    sessions.sort((a, b) => String(a.scheduled_date || "").localeCompare(String(b.scheduled_date || "")) || String(a.scheduled_time || "").localeCompare(String(b.scheduled_time || "")));
    res.json({ success: true, count: sessions.length, sessions });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to load admin live sessions" }); }
});

app.post("/admin/live-sessions", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const id = uuid();
    const session = normalizeLiveSessionPayload(req.body);
    session.id = id;
    session.created_by = user.id;
    session.created_at = new Date().toISOString();
    session.updated_at = new Date().toISOString();
    if (!session.course_id) return res.status(400).json({ success: false, error: "course_id is required" });
    if (!session.topic) return res.status(400).json({ success: false, error: "Session topic is required" });
    db.liveSessions[id] = session;
    await writeLiveDb(db);
    res.json({ success: true, session: sanitizeLiveSession(session) });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to create live session" }); }
});

app.patch("/admin/live-sessions/:sessionId", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const existing = db.liveSessions[String(req.params.sessionId)];
    if (!existing) return res.status(404).json({ success: false, error: "Live session not found" });
    const session = normalizeLiveSessionPayload(req.body, existing);
    session.id = existing.id;
    session.created_by = existing.created_by || user.id;
    session.created_at = existing.created_at || new Date().toISOString();
    session.updated_by = user.id;
    session.updated_at = new Date().toISOString();
    db.liveSessions[session.id] = session;
    await writeLiveDb(db);
    res.json({ success: true, session: sanitizeLiveSession(session) });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to update live session" }); }
});

app.delete("/admin/live-sessions/:sessionId", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const session = db.liveSessions[String(req.params.sessionId)];
    if (!session) return res.status(404).json({ success: false, error: "Live session not found" });
    delete db.liveSessions[String(req.params.sessionId)];
    await writeLiveDb(db);
    res.json({ success: true, deleted_session: sanitizeLiveSession(session) });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to delete live session" }); }
});

app.get("/announcements", async (req, res) => {
  try {
    const db = await readLiveDb();
    let announcements = Object.values(db.announcements || {}).map(sanitizeAnnouncement).filter((a) => a.status === "active");
    if (req.query.course_id) announcements = announcements.filter((a) => !a.course_id || String(a.course_id) === String(req.query.course_id));
    announcements.sort(sortNewestFirst);
    res.json({ success: true, count: announcements.length, announcements });
  } catch (e) { res.status(500).json({ success: false, error: e.message || "Failed to load announcements" }); }
});

app.get("/admin/announcements", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const announcements = Object.values(db.announcements || {}).map(sanitizeAnnouncement).sort(sortNewestFirst);
    res.json({ success: true, count: announcements.length, announcements });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to load admin announcements" }); }
});

app.post("/admin/announcements", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const id = uuid();
    const item = { id, title: String(req.body.title || "").trim(), content: String(req.body.content || "").trim(), course_id: req.body.course_id || null, status: req.body.status || "active", created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (!item.title) return res.status(400).json({ success: false, error: "Announcement title is required" });
    if (!item.content) return res.status(400).json({ success: false, error: "Announcement content is required" });
    db.announcements[id] = item;
    await writeLiveDb(db);
    res.json({ success: true, announcement: sanitizeAnnouncement(item) });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to create announcement" }); }
});

app.patch("/admin/announcements/:announcementId", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const item = db.announcements[String(req.params.announcementId)];
    if (!item) return res.status(404).json({ success: false, error: "Announcement not found" });
    for (const key of ["title", "content", "course_id", "status"]) if (req.body[key] !== undefined) item[key] = req.body[key];
    item.title = String(item.title || "").trim();
    item.content = String(item.content || "").trim();
    item.updated_by = user.id;
    item.updated_at = new Date().toISOString();
    await writeLiveDb(db);
    res.json({ success: true, announcement: sanitizeAnnouncement(item) });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to update announcement" }); }
});

app.delete("/admin/announcements/:announcementId", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const item = db.announcements[String(req.params.announcementId)];
    if (!item) return res.status(404).json({ success: false, error: "Announcement not found" });
    delete db.announcements[String(req.params.announcementId)];
    await writeLiveDb(db);
    res.json({ success: true, deleted_announcement: sanitizeAnnouncement(item) });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to delete announcement" }); }
});

app.get("/demo/settings", async (req, res) => { const db = await readLiveDb(); res.json({ success: true, demo_settings: { ...DEFAULT_DEMO_SETTINGS, ...(db.demoSettings || {}) } }); });
app.get("/admin/demo/settings", async (req, res) => { try { await requireAdmin(req); const db = await readLiveDb(); res.json({ success: true, demo_settings: { ...DEFAULT_DEMO_SETTINGS, ...(db.demoSettings || {}) } }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.patch("/admin/demo/settings", async (req, res) => {
  try {
    const { user } = await requireAdmin(req);
    const db = await readLiveDb();
    const allowed = ["enabled", "duration_days", "allow_live_classes", "allow_roadmap", "allow_community", "allow_assessments", "allow_leaderboard", "allow_recordings", "allow_notes_transcripts", "allow_video_library", "max_live_sessions"];
    const updates = {};
    for (const k of allowed) if (req.body[k] !== undefined) updates[k] = req.body[k];
    if (updates.duration_days !== undefined) updates.duration_days = Math.max(1, Number(updates.duration_days || 2));
    db.demoSettings = { ...DEFAULT_DEMO_SETTINGS, ...(db.demoSettings || {}), ...updates, updated_by: user.id, updated_at: new Date().toISOString() };
    await writeLiveDb(db);
    res.json({ success: true, demo_settings: db.demoSettings });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); }
});

app.get("/features", async (req, res) => { const db = await readLiveDb(); res.json({ success: true, features: Object.values(db.featureCatalog || {}) }); });
app.get("/plans", async (req, res) => {
  const db = await readLiveDb();
  let plans = Object.values(db.plans || {}).filter((p) => p.is_active !== false).map(sanitizePlan);
  if (req.query.course_id) plans = plans.filter((p) => !p.course_id || String(p.course_id) === String(req.query.course_id));
  plans.sort((a, b) => a.price_cents - b.price_cents);
  res.json({ success: true, count: plans.length, plans, features: Object.values(db.featureCatalog || {}) });
});
app.get("/admin/plans", async (req, res) => { try { await requireAdmin(req); const db = await readLiveDb(); res.json({ success: true, plans: Object.values(db.plans || {}).map(sanitizePlan), features: Object.values(db.featureCatalog || {}) }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.post("/admin/plans", async (req, res) => {
  try {
    const { user } = await requireAdmin(req);
    const db = await readLiveDb();
    const id = uuid();
    const plan = { id, name: String(req.body.name || "").trim(), description: req.body.description || "", price_cents: req.body.price_cents !== undefined ? Number(req.body.price_cents) : centsFromDollars(req.body.price), currency: String(req.body.currency || "usd").toLowerCase(), billing_type: req.body.billing_type || "one_time", course_id: req.body.course_id || null, included_features: Array.isArray(req.body.included_features) ? req.body.included_features : [], access_days: req.body.access_days || null, is_active: req.body.is_active !== false, is_featured: Boolean(req.body.is_featured), created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (!plan.name) return res.status(400).json({ success: false, error: "Plan name is required" });
    if (Number.isNaN(plan.price_cents) || plan.price_cents < 0) return res.status(400).json({ success: false, error: "Plan price is invalid" });
    db.plans[id] = plan; await writeLiveDb(db); res.json({ success: true, plan: sanitizePlan(plan) });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); }
});
app.patch("/admin/plans/:planId", async (req, res) => {
  try { await requireAdmin(req); const db = await readLiveDb(); const p = db.plans[req.params.planId]; if (!p) return res.status(404).json({ success: false, error: "Plan not found" }); const allowed = ["name", "description", "price_cents", "currency", "billing_type", "course_id", "included_features", "access_days", "is_active", "is_featured"]; for (const k of allowed) if (req.body[k] !== undefined) p[k] = req.body[k]; if (p.price_cents !== undefined) p.price_cents = Number(p.price_cents); p.updated_at = new Date().toISOString(); await writeLiveDb(db); res.json({ success: true, plan: sanitizePlan(p) }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); }
});
app.delete("/admin/plans/:planId", async (req, res) => { try { await requireAdmin(req); const db = await readLiveDb(); const p = db.plans[req.params.planId]; if (!p) return res.status(404).json({ success: false, error: "Plan not found" }); delete db.plans[req.params.planId]; await writeLiveDb(db); res.json({ success: true, deleted_plan: sanitizePlan(p), message: "Plan deleted. Students/enrollments are not deleted." }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });

app.get("/admin/coupons", async (req, res) => { try { await requireAdmin(req); const db = await readLiveDb(); res.json({ success: true, coupons: Object.values(db.coupons || {}).map(sanitizeCoupon) }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.post("/admin/coupons", async (req, res) => {
  try {
    const { user } = await requireAdmin(req); const db = await readLiveDb(); const code = normalizeCouponCode(req.body.code);
    if (!code) return res.status(400).json({ success: false, error: "Coupon code is required" });
    if (Object.values(db.coupons || {}).some((c) => c.code === code)) return res.status(400).json({ success: false, error: "Coupon already exists" });
    const id = uuid(); const coupon = { id, code, description: req.body.description || "", discount_type: req.body.discount_type || "percentage", discount_value: Number(req.body.discount_value || 0), max_uses: req.body.max_uses ? Number(req.body.max_uses) : null, used_count: 0, expires_at: req.body.expires_at || null, course_id: req.body.course_id || null, plan_id: req.body.plan_id || null, is_active: req.body.is_active !== false, created_by: user.id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (!coupon.discount_value || coupon.discount_value <= 0) return res.status(400).json({ success: false, error: "Discount value is required" });
    db.coupons[id] = coupon; await writeLiveDb(db); res.json({ success: true, coupon: sanitizeCoupon(coupon) });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); }
});
app.patch("/admin/coupons/:couponId", async (req, res) => { try { await requireAdmin(req); const db = await readLiveDb(); const c = db.coupons[req.params.couponId]; if (!c) return res.status(404).json({ success: false, error: "Coupon not found" }); const allowed = ["description", "discount_type", "discount_value", "max_uses", "expires_at", "course_id", "plan_id", "is_active"]; for (const k of allowed) if (req.body[k] !== undefined) c[k] = req.body[k]; if (c.discount_value !== undefined) c.discount_value = Number(c.discount_value); c.updated_at = new Date().toISOString(); await writeLiveDb(db); res.json({ success: true, coupon: sanitizeCoupon(c) }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.delete("/admin/coupons/:couponId", async (req, res) => { try { await requireAdmin(req); const db = await readLiveDb(); const c = db.coupons[req.params.couponId]; if (!c) return res.status(404).json({ success: false, error: "Coupon not found" }); delete db.coupons[req.params.couponId]; await writeLiveDb(db); res.json({ success: true, deleted_coupon: sanitizeCoupon(c) }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.post("/coupons/validate", async (req, res) => { const db = await readLiveDb(); const plan = db.plans[req.body.plan_id]; if (!plan || plan.is_active === false) return res.status(404).json({ success: false, error: "Plan not found or inactive" }); const code = normalizeCouponCode(req.body.coupon_code); const coupon = code ? Object.values(db.coupons || {}).find((c) => c.code === code) : null; if (code && !coupon) return res.status(400).json({ success: false, valid: false, error: "Coupon not found" }); const pricing = buildCheckoutPricing({ plan, coupon, courseId: req.body.course_id }); if (!pricing.valid) return res.status(400).json({ success: false, valid: false, error: pricing.error }); res.json({ success: true, valid: true, coupon: coupon ? sanitizeCoupon(coupon) : null, pricing }); });

app.post("/demo/start", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { course_id } = req.body;
    if (!course_id) return res.status(400).json({ success: false, error: "course_id is required" });
    const db = await readLiveDb(); const settings = { ...DEFAULT_DEMO_SETTINGS, ...(db.demoSettings || {}) };
    if (!settings.enabled) return res.status(403).json({ success: false, error: "Demo access is disabled" });
    const paid = db.enrollments[backendEnrollmentKey(course_id, user.id, "paid")];
    if (paid?.access_granted) return res.json({ success: true, already_paid: true, enrollment: paid, message: "You already have full access", source: "backend" });
    const demoExpiry = dateOnly(addDays(new Date(), Number(settings.duration_days || 2)));
    const enrollment = createBackendEnrollment(db, { userId: user.id, userName: user.name || user.email || "Student", courseId: course_id, isDemo: true, accessGranted: true, demoExpiry });
    await writeLiveDb(db);
    res.json({ success: true, enrollment, demo_settings: settings, demo_expiry: demoExpiry, created: true, source: "backend", message: "Demo access granted" });
  } catch (e) { res.status(e.statusCode || e.response?.status || 500).json({ success: false, error: e.response?.data?.message || e.message || "Failed to start demo", details: e.response?.data || null }); }
});
app.post("/enrollments/prepare-checkout", async (req, res) => {
  try { const { user } = await getAuthenticatedUser(req); const { course_id } = req.body; if (!course_id) return res.status(400).json({ success: false, error: "course_id is required" }); const db = await readLiveDb(); const enrollment = createBackendEnrollment(db, { userId: user.id, userName: user.name || user.email || "Student", courseId: course_id, isDemo: false, accessGranted: false }); await writeLiveDb(db); res.json({ success: true, enrollment, created: true, source: "backend" }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); }
});
app.get("/enrollments/status", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req); const courseId = req.query.course_id; if (!courseId) return res.status(400).json({ success: false, error: "course_id is required" });
    const db = await readLiveDb(); const settings = { ...DEFAULT_DEMO_SETTINGS, ...(db.demoSettings || {}) }; const paid = db.enrollments[backendEnrollmentKey(courseId, user.id, "paid")]; const demo = db.enrollments[backendEnrollmentKey(courseId, user.id, "demo")];
    if (paid?.access_granted) return res.json({ success: true, status: "paid", enrollment: paid, demo_expiry: null, source: "backend" });
    if (demo?.access_granted) return res.json({ success: true, status: isDemoEnrollmentActive(demo, settings) ? "demo_active" : "demo_expired", enrollment: demo, demo_expiry: demo.demo_expiry || null, source: "backend" });
    res.json({ success: true, status: "none", enrollment: null, demo_expiry: null, source: "backend" });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); }
});
app.post("/stripe/create-checkout", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const { enrollmentId, studentId, courseId, plan_id = null, coupon_code = null, successUrl, cancelUrl, amount } = req.body;
    if (!enrollmentId || !studentId || !courseId) return res.status(400).json({ success: false, error: "enrollmentId, studentId, courseId required" });
    if (String(user.id) !== String(studentId) && user.role !== "admin") return res.status(403).json({ success: false, error: "Checkout user mismatch" });
    const db = await readLiveDb();
    let plan = plan_id ? db.plans[plan_id] : Object.values(db.plans || {}).filter((p) => p.is_active !== false && (!p.course_id || String(p.course_id) === String(courseId))).sort((a, b) => Number(a.price_cents || 0) - Number(b.price_cents || 0))[0];
    if (!plan) plan = { id: "legacy_course_price", name: "NextGen Enrollment", description: "Course enrollment", price_cents: Math.round(Number(amount || 0) * 100), currency: "usd", billing_type: "one_time", course_id: courseId, included_features: [], is_active: true };
    if (plan.is_active === false) return res.status(404).json({ success: false, error: "Plan not found or inactive" });
    const code = normalizeCouponCode(coupon_code); const coupon = code ? Object.values(db.coupons || {}).find((c) => c.code === code) : null; const pricing = buildCheckoutPricing({ plan, coupon, courseId }); if (!pricing.valid) return res.status(400).json({ success: false, error: pricing.error });
    if (pricing.final_amount_cents <= 0) {
      const enrollment = createBackendEnrollment(db, { userId: studentId, userName: user.name || user.email || "Student", courseId, isDemo: false, accessGranted: true, planId: plan.id });
      if (coupon?.id) { coupon.used_count = Number(coupon.used_count || 0) + 1; coupon.updated_at = new Date().toISOString(); db.couponRedemptions[uuid()] = { id: uuid(), coupon_id: coupon.id, coupon_code: coupon.code, plan_id: plan.id, enrollment_id: enrollment.id, student_id: studentId, course_id: courseId, original_amount_cents: pricing.original_amount_cents, discount_cents: pricing.discount_cents, final_amount_cents: 0, redeemed_at: new Date().toISOString() }; }
      await writeLiveDb(db);
      return res.json({ success: true, free_checkout: true, url: null, plan: sanitizePlan(plan), pricing, access_grant: { granted: true, method: "backend_enrollment_granted", enrollment_id: enrollment.id }, message: "Access granted without Stripe checkout." });
    }
    const session = await stripe.checkout.sessions.create({ mode: "payment", payment_method_types: ["card"], line_items: [{ price_data: { currency: plan.currency || "usd", product_data: { name: plan.name, description: plan.description || "Course enrollment" }, unit_amount: pricing.final_amount_cents }, quantity: 1 }], metadata: { enrollmentId, studentId, courseId, planId: plan.id, couponCode: coupon?.code || "", originalAmountCents: String(pricing.original_amount_cents), discountCents: String(pricing.discount_cents), finalAmountCents: String(pricing.final_amount_cents) }, success_url: successUrl || "https://live.nextgenusmlelms.com/payment-success", cancel_url: cancelUrl || "https://live.nextgenusmlelms.com/payment-cancel" });
    res.json({ success: true, free_checkout: false, url: session.url, plan: sanitizePlan(plan), pricing });
  } catch (e) { res.status(e.statusCode || e.response?.status || 500).json({ success: false, error: e.response?.data?.message || e.message || "Checkout failed", details: e.response?.data || null }); }
});

app.get("/hcgi/api/live-class/:sessionId", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    let session = db.liveSessions[String(req.params.sessionId)] || null;
    if (!session?.id) return res.status(404).json({ allowed: false, error: "Session not found" });

    const courseId = session.course_id;
    const enrollment = getBackendEnrollment(db, { userId: user.id, courseId });
    let allowed = false;
    let reason = "You don't have access to this session";

    if (isAdminOrInstructor(user, session)) allowed = true;
    else if (enrollment?.id) {
      if (enrollment.is_demo) {
        if (!isDemoEnrollmentActive(enrollment, db.demoSettings)) reason = "Demo access is expired or disabled";
        else if (!db.demoSettings.allow_live_classes) reason = "Live classes are not available in demo access";
        else allowed = true;
      } else allowed = true;
    }

    if (!allowed) return res.json({ allowed: false, reason });
    if (session.status === "cancelled") return res.json({ allowed: true, can_join: false, join_reason: "This session has been cancelled.", session: sanitizeLiveSession(session) });

    const start = getSessionStartUtc(session.scheduled_date, session.scheduled_time, session.scheduled_timezone || DEFAULT_TIMEZONE);
    let canJoin = false;
    let joinReason = null;
    let joinOpensAt = null;

    if (!start) joinReason = "Session date/time is not configured correctly";
    else if (session.status === "completed") joinReason = "Session is completed";
    else {
      const openAt = new Date(start.getTime() - 60 * 1000);
      joinOpensAt = openAt.toISOString();
      canJoin = Date.now() >= openAt.getTime();
      if (!canJoin) joinReason = "Classroom opens 1 minute before class starts";
    }

    if (canJoin && !hasRealZoomMeetingId(session.zoom_meeting_id) && isAdminOrInstructor(user, session)) {
      const meeting = await createZoomMeetingForLiveSession(session, session.scheduled_timezone || DEFAULT_TIMEZONE);
      session.zoom_meeting_id = String(meeting.id);
      session.meeting_password = meeting.password || "pending";
      session.zoom_meeting_url = meeting.join_url || "pending";
      session.status = session.status || "scheduled";
      session.updated_by = user.id;
      session.updated_at = new Date().toISOString();
      db.liveSessions[session.id] = session;
      db.recordings[String(meeting.id)] = { ...(db.recordings[String(meeting.id)] || {}), meeting_id: String(meeting.id), session_id: session.id, course_id: courseId, topic: session.topic, published: false, created_at: new Date().toISOString() };
      await writeLiveDb(db);
    }

    const hasZoom = hasRealZoomMeetingId(session.zoom_meeting_id);
    res.json({
      allowed: true,
      can_join: canJoin && hasZoom,
      join_reason: canJoin && hasZoom ? "Classroom is open" : joinReason || "Waiting for tutor to open classroom",
      join_opens_at: joinOpensAt,
      session: {
        id: session.id,
        topic: session.topic,
        zoom_meeting_id: canJoin && hasZoom ? session.zoom_meeting_id : null,
        meeting_password: canJoin && hasZoom ? session.meeting_password : null,
        scheduled_date: session.scheduled_date,
        scheduled_time: session.scheduled_time,
        scheduled_timezone: session.scheduled_timezone || DEFAULT_TIMEZONE,
        course_id: courseId,
        instructor_id: session.instructor_id || null,
        instructor_name: session.instructor_name || null,
        status: session.status || "scheduled",
        zoom_join_url: canJoin && hasZoom ? session.zoom_meeting_url : null,
        recording_url: session.recording_url || null,
      },
    });
  } catch (e) { res.status(e.statusCode || e.response?.status || 500).json({ allowed: false, error: e.response?.data?.message || e.message || "Failed to load live classroom", details: e.response?.data || null }); }
});

app.get("/zoom/zak", async (req, res) => { try { const token = await getZoomAccessToken(); const response = await axios.get("https://api.zoom.us/v2/users/me/token?type=zak", { headers: { Authorization: `Bearer ${token}` } }); res.json({ zak: response.data.token }); } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); } });
app.post("/zoom/generate-signature", async (req, res) => { try { const { meetingNumber, role } = req.body; const iat = Math.round(Date.now() / 1000) - 30; const exp = iat + 60 * 60 * 2; const signature = jwt.sign({ sdkKey: process.env.ZOOM_MEETING_SDK_KEY, mn: meetingNumber, role, iat, exp, appKey: process.env.ZOOM_MEETING_SDK_KEY, tokenExp: exp }, process.env.ZOOM_MEETING_SDK_SECRET, { algorithm: "HS256" }); res.json({ signature }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post("/zoom/create-meeting", async (req, res) => { try { const token = await getZoomAccessToken(); const response = await axios.post("https://api.zoom.us/v2/users/me/meetings", { topic: req.body.topic, type: 2, start_time: req.body.start_time, duration: req.body.duration || DEFAULT_ZOOM_DURATION_MINUTES, timezone: req.body.timezone || DEFAULT_TIMEZONE, settings: { host_video: true, participant_video: true, join_before_host: false, waiting_room: true, auto_recording: "cloud" } }, { headers: { Authorization: `Bearer ${token}` } }); res.json({ success: true, meeting: response.data }); } catch (e) { res.status(500).json({ success: false, error: e.response?.data || e.message }); } });

app.post("/zoom/webhook", async (req, res) => {
  try {
    const event = req.body.event;
    if (event === "endpoint.url_validation") {
      const plainToken = req.body.payload.plainToken;
      const encryptedToken = crypto.createHmac("sha256", process.env.ZOOM_WEBHOOK_SECRET_TOKEN).update(plainToken).digest("hex");
      return res.status(200).json({ plainToken, encryptedToken });
    }
    if (event === "recording.completed") {
      const object = req.body.payload.object;
      const files = object.recording_files || [];
      const videoFile = findVideoFile(files);
      const transcriptFile = findTranscriptFile(files);
      const meetingId = String(object.id);
      const db = await readLiveDb();
      let transcriptText = ""; let transcriptRaw = ""; let transcriptImportError = null;
      if (transcriptFile) {
        try { const accessToken = await getZoomAccessToken(); transcriptRaw = await downloadZoomTextFile(transcriptFile, accessToken); transcriptText = stripVttToText(transcriptRaw); } catch (e) { transcriptImportError = e.response?.data || e.message; console.warn("Zoom transcript import failed:", transcriptImportError); }
      }
      const previous = db.recordings[meetingId] || {};
      const recordingPayload = { ...previous, meeting_id: meetingId, uuid: object.uuid, topic: object.topic, start_time: object.start_time, duration: object.duration, share_url: object.share_url || previous.share_url || null, recording_url: videoFile?.play_url || object.share_url || videoFile?.download_url || previous.recording_url || null, download_url: videoFile?.download_url || previous.download_url || null, transcript_url: transcriptFile?.download_url || transcriptFile?.play_url || previous.transcript_url || null, transcript_imported: Boolean(transcriptText), transcript_import_error: transcriptImportError, file_type: videoFile?.file_type || previous.file_type || null, recording_type: videoFile?.recording_type || previous.recording_type || null, status: videoFile?.status || previous.status || null, published: Boolean(previous.published), received_at: new Date().toISOString() };
      db.recordings[meetingId] = recordingPayload;
      const sessionId = previous.session_id || findSessionByMeetingIdInNotesOrRecordings(db, meetingId) || null;
      if (sessionId) {
        db.notes[sessionId] = { ...(db.notes[sessionId] || {}), session_id: sessionId, course_id: previous.course_id || db.notes[sessionId]?.course_id || null, notes: db.notes[sessionId]?.notes || "", transcript_text: transcriptText || db.notes[sessionId]?.transcript_text || "", transcript_raw_vtt: transcriptRaw || db.notes[sessionId]?.transcript_raw_vtt || "", transcript_url: recordingPayload.transcript_url, recording_url: recordingPayload.recording_url, meeting_id: meetingId, source: transcriptText ? "zoom_transcript" : db.notes[sessionId]?.source || "manual", auto_imported: Boolean(transcriptText), updated_at: new Date().toISOString() };
      }
      await writeLiveDb(db);
      return res.status(200).json({ received: true, saved: true, transcript_imported: Boolean(transcriptText), session_id: sessionId });
    }
    res.status(200).json({ received: true });
  } catch (e) { console.error("Zoom webhook error:", e.response?.data || e.message); res.status(200).json({ success: false, error: e.response?.data || e.message }); }
});

app.get("/zoom/recordings", async (req, res) => { try { const token = await getZoomAccessToken(); const to = todayKey(); const from = todayKey(addDays(new Date(), -30)); const response = await axios.get(`https://api.zoom.us/v2/users/me/recordings?from=${from}&to=${to}&page_size=100`, { headers: { Authorization: `Bearer ${token}` } }); const db = await readLiveDb(); const recordings = (response.data?.meetings || []).flatMap((m) => (m.recording_files || []).filter((f) => f.file_type === "MP4").map((f) => sanitizePublicRecording({ ...(db.recordings[String(m.id)] || {}), meeting_id: String(m.id), uuid: m.uuid, topic: m.topic, start_time: m.start_time, duration: m.duration, share_url: m.share_url, recording_url: f.play_url || m.share_url || f.download_url, download_url: f.download_url, file_type: f.file_type, recording_type: f.recording_type, status: f.status }))); res.json({ success: true, from, to, count: recordings.length, recordings }); } catch (e) { res.status(500).json({ success: false, error: e.response?.data || e.message }); } });
app.post("/live/recordings/publish", async (req, res) => { try { const { user } = await requireAdminOrInstructor(req); const db = await readLiveDb(); const key = String(req.body.meeting_id); if (!key) return res.status(400).json({ success: false, error: "meeting_id is required" }); db.recordings[key] = { ...(db.recordings[key] || {}), meeting_id: key, session_id: req.body.session_id || db.recordings[key]?.session_id || null, course_id: req.body.course_id || db.recordings[key]?.course_id || null, topic: req.body.topic || db.recordings[key]?.topic || null, recording_url: req.body.recording_url || db.recordings[key]?.recording_url || null, share_url: req.body.share_url || db.recordings[key]?.share_url || null, published: req.body.published !== false, published_at: new Date().toISOString(), published_by: user.id }; await writeLiveDb(db); res.json({ success: true, recording: db.recordings[key] }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.post("/live/recordings/unpublish", async (req, res) => { try { await requireAdminOrInstructor(req); const db = await readLiveDb(); const key = String(req.body.meeting_id); db.recordings[key] = { ...(db.recordings[key] || {}), meeting_id: key, published: false, unpublished_at: new Date().toISOString() }; await writeLiveDb(db); res.json({ success: true, recording: db.recordings[key] }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.get("/live/recordings/published", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); const db = await readLiveDb(); if (req.query.course_id) { const e = getBackendEnrollment(db, { userId: user.id, courseId: req.query.course_id }); if (e?.is_demo && !db.demoSettings.allow_recordings) return res.json({ success: true, count: 0, recordings: [], demo_restricted: true }); } let recordings = Object.values(db.recordings || {}).filter((r) => r.published); if (req.query.course_id) recordings = recordings.filter((r) => String(r.course_id || "") === String(req.query.course_id)); res.json({ success: true, count: recordings.length, recordings: recordings.map(sanitizePublicRecording) }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });

app.post("/live/notes/:sessionId", async (req, res) => { try { const { user } = await requireAdminOrInstructor(req); const db = await readLiveDb(); const sessionId = req.params.sessionId; db.notes[sessionId] = { ...(db.notes[sessionId] || {}), session_id: sessionId, course_id: req.body.course_id || db.notes[sessionId]?.course_id || null, notes: String(req.body.notes || ""), transcript_url: req.body.transcript_url || db.notes[sessionId]?.transcript_url || null, transcript_text: req.body.transcript_text !== undefined ? String(req.body.transcript_text || "") : db.notes[sessionId]?.transcript_text || "", updated_by: user.id, updated_at: new Date().toISOString() }; await writeLiveDb(db); res.json({ success: true, notes: db.notes[sessionId] }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.get("/live/notes/:sessionId", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); const db = await readLiveDb(); const notes = db.notes[req.params.sessionId] || null; if (notes?.course_id) { const e = getBackendEnrollment(db, { userId: user.id, courseId: notes.course_id }); if (e?.is_demo && !db.demoSettings.allow_notes_transcripts) return res.json({ success: true, notes: null, demo_restricted: true }); } res.json({ success: true, notes }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });

app.post("/live/attendance/mark", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); const db = await readLiveDb(); const { session_id, course_id, source = "classroom_opened" } = req.body; if (!session_id || !course_id) return res.status(400).json({ success: false, error: "session_id and course_id are required" }); const e = getBackendEnrollment(db, { userId: user.id, courseId: course_id }); if (!e && user.role !== "admin" && user.role !== "instructor") return res.status(403).json({ success: false, error: "No course access found" }); const key = `${user.id}:${session_id}`; db.attendance[key] = { id: key, user_id: user.id, user_name: user.name || user.email || "Student", session_id, course_id, date: todayKey(), source, marked_at: new Date().toISOString() }; const leaderboard = updateLeaderboard(db, { courseId: course_id, userId: user.id, userName: user.name || user.email || "Student" }); await writeLiveDb(db); res.json({ success: true, attendance: db.attendance[key], leaderboard }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.get("/live/leaderboard", async (req, res) => { try { await getAuthenticatedUser(req); const db = await readLiveDb(); let list = Object.values(db.leaderboard || {}); if (req.query.course_id) list = list.filter((x) => String(x.course_id) === String(req.query.course_id)); list = list.sort((a, b) => Number(b.total_points || 0) - Number(a.total_points || 0)).map((x, i) => ({ rank: i + 1, ...x })); res.json({ success: true, count: list.length, leaderboard: list }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.get("/live/community/:sessionId", async (req, res) => { try { await getAuthenticatedUser(req); const db = await readLiveDb(); const messages = db.communityMessages[req.params.sessionId] || []; res.json({ success: true, count: messages.length, messages }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.post("/live/community/:sessionId", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); if (!req.body.message) return res.status(400).json({ success: false, error: "message is required" }); const db = await readLiveDb(); const item = { id: uuid(), session_id: req.params.sessionId, course_id: req.body.course_id || null, user_id: user.id, user_name: user.name || user.email || "Student", message: String(req.body.message).slice(0, 2000), created_at: new Date().toISOString() }; db.communityMessages[req.params.sessionId] = [...(db.communityMessages[req.params.sessionId] || []), item]; await writeLiveDb(db); res.json({ success: true, message: item }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });

app.get("/roadmap/course/:courseId", async (req, res) => { const db = await readLiveDb(); const roadmap = db.roadmaps[String(req.params.courseId)] || null; const days = (roadmap?.days || []).filter((d) => d.is_published !== false); res.json({ success: true, roadmap: roadmap ? { id: roadmap.id, course_id: roadmap.course_id, course_name: roadmap.course_name, settings: roadmap.settings, created_at: roadmap.created_at, updated_at: roadmap.updated_at } : null, days: days.map(sanitizeRoadmapDay), summary: { total_days: roadmap?.days?.length || 0, shown_days: days.length, total_weeks: Math.ceil((roadmap?.days?.length || 0) / 7) } }); });
app.post("/admin/roadmap/generate", async (req, res) => { try { await requireAdminOrInstructor(req); const db = await readLiveDb(); const { course_id, course_name = "Course", start_date, duration_days, class_time = null, skip_sundays = true, template = "usmle_step_1" } = req.body; if (!course_id || !start_date || !duration_days) return res.status(400).json({ success: false, error: "course_id, start_date, duration_days required" }); const topics = ["Orientation", "Biochemistry", "Genetics", "Immunology", "Microbiology", "Pathology", "Pharmacology", "Cardiology", "Respiratory", "Renal", "Endocrine", "GI", "Neurology", "Psychiatry", "Reproductive", "Heme/Onc", "MSK/Derm", "Biostatistics", "Mixed Review"]; const dates = []; let cursor = new Date(`${start_date}T00:00:00`); while (dates.length < Number(duration_days)) { if (!(skip_sundays && cursor.getDay() === 0)) dates.push(dateOnly(cursor)); cursor = addDays(cursor, 1); } const days = dates.map((date, i) => ({ id: `${course_id}:day:${i + 1}`, course_id, week_number: Math.ceil((i + 1) / 7), day_number: i + 1, date, title: topics[i % topics.length], description: `Daily plan for ${course_name}`, resources: ["First Aid", "UWorld", "Class notes"], resource_links: [], uworld_target: "30-40 MCQs or assigned block", first_aid_topics: topics[i % topics.length], homework: "Complete assigned MCQs and review explanations", class_time, status: "scheduled", is_published: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), template })); db.roadmaps[String(course_id)] = { id: `roadmap:${course_id}`, course_id, course_name, settings: { duration_days: Number(duration_days), start_date, class_time, skip_sundays, template }, days, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; await writeLiveDb(db); res.json({ success: true, roadmap: db.roadmaps[String(course_id)] }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.post("/admin/roadmap/sync-live-sessions", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);

    const courseId = String(req.body.course_id || "").trim();

    if (!courseId) {
      return res.status(400).json({
        success: false,
        error: "course_id is required",
      });
    }

    const db = await readLiveDb();

    const sessions = Object.values(db.liveSessions || {})
      .filter((session) => String(session.course_id) === courseId)
      .sort((a, b) => {
        const ad = `${a.scheduled_date || ""} ${a.scheduled_time || ""}`;
        const bd = `${b.scheduled_date || ""} ${b.scheduled_time || ""}`;
        return ad.localeCompare(bd);
      });

    if (!sessions.length) {
      return res.status(404).json({
        success: false,
        error: "No live sessions found for this course",
      });
    }

    let roadmapKey = courseId;
    let roadmap = db.roadmaps?.[courseId];

    if (!roadmap) {
      const found = Object.entries(db.roadmaps || {}).find(([, value]) => {
        return (
          String(value.course_id || "") === courseId ||
          String(value.courseId || "") === courseId
        );
      });

      if (found) {
        roadmapKey = found[0];
        roadmap = found[1];
      }
    }

    if (!roadmap) {
      return res.status(404).json({
        success: false,
        error: "Roadmap not found for this course",
      });
    }

    const days = Array.isArray(roadmap.days)
      ? roadmap.days
      : Array.isArray(roadmap.items)
        ? roadmap.items
        : Array.isArray(roadmap.roadmap)
          ? roadmap.roadmap
          : [];

    if (!days.length) {
      return res.status(404).json({
        success: false,
        error: "Roadmap has no days to sync",
      });
    }

    const sessionByDate = new Map();
    const sessionByDayNumber = new Map();

    sessions.forEach((session, index) => {
      if (session.scheduled_date) {
        sessionByDate.set(String(session.scheduled_date).slice(0, 10), session);
      }

      const topic = String(session.topic || "");
      const dayMatch = topic.match(/day\s*(\d+)/i);

      if (dayMatch?.[1]) {
        sessionByDayNumber.set(Number(dayMatch[1]), session);
      }

      sessionByDayNumber.set(index + 1, session);
    });

    let syncedCount = 0;

    const syncedDays = days.map((day, index) => {
      const dayNumber = Number(day.day_number || day.order || index + 1);
      const dateKey = day.date ? String(day.date).slice(0, 10) : "";

      const matchedSession =
        (dateKey && sessionByDate.get(dateKey)) ||
        sessionByDayNumber.get(dayNumber) ||
        sessions[index];

      if (!matchedSession?.id) {
        return day;
      }

      syncedCount += 1;

      db.liveSessions[matchedSession.id] = {
        ...db.liveSessions[matchedSession.id],
        roadmap_day_id: day.id || null,
        updated_at: new Date().toISOString(),
      };

      return {
        ...day,
        live_session_id: matchedSession.id,
        session_id: matchedSession.id,
        scheduled_date: matchedSession.scheduled_date || day.scheduled_date || day.date || "",
        scheduled_time: matchedSession.scheduled_time || day.scheduled_time || "",
        status: day.status || "scheduled",
      };
    });

    if (Array.isArray(roadmap.days)) {
      roadmap.days = syncedDays;
    } else if (Array.isArray(roadmap.items)) {
      roadmap.items = syncedDays;
    } else if (Array.isArray(roadmap.roadmap)) {
      roadmap.roadmap = syncedDays;
    } else {
      roadmap.days = syncedDays;
    }

    roadmap.updated_at = new Date().toISOString();
    db.roadmaps[roadmapKey] = roadmap;

    await writeLiveDb(db);

    res.json({
      success: true,
      course_id: courseId,
      synced_count: syncedCount,
      total_days: syncedDays.length,
      total_sessions: sessions.length,
      roadmap,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to sync roadmap with live sessions",
    });
  }
});
app.post("/roadmap/progress/mark", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); const { course_id, day_id, completed = true } = req.body; const db = await readLiveDb(); const key = `${course_id}:${user.id}:${day_id}`; db.roadmapProgress[key] = { id: key, course_id, user_id: user.id, day_id, completed: Boolean(completed), completed_at: completed ? new Date().toISOString() : null, updated_at: new Date().toISOString() }; const leaderboard = updateLeaderboard(db, { courseId: course_id, userId: user.id, userName: user.name || user.email || "Student" }); await writeLiveDb(db); res.json({ success: true, progress: db.roadmapProgress[key], summary: buildProgressSummary({ db, courseId: course_id, userId: user.id }), leaderboard }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.get("/roadmap/progress/me", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); const db = await readLiveDb(); res.json({ success: true, summary: buildProgressSummary({ db, courseId: req.query.course_id, userId: user.id }), progress_items: Object.values(db.roadmapProgress || {}).filter((x) => String(x.course_id) === String(req.query.course_id) && String(x.user_id) === String(user.id)) }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });

app.post("/admin/assessments/create", async (req, res) => { try { const { user } = await requireAdminOrInstructor(req); const { course_id, session_id = null, title, description = "", source_type = "manual_notes", source_text = "", question_count = 10, duration_minutes = null, topic = "Assessment" } = req.body; if (!course_id) return res.status(400).json({ success: false, error: "course_id is required" }); const db = await readLiveDb(); const notes = session_id ? db.notes[session_id] : null; const source = source_text || notes?.notes || notes?.transcript_text || ""; const id = uuid(); const assessment = { id, course_id, session_id, title: title || `${topic} Assessment`, description, source_type, source_text: source, question_count: Number(question_count), duration_minutes, questions: createDraftQuestions({ question_count, topic }), is_published: false, created_by: user.id, created_by_name: user.name || user.email || "Tutor", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), published_at: null }; db.assessments[id] = assessment; await writeLiveDb(db); res.json({ success: true, assessment }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.get("/admin/assessments", async (req, res) => { try { await requireAdminOrInstructor(req); const db = await readLiveDb(); let items = Object.values(db.assessments || {}); if (req.query.course_id) items = items.filter((a) => String(a.course_id) === String(req.query.course_id)); if (req.query.session_id) items = items.filter((a) => String(a.session_id || "") === String(req.query.session_id)); items.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))); res.json({ success: true, count: items.length, assessments: items }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.get("/admin/assessments/:assessmentId", async (req, res) => { try { await requireAdminOrInstructor(req); const db = await readLiveDb(); const a = db.assessments[req.params.assessmentId]; if (!a) return res.status(404).json({ success: false, error: "Assessment not found" }); res.json({ success: true, assessment: a }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.patch("/admin/assessments/:assessmentId", async (req, res) => { try { await requireAdminOrInstructor(req); const db = await readLiveDb(); const a = db.assessments[req.params.assessmentId]; if (!a) return res.status(404).json({ success: false, error: "Assessment not found" }); const allowed = ["title", "description", "source_type", "source_text", "duration_minutes", "questions"]; for (const k of allowed) if (req.body[k] !== undefined) a[k] = req.body[k]; a.question_count = Array.isArray(a.questions) ? a.questions.length : a.question_count; a.updated_at = new Date().toISOString(); await writeLiveDb(db); res.json({ success: true, assessment: a }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.post("/admin/assessments/:assessmentId/publish", async (req, res) => { try { const { user } = await requireAdminOrInstructor(req); const db = await readLiveDb(); const a = db.assessments[req.params.assessmentId]; if (!a) return res.status(404).json({ success: false, error: "Assessment not found" }); const invalid = (a.questions || []).find((q) => !q.stem || !Array.isArray(q.options) || q.options.length < 2 || q.correct_index === undefined); if (req.body.is_published !== false && invalid) return res.status(400).json({ success: false, error: "Assessment has incomplete questions" }); a.is_published = req.body.is_published !== false; a.published_at = a.is_published ? new Date().toISOString() : null; a.published_by = a.is_published ? user.id : null; a.updated_at = new Date().toISOString(); await writeLiveDb(db); res.json({ success: true, assessment: a }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.delete("/admin/assessments/:assessmentId", async (req, res) => { try { await requireAdminOrInstructor(req); const db = await readLiveDb(); const a = db.assessments[req.params.assessmentId]; if (!a) return res.status(404).json({ success: false, error: "Assessment not found" }); delete db.assessments[req.params.assessmentId]; await writeLiveDb(db); res.json({ success: true, deleted_assessment: a }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.get("/student/assessments", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); const db = await readLiveDb(); const courseId = req.query.course_id; if (!courseId) return res.status(400).json({ success: false, error: "course_id is required" }); const e = getBackendEnrollment(db, { userId: user.id, courseId }); if (!e && user.role !== "admin" && user.role !== "instructor") return res.status(403).json({ success: false, error: "No course access found" }); if (e?.is_demo && !db.demoSettings.allow_assessments) return res.json({ success: true, count: 0, assessments: [], demo_restricted: true }); const items = Object.values(db.assessments || {}).filter((a) => String(a.course_id) === String(courseId) && a.is_published); res.json({ success: true, count: items.length, assessments: items.map((a) => sanitizeAssessmentForStudent(a, db.assessmentAttempts[assessmentAttemptKey(a.id, user.id)])) }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.get("/student/assessments/:assessmentId/take", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); const db = await readLiveDb(); const a = db.assessments[req.params.assessmentId]; if (!a || !a.is_published) return res.status(404).json({ success: false, error: "Assessment not found" }); const e = getBackendEnrollment(db, { userId: user.id, courseId: a.course_id }); if (!e && user.role !== "admin" && user.role !== "instructor") return res.status(403).json({ success: false, error: "No course access found" }); res.json({ success: true, assessment: sanitizeAssessmentForTaking(a), existing_attempt: db.assessmentAttempts[assessmentAttemptKey(a.id, user.id)] || null }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.post("/student/assessments/:assessmentId/submit", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); const db = await readLiveDb(); const a = db.assessments[req.params.assessmentId]; if (!a || !a.is_published) return res.status(404).json({ success: false, error: "Assessment not found" }); const e = getBackendEnrollment(db, { userId: user.id, courseId: a.course_id }); if (!e && user.role !== "admin" && user.role !== "instructor") return res.status(403).json({ success: false, error: "No course access found" }); const graded = gradeAssessment(a, req.body.answers || {}); const key = assessmentAttemptKey(a.id, user.id); const attempt = { id: key, assessment_id: a.id, course_id: a.course_id, session_id: a.session_id || null, user_id: user.id, user_name: user.name || user.email || "Student", answers: req.body.answers || {}, score: graded.score, total: graded.total, percentage: graded.percentage, graded_answers: graded.graded, submitted_at: new Date().toISOString() }; db.assessmentAttempts[key] = attempt; const quizKey = courseUserKey(a.course_id, user.id); db.quizAttempts[quizKey] = [...(db.quizAttempts[quizKey] || []), { id: uuid(), user_id: user.id, user_name: attempt.user_name, session_id: a.session_id || "assessment", course_id: a.course_id, quiz_id: a.id, topic: a.title, subject: "Assessment", score: graded.score, total: graded.total, percentage: graded.percentage, answers: req.body.answers || {}, created_at: new Date().toISOString() }]; const leaderboard = updateLeaderboard(db, { courseId: a.course_id, userId: user.id, userName: attempt.user_name }); await writeLiveDb(db); res.json({ success: true, attempt, leaderboard }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.get("/admin/assessments/report/:courseId", async (req, res) => { try { await requireAdminOrInstructor(req); const db = await readLiveDb(); const assessments = Object.values(db.assessments || {}).filter((a) => String(a.course_id) === String(req.params.courseId)); const attempts = Object.values(db.assessmentAttempts || {}).filter((a) => String(a.course_id) === String(req.params.courseId)); const reports = assessments.map((a) => { const related = attempts.filter((x) => x.assessment_id === a.id); const avg = related.length ? Math.round(related.reduce((s, x) => s + Number(x.percentage || 0), 0) / related.length) : 0; return { assessment_id: a.id, title: a.title, published: Boolean(a.is_published), attempts_count: related.length, average_percentage: avg }; }); res.json({ success: true, course_id: req.params.courseId, assessments_count: assessments.length, attempts_count: attempts.length, reports }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });

app.get("/student/dashboard/summary", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req); const courseId = req.query.course_id; if (!courseId) return res.status(400).json({ success: false, error: "course_id is required" });
    const db = await readLiveDb(); const enrollment = getBackendEnrollment(db, { userId: user.id, courseId }); const roadmap = buildProgressSummary({ db, courseId, userId: user.id }); const perf = performanceFromAttempts(getStudentAttempts(db, courseId, user.id)); const leaderboard = updateLeaderboard(db, { courseId, userId: user.id, userName: user.name || user.email || "Student" });
    let plan = { name: enrollment?.is_demo ? "Demo" : enrollment ? "Active" : "No active plan", days_left: null, is_demo: Boolean(enrollment?.is_demo) };
    if (enrollment?.is_demo && enrollment.demo_expiry) plan.days_left = Math.max(0, Math.ceil((new Date(`${enrollment.demo_expiry}T23:59:59`).getTime() - Date.now()) / 86400000));
    const assessments = Object.values(db.assessments || {}).filter((a) => String(a.course_id) === String(courseId) && a.is_published);
    const completedAssessments = assessments.filter((a) => db.assessmentAttempts[assessmentAttemptKey(a.id, user.id)]);
    await writeLiveDb(db);
    res.json({ success: true, plan, roadmap, today: roadmap.today_day, performance: { study_streak: 0, best_streak: 0, total_study_time_hours: 0, average_mock_score: perf.average_score, latest_mock_score: perf.latest_score, best_mock_score: perf.best_score, attempts_count: perf.attempts_count }, focus_areas: perf.focus_areas, leaderboard: { points: leaderboard.total_points || 0, attendance_points: leaderboard.attendance_points || 0, task_points: leaderboard.task_points || 0, quiz_points: leaderboard.quiz_points || 0 }, assessments: { available: assessments.length, completed: completedAssessments.length, pending: Math.max(0, assessments.length - completedAssessments.length) } });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); }
});

app.get("/live/debug/storage", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); if (user.role !== "admin") return res.status(403).json({ success: false, error: "Only admins can view storage debug" }); const db = await readLiveDb(); res.json({ success: true, data_dir: DATA_DIR, live_db_path: LIVE_DB_PATH, counts: { courses: Object.keys(db.courses || {}).length, liveSessions: Object.keys(db.liveSessions || {}).length, announcements: Object.keys(db.announcements || {}).length, recordings: Object.keys(db.recordings || {}).length, notes: Object.keys(db.notes || {}).length, enrollments: Object.keys(db.enrollments || {}).length, plans: Object.keys(db.plans || {}).length, coupons: Object.keys(db.coupons || {}).length, assessments: Object.keys(db.assessments || {}).length, assessmentAttempts: Object.keys(db.assessmentAttempts || {}).length, roadmaps: Object.keys(db.roadmaps || {}).length, roadmapProgress: Object.keys(db.roadmapProgress || {}).length, leaderboard: Object.keys(db.leaderboard || {}).length, googleAuthUsers: Object.keys(db.googleAuthUsers || {}).length }, updatedAt: db.updatedAt || null }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`LIVE_DB_PATH=${LIVE_DB_PATH}`);
});
