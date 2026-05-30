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
  // Backend-owned LMS content and authentication. PocketBase is no longer required.
  users: {},
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
  payments: {},
  featureCatalog: DEFAULT_FEATURE_CATALOG,
  demoSettings: DEFAULT_DEMO_SETTINGS,
  googleAuthUsers: {},

  roadmaps: {},
  roadmapProgress: {},

  assessments: {},
  assessmentAttempts: {},
  aiUsageLogs: {},

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
      users: parsed.users || {},
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
      payments: parsed.payments || {},
      googleAuthUsers: parsed.googleAuthUsers || {},
      roadmaps: parsed.roadmaps || {},
      roadmapProgress: parsed.roadmapProgress || {},
      assessments: parsed.assessments || {},
      assessmentAttempts: parsed.assessmentAttempts || {},
      aiUsageLogs: parsed.aiUsageLogs || {},
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

const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || "CHANGE_THIS_AUTH_SECRET_IN_RENDER_ENV";
const AUTH_TOKEN_DAYS = 30;

const EXTERNAL_LIBRARY_URL =
  process.env.EXTERNAL_LIBRARY_URL || "https://lms.nextgenusmlelms.com";

const EXTERNAL_LIBRARY_SSO_SECRET =
  process.env.EXTERNAL_LIBRARY_SSO_SECRET || AUTH_JWT_SECRET;

const EXTERNAL_LIBRARY_TOKEN_MINUTES = 2;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const passwordHash = crypto
    .pbkdf2Sync(String(password || ""), salt, 120000, 64, "sha512")
    .toString("hex");

  return {
    salt,
    password_hash: passwordHash,
  };
}

function verifyPassword(password, user) {
  if (!user?.salt || !user?.password_hash) return false;

  const check = crypto
    .pbkdf2Sync(String(password || ""), user.salt, 120000, 64, "sha512")
    .toString("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(check, "hex"),
      Buffer.from(user.password_hash, "hex")
    );
  } catch {
    return false;
  }
}

function sanitizeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name || "",
    role: user.role || "student",
    avatar_url: user.avatar_url || null,
    google_sub: user.google_sub || null,
    verified: user.verified !== false,
    created_at: user.created_at || null,
    updated_at: user.updated_at || null,
  };
}

function signAuthToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role || "student",
    },
    AUTH_JWT_SECRET,
    {
      expiresIn: `${AUTH_TOKEN_DAYS}d`,
    }
  );
}

function planIncludesFeature(plan, featureKey) {
  const features = Array.isArray(plan?.included_features)
    ? plan.included_features
    : [];

  return features
    .map((item) => String(item || "").trim().toLowerCase())
    .includes(String(featureKey || "").trim().toLowerCase());
}

function getPlanAccessDays(plan) {
  if (plan?.access_days === null || plan?.access_days === undefined || plan?.access_days === "") {
    return 30;
  }

  const days = Number(plan.access_days);
  return Number.isFinite(days) && days > 0 ? days : 30;
}

function getExternalLibraryAccess(db, user) {
  const enrollments = Object.values(db.enrollments || {}).filter((enrollment) => {
    return (
      String(enrollment.user_id) === String(user.id) &&
      enrollment.access_granted !== false &&
      enrollment.is_demo !== true
    );
  });

  for (const enrollment of enrollments) {
    const plan = enrollment.plan_id
      ? db.plans?.[String(enrollment.plan_id)] || null
      : null;

    if (!plan) continue;
    if (plan.is_active === false) continue;
    if (!planIncludesFeature(plan, "video_library")) continue;

    const course = enrollment.course_id
      ? db.courses?.[String(enrollment.course_id)] || null
      : null;

    const accessDays = getPlanAccessDays(plan);
    const accessEndsAt = addDays(new Date(), accessDays).toISOString();

    return {
      allowed: true,
      enrollment,
      plan,
      course,
      accessDays,
      accessEndsAt,
    };
  }

  return {
    allowed: false,
    enrollment: null,
    plan: null,
    course: null,
    accessDays: 0,
    accessEndsAt: null,
  };
}

function getStudentFeatureAccess(db, user) {
  const featureKeys = Object.keys({ ...DEFAULT_FEATURE_CATALOG, ...(db.featureCatalog || {}) });
  const access = {};

  for (const key of featureKeys) {
    const catalogItem = (db.featureCatalog || {})[key] || DEFAULT_FEATURE_CATALOG[key] || {};
    access[key] = {
      key,
      name: catalogItem.name || key,
      description: catalogItem.description || "",
      included: Boolean(catalogItem.free_for_all),
      locked: !Boolean(catalogItem.free_for_all),
      plan_id: null,
      plan_name: null,
      course_id: null,
      course_name: null,
      access_days: null,
    };
  }

  const enrollments = Object.values(db.enrollments || {}).filter((enrollment) => {
    return (
      String(enrollment.user_id) === String(user.id) &&
      enrollment.access_granted !== false &&
      enrollment.is_demo !== true
    );
  });

  for (const enrollment of enrollments) {
    const plan = enrollment.plan_id
      ? db.plans?.[String(enrollment.plan_id)] || null
      : null;

    if (!plan || plan.is_active === false) continue;

    const course = enrollment.course_id
      ? db.courses?.[String(enrollment.course_id)] || null
      : null;

    const features = Array.isArray(plan.included_features) ? plan.included_features : [];

    for (const rawFeature of features) {
      const featureKey = String(rawFeature || "").trim();
      if (!featureKey) continue;

      const catalogItem = (db.featureCatalog || {})[featureKey] || DEFAULT_FEATURE_CATALOG[featureKey] || {};
      access[featureKey] = {
        key: featureKey,
        name: catalogItem.name || featureKey,
        description: catalogItem.description || "",
        included: true,
        locked: false,
        plan_id: plan.id || null,
        plan_name: plan.name || null,
        course_id: course?.id || enrollment.course_id || null,
        course_name: course?.name || "Course",
        access_days: getPlanAccessDays(plan),
      };
    }
  }

  return access;
}

function signExternalLibraryToken({ user, enrollment, plan, course, accessEndsAt }) {
  return jwt.sign(
    {
      purpose: "external_library_sso",
      sub: user.id,
      email: user.email,
      name: user.name || user.email || "NextGen Student",
      role: user.role || "student",
      tier: "premium",
      enrollment_id: enrollment?.id || null,
      plan_id: plan?.id || null,
      plan_name: plan?.name || "NextGen Plan",
      course_id: course?.id || enrollment?.course_id || null,
      course_name: course?.name || "NextGen Course",
      accessEndsAt,
    },
    EXTERNAL_LIBRARY_SSO_SECRET,
    {
      expiresIn: `${EXTERNAL_LIBRARY_TOKEN_MINUTES}m`,
    }
  );
}

function findUserByEmail(db, email) {
  const cleanEmail = normalizeEmail(email);

  return (
    Object.values(db.users || {}).find(
      (user) => normalizeEmail(user.email) === cleanEmail
    ) || null
  );
}

async function ensureBootstrapAdmin() {
  const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL);
  const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || "");
  const name = process.env.BOOTSTRAP_ADMIN_NAME || "NextGen Admin";

  if (!email || !password) {
    return null;
  }

  const db = await readLiveDb();
  const existing = findUserByEmail(db, email);

  if (existing) {
    let changed = false;

    if (existing.role !== "admin") {
      existing.role = "admin";
      changed = true;
    }

    if (process.env.BOOTSTRAP_ADMIN_RESET_PASSWORD === "true") {
      const hashed = hashPassword(password);
      existing.salt = hashed.salt;
      existing.password_hash = hashed.password_hash;
      changed = true;
    }

    if (changed) {
      existing.updated_at = new Date().toISOString();
      db.users[existing.id] = existing;
      await writeLiveDb(db);
    }

    return existing;
  }

  const id = uuid();
  const hashed = hashPassword(password);

  const admin = {
    id,
    email,
    name,
    role: "admin",
    verified: true,
    ...hashed,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  db.users[id] = admin;
  await writeLiveDb(db);

  console.log(`Bootstrap admin created: ${email}`);

  return admin;
}

function createBackendUser({ email, name, password, role = "student", google_sub = null, avatar_url = null }) {
  const hashed = password
    ? hashPassword(password)
    : hashPassword(`NG_${crypto.randomBytes(24).toString("hex")}_9aZ!`);

  return {
    id: uuid(),
    email: normalizeEmail(email),
    name: String(name || "").trim(),
    role,
    verified: true,
    google_sub,
    avatar_url,
    ...hashed,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}


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

function getUserDisplay(db, userId, fallbackName = "Student") {
  const user = db.users?.[String(userId)] || null;
  return {
    user_id: userId || null,
    student_id: userId || null,
    user_name: user?.name || fallbackName || "Student",
    student_name: user?.name || fallbackName || "Student",
    user_email: user?.email || "",
    student_email: user?.email || "",
    email: user?.email || "",
  };
}

function sanitizeAdminEnrollment(enrollment, db) {
  const course = db.courses?.[String(enrollment.course_id)] || null;
  const userInfo = getUserDisplay(db, enrollment.user_id, enrollment.user_name);
  const plan = enrollment.plan_id ? db.plans?.[String(enrollment.plan_id)] || null : null;
  const isDemo = Boolean(enrollment.is_demo);
  const accessGranted = enrollment.access_granted !== false;
  const demoActive = isDemo ? isDemoEnrollmentActive(enrollment, { ...DEFAULT_DEMO_SETTINGS, ...(db.demoSettings || {}) }) : true;

  return {
    id: enrollment.id,
    backend_owned: enrollment.backend_owned !== false,
    user_id: enrollment.user_id || null,
    student_id: enrollment.user_id || null,
    student_name: userInfo.student_name,
    user_name: userInfo.user_name,
    name: userInfo.user_name,
    student_email: userInfo.student_email,
    user_email: userInfo.user_email,
    email: userInfo.email,
    course_id: enrollment.course_id || null,
    course_name: course?.name || "Course",
    plan_id: enrollment.plan_id || null,
    plan_name: plan?.name || (isDemo ? "Demo" : enrollment.plan_id ? "Selected plan" : "Manual/Legacy"),
    access_granted: accessGranted,
    is_active: accessGranted,
    is_demo: isDemo,
    type: isDemo ? "demo" : "paid",
    status: !accessGranted ? "revoked" : isDemo ? (demoActive ? "demo_active" : "demo_expired") : "paid",
    demo_expiry: enrollment.demo_expiry || null,
    progress_percentage: Number(enrollment.progress_percentage || 0),
    created_at: enrollment.created_at || null,
    updated_at: enrollment.updated_at || null,
  };
}

function sanitizePayment(payment, db) {
  const course = db.courses?.[String(payment.course_id)] || null;
  const plan = payment.plan_id ? db.plans?.[String(payment.plan_id)] || null : null;
  const userInfo = getUserDisplay(db, payment.student_id || payment.user_id, payment.student_name || payment.user_name);
  const amountCents = Number(payment.amount_cents ?? payment.final_amount_cents ?? payment.price_cents ?? 0) || 0;

  return {
    id: payment.id,
    payment_id: payment.id,
    checkout_session_id: payment.checkout_session_id || payment.stripe_session_id || null,
    stripe_session_id: payment.stripe_session_id || payment.checkout_session_id || null,
    enrollment_id: payment.enrollment_id || null,
    user_id: payment.user_id || payment.student_id || null,
    student_id: payment.student_id || payment.user_id || null,
    student_name: userInfo.student_name,
    student_email: userInfo.student_email,
    user_name: userInfo.user_name,
    user_email: userInfo.user_email,
    email: userInfo.email,
    course_id: payment.course_id || null,
    course_name: course?.name || "Course",
    plan_id: payment.plan_id || null,
    plan_name: plan?.name || payment.plan_name || "Plan",
    coupon_code: payment.coupon_code || null,
    amount_cents: amountCents,
    price_cents: amountCents,
    original_amount_cents: Number(payment.original_amount_cents ?? amountCents) || 0,
    discount_cents: Number(payment.discount_cents || 0) || 0,
    currency: payment.currency || plan?.currency || "usd",
    status: payment.status || payment.payment_status || "completed",
    payment_status: payment.payment_status || payment.status || "completed",
    payment_method: payment.payment_method || payment.method || "stripe",
    source: payment.source || "backend",
    created_at: payment.created_at || payment.paid_at || payment.redeemed_at || null,
    updated_at: payment.updated_at || null,
    paid_at: payment.paid_at || null,
    metadata: payment.metadata || {},
  };
}

function buildDerivedPayments(db) {
  const payments = Object.values(db.payments || {});

  for (const redemption of Object.values(db.couponRedemptions || {})) {
    const id = `coupon_${redemption.id}`;
    if (!payments.some((p) => p.id === id)) {
      payments.push({
        id,
        enrollment_id: redemption.enrollment_id || null,
        student_id: redemption.student_id || null,
        user_id: redemption.student_id || null,
        course_id: redemption.course_id || null,
        plan_id: redemption.plan_id || null,
        coupon_code: redemption.coupon_code || null,
        original_amount_cents: Number(redemption.original_amount_cents || 0),
        discount_cents: Number(redemption.discount_cents || 0),
        amount_cents: Number(redemption.final_amount_cents || 0),
        final_amount_cents: Number(redemption.final_amount_cents || 0),
        currency: "usd",
        status: "completed",
        payment_status: "completed",
        payment_method: "coupon",
        source: "coupon_redemption",
        created_at: redemption.redeemed_at || null,
        paid_at: redemption.redeemed_at || null,
      });
    }
  }

  return payments.map((payment) => sanitizePayment(payment, db)).sort(sortNewestFirst);
}

function findEnrollmentById(db, enrollmentId) {
  const id = String(enrollmentId || "");
  return db.enrollments?.[id] || Object.values(db.enrollments || {}).find((e) => String(e.id) === id) || null;
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
    homepage_roadmap_enabled:
      body.homepage_roadmap_enabled !== undefined
        ? Boolean(body.homepage_roadmap_enabled)
        : Boolean(existing.homepage_roadmap_enabled),
    homepage_roadmap_title: String(body.homepage_roadmap_title ?? existing.homepage_roadmap_title ?? "").trim(),
    homepage_roadmap_subtitle: String(body.homepage_roadmap_subtitle ?? existing.homepage_roadmap_subtitle ?? "").trim(),
    homepage_roadmap_style: String(body.homepage_roadmap_style ?? existing.homepage_roadmap_style ?? "custom").trim() || "custom",
    homepage_roadmap_phases: Array.isArray(body.homepage_roadmap_phases)
      ? body.homepage_roadmap_phases
      : Array.isArray(existing.homepage_roadmap_phases)
        ? existing.homepage_roadmap_phases
        : [],
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
    homepage_roadmap_enabled: Boolean(course.homepage_roadmap_enabled),
    homepage_roadmap_title: course.homepage_roadmap_title || "",
    homepage_roadmap_subtitle: course.homepage_roadmap_subtitle || "",
    homepage_roadmap_style: course.homepage_roadmap_style || "custom",
    homepage_roadmap_phases: Array.isArray(course.homepage_roadmap_phases) ? course.homepage_roadmap_phases : [],
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

async function getAuthenticatedUser(req) {
  await ensureBootstrapAdmin();

  const token = String(req.headers.authorization || "").replace("Bearer ", "").trim();

  if (!token) {
    const e = new Error("User not authenticated");
    e.statusCode = 401;
    throw e;
  }

  let decoded;

  try {
    decoded = jwt.verify(token, AUTH_JWT_SECRET);
  } catch {
    const e = new Error("Invalid or expired auth token");
    e.statusCode = 401;
    throw e;
  }

  const db = await readLiveDb();
  const user = db.users[String(decoded.sub)];

  if (!user?.id) {
    const e = new Error("User not found");
    e.statusCode = 401;
    throw e;
  }

  return {
    user: sanitizeUser(user),
    token,
  };
}

async function requireAdmin(req) {
  const ctx = await getAuthenticatedUser(req);

  if (ctx.user.role !== "admin") {
    const e = new Error("Only admins can perform this action");
    e.statusCode = 403;
    throw e;
  }

  return ctx;
}

async function requireAdminOrInstructor(req) {
  const ctx = await getAuthenticatedUser(req);

  if (ctx.user.role !== "admin" && ctx.user.role !== "instructor") {
    const e = new Error("Only admins or instructors can perform this action");
    e.statusCode = 403;
    throw e;
  }

  return ctx;
}

function isAdminOrInstructor(user, session) {
  return (
    user?.role === "admin" ||
    user?.role === "instructor" ||
    session?.instructor_id === user?.id
  );
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
  const files = Array.isArray(recordingFiles) ? recordingFiles : [];

  return (
    files.find((file) =>
      ["TRANSCRIPT", "CC", "VTT"].includes(
        String(file.file_type || "").toUpperCase()
      )
    ) ||
    files.find((file) =>
      String(file.recording_type || "").toLowerCase().includes("transcript")
    ) ||
    files.find((file) =>
      String(file.file_extension || "").toLowerCase() === "vtt"
    ) ||
    files.find((file) =>
      String(file.download_url || file.play_url || "").toLowerCase().includes("transcript")
    ) ||
    null
  );
}

function findVideoFile(recordingFiles = []) {
  const files = Array.isArray(recordingFiles) ? recordingFiles : [];

  return (
    files.find((file) => String(file.file_type || "").toUpperCase() === "MP4") ||
    files.find((file) => String(file.recording_type || "").toLowerCase().includes("shared_screen")) ||
    files.find((file) => String(file.file_type || "").toUpperCase().includes("MP4")) ||
    files[0] ||
    null
  );
}

async function downloadZoomTextFile(file, accessToken) {
  const baseUrl = file?.download_url || file?.play_url;
  if (!baseUrl) return "";

  const separator = baseUrl.includes("?") ? "&" : "?";
  const url = file?.download_url ? `${baseUrl}${separator}access_token=${accessToken}` : baseUrl;

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

  const session = Object.values(db.liveSessions || {}).find((s) => {
    return (
      String(s.zoom_meeting_id || "") === key ||
      String(s.meeting_id || "") === key
    );
  });

  return session?.id || null;
}

async function fetchZoomRecordingByMeetingId(meetingId) {
  const accessToken = await getZoomAccessToken();
  const encodedMeetingId = encodeURIComponent(String(meetingId || ""));

  const response = await axios.get(
    `https://api.zoom.us/v2/meetings/${encodedMeetingId}/recordings`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return { recording: response.data, accessToken };
}

async function upsertZoomRecordingFromObject({ db, object, accessToken = null, forceImportTranscript = false }) {
  const files = object?.recording_files || [];
  const videoFile = findVideoFile(files);
  const transcriptFile = findTranscriptFile(files);
  const meetingId = String(object?.id || object?.meeting_id || "");

  if (!meetingId) {
    throw new Error("Zoom recording object is missing meeting id");
  }

  let transcriptText = "";
  let transcriptRaw = "";
  let transcriptImportError = null;

  if (transcriptFile && (forceImportTranscript || transcriptFile.download_url || transcriptFile.play_url)) {
    try {
      const token = accessToken || await getZoomAccessToken();
      transcriptRaw = await downloadZoomTextFile(transcriptFile, token);
      transcriptText = stripVttToText(transcriptRaw);
    } catch (error) {
      transcriptImportError = error.response?.data || error.message;
      console.warn("Zoom transcript import failed:", transcriptImportError);
    }
  }

  const previous = db.recordings[meetingId] || {};

  const recordingPayload = {
    ...previous,
    meeting_id: meetingId,
    uuid: object.uuid || previous.uuid || null,
    topic: object.topic || previous.topic || null,
    start_time: object.start_time || previous.start_time || null,
    duration: object.duration || previous.duration || null,

    share_url: object.share_url || previous.share_url || null,

    recording_url:
      videoFile?.play_url ||
      object.share_url ||
      videoFile?.download_url ||
      previous.recording_url ||
      null,

    download_url:
      videoFile?.download_url ||
      previous.download_url ||
      null,

    transcript_url:
      transcriptFile?.play_url ||
      transcriptFile?.download_url ||
      previous.transcript_url ||
      null,

    transcript_download_url:
      transcriptFile?.download_url ||
      previous.transcript_download_url ||
      null,

    transcript_imported: Boolean(transcriptText || previous.transcript_imported),
    transcript_import_error: transcriptImportError,

    file_type: videoFile?.file_type || previous.file_type || null,
    recording_type: videoFile?.recording_type || previous.recording_type || null,
    status: videoFile?.status || previous.status || "completed",

    published: Boolean(previous.published),
    received_at: new Date().toISOString(),
  };

  db.recordings[meetingId] = recordingPayload;

  const sessionId =
    previous.session_id ||
    findSessionByMeetingIdInNotesOrRecordings(db, meetingId) ||
    null;

  if (sessionId) {
    db.notes[sessionId] = {
      ...(db.notes[sessionId] || {}),
      session_id: sessionId,
      course_id:
        previous.course_id ||
        db.liveSessions?.[sessionId]?.course_id ||
        db.notes[sessionId]?.course_id ||
        null,

      notes: db.notes[sessionId]?.notes || "",

      transcript_text:
        transcriptText ||
        db.notes[sessionId]?.transcript_text ||
        "",

      transcript_raw_vtt:
        transcriptRaw ||
        db.notes[sessionId]?.transcript_raw_vtt ||
        "",

      transcript_url: recordingPayload.transcript_url,
      transcript_download_url: recordingPayload.transcript_download_url,
      recording_url: recordingPayload.recording_url,
      meeting_id: meetingId,
      source: transcriptText
        ? "zoom_transcript"
        : db.notes[sessionId]?.source || "manual",
      auto_imported: Boolean(transcriptText || db.notes[sessionId]?.auto_imported),
      updated_at: new Date().toISOString(),
    };
  }

  return {
    recordingPayload,
    sessionId,
    transcriptFile,
    transcriptText,
    transcriptRaw,
    transcriptImportError,
  };
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

function isAttemptReleased(attempt) {
  if (!attempt) return false;
  return attempt.released_to_student === true || attempt.review_status === "released";
}

function sanitizeAttemptForStudent(attempt) {
  if (!attempt) return null;
  const released = isAttemptReleased(attempt);
  return {
    id: attempt.id,
    assessment_id: attempt.assessment_id,
    course_id: attempt.course_id,
    session_id: attempt.session_id || null,
    submitted_at: attempt.submitted_at || null,
    review_status: attempt.review_status || (released ? "released" : "pending_review"),
    released_to_student: released,
    admin_feedback: released ? (attempt.admin_feedback || "") : "",
    score: released ? attempt.score : null,
    total: released ? attempt.total : attempt.total || null,
    percentage: released ? attempt.percentage : null,
    graded_answers: released ? attempt.graded_answers || [] : [],
  };
}

function sanitizeAttemptForAdmin(attempt, db) {
  const assessment = db.assessments?.[attempt.assessment_id] || null;
  const course = db.courses?.[attempt.course_id] || null;
  const user = db.users?.[attempt.user_id] || null;
  return {
    ...attempt,
    assessment_title: assessment?.title || attempt.assessment_title || "Assessment",
    course_name: course?.name || "Course",
    student_name: user?.name || attempt.user_name || "Student",
    student_email: user?.email || attempt.user_email || "",
    review_status: attempt.review_status || "pending_review",
    released_to_student: attempt.released_to_student === true,
    leaderboard_applied: attempt.leaderboard_applied === true,
  };
}

function sanitizeAssessmentForStudent(assessment, attempt = null) {
  const released = isAttemptReleased(attempt);
  return {
    id: assessment.id,
    course_id: assessment.course_id,
    session_id: assessment.session_id || null,
    title: assessment.title,
    description: assessment.description || "",
    source_type: assessment.source_type || "manual_notes",
    question_count: (assessment.questions || []).length,
    duration_minutes: assessment.duration_minutes || null,
    starts_at: assessment.starts_at || assessment.start_at || assessment.opens_at || null,
    due_at: assessment.due_at || assessment.ends_at || assessment.deadline || null,
    attempts_allowed: assessment.attempts_allowed || 1,
    is_published: Boolean(assessment.is_published),
    created_at: assessment.created_at || null,
    published_at: assessment.published_at || null,
    attempt_status: attempt ? "completed" : "not_started",
    review_status: attempt ? (attempt.review_status || (released ? "released" : "pending_review")) : null,
    released_to_student: released,
    result_visible: released,
    attempt_score: released ? attempt?.score ?? null : null,
    attempt_total: released ? attempt?.total ?? null : attempt?.total ?? null,
    attempt_percentage: released ? attempt?.percentage ?? null : null,
    admin_feedback: released ? attempt?.admin_feedback || "" : "",
    submitted_at: attempt?.submitted_at || null,
  };
}

function sanitizeAssessmentForTaking(assessment, existingAttempt = null) {
  const released = isAttemptReleased(existingAttempt);
  return {
    id: assessment.id,
    course_id: assessment.course_id,
    session_id: assessment.session_id || null,
    title: assessment.title,
    description: assessment.description || "",
    duration_minutes: assessment.duration_minutes || null,
    starts_at: assessment.starts_at || assessment.start_at || assessment.opens_at || null,
    due_at: assessment.due_at || assessment.ends_at || assessment.deadline || null,
    attempts_allowed: assessment.attempts_allowed || 1,
    existing_attempt: existingAttempt ? sanitizeAttemptForStudent(existingAttempt) : null,
    questions: released
      ? (assessment.questions || []).map((q, i) => ({
          id: q.id || `q${i + 1}`,
          stem: q.stem,
          options: q.options || [],
          topic: q.topic || "General",
          difficulty: q.difficulty || "medium",
          explanation: q.explanation || "",
          correct_index: q.correct_index,
        }))
      : (assessment.questions || []).map((q, i) => ({
          id: q.id || `q${i + 1}`,
          stem: q.stem,
          options: q.options || [],
          topic: q.topic || "General",
          difficulty: q.difficulty || "medium",
        })),
  };
}

function applyReleasedAssessmentAttemptToLeaderboard(db, attempt, assessment = null) {
  if (!attempt || attempt.leaderboard_applied === true) {
    return db.leaderboard?.[courseUserKey(attempt?.course_id, attempt?.user_id)] || null;
  }

  const quizKey = courseUserKey(attempt.course_id, attempt.user_id);
  db.quizAttempts[quizKey] = Array.isArray(db.quizAttempts[quizKey]) ? db.quizAttempts[quizKey] : [];

  const existingQuizAttemptId = attempt.quiz_attempt_id;
  const alreadyExists = existingQuizAttemptId
    ? db.quizAttempts[quizKey].some((item) => item.id === existingQuizAttemptId)
    : db.quizAttempts[quizKey].some((item) => item.assessment_attempt_id === attempt.id);

  if (!alreadyExists) {
    const quizAttemptId = existingQuizAttemptId || uuid();
    attempt.quiz_attempt_id = quizAttemptId;
    db.quizAttempts[quizKey].push({
      id: quizAttemptId,
      assessment_attempt_id: attempt.id,
      user_id: attempt.user_id,
      user_name: attempt.user_name || "Student",
      session_id: attempt.session_id || "assessment",
      course_id: attempt.course_id,
      quiz_id: attempt.assessment_id,
      topic: assessment?.title || attempt.assessment_title || "Assessment",
      subject: "Assessment",
      score: attempt.score,
      total: attempt.total,
      percentage: attempt.percentage,
      answers: attempt.answers || {},
      created_at: attempt.submitted_at || new Date().toISOString(),
      released_at: attempt.reviewed_at || new Date().toISOString(),
    });
  }

  attempt.leaderboard_applied = true;
  attempt.leaderboard_applied_at = attempt.leaderboard_applied_at || new Date().toISOString();

  return updateLeaderboard(db, {
    courseId: attempt.course_id,
    userId: attempt.user_id,
    userName: attempt.user_name || "Student",
  });
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
// -----------------------------------------------------------------------------
// AI Foundation: Notes Cleanup + Assessment Question Generation
// -----------------------------------------------------------------------------

function isAIConfigured() {
  return (
    process.env.AI_ENABLED !== "false" &&
    Boolean(String(process.env.OPENAI_API_KEY || "").trim())
  );
}

function getAIConfigError() {
  return "AI question generation is not configured. Please add OPENAI_API_KEY.";
}

function getAIModel(fallback = "gpt-4o-mini") {
  return String(process.env.AI_MODEL || fallback).trim() || fallback;
}

function getAICleanupModel(fallback = "gpt-4o-mini") {
  return String(process.env.AI_CLEANUP_MODEL || process.env.AI_MODEL || fallback).trim() || fallback;
}

function getAIModelPricing(model) {
  const key = String(model || "").toLowerCase();

  const pricing = {
    "gpt-4o-mini": { input_per_1m: 0.15, output_per_1m: 0.60 },
    "gpt-4.1-mini": { input_per_1m: 0.40, output_per_1m: 1.60 },
    "gpt-5-mini": { input_per_1m: 0.25, output_per_1m: 2.00 },
  };

  return pricing[key] || pricing["gpt-4o-mini"];
}

function normalizeAIUsage(rawUsage = {}) {
  const inputTokens = Number(rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? rawUsage.inputTokens ?? 0) || 0;
  const outputTokens = Number(rawUsage.output_tokens ?? rawUsage.completion_tokens ?? rawUsage.outputTokens ?? 0) || 0;
  const totalTokens = Number(rawUsage.total_tokens ?? rawUsage.totalTokens ?? 0) || inputTokens + outputTokens;

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

function estimateAICostUsd({ model, usage }) {
  const cleanUsage = normalizeAIUsage(usage);
  const pricing = getAIModelPricing(model);

  const inputCost = (cleanUsage.input_tokens / 1000000) * pricing.input_per_1m;
  const outputCost = (cleanUsage.output_tokens / 1000000) * pricing.output_per_1m;

  return Number((inputCost + outputCost).toFixed(6));
}

async function logAIUsage({ user, action, model, usage, sourceLength = 0, questionCount = null }) {
  try {
    const db = await readLiveDb();
    db.aiUsageLogs = db.aiUsageLogs || {};

    const cleanUsage = normalizeAIUsage(usage);
    const id = uuid();
    const log = {
      id,
      user_id: user?.id || null,
      user_email: user?.email || null,
      user_name: user?.name || null,
      action,
      model,
      input_tokens: cleanUsage.input_tokens,
      output_tokens: cleanUsage.output_tokens,
      total_tokens: cleanUsage.total_tokens,
      estimated_cost_usd: estimateAICostUsd({ model, usage: cleanUsage }),
      source_length: Number(sourceLength || 0),
      question_count: questionCount === null || questionCount === undefined ? null : Number(questionCount || 0),
      created_at: new Date().toISOString(),
    };

    db.aiUsageLogs[id] = log;
    await writeLiveDb(db);
    return log;
  } catch (error) {
    console.warn("AI usage logging failed:", error.message);
    return null;
  }
}

function extractAIText(openAIResponse) {
  if (typeof openAIResponse?.output_text === "string") {
    return openAIResponse.output_text;
  }

  const output = openAIResponse?.output || [];

  for (const item of output) {
    const content = item?.content || [];

    for (const part of content) {
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.output_text === "string") return part.output_text;
    }
  }

  const firstChoice = openAIResponse?.choices?.[0]?.message?.content;

  if (typeof firstChoice === "string") return firstChoice;

  return "";
}

function safeJsonParseFromAI(text) {
  const raw = String(text || "").trim();

  if (!raw) {
    throw new Error("AI returned an empty response");
  }

  try {
    return JSON.parse(raw);
  } catch {
    const jsonMatch =
      raw.match(/```json\s*([\s\S]*?)```/i) ||
      raw.match(/```\s*([\s\S]*?)```/i);

    if (jsonMatch?.[1]) {
      return JSON.parse(jsonMatch[1].trim());
    }

    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    }

    throw new Error("AI response was not valid JSON");
  }
}

async function callOpenAIResponsesAPI({
  model,
  systemPrompt,
  userPrompt,
  maxOutputTokens = 3000,
  jsonMode = false,
}) {
  if (!isAIConfigured()) {
    const error = new Error(getAIConfigError());
    error.statusCode = 500;
    throw error;
  }

  const payload = {
    model,
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_output_tokens: maxOutputTokens,
  };

  if (jsonMode) {
    payload.text = { format: { type: "json_object" } };
  }

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/responses",
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 120000,
      }
    );

    return {
      text: extractAIText(response.data),
      usage: normalizeAIUsage(response.data?.usage || {}),
      model,
      raw_model: response.data?.model || model,
    };
  } catch (error) {
    const apiMessage =
      error.response?.data?.error?.message ||
      error.response?.data?.message ||
      error.message ||
      "OpenAI request failed";

    const e = new Error(apiMessage);
    e.statusCode = error.response?.status || 500;
    throw e;
  }
}

function getSourceTextFromRequest({ db, body }) {
  const sourceType = String(body.source_type || "custom_text").trim();
  const manualText = String(body.text || body.source_text || "").trim();

  if (manualText) {
    return {
      sourceType,
      sourceText: manualText,
      sourceSession: null,
    };
  }

  const sessionId = body.session_id ? String(body.session_id) : "";

  if (sessionId) {
    const notes = db.notes?.[sessionId] || null;
    const session = db.liveSessions?.[sessionId] || null;

    const sourceText = String(
      notes?.notes ||
        notes?.transcript_text ||
        notes?.transcript ||
        notes?.content ||
        ""
    ).trim();

    return {
      sourceType: "session_notes",
      sourceText,
      sourceSession: session,
    };
  }

  return {
    sourceType,
    sourceText: "",
    sourceSession: null,
  };
}

function validateAISourceText(sourceText) {
  const text = String(sourceText || "").trim();

  if (!text) {
    const error = new Error("Source text is required");
    error.statusCode = 400;
    throw error;
  }

  if (text.length < 300) {
    const error = new Error("Source text must be at least 300 characters for AI generation");
    error.statusCode = 400;
    throw error;
  }

  return text;
}

function normalizeAIQuestions(inputQuestions = []) {
  const questions = Array.isArray(inputQuestions) ? inputQuestions : [];

  return questions
    .map((question, index) => {
      const optionsObject = question.options || {};
      const optionsArray = Array.isArray(optionsObject)
        ? optionsObject
        : [
            optionsObject.A,
            optionsObject.B,
            optionsObject.C,
            optionsObject.D,
          ];

      const cleanOptions = optionsArray
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, 4);

      while (cleanOptions.length < 4) {
        cleanOptions.push(`Option ${String.fromCharCode(65 + cleanOptions.length)}`);
      }

      const correctLetter = String(question.correct_answer || "A").trim().toUpperCase();
      const letterMap = { A: 0, B: 1, C: 2, D: 3 };
      const correctIndex =
        Number.isInteger(question.correct_index)
          ? Math.max(0, Math.min(3, Number(question.correct_index)))
          : letterMap[correctLetter] ?? 0;

      return {
        id: question.id || `q${index + 1}`,
        stem: String(
          question.stem ||
            question.question_text ||
            question.question ||
            `Question ${index + 1}`
        ).trim(),
        options: cleanOptions,
        correct_index: correctIndex,
        explanation: String(question.explanation || "").trim(),
        topic: String(question.topic || question.source_lecture_name || "General").trim(),
        difficulty: String(question.difficulty || "medium").trim().toLowerCase(),
        points: Number(question.points || 1) || 1,
        source_lecture_id: question.source_lecture_id || null,
        source_lecture_name: question.source_lecture_name || null,
      };
    })
    .filter((question) => question.stem && question.options.length >= 4);
}

async function cleanNotesWithAI({ sourceText, sourceType, metadata = {} }) {
  const cleanText = validateAISourceText(sourceText);

  const systemPrompt = `
You are cleaning lecture/session notes for NextGen USMLE.

Rules:
- Preserve the original meaning.
- Do not add new medical facts.
- Do not invent information.
- Do not expand beyond the provided source.
- Organize into clear headings and bullet points.
- Correct grammar and formatting.
- If content is unclear, label it as unclear instead of guessing.
- Return clean notes only, not JSON.
`.trim();

  const userPrompt = `
Source type: ${sourceType || "custom_text"}
Metadata: ${JSON.stringify(metadata || {})}

Clean and organize the following notes:

${cleanText}
`.trim();

  const model = getAICleanupModel();

  const result = await callOpenAIResponsesAPI({
    model,
    systemPrompt,
    userPrompt,
    maxOutputTokens: 5000,
    jsonMode: false,
  });

  return {
    cleaned_notes: result.text,
    usage: result.usage,
    model: result.raw_model || model,
  };
}

async function generateQuestionsWithAI({
  sourceText,
  questionCount = 10,
  difficulty = "mixed",
  questionType = "mcq",
  metadata = {},
}) {
  const cleanText = validateAISourceText(sourceText);
  const count = Math.max(1, Math.min(50, Number(questionCount || 10)));

  const systemPrompt = `
You are generating original USMLE-style assessment questions for NextGen USMLE.

Rules:
- Use only the provided source material.
- Do not invent facts.
- Do not copy proprietary question-bank content.
- Do not use outside question bank wording.
- If there is not enough material, generate fewer questions and include a warning.
- Return strict JSON only.
- Each question must have A, B, C, D options.
- Each question must have one correct answer.
- Each explanation must be grounded in the provided source.
`.trim();

  const userPrompt = `
Generate ${count} ${questionType || "mcq"} questions.

Difficulty: ${difficulty || "mixed"}
Metadata: ${JSON.stringify(metadata || {})}

Return JSON exactly in this shape:
{
  "questions": [
    {
      "question_text": "...",
      "options": {
        "A": "...",
        "B": "...",
        "C": "...",
        "D": "..."
      },
      "correct_answer": "A",
      "explanation": "...",
      "difficulty": "medium",
      "points": 1
    }
  ],
  "warnings": []
}

Source material:
${cleanText}
`.trim();

  const model = getAIModel();

  const aiResult = await callOpenAIResponsesAPI({
    model,
    systemPrompt,
    userPrompt,
    maxOutputTokens: 7000,
    jsonMode: true,
  });

  const parsed = safeJsonParseFromAI(aiResult.text);

  return {
    questions: normalizeAIQuestions(parsed.questions || []),
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
    usage: aiResult.usage,
    model: aiResult.raw_model || model,
  };
}

app.post("/admin/ai/clean-notes", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);

    if (!isAIConfigured()) {
      return res.status(500).json({
        success: false,
        error: getAIConfigError(),
      });
    }

    const db = await readLiveDb();
    const { sourceType, sourceText, sourceSession } = getSourceTextFromRequest({
      db,
      body: req.body || {},
    });

    const aiResult = await cleanNotesWithAI({
      sourceText,
      sourceType,
      metadata: {
        session_id: req.body.session_id || null,
        course_id: req.body.course_id || sourceSession?.course_id || null,
        topic: sourceSession?.topic || sourceSession?.title || null,
      },
    });

    const usageLog = await logAIUsage({
      user,
      action: "clean_notes",
      model: aiResult.model,
      usage: aiResult.usage,
      sourceLength: String(sourceText || "").length,
    });

    res.json({
      success: true,
      cleaned_notes: aiResult.cleaned_notes,
      source_length: String(sourceText || "").length,
      ai_usage: usageLog,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to clean notes with AI",
    });
  }
});

app.post("/admin/assessments/generate-from-source", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);

    if (!isAIConfigured()) {
      return res.status(500).json({
        success: false,
        error: getAIConfigError(),
      });
    }

    const db = await readLiveDb();

    const courseId = String(req.body.course_id || "").trim();

    if (!courseId) {
      return res.status(400).json({
        success: false,
        error: "course_id is required",
      });
    }

    const course = db.courses?.[courseId];

    if (!course) {
      return res.status(404).json({
        success: false,
        error: "Course not found",
      });
    }

    const { sourceType, sourceText, sourceSession } = getSourceTextFromRequest({
      db,
      body: req.body || {},
    });

    const result = await generateQuestionsWithAI({
      sourceText,
      questionCount: req.body.question_count,
      difficulty: req.body.difficulty || "mixed",
      questionType: req.body.question_type || "mcq",
      metadata: {
        course_id: courseId,
        course_name: course.name || "",
        session_id: req.body.session_id || null,
        session_topic: sourceSession?.topic || sourceSession?.title || null,
        title: req.body.title || "",
        instructions: req.body.instructions || "",
        source_type: sourceType,
      },
    });

    const usageLog = await logAIUsage({
      user,
      action: "generate_assessment",
      model: result.model,
      usage: result.usage,
      sourceLength: String(sourceText || "").length,
      questionCount: result.questions.length,
    });

    res.json({
      success: true,
      questions: result.questions,
      warnings: result.warnings,
      source_length: String(sourceText || "").length,
      ai_usage: usageLog,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to generate assessment questions",
    });
  }
});
app.get("/admin/ai/usage", async (req, res) => {
  try {
    await requireAdmin(req);

    const db = await readLiveDb();
    const logs = Object.values(db.aiUsageLogs || {}).sort((a, b) =>
      String(b.created_at || "").localeCompare(String(a.created_at || ""))
    );

    const totalTokens = logs.reduce((sum, item) => sum + Number(item.total_tokens || 0), 0);
    const totalCost = logs.reduce((sum, item) => sum + Number(item.estimated_cost_usd || 0), 0);
    const today = new Date().toISOString().slice(0, 10);
    const todayLogs = logs.filter((item) => String(item.created_at || "").startsWith(today));
    const todayCost = todayLogs.reduce((sum, item) => sum + Number(item.estimated_cost_usd || 0), 0);

    res.json({
      success: true,
      summary: {
        total_requests: logs.length,
        total_tokens: totalTokens,
        total_cost_usd: Number(totalCost.toFixed(6)),
        today_requests: todayLogs.length,
        today_cost_usd: Number(todayCost.toFixed(6)),
      },
      logs: logs.slice(0, 200),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load AI usage",
    });
  }
});

app.get("/", (req, res) => res.send("NextGen Backend Running"));
app.get("/health", async (req, res) => {
  const liveDbExists = await fs.access(LIVE_DB_PATH).then(() => true).catch(() => false);
  res.json({ success: true, message: "Backend running", data_dir: DATA_DIR, live_db_path: LIVE_DB_PATH, live_db_exists: liveDbExists });
})

app.post("/auth/login", async (req, res) => {
  try {
    await ensureBootstrapAdmin();

    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password are required",
      });
    }

    const db = await readLiveDb();
    const user = findUserByEmail(db, email);

    if (!user || !verifyPassword(password, user)) {
      return res.status(400).json({
        success: false,
        error: "Invalid email or password",
      });
    }

    const token = signAuthToken(user);
    const safeUser = sanitizeUser(user);

    res.json({
      success: true,
      token,
      user: safeUser,
      record: safeUser,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Login failed",
    });
  }
});

app.post("/auth/signup", async (req, res) => {
  try {
    await ensureBootstrapAdmin();

    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const passwordConfirm = String(req.body.passwordConfirm || req.body.password_confirm || "");
    const name = String(req.body.name || "").trim();

    if (!name) {
      return res.status(400).json({
        success: false,
        error: "Name is required",
      });
    }

    if (!email) {
      return res.status(400).json({
        success: false,
        error: "Email is required",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        error: "Password must be at least 8 characters",
      });
    }

    if (passwordConfirm && password !== passwordConfirm) {
      return res.status(400).json({
        success: false,
        error: "Passwords do not match",
      });
    }

    const db = await readLiveDb();

    if (findUserByEmail(db, email)) {
      return res.status(400).json({
        success: false,
        error: "An account with this email already exists",
      });
    }

    const user = createBackendUser({
      email,
      name,
      password,
      role: "student",
    });

    db.users[user.id] = user;
    await writeLiveDb(db);

    const token = signAuthToken(user);
    const safeUser = sanitizeUser(user);

    res.json({
      success: true,
      token,
      user: safeUser,
      record: safeUser,
      created: true,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Signup failed",
    });
  }
});

app.get("/student/feature-access", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const features = getStudentFeatureAccess(db, user);

    res.json({
      success: true,
      features,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load feature access",
    });
  }
});

app.post("/student/external-library/access", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);

    if (user.role !== "student" && user.role !== "admin") {
      return res.status(403).json({
        success: false,
        error: "Only students can open the external video library",
      });
    }

    const db = await readLiveDb();
    const access = getExternalLibraryAccess(db, user);

    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        locked: true,
        feature: "video_library",
        upgrade_url: "/plans",
        error:
          "Your current plan does not include UWorld Video Library access. Please upgrade to a plan that includes Video Library.",
      });
    }

    const token = signExternalLibraryToken({
      user,
      enrollment: access.enrollment,
      plan: access.plan,
      course: access.course,
      accessEndsAt: access.accessEndsAt,
    });

    const redirect_url = `${EXTERNAL_LIBRARY_URL.replace(/\/$/, "")}/sso-login?token=${encodeURIComponent(token)}`;

    res.json({
      success: true,
      redirect_url,
      expires_in_minutes: EXTERNAL_LIBRARY_TOKEN_MINUTES,
      access_ends_at: access.accessEndsAt,
      access_days: access.accessDays,
      plan: access.plan ? sanitizePlan(access.plan) : null,
      course: access.course ? sanitizeCourse(access.course) : null,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to create external library access link",
    });
  }
});

app.get("/external-library/sso/verify", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();

    if (!token) {
      return res.status(400).json({
        success: false,
        error: "SSO token is required",
      });
    }

    let decoded;

    try {
      decoded = jwt.verify(token, EXTERNAL_LIBRARY_SSO_SECRET);
    } catch {
      return res.status(401).json({
        success: false,
        error: "SSO token is invalid or expired",
      });
    }

    if (decoded.purpose !== "external_library_sso") {
      return res.status(401).json({
        success: false,
        error: "Invalid SSO token purpose",
      });
    }

    const db = await readLiveDb();
    const user = db.users?.[String(decoded.sub)] || findUserByEmail(db, decoded.email);

    if (!user?.id) {
      return res.status(404).json({
        success: false,
        error: "Student account not found",
      });
    }

    const access = getExternalLibraryAccess(db, sanitizeUser(user));

    if (!access.allowed) {
      return res.status(403).json({
        success: false,
        error: "Video Library access is no longer active for this student",
      });
    }

    res.json({
      success: true,
      student: {
        id: user.id,
        name: user.name || decoded.name || user.email || "NextGen Student",
        email: user.email,
        tier: decoded.tier || "premium",
        accessEndsAt: decoded.accessEndsAt || access.accessEndsAt,
        plan_id: decoded.plan_id || access.plan?.id || null,
        plan_name: decoded.plan_name || access.plan?.name || null,
        course_id: decoded.course_id || access.course?.id || null,
        course_name: decoded.course_name || access.course?.name || null,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to verify external library SSO token",
    });
  }
});

app.get("/auth/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);

    res.json({
      success: true,
      user,
      record: user,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load current user",
    });
  }
});

app.post("/auth/logout", async (req, res) => {
  res.json({
    success: true,
    message: "Logged out",
  });
});
;

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
    await ensureBootstrapAdmin();

    const profile = await verifyGoogleIdToken(req.body.id_token);
    const db = await readLiveDb();

    let user = findUserByEmail(db, profile.email);
    let created = false;

    if (!user) {
      user = createBackendUser({
        email: profile.email,
        name: profile.name,
        role: "student",
        google_sub: profile.google_sub,
        avatar_url: profile.picture,
      });

      created = true;
    } else {
      user.google_sub = user.google_sub || profile.google_sub;
      user.avatar_url = user.avatar_url || profile.picture;
      user.name = user.name || profile.name;
      user.verified = true;
      user.updated_at = new Date().toISOString();
    }

    db.users[user.id] = user;

    db.googleAuthUsers[profile.email] = {
      email: profile.email,
      user_id: user.id,
      google_sub: profile.google_sub,
      name: profile.name,
      picture: profile.picture,
      created_at: db.googleAuthUsers[profile.email]?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await writeLiveDb(db);

    const token = signAuthToken(user);
    const safeUser = sanitizeUser(user);

    res.json({
      success: true,
      token,
      user: safeUser,
      record: safeUser,
      created,
    });
  } catch (error) {
    console.error("Google auth error:", error.response?.data || error.message);

    res.status(error.statusCode || error.response?.status || 500).json({
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

// -----------------------------------------------------------------------------
// Backend-owned Courses, Live Sessions, and Announcements
// PocketBase is no longer used for LMS records or authentication.
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


// -----------------------------------------------------------------------------
// Admin Enrollments + Payments
// -----------------------------------------------------------------------------

app.get("/admin/enrollments", async (req, res) => {
  try {
    await requireAdmin(req);
    const db = await readLiveDb();
    let enrollments = Object.values(db.enrollments || {}).map((item) => sanitizeAdminEnrollment(item, db));

    if (req.query.course_id) {
      enrollments = enrollments.filter((item) => String(item.course_id) === String(req.query.course_id));
    }

    if (req.query.status) {
      enrollments = enrollments.filter((item) => String(item.status) === String(req.query.status));
    }

    if (req.query.type) {
      enrollments = enrollments.filter((item) => String(item.type) === String(req.query.type));
    }

    enrollments.sort(sortNewestFirst);

    res.json({
      success: true,
      count: enrollments.length,
      enrollments,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load enrollments",
    });
  }
});

app.post("/admin/enrollments", async (req, res) => {
  try {
    await requireAdmin(req);
    const db = await readLiveDb();

    const courseId = String(req.body.course_id || "").trim();
    const email = normalizeEmail(req.body.email || req.body.student_email || req.body.user_email);
    const name = String(req.body.name || req.body.student_name || "Student").trim();
    const isDemo = Boolean(req.body.is_demo || req.body.type === "demo");

    if (!courseId) return res.status(400).json({ success: false, error: "course_id is required" });
    if (!email && !req.body.user_id) return res.status(400).json({ success: false, error: "Student email or user_id is required" });
    if (!db.courses[courseId]) return res.status(404).json({ success: false, error: "Course not found" });

    let user = req.body.user_id ? db.users[String(req.body.user_id)] : findUserByEmail(db, email);

    if (!user) {
      user = createBackendUser({
        email,
        name: name || email.split("@")[0],
        role: "student",
      });
      db.users[user.id] = user;
    }

    const enrollment = createBackendEnrollment(db, {
      userId: user.id,
      userName: user.name || name || user.email || "Student",
      courseId,
      isDemo,
      accessGranted: req.body.access_granted !== false,
      demoExpiry: req.body.demo_expiry || null,
      planId: req.body.plan_id || null,
    });

    if (req.body.progress_percentage !== undefined) {
      enrollment.progress_percentage = Number(req.body.progress_percentage || 0) || 0;
    }

    enrollment.updated_at = new Date().toISOString();
    db.enrollments[enrollment.id] = enrollment;

    await writeLiveDb(db);

    res.json({
      success: true,
      enrollment: sanitizeAdminEnrollment(enrollment, db),
      created: true,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to create enrollment",
    });
  }
});

app.patch("/admin/enrollments/:enrollmentId", async (req, res) => {
  try {
    await requireAdmin(req);
    const db = await readLiveDb();
    const enrollment = findEnrollmentById(db, req.params.enrollmentId);

    if (!enrollment) {
      return res.status(404).json({ success: false, error: "Enrollment not found" });
    }

    if (req.body.access_granted !== undefined) enrollment.access_granted = Boolean(req.body.access_granted);
    if (req.body.is_active !== undefined) enrollment.access_granted = Boolean(req.body.is_active);
    if (req.body.demo_expiry !== undefined) enrollment.demo_expiry = req.body.demo_expiry || null;
    if (req.body.plan_id !== undefined) enrollment.plan_id = req.body.plan_id || null;
    if (req.body.progress_percentage !== undefined) enrollment.progress_percentage = Number(req.body.progress_percentage || 0) || 0;
    if (req.body.user_name !== undefined || req.body.student_name !== undefined || req.body.name !== undefined) {
      enrollment.user_name = String(req.body.user_name || req.body.student_name || req.body.name || enrollment.user_name || "Student").trim();
    }

    enrollment.updated_at = new Date().toISOString();
    db.enrollments[enrollment.id] = enrollment;

    await writeLiveDb(db);

    res.json({
      success: true,
      enrollment: sanitizeAdminEnrollment(enrollment, db),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to update enrollment",
    });
  }
});

app.post("/admin/enrollments/:enrollmentId/revoke", async (req, res) => {
  try {
    await requireAdmin(req);
    const db = await readLiveDb();
    const enrollment = findEnrollmentById(db, req.params.enrollmentId);

    if (!enrollment) {
      return res.status(404).json({ success: false, error: "Enrollment not found" });
    }

    enrollment.access_granted = false;
    enrollment.updated_at = new Date().toISOString();
    db.enrollments[enrollment.id] = enrollment;

    await writeLiveDb(db);

    res.json({
      success: true,
      enrollment: sanitizeAdminEnrollment(enrollment, db),
      message: "Enrollment access revoked",
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to revoke enrollment",
    });
  }
});

app.delete("/admin/enrollments/:enrollmentId", async (req, res) => {
  try {
    await requireAdmin(req);
    const db = await readLiveDb();
    const enrollment = findEnrollmentById(db, req.params.enrollmentId);

    if (!enrollment) {
      return res.status(404).json({ success: false, error: "Enrollment not found" });
    }

    const deleted = sanitizeAdminEnrollment(enrollment, db);
    delete db.enrollments[enrollment.id];

    await writeLiveDb(db);

    res.json({
      success: true,
      deleted_enrollment: deleted,
      message: "Enrollment deleted",
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to delete enrollment",
    });
  }
});

app.get("/admin/payments", async (req, res) => {
  try {
    await requireAdmin(req);
    const db = await readLiveDb();
    let payments = buildDerivedPayments(db);

    if (req.query.course_id) {
      payments = payments.filter((item) => String(item.course_id) === String(req.query.course_id));
    }

    if (req.query.status) {
      payments = payments.filter((item) => String(item.status) === String(req.query.status) || String(item.payment_status) === String(req.query.status));
    }

    res.json({
      success: true,
      count: payments.length,
      payments,
      total_amount_cents: payments
        .filter((payment) => ["paid", "completed", "succeeded"].includes(String(payment.status || payment.payment_status)))
        .reduce((sum, payment) => sum + Number(payment.amount_cents || 0), 0),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to load payments",
    });
  }
});

app.patch("/admin/payments/:paymentId", async (req, res) => {
  try {
    await requireAdmin(req);
    const db = await readLiveDb();
    db.payments = db.payments || {};
    const payment = db.payments[String(req.params.paymentId)];

    if (!payment) {
      return res.status(404).json({ success: false, error: "Payment not found" });
    }

    const allowed = ["status", "payment_status", "amount_cents", "currency", "metadata", "paid_at"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) payment[key] = req.body[key];
    }

    if (payment.amount_cents !== undefined) payment.amount_cents = Number(payment.amount_cents || 0) || 0;
    payment.updated_at = new Date().toISOString();

    db.payments[payment.id] = payment;
    await writeLiveDb(db);

    res.json({
      success: true,
      payment: sanitizePayment(payment, db),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Failed to update payment",
    });
  }
});

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
      db.payments = db.payments || {};
      const paymentId = uuid();
      db.payments[paymentId] = {
        id: paymentId,
        enrollment_id: enrollment.id,
        user_id: studentId,
        student_id: studentId,
        course_id: courseId,
        plan_id: plan.id,
        plan_name: plan.name || "Plan",
        coupon_code: coupon?.code || null,
        original_amount_cents: pricing.original_amount_cents,
        discount_cents: pricing.discount_cents,
        amount_cents: 0,
        final_amount_cents: 0,
        currency: plan.currency || "usd",
        status: "completed",
        payment_status: "completed",
        payment_method: coupon?.id ? "coupon" : "free_checkout",
        source: "free_checkout",
        created_at: new Date().toISOString(),
        paid_at: new Date().toISOString(),
      };
      if (coupon?.id) { coupon.used_count = Number(coupon.used_count || 0) + 1; coupon.updated_at = new Date().toISOString(); db.couponRedemptions[uuid()] = { id: uuid(), coupon_id: coupon.id, coupon_code: coupon.code, plan_id: plan.id, enrollment_id: enrollment.id, student_id: studentId, course_id: courseId, original_amount_cents: pricing.original_amount_cents, discount_cents: pricing.discount_cents, final_amount_cents: 0, redeemed_at: new Date().toISOString() }; }
      await writeLiveDb(db);
      return res.json({ success: true, free_checkout: true, url: null, plan: sanitizePlan(plan), pricing, access_grant: { granted: true, method: "backend_enrollment_granted", enrollment_id: enrollment.id }, message: "Access granted without Stripe checkout." });
    }
    const session = await stripe.checkout.sessions.create({ mode: "payment", payment_method_types: ["card"], line_items: [{ price_data: { currency: plan.currency || "usd", product_data: { name: plan.name, description: plan.description || "Course enrollment" }, unit_amount: pricing.final_amount_cents }, quantity: 1 }], metadata: { enrollmentId, studentId, courseId, planId: plan.id, couponCode: coupon?.code || "", originalAmountCents: String(pricing.original_amount_cents), discountCents: String(pricing.discount_cents), finalAmountCents: String(pricing.final_amount_cents) }, success_url: successUrl || "https://live.nextgenusmlelms.com/payment-success", cancel_url: cancelUrl || "https://live.nextgenusmlelms.com/payment-cancel" });
    db.payments = db.payments || {};
    db.payments[session.id] = {
      id: session.id,
      checkout_session_id: session.id,
      stripe_session_id: session.id,
      enrollment_id: enrollmentId,
      user_id: studentId,
      student_id: studentId,
      course_id: courseId,
      plan_id: plan.id,
      plan_name: plan.name || "Plan",
      coupon_code: coupon?.code || null,
      original_amount_cents: pricing.original_amount_cents,
      discount_cents: pricing.discount_cents,
      amount_cents: pricing.final_amount_cents,
      final_amount_cents: pricing.final_amount_cents,
      currency: plan.currency || "usd",
      status: "pending",
      payment_status: "pending",
      payment_method: "stripe",
      source: "stripe_checkout",
      created_at: new Date().toISOString(),
      metadata: session.metadata || {},
    };
    await writeLiveDb(db);
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
      const encryptedToken = crypto
        .createHmac("sha256", process.env.ZOOM_WEBHOOK_SECRET_TOKEN)
        .update(plainToken)
        .digest("hex");

      return res.status(200).json({ plainToken, encryptedToken });
    }

    if (event === "recording.completed") {
      const object = req.body.payload.object;
      const meetingId = String(object.id);
      const db = await readLiveDb();

      const result = await upsertZoomRecordingFromObject({
        db,
        object,
        forceImportTranscript: true,
      });

      await writeLiveDb(db);

      return res.status(200).json({
        received: true,
        saved: true,
        meeting_id: meetingId,
        transcript_found: Boolean(result.transcriptFile),
        transcript_imported: Boolean(result.transcriptText),
        transcript_url: result.recordingPayload.transcript_url,
        session_id: result.sessionId,
      });
    }

    res.status(200).json({ received: true });
  } catch (e) {
    console.error("Zoom webhook error:", e.response?.data || e.message);

    // Return 200 so Zoom does not keep retrying forever for app-side errors.
    res.status(200).json({
      success: false,
      error: e.response?.data || e.message,
    });
  }
});

app.get("/zoom/recordings", async (req, res) => {
  try {
    const token = await getZoomAccessToken();
    const to = todayKey();
    const from = todayKey(addDays(new Date(), -30));

    const response = await axios.get(
      `https://api.zoom.us/v2/users/me/recordings?from=${from}&to=${to}&page_size=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const db = await readLiveDb();

    const recordings = (response.data?.meetings || []).map((meeting) => {
      const files = meeting.recording_files || [];
      const videoFile = findVideoFile(files);
      const transcriptFile = findTranscriptFile(files);

      return sanitizePublicRecording({
        ...(db.recordings[String(meeting.id)] || {}),
        meeting_id: String(meeting.id),
        uuid: meeting.uuid,
        topic: meeting.topic,
        start_time: meeting.start_time,
        duration: meeting.duration,
        share_url: meeting.share_url,
        recording_url: videoFile?.play_url || meeting.share_url || videoFile?.download_url || null,
        download_url: videoFile?.download_url || null,
        transcript_url: transcriptFile?.play_url || transcriptFile?.download_url || db.recordings[String(meeting.id)]?.transcript_url || null,
        transcript_download_url: transcriptFile?.download_url || db.recordings[String(meeting.id)]?.transcript_download_url || null,
        file_type: videoFile?.file_type || null,
        recording_type: videoFile?.recording_type || null,
        status: videoFile?.status || "completed",
      });
    });

    res.json({ success: true, from, to, count: recordings.length, recordings });
  } catch (e) {
    res.status(500).json({ success: false, error: e.response?.data || e.message });
  }
});

app.post("/zoom/recordings/:meetingId/refresh-transcript", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);

    const meetingId = String(req.params.meetingId || req.body.meeting_id || "").trim();

    if (!meetingId) {
      return res.status(400).json({
        success: false,
        error: "meeting_id is required",
      });
    }

    const { recording, accessToken } = await fetchZoomRecordingByMeetingId(meetingId);
    const db = await readLiveDb();

    const result = await upsertZoomRecordingFromObject({
      db,
      object: recording,
      accessToken,
      forceImportTranscript: true,
    });

    await writeLiveDb(db);

    res.json({
      success: true,
      meeting_id: meetingId,
      transcript_found: Boolean(result.transcriptFile),
      transcript_imported: Boolean(result.transcriptText),
      transcript_url: result.recordingPayload.transcript_url,
      transcript_download_url: result.recordingPayload.transcript_download_url,
      session_id: result.sessionId,
      recording: sanitizePublicRecording(result.recordingPayload),
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({
      success: false,
      error: e.response?.data || e.message,
    });
  }
});
app.post("/live/recordings/publish", async (req, res) => { try { const { user } = await requireAdminOrInstructor(req); const db = await readLiveDb(); const key = String(req.body.meeting_id); if (!key) return res.status(400).json({ success: false, error: "meeting_id is required" }); db.recordings[key] = { ...(db.recordings[key] || {}), meeting_id: key, session_id: req.body.session_id || db.recordings[key]?.session_id || null, course_id: req.body.course_id || db.recordings[key]?.course_id || null, topic: req.body.topic || db.recordings[key]?.topic || null, recording_url: req.body.recording_url || db.recordings[key]?.recording_url || null, share_url: req.body.share_url || db.recordings[key]?.share_url || null, published: req.body.published !== false, published_at: new Date().toISOString(), published_by: user.id }; await writeLiveDb(db); res.json({ success: true, recording: db.recordings[key] }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.post("/live/recordings/unpublish", async (req, res) => { try { await requireAdminOrInstructor(req); const db = await readLiveDb(); const key = String(req.body.meeting_id); db.recordings[key] = { ...(db.recordings[key] || {}), meeting_id: key, published: false, unpublished_at: new Date().toISOString() }; await writeLiveDb(db); res.json({ success: true, recording: db.recordings[key] }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });
app.get("/live/recordings/published", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); const db = await readLiveDb(); if (req.query.course_id) { const e = getBackendEnrollment(db, { userId: user.id, courseId: req.query.course_id }); if (e?.is_demo && !db.demoSettings.allow_recordings) return res.json({ success: true, count: 0, recordings: [], demo_restricted: true }); } let recordings = Object.values(db.recordings || {}).filter((r) => r.published); if (req.query.course_id) recordings = recordings.filter((r) => String(r.course_id || "") === String(req.query.course_id)); res.json({ success: true, count: recordings.length, recordings: recordings.map(sanitizePublicRecording) }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });



function buildNotesPayload({ db, sessionId, body = {}, user, publishMode = "save" }) {
  const previous = db.notes?.[sessionId] || {};
  const session = db.liveSessions?.[sessionId] || null;
  const now = new Date().toISOString();

  const notesPayload = {
    ...previous,
    session_id: sessionId,
    course_id: body.course_id || previous.course_id || session?.course_id || null,
    notes: body.notes !== undefined ? String(body.notes || "") : String(previous.notes || ""),
    transcript_url: body.transcript_url || previous.transcript_url || null,
    transcript_text: body.transcript_text !== undefined ? String(body.transcript_text || "") : String(previous.transcript_text || ""),
    transcript_raw_vtt: body.transcript_raw_vtt !== undefined ? String(body.transcript_raw_vtt || "") : String(previous.transcript_raw_vtt || ""),
    recording_url: body.recording_url || previous.recording_url || null,
    meeting_id: body.meeting_id || previous.meeting_id || session?.zoom_meeting_id || null,
    source: body.source || previous.source || "manual",
    updated_by: user?.id || previous.updated_by || null,
    updated_at: now,
  };

  if (publishMode === "publish" || body.published === true || body.is_published === true) {
    notesPayload.published = true;
    notesPayload.is_published = true;
    notesPayload.published_at = previous.published_at || now;
    notesPayload.published_by = previous.published_by || user?.id || null;
    notesPayload.unpublished_at = null;
    notesPayload.unpublished_by = null;
  }

  if (publishMode === "unpublish" || body.published === false || body.is_published === false) {
    notesPayload.published = false;
    notesPayload.is_published = false;
    notesPayload.unpublished_at = now;
    notesPayload.unpublished_by = user?.id || null;
  }

  return notesPayload;
}

async function saveNotesHandler(req, res) {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const sessionId = String(req.params.sessionId || "").trim();

    if (!sessionId) {
      return res.status(400).json({ success: false, error: "sessionId is required" });
    }

    db.notes[sessionId] = buildNotesPayload({
      db,
      sessionId,
      body: req.body || {},
      user,
      publishMode: "save",
    });

    await writeLiveDb(db);
    res.json({ success: true, message: "Notes saved successfully", notes: db.notes[sessionId] });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to save notes" });
  }
}

async function publishNotesHandler(req, res) {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const sessionId = String(req.params.sessionId || "").trim();

    if (!sessionId) {
      return res.status(400).json({ success: false, error: "sessionId is required" });
    }

    db.notes[sessionId] = buildNotesPayload({
      db,
      sessionId,
      body: req.body || {},
      user,
      publishMode: "publish",
    });

    await writeLiveDb(db);
    res.json({ success: true, message: "Notes published successfully", notes: db.notes[sessionId] });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to publish notes" });
  }
}

async function unpublishNotesHandler(req, res) {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const sessionId = String(req.params.sessionId || "").trim();

    if (!sessionId) {
      return res.status(400).json({ success: false, error: "sessionId is required" });
    }

    db.notes[sessionId] = buildNotesPayload({
      db,
      sessionId,
      body: req.body || {},
      user,
      publishMode: "unpublish",
    });

    await writeLiveDb(db);
    res.json({ success: true, message: "Notes unpublished successfully", notes: db.notes[sessionId] });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to unpublish notes" });
  }
}

async function getNotesHandler(req, res) {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const sessionId = String(req.params.sessionId || "").trim();
    const notes = db.notes?.[sessionId] || null;

    if (!notes) {
      return res.json({ success: true, notes: null });
    }

    const isStaff = user.role === "admin" || user.role === "instructor";

    if (!isStaff && notes.published !== true && notes.is_published !== true) {
      return res.json({ success: true, notes: null, unpublished: true });
    }

    if (notes?.course_id) {
      const enrollment = getBackendEnrollment(db, { userId: user.id, courseId: notes.course_id });
      if (!enrollment && !isStaff) {
        return res.status(403).json({ success: false, error: "No course access found" });
      }
      if (enrollment?.is_demo && !db.demoSettings.allow_notes_transcripts) {
        return res.json({ success: true, notes: null, demo_restricted: true });
      }
    }

    res.json({ success: true, notes });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to load notes" });
  }
}

app.post(["/live/notes/:sessionId", "/admin/notes/:sessionId"], saveNotesHandler);
app.post(["/live/notes/:sessionId/publish", "/admin/notes/:sessionId/publish"], publishNotesHandler);
app.post(["/live/notes/:sessionId/unpublish", "/admin/notes/:sessionId/unpublish"], unpublishNotesHandler);
app.get(["/live/notes/:sessionId", "/admin/notes/:sessionId"], getNotesHandler);


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
app.get("/student/assessments", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const courseId = req.query.course_id;

    if (!courseId) return res.status(400).json({ success: false, error: "course_id is required" });

    const enrollment = getBackendEnrollment(db, { userId: user.id, courseId });
    if (!enrollment && user.role !== "admin" && user.role !== "instructor") {
      return res.status(403).json({ success: false, error: "No course access found" });
    }

    if (enrollment?.is_demo && !db.demoSettings.allow_assessments) {
      return res.json({ success: true, count: 0, assessments: [], demo_restricted: true });
    }

    const items = Object.values(db.assessments || {})
      .filter((assessment) => String(assessment.course_id) === String(courseId) && assessment.is_published)
      .map((assessment) => sanitizeAssessmentForStudent(assessment, db.assessmentAttempts[assessmentAttemptKey(assessment.id, user.id)]));

    res.json({ success: true, count: items.length, assessments: items });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, error: e.message });
  }
});

app.get("/student/assessments/:assessmentId/take", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const assessment = db.assessments[req.params.assessmentId];

    if (!assessment || !assessment.is_published) {
      return res.status(404).json({ success: false, error: "Assessment not found" });
    }

    const enrollment = getBackendEnrollment(db, { userId: user.id, courseId: assessment.course_id });
    if (!enrollment && user.role !== "admin" && user.role !== "instructor") {
      return res.status(403).json({ success: false, error: "No course access found" });
    }

    const existingAttempt = db.assessmentAttempts[assessmentAttemptKey(assessment.id, user.id)] || null;

    res.json({
      success: true,
      assessment: sanitizeAssessmentForTaking(assessment, existingAttempt),
      existing_attempt: existingAttempt ? sanitizeAttemptForStudent(existingAttempt) : null,
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, error: e.message });
  }
});

app.post("/student/assessments/:assessmentId/submit", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const assessment = db.assessments[req.params.assessmentId];

    if (!assessment || !assessment.is_published) {
      return res.status(404).json({ success: false, error: "Assessment not found" });
    }

    const enrollment = getBackendEnrollment(db, { userId: user.id, courseId: assessment.course_id });
    if (!enrollment && user.role !== "admin" && user.role !== "instructor") {
      return res.status(403).json({ success: false, error: "No course access found" });
    }

    const key = assessmentAttemptKey(assessment.id, user.id);
    const existingAttempt = db.assessmentAttempts[key] || null;
    if (existingAttempt) {
      return res.status(400).json({
        success: false,
        error: "Assessment already submitted",
        attempt: sanitizeAttemptForStudent(existingAttempt),
      });
    }

    const graded = gradeAssessment(assessment, req.body.answers || {});
    const now = new Date().toISOString();

    const attempt = {
      id: key,
      assessment_id: assessment.id,
      assessment_title: assessment.title || "Assessment",
      course_id: assessment.course_id,
      session_id: assessment.session_id || null,
      user_id: user.id,
      user_name: user.name || user.email || "Student",
      user_email: user.email || "",
      answers: req.body.answers || {},
      marked_for_review: Array.isArray(req.body.marked_for_review) ? req.body.marked_for_review : [],
      score: graded.score,
      total: graded.total,
      percentage: graded.percentage,
      graded_answers: graded.graded,
      submitted_at: now,
      auto_submitted: Boolean(req.body.auto_submitted),
      review_status: "pending_review",
      released_to_student: false,
      reviewed_by: null,
      reviewed_at: null,
      admin_feedback: "",
      leaderboard_applied: false,
      leaderboard_applied_at: null,
      quiz_attempt_id: null,
    };

    db.assessmentAttempts[key] = attempt;
    await writeLiveDb(db);

    res.json({
      success: true,
      message: "Assessment submitted. Result is under admin review.",
      attempt: sanitizeAttemptForStudent(attempt),
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, error: e.message });
  }
});

app.get("/admin/assessments/report/:courseId", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const assessments = Object.values(db.assessments || {}).filter((assessment) => String(assessment.course_id) === String(req.params.courseId));
    const attempts = Object.values(db.assessmentAttempts || {}).filter((attempt) => String(attempt.course_id) === String(req.params.courseId));

    const reports = assessments.map((assessment) => {
      const related = attempts.filter((attempt) => attempt.assessment_id === assessment.id);
      const released = related.filter((attempt) => attempt.released_to_student === true || attempt.review_status === "released");
      const pendingReview = related.filter((attempt) => !attempt.released_to_student && attempt.review_status !== "released");
      const avg = released.length ? Math.round(released.reduce((sum, attempt) => sum + Number(attempt.percentage || 0), 0) / released.length) : 0;
      return {
        assessment_id: assessment.id,
        title: assessment.title,
        published: Boolean(assessment.is_published),
        attempts_count: related.length,
        released_attempts_count: released.length,
        pending_review_count: pendingReview.length,
        average_percentage: avg,
      };
    });

    res.json({
      success: true,
      course_id: req.params.courseId,
      assessments_count: assessments.length,
      attempts_count: attempts.length,
      pending_review_count: attempts.filter((attempt) => !attempt.released_to_student && attempt.review_status !== "released").length,
      reports,
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, error: e.message });
  }
});

app.get("/admin/assessment-attempts", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const courseId = req.query.course_id ? String(req.query.course_id) : "";
    const assessmentId = req.query.assessment_id ? String(req.query.assessment_id) : "";

    let attempts = Object.values(db.assessmentAttempts || {});
    if (courseId) attempts = attempts.filter((attempt) => String(attempt.course_id) === courseId);
    if (assessmentId) attempts = attempts.filter((attempt) => String(attempt.assessment_id) === assessmentId);

    attempts = attempts
      .map((attempt) => sanitizeAttemptForAdmin(attempt, db))
      .sort((a, b) => String(b.submitted_at || "").localeCompare(String(a.submitted_at || "")));

    res.json({ success: true, count: attempts.length, attempts });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to load assessment attempts" });
  }
});

app.get("/admin/assessment-attempts/:attemptId", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const attempt = db.assessmentAttempts[String(req.params.attemptId)];

    if (!attempt) return res.status(404).json({ success: false, error: "Assessment attempt not found" });

    const assessment = db.assessments?.[attempt.assessment_id] || null;
    res.json({
      success: true,
      attempt: sanitizeAttemptForAdmin(attempt, db),
      assessment,
      questions: assessment?.questions || [],
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to load assessment attempt" });
  }
});

app.patch("/admin/assessment-attempts/:attemptId/review", async (req, res) => {
  try {
    const { user } = await requireAdmin(req);
    const db = await readLiveDb();
    const attempt = db.assessmentAttempts[String(req.params.attemptId)];

    if (!attempt) return res.status(404).json({ success: false, error: "Assessment attempt not found" });

    if (req.body.admin_feedback !== undefined) attempt.admin_feedback = String(req.body.admin_feedback || "");
    if (req.body.review_status !== undefined) {
      const allowed = ["pending_review", "reviewed", "released"];
      const nextStatus = String(req.body.review_status || "pending_review");
      if (allowed.includes(nextStatus)) attempt.review_status = nextStatus;
    }
    if (req.body.released_to_student !== undefined) attempt.released_to_student = Boolean(req.body.released_to_student);

    if (attempt.released_to_student || attempt.review_status === "released") {
      attempt.review_status = "released";
      attempt.released_to_student = true;
      attempt.reviewed_by = user.id;
      attempt.reviewed_at = new Date().toISOString();
      applyReleasedAssessmentAttemptToLeaderboard(db, attempt, db.assessments?.[attempt.assessment_id]);
    } else {
      attempt.reviewed_by = user.id;
      attempt.reviewed_at = new Date().toISOString();
    }

    db.assessmentAttempts[attempt.id] = attempt;
    await writeLiveDb(db);

    res.json({
      success: true,
      attempt: sanitizeAttemptForAdmin(attempt, db),
      leaderboard: db.leaderboard?.[courseUserKey(attempt.course_id, attempt.user_id)] || null,
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to review assessment attempt" });
  }
});

app.post("/admin/assessment-attempts/:attemptId/release", async (req, res) => {
  try {
    const { user } = await requireAdmin(req);
    const db = await readLiveDb();
    const attempt = db.assessmentAttempts[String(req.params.attemptId)];

    if (!attempt) return res.status(404).json({ success: false, error: "Assessment attempt not found" });

    if (req.body.admin_feedback !== undefined) attempt.admin_feedback = String(req.body.admin_feedback || "");
    attempt.review_status = "released";
    attempt.released_to_student = true;
    attempt.reviewed_by = user.id;
    attempt.reviewed_at = new Date().toISOString();

    const leaderboard = applyReleasedAssessmentAttemptToLeaderboard(db, attempt, db.assessments?.[attempt.assessment_id]);

    db.assessmentAttempts[attempt.id] = attempt;
    await writeLiveDb(db);

    res.json({
      success: true,
      attempt: sanitizeAttemptForAdmin(attempt, db),
      leaderboard,
    });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, error: e.message || "Failed to release assessment result" });
  }
});

app.get("/student/dashboard/summary", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req); const courseId = req.query.course_id; if (!courseId) return res.status(400).json({ success: false, error: "course_id is required" });
    const db = await readLiveDb(); const enrollment = getBackendEnrollment(db, { userId: user.id, courseId }); const roadmap = buildProgressSummary({ db, courseId, userId: user.id }); const perf = performanceFromAttempts(getStudentAttempts(db, courseId, user.id)); const leaderboard = updateLeaderboard(db, { courseId, userId: user.id, userName: user.name || user.email || "Student" });
    let plan = { name: enrollment?.is_demo ? "Demo" : enrollment ? "Active" : "No active plan", days_left: null, is_demo: Boolean(enrollment?.is_demo) };
    if (enrollment?.is_demo && enrollment.demo_expiry) plan.days_left = Math.max(0, Math.ceil((new Date(`${enrollment.demo_expiry}T23:59:59`).getTime() - Date.now()) / 86400000));
    const assessments = Object.values(db.assessments || {}).filter((a) => String(a.course_id) === String(courseId) && a.is_published);
    const completedAssessments = assessments.filter((a) => { const attempt = db.assessmentAttempts[assessmentAttemptKey(a.id, user.id)]; return attempt && isAttemptReleased(attempt); });
    await writeLiveDb(db);
    res.json({ success: true, plan, roadmap, today: roadmap.today_day, performance: { study_streak: 0, best_streak: 0, total_study_time_hours: 0, average_mock_score: perf.average_score, latest_mock_score: perf.latest_score, best_mock_score: perf.best_score, attempts_count: perf.attempts_count }, focus_areas: perf.focus_areas, leaderboard: { points: leaderboard.total_points || 0, attendance_points: leaderboard.attendance_points || 0, task_points: leaderboard.task_points || 0, quiz_points: leaderboard.quiz_points || 0 }, assessments: { available: assessments.length, completed: completedAssessments.length, pending: Math.max(0, assessments.length - completedAssessments.length) } });
  } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); }
});

app.get("/live/debug/storage", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); if (user.role !== "admin") return res.status(403).json({ success: false, error: "Only admins can view storage debug" }); const db = await readLiveDb(); res.json({ success: true, data_dir: DATA_DIR, live_db_path: LIVE_DB_PATH, counts: { courses: Object.keys(db.courses || {}).length, liveSessions: Object.keys(db.liveSessions || {}).length, announcements: Object.keys(db.announcements || {}).length, recordings: Object.keys(db.recordings || {}).length, notes: Object.keys(db.notes || {}).length, enrollments: Object.keys(db.enrollments || {}).length, plans: Object.keys(db.plans || {}).length, coupons: Object.keys(db.coupons || {}).length, assessments: Object.keys(db.assessments || {}).length, assessmentAttempts: Object.keys(db.assessmentAttempts || {}).length, aiUsageLogs: Object.keys(db.aiUsageLogs || {}).length, payments: Object.keys(db.payments || {}).length, roadmaps: Object.keys(db.roadmaps || {}).length, roadmapProgress: Object.keys(db.roadmapProgress || {}).length, leaderboard: Object.keys(db.leaderboard || {}).length, googleAuthUsers: Object.keys(db.googleAuthUsers || {}).length }, updatedAt: db.updatedAt || null }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });


// -----------------------------------------------------------------------------
// CRM Growth Engine Backend (JSON persistent storage on Render disk)
// -----------------------------------------------------------------------------
// This module is intentionally backend-owned. Do not use PocketBase or frontend
// localStorage for CRM records. Frontend should call these APIs.

const CRM_DB_PATH = path.join(DATA_DIR, "crm-db.json");

const DEFAULT_CRM_SETTINGS = {
  global_ai_enabled: true,
  whatsapp_ai_enabled: false,
  email_ai_enabled: false,
  social_ai_enabled: false,
  default_approval_mode: "needs_approval",
  default_language: "english",
  default_region: "global",
  default_daily_send_limit: 50,
  default_brand_id: null,
  budget_mode: "approval",
  ai_usage_tracking_enabled: true,
  default_consultation_link: "",
  default_payment_link_behavior: "approval_required",
  unsubscribe_keywords: ["STOP", "UNSUBSCRIBE", "DON'T MESSAGE", "DO NOT MESSAGE", "NOT INTERESTED"],
  blocked_words: [],
  whatsapp_safety_thresholds: {
    max_daily_failures: 10,
    max_stop_replies_per_day: 5,
    max_blocked_per_day: 3,
  },
};

const DEFAULT_CRM_MODEL_PRICING = [
  {
    id: "model_gpt_4o_mini",
    model_name: "gpt-4o-mini",
    input_cost_per_1m_tokens: 0.15,
    output_cost_per_1m_tokens: 0.60,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "model_gpt_5_mini",
    model_name: "gpt-5-mini",
    input_cost_per_1m_tokens: 0.25,
    output_cost_per_1m_tokens: 2.00,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const DEFAULT_CRM_DB = {
  brands: [],
  leads: [],
  conversations: [],
  communities: [],
  community_posts: [],
  campaigns: [],
  outreach_queue: [],
  import_batches: [],
  ai_training: [],
  ai_strategies: [],
  ai_actions: [],
  ai_feedback: [],
  forbidden_claims: [],
  ai_usage: [],
  ai_cost_settings: [],
  model_pricing: DEFAULT_CRM_MODEL_PRICING,
  country_strategies: [],
  coupon_rules: [],
  followups: [],
  templates: [],
  approval_queue: [],
  settings: DEFAULT_CRM_SETTINGS,
  updated_at: null,
};

let crmWriteQueue = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function normalizeCrmString(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function normalizeCrmLower(value, fallback = "") {
  return normalizeCrmString(value, fallback).toLowerCase();
}

function ensureCrmArray(db, key) {
  if (!Array.isArray(db[key])) db[key] = [];
  return db[key];
}

function withTimestamps(record = {}, existing = null) {
  const now = nowIso();
  return {
    ...record,
    id: record.id || existing?.id || uuid(),
    created_at: existing?.created_at || record.created_at || now,
    updated_at: now,
  };
}

function safeCrmJson(value, fallback) {
  try {
    if (typeof value === "string") return JSON.parse(value);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

async function readCrmDb() {
  try {
    await ensureDataDir();
    const raw = await fs.readFile(CRM_DB_PATH, "utf8");
    const parsed = JSON.parse(raw);

    const merged = {
      ...DEFAULT_CRM_DB,
      ...parsed,
      brands: Array.isArray(parsed.brands) ? parsed.brands : [],
      leads: Array.isArray(parsed.leads) ? parsed.leads : [],
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
      communities: Array.isArray(parsed.communities) ? parsed.communities : [],
      community_posts: Array.isArray(parsed.community_posts) ? parsed.community_posts : [],
      campaigns: Array.isArray(parsed.campaigns) ? parsed.campaigns : [],
      outreach_queue: Array.isArray(parsed.outreach_queue) ? parsed.outreach_queue : [],
      import_batches: Array.isArray(parsed.import_batches) ? parsed.import_batches : [],
      ai_training: Array.isArray(parsed.ai_training) ? parsed.ai_training : [],
      ai_strategies: Array.isArray(parsed.ai_strategies) ? parsed.ai_strategies : [],
      ai_actions: Array.isArray(parsed.ai_actions) ? parsed.ai_actions : [],
      ai_feedback: Array.isArray(parsed.ai_feedback) ? parsed.ai_feedback : [],
      ai_usage: Array.isArray(parsed.ai_usage) ? parsed.ai_usage : [],
      ai_cost_settings: Array.isArray(parsed.ai_cost_settings) ? parsed.ai_cost_settings : [],
      model_pricing: Array.isArray(parsed.model_pricing) && parsed.model_pricing.length ? parsed.model_pricing : DEFAULT_CRM_MODEL_PRICING,
      country_strategies: Array.isArray(parsed.country_strategies) ? parsed.country_strategies : [],
      coupon_rules: Array.isArray(parsed.coupon_rules) ? parsed.coupon_rules : [],
      followups: Array.isArray(parsed.followups) ? parsed.followups : [],
      templates: Array.isArray(parsed.templates) ? parsed.templates : [],
      approval_queue: Array.isArray(parsed.approval_queue) ? parsed.approval_queue : [],
      settings: { ...DEFAULT_CRM_SETTINGS, ...(parsed.settings || {}) },
      updated_at: parsed.updated_at || null,
    };

    if (!merged.brands.length) {
      const brand = createDefaultCrmBrand();
      merged.brands.push(brand);
      merged.settings.default_brand_id = brand.id;
      await writeCrmDb(merged);
    } else if (!merged.settings.default_brand_id) {
      merged.settings.default_brand_id = merged.brands[0].id;
      await writeCrmDb(merged);
    }

    return merged;
  } catch (error) {
    if (error.code === "ENOENT") {
      const brand = createDefaultCrmBrand();
      const initial = {
        ...DEFAULT_CRM_DB,
        brands: [brand],
        settings: { ...DEFAULT_CRM_SETTINGS, default_brand_id: brand.id },
        updated_at: nowIso(),
      };
      await writeCrmDb(initial);
      return initial;
    }

    console.error("CRM DB read error:", error.message);
    return { ...DEFAULT_CRM_DB };
  }
}

async function writeCrmDb(db) {
  crmWriteQueue = crmWriteQueue.then(async () => {
    await ensureDataDir();
    const nextDb = {
      ...DEFAULT_CRM_DB,
      ...db,
      settings: { ...DEFAULT_CRM_SETTINGS, ...(db.settings || {}) },
      model_pricing: Array.isArray(db.model_pricing) && db.model_pricing.length ? db.model_pricing : DEFAULT_CRM_MODEL_PRICING,
      updated_at: nowIso(),
    };
    const tempPath = `${CRM_DB_PATH}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(nextDb, null, 2), "utf8");
    await fs.rename(tempPath, CRM_DB_PATH);
  });
  return crmWriteQueue;
}

function createDefaultCrmBrand() {
  const now = nowIso();
  return {
    id: "brand_nextgen_usmle",
    name: "NextGen USMLE",
    exam_key: "usmle",
    domain: "live.nextgenusmlelms.com",
    logo_url: "",
    primary_color: "#060F1E",
    accent_color: "#10B981",
    default_language: "english",
    support_email: "support@nextgenusmlelms.com",
    whatsapp_number: "",
    status: "active",
    created_at: now,
    updated_at: now,
  };
}

function getCrmBrandId(req, db, fallback = null) {
  return (
    normalizeCrmString(req.query.brand_id) ||
    normalizeCrmString(req.body?.brand_id) ||
    fallback ||
    db.settings?.default_brand_id ||
    db.brands?.[0]?.id ||
    null
  );
}

function normalizeCrmCollectionPayload(collection, body = {}, existing = null, brandId = null) {
  const now = nowIso();
  const base = {
    ...(existing || {}),
    ...(body || {}),
    id: body.id || existing?.id || uuid(),
    created_at: existing?.created_at || body.created_at || now,
    updated_at: now,
  };

  if (collection !== "brands" && brandId) {
    base.brand_id = body.brand_id || existing?.brand_id || brandId;
  }

  if (collection === "brands") {
    base.name = normalizeCrmString(base.name || base.brand_name || "New Brand");
    base.exam_key = normalizeCrmString(base.exam_key || base.name.toLowerCase().replace(/[^a-z0-9]+/g, "_"), "general");
    base.status = normalizeCrmLower(base.status, "active") || "active";
    base.default_language = normalizeCrmLower(base.default_language, "english") || "english";
    base.primary_color = base.primary_color || "#060F1E";
    base.accent_color = base.accent_color || "#10B981";
  }

  if (collection === "leads") {
    base.name = normalizeCrmString(base.name || "Unnamed Lead");
    base.email = normalizeEmail(base.email || "");
    base.whatsapp = normalizeCrmString(base.whatsapp || base.phone || "");
    base.phone = normalizeCrmString(base.phone || base.whatsapp || "");
    base.platform = normalizeCrmLower(base.platform, "manual") || "manual";
    base.status = normalizeCrmLower(base.status, "new") || "new";
    base.language = normalizeCrmLower(base.language, "english") || "english";
    base.region = normalizeCrmLower(base.region, "global") || "global";
    base.country = normalizeCrmString(base.country || "");
    base.economic_segment = normalizeCrmLower(base.economic_segment, "unknown") || "unknown";
    base.interest_level = normalizeCrmLower(base.interest_level, "unknown") || "unknown";
    base.lead_score = Math.max(0, Math.min(100, Number(base.lead_score || 0)));
    base.opt_in_status = normalizeCrmLower(base.opt_in_status, "unknown") || "unknown";
    base.unsubscribe_status = normalizeCrmLower(base.unsubscribe_status, "active") || "active";
    base.ai_enabled = base.ai_enabled !== false;
  }

  if (collection === "communities") {
    base.platform = normalizeCrmLower(base.platform, "manual") || "manual";
    base.name = normalizeCrmString(base.name || "New Community");
    base.status = normalizeCrmLower(base.status, "active") || "active";
    base.language = normalizeCrmLower(base.language, "english") || "english";
    base.region = normalizeCrmLower(base.region, "global") || "global";
    base.community_type = normalizeCrmLower(base.community_type, "international") || "international";
    base.member_count = Number(base.member_count || 0);
  }

  if (collection === "campaigns") {
    base.name = normalizeCrmString(base.name || "New Campaign");
    base.channel = normalizeCrmLower(base.channel, "manual") || "manual";
    base.status = normalizeCrmLower(base.status, "draft") || "draft";
    base.send_mode = normalizeCrmLower(base.send_mode, "safe_queue") || "safe_queue";
    base.approval_mode = normalizeCrmLower(base.approval_mode, "safe_queue") || "safe_queue";
    base.daily_limit = Number(base.daily_limit || 50);
    base.personalization_enabled = base.personalization_enabled !== false;
  }

  if (collection === "ai_training") {
    base.category = normalizeCrmString(base.category || "Company Knowledge");
    base.title = normalizeCrmString(base.title || "Untitled Knowledge");
    base.content = normalizeCrmString(base.content || "");
    base.is_active = base.is_active !== false;
    base.priority = Number(base.priority || 0);
    base.version = Number(base.version || existing?.version || 1);
  }

  if (collection === "templates") {
    base.name = normalizeCrmString(base.name || "Untitled Template");
    base.channel = normalizeCrmLower(base.channel, "whatsapp") || "whatsapp";
    base.language = normalizeCrmLower(base.language, "english") || "english";
    base.body = base.body || base.message_body || base.content || "";
    base.active = base.active !== false;
    base.approval_required = base.approval_required !== false;
    base.version = Number(base.version || existing?.version || 1);
  }

  return base;
}

function collectionResponseName(collection) {
  const map = {
    brands: "brands",
    leads: "leads",
    conversations: "conversations",
    communities: "communities",
    community_posts: "posts",
    campaigns: "campaigns",
    outreach_queue: "queue",
    import_batches: "batches",
    ai_training: "training",
    ai_strategies: "strategies",
    ai_actions: "actions",
    ai_feedback: "feedback",
    forbidden_claims: "claims",
    ai_usage: "usage",
    country_strategies: "country_strategies",
    coupon_rules: "coupon_rules",
    followups: "followups",
    templates: "templates",
    approval_queue: "items",
  };
  return map[collection] || collection;
}

function filterCrmRecords(req, records = [], brandId = null) {
  let output = [...records];

  if (brandId) {
    output = output.filter((item) => !item.brand_id || String(item.brand_id) === String(brandId));
  }

  const status = normalizeCrmString(req.query.status);
  if (status) output = output.filter((item) => String(item.status || "").toLowerCase() === status.toLowerCase());

  const platform = normalizeCrmString(req.query.platform);
  if (platform) output = output.filter((item) => String(item.platform || "").toLowerCase() === platform.toLowerCase());

  const q = normalizeCrmString(req.query.q || req.query.search);
  if (q) {
    const needle = q.toLowerCase();
    output = output.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
  }

  output.sort(sortNewestFirst);

  return output;
}

async function requireCrmAdmin(req) {
  return requireAdmin(req);
}

function registerCrmCrudRoutes({ route, collection, brandScoped = true }) {
  app.get(route, async (req, res) => {
    try {
      await requireCrmAdmin(req);
      const db = await readCrmDb();
      const brandId = brandScoped ? getCrmBrandId(req, db) : null;
      const records = filterCrmRecords(req, ensureCrmArray(db, collection), brandId);
      res.json({ success: true, [collectionResponseName(collection)]: records, count: records.length });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.post(route, async (req, res) => {
    try {
      await requireCrmAdmin(req);
      const db = await readCrmDb();
      const brandId = brandScoped ? getCrmBrandId(req, db) : null;
      const records = ensureCrmArray(db, collection);
      const record = normalizeCrmCollectionPayload(collection, req.body || {}, null, brandId);
      records.push(record);

      if (collection === "brands" && !db.settings.default_brand_id) {
        db.settings.default_brand_id = record.id;
      }

      await writeCrmDb(db);
      res.json({ success: true, [collectionResponseName(collection).replace(/s$/, "") || "record"]: record });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.get(`${route}/:id`, async (req, res) => {
    try {
      await requireCrmAdmin(req);
      const db = await readCrmDb();
      const record = ensureCrmArray(db, collection).find((item) => String(item.id) === String(req.params.id));

      if (!record) return res.status(404).json({ success: false, error: "Record not found" });

      res.json({ success: true, record });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.put(`${route}/:id`, async (req, res) => {
    try {
      await requireCrmAdmin(req);
      const db = await readCrmDb();
      const brandId = brandScoped ? getCrmBrandId(req, db) : null;
      const records = ensureCrmArray(db, collection);
      const index = records.findIndex((item) => String(item.id) === String(req.params.id));

      if (index < 0) return res.status(404).json({ success: false, error: "Record not found" });

      const record = normalizeCrmCollectionPayload(collection, req.body || {}, records[index], brandId);
      records[index] = record;

      await writeCrmDb(db);
      res.json({ success: true, record });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });

  app.delete(`${route}/:id`, async (req, res) => {
    try {
      await requireCrmAdmin(req);
      const db = await readCrmDb();
      const records = ensureCrmArray(db, collection);
      const before = records.length;
      db[collection] = records.filter((item) => String(item.id) !== String(req.params.id));
      await writeCrmDb(db);
      res.json({ success: true, deleted: before !== db[collection].length });
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.message });
    }
  });
}

function detectCountryFromPhone(rawPhone) {
  const phone = String(rawPhone || "").replace(/[^\d+]/g, "");
  const digits = phone.replace(/\D/g, "");

  const rules = [
    { prefix: "966", country: "Saudi Arabia", region: "middle_east", language: "arabic" },
    { prefix: "971", country: "United Arab Emirates", region: "middle_east", language: "arabic" },
    { prefix: "974", country: "Qatar", region: "middle_east", language: "arabic" },
    { prefix: "965", country: "Kuwait", region: "middle_east", language: "arabic" },
    { prefix: "968", country: "Oman", region: "middle_east", language: "arabic" },
    { prefix: "973", country: "Bahrain", region: "middle_east", language: "arabic" },
    { prefix: "20", country: "Egypt", region: "middle_east", language: "arabic" },
    { prefix: "92", country: "Pakistan", region: "south_asia", language: "urdu" },
    { prefix: "91", country: "India", region: "south_asia", language: "english" },
    { prefix: "234", country: "Nigeria", region: "africa", language: "english" },
    { prefix: "1", country: "United States/Canada", region: "north_america", language: "english" },
    { prefix: "44", country: "United Kingdom", region: "europe", language: "english" },
  ];

  const match = rules.find((item) => digits.startsWith(item.prefix));

  return {
    phone,
    country: match?.country || "",
    region: match?.region || "global",
    language: match?.language || "english",
  };
}

function parseManualContacts(input) {
  if (Array.isArray(input)) return input;

  const raw = String(input || "");
  return raw
    .split(/\n|,|;/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((value) => {
      if (value.includes("@")) return { email: value };
      return { whatsapp: value, phone: value };
    });
}

function validateCrmContact(row = {}) {
  const email = normalizeEmail(row.email || "");
  const whatsapp = normalizeCrmString(row.whatsapp || row.phone || "");
  const emailValid = !email || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const phoneDigits = whatsapp.replace(/\D/g, "");
  const phoneValid = !whatsapp || phoneDigits.length >= 8;

  return {
    email,
    whatsapp,
    phone: normalizeCrmString(row.phone || whatsapp),
    valid: Boolean((email && emailValid) || (whatsapp && phoneValid)),
    email_valid: emailValid,
    phone_valid: phoneValid,
  };
}

function findCouponForLead(db, { brandId, country, region, language, examType, leadStatus }) {
  const rules = ensureCrmArray(db, "coupon_rules").filter((rule) => {
    if (String(rule.brand_id) !== String(brandId)) return false;
    if (rule.active === false) return false;
    if (rule.country && country && String(rule.country).toLowerCase() !== String(country).toLowerCase()) return false;
    if (rule.region && region && String(rule.region).toLowerCase() !== String(region).toLowerCase()) return false;
    if (rule.language && language && String(rule.language).toLowerCase() !== String(language).toLowerCase()) return false;
    if (rule.exam_type && examType && String(rule.exam_type).toLowerCase() !== String(examType).toLowerCase()) return false;
    if (rule.lead_status && leadStatus && String(rule.lead_status).toLowerCase() !== String(leadStatus).toLowerCase()) return false;
    return true;
  });

  return rules[0] || null;
}

function buildImportPreviewRows({ db, brandId, rows = [], defaults = {} }) {
  const leads = ensureCrmArray(db, "leads");

  return rows.map((rawRow, index) => {
    const row = typeof rawRow === "string" ? (rawRow.includes("@") ? { email: rawRow } : { whatsapp: rawRow, phone: rawRow }) : rawRow || {};
    const validation = validateCrmContact(row);
    const detected = detectCountryFromPhone(validation.whatsapp || validation.phone);
    const email = validation.email;
    const whatsapp = validation.whatsapp || detected.phone;
    const duplicate = leads.some((lead) => {
      return (
        (email && normalizeEmail(lead.email) === email) ||
        (whatsapp && String(lead.whatsapp || lead.phone || "").replace(/\D/g, "") === whatsapp.replace(/\D/g, ""))
      );
    });

    const country = row.country || detected.country || defaults.country || "";
    const region = row.region || detected.region || defaults.region || "global";
    const language = row.language || detected.language || defaults.language || "english";
    const couponRule = findCouponForLead(db, {
      brandId,
      country,
      region,
      language,
      examType: row.exam_type || defaults.exam_type || "",
      leadStatus: row.status || "imported",
    });

    return {
      row_number: index + 1,
      name: normalizeCrmString(row.name || row.full_name || ""),
      email,
      whatsapp,
      phone: validation.phone || whatsapp,
      country,
      region,
      language,
      platform: row.platform || defaults.platform || "manual",
      source_community: row.source_community || defaults.source_community || "",
      exam_type: row.exam_type || defaults.exam_type || "",
      exam_timeline: row.exam_timeline || defaults.exam_timeline || "",
      notes: row.notes || row.pain_points || "",
      opt_in_status: row.opt_in_status || defaults.opt_in_status || "unknown",
      coupon_rule: couponRule ? { id: couponRule.id, coupon_code: couponRule.coupon_code, discount_percent: couponRule.discount_percent } : null,
      valid: validation.valid,
      duplicate,
      action: duplicate ? "skip_duplicate" : validation.valid ? "create" : "skip_invalid",
      errors: [
        validation.email_valid ? null : "Invalid email",
        validation.phone_valid ? null : "Invalid phone",
        validation.valid ? null : "No valid email or phone",
      ].filter(Boolean),
    };
  });
}

function estimateTokensFromText(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function getCrmModelPricing(db, modelName = "gpt-4o-mini") {
  return (
    ensureCrmArray(db, "model_pricing").find((item) => String(item.model_name).toLowerCase() === String(modelName).toLowerCase() && item.active !== false) ||
    DEFAULT_CRM_MODEL_PRICING[0]
  );
}

function estimateCrmAiCost({ db, model, inputTokens, outputTokens }) {
  const pricing = getCrmModelPricing(db, model);
  const input = Number(inputTokens || 0);
  const output = Number(outputTokens || 0);
  const cost =
    (input / 1000000) * Number(pricing.input_cost_per_1m_tokens || 0) +
    (output / 1000000) * Number(pricing.output_cost_per_1m_tokens || 0);

  return Number(cost.toFixed(6));
}

function getBrandCostSettings(db, brandId) {
  const existing = ensureCrmArray(db, "ai_cost_settings").find((item) => String(item.brand_id) === String(brandId));
  return {
    id: existing?.id || `cost_${brandId || "global"}`,
    brand_id: brandId || null,
    daily_cost_limit: Number(existing?.daily_cost_limit ?? 5),
    weekly_cost_limit: Number(existing?.weekly_cost_limit ?? 25),
    monthly_cost_limit: Number(existing?.monthly_cost_limit ?? 100),
    daily_token_limit: Number(existing?.daily_token_limit ?? 500000),
    monthly_token_limit: Number(existing?.monthly_token_limit ?? 5000000),
    max_cost_per_action: Number(existing?.max_cost_per_action ?? 0.25),
    max_tokens_per_action: Number(existing?.max_tokens_per_action ?? 12000),
    budget_mode: existing?.budget_mode || db.settings?.budget_mode || "approval",
    pause_at_limit: existing?.pause_at_limit !== false,
    notify_at_50: existing?.notify_at_50 !== false,
    notify_at_75: existing?.notify_at_75 !== false,
    notify_at_90: existing?.notify_at_90 !== false,
    notify_at_100: existing?.notify_at_100 !== false,
    agent_limits: existing?.agent_limits || {},
    campaign_limits: existing?.campaign_limits || {},
    lead_limits: existing?.lead_limits || {},
    created_at: existing?.created_at || nowIso(),
    updated_at: existing?.updated_at || nowIso(),
  };
}

function usageWithinDate(usage, startDate, endDate) {
  const ts = new Date(usage.created_at || 0).getTime();
  return ts >= startDate.getTime() && ts <= endDate.getTime();
}

function getCrmUsageTotals(db, brandId, { startDate, endDate } = {}) {
  let logs = ensureCrmArray(db, "ai_usage").filter((item) => !brandId || String(item.brand_id) === String(brandId));

  if (startDate && endDate) {
    logs = logs.filter((item) => usageWithinDate(item, startDate, endDate));
  }

  return logs.reduce(
    (acc, item) => {
      acc.calls += 1;
      acc.input_tokens += Number(item.input_tokens || 0);
      acc.output_tokens += Number(item.output_tokens || 0);
      acc.total_tokens += Number(item.total_tokens || 0);
      acc.estimated_cost += Number(item.estimated_cost || 0);
      if (item.status === "failed") acc.failed_calls += 1;
      return acc;
    },
    { calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost: 0, failed_calls: 0 }
  );
}

function todayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function monthRange() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setMonth(end.getMonth() + 1, 0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function weekRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function evaluateCrmBudget({ db, brandId, estimatedCost = 0, estimatedTokens = 0, agentName = "", campaignId = "", leadId = "" }) {
  const settings = getBrandCostSettings(db, brandId);
  const today = todayRange();
  const month = monthRange();
  const todayTotals = getCrmUsageTotals(db, brandId, { startDate: today.start, endDate: today.end });
  const monthTotals = getCrmUsageTotals(db, brandId, { startDate: month.start, endDate: month.end });

  const reasons = [];

  if (Number(estimatedCost || 0) > settings.max_cost_per_action) reasons.push("max_cost_per_action_exceeded");
  if (Number(estimatedTokens || 0) > settings.max_tokens_per_action) reasons.push("max_tokens_per_action_exceeded");
  if (todayTotals.estimated_cost + Number(estimatedCost || 0) > settings.daily_cost_limit) reasons.push("daily_cost_limit_reached");
  if (monthTotals.estimated_cost + Number(estimatedCost || 0) > settings.monthly_cost_limit) reasons.push("monthly_cost_limit_reached");
  if (todayTotals.total_tokens + Number(estimatedTokens || 0) > settings.daily_token_limit) reasons.push("daily_token_limit_reached");
  if (monthTotals.total_tokens + Number(estimatedTokens || 0) > settings.monthly_token_limit) reasons.push("monthly_token_limit_reached");

  const agentLimit = agentName ? settings.agent_limits?.[agentName] : null;
  if (agentLimit?.daily_cost_limit) {
    const agentToday = ensureCrmArray(db, "ai_usage")
      .filter((item) => String(item.brand_id) === String(brandId) && item.agent_name === agentName)
      .filter((item) => usageWithinDate(item, today.start, today.end))
      .reduce((sum, item) => sum + Number(item.estimated_cost || 0), 0);
    if (agentToday + Number(estimatedCost || 0) > Number(agentLimit.daily_cost_limit)) reasons.push("agent_daily_cost_limit_reached");
  }

  const campaignLimit = campaignId ? settings.campaign_limits?.[campaignId] : null;
  if (campaignLimit?.total_cost_limit) {
    const campaignTotal = ensureCrmArray(db, "ai_usage")
      .filter((item) => String(item.brand_id) === String(brandId) && String(item.campaign_id) === String(campaignId))
      .reduce((sum, item) => sum + Number(item.estimated_cost || 0), 0);
    if (campaignTotal + Number(estimatedCost || 0) > Number(campaignLimit.total_cost_limit)) reasons.push("campaign_cost_limit_reached");
  }

  const leadLimit = leadId ? settings.lead_limits?.[leadId] : null;
  if (leadLimit?.max_cost) {
    const leadTotal = ensureCrmArray(db, "ai_usage")
      .filter((item) => String(item.brand_id) === String(brandId) && String(item.lead_id) === String(leadId))
      .reduce((sum, item) => sum + Number(item.estimated_cost || 0), 0);
    if (leadTotal + Number(estimatedCost || 0) > Number(leadLimit.max_cost)) reasons.push("lead_cost_limit_reached");
  }

  return {
    allowed: reasons.length === 0 || settings.budget_mode === "warning",
    budget_mode: settings.budget_mode,
    requires_approval: reasons.length > 0 && settings.budget_mode === "approval",
    should_pause: reasons.length > 0 && settings.budget_mode === "strict",
    reasons,
    settings,
    todayTotals,
    monthTotals,
  };
}

async function logCrmAiActionAndUsage({
  db,
  brandId,
  agentName = "CRM AI",
  actionType,
  channel = "crm",
  leadId = null,
  campaignId = null,
  strategyId = null,
  inputText = "",
  outputText = "",
  model = "gpt-4o-mini",
  status = "draft",
  approvalStatus = "needs_approval",
}) {
  const inputTokens = estimateTokensFromText(inputText);
  const outputTokens = estimateTokensFromText(outputText);
  const totalTokens = inputTokens + outputTokens;
  const estimatedCost = estimateCrmAiCost({ db, model, inputTokens, outputTokens });

  const now = nowIso();
  const action = {
    id: uuid(),
    brand_id: brandId || null,
    agent_name: agentName,
    action_type: actionType,
    channel,
    lead_id: leadId,
    campaign_id: campaignId,
    strategy_id: strategyId,
    input_text: inputText,
    output_text: outputText,
    status,
    approval_status: approvalStatus,
    approved_by: null,
    executed_at: status === "executed" || status === "sent" ? now : null,
    created_at: now,
  };

  const usage = {
    id: uuid(),
    brand_id: brandId || null,
    agent_name: agentName,
    action_type: actionType,
    lead_id: leadId,
    campaign_id: campaignId,
    strategy_id: strategyId,
    channel,
    model_used: model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    estimated_cost: estimatedCost,
    status,
    created_at: now,
  };

  db.ai_actions.push(action);
  db.ai_usage.push(usage);

  if (approvalStatus === "needs_approval" || status === "draft") {
    db.approval_queue.push({
      id: uuid(),
      brand_id: brandId || null,
      action_id: action.id,
      agent_name: agentName,
      action_type: actionType,
      channel,
      lead_id: leadId,
      campaign_id: campaignId,
      strategy_id: strategyId,
      draft_content: outputText,
      estimated_cost: estimatedCost,
      total_tokens: totalTokens,
      status: "pending",
      created_at: now,
      updated_at: now,
    });
  }

  return { action, usage };
}

function classifyLeadFromMessage(message = "") {
  const text = String(message || "").toLowerCase();
  let score = 30;
  let exam_type = "";
  let exam_timeline = "";
  let recommended_offer = "Free 15-minute consultation";
  const pain = [];

  if (text.includes("step 1")) exam_type = "Step 1";
  if (text.includes("step 2") || text.includes("ck")) exam_type = "Step 2 CK";
  if (text.includes("uworld")) { score += 15; pain.push("Needs UWorld guidance"); }
  if (text.includes("nbme")) { score += 20; pain.push("NBME score concern"); }
  if (text.includes("live")) { score += 15; pain.push("Interested in live classes"); }
  if (text.includes("exam")) score += 10;
  if (text.includes("fail") || text.includes("stuck") || text.includes("low score")) { score += 15; pain.push("Score is stuck or low"); }

  const months = text.match(/(\d+)\s*(month|months)/i);
  const weeks = text.match(/(\d+)\s*(week|weeks)/i);
  if (months) exam_timeline = `${months[1]} months`;
  if (weeks) exam_timeline = `${weeks[1]} weeks`;

  if (weeks && Number(weeks[1]) <= 10) recommended_offer = "60 Days Marathon";
  else if (months && Number(months[1]) >= 3) recommended_offer = "120 Days Marathon";
  else if (text.includes("record") || text.includes("video")) recommended_offer = "UWorld Video Library";

  return {
    exam_type: exam_type || "Unknown",
    exam_timeline: exam_timeline || "Unknown",
    current_resources: [
      text.includes("uworld") ? "UWorld" : null,
      text.includes("first aid") ? "First Aid" : null,
      text.includes("nbme") ? "NBME" : null,
      text.includes("pathoma") ? "Pathoma" : null,
      text.includes("sketchy") ? "Sketchy" : null,
    ].filter(Boolean).join(" + ") || "Unknown",
    pain_points: pain.join(", ") || "Needs study structure guidance",
    interest_level: score >= 75 ? "high" : score >= 50 ? "medium" : "low",
    lead_score: Math.max(0, Math.min(100, score)),
    recommended_offer,
  };
}

function buildMockLeadReply(analysis) {
  return `That makes sense, Doctor. Based on what you shared, your main issue seems to be ${analysis.pain_points}. Are you currently following a fixed daily roadmap, or are you selecting topics randomly?`;
}

function buildMockCommunityPost({ platform, postType, topic, audience, cta, language }) {
  const isArabic = String(language || "").toLowerCase() === "arabic";
  const isUrdu = String(language || "").toLowerCase().includes("urdu");

  if (isArabic) {
    return `نقاش USMLE لليوم:\n\n${topic || "كثير من الطلاب يدرسون UWorld ولكن لا يرون تحسنًا واضحًا في NBME."}\n\nما السبب الأهم برأيك؟\nA) ضعف في الأساسيات\nB) مراجعة غير صحيحة للأخطاء\nC) جدول عشوائي\nD) عدد أسئلة غير كافٍ\n\n${cta || "اكتب إجابتك، وسنشارك طريقة المراجعة الصحيحة بعد النقاش."}`;
  }

  if (isUrdu) {
    return `USMLE Discussion:\n\n${topic || "Bohat se students UWorld karte hain lekin NBME score improve nahi hota."}\n\nAap ke khayal mein sab se bari wajah kya hai?\nA) First Aid weak\nB) Incorrects review theek nahi\nC) Random schedule\nD) Questions kam\n\n${cta || "Apna answer comment karein, phir hum strategy share karenge."}`;
  }

  return `USMLE Discussion of the Day:\n\n${topic || "Many students complete UWorld but still do not see NBME improvement."}\n\nWhat do you think is the biggest reason?\n\nA) Weak First Aid base\nB) Poor incorrect review\nC) Random study schedule\nD) Not enough questions\n\n${cta || "Comment your answer and we’ll share the correct strategy after discussion."}`;
}

// CRM core CRUD routes
registerCrmCrudRoutes({ route: "/admin/crm/brands", collection: "brands", brandScoped: false });
registerCrmCrudRoutes({ route: "/admin/crm/leads", collection: "leads", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/communities", collection: "communities", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/campaigns", collection: "campaigns", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/training", collection: "ai_training", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/templates", collection: "templates", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/followups", collection: "followups", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/conversations", collection: "conversations", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/community-posts", collection: "community_posts", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/country-strategies", collection: "country_strategies", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/coupon-rules", collection: "coupon_rules", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/strategies", collection: "ai_strategies", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/ai-strategies", collection: "ai_strategies", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/followup-rules", collection: "followups", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/geo-communities", collection: "communities", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/coupons", collection: "coupon_rules", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/outreach-queue", collection: "outreach_queue", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/ai-feedback", collection: "ai_feedback", brandScoped: true });
registerCrmCrudRoutes({ route: "/admin/crm/forbidden-claims", collection: "forbidden_claims", brandScoped: true });

app.get("/admin/crm/ai-permissions", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    res.json({
      success: true,
      permissions: db.settings?.ai_permissions || DEFAULT_CRM_SETTINGS.ai_permissions || {},
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.put("/admin/crm/ai-permissions", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    db.settings = { ...DEFAULT_CRM_SETTINGS, ...(db.settings || {}) };
    db.settings.ai_permissions = { ...(db.settings.ai_permissions || {}), ...(req.body || {}) };
    db.ai_actions = ensureCrmArray(db, "ai_actions");
    db.ai_actions.push(withTimestamps({
      id: uuid(),
      brand_id: getCrmBrandId(req, db),
      agent_name: "system",
      action_type: "update_ai_permissions",
      channel: "admin",
      input_text: JSON.stringify(req.body || {}),
      output_text: "AI permissions updated",
      status: "completed",
      approval_status: "approved",
      approved_by: user.id,
      executed_at: nowIso(),
    }));
    await writeCrmDb(db);
    res.json({ success: true, permissions: db.settings.ai_permissions });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/ai/pause", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    db.settings = { ...DEFAULT_CRM_SETTINGS, ...(db.settings || {}) };
    const scope = normalizeCrmLower(req.body?.scope || "global", "global");
    db.settings.ai_paused = true;
    db.settings.ai_pause_scope = scope;
    db.settings.ai_paused_at = nowIso();
    db.settings.ai_paused_by = user.id;
    db.settings.ai_pause_reason = normalizeCrmString(req.body?.reason || "Paused by admin");
    db.ai_actions = ensureCrmArray(db, "ai_actions");
    db.ai_actions.push(withTimestamps({
      id: uuid(),
      brand_id: getCrmBrandId(req, db),
      agent_name: "system",
      action_type: "pause_ai",
      channel: "admin",
      input_text: JSON.stringify(req.body || {}),
      output_text: `AI paused (${scope})`,
      status: "completed",
      approval_status: "approved",
      approved_by: user.id,
      executed_at: nowIso(),
    }));
    await writeCrmDb(db);
    res.json({ success: true, settings: db.settings });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/ai/resume", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    db.settings = { ...DEFAULT_CRM_SETTINGS, ...(db.settings || {}) };
    db.settings.ai_paused = false;
    db.settings.ai_resumed_at = nowIso();
    db.settings.ai_resumed_by = user.id;
    db.ai_actions = ensureCrmArray(db, "ai_actions");
    db.ai_actions.push(withTimestamps({
      id: uuid(),
      brand_id: getCrmBrandId(req, db),
      agent_name: "system",
      action_type: "resume_ai",
      channel: "admin",
      input_text: JSON.stringify(req.body || {}),
      output_text: "AI resumed",
      status: "completed",
      approval_status: "approved",
      approved_by: user.id,
      executed_at: nowIso(),
    }));
    await writeCrmDb(db);
    res.json({ success: true, settings: db.settings });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// Compatibility aliases for frontend naming
app.get("/admin/crm/action-logs", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const actions = filterCrmRecords(req, ensureCrmArray(db, "ai_actions"), brandId);
    res.json({ success: true, actions, logs: actions, count: actions.length });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/approval-queue", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const items = filterCrmRecords(req, ensureCrmArray(db, "approval_queue"), brandId);
    res.json({ success: true, items, count: items.length });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.put("/admin/crm/approval-queue/:id", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const item = db.approval_queue.find((x) => String(x.id) === String(req.params.id));
    if (!item) return res.status(404).json({ success: false, error: "Approval item not found" });

    item.status = normalizeCrmLower(req.body.status, "approved");
    item.review_note = req.body.review_note || "";
    item.approved_by = item.status === "approved" ? user.id : null;
    item.updated_at = nowIso();

    const action = db.ai_actions.find((x) => String(x.id) === String(item.action_id));
    if (action) {
      action.approval_status = item.status;
      action.approved_by = item.approved_by;
      action.updated_at = nowIso();
    }

    if (item.status === "rejected" || item.status === "unsafe") {
      db.ai_feedback.push({
        id: uuid(),
        brand_id: item.brand_id || null,
        action_id: item.action_id || null,
        agent_name: item.agent_name || "",
        original_output: item.draft_content || "",
        corrected_output: req.body.corrected_output || "",
        rejection_reason: req.body.review_note || "Rejected from approval queue",
        feedback_type: req.body.feedback_type || "other",
        created_by: user.id,
        created_at: nowIso(),
      });
    }

    await writeCrmDb(db);
    res.json({ success: true, item });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/summary", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const leads = ensureCrmArray(db, "leads").filter((lead) => !brandId || String(lead.brand_id) === String(brandId));
    const byStatus = (status) => leads.filter((lead) => lead.status === status).length;

    const summary = {
      total_leads: leads.length,
      new_leads: byStatus("new"),
      imported_contacts: byStatus("imported"),
      engaged: byStatus("engaged"),
      qualified: byStatus("qualified"),
      hot_leads: byStatus("hot_lead"),
      consultation_offered: byStatus("consultation_offered"),
      consultation_booked: byStatus("consultation_booked"),
      demo_offered: byStatus("demo_offered"),
      payment_pending: byStatus("payment_pending"),
      enrolled: byStatus("enrolled"),
      cold: byStatus("cold"),
      unsubscribed: byStatus("unsubscribed") + leads.filter((lead) => lead.unsubscribe_status === "unsubscribed").length,
      todays_followups: ensureCrmArray(db, "followups").filter((item) => item.scheduled_at && String(item.scheduled_at).slice(0, 10) === todayKey()).length,
      active_campaigns: ensureCrmArray(db, "campaigns").filter((item) => String(item.brand_id) === String(brandId) && item.status === "running").length,
      active_communities: ensureCrmArray(db, "communities").filter((item) => String(item.brand_id) === String(brandId) && item.status !== "archived").length,
    };

    res.json({
      success: true,
      summary,
      recent_leads: leads.sort(sortNewestFirst).slice(0, 10),
      high_score_leads: [...leads].sort((a, b) => Number(b.lead_score || 0) - Number(a.lead_score || 0)).slice(0, 10),
      approval_queue_count: ensureCrmArray(db, "approval_queue").filter((item) => String(item.brand_id) === String(brandId) && item.status === "pending").length,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/settings", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    res.json({ success: true, settings: db.settings || DEFAULT_CRM_SETTINGS });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.put("/admin/crm/settings", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    db.settings = { ...DEFAULT_CRM_SETTINGS, ...(db.settings || {}), ...(req.body || {}), updated_at: nowIso() };
    await writeCrmDb(db);
    res.json({ success: true, settings: db.settings });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/leads/:leadId/conversations", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const conversations = ensureCrmArray(db, "conversations")
      .filter((item) => String(item.lead_id) === String(req.params.leadId))
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    res.json({ success: true, conversations });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/leads/:leadId/conversations", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const lead = db.leads.find((item) => String(item.id) === String(req.params.leadId));
    if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });

    const conversation = withTimestamps({
      id: uuid(),
      brand_id: lead.brand_id,
      lead_id: lead.id,
      platform: req.body.platform || lead.platform || "manual",
      direction: req.body.direction || "internal_note",
      message_text: req.body.message_text || req.body.text || "",
      ai_summary: req.body.ai_summary || "",
      sent_by: req.body.sent_by || "human",
    });

    db.conversations.push(conversation);
    lead.last_contacted_at = nowIso();
    lead.updated_at = nowIso();

    await writeCrmDb(db);
    res.json({ success: true, conversation });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/import/preview", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const inputRows = req.body.rows || req.body.contacts || parseManualContacts(req.body.text || req.body.raw || "");
    const rows = buildImportPreviewRows({ db, brandId, rows: inputRows, defaults: req.body.defaults || req.body || {} });

    res.json({
      success: true,
      rows,
      summary: {
        total_rows: rows.length,
        valid_rows: rows.filter((row) => row.valid && !row.duplicate).length,
        duplicate_rows: rows.filter((row) => row.duplicate).length,
        invalid_rows: rows.filter((row) => !row.valid).length,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/import/confirm", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const batchId = uuid();
    const now = nowIso();

    let created = 0;
    let skipped = 0;

    for (const row of rows) {
      if (!row.valid || row.duplicate || row.action === "skip_duplicate" || row.action === "skip_invalid") {
        skipped += 1;
        continue;
      }

      const lead = normalizeCrmCollectionPayload(
        "leads",
        {
          ...row,
          id: uuid(),
          brand_id: brandId,
          status: row.status || "imported",
          source_community: row.source_community || req.body.source_community || "",
          import_batch_id: batchId,
          opt_in_status: row.opt_in_status || "unknown",
          coupon_eligibility: row.coupon_rule?.coupon_code || "",
          ai_enabled: false,
          created_at: now,
          updated_at: now,
        },
        null,
        brandId
      );

      db.leads.push(lead);
      created += 1;
    }

    const batch = {
      id: batchId,
      brand_id: brandId,
      source_type: req.body.source_type || "manual_import",
      file_name: req.body.file_name || "",
      total_rows: rows.length,
      valid_rows: created,
      duplicate_rows: rows.filter((row) => row.duplicate).length,
      invalid_rows: rows.filter((row) => !row.valid).length,
      imported_by: user.id,
      status: "completed",
      created_at: now,
      updated_at: now,
    };

    db.import_batches.push(batch);
    await writeCrmDb(db);

    res.json({ success: true, batch, created, skipped });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// AI Usage & Cost Control
app.get("/admin/crm/ai-usage/summary", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const today = todayRange();
    const week = weekRange();
    const month = monthRange();
    const todayTotals = getCrmUsageTotals(db, brandId, { startDate: today.start, endDate: today.end });
    const weekTotals = getCrmUsageTotals(db, brandId, { startDate: week.start, endDate: week.end });
    const monthTotals = getCrmUsageTotals(db, brandId, { startDate: month.start, endDate: month.end });
    const settings = getBrandCostSettings(db, brandId);

    const byField = (field) => {
      const map = {};
      for (const item of ensureCrmArray(db, "ai_usage").filter((log) => !brandId || String(log.brand_id) === String(brandId))) {
        const key = item[field] || "Unknown";
        map[key] = (map[key] || 0) + Number(item.estimated_cost || 0);
      }
      return Object.entries(map).map(([name, cost]) => ({ name, cost: Number(cost.toFixed(6)) })).sort((a, b) => b.cost - a.cost);
    };

    res.json({
      success: true,
      summary: {
        today_cost: Number(todayTotals.estimated_cost.toFixed(6)),
        week_cost: Number(weekTotals.estimated_cost.toFixed(6)),
        month_cost: Number(monthTotals.estimated_cost.toFixed(6)),
        total_tokens: monthTotals.total_tokens,
        input_tokens: monthTotals.input_tokens,
        output_tokens: monthTotals.output_tokens,
        remaining_monthly_budget: Math.max(0, Number((settings.monthly_cost_limit - monthTotals.estimated_cost).toFixed(6))),
        ai_calls_today: todayTotals.calls,
        failed_ai_calls: monthTotals.failed_calls,
        most_expensive_agent: byField("agent_name")[0] || null,
        most_expensive_campaign: byField("campaign_id")[0] || null,
        most_expensive_brand: byField("brand_id")[0] || null,
      },
      breakdowns: {
        cost_by_agent: byField("agent_name"),
        cost_by_campaign: byField("campaign_id"),
        cost_by_brand: byField("brand_id"),
        cost_by_action_type: byField("action_type"),
        cost_by_channel: byField("channel"),
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/ai-usage/logs", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const logs = filterCrmRecords(req, ensureCrmArray(db, "ai_usage"), brandId);
    res.json({ success: true, logs, usage: logs, count: logs.length });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/ai-usage/charts", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const logs = ensureCrmArray(db, "ai_usage").filter((item) => !brandId || String(item.brand_id) === String(brandId));
    const daily = {};

    for (const log of logs) {
      const day = String(log.created_at || "").slice(0, 10);
      if (!day) continue;
      daily[day] ||= { date: day, cost: 0, tokens: 0, calls: 0 };
      daily[day].cost += Number(log.estimated_cost || 0);
      daily[day].tokens += Number(log.total_tokens || 0);
      daily[day].calls += 1;
    }

    res.json({ success: true, daily: Object.values(daily).sort((a, b) => a.date.localeCompare(b.date)) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/ai-cost-settings", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    res.json({ success: true, settings: getBrandCostSettings(db, brandId) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.put("/admin/crm/ai-cost-settings", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const settings = getBrandCostSettings(db, brandId);
    const updated = { ...settings, ...(req.body || {}), id: settings.id, brand_id: brandId, updated_at: nowIso() };
    const index = db.ai_cost_settings.findIndex((item) => String(item.brand_id) === String(brandId));
    if (index >= 0) db.ai_cost_settings[index] = updated;
    else db.ai_cost_settings.push(updated);
    await writeCrmDb(db);
    res.json({ success: true, settings: updated });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/model-pricing", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    res.json({ success: true, pricing: ensureCrmArray(db, "model_pricing") });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.put("/admin/crm/model-pricing/:id", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const index = db.model_pricing.findIndex((item) => String(item.id) === String(req.params.id));
    if (index < 0) return res.status(404).json({ success: false, error: "Model pricing not found" });
    db.model_pricing[index] = { ...db.model_pricing[index], ...(req.body || {}), updated_at: nowIso() };
    await writeCrmDb(db);
    res.json({ success: true, pricing: db.model_pricing[index] });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/ai-usage/check-budget", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const model = req.body.model || "gpt-4o-mini";
    const inputTokens = Number(req.body.input_tokens || estimateTokensFromText(req.body.input_text || ""));
    const outputTokens = Number(req.body.output_tokens || estimateTokensFromText(req.body.output_text || ""));
    const estimatedCost = req.body.estimated_cost ?? estimateCrmAiCost({ db, model, inputTokens, outputTokens });
    const result = evaluateCrmBudget({
      db,
      brandId,
      estimatedCost,
      estimatedTokens: inputTokens + outputTokens,
      agentName: req.body.agent_name || "",
      campaignId: req.body.campaign_id || "",
      leadId: req.body.lead_id || "",
    });
    res.json({ success: true, ...result, estimated_cost: estimatedCost, estimated_tokens: inputTokens + outputTokens });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/ai-usage/log-action", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const result = await logCrmAiActionAndUsage({
      db,
      brandId,
      agentName: req.body.agent_name || "CRM AI",
      actionType: req.body.action_type || "manual_ai_action",
      channel: req.body.channel || "crm",
      leadId: req.body.lead_id || null,
      campaignId: req.body.campaign_id || null,
      strategyId: req.body.strategy_id || null,
      inputText: req.body.input_text || "",
      outputText: req.body.output_text || "",
      model: req.body.model_used || req.body.model || "gpt-4o-mini",
      status: req.body.status || "draft",
      approvalStatus: req.body.approval_status || "needs_approval",
    });
    await writeCrmDb(db);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/ai-usage/estimate-campaign", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const leadCount = Number(req.body.lead_count || req.body.leads?.length || 0);
    const template = req.body.template || req.body.message_template || "";
    const model = req.body.model || "gpt-4o-mini";
    const inputTokensPerLead = estimateTokensFromText(template) + 250;
    const outputTokensPerLead = 120;
    const totalInput = inputTokensPerLead * leadCount;
    const totalOutput = outputTokensPerLead * leadCount;
    const estimatedCost = estimateCrmAiCost({ db, model, inputTokens: totalInput, outputTokens: totalOutput });
    const campaignDailyLimit = Number(req.body.daily_limit || 50);
    res.json({
      success: true,
      estimate: {
        brand_id: brandId,
        lead_count: leadCount,
        expected_ai_calls: leadCount,
        input_tokens: totalInput,
        output_tokens: totalOutput,
        total_tokens: totalInput + totalOutput,
        estimated_cost: estimatedCost,
        daily_limit: campaignDailyLimit,
        estimated_days: campaignDailyLimit ? Math.ceil(leadCount / campaignDailyLimit) : null,
        model,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// Mock AI endpoints, integration-ready for OpenAI later
app.post("/admin/crm/ai/analyze-lead", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const message = req.body.message || req.body.text || req.body.comment || "";
    const detected = detectCountryFromPhone(req.body.whatsapp || req.body.phone || "");
    const analysis = {
      ...classifyLeadFromMessage(message),
      country: req.body.country || detected.country || "",
      region: req.body.region || detected.region || "global",
      language: req.body.language || detected.language || "english",
    };
    const couponRule = findCouponForLead(db, {
      brandId,
      country: analysis.country,
      region: analysis.region,
      language: analysis.language,
      examType: analysis.exam_type,
      leadStatus: "engaged",
    });
    analysis.coupon_eligibility = couponRule?.coupon_code || "none";
    analysis.suggested_reply = buildMockLeadReply(analysis);
    analysis.sales_summary = `Lead preparing for ${analysis.exam_type}, timeline ${analysis.exam_timeline}, resources ${analysis.current_resources}. Pain point: ${analysis.pain_points}. Recommended offer: ${analysis.recommended_offer}.`;

    const model = req.body.model || "mock-crm-ai";
    const inputText = JSON.stringify(req.body || {});
    const outputText = JSON.stringify(analysis);
    const inputTokens = estimateTokensFromText(inputText);
    const outputTokens = estimateTokensFromText(outputText);
    const estimatedCost = estimateCrmAiCost({ db, model, inputTokens, outputTokens });
    const budget = evaluateCrmBudget({ db, brandId, estimatedCost, estimatedTokens: inputTokens + outputTokens, agentName: "AI Lead Analyzer", leadId: req.body.lead_id });

    const log = await logCrmAiActionAndUsage({
      db,
      brandId,
      agentName: "AI Lead Analyzer",
      actionType: "analyze_lead",
      channel: req.body.platform || "crm",
      leadId: req.body.lead_id || null,
      campaignId: req.body.campaign_id || null,
      strategyId: req.body.strategy_id || null,
      inputText,
      outputText,
      model,
      status: budget.requires_approval ? "draft" : "executed",
      approvalStatus: budget.requires_approval ? "needs_approval" : "auto_approved",
    });

    await writeCrmDb(db);
    res.json({ success: true, analysis, budget, ai_action: log.action, ai_usage: log.usage });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/ai/generate-post", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const content = buildMockCommunityPost({
      platform: req.body.platform,
      postType: req.body.post_type,
      topic: req.body.topic,
      audience: req.body.audience,
      cta: req.body.cta,
      language: req.body.language,
    });

    const model = req.body.model || "mock-crm-ai";
    const inputText = JSON.stringify(req.body || {});
    const outputText = content;
    const inputTokens = estimateTokensFromText(inputText);
    const outputTokens = estimateTokensFromText(outputText);
    const estimatedCost = estimateCrmAiCost({ db, model, inputTokens, outputTokens });
    const budget = evaluateCrmBudget({ db, brandId, estimatedCost, estimatedTokens: inputTokens + outputTokens, agentName: "Community Manager Agent" });

    const log = await logCrmAiActionAndUsage({
      db,
      brandId,
      agentName: "Community Manager Agent",
      actionType: "generate_post",
      channel: req.body.platform || "social",
      leadId: null,
      campaignId: req.body.campaign_id || null,
      strategyId: req.body.strategy_id || null,
      inputText,
      outputText,
      model,
      status: "draft",
      approvalStatus: "needs_approval",
    });

    await writeCrmDb(db);
    res.json({ success: true, post: { content, cta: req.body.cta || "" }, budget, ai_action: log.action, ai_usage: log.usage });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/ai/generate-reply", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const message = req.body.message || "";
    const analysis = classifyLeadFromMessage(message);
    const reply = req.body.language === "arabic"
      ? "شكرًا دكتور. لفهم حالتك بشكل أفضل، هل تستعد حاليًا لـ Step 1 أم Step 2 CK؟"
      : req.body.language === "urdu"
        ? "Thank you Doctor. Behtar guide karne ke liye, kya aap Step 1 prepare kar rahe hain ya Step 2 CK?"
        : buildMockLeadReply(analysis);

    const model = req.body.model || "mock-crm-ai";
    const inputText = JSON.stringify(req.body || {});
    const outputText = reply;
    const inputTokens = estimateTokensFromText(inputText);
    const outputTokens = estimateTokensFromText(outputText);
    const estimatedCost = estimateCrmAiCost({ db, model, inputTokens, outputTokens });
    const budget = evaluateCrmBudget({ db, brandId, estimatedCost, estimatedTokens: inputTokens + outputTokens, agentName: "Trust Advisor Agent", leadId: req.body.lead_id });

    const log = await logCrmAiActionAndUsage({
      db,
      brandId,
      agentName: "Trust Advisor Agent",
      actionType: "generate_reply",
      channel: req.body.channel || req.body.platform || "crm",
      leadId: req.body.lead_id || null,
      campaignId: req.body.campaign_id || null,
      strategyId: req.body.strategy_id || null,
      inputText,
      outputText,
      model,
      status: "draft",
      approvalStatus: "needs_approval",
    });

    await writeCrmDb(db);
    res.json({ success: true, reply, budget, ai_action: log.action, ai_usage: log.usage });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// CRM debug endpoint
app.get("/admin/crm/debug/storage", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    res.json({
      success: true,
      user,
      data_dir: DATA_DIR,
      crm_db_path: CRM_DB_PATH,
      counts: {
        brands: db.brands.length,
        leads: db.leads.length,
        conversations: db.conversations.length,
        communities: db.communities.length,
        campaigns: db.campaigns.length,
        ai_training: db.ai_training.length,
        ai_actions: db.ai_actions.length,
        ai_usage: db.ai_usage.length,
        approval_queue: db.approval_queue.length,
        model_pricing: db.model_pricing.length,
      },
      updated_at: db.updated_at || null,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DATA_DIR=${DATA_DIR}`);
  console.log(`LIVE_DB_PATH=${LIVE_DB_PATH}`);
});
