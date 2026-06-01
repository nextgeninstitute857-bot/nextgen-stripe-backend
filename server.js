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
  global_community: { key: "global_community", name: "Global LMS Community", description: "Access to the overall LMS community discussions", is_active: true, free_for_all: false },
  study_partner: { key: "study_partner", name: "Study Partner", description: "Find and connect with compatible study partners", is_active: true, free_for_all: false },
  support: { key: "support", name: "Student Support", description: "Access to support and announcements", is_active: true, free_for_all: false },
};

const DEFAULT_DEMO_SETTINGS = {
  enabled: true,
  duration_days: 2,
  allow_live_classes: true,
  allow_roadmap: true,
  allow_community: true,
  allow_global_community: true,
  allow_study_partner: true,
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

  // Global LMS community and study partner module.
  globalCommunityPosts: {},
  globalCommunityComments: {},
  globalCommunityReactions: {},
  globalCommunityReports: {},
  globalCommunityCategories: {},

  studyPartnerProfiles: {},
  studyPartnerRequests: {},
  studyPartnerMatches: {},
  studyPartnerReports: {},

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
      globalCommunityPosts: parsed.globalCommunityPosts || {},
      globalCommunityComments: parsed.globalCommunityComments || {},
      globalCommunityReactions: parsed.globalCommunityReactions || {},
      globalCommunityReports: parsed.globalCommunityReports || {},
      globalCommunityCategories: parsed.globalCommunityCategories || {},
      studyPartnerProfiles: parsed.studyPartnerProfiles || {},
      studyPartnerRequests: parsed.studyPartnerRequests || {},
      studyPartnerMatches: parsed.studyPartnerMatches || {},
      studyPartnerReports: parsed.studyPartnerReports || {},
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
    const allowed = ["enabled", "duration_days", "allow_live_classes", "allow_roadmap", "allow_community", "allow_global_community", "allow_study_partner", "allow_assessments", "allow_leaderboard", "allow_recordings", "allow_notes_transcripts", "allow_video_library", "max_live_sessions"];
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
app.get("/live/recordings", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const isStaff = user.role === "admin" || user.role === "instructor";

    if (req.query.course_id) {
      const enrollment = getBackendEnrollment(db, { userId: user.id, courseId: req.query.course_id });
      if (!enrollment && !isStaff) {
        return res.status(403).json({ success: false, error: "No course access found" });
      }
      if (enrollment?.is_demo && !db.demoSettings.allow_recordings) {
        return res.json({ success: true, count: 0, recordings: [], demo_restricted: true });
      }
    }

    let recordings = Object.values(db.recordings || {});
    if (!isStaff) recordings = recordings.filter((recording) => recording.published);
    if (req.query.course_id) recordings = recordings.filter((recording) => String(recording.course_id || "") === String(req.query.course_id));

    recordings.sort(sortNewestFirst);
    res.json({ success: true, count: recordings.length, recordings: recordings.map(sanitizePublicRecording) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load live recordings" });
  }
});

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


// -----------------------------------------------------------------------------
// Global LMS Community + Study Partner Module
// -----------------------------------------------------------------------------

const DEFAULT_COMMUNITY_CATEGORIES = [
  { key: "general", name: "General Discussion", description: "General LMS community discussion" },
  { key: "step_1", name: "USMLE Step 1", description: "Step 1 questions, plans, and discussion" },
  { key: "step_2_ck", name: "USMLE Step 2 CK", description: "Step 2 CK discussion" },
  { key: "uworld", name: "UWorld Discussion", description: "UWorld blocks, incorrects, and strategy" },
  { key: "first_aid", name: "First Aid", description: "First Aid topics and memorization help" },
  { key: "nbme", name: "NBME Reviews", description: "NBME score improvement and review" },
  { key: "study_partner", name: "Study Partner Board", description: "Find accountability and study partners" },
  { key: "success_stories", name: "Success Stories", description: "Student wins and motivation" },
  { key: "announcements", name: "Announcements", description: "Official LMS announcements" },
];

function hasAnyActiveEnrollment(db, user, { includeDemo = true } = {}) {
  if (!user?.id) return false;
  return Object.values(db.enrollments || {}).some((enrollment) => {
    if (String(enrollment.user_id) !== String(user.id)) return false;
    if (enrollment.access_granted === false) return false;
    if (!includeDemo && enrollment.is_demo) return false;
    if (enrollment.is_demo && !isDemoEnrollmentActive(enrollment, { ...DEFAULT_DEMO_SETTINGS, ...(db.demoSettings || {}) })) return false;
    return true;
  });
}

function sanitizeGlobalCommunityPost(post = {}) {
  return {
    id: post.id,
    title: post.title || "",
    content: post.content || "",
    category: post.category || "general",
    tags: Array.isArray(post.tags) ? post.tags : [],
    exam_type: post.exam_type || "",
    course_id: post.course_id || null,
    user_id: post.user_id || null,
    user_name: post.user_name || "Student",
    user_role: post.user_role || "student",
    is_ai_generated: Boolean(post.is_ai_generated),
    is_pinned: Boolean(post.is_pinned),
    is_locked: Boolean(post.is_locked),
    status: post.status || "active",
    comments_count: Number(post.comments_count || 0),
    reactions_count: Number(post.reactions_count || 0),
    created_at: post.created_at || null,
    updated_at: post.updated_at || null,
  };
}

function sanitizeGlobalCommunityComment(comment = {}) {
  return {
    id: comment.id,
    post_id: comment.post_id,
    parent_comment_id: comment.parent_comment_id || null,
    content: comment.content || "",
    user_id: comment.user_id || null,
    user_name: comment.user_name || "Student",
    user_role: comment.user_role || "student",
    is_ai_generated: Boolean(comment.is_ai_generated),
    status: comment.status || "active",
    created_at: comment.created_at || null,
    updated_at: comment.updated_at || null,
  };
}

function canAccessGlobalCommunity({ db, user }) {
  if (user.role === "admin" || user.role === "instructor") return { allowed: true };

  const featureAccess = getStudentFeatureAccess(db, user);
  const hasFeature = featureAccess.global_community?.included || featureAccess.community?.included;
  const demoAllowed = db.demoSettings?.allow_global_community !== false && hasAnyActiveEnrollment(db, user, { includeDemo: true });

  if (!hasFeature && !demoAllowed) {
    return { allowed: false, error: "Your current plan does not include Global Community access." };
  }

  return { allowed: true };
}

function sanitizeStudyPartnerProfile(profile = {}, currentUserId = null, exposeContact = false) {
  const isOwnProfile = String(profile.user_id || "") === String(currentUserId || "");
  const canExpose = isOwnProfile || exposeContact;

  return {
    id: profile.id,
    user_id: profile.user_id,
    user_name: profile.user_name || "Student",
    exam_type: profile.exam_type || "",
    current_stage: profile.current_stage || "",
    timezone: profile.timezone || "",
    country: profile.country || "",
    target_exam_date: profile.target_exam_date || null,
    current_resources: Array.isArray(profile.current_resources) ? profile.current_resources : [],
    current_subjects: Array.isArray(profile.current_subjects) ? profile.current_subjects : [],
    available_hours_per_day: Number(profile.available_hours_per_day || 0),
    available_hours_per_week: Number(profile.available_hours_per_week || 0),
    preferred_time_blocks: Array.isArray(profile.preferred_time_blocks) ? profile.preferred_time_blocks : [],
    study_style: profile.study_style || "",
    looking_for: Array.isArray(profile.looking_for) ? profile.looking_for : [],
    language_preference: Array.isArray(profile.language_preference) ? profile.language_preference : [],
    bio: profile.bio || "",
    visibility: profile.visibility || "students_only",
    allow_requests: profile.allow_requests !== false,
    show_contact_after_accept: profile.show_contact_after_accept !== false,
    status: profile.status || "active",
    email: canExpose ? profile.email || "" : "",
    whatsapp: canExpose ? profile.whatsapp || "" : "",
    telegram_username: canExpose ? profile.telegram_username || "" : "",
    created_at: profile.created_at || null,
    updated_at: profile.updated_at || null,
  };
}

function calculateStudyPartnerCompatibility(a = {}, b = {}) {
  let score = 0;
  const reasons = [];

  if (a.exam_type && b.exam_type && String(a.exam_type).toLowerCase() === String(b.exam_type).toLowerCase()) {
    score += 30;
    reasons.push("Same exam");
  }

  if (a.timezone && b.timezone && String(a.timezone).toLowerCase() === String(b.timezone).toLowerCase()) {
    score += 20;
    reasons.push("Same timezone");
  }

  const resourcesA = new Set((a.current_resources || []).map((x) => String(x).toLowerCase()));
  const resourcesB = new Set((b.current_resources || []).map((x) => String(x).toLowerCase()));
  const sharedResources = [...resourcesA].filter((x) => resourcesB.has(x));
  if (sharedResources.length) {
    score += Math.min(15, sharedResources.length * 5);
    reasons.push(`Shared resources: ${sharedResources.join(", ")}`);
  }

  const subjectsA = new Set((a.current_subjects || []).map((x) => String(x).toLowerCase()));
  const subjectsB = new Set((b.current_subjects || []).map((x) => String(x).toLowerCase()));
  const sharedSubjects = [...subjectsA].filter((x) => subjectsB.has(x));
  if (sharedSubjects.length) {
    score += Math.min(15, sharedSubjects.length * 5);
    reasons.push(`Shared subjects: ${sharedSubjects.join(", ")}`);
  }

  const langA = new Set((a.language_preference || []).map((x) => String(x).toLowerCase()));
  const langB = new Set((b.language_preference || []).map((x) => String(x).toLowerCase()));
  const sharedLang = [...langA].filter((x) => langB.has(x));
  if (sharedLang.length) {
    score += 10;
    reasons.push("Same language preference");
  }

  const hoursA = Number(a.available_hours_per_day || 0);
  const hoursB = Number(b.available_hours_per_day || 0);
  if (hoursA && hoursB && Math.abs(hoursA - hoursB) <= 2) {
    score += 10;
    reasons.push("Similar daily study hours");
  }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

function canAccessStudyPartner({ db, user }) {
  if (user.role === "admin" || user.role === "instructor") return { allowed: true };

  const featureAccess = getStudentFeatureAccess(db, user);
  const hasFeature = featureAccess.study_partner?.included;
  const demoAllowed = db.demoSettings?.allow_study_partner !== false && hasAnyActiveEnrollment(db, user, { includeDemo: true });

  if (!hasFeature && !demoAllowed) {
    return { allowed: false, error: "Your current plan does not include Study Partner access." };
  }

  return { allowed: true };
}

app.get("/community/categories", async (req, res) => {
  try {
    await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const stored = Object.values(db.globalCommunityCategories || {});
    res.json({ success: true, categories: stored.length ? stored : DEFAULT_COMMUNITY_CATEGORIES });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load community categories" });
  }
});

app.get("/community/posts", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const access = canAccessGlobalCommunity({ db, user });
    if (!access.allowed) return res.status(403).json({ success: false, error: access.error });

    let posts = Object.values(db.globalCommunityPosts || {}).filter((post) => post.status !== "deleted");
    if (req.query.category) posts = posts.filter((post) => String(post.category) === String(req.query.category));
    if (req.query.exam_type) posts = posts.filter((post) => String(post.exam_type || "").toLowerCase() === String(req.query.exam_type).toLowerCase());
    if (req.query.q) {
      const q = String(req.query.q).toLowerCase();
      posts = posts.filter((post) => JSON.stringify(post).toLowerCase().includes(q));
    }

    posts.sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1;
      if (!a.is_pinned && b.is_pinned) return 1;
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });

    res.json({ success: true, count: posts.length, posts: posts.map(sanitizeGlobalCommunityPost) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load community posts" });
  }
});

app.post("/community/posts", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const access = canAccessGlobalCommunity({ db, user });
    if (!access.allowed) return res.status(403).json({ success: false, error: access.error });

    const title = String(req.body.title || "").trim();
    const content = String(req.body.content || "").trim();
    if (!title) return res.status(400).json({ success: false, error: "Post title is required" });
    if (!content) return res.status(400).json({ success: false, error: "Post content is required" });

    const id = uuid();
    const now = new Date().toISOString();
    const post = {
      id,
      title: title.slice(0, 200),
      content: content.slice(0, 8000),
      category: req.body.category || "general",
      tags: Array.isArray(req.body.tags) ? req.body.tags : [],
      exam_type: req.body.exam_type || "",
      course_id: req.body.course_id || null,
      user_id: user.id,
      user_name: user.name || user.email || "Student",
      user_role: user.role || "student",
      is_ai_generated: false,
      is_pinned: false,
      is_locked: false,
      status: "active",
      comments_count: 0,
      reactions_count: 0,
      created_at: now,
      updated_at: now,
    };

    db.globalCommunityPosts[id] = post;
    await writeLiveDb(db);
    res.json({ success: true, post: sanitizeGlobalCommunityPost(post) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to create community post" });
  }
});

app.get("/community/posts/:postId", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const access = canAccessGlobalCommunity({ db, user });
    if (!access.allowed) return res.status(403).json({ success: false, error: access.error });

    const post = db.globalCommunityPosts[String(req.params.postId)];
    if (!post || post.status === "deleted") return res.status(404).json({ success: false, error: "Post not found" });

    const comments = Object.values(db.globalCommunityComments || {})
      .filter((comment) => String(comment.post_id) === String(post.id) && comment.status !== "deleted")
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));

    res.json({ success: true, post: sanitizeGlobalCommunityPost(post), comments: comments.map(sanitizeGlobalCommunityComment) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load community post" });
  }
});

app.post("/community/posts/:postId/comments", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const access = canAccessGlobalCommunity({ db, user });
    if (!access.allowed) return res.status(403).json({ success: false, error: access.error });

    const post = db.globalCommunityPosts[String(req.params.postId)];
    if (!post || post.status === "deleted") return res.status(404).json({ success: false, error: "Post not found" });
    if (post.is_locked) return res.status(403).json({ success: false, error: "This post is locked" });

    const content = String(req.body.content || req.body.comment || "").trim();
    if (!content) return res.status(400).json({ success: false, error: "Comment content is required" });

    const id = uuid();
    const now = new Date().toISOString();
    const comment = {
      id,
      post_id: post.id,
      parent_comment_id: req.body.parent_comment_id || null,
      content: content.slice(0, 4000),
      user_id: user.id,
      user_name: user.name || user.email || "Student",
      user_role: user.role || "student",
      is_ai_generated: false,
      status: "active",
      created_at: now,
      updated_at: now,
    };

    db.globalCommunityComments[id] = comment;
    post.comments_count = Object.values(db.globalCommunityComments || {}).filter((c) => String(c.post_id) === String(post.id) && c.status !== "deleted").length;
    post.updated_at = now;
    await writeLiveDb(db);
    res.json({ success: true, comment: sanitizeGlobalCommunityComment(comment) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to add comment" });
  }
});

app.post("/community/posts/:postId/react", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const access = canAccessGlobalCommunity({ db, user });
    if (!access.allowed) return res.status(403).json({ success: false, error: access.error });

    const post = db.globalCommunityPosts[String(req.params.postId)];
    if (!post || post.status === "deleted") return res.status(404).json({ success: false, error: "Post not found" });

    const reactionType = String(req.body.reaction_type || "like").trim().toLowerCase();
    const key = `${post.id}:${user.id}`;
    db.globalCommunityReactions[key] = {
      id: key,
      post_id: post.id,
      user_id: user.id,
      user_name: user.name || user.email || "Student",
      reaction_type: reactionType,
      created_at: db.globalCommunityReactions[key]?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    post.reactions_count = Object.values(db.globalCommunityReactions || {}).filter((r) => String(r.post_id) === String(post.id)).length;
    post.updated_at = new Date().toISOString();
    await writeLiveDb(db);
    res.json({ success: true, reaction: db.globalCommunityReactions[key], reactions_count: post.reactions_count });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to react to post" });
  }
});

app.post("/community/report", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const id = uuid();
    const report = {
      id,
      target_type: req.body.target_type || "post",
      target_id: req.body.target_id || "",
      reason: req.body.reason || "Reported by user",
      details: req.body.details || "",
      user_id: user.id,
      user_name: user.name || user.email || "Student",
      status: "pending_review",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.globalCommunityReports[id] = report;
    await writeLiveDb(db);
    res.json({ success: true, report });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to report item" });
  }
});

app.get("/admin/community/posts", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    let posts = Object.values(db.globalCommunityPosts || {});
    if (req.query.status) posts = posts.filter((p) => String(p.status) === String(req.query.status));
    if (req.query.category) posts = posts.filter((p) => String(p.category) === String(req.query.category));
    posts.sort(sortNewestFirst);
    res.json({ success: true, count: posts.length, posts: posts.map(sanitizeGlobalCommunityPost) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load admin community posts" });
  }
});

app.patch("/admin/community/posts/:postId", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const post = db.globalCommunityPosts[String(req.params.postId)];
    if (!post) return res.status(404).json({ success: false, error: "Post not found" });
    const allowed = ["title", "content", "category", "tags", "status", "is_pinned", "is_locked"];
    for (const key of allowed) if (req.body[key] !== undefined) post[key] = req.body[key];
    post.updated_by = user.id;
    post.updated_at = new Date().toISOString();
    await writeLiveDb(db);
    res.json({ success: true, post: sanitizeGlobalCommunityPost(post) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to update community post" });
  }
});

app.post("/admin/community/ai-prompt", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const title = String(req.body.title || "USMLE Discussion of the Day").trim();
    const content = String(req.body.content || "").trim();
    if (!content) return res.status(400).json({ success: false, error: "AI prompt content is required" });

    const id = uuid();
    const now = new Date().toISOString();
    const post = {
      id,
      title: title.slice(0, 200),
      content: content.slice(0, 8000),
      category: req.body.category || "general",
      tags: Array.isArray(req.body.tags) ? req.body.tags : ["ai_prompt"],
      exam_type: req.body.exam_type || "",
      course_id: req.body.course_id || null,
      user_id: user.id,
      user_name: req.body.agent_name || "NextGen AI",
      user_role: "ai_agent",
      is_ai_generated: true,
      is_pinned: Boolean(req.body.is_pinned),
      is_locked: false,
      status: req.body.status || "active",
      comments_count: 0,
      reactions_count: 0,
      created_by: user.id,
      created_at: now,
      updated_at: now,
    };
    db.globalCommunityPosts[id] = post;

    const usageId = uuid();
    db.aiUsageLogs = db.aiUsageLogs || {};
    db.aiUsageLogs[usageId] = {
      id: usageId,
      user_id: user.id,
      user_email: user.email,
      action: "community_ai_prompt",
      model: req.body.model || "manual_admin_ai_prompt",
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      estimated_cost_usd: 0,
      created_at: now,
    };

    await writeLiveDb(db);
    res.json({ success: true, post: sanitizeGlobalCommunityPost(post) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to create AI community prompt" });
  }
});

app.get("/study-partner/profile/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const access = canAccessStudyPartner({ db, user });
    if (!access.allowed) return res.status(403).json({ success: false, error: access.error });
    const profile = Object.values(db.studyPartnerProfiles || {}).find((p) => String(p.user_id) === String(user.id)) || null;
    res.json({ success: true, profile: profile ? sanitizeStudyPartnerProfile(profile, user.id) : null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load study partner profile" });
  }
});

app.post("/study-partner/profile/me", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const access = canAccessStudyPartner({ db, user });
    if (!access.allowed) return res.status(403).json({ success: false, error: access.error });

    const existing = Object.values(db.studyPartnerProfiles || {}).find((p) => String(p.user_id) === String(user.id)) || null;
    const id = existing?.id || uuid();
    const profile = {
      ...(existing || {}),
      id,
      user_id: user.id,
      user_name: user.name || user.email || "Student",
      email: req.body.email || existing?.email || user.email || "",
      whatsapp: req.body.whatsapp || existing?.whatsapp || "",
      telegram_username: req.body.telegram_username || existing?.telegram_username || "",
      exam_type: req.body.exam_type || existing?.exam_type || "Step 1",
      current_stage: req.body.current_stage || existing?.current_stage || "",
      timezone: req.body.timezone || existing?.timezone || "",
      country: req.body.country || existing?.country || "",
      target_exam_date: req.body.target_exam_date || existing?.target_exam_date || null,
      current_resources: Array.isArray(req.body.current_resources) ? req.body.current_resources : existing?.current_resources || [],
      current_subjects: Array.isArray(req.body.current_subjects) ? req.body.current_subjects : existing?.current_subjects || [],
      available_hours_per_day: Number(req.body.available_hours_per_day ?? existing?.available_hours_per_day ?? 0),
      available_hours_per_week: Number(req.body.available_hours_per_week ?? existing?.available_hours_per_week ?? 0),
      preferred_time_blocks: Array.isArray(req.body.preferred_time_blocks) ? req.body.preferred_time_blocks : existing?.preferred_time_blocks || [],
      study_style: req.body.study_style || existing?.study_style || "",
      looking_for: Array.isArray(req.body.looking_for) ? req.body.looking_for : existing?.looking_for || [],
      language_preference: Array.isArray(req.body.language_preference) ? req.body.language_preference : existing?.language_preference || [],
      bio: String(req.body.bio || existing?.bio || "").slice(0, 1000),
      visibility: req.body.visibility || existing?.visibility || "students_only",
      allow_requests: req.body.allow_requests !== undefined ? Boolean(req.body.allow_requests) : existing?.allow_requests !== false,
      show_contact_after_accept: req.body.show_contact_after_accept !== undefined ? Boolean(req.body.show_contact_after_accept) : existing?.show_contact_after_accept !== false,
      status: req.body.status || existing?.status || "active",
      created_at: existing?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    db.studyPartnerProfiles[id] = profile;
    await writeLiveDb(db);
    res.json({ success: true, profile: sanitizeStudyPartnerProfile(profile, user.id) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to save study partner profile" });
  }
});

app.get("/study-partner/matches", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const access = canAccessStudyPartner({ db, user });
    if (!access.allowed) return res.status(403).json({ success: false, error: access.error });

    const myProfile = Object.values(db.studyPartnerProfiles || {}).find((p) => String(p.user_id) === String(user.id)) || null;
    if (!myProfile) return res.json({ success: true, profile_required: true, matches: [], message: "Please create your study partner profile first." });

    const profiles = Object.values(db.studyPartnerProfiles || {})
      .filter((p) => String(p.user_id) !== String(user.id))
      .filter((p) => p.status === "active")
      .filter((p) => p.allow_requests !== false)
      .filter((p) => p.visibility !== "hidden");

    let matches = profiles.map((profile) => {
      const compatibility = calculateStudyPartnerCompatibility(myProfile, profile);
      return { profile: sanitizeStudyPartnerProfile(profile, user.id), compatibility_score: compatibility.score, compatibility_reasons: compatibility.reasons };
    });

    if (req.query.exam_type) matches = matches.filter((m) => String(m.profile.exam_type || "").toLowerCase() === String(req.query.exam_type).toLowerCase());
    if (req.query.timezone) matches = matches.filter((m) => String(m.profile.timezone || "").toLowerCase() === String(req.query.timezone).toLowerCase());
    matches.sort((a, b) => Number(b.compatibility_score || 0) - Number(a.compatibility_score || 0));

    res.json({ success: true, count: matches.length, matches });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load study partner matches" });
  }
});

app.post("/study-partner/requests", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const access = canAccessStudyPartner({ db, user });
    if (!access.allowed) return res.status(403).json({ success: false, error: access.error });

    const toUserId = String(req.body.to_user_id || "").trim();
    const toProfileId = String(req.body.to_profile_id || "").trim();
    const toProfile = Object.values(db.studyPartnerProfiles || {}).find((p) => (toUserId && String(p.user_id) === toUserId) || (toProfileId && String(p.id) === toProfileId));
    if (!toProfile) return res.status(404).json({ success: false, error: "Study partner profile not found" });
    if (String(toProfile.user_id) === String(user.id)) return res.status(400).json({ success: false, error: "You cannot send a study partner request to yourself" });

    const existing = Object.values(db.studyPartnerRequests || {}).find((r) => String(r.from_user_id) === String(user.id) && String(r.to_user_id) === String(toProfile.user_id) && ["pending", "accepted"].includes(String(r.status)));
    if (existing) return res.status(400).json({ success: false, error: "A request already exists with this student" });

    const id = uuid();
    const request = {
      id,
      from_user_id: user.id,
      from_user_name: user.name || user.email || "Student",
      to_user_id: toProfile.user_id,
      to_user_name: toProfile.user_name || "Student",
      to_profile_id: toProfile.id,
      message: String(req.body.message || "").slice(0, 1000),
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    db.studyPartnerRequests[id] = request;
    await writeLiveDb(db);
    res.json({ success: true, request });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to send study partner request" });
  }
});

app.get("/study-partner/requests", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const access = canAccessStudyPartner({ db, user });
    if (!access.allowed) return res.status(403).json({ success: false, error: access.error });
    const requests = Object.values(db.studyPartnerRequests || {})
      .filter((r) => String(r.from_user_id) === String(user.id) || String(r.to_user_id) === String(user.id))
      .sort(sortNewestFirst);
    res.json({ success: true, count: requests.length, requests });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load study partner requests" });
  }
});

app.patch("/study-partner/requests/:requestId", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const request = db.studyPartnerRequests[String(req.params.requestId)];
    if (!request) return res.status(404).json({ success: false, error: "Request not found" });
    if (String(request.to_user_id) !== String(user.id) && user.role !== "admin") return res.status(403).json({ success: false, error: "Only the receiver can accept or decline this request" });

    const status = String(req.body.status || "").toLowerCase();
    if (!["accepted", "declined", "blocked"].includes(status)) return res.status(400).json({ success: false, error: "Invalid request status" });

    request.status = status;
    request.updated_at = new Date().toISOString();
    if (status === "accepted") {
      const matchId = `${request.from_user_id}:${request.to_user_id}`;
      db.studyPartnerMatches[matchId] = {
        id: matchId,
        request_id: request.id,
        user_a_id: request.from_user_id,
        user_a_name: request.from_user_name,
        user_b_id: request.to_user_id,
        user_b_name: request.to_user_name,
        status: "active",
        created_at: db.studyPartnerMatches[matchId]?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
    }
    await writeLiveDb(db);
    res.json({ success: true, request });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to update study partner request" });
  }
});

app.get("/study-partner/partners", async (req, res) => {
  try {
    const { user } = await getAuthenticatedUser(req);
    const db = await readLiveDb();
    const matches = Object.values(db.studyPartnerMatches || {})
      .filter((m) => String(m.user_a_id) === String(user.id) || String(m.user_b_id) === String(user.id))
      .filter((m) => m.status === "active")
      .map((match) => {
        const partnerUserId = String(match.user_a_id) === String(user.id) ? match.user_b_id : match.user_a_id;
        const profile = Object.values(db.studyPartnerProfiles || {}).find((p) => String(p.user_id) === String(partnerUserId)) || null;
        const exposeContact = profile?.show_contact_after_accept !== false;
        return { ...match, partner_user_id: partnerUserId, partner_profile: profile ? sanitizeStudyPartnerProfile(profile, user.id, exposeContact) : null };
      });
    res.json({ success: true, count: matches.length, partners: matches });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load study partners" });
  }
});

app.get("/admin/study-partner/profiles", async (req, res) => {
  try {
    await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    let profiles = Object.values(db.studyPartnerProfiles || {});
    if (req.query.status) profiles = profiles.filter((p) => String(p.status) === String(req.query.status));
    if (req.query.exam_type) profiles = profiles.filter((p) => String(p.exam_type) === String(req.query.exam_type));
    profiles.sort(sortNewestFirst);
    res.json({ success: true, count: profiles.length, profiles });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to load study partner profiles" });
  }
});

app.patch("/admin/study-partner/profiles/:profileId", async (req, res) => {
  try {
    const { user } = await requireAdminOrInstructor(req);
    const db = await readLiveDb();
    const profile = db.studyPartnerProfiles[String(req.params.profileId)];
    if (!profile) return res.status(404).json({ success: false, error: "Profile not found" });
    const allowed = ["status", "visibility", "allow_requests", "bio"];
    for (const key of allowed) if (req.body[key] !== undefined) profile[key] = req.body[key];
    profile.updated_by = user.id;
    profile.updated_at = new Date().toISOString();
    await writeLiveDb(db);
    res.json({ success: true, profile });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Failed to update study partner profile" });
  }
});

app.get("/live/debug/storage", async (req, res) => { try { const { user } = await getAuthenticatedUser(req); if (user.role !== "admin") return res.status(403).json({ success: false, error: "Only admins can view storage debug" }); const db = await readLiveDb(); res.json({ success: true, data_dir: DATA_DIR, live_db_path: LIVE_DB_PATH, counts: { courses: Object.keys(db.courses || {}).length, liveSessions: Object.keys(db.liveSessions || {}).length, announcements: Object.keys(db.announcements || {}).length, recordings: Object.keys(db.recordings || {}).length, notes: Object.keys(db.notes || {}).length, enrollments: Object.keys(db.enrollments || {}).length, plans: Object.keys(db.plans || {}).length, coupons: Object.keys(db.coupons || {}).length, assessments: Object.keys(db.assessments || {}).length, assessmentAttempts: Object.keys(db.assessmentAttempts || {}).length, aiUsageLogs: Object.keys(db.aiUsageLogs || {}).length, payments: Object.keys(db.payments || {}).length, roadmaps: Object.keys(db.roadmaps || {}).length, roadmapProgress: Object.keys(db.roadmapProgress || {}).length, leaderboard: Object.keys(db.leaderboard || {}).length, googleAuthUsers: Object.keys(db.googleAuthUsers || {}).length, globalCommunityPosts: Object.keys(db.globalCommunityPosts || {}).length, globalCommunityComments: Object.keys(db.globalCommunityComments || {}).length, globalCommunityReactions: Object.keys(db.globalCommunityReactions || {}).length, globalCommunityReports: Object.keys(db.globalCommunityReports || {}).length, studyPartnerProfiles: Object.keys(db.studyPartnerProfiles || {}).length, studyPartnerRequests: Object.keys(db.studyPartnerRequests || {}).length, studyPartnerMatches: Object.keys(db.studyPartnerMatches || {}).length, studyPartnerReports: Object.keys(db.studyPartnerReports || {}).length }, updatedAt: db.updatedAt || null }); } catch (e) { res.status(e.statusCode || 500).json({ success: false, error: e.message }); } });


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
  agents: [],
  agent_logs: [],
  integrations: [],
  integration_logs: [],
  handoffs: [],
  client_data_events: [],

  // Advanced CRM operating-system modules
  crm_flows: [],
  crm_flow_runs: [],
  crm_flow_events: [],
  live_conversion_settings: [],
  live_conversion_events: [],
  live_session_invites: [],
  scheduled_followup_jobs: [],
  followup_executions: [],
  community_intelligence_settings: [],
  community_intelligence_tasks: [],
  community_opportunities: [],
  community_reply_drafts: [],
  community_watch_keywords: [],
  community_rules: [],
  team_members: [],
  roles: [],
  role_permissions: [],
  team_activity_logs: [],
  referral_codes: [],
  referral_attributions: [],
  commission_rules: [],
  commission_payouts: [],
  revenue_attribution: [],
  dashboard_settings: [],
  module_visibility_settings: [],
  portal_settings: [],
  voice_call_settings: [],
  voice_call_logs: [],

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
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      agent_logs: Array.isArray(parsed.agent_logs) ? parsed.agent_logs : [],
      integrations: Array.isArray(parsed.integrations) ? parsed.integrations : [],
      integration_logs: Array.isArray(parsed.integration_logs) ? parsed.integration_logs : [],
      handoffs: Array.isArray(parsed.handoffs) ? parsed.handoffs : [],
      client_data_events: Array.isArray(parsed.client_data_events) ? parsed.client_data_events : [],
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


  if (collection === "agents") {
    base.name = normalizeCrmString(base.name || base.agent_name || "New Agent");
    base.agent_name = base.name;
    base.agent_type = normalizeCrmLower(base.agent_type || base.type || "follow_up_agent", "follow_up_agent");
    base.status = normalizeCrmLower(base.status, "draft_only") || "draft_only";
    base.approval_level = normalizeCrmLower(base.approval_level, "needs_approval") || "needs_approval";
    base.primary_language = normalizeCrmLower(base.primary_language || base.language, "english") || "english";
    base.region = normalizeCrmLower(base.region, "global") || "global";
    base.country = normalizeCrmString(base.country || "");
    base.allowed_channels = Array.isArray(base.allowed_channels) ? base.allowed_channels : normalizeArray(base.allowed_channels || []);
    base.allowed_actions = Array.isArray(base.allowed_actions) ? base.allowed_actions : normalizeArray(base.allowed_actions || []);
    base.assigned_strategy_id = base.assigned_strategy_id || base.strategy_id || null;
    base.daily_action_limit = Number(base.daily_action_limit || 50);
    base.daily_cost_limit_usd = Number(base.daily_cost_limit_usd || 2);
    base.monthly_cost_limit_usd = Number(base.monthly_cost_limit_usd || 30);
    base.max_messages_per_lead_per_day = Number(base.max_messages_per_lead_per_day || 2);
    base.total_ai_cost_usd = Number(base.total_ai_cost_usd || 0);
    base.total_leads_handled = Number(base.total_leads_handled || 0);
    base.conversion_count = Number(base.conversion_count || 0);
  }

  if (collection === "integrations") {
    base.platform = normalizeCrmLower(base.platform, "other") || "other";
    base.account_name = normalizeCrmString(base.account_name || base.name || `${base.platform} Account`);
    base.name = base.account_name;
    base.account_id = normalizeCrmString(base.account_id || base.username || "");
    base.status = normalizeCrmLower(base.status, "not_connected") || "not_connected";
    base.rate_limit = Number(base.rate_limit || 60);
    base.auto_sync = base.auto_sync !== false;
    base.sync_frequency = normalizeCrmLower(base.sync_frequency, "hourly") || "hourly";
    base.permissions = Array.isArray(base.permissions) ? base.permissions : normalizeArray(base.permissions || []);
    base.allowed_actions = Array.isArray(base.allowed_actions) ? base.allowed_actions : normalizeArray(base.allowed_actions || []);
    base.messages_sent_today = Number(base.messages_sent_today || 0);
    base.messages_received_today = Number(base.messages_received_today || 0);
    base.leads_captured = Number(base.leads_captured || 0);
    base.last_sync = base.last_sync || base.last_sync_at || null;
    base.last_webhook_at = base.last_webhook_at || null;
  }

  if (collection === "coupon_rules") {
    base.rule_name = normalizeCrmString(base.rule_name || base.name || "New Offer");
    base.name = base.rule_name;
    base.coupon_code = normalizeCrmString(base.coupon_code || base.code || "").toUpperCase();
    base.code = base.coupon_code || base.code || "";
    base.discount_type = normalizeCrmLower(base.discount_type, "percentage") || "percentage";
    base.discount_percent = Number(base.discount_percent || base.discount_value || 0);
    base.discount_amount_usd = Number(base.discount_amount_usd || 0);
    base.country = normalizeCrmString(base.country || "");
    base.region = normalizeCrmLower(base.region, "global") || "global";
    base.language = normalizeCrmLower(base.language, "english") || "english";
    base.economic_segment = normalizeCrmLower(base.economic_segment, "general") || "general";
    base.exam_type = normalizeCrmString(base.exam_type || "USMLE");
    base.lead_status = normalizeCrmLower(base.lead_status, "any") || "any";
    base.recommended_offer = normalizeCrmString(base.recommended_offer || "");
    base.usage_limit = base.usage_limit ? Number(base.usage_limit) : null;
    base.used_count = Number(base.used_count || 0);
    base.approval_required = base.approval_required !== false;
    base.active = base.active !== false;
    base.status = base.active ? "active" : "inactive";
  }

  if (collection === "country_strategies") {
    base.strategy_name = normalizeCrmString(base.strategy_name || base.name || "Regional Strategy");
    base.name = base.strategy_name;
    base.country = normalizeCrmString(base.country || "");
    base.region = normalizeCrmLower(base.region, "global") || "global";
    base.language = normalizeCrmLower(base.language, "english") || "english";
    base.target_audience = normalizeCrmString(base.target_audience || "");
    base.exam_type = normalizeCrmString(base.exam_type || "USMLE");
    base.recommended_offer = normalizeCrmString(base.recommended_offer || "");
    base.tone = normalizeCrmString(base.tone || "professional, supportive");
    base.cta = normalizeCrmString(base.cta || "Book a free consultation");
    base.approval_mode = normalizeCrmLower(base.approval_mode, "needs_approval") || "needs_approval";
    base.status = normalizeCrmLower(base.status, "draft") || "draft";
    base.community_ids = Array.isArray(base.community_ids) ? base.community_ids : normalizeArray(base.community_ids || []);
    base.agent_ids = Array.isArray(base.agent_ids) ? base.agent_ids : normalizeArray(base.agent_ids || []);
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
    agents: "agents",
    agent_logs: "logs",
    integrations: "integrations",
    integration_logs: "logs",
    handoffs: "handoffs",
    client_data_events: "events",
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
      let records = filterCrmRecords(req, ensureCrmArray(db, collection), brandId);

      if (collection === "leads") {
        records = records.map((lead) => ensureLeadIdentityFields(lead));
      }

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
      let record = normalizeCrmCollectionPayload(collection, req.body || {}, null, brandId);
      if (collection === "leads") record = ensureLeadIdentityFields(record);
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
      let record = null;

      if (collection === "leads") {
        record = getLeadByAnyId(db, req.params.id);
        if (record) {
          ensureLeadIdentityFields(record);
          const conversations = ensureCrmArray(db, "conversations")
            .filter((item) => String(item.lead_id) === String(record.id))
            .sort((a, b) => String(a.created_at || a.timestamp || "").localeCompare(String(b.created_at || b.timestamp || "")));
          return res.json({ success: true, lead: record, record, conversations });
        }
      } else if (collection === "conversations") {
        record = ensureCrmArray(db, collection).find((item) => String(item.id) === String(req.params.id));
        if (!record) {
          const conversations = ensureCrmArray(db, "conversations")
            .filter((item) => String(item.lead_id) === String(req.params.id))
            .sort((a, b) => String(a.created_at || a.timestamp || "").localeCompare(String(b.created_at || b.timestamp || "")));
          return res.json({ success: true, conversations, count: conversations.length });
        }
      } else {
        record = ensureCrmArray(db, collection).find((item) => String(item.id) === String(req.params.id));
      }

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
      const index = collection === "leads"
        ? records.findIndex((item) => [item.id, item._id, item.lead_id, item.uuid].map((x) => String(x || "")).includes(String(req.params.id)))
        : records.findIndex((item) => String(item.id) === String(req.params.id));

      if (index < 0) return res.status(404).json({ success: false, error: "Record not found" });

      let record = normalizeCrmCollectionPayload(collection, req.body || {}, records[index], brandId);
      if (collection === "leads") record = ensureLeadIdentityFields(record);
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
      if (collection === "leads") {
        db[collection] = records.filter((item) => {
          return ![item.id, item._id, item.lead_id, item.uuid].map((x) => String(x || "")).includes(String(req.params.id));
        });
      } else {
        db[collection] = records.filter((item) => String(item.id) !== String(req.params.id));
      }
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
    const lead = getLeadByAnyId(db, req.params.leadId);
    const leadId = lead?.id || req.params.leadId;
    const conversations = ensureCrmArray(db, "conversations")
      .filter((item) => String(item.lead_id) === String(leadId))
      .sort((a, b) => String(a.created_at || a.timestamp || "").localeCompare(String(b.created_at || b.timestamp || "")));
    res.json({ success: true, conversations, lead: lead ? normalizeLeadForResponse(lead) : null });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/leads/:leadId/conversations", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const lead = getLeadByAnyId(db, req.params.leadId);
    if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });

    const conversation = appendSocialConversation(db, {
      lead,
      platform: req.body.platform || lead.platform || lead.source_platform || "manual",
      direction: req.body.direction || "internal_note",
      text: req.body.message_text || req.body.text || req.body.message || "",
      payload: { manual_message: true, ai_summary: req.body.ai_summary || "" },
      integration: null,
    });

    conversation.ai_summary = req.body.ai_summary || "";
    conversation.sent_by = req.body.sent_by || conversation.sent_by || "human";
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

// -----------------------------------------------------------------------------
// CRM Advanced Backend: Agents, Social Integrations, Client Data, Revenue
// -----------------------------------------------------------------------------

function crmMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function getLeadRevenueUsd(lead = {}) {
  return crmMoney(
    lead.revenue_generated_usd ??
    lead.revenue_usd ??
    lead.amount_brought_usd ??
    lead.deal_value_usd ??
    lead.payment_amount_usd ??
    lead.sale_amount_usd ??
    lead.value_usd
  );
}

function getLeadSpendUsd(lead = {}) {
  return crmMoney(
    lead.marketing_spend_usd ??
    lead.spend_usd ??
    lead.ad_spend_usd ??
    lead.cost_usd ??
    lead.acquisition_cost_usd
  );
}

function getCampaignSpendUsd(campaign = {}) {
  return crmMoney(campaign.spend_usd ?? campaign.budget_used_usd ?? campaign.ad_spend_usd ?? campaign.cost_usd);
}

function getCampaignRevenueUsd(campaign = {}) {
  return crmMoney(campaign.revenue_generated_usd ?? campaign.revenue_usd ?? campaign.value_usd);
}

function maskSecret(value) {
  const raw = String(value || "");
  if (!raw) return "";
  if (raw.length <= 8) return "********";
  return `${"*".repeat(Math.max(8, raw.length - 4))}${raw.slice(-4)}`;
}

function sanitizeIntegrationForResponse(integration = {}) {
  return {
    ...integration,
    api_key: integration.api_key ? maskSecret(integration.api_key) : "",
    api_secret: integration.api_secret ? maskSecret(integration.api_secret) : "",
    access_token: integration.access_token ? maskSecret(integration.access_token) : "",
  };
}

function createCrmActionLog(db, payload = {}) {
  db.ai_actions = ensureCrmArray(db, "ai_actions");
  const log = withTimestamps({
    id: uuid(),
    brand_id: payload.brand_id || null,
    agent_id: payload.agent_id || null,
    agent_name: payload.agent_name || "system",
    action_type: payload.action_type || "manual_action",
    channel: payload.channel || "admin",
    lead_id: payload.lead_id || null,
    campaign_id: payload.campaign_id || null,
    input_text: payload.input_text || "",
    output_text: payload.output_text || "",
    status: payload.status || "completed",
    approval_status: payload.approval_status || "approved",
    estimated_cost: crmMoney(payload.estimated_cost),
    model_used: payload.model_used || null,
    created_by: payload.created_by || null,
    executed_at: nowIso(),
  });
  db.ai_actions.push(log);
  return log;
}

function createAgentLog(db, payload = {}) {
  db.agent_logs = ensureCrmArray(db, "agent_logs");
  const log = withTimestamps({
    id: uuid(),
    brand_id: payload.brand_id || null,
    agent_id: payload.agent_id || null,
    agent_name: payload.agent_name || "",
    lead_id: payload.lead_id || null,
    action_type: payload.action_type || "agent_action",
    channel: payload.channel || "admin",
    status: payload.status || "completed",
    message: payload.message || "",
    metadata: payload.metadata || {},
  });
  db.agent_logs.push(log);
  return log;
}

function createIntegrationLog(db, payload = {}) {
  db.integration_logs = ensureCrmArray(db, "integration_logs");
  const log = withTimestamps({
    id: uuid(),
    brand_id: payload.brand_id || null,
    integration_id: payload.integration_id || null,
    platform: payload.platform || "other",
    action: payload.action || "integration_action",
    status: payload.status || "success",
    message: payload.message || "",
    metadata: payload.metadata || {},
    timestamp: nowIso(),
  });
  db.integration_logs.push(log);
  return log;
}

function normalizeClientDataPayload(body = {}) {
  return {
    name: body.name,
    email: body.email,
    phone: body.phone,
    whatsapp: body.whatsapp,
    facebook_url: body.facebook_url,
    facebook_id: body.facebook_id,
    instagram_handle: body.instagram_handle,
    instagram_url: body.instagram_url,
    linkedin_url: body.linkedin_url,
    telegram_username: body.telegram_username,
    telegram_id: body.telegram_id,
    country: body.country,
    region: body.region,
    language: body.language,
    exam_type: body.exam_type,
    exam_timeline: body.exam_timeline,
    exam_date: body.exam_date,
    current_stage: body.current_stage,
    target_score: body.target_score,
    pain_points: body.pain_points,
    study_problem: body.study_problem,
    budget_level: body.budget_level,
    preferred_contact_method: body.preferred_contact_method,
    interested_program: body.interested_program,
    recommended_offer: body.recommended_offer,
    lead_score: body.lead_score,
    status: body.status || body.lead_status,
    source_platform: body.source_platform || body.platform,
    source_community_id: body.source_community_id,
    source_campaign_id: body.source_campaign_id,
    assigned_agent_id: body.assigned_agent_id,
    conversation_summary: body.conversation_summary,
    next_follow_up_at: body.next_follow_up_at,
    opt_in_status: body.opt_in_status,
    unsubscribe_status: body.unsubscribe_status,
    revenue_generated_usd: body.revenue_generated_usd,
    marketing_spend_usd: body.marketing_spend_usd,
    payment_status: body.payment_status,
    payment_reference: body.payment_reference,
    converted_at: body.converted_at,
  };
}

function compactDefined(obj = {}) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function canAgentAct(agent, actionType, channel = null) {
  if (!agent) return { allowed: false, error: "Agent not found" };
  if (["paused", "disabled"].includes(String(agent.status || "").toLowerCase())) return { allowed: false, error: `Agent is ${agent.status}` };

  const allowedActions = Array.isArray(agent.allowed_actions) ? agent.allowed_actions : [];
  if (allowedActions.length && !allowedActions.includes(actionType)) {
    return { allowed: false, error: "Agent is not allowed to perform this action" };
  }

  const allowedChannels = Array.isArray(agent.allowed_channels) ? agent.allowed_channels : [];
  if (channel && allowedChannels.length && !allowedChannels.includes(channel)) {
    return { allowed: false, error: "Agent is not allowed on this channel" };
  }

  return { allowed: true, error: null };
}

function calculateCrmAnalytics(db, req) {
  const brandId = getCrmBrandId(req, db);
  const leads = ensureCrmArray(db, "leads").filter((lead) => !brandId || String(lead.brand_id) === String(brandId));
  const campaigns = ensureCrmArray(db, "campaigns").filter((campaign) => !brandId || String(campaign.brand_id) === String(brandId));
  const aiUsage = ensureCrmArray(db, "ai_usage").filter((usage) => !brandId || String(usage.brand_id) === String(brandId));

  const totalRevenue = leads.reduce((sum, lead) => sum + getLeadRevenueUsd(lead), 0) + campaigns.reduce((sum, campaign) => sum + getCampaignRevenueUsd(campaign), 0);
  const leadSpend = leads.reduce((sum, lead) => sum + getLeadSpendUsd(lead), 0);
  const campaignSpend = campaigns.reduce((sum, campaign) => sum + getCampaignSpendUsd(campaign), 0);
  const aiSpend = aiUsage.reduce((sum, usage) => sum + crmMoney(usage.estimated_cost || usage.estimated_cost_usd), 0);
  const totalSpend = leadSpend + campaignSpend + aiSpend;
  const qualified = leads.filter((lead) => ["qualified", "hot_lead", "consultation_booked", "payment_pending", "enrolled"].includes(String(lead.status || "").toLowerCase())).length;
  const enrolled = leads.filter((lead) => String(lead.status || "").toLowerCase() === "enrolled").length;
  const consultations = leads.filter((lead) => ["consultation_booked", "payment_pending", "enrolled"].includes(String(lead.status || "").toLowerCase())).length;

  const groupSum = (items, keyFn, valueFn) => {
    const map = {};
    for (const item of items) {
      const key = keyFn(item) || "Unknown";
      map[key] = (map[key] || 0) + valueFn(item);
    }
    return Object.entries(map).map(([name, value]) => ({ name, value: Number(value.toFixed(2)) })).sort((a, b) => b.value - a.value);
  };

  return {
    brand_id: brandId,
    total_leads: leads.length,
    clients_reached_out: leads.filter((lead) => lead.last_contacted_at || lead.reached_out_at || lead.first_message_sent_at).length,
    qualified_leads: qualified,
    consultations_booked: consultations,
    enrollments: enrolled,
    revenue_generated_usd: Number(totalRevenue.toFixed(2)),
    total_marketing_spend_usd: Number(totalSpend.toFixed(2)),
    ai_usage_cost_usd: Number(aiSpend.toFixed(2)),
    campaign_spend_usd: Number(campaignSpend.toFixed(2)),
    lead_level_spend_usd: Number(leadSpend.toFixed(2)),
    net_revenue_usd: Number((totalRevenue - totalSpend).toFixed(2)),
    roi_percent: totalSpend ? Number((((totalRevenue - totalSpend) / totalSpend) * 100).toFixed(2)) : 0,
    cost_per_lead_usd: leads.length ? Number((totalSpend / leads.length).toFixed(2)) : 0,
    cost_per_qualified_lead_usd: qualified ? Number((totalSpend / qualified).toFixed(2)) : 0,
    cost_per_enrollment_usd: enrolled ? Number((totalSpend / enrolled).toFixed(2)) : 0,
    lead_to_consultation_rate: leads.length ? Number(((consultations / leads.length) * 100).toFixed(2)) : 0,
    consultation_to_enrollment_rate: consultations ? Number(((enrolled / consultations) * 100).toFixed(2)) : 0,
    revenue_by_campaign: groupSum(leads, (lead) => lead.source_campaign_id || lead.campaign_id || "Manual/Unknown", getLeadRevenueUsd),
    revenue_by_country: groupSum(leads, (lead) => lead.country || "Unknown", getLeadRevenueUsd),
    revenue_by_platform: groupSum(leads, (lead) => lead.source_platform || lead.platform || "manual", getLeadRevenueUsd),
  };
}

// Stronger agents backend
app.get("/admin/crm/agents", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const agents = filterCrmRecords(req, ensureCrmArray(db, "agents"), brandId);
    res.json({ success: true, agents, count: agents.length });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/agents", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const agent = normalizeCrmCollectionPayload("agents", req.body || {}, null, brandId);
    ensureCrmArray(db, "agents").push(agent);
    createAgentLog(db, { brand_id: brandId, agent_id: agent.id, agent_name: agent.name, action_type: "create_agent", message: "Agent created", metadata: { created_by: user.id } });
    await writeCrmDb(db);
    res.json({ success: true, agent });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.put("/admin/crm/agents/:id", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const agents = ensureCrmArray(db, "agents");
    const index = agents.findIndex((agent) => String(agent.id) === String(req.params.id));
    if (index < 0) return res.status(404).json({ success: false, error: "Agent not found" });

    agents[index] = normalizeCrmCollectionPayload("agents", req.body || {}, agents[index], agents[index].brand_id);
    createAgentLog(db, { brand_id: agents[index].brand_id, agent_id: agents[index].id, agent_name: agents[index].name, action_type: "update_agent", message: "Agent updated", metadata: { updated_by: user.id } });
    await writeCrmDb(db);
    res.json({ success: true, agent: agents[index] });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.delete("/admin/crm/agents/:id", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const before = ensureCrmArray(db, "agents").length;
    db.agents = db.agents.filter((agent) => String(agent.id) !== String(req.params.id));
    await writeCrmDb(db);
    res.json({ success: true, deleted: before !== db.agents.length });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/agents/:id/pause", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const agent = ensureCrmArray(db, "agents").find((item) => String(item.id) === String(req.params.id));
    if (!agent) return res.status(404).json({ success: false, error: "Agent not found" });
    agent.status = "paused";
    agent.paused_at = nowIso();
    agent.pause_reason = req.body?.reason || "Paused by admin";
    agent.updated_at = nowIso();
    createAgentLog(db, { brand_id: agent.brand_id, agent_id: agent.id, agent_name: agent.name, action_type: "pause_agent", message: agent.pause_reason });
    await writeCrmDb(db);
    res.json({ success: true, agent });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/agents/:id/resume", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const agent = ensureCrmArray(db, "agents").find((item) => String(item.id) === String(req.params.id));
    if (!agent) return res.status(404).json({ success: false, error: "Agent not found" });
    agent.status = "active";
    agent.resumed_at = nowIso();
    agent.updated_at = nowIso();
    createAgentLog(db, { brand_id: agent.brand_id, agent_id: agent.id, agent_name: agent.name, action_type: "resume_agent", message: "Agent resumed" });
    await writeCrmDb(db);
    res.json({ success: true, agent });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/agents/:id/logs", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const logs = ensureCrmArray(db, "agent_logs").filter((log) => String(log.agent_id) === String(req.params.id)).sort(sortNewestFirst);
    res.json({ success: true, logs, count: logs.length });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/agents/:id/leads", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const leads = ensureCrmArray(db, "leads").filter((lead) => String(lead.assigned_agent_id) === String(req.params.id)).sort(sortNewestFirst);
    res.json({ success: true, leads, count: leads.length });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/agents/:id/usage", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const usage = ensureCrmArray(db, "ai_usage").filter((item) => String(item.agent_id) === String(req.params.id) || String(item.agent_name) === String(req.params.id));
    const totalCost = usage.reduce((sum, item) => sum + crmMoney(item.estimated_cost || item.estimated_cost_usd), 0);
    res.json({ success: true, usage, summary: { total_calls: usage.length, total_cost_usd: Number(totalCost.toFixed(6)) } });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/agents/:id/capture-lead", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const agent = ensureCrmArray(db, "agents").find((item) => String(item.id) === String(req.params.id));
    const permission = canAgentAct(agent, "capture_leads", req.body?.source_platform || req.body?.platform);
    if (!permission.allowed) return res.status(403).json({ success: false, error: permission.error });

    const brandId = agent.brand_id || getCrmBrandId(req, db);
    const clientData = compactDefined(normalizeClientDataPayload(req.body || {}));
    const lead = normalizeCrmCollectionPayload("leads", {
      ...clientData,
      id: uuid(),
      brand_id: brandId,
      assigned_agent_id: agent.id,
      platform: clientData.source_platform || req.body.platform || "agent_capture",
      status: clientData.status || "new",
      conversation_summary: req.body.conversation_summary || req.body.notes || "",
      opt_in_status: req.body.opt_in_status || "unknown",
    }, null, brandId);

    ensureCrmArray(db, "leads").push(lead);
    agent.total_leads_handled = Number(agent.total_leads_handled || 0) + 1;
    agent.last_activity = nowIso();
    agent.updated_at = nowIso();

    const event = withTimestamps({ id: uuid(), brand_id: brandId, agent_id: agent.id, lead_id: lead.id, event_type: "capture_lead", client_data: clientData, created_by: user.id });
    ensureCrmArray(db, "client_data_events").push(event);
    createAgentLog(db, { brand_id: brandId, agent_id: agent.id, agent_name: agent.name, lead_id: lead.id, action_type: "capture_lead", channel: lead.platform, message: "Lead captured by agent", metadata: clientData });
    createCrmActionLog(db, { brand_id: brandId, agent_id: agent.id, agent_name: agent.name, lead_id: lead.id, action_type: "capture_lead", channel: lead.platform, status: "completed", created_by: user.id });

    await writeCrmDb(db);
    res.json({ success: true, lead, agent });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/agents/:id/update-lead-data", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const agent = ensureCrmArray(db, "agents").find((item) => String(item.id) === String(req.params.id));
    const permission = canAgentAct(agent, "update_lead_data", req.body?.source_platform || req.body?.platform);
    if (!permission.allowed) return res.status(403).json({ success: false, error: permission.error });

    const lead = ensureCrmArray(db, "leads").find((item) => String(item.id) === String(req.body.lead_id));
    if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });

    const updates = compactDefined(normalizeClientDataPayload(req.body || {}));
    Object.assign(lead, updates, { assigned_agent_id: agent.id, updated_at: nowIso() });

    const event = withTimestamps({ id: uuid(), brand_id: lead.brand_id, agent_id: agent.id, lead_id: lead.id, event_type: "update_lead_data", client_data: updates, created_by: user.id });
    ensureCrmArray(db, "client_data_events").push(event);
    createAgentLog(db, { brand_id: lead.brand_id, agent_id: agent.id, agent_name: agent.name, lead_id: lead.id, action_type: "update_lead_data", channel: lead.platform, message: "Lead data updated by agent", metadata: updates });

    await writeCrmDb(db);
    res.json({ success: true, lead, event });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/agents/:id/create-followup", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const agent = ensureCrmArray(db, "agents").find((item) => String(item.id) === String(req.params.id));
    const permission = canAgentAct(agent, "create_followup", req.body?.channel);
    if (!permission.allowed) return res.status(403).json({ success: false, error: permission.error });

    const followup = normalizeCrmCollectionPayload("followups", {
      ...req.body,
      brand_id: agent.brand_id,
      assigned_agent_id: agent.id,
      agent_id: agent.id,
      status: req.body.status || "scheduled",
    }, null, agent.brand_id);

    ensureCrmArray(db, "followups").push(followup);
    createAgentLog(db, { brand_id: agent.brand_id, agent_id: agent.id, agent_name: agent.name, lead_id: req.body.lead_id || null, action_type: "create_followup", channel: req.body.channel || "manual", message: "Follow-up created" });
    await writeCrmDb(db);
    res.json({ success: true, followup });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/agents/:id/escalate-lead", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const agent = ensureCrmArray(db, "agents").find((item) => String(item.id) === String(req.params.id));
    if (!agent) return res.status(404).json({ success: false, error: "Agent not found" });

    const lead = ensureCrmArray(db, "leads").find((item) => String(item.id) === String(req.body.lead_id));
    if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });

    lead.status = req.body.status || "hot_lead";
    lead.escalated_at = nowIso();
    lead.escalated_by_agent_id = agent.id;
    lead.updated_at = nowIso();

    const handoff = withTimestamps({
      id: uuid(),
      brand_id: lead.brand_id,
      lead_id: lead.id,
      agent_id: agent.id,
      status: "pending_sales_review",
      handoff_summary: req.body.handoff_summary || lead.conversation_summary || "",
      recommended_next_action: req.body.recommended_next_action || "Book consultation",
      assigned_closer_id: req.body.assigned_closer_id || null,
    });
    ensureCrmArray(db, "handoffs").push(handoff);
    createAgentLog(db, { brand_id: lead.brand_id, agent_id: agent.id, agent_name: agent.name, lead_id: lead.id, action_type: "escalate_lead", channel: lead.platform, message: "Lead escalated to sales" });
    await writeCrmDb(db);
    res.json({ success: true, lead, handoff });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// Social integrations backend
app.get("/admin/crm/integrations/logs", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const logs = filterCrmRecords(req, ensureCrmArray(db, "integration_logs"), brandId);
    res.json({ success: true, logs, count: logs.length });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/integrations/test", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const platform = normalizeCrmLower(req.body?.platform, "other");
    const result = await testSocialIntegration({ ...(req.body || {}), platform });
    res.json({
      success: true,
      platform,
      ...result,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/integrations", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const integrations = filterCrmRecords(req, ensureCrmArray(db, "integrations"), brandId).map(sanitizeIntegrationForResponse);
    res.json({ success: true, integrations, count: integrations.length });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/integrations", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const integration = normalizeCrmCollectionPayload("integrations", req.body || {}, null, brandId);
    ensureCrmArray(db, "integrations").push(integration);
    createIntegrationLog(db, { brand_id: brandId, integration_id: integration.id, platform: integration.platform, action: "create_integration", status: "success", message: "Integration created", metadata: { created_by: user.id } });
    await writeCrmDb(db);
    res.json({ success: true, integration: sanitizeIntegrationForResponse(integration) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.put("/admin/crm/integrations/:id", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const integrations = ensureCrmArray(db, "integrations");
    const index = integrations.findIndex((item) => String(item.id) === String(req.params.id));
    if (index < 0) return res.status(404).json({ success: false, error: "Integration not found" });

    integrations[index] = normalizeCrmCollectionPayload("integrations", req.body || {}, integrations[index], integrations[index].brand_id);
    createIntegrationLog(db, { brand_id: integrations[index].brand_id, integration_id: integrations[index].id, platform: integrations[index].platform, action: "update_integration", status: "success", message: "Integration updated", metadata: { updated_by: user.id } });
    await writeCrmDb(db);
    res.json({ success: true, integration: sanitizeIntegrationForResponse(integrations[index]) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.delete("/admin/crm/integrations/:id", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const integrations = ensureCrmArray(db, "integrations");
    const item = integrations.find((integration) => String(integration.id) === String(req.params.id));
    db.integrations = integrations.filter((integration) => String(integration.id) !== String(req.params.id));
    if (item) createIntegrationLog(db, { brand_id: item.brand_id, integration_id: item.id, platform: item.platform, action: "delete_integration", status: "success", message: "Integration deleted/disconnected" });
    await writeCrmDb(db);
    res.json({ success: true, deleted: Boolean(item) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/integrations/:id/test", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const integration = ensureCrmArray(db, "integrations").find((item) => String(item.id) === String(req.params.id));
    if (!integration) return res.status(404).json({ success: false, error: "Integration not found" });

    const result = await testSocialIntegration(integration);

    integration.last_tested_at = nowIso();
    integration.test_status = result.live_connected ? "live_success" : "configured_success";
    integration.status = result.live_connected ? "connected" : (integration.status || "configured");
    integration.updated_at = nowIso();

    createIntegrationLog(db, {
      brand_id: integration.brand_id,
      integration_id: integration.id,
      platform: integration.platform,
      action: "test_connection",
      status: "success",
      message: result.message || "Integration connection test completed",
      metadata: result.safe_metadata || {},
    });

    await writeCrmDb(db);

    res.json({
      success: true,
      ...result,
      integration: sanitizeIntegrationForResponse(integration),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/integrations/:id/sync", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const integration = ensureCrmArray(db, "integrations").find((item) => String(item.id) === String(req.params.id));
    if (!integration) return res.status(404).json({ success: false, error: "Integration not found" });

    const result = await syncSocialIntegration({ db, integration, body: req.body || {} });

    integration.last_sync = nowIso();
    integration.last_sync_at = integration.last_sync;
    integration.sync_status = result.live_connected ? "live_synced" : "ready_no_live_sync";
    integration.updated_at = nowIso();

    createIntegrationLog(db, {
      brand_id: integration.brand_id,
      integration_id: integration.id,
      platform: integration.platform,
      action: "manual_sync",
      status: "success",
      message: result.message || "Integration sync completed",
      metadata: result.safe_metadata || {},
    });

    await writeCrmDb(db);

    res.json({
      success: true,
      ...result,
      integration: sanitizeIntegrationForResponse(integration),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/integrations/:id/logs", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const logs = ensureCrmArray(db, "integration_logs").filter((log) => String(log.integration_id) === String(req.params.id)).sort(sortNewestFirst);
    res.json({ success: true, logs, count: logs.length });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// Client data / conversation / handoff backend
app.get("/admin/crm/conversations/:leadId", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const conversations = ensureCrmArray(db, "conversations").filter((item) => String(item.lead_id) === String(req.params.leadId)).sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    res.json({ success: true, conversations, messages: conversations });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/conversations/:leadId/messages", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const lead = getLeadByAnyId(db, req.params.leadId);
    if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });

    const message = appendSocialConversation(db, {
      lead,
      platform: req.body.platform || lead.platform || lead.source_platform || "manual",
      direction: req.body.direction || "internal_note",
      text: req.body.message_text || req.body.text || req.body.message || "",
      payload: { manual_message: true, ai_summary: req.body.ai_summary || "", status: req.body.status || "saved" },
      integration: null,
    });

    message.ai_summary = req.body.ai_summary || "";
    message.sent_by = req.body.sent_by || message.sent_by || "human";
    message.status = req.body.status || message.status || "saved";

    lead.last_contacted_at = nowIso();
    lead.updated_at = nowIso();
    await writeCrmDb(db);

    res.json({ success: true, message, conversation: message });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/leads/:id/client-data", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const lead = ensureCrmArray(db, "leads").find((item) => String(item.id) === String(req.params.id));
    if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });

    const updates = compactDefined(normalizeClientDataPayload(req.body || {}));
    Object.assign(lead, updates, { updated_at: nowIso() });

    const event = withTimestamps({ id: uuid(), brand_id: lead.brand_id, lead_id: lead.id, event_type: "client_data_update", client_data: updates, created_by: user.id });
    ensureCrmArray(db, "client_data_events").push(event);
    await writeCrmDb(db);

    res.json({ success: true, lead, event });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/leads/:id/score", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const lead = ensureCrmArray(db, "leads").find((item) => String(item.id) === String(req.params.id));
    if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });
    lead.lead_score = Math.max(0, Math.min(100, Number(req.body.lead_score ?? req.body.score ?? lead.lead_score ?? 0)));
    lead.status = req.body.status || lead.status;
    lead.score_reason = req.body.score_reason || lead.score_reason || "";
    lead.updated_at = nowIso();
    await writeCrmDb(db);
    res.json({ success: true, lead });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/leads/:id/handoff", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const lead = ensureCrmArray(db, "leads").find((item) => String(item.id) === String(req.params.id));
    if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });

    const handoff = withTimestamps({
      id: uuid(),
      brand_id: lead.brand_id,
      lead_id: lead.id,
      status: req.body.status || "pending_sales_review",
      assigned_closer_id: req.body.assigned_closer_id || null,
      handoff_summary: req.body.handoff_summary || lead.conversation_summary || "",
      recommended_next_action: req.body.recommended_next_action || "Book consultation",
      priority: req.body.priority || "normal",
    });

    ensureCrmArray(db, "handoffs").push(handoff);
    lead.status = req.body.lead_status || "hot_lead";
    lead.handoff_id = handoff.id;
    lead.updated_at = nowIso();
    await writeCrmDb(db);
    res.json({ success: true, lead, handoff });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// Revenue and dashboard analytics
app.get("/admin/crm/dashboard/analytics", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    res.json({ success: true, analytics: calculateCrmAnalytics(db, req) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/revenue/summary", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    res.json({ success: true, summary: calculateCrmAnalytics(db, req) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/campaigns/:id/performance", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const campaign = ensureCrmArray(db, "campaigns").find((item) => String(item.id) === String(req.params.id));
    if (!campaign) return res.status(404).json({ success: false, error: "Campaign not found" });

    const leads = ensureCrmArray(db, "leads").filter((lead) => String(lead.source_campaign_id || lead.campaign_id) === String(campaign.id));
    const revenue = leads.reduce((sum, lead) => sum + getLeadRevenueUsd(lead), 0) + getCampaignRevenueUsd(campaign);
    const spend = leads.reduce((sum, lead) => sum + getLeadSpendUsd(lead), 0) + getCampaignSpendUsd(campaign);
    const qualified = leads.filter((lead) => ["qualified", "hot_lead", "consultation_booked", "payment_pending", "enrolled"].includes(String(lead.status || "").toLowerCase())).length;
    const enrolled = leads.filter((lead) => String(lead.status || "").toLowerCase() === "enrolled").length;

    res.json({
      success: true,
      campaign,
      performance: {
        leads_count: leads.length,
        qualified_count: qualified,
        enrollments_count: enrolled,
        revenue_generated_usd: Number(revenue.toFixed(2)),
        spend_usd: Number(spend.toFixed(2)),
        net_revenue_usd: Number((revenue - spend).toFixed(2)),
        roi_percent: spend ? Number((((revenue - spend) / spend) * 100).toFixed(2)) : 0,
        replies_count: Number(campaign.replies_count || 0),
        messages_sent: Number(campaign.messages_sent || campaign.leads_reached || 0),
        consultations_booked: leads.filter((lead) => ["consultation_booked", "payment_pending", "enrolled"].includes(String(lead.status || "").toLowerCase())).length,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});


// -----------------------------------------------------------------------------
// Telegram Live Integration
// -----------------------------------------------------------------------------

function getTelegramBotToken(integration = {}) {
  const fromIntegration =
    integration?.api_key ||
    integration?.access_token ||
    integration?.bot_token ||
    "";
  return String(process.env.TELEGRAM_BOT_TOKEN || fromIntegration || "").trim();
}

function getTelegramWebhookSecret() {
  return String(process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
}

function getPublicBackendUrl(req = null) {
  const envUrl = String(
    process.env.BACKEND_PUBLIC_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    ""
  ).trim();

  if (envUrl) return envUrl.replace(/\/+$/, "");

  if (req) {
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    if (host) return `${proto}://${host}`.replace(/\/+$/, "");
  }

  return "";
}

async function telegramApi(method, payload = {}, integration = {}) {
  const token = getTelegramBotToken(integration);
  if (!token) {
    const error = new Error("Telegram bot token is missing. Add TELEGRAM_BOT_TOKEN in Render environment variables.");
    error.statusCode = 400;
    throw error;
  }

  const response = await axios.post(
    `https://api.telegram.org/bot${token}/${method}`,
    payload,
    { timeout: 30000 }
  );

  if (response.data?.ok === false) {
    const error = new Error(response.data?.description || "Telegram API request failed");
    error.statusCode = 400;
    throw error;
  }

  return response.data;
}

function findTelegramIntegration(db) {
  const integrations = ensureCrmArray(db, "integrations");
  return (
    integrations.find((item) =>
      String(item.platform || "").toLowerCase() === "telegram" &&
      String(item.status || "").toLowerCase() !== "inactive"
    ) ||
    integrations.find((item) => String(item.platform || "").toLowerCase() === "telegram") ||
    null
  );
}

function getTelegramMessageFromUpdate(update = {}) {
  return (
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post ||
    update.callback_query?.message ||
    null
  );
}

function normalizeTelegramLeadPayload({ update = {}, message = {}, integration = null }) {
  const from = update.callback_query?.from || message.from || {};
  const chat = message.chat || {};
  const username = from.username ? `@${String(from.username).replace(/^@/, "")}` : "";
  const firstName = String(from.first_name || "").trim();
  const lastName = String(from.last_name || "").trim();
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  return {
    name: fullName || username || `Telegram ${from.id || chat.id || "Lead"}`,
    telegram_id: from.id || chat.id || null,
    telegram_chat_id: chat.id || null,
    telegram_username: username,
    source_platform: "telegram",
    platform: "telegram",
    source_integration_id: integration?.id || null,
    source_integration_name: integration?.account_name || integration?.name || "Telegram",
    language: from.language_code || "",
    country: "",
    region: "",
    status: "new",
    lead_status: "new",
    opt_in_status: "telegram_inbound",
    unsubscribe_status: "subscribed",
    source_text: String(message.text || message.caption || "").trim(),
    last_message: String(message.text || message.caption || "").trim(),
    last_message_at: new Date().toISOString(),
    platform_contact_id: chat.id || from.id || null,
    conversation_direction: "inbound",
    client_reached_out: true,
    agent_initiated: false,
    last_contacted_at: new Date().toISOString(),
  };
}

function findExistingTelegramLead(db, payload = {}) {
  const leads = ensureCrmArray(db, "leads");
  return leads.find((lead) => {
    return (
      (payload.telegram_id && String(lead.telegram_id || "") === String(payload.telegram_id)) ||
      (payload.telegram_chat_id && String(lead.telegram_chat_id || "") === String(payload.telegram_chat_id)) ||
      (payload.telegram_username && String(lead.telegram_username || "").toLowerCase() === String(payload.telegram_username).toLowerCase())
    );
  }) || null;
}

function upsertTelegramLead(db, payload = {}) {
  db.leads = ensureCrmArray(db, "leads");
  const previous = findExistingTelegramLead(db, payload);
  const now = nowIso();
  const inboundText = String(payload.last_message || payload.source_text || "").trim();

  if (previous) {
    Object.assign(previous, {
      ...previous,
      ...payload,
      id: getStableLeadId(previous) || previous.id || uuid(),
      lead_id: previous.lead_id || getStableLeadId(previous) || previous.id || uuid(),
      source_platform: "telegram",
      platform: "telegram",
      source_channel: "social_integration",
      conversation_direction: previous.conversation_direction || "inbound",
      client_reached_out: true,
      agent_initiated: Boolean(previous.agent_initiated),
      status: previous.status || payload.status || "new",
      lead_status: previous.lead_status || previous.status || payload.lead_status || "new",
      last_message: inboundText || previous.last_message || "",
      last_message_at: inboundText ? now : previous.last_message_at || now,
      last_inbound_at: now,
      updated_at: now,
    });
    ensureLeadIdentityFields(previous);
    return { lead: previous, created: false };
  }

  const leadId = uuid();
  const lead = withTimestamps({
    id: leadId,
    lead_id: leadId,
    ...payload,
    source_platform: "telegram",
    platform: "telegram",
    source_channel: "social_integration",
    conversation_direction: "inbound",
    client_reached_out: true,
    agent_initiated: false,
    last_message: inboundText,
    last_message_at: inboundText ? now : null,
    last_inbound_at: now,
    lead_score: Number(payload.lead_score || 10),
    created_by: "telegram_webhook",
  });

  ensureLeadIdentityFields(lead);
  db.leads.push(lead);
  return { lead, created: true };
}

function appendTelegramConversation(db, { lead, update = {}, message = {}, text = "", integration = null }) {
  db.conversations = ensureCrmArray(db, "conversations");
  const msgText = text || message.text || message.caption || "";
  const now = nowIso();

  const conversation = withTimestamps({
    id: uuid(),
    conversation_id: lead?.conversation_id || lead?.id || uuid(),
    lead_id: lead?.id || null,
    integration_id: integration?.id || null,
    platform: "telegram",
    source_platform: "telegram",
    channel: "telegram",
    direction: "inbound",
    message_id: message.message_id || null,
    platform_message_id: message.message_id || null,
    telegram_update_id: update.update_id || null,
    telegram_chat_id: message.chat?.id || lead?.telegram_chat_id || null,
    platform_contact_id: lead?.platform_contact_id || lead?.telegram_chat_id || message.chat?.id || null,
    from_id: message.from?.id || null,
    from_username: message.from?.username || "",
    message_text: msgText,
    text: msgText,
    raw: update,
    raw_payload: update,
    status: "received",
    timestamp: now,
    created_at: now,
  });

  db.conversations.push(conversation);

  if (lead) {
    lead.last_message = msgText || lead.last_message || "";
    lead.last_message_at = now;
    lead.last_inbound_at = now;
    lead.client_reached_out = true;
    lead.source_platform = "telegram";
    lead.platform = "telegram";
    lead.updated_at = now;
  }

  return conversation;
}

function createTelegramIntegrationLog(db, payload = {}) {
  db.integration_logs = ensureCrmArray(db, "integration_logs");
  const log = withTimestamps({
    id: uuid(),
    platform: "telegram",
    integration_id: payload.integration_id || null,
    lead_id: payload.lead_id || null,
    action: payload.action || "telegram_event",
    status: payload.status || "success",
    message: payload.message || "",
    raw: payload.raw || null,
  });
  db.integration_logs.push(log);
  return log;
}

app.get("/webhooks/telegram", (req, res) => {
  res.json({
    success: true,
    message: "Telegram webhook endpoint is online. Telegram sends updates by POST.",
  });
});

app.post("/webhooks/telegram", async (req, res) => {
  try {
    const expectedSecret = getTelegramWebhookSecret();
    if (expectedSecret) {
      const receivedSecret = String(req.headers["x-telegram-bot-api-secret-token"] || "");
      if (receivedSecret !== expectedSecret) {
        return res.status(403).json({ success: false, error: "Invalid Telegram webhook secret" });
      }
    }

    const update = req.body || {};
    const message = getTelegramMessageFromUpdate(update);

    if (!message) {
      return res.json({ success: true, ignored: true, reason: "No message object found" });
    }

    const text = String(message.text || message.caption || "").trim();
    const db = await readCrmDb();
    const integration = findTelegramIntegration(db);

    const leadPayload = normalizeTelegramLeadPayload({ update, message, integration });
    const { lead, created } = upsertTelegramLead(db, leadPayload);
    const conversation = appendTelegramConversation(db, { lead, update, message, text, integration });

    createTelegramIntegrationLog(db, {
      integration_id: integration?.id || null,
      lead_id: lead.id,
      action: "telegram_inbound_message",
      status: "success",
      message: created ? "Created lead from Telegram inbound message" : "Updated lead from Telegram inbound message",
      raw: { update_id: update.update_id, message_id: message.message_id, text },
    });

    db.client_data_events = ensureCrmArray(db, "client_data_events");
    db.client_data_events.push(withTimestamps({
      id: uuid(),
      lead_id: lead.id,
      source: "telegram",
      action: created ? "create_lead" : "update_lead",
      fields_collected: Object.keys(leadPayload),
      conversation_id: conversation.id,
    }));

    await writeCrmDb(db);

    res.json({
      success: true,
      created,
      lead_id: lead.id,
      conversation_id: conversation.id,
    });
  } catch (error) {
    console.error("Telegram webhook error:", error.message);
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message || "Telegram webhook failed",
    });
  }
});

app.get("/admin/crm/integrations/telegram/me", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const integration = findTelegramIntegration(db);
    const result = await telegramApi("getMe", {}, integration || {});
    res.json({ success: true, bot: result.result, live_connected: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/integrations/telegram/set-webhook", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const integration = findTelegramIntegration(db);
    const publicUrl = getPublicBackendUrl(req);

    if (!publicUrl) {
      return res.status(400).json({
        success: false,
        error: "BACKEND_PUBLIC_URL or RENDER_EXTERNAL_URL is required to set Telegram webhook.",
      });
    }

    const webhookUrl = `${publicUrl}/webhooks/telegram`;
    const secret = getTelegramWebhookSecret();

    const payload = {
      url: webhookUrl,
      allowed_updates: ["message", "edited_message", "callback_query", "channel_post"],
      drop_pending_updates: req.body?.drop_pending_updates !== false,
    };

    if (secret) {
      payload.secret_token = secret;
    }

    const result = await telegramApi("setWebhook", payload, integration || {});

    if (integration) {
      integration.webhook_url = webhookUrl;
      integration.status = "connected";
      integration.last_sync = new Date().toISOString();
      integration.updated_at = new Date().toISOString();
      createTelegramIntegrationLog(db, {
        integration_id: integration.id,
        action: "set_webhook",
        status: "success",
        message: `Telegram webhook set to ${webhookUrl}`,
      });
      await writeCrmDb(db);
    }

    res.json({
      success: true,
      message: "Telegram webhook configured",
      webhook_url: webhookUrl,
      telegram: result,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/integrations/telegram/send", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const chatId = req.body.chat_id || req.body.telegram_chat_id;
    const text = String(req.body.text || req.body.message || "").trim();

    if (!chatId) return res.status(400).json({ success: false, error: "chat_id is required" });
    if (!text) return res.status(400).json({ success: false, error: "text/message is required" });

    const db = await readCrmDb();
    const integration = findTelegramIntegration(db);
    const result = await telegramApi("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: req.body.parse_mode || undefined,
      disable_web_page_preview: req.body.disable_web_page_preview !== false,
    }, integration || {});

    const lead = ensureCrmArray(db, "leads").find((item) => String(item.telegram_chat_id || "") === String(chatId)) || null;

    db.conversations = ensureCrmArray(db, "conversations");
    const conversation = withTimestamps({
      id: uuid(),
      lead_id: lead?.id || req.body.lead_id || null,
      integration_id: integration?.id || null,
      platform: "telegram",
      channel: "telegram",
      direction: "outbound",
      telegram_chat_id: chatId,
      text,
      sent_by: user.email,
      raw: result.result || result,
    });
    db.conversations.push(conversation);

    createTelegramIntegrationLog(db, {
      integration_id: integration?.id || null,
      lead_id: lead?.id || req.body.lead_id || null,
      action: "telegram_send_message",
      status: "success",
      message: `Sent Telegram message to ${chatId}`,
      raw: { message_id: result.result?.message_id || null },
    });

    await writeCrmDb(db);

    res.json({
      success: true,
      message: "Telegram message sent",
      telegram: result,
      conversation,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/integrations/telegram/delete-webhook", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const integration = findTelegramIntegration(db);
    const result = await telegramApi("deleteWebhook", {
      drop_pending_updates: req.body?.drop_pending_updates === true,
    }, integration || {});

    if (integration) {
      integration.webhook_url = "";
      integration.status = "configured";
      integration.updated_at = new Date().toISOString();
      createTelegramIntegrationLog(db, {
        integration_id: integration.id,
        action: "delete_webhook",
        status: "success",
        message: "Telegram webhook deleted",
      });
      await writeCrmDb(db);
    }

    res.json({ success: true, message: "Telegram webhook deleted", telegram: result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});


// -----------------------------------------------------------------------------
// Universal Social Integrations: Email, WhatsApp, Meta, Reddit, LinkedIn,
// YouTube, TikTok, X/Twitter, Discord, custom webhooks.
// -----------------------------------------------------------------------------

const SOCIAL_PLATFORM_CONFIG = {
  telegram: {
    label: "Telegram",
    env: ["TELEGRAM_BOT_TOKEN"],
    live: true,
    inbound: true,
    outbound: true,
  },
  email: {
    label: "Email",
    env: ["RESEND_API_KEY or SENDGRID_API_KEY or SMTP_*"],
    live: true,
    inbound: true,
    outbound: true,
  },
  whatsapp: {
    label: "WhatsApp Cloud API",
    env: ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"],
    live: true,
    inbound: true,
    outbound: true,
  },
  facebook: {
    label: "Facebook Page",
    env: ["META_PAGE_ACCESS_TOKEN", "FACEBOOK_PAGE_ID", "META_VERIFY_TOKEN"],
    live: true,
    inbound: true,
    outbound: true,
  },
  instagram: {
    label: "Instagram Professional",
    env: ["INSTAGRAM_PAGE_ACCESS_TOKEN", "INSTAGRAM_BUSINESS_ACCOUNT_ID", "META_VERIFY_TOKEN"],
    live: true,
    inbound: true,
    outbound: true,
  },
  reddit: {
    label: "Reddit",
    env: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_REFRESH_TOKEN"],
    live: false,
    inbound: true,
    outbound: false,
  },
  linkedin: {
    label: "LinkedIn",
    env: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET", "LINKEDIN_ACCESS_TOKEN"],
    live: false,
    inbound: true,
    outbound: false,
  },
  youtube: {
    label: "YouTube",
    env: ["YOUTUBE_API_KEY or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET"],
    live: false,
    inbound: true,
    outbound: false,
  },
  tiktok: {
    label: "TikTok",
    env: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_ACCESS_TOKEN"],
    live: false,
    inbound: true,
    outbound: false,
  },
  twitter: {
    label: "X / Twitter",
    env: ["TWITTER_BEARER_TOKEN", "TWITTER_API_KEY", "TWITTER_API_SECRET"],
    live: false,
    inbound: true,
    outbound: false,
  },
  x: {
    label: "X / Twitter",
    env: ["TWITTER_BEARER_TOKEN", "TWITTER_API_KEY", "TWITTER_API_SECRET"],
    live: false,
    inbound: true,
    outbound: false,
  },
  discord: {
    label: "Discord",
    env: ["DISCORD_BOT_TOKEN or DISCORD_WEBHOOK_URL"],
    live: true,
    inbound: true,
    outbound: true,
  },
  other: {
    label: "Custom Platform",
    env: [],
    live: false,
    inbound: true,
    outbound: false,
  },
};

function normalizeSocialPlatform(platform = "other") {
  const clean = String(platform || "other").trim().toLowerCase();
  if (clean === "x") return "twitter";
  return SOCIAL_PLATFORM_CONFIG[clean] ? clean : "other";
}

function getPlatformConfig(platform) {
  return SOCIAL_PLATFORM_CONFIG[normalizeSocialPlatform(platform)] || SOCIAL_PLATFORM_CONFIG.other;
}

function getIntegrationCredential(integration = {}, key, envKey = null) {
  const value = integration?.[key] || integration?.credentials?.[key] || "";
  const envValue = envKey ? process.env[envKey] : "";
  const clean = String(value || envValue || "").trim();
  if (!clean || clean.includes("***")) return String(envValue || "").trim();
  return clean;
}

function getBackendPublicUrl() {
  return String(process.env.BACKEND_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
}

function getIntegrationByPlatform(db, platform) {
  const clean = normalizeSocialPlatform(platform);
  return ensureCrmArray(db, "integrations").find((item) => normalizeSocialPlatform(item.platform) === clean) || null;
}

function getStableLeadId(lead = {}) {
  return String(lead?.id || lead?._id || lead?.lead_id || lead?.uuid || "").trim();
}

function getLeadByAnyId(db, id) {
  const cleanId = String(id || "").trim();
  if (!cleanId) return null;
  return ensureCrmArray(db, "leads").find((lead) => {
    return [lead.id, lead._id, lead.lead_id, lead.uuid].map((x) => String(x || "").trim()).includes(cleanId);
  }) || null;
}

function normalizeLeadDirection(value, fallback = "inbound") {
  const clean = String(value || fallback || "inbound").trim().toLowerCase();
  if (["outbound", "agent", "agent_outreach", "company", "business"].includes(clean)) return "outbound";
  if (["inbound", "client", "client_reached_out", "student", "lead", "user"].includes(clean)) return "inbound";
  return fallback || "inbound";
}

function normalizeLeadSourcePlatform(lead = {}, fallback = "other") {
  return normalizeSocialPlatform(
    lead.source_platform ||
    lead.platform ||
    lead.channel ||
    lead.source ||
    lead.source_channel ||
    fallback
  );
}

function normalizeLeadForResponse(lead = {}) {
  const id = getStableLeadId(lead) || uuid();
  const platform = normalizeLeadSourcePlatform(lead);
  const direction = normalizeLeadDirection(
    lead.conversation_direction ||
      lead.direction ||
      lead.lead_direction ||
      lead.origin ||
      (lead.agent_initiated ? "outbound" : "inbound"),
    lead.agent_initiated ? "outbound" : "inbound"
  );

  return {
    ...lead,
    id,
    lead_id: lead.lead_id || id,
    source_platform: platform,
    platform,
    source_channel: lead.source_channel || "social_integration",
    conversation_direction: direction,
    client_reached_out: direction === "inbound" ? true : Boolean(lead.client_reached_out),
    agent_initiated: direction === "outbound" ? true : Boolean(lead.agent_initiated),
    status: lead.status || lead.lead_status || "new",
    lead_status: lead.lead_status || lead.status || "new",
    last_message: lead.last_message || lead.last_message_text || lead.source_text || "",
    last_message_at: lead.last_message_at || lead.last_inbound_at || lead.updated_at || lead.created_at || null,
    assigned_agent: lead.assigned_agent || lead.assigned_agent_id || null,
  };
}

function ensureLeadIdentityFields(lead = {}) {
  const normalized = normalizeLeadForResponse(lead);
  Object.assign(lead, normalized);
  return lead;
}

function getPlatformContactIdForLead(platform, payload = {}) {
  const cleanPlatform = normalizeSocialPlatform(platform);
  return (
    payload.platform_contact_id ||
    payload[`${cleanPlatform}_id`] ||
    payload[`${cleanPlatform}_chat_id`] ||
    payload.telegram_chat_id ||
    payload.wa_id ||
    payload.whatsapp_phone ||
    payload.phone ||
    payload.email ||
    payload.username ||
    ""
  );
}

function detectMetaPayloadPlatform(payload = {}) {
  const object = String(payload?.object || "").toLowerCase();

  if (object.includes("instagram")) return "instagram";
  if (object.includes("page")) return "facebook";

  const entry = payload?.entry?.[0] || {};
  const messaging = entry?.messaging?.[0] || {};
  const change = entry?.changes?.[0] || {};
  const field = String(change?.field || "").toLowerCase();

  if (
    field.includes("instagram") ||
    ["comments", "live_comments", "messages", "messaging_postbacks", "message_reactions", "messaging_seen"].includes(field) &&
      (change?.value?.from?.username || change?.value?.media || change?.value?.comment_id)
  ) {
    return "instagram";
  }

  if (messaging?.recipient?.id || messaging?.sender?.id || field) return "facebook";

  return "facebook";
}

function extractMetaText({ platform, payload = {} }) {
  const entry = payload.entry?.[0] || {};
  const messaging = entry.messaging?.[0] || {};
  const change = entry.changes?.[0] || {};
  const value = change.value || {};

  const messageText =
    messaging.message?.text ||
    messaging.postback?.title ||
    messaging.postback?.payload ||
    value.message ||
    value.text ||
    value.comment ||
    value.caption ||
    payload.text ||
    payload.message ||
    "";

  const senderId =
    messaging.sender?.id ||
    value.from?.id ||
    value.sender?.id ||
    payload.sender_id ||
    payload.user_id ||
    payload.from_id ||
    "";

  const recipientId =
    messaging.recipient?.id ||
    value.recipient?.id ||
    entry.id ||
    payload.recipient_id ||
    "";

  const username =
    value.from?.username ||
    value.sender?.username ||
    payload.username ||
    payload.handle ||
    "";

  const displayName =
    value.from?.name ||
    value.sender?.name ||
    payload.name ||
    username ||
    senderId ||
    `${getPlatformConfig(platform).label} Lead`;

  const platformMessageId =
    messaging.message?.mid ||
    messaging.postback?.mid ||
    value.mid ||
    value.message_id ||
    value.comment_id ||
    value.id ||
    payload.message_id ||
    "";

  return { messageText, senderId, recipientId, username, displayName, platformMessageId, field: change.field || "" };
}

function getMetaTokenForPlatform(platform, integration = {}) {
  const cleanPlatform = normalizeSocialPlatform(platform);
  if (cleanPlatform === "instagram") {
    return (
      getIntegrationCredential(integration, "api_key", "INSTAGRAM_PAGE_ACCESS_TOKEN") ||
      process.env.INSTAGRAM_PAGE_ACCESS_TOKEN ||
      process.env.META_PAGE_ACCESS_TOKEN ||
      ""
    );
  }
  return (
    getIntegrationCredential(integration, "api_key", "META_PAGE_ACCESS_TOKEN") ||
    process.env.META_PAGE_ACCESS_TOKEN ||
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN ||
    ""
  );
}

function getMetaAccountIdForPlatform(platform, integration = {}) {
  const cleanPlatform = normalizeSocialPlatform(platform);
  if (cleanPlatform === "instagram") {
    return integration.account_id || process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || process.env.INSTAGRAM_ACCOUNT_ID || "me";
  }
  return integration.account_id || process.env.FACEBOOK_PAGE_ID || "me";
}

function buildConversationInbox(db) {
  const leads = ensureCrmArray(db, "leads").map(normalizeLeadForResponse);
  const conversations = ensureCrmArray(db, "conversations");

  return leads.map((lead) => {
    const leadId = getStableLeadId(lead);
    const leadMessages = conversations
      .filter((message) => String(message.lead_id || "") === String(leadId))
      .sort((a, b) => String(b.created_at || b.timestamp || "").localeCompare(String(a.created_at || a.timestamp || "")));

    const lastMessage = leadMessages[0] || null;
    const unreadCount = leadMessages.filter((message) => {
      return String(message.direction || "inbound") === "inbound" && !message.read_at && !message.admin_read_at;
    }).length;

    return {
      conversation_id: lead.conversation_id || leadId,
      lead_id: leadId,
      lead_name: lead.name || lead.display_name || "Unknown Lead",
      contact: lead.email || lead.phone || lead.whatsapp_phone || lead.platform_contact_id || "",
      platform: normalizeLeadSourcePlatform(lead),
      source_platform: normalizeLeadSourcePlatform(lead),
      platform_icon: normalizeLeadSourcePlatform(lead),
      last_message: lastMessage?.message_text || lastMessage?.text || lead.last_message || "",
      last_message_at: lastMessage?.created_at || lastMessage?.timestamp || lead.last_message_at || lead.updated_at || lead.created_at || null,
      unread_count: unreadCount,
      status: lead.status || lead.lead_status || "new",
      assigned_agent: lead.assigned_agent_name || lead.assigned_agent || lead.assigned_agent_id || "Unassigned",
      direction: lead.conversation_direction || "inbound",
      client_reached_out: lead.client_reached_out !== false,
      agent_initiated: Boolean(lead.agent_initiated),
    };
  }).sort((a, b) => String(b.last_message_at || "").localeCompare(String(a.last_message_at || "")));
}

function parseInboundSocialPayload({ platform, payload = {}, integration = null }) {
  let cleanPlatform = normalizeSocialPlatform(platform);
  const body = payload || {};

  if (cleanPlatform === "facebook" && (String(body.object || "").toLowerCase().includes("instagram"))) {
    cleanPlatform = "instagram";
  }

  let text = "";
  let externalUserId = "";
  let username = "";
  let displayName = "";
  let chatId = "";
  let email = "";
  let phone = "";
  let platformMessageId = "";
  let recipientId = "";

  if (cleanPlatform === "telegram") {
    const message = body.message || body.edited_message || body.channel_post || {};
    const from = message.from || {};
    const chat = message.chat || {};
    text = message.text || message.caption || body.text || "";
    externalUserId = String(from.id || chat.id || body.user_id || "");
    username = from.username || body.username || "";
    displayName = [from.first_name, from.last_name].filter(Boolean).join(" ") || username || chat.title || externalUserId;
    chatId = String(chat.id || externalUserId || "");
    platformMessageId = message.message_id || body.update_id || "";
  } else if (cleanPlatform === "whatsapp") {
    const value = body.entry?.[0]?.changes?.[0]?.value || body.value || body;
    const message = value.messages?.[0] || body.message || {};
    const contact = value.contacts?.[0] || {};
    text =
      message.text?.body ||
      message.button?.text ||
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.title ||
      body.text ||
      "";
    externalUserId = message.from || contact.wa_id || body.from || body.phone || "";
    phone = externalUserId;
    displayName = contact.profile?.name || body.name || externalUserId;
    chatId = externalUserId;
    platformMessageId = message.id || body.message_id || "";
  } else if (cleanPlatform === "facebook" || cleanPlatform === "instagram") {
    const meta = extractMetaText({ platform: cleanPlatform, payload: body });
    text = meta.messageText;
    externalUserId = meta.senderId;
    username = meta.username;
    displayName = meta.displayName;
    chatId = meta.senderId;
    recipientId = meta.recipientId;
    platformMessageId = meta.platformMessageId;
  } else if (cleanPlatform === "email") {
    text = body.text || body.html || body.subject || body.message || "";
    email = body.from || body.email || body.sender || body.reply_to || "";
    externalUserId = email;
    displayName = body.name || body.from_name || email;
    chatId = body.message_id || body.thread_id || email;
    platformMessageId = body.message_id || "";
  } else if (cleanPlatform === "discord") {
    text = body.content || body.text || "";
    externalUserId = body.author?.id || body.user_id || "";
    username = body.author?.username || body.username || "";
    displayName = body.author?.global_name || username || externalUserId;
    chatId = body.channel_id || "";
    platformMessageId = body.id || body.message_id || "";
  } else {
    text = body.text || body.message || body.comment || body.body || body.content || "";
    externalUserId = body.user_id || body.id || body.author_id || body.sender_id || body.profile_id || body.username || body.email || "";
    username = body.username || body.handle || body.author || "";
    email = body.email || "";
    phone = body.phone || body.whatsapp || "";
    displayName = body.name || username || email || phone || externalUserId || `${getPlatformConfig(cleanPlatform).label} Lead`;
    chatId = body.chat_id || body.thread_id || body.conversation_id || "";
    platformMessageId = body.message_id || body.id || "";
  }

  const platformContactId = String(getPlatformContactIdForLead(cleanPlatform, {
    platform_contact_id: externalUserId || chatId || email || phone,
    [`${cleanPlatform}_id`]: externalUserId,
    [`${cleanPlatform}_chat_id`]: chatId,
    email,
    phone,
  }) || "").trim();

  return compactDefined({
    name: displayName,
    display_name: displayName,
    email,
    phone,
    whatsapp: cleanPlatform === "whatsapp" ? phone : undefined,
    whatsapp_phone: cleanPlatform === "whatsapp" ? phone : undefined,
    wa_id: cleanPlatform === "whatsapp" ? externalUserId : undefined,

    [`${cleanPlatform}_id`]: externalUserId,
    [`${cleanPlatform}_username`]: username,
    [`${cleanPlatform}_chat_id`]: chatId,

    telegram_id: cleanPlatform === "telegram" ? externalUserId : undefined,
    telegram_username: cleanPlatform === "telegram" ? username : undefined,
    telegram_chat_id: cleanPlatform === "telegram" ? chatId : undefined,

    facebook_sender_id: cleanPlatform === "facebook" ? externalUserId : undefined,
    facebook_page_id: cleanPlatform === "facebook" ? (recipientId || process.env.FACEBOOK_PAGE_ID || "") : undefined,

    instagram_sender_id: cleanPlatform === "instagram" ? externalUserId : undefined,
    instagram_business_account_id: cleanPlatform === "instagram" ? (recipientId || process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || "") : undefined,

    platform_contact_id: platformContactId,
    platform_username: username,
    platform_display_name: displayName,
    platform_message_id: platformMessageId,
    source_platform: cleanPlatform,
    platform: cleanPlatform,
    source_channel: "social_integration",
    source_integration_id: integration?.id || null,
    source_integration_name: integration?.account_name || integration?.name || getPlatformConfig(cleanPlatform).label,
    source_text: String(text || "").trim(),
    last_message: String(text || "").trim(),
    last_message_at: nowIso(),
    conversation_summary: String(text || "").trim().slice(0, 300),
    conversation_direction: "inbound",
    client_reached_out: true,
    agent_initiated: false,
    opt_in_status: cleanPlatform === "whatsapp" ? "platform_inbound" : "platform_inbound",
    status: "new",
    lead_status: "new",
  });
}

function findExistingSocialLead(db, platform, payload = {}) {
  const cleanPlatform = normalizeSocialPlatform(platform);
  const leads = ensureCrmArray(db, "leads");
  const possibleIds = [
    payload.email,
    payload.phone,
    payload.whatsapp,
    payload.whatsapp_phone,
    payload.wa_id,
    payload.platform_contact_id,
    payload.telegram_id,
    payload.facebook_id,
    payload.instagram_id,
    payload.linkedin_id,
    payload.reddit_id,
    payload.youtube_id,
    payload.tiktok_id,
    payload.twitter_id,
    payload.discord_id,
    payload[`${cleanPlatform}_id`],
    payload[`${cleanPlatform}_username`],
    payload[`${cleanPlatform}_chat_id`],
  ].map((item) => String(item || "").trim()).filter(Boolean);

  return leads.find((lead) => {
    if (payload.email && normalizeEmail(lead.email) === normalizeEmail(payload.email)) return true;
    return possibleIds.some((value) => {
      return [
        lead.phone,
        lead.whatsapp,
        lead.whatsapp_phone,
        lead.wa_id,
        lead.platform_contact_id,
        lead.telegram_id,
        lead.facebook_id,
        lead.instagram_id,
        lead.linkedin_id,
        lead.reddit_id,
        lead.youtube_id,
        lead.tiktok_id,
        lead.twitter_id,
        lead.discord_id,
        lead[`${cleanPlatform}_id`],
        lead[`${cleanPlatform}_username`],
        lead[`${cleanPlatform}_chat_id`],
      ].map((x) => String(x || "").trim()).includes(value);
    });
  }) || null;
}

function upsertSocialLead(db, platform, payload = {}) {
  const cleanPlatform = normalizeSocialPlatform(platform);
  const previous = findExistingSocialLead(db, cleanPlatform, payload);
  const leads = ensureCrmArray(db, "leads");
  const now = nowIso();
  const inboundText = String(payload.last_message || payload.source_text || "").trim();

  if (previous) {
    Object.assign(previous, compactDefined(payload), {
      id: getStableLeadId(previous) || uuid(),
      lead_id: previous.lead_id || getStableLeadId(previous) || uuid(),
      source_platform: cleanPlatform,
      platform: cleanPlatform,
      source_channel: previous.source_channel || "social_integration",
      conversation_direction: previous.conversation_direction || "inbound",
      client_reached_out: previous.client_reached_out !== false,
      agent_initiated: Boolean(previous.agent_initiated),
      last_message: inboundText || previous.last_message || previous.last_message_text || "",
      last_message_at: inboundText ? now : previous.last_message_at || previous.updated_at || now,
      last_inbound_at: now,
      updated_at: now,
      status: previous.status || previous.lead_status || payload.status || "new",
      lead_status: previous.lead_status || previous.status || payload.lead_status || "new",
    });
    ensureLeadIdentityFields(previous);
    return { lead: previous, created: false };
  }

  const leadId = uuid();
  const lead = withTimestamps({
    id: leadId,
    lead_id: leadId,
    brand_id: payload.brand_id || null,
    name: payload.name || payload.display_name || `${getPlatformConfig(cleanPlatform).label} Lead`,
    status: payload.status || "new",
    lead_status: payload.lead_status || payload.status || "new",
    lead_score: Number(payload.lead_score || 10),
    source_platform: cleanPlatform,
    platform: cleanPlatform,
    source_channel: "social_integration",
    conversation_direction: "inbound",
    client_reached_out: true,
    agent_initiated: false,
    created_from: `${cleanPlatform}_webhook`,
    last_message: inboundText,
    last_message_at: inboundText ? now : null,
    last_inbound_at: now,
    ...compactDefined(payload),
  });

  ensureLeadIdentityFields(lead);
  leads.push(lead);
  return { lead, created: true };
}

function appendSocialConversation(db, { lead, platform, direction = "inbound", text = "", payload = {}, integration = null }) {
  const cleanPlatform = normalizeSocialPlatform(platform);
  const now = nowIso();
  const leadId = getStableLeadId(lead);
  const msgText = String(text || payload?.text || payload?.message || "").trim();

  const message = withTimestamps({
    id: uuid(),
    conversation_id: lead?.conversation_id || leadId || uuid(),
    brand_id: lead?.brand_id || integration?.brand_id || null,
    lead_id: leadId || null,
    platform: cleanPlatform,
    source_platform: cleanPlatform,
    integration_id: integration?.id || null,
    direction: normalizeLeadDirection(direction, "inbound"),
    message_text: msgText,
    text: msgText,
    platform_message_id: payload?.message_id || payload?.platform_message_id || payload?.entry?.[0]?.messaging?.[0]?.message?.mid || null,
    platform_contact_id: lead?.platform_contact_id || lead?.[`${cleanPlatform}_id`] || null,
    raw_payload: payload || {},
    sent_by: normalizeLeadDirection(direction, "inbound") === "outbound" ? "system" : "lead",
    status: normalizeLeadDirection(direction, "inbound") === "outbound" ? "sent" : "received",
    timestamp: now,
    created_at: now,
  });

  ensureCrmArray(db, "conversations").push(message);

  if (lead) {
    lead.id = leadId || lead.id || uuid();
    lead.lead_id = lead.lead_id || lead.id;
    lead.last_message = msgText || lead.last_message || "";
    lead.last_message_at = now;
    if (normalizeLeadDirection(direction, "inbound") === "inbound") {
      lead.last_inbound_at = now;
      lead.client_reached_out = true;
      lead.conversation_direction = lead.conversation_direction || "inbound";
    } else {
      lead.last_outbound_at = now;
      lead.agent_initiated = true;
    }
    lead.updated_at = now;
  }

  return message;
}

function createSocialClientDataEvent(db, { lead, platform, payload = {}, integration = null }) {
  const event = withTimestamps({
    id: uuid(),
    lead_id: lead?.id || null,
    brand_id: lead?.brand_id || integration?.brand_id || null,
    agent_id: null,
    event_type: `${normalizeSocialPlatform(platform)}_inbound_capture`,
    source: normalizeSocialPlatform(platform),
    client_data: compactDefined(payload),
  });
  ensureCrmArray(db, "client_data_events").push(event);
  return event;
}

async function testSocialIntegration(integration = {}) {
  const platform = normalizeSocialPlatform(integration.platform);
  const config = getPlatformConfig(platform);

  if (platform === "telegram") {
    const telegramResult = await telegramApi("getMe", {}, integration);
    return {
      message: `Telegram live connection passed for @${telegramResult.result?.username || "bot"}`,
      platform,
      live_connected: true,
      safe_metadata: { bot_username: telegramResult.result?.username || null, bot_id: telegramResult.result?.id || null },
      bot: telegramResult.result,
    };
  }

  if (platform === "email") {
    const hasResend = Boolean(process.env.RESEND_API_KEY);
    const hasSendGrid = Boolean(process.env.SENDGRID_API_KEY);
    const hasSmtp = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    if (!hasResend && !hasSendGrid && !hasSmtp && !integration.api_key) {
      const e = new Error("Email provider is not configured. Add RESEND_API_KEY, SENDGRID_API_KEY, SMTP_* or save an integration API key.");
      e.statusCode = 400;
      throw e;
    }
    return { message: "Email integration configuration found", platform, live_connected: Boolean(hasResend || hasSendGrid), mode: hasResend ? "resend" : hasSendGrid ? "sendgrid" : "smtp_or_saved_credentials", safe_metadata: { provider: hasResend ? "resend" : hasSendGrid ? "sendgrid" : "smtp_or_saved_credentials" } };
  }

  if (platform === "whatsapp") {
    const token = getIntegrationCredential(integration, "api_key", "WHATSAPP_ACCESS_TOKEN") || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = integration.phone_number_id || integration.account_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) {
      const e = new Error("WhatsApp is missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.");
      e.statusCode = 400;
      throw e;
    }
    const response = await axios.get(`https://graph.facebook.com/v19.0/${phoneNumberId}`, { params: { access_token: token }, timeout: 20000 });
    return { message: "WhatsApp Cloud API connection passed", platform, live_connected: true, safe_metadata: { phone_number_id: phoneNumberId, display_phone_number: response.data?.display_phone_number || null }, meta: response.data };
  }

  if (platform === "facebook" || platform === "instagram") {
    const token = getMetaTokenForPlatform(platform, integration);
    if (!token) {
      const e = new Error(platform === "instagram"
        ? "Instagram integration is missing INSTAGRAM_PAGE_ACCESS_TOKEN or META_PAGE_ACCESS_TOKEN."
        : "Facebook integration is missing META_PAGE_ACCESS_TOKEN.");
      e.statusCode = 400;
      throw e;
    }

    const id = getMetaAccountIdForPlatform(platform, integration);
    const fields = platform === "instagram" ? "id,username,name" : "id,name";

    try {
      const response = await axios.get(`https://graph.facebook.com/v19.0/${id}`, {
        params: { access_token: token, fields },
        timeout: 20000,
      });

      return {
        message: `${config.label} API connection passed`,
        platform,
        live_connected: true,
        configured: true,
        mode: "graph_verified",
        safe_metadata: {
          id: response.data?.id || id,
          name: response.data?.name || response.data?.username || null,
          graph_verified: true,
        },
        meta: response.data,
      };
    } catch (error) {
      const metaError = error.response?.data?.error || {};
      const metaMessage = String(metaError.message || error.message || "Meta Graph API test failed");
      const metaCode = metaError.code || error.response?.status || null;

      const isPermissionOrReviewBlock =
        error.response?.status === 400 &&
        (
          metaCode === 100 ||
          metaCode === 10 ||
          metaCode === 190 ||
          /missing permission|reviewable feature|does not exist|pages_read_engagement|permission/i.test(metaMessage)
        );

      if (!isPermissionOrReviewBlock) {
        const e = new Error(metaMessage);
        e.statusCode = error.response?.status || 500;
        throw e;
      }

      return {
        message: `${config.label} token is stored, webhook can be configured, but Meta profile lookup is blocked by permission/app review.`,
        platform,
        live_connected: false,
        configured: true,
        mode: "configured_permission_limited",
        warning: metaMessage,
        safe_metadata: {
          id,
          graph_verified: false,
          meta_error_code: metaCode,
          required_review_or_permission: true,
          note: platform === "facebook"
            ? "Facebook Page messaging can be configured for development, but Page metadata lookup may need pages_read_engagement/app review."
            : "Instagram messaging can be configured for development, but IG metadata lookup may need Instagram permissions/app review.",
        },
      };
    }
  }

  if (platform === "discord") {
    const webhookUrl = integration.webhook_url || process.env.DISCORD_WEBHOOK_URL;
    const botToken = getIntegrationCredential(integration, "api_key", "DISCORD_BOT_TOKEN") || process.env.DISCORD_BOT_TOKEN;
    if (!webhookUrl && !botToken) {
      const e = new Error("Discord is missing DISCORD_WEBHOOK_URL or DISCORD_BOT_TOKEN.");
      e.statusCode = 400;
      throw e;
    }
    return { message: "Discord configuration found", platform, live_connected: Boolean(webhookUrl || botToken), safe_metadata: { mode: webhookUrl ? "webhook" : "bot_token" } };
  }

  const configured = Boolean(integration.api_key || integration.access_token || integration.account_id || integration.webhook_url);
  return {
    message: `${config.label} settings are stored. Live API execution is manual/approval-first until OAuth/API access is completed.`,
    platform,
    live_connected: false,
    configured,
    mode: configured ? "configured_manual_first" : "not_configured",
    required_env: config.env,
    safe_metadata: { required_env: config.env, manual_first: true },
  };
}

async function syncSocialIntegration({ db, integration, body = {} }) {
  const platform = normalizeSocialPlatform(integration.platform);
  if (platform === "telegram") {
    const result = await telegramApi("getMe", {}, integration);
    return { message: `Telegram sync checked bot @${result.result?.username || "bot"}`, platform, live_connected: true, leads_captured: 0, safe_metadata: { bot_username: result.result?.username || null } };
  }
  if (["whatsapp", "facebook", "instagram", "email", "discord"].includes(platform)) {
    const test = await testSocialIntegration(integration);
    return { ...test, message: `${getPlatformConfig(platform).label} configuration synced`, leads_captured: 0 };
  }
  return { message: `${getPlatformConfig(platform).label} sync saved as manual-first. Inbound webhooks/imports can still capture leads.`, platform, live_connected: false, leads_captured: 0, safe_metadata: { manual_first: true } };
}

async function sendSocialMessage({ db, integration, body = {} }) {
  const platform = normalizeSocialPlatform(integration.platform);
  const to = body.to || body.chat_id || body.phone || body.email || body.recipient || body.channel_id;
  const text = String(body.text || body.message || body.body || "").trim();
  if (!text) {
    const e = new Error("Message text is required");
    e.statusCode = 400;
    throw e;
  }

  if (platform === "telegram") {
    const result = await telegramApi("sendMessage", { chat_id: to, text }, integration);
    return { message: "Telegram message sent", platform, live_sent: true, raw: result };
  }

  if (platform === "email") {
    const from = body.from || process.env.EMAIL_FROM || process.env.RESEND_FROM_EMAIL || "NextGen USMLE <noreply@nextgenusmlelms.com>";
    const subject = body.subject || "NextGen USMLE";
    if (process.env.RESEND_API_KEY) {
      const response = await axios.post("https://api.resend.com/emails", { from, to: Array.isArray(to) ? to : [to], subject, text }, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000 });
      return { message: "Email sent through Resend", platform, live_sent: true, raw: response.data };
    }
    if (process.env.SENDGRID_API_KEY) {
      const response = await axios.post("https://api.sendgrid.com/v3/mail/send", { personalizations: [{ to: [{ email: to }] }], from: { email: String(from).match(/<([^>]+)>/)?.[1] || from }, subject, content: [{ type: "text/plain", value: text }] }, { headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000 });
      return { message: "Email sent through SendGrid", platform, live_sent: true, raw: { status: response.status } };
    }
    const e = new Error("Email sending requires RESEND_API_KEY or SENDGRID_API_KEY.");
    e.statusCode = 400;
    throw e;
  }

  if (platform === "whatsapp") {
    const token = getIntegrationCredential(integration, "api_key", "WHATSAPP_ACCESS_TOKEN") || process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = integration.phone_number_id || integration.account_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) {
      const e = new Error("WhatsApp is missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.");
      e.statusCode = 400;
      throw e;
    }
    const response = await axios.post(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, { messaging_product: "whatsapp", to, type: "text", text: { preview_url: false, body: text } }, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 30000 });
    return { message: "WhatsApp message sent", platform, live_sent: true, raw: response.data };
  }

  if (platform === "facebook" || platform === "instagram") {
    const token = getMetaTokenForPlatform(platform, integration);
    if (!token) {
      const e = new Error(platform === "instagram"
        ? "Instagram sending requires INSTAGRAM_PAGE_ACCESS_TOKEN or META_PAGE_ACCESS_TOKEN."
        : "Facebook sending requires META_PAGE_ACCESS_TOKEN.");
      e.statusCode = 400;
      throw e;
    }

    const recipientId = to;
    if (!recipientId) {
      const e = new Error("Recipient ID is required for Meta messaging.");
      e.statusCode = 400;
      throw e;
    }

    const response = await axios.post(
      `https://graph.facebook.com/v19.0/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text },
        messaging_type: body.messaging_type || "RESPONSE",
      },
      {
        params: { access_token: token },
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      }
    );

    return {
      message: `${getPlatformConfig(platform).label} message sent`,
      platform,
      live_sent: true,
      raw: response.data,
    };
  }

  if (platform === "discord") {
    const webhookUrl = integration.webhook_url || process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) {
      const e = new Error("Discord webhook URL is required for live send.");
      e.statusCode = 400;
      throw e;
    }
    const response = await axios.post(webhookUrl, { content: text }, { timeout: 30000 });
    return { message: "Discord webhook message sent", platform, live_sent: true, raw: { status: response.status } };
  }

  const draft = withTimestamps({
    id: uuid(),
    brand_id: integration.brand_id || null,
    integration_id: integration.id,
    platform,
    action_type: `${platform}_manual_send_draft`,
    input_text: text,
    output_text: text,
    status: "draft",
    approval_status: "needs_approval",
    metadata: { to },
  });
  ensureCrmArray(db, "approval_queue").push(draft);
  return { message: `${getPlatformConfig(platform).label} is manual-first. Message saved to approval queue as a draft.`, platform, live_sent: false, approval_item: draft };
}

function verifyMetaWebhook(req, res) {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  const expected = process.env.META_VERIFY_TOKEN || process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (mode === "subscribe" && token && expected && token === expected) return res.status(200).send(challenge);
  return res.status(403).send("Forbidden");
}

function verifyTelegramSecretHeader(req) {
  const expectedSecret = getTelegramWebhookSecret();
  if (!expectedSecret) return true;
  const receivedSecret = req.headers["x-telegram-bot-api-secret-token"];
  return String(receivedSecret || "") === String(expectedSecret);
}

async function handleUniversalWebhook({ req, res, platform, integrationId = null }) {
  try {
    const db = await readCrmDb();
    const requestedPlatform = normalizeSocialPlatform(platform);
    const cleanPlatform = (requestedPlatform === "facebook" || requestedPlatform === "instagram")
      ? (String(req.body?.object || "").toLowerCase().includes("instagram") ? "instagram" : requestedPlatform)
      : requestedPlatform;
    const integration = integrationId
      ? ensureCrmArray(db, "integrations").find((item) => String(item.id) === String(integrationId))
      : getIntegrationByPlatform(db, cleanPlatform);

    const leadPayload = parseInboundSocialPayload({ platform: cleanPlatform, payload: req.body || {}, integration });
    const inboundText = leadPayload.source_text || "";
    const { lead, created } = upsertSocialLead(db, cleanPlatform, leadPayload);
    const conversation = appendSocialConversation(db, { lead, platform: cleanPlatform, direction: "inbound", text: inboundText, payload: req.body || {}, integration });
    createSocialClientDataEvent(db, { lead, platform: cleanPlatform, payload: leadPayload, integration });
    createIntegrationLog(db, { brand_id: integration?.brand_id || lead.brand_id || null, integration_id: integration?.id || null, platform: cleanPlatform, action: "inbound_webhook", status: "success", message: created ? `Created lead from ${cleanPlatform} inbound webhook` : `Updated lead from ${cleanPlatform} inbound webhook`, metadata: { lead_id: lead.id, conversation_id: conversation.id } });

    await writeCrmDb(db);
    res.json({ success: true, platform: cleanPlatform, lead_id: lead.id, created, conversation_id: conversation.id });
  } catch (error) {
    console.error("Universal social webhook error:", error.message);
    res.status(error.statusCode || 500).json({ success: false, error: error.message || "Webhook failed" });
  }
}

app.get("/webhooks/social/:platform/:integrationId?", (req, res) => {
  const platform = normalizeSocialPlatform(req.params.platform);
  if (["whatsapp", "facebook", "instagram"].includes(platform)) return verifyMetaWebhook(req, res);
  res.json({ success: true, platform, message: `${getPlatformConfig(platform).label} webhook endpoint is online. Send POST requests here.` });
});

app.post("/webhooks/social/:platform/:integrationId?", async (req, res) => {
  const platform = normalizeSocialPlatform(req.params.platform);
  if (platform === "telegram" && !verifyTelegramSecretHeader(req)) return res.status(403).json({ success: false, error: "Invalid Telegram webhook secret" });
  return handleUniversalWebhook({ req, res, platform, integrationId: req.params.integrationId || null });
});

app.get("/webhooks/whatsapp", verifyMetaWebhook);
app.post("/webhooks/whatsapp", async (req, res) => handleUniversalWebhook({ req, res, platform: "whatsapp" }));
app.get("/webhooks/meta", verifyMetaWebhook);
app.post("/webhooks/meta", async (req, res) => handleUniversalWebhook({ req, res, platform: "facebook" }));
app.post("/webhooks/email", async (req, res) => handleUniversalWebhook({ req, res, platform: "email" }));
app.post("/webhooks/reddit", async (req, res) => handleUniversalWebhook({ req, res, platform: "reddit" }));
app.post("/webhooks/linkedin", async (req, res) => handleUniversalWebhook({ req, res, platform: "linkedin" }));
app.post("/webhooks/youtube", async (req, res) => handleUniversalWebhook({ req, res, platform: "youtube" }));
app.post("/webhooks/tiktok", async (req, res) => handleUniversalWebhook({ req, res, platform: "tiktok" }));
app.post("/webhooks/twitter", async (req, res) => handleUniversalWebhook({ req, res, platform: "twitter" }));
app.post("/webhooks/discord", async (req, res) => handleUniversalWebhook({ req, res, platform: "discord" }));

app.get("/admin/crm/integrations/platforms", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    res.json({
      success: true,
      platforms: Object.entries(SOCIAL_PLATFORM_CONFIG).map(([key, value]) => ({ platform: key, ...value })),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/integrations/:id/send", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const integration = ensureCrmArray(db, "integrations").find((item) => String(item.id) === String(req.params.id));
    if (!integration) return res.status(404).json({ success: false, error: "Integration not found" });

    const result = await sendSocialMessage({ db, integration, body: req.body || {} });
    createIntegrationLog(db, { brand_id: integration.brand_id, integration_id: integration.id, platform: integration.platform, action: "send_message", status: result.live_sent ? "success" : "draft", message: result.message, metadata: { to: req.body?.to || req.body?.chat_id || req.body?.email || req.body?.phone || null } });
    await writeCrmDb(db);

    res.json({ success: true, ...result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/integrations/:id/capture", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const integration = ensureCrmArray(db, "integrations").find((item) => String(item.id) === String(req.params.id));
    if (!integration) return res.status(404).json({ success: false, error: "Integration not found" });

    const platform = normalizeSocialPlatform(integration.platform);
    const leadPayload = { ...parseInboundSocialPayload({ platform, payload: req.body || {}, integration }), ...compactDefined(normalizeClientDataPayload(req.body || {})) };
    const { lead, created } = upsertSocialLead(db, platform, leadPayload);
    const conversation = appendSocialConversation(db, { lead, platform, direction: req.body.direction || "manual_capture", text: leadPayload.source_text || req.body.notes || "", payload: req.body || {}, integration });
    createSocialClientDataEvent(db, { lead, platform, payload: leadPayload, integration });
    createIntegrationLog(db, { brand_id: integration.brand_id, integration_id: integration.id, platform, action: "manual_capture", status: "success", message: created ? "Lead captured from integration" : "Lead updated from integration", metadata: { lead_id: lead.id } });

    await writeCrmDb(db);
    res.json({ success: true, lead, created, conversation });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.get("/admin/crm/integrations/:id/status", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const integration = ensureCrmArray(db, "integrations").find((item) => String(item.id) === String(req.params.id));
    if (!integration) return res.status(404).json({ success: false, error: "Integration not found" });
    const platform = normalizeSocialPlatform(integration.platform);
    res.json({ success: true, platform, config: getPlatformConfig(platform), integration: sanitizeIntegrationForResponse(integration) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});



app.get("/admin/crm/conversation-inbox", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const conversations = buildConversationInbox(db);

    const platform = req.query.platform ? normalizeSocialPlatform(req.query.platform) : null;
    const status = req.query.status ? String(req.query.status).toLowerCase() : null;
    const direction = req.query.direction ? normalizeLeadDirection(req.query.direction, "") : null;
    const unreadOnly = String(req.query.unread || "false").toLowerCase() === "true";

    const filtered = conversations.filter((item) => {
      if (platform && item.platform !== platform) return false;
      if (status && String(item.status || "").toLowerCase() !== status) return false;
      if (direction && item.direction !== direction) return false;
      if (unreadOnly && Number(item.unread_count || 0) <= 0) return false;
      return true;
    });

    res.json({
      success: true,
      conversations: filtered,
      count: filtered.length,
      summary: {
        total: conversations.length,
        unread: conversations.filter((item) => Number(item.unread_count || 0) > 0).length,
        whatsapp: conversations.filter((item) => item.platform === "whatsapp").length,
        telegram: conversations.filter((item) => item.platform === "telegram").length,
        email: conversations.filter((item) => item.platform === "email").length,
        facebook: conversations.filter((item) => item.platform === "facebook").length,
        instagram: conversations.filter((item) => item.platform === "instagram").length,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.post("/admin/crm/conversations/:leadId/send", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const lead = getLeadByAnyId(db, req.params.leadId);
    if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });

    const platform = normalizeLeadSourcePlatform(lead);
    const integration = getIntegrationByPlatform(db, platform) || { id: null, platform };
    const to =
      req.body.to ||
      lead.platform_contact_id ||
      lead.telegram_chat_id ||
      lead.wa_id ||
      lead.whatsapp_phone ||
      lead.phone ||
      lead.email ||
      lead.facebook_sender_id ||
      lead.instagram_sender_id;

    const result = await sendSocialMessage({
      db,
      integration,
      body: {
        ...req.body,
        to,
        text: req.body.text || req.body.message || req.body.body,
      },
    });

    const conversation = appendSocialConversation(db, {
      lead,
      platform,
      direction: "outbound",
      text: req.body.text || req.body.message || req.body.body || "",
      payload: { send_result: result },
      integration,
    });

    createIntegrationLog(db, {
      brand_id: integration?.brand_id || lead.brand_id || null,
      integration_id: integration?.id || null,
      platform,
      action: "admin_send_message",
      status: result.live_sent ? "success" : "queued",
      message: result.message,
      metadata: { lead_id: lead.id, conversation_id: conversation.id },
    });

    await writeCrmDb(db);
    res.json({ success: true, result, conversation });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});



// -----------------------------------------------------------------------------
// CRM Advanced Operating System: Flow Builder, Live Conversion, Team/Roles,
// Referrals/Commissions, Community Intelligence, Dashboard Settings
// -----------------------------------------------------------------------------

const DEFAULT_CRM_DASHBOARD_LAYOUT = {
  version: 1,
  sidebar_mode: "grouped",
  compact_mode: true,
  default_landing_page: "conversation_inbox",
  groups: [
    {
      key: "daily_work",
      label: "Daily Work",
      description: "The pages used every day by admins and agents.",
      modules: ["conversation_inbox", "leads", "approval_queue", "followup_rules", "sales_handoff"]
    },
    {
      key: "growth",
      label: "Growth Channels",
      description: "Lead sources, integrations, campaigns, and community intelligence.",
      modules: ["social_integrations", "communities", "geo_communities", "community_intelligence", "campaigns", "post_generator", "import_contacts"]
    },
    {
      key: "ai_control",
      label: "AI Control",
      description: "AI agents, flow builder, training, templates, costs, and safety.",
      modules: ["ai_agents", "ai_flow_builder", "ai_training_center", "ai_lead_analyzer", "ai_control_center", "templates", "ai_usage_cost", "ai_cost_settings", "action_logs"]
    },
    {
      key: "sales_revenue",
      label: "Sales & Revenue",
      description: "Live-session conversion, coupons, referrals, commissions, and ROI.",
      modules: ["live_session_conversion", "coupons_offers", "regional_strategies", "cost_revenue_dashboard", "team_role_portal", "referral_commission"]
    },
    {
      key: "system",
      label: "System",
      description: "Brands, dashboard settings, module visibility, and portal controls.",
      modules: ["brands", "dashboard_settings", "settings"]
    }
  ],
  module_labels: {
    brands: "Brands",
    leads: "Leads",
    import_contacts: "Import Contacts",
    communities: "Communities",
    geo_communities: "Geo Communities",
    social_integrations: "Social Integrations",
    conversation_inbox: "Conversations Inbox",
    ai_agents: "AI Agents",
    ai_flow_builder: "AI Flow Builder",
    coupons_offers: "Coupons / Offers",
    regional_strategies: "Regional Strategies",
    campaigns: "Campaigns",
    post_generator: "Post Generator",
    ai_lead_analyzer: "AI Lead Analyzer",
    ai_control_center: "AI Control Center",
    ai_usage_cost: "AI Usage & Cost",
    ai_cost_settings: "AI Cost Settings",
    approval_queue: "Approval Queue",
    templates: "Templates",
    followup_rules: "Follow-up Rules",
    ai_training_center: "AI Training Center",
    sales_handoff: "Sales Handoff",
    action_logs: "Action Logs",
    live_session_conversion: "Live Session Conversion",
    community_intelligence: "Community Intelligence",
    cost_revenue_dashboard: "Cost & Revenue Dashboard",
    team_role_portal: "Team / Role Portal",
    referral_commission: "Referral & Commission",
    dashboard_settings: "Dashboard Settings",
    settings: "Settings"
  },
  hidden_modules: [],
  pinned_modules: ["conversation_inbox", "leads", "approval_queue", "live_session_conversion"],
};

const DEFAULT_ROLE_PERMISSION_SETS = {
  admin: ["*"] ,
  instructor: ["view_assigned_courses", "manage_live_sessions", "manage_recordings", "manage_assessments", "view_assigned_students", "reply_assigned_conversations"],
  sales_agent: ["view_assigned_leads", "reply_assigned_conversations", "use_ai_draft", "create_followups"],
  closer: ["view_assigned_leads", "reply_assigned_conversations", "send_payment_links", "view_revenue_limited", "create_followups"],
  community_manager: ["manage_community_intelligence", "draft_community_replies", "submit_approval_items"],
  affiliate: ["view_own_referrals", "view_own_commissions"],
  support_agent: ["view_assigned_leads", "reply_assigned_conversations", "create_internal_notes"],
};

function getDefaultLiveConversionSettings(brandId = null) {
  return {
    id: `live_conversion_${brandId || "global"}`,
    brand_id: brandId || null,
    enabled: true,
    approval_required: true,
    promote_live_sessions: true,
    promote_demo_sessions: true,
    link_send_window_minutes_before: 120,
    link_send_window_minutes_after_start: 30,
    post_session_followup_minutes: 45,
    did_not_attend_followup_hours: 12,
    max_session_invites_per_lead: 3,
    default_course_id: null,
    default_plan_id: null,
    default_payment_link: "",
    default_booking_link: "",
    message_templates: {
      live_now: "Doctor, a relevant live session is starting now. You can join and experience the teaching style before enrollment: {{session_link}}",
      upcoming: "Doctor, we have a relevant live/demo session coming up at {{session_time}}. I can send you the join link when it opens.",
      post_session_attended: "How was the session, Doctor? If you liked the teaching style, I can guide you to the best plan for your timeline.",
      post_session_missed: "No problem if you missed it. I can send you the next available live/demo session so you can experience the class before deciding.",
      payment_link: "Based on your timeline, this plan fits best: {{plan_name}}. Here is the secure enrollment link: {{payment_link}}"
    },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function getDashboardSettings(db, brandId = null) {
  const existing = ensureCrmArray(db, "dashboard_settings").find((item) => !brandId || String(item.brand_id || "") === String(brandId));
  if (existing) return { ...DEFAULT_CRM_DASHBOARD_LAYOUT, ...existing };
  return {
    id: `dashboard_${brandId || "global"}`,
    brand_id: brandId || null,
    ...DEFAULT_CRM_DASHBOARD_LAYOUT,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function getLiveConversionSettings(db, brandId = null) {
  const existing = ensureCrmArray(db, "live_conversion_settings").find((item) => !brandId || String(item.brand_id || "") === String(brandId));
  return existing ? { ...getDefaultLiveConversionSettings(brandId), ...existing } : getDefaultLiveConversionSettings(brandId);
}

function normalizeCrmFlow(body = {}, existing = null, brandId = null) {
  const now = nowIso();
  return {
    ...(existing || {}),
    id: existing?.id || body.id || uuid(),
    brand_id: body.brand_id || existing?.brand_id || brandId || null,
    name: normalizeCrmString(body.name || existing?.name || "New CRM Flow"),
    description: normalizeCrmString(body.description || existing?.description || ""),
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : existing?.enabled !== false,
    platforms: Array.isArray(body.platforms) ? body.platforms.map(normalizeSocialPlatform) : existing?.platforms || ["whatsapp", "telegram", "email"],
    trigger: body.trigger || existing?.trigger || "new_inbound_message",
    conditions: safeCrmJson(body.conditions, existing?.conditions || { intents: ["pricing_inquiry", "course_inquiry", "demo_interest", "live_class_inquiry"] }),
    steps: Array.isArray(body.steps) ? body.steps : existing?.steps || [
      { id: "classify_intent", type: "ai_classify_intent", label: "Classify intent" },
      { id: "check_live_sessions", type: "check_live_sessions", label: "Check ongoing/upcoming sessions" },
      { id: "draft_session_invite", type: "draft_or_send", label: "Draft/send live session invite", approval_required: true },
      { id: "schedule_followup", type: "schedule_followup", label: "Schedule post-session follow-up" },
      { id: "recommend_plan", type: "recommend_plan", label: "Recommend plan/payment link" },
      { id: "escalate_hot_lead", type: "escalate_if_hot", label: "Escalate hot lead" }
    ],
    approval_mode: body.approval_mode || existing?.approval_mode || "draft_first",
    max_followups: Number(body.max_followups ?? existing?.max_followups ?? 3),
    assigned_agent_id: body.assigned_agent_id || existing?.assigned_agent_id || null,
    status: body.status || existing?.status || "active",
    created_at: existing?.created_at || body.created_at || now,
    updated_at: now,
  };
}

function calculateStripeFeeUsd(amountUsd, override = null) {
  if (override !== null && override !== undefined && override !== "") return Number(override || 0);
  const amount = Number(amountUsd || 0);
  if (amount <= 0) return 0;
  const percent = Number(process.env.STRIPE_FEE_PERCENT || 2.9);
  const fixed = Number(process.env.STRIPE_FEE_FIXED_USD || 0.30);
  return Number(((amount * percent) / 100 + fixed).toFixed(2));
}

function calculateCommission({ grossUsd = 0, netUsd = 0, rule = null }) {
  if (!rule || rule.active === false) return 0;
  const basis = String(rule.basis || "net").toLowerCase() === "gross" ? Number(grossUsd || 0) : Number(netUsd || 0);
  if (rule.commission_type === "fixed") return Number(rule.amount_usd || 0);
  return Number(((basis * Number(rule.percent || rule.commission_percent || 0)) / 100).toFixed(2));
}

function findReferralCode(db, code) {
  const clean = normalizeCrmString(code).toUpperCase();
  if (!clean) return null;
  return ensureCrmArray(db, "referral_codes").find((item) => String(item.code || "").toUpperCase() === clean) || null;
}

function getTeamMemberStats(db, teamMemberId) {
  const attributions = ensureCrmArray(db, "referral_attributions").filter((item) => String(item.team_member_id) === String(teamMemberId));
  const payouts = ensureCrmArray(db, "commission_payouts").filter((item) => String(item.team_member_id) === String(teamMemberId));
  const gross = attributions.reduce((sum, item) => sum + Number(item.gross_revenue_usd || 0), 0);
  const stripeFees = attributions.reduce((sum, item) => sum + Number(item.stripe_fee_usd || 0), 0);
  const commissions = attributions.reduce((sum, item) => sum + Number(item.commission_amount_usd || 0), 0);
  const paid = payouts.filter((item) => item.status === "paid").reduce((sum, item) => sum + Number(item.amount_usd || 0), 0);
  return {
    referrals_count: attributions.length,
    gross_revenue_usd: Number(gross.toFixed(2)),
    stripe_fees_usd: Number(stripeFees.toFixed(2)),
    net_revenue_usd: Number((gross - stripeFees).toFixed(2)),
    commission_earned_usd: Number(commissions.toFixed(2)),
    commission_paid_usd: Number(paid.toFixed(2)),
    commission_pending_usd: Number((commissions - paid).toFixed(2)),
  };
}

function logTeamActivity(db, payload = {}) {
  const log = withTimestamps({
    id: uuid(),
    team_member_id: payload.team_member_id || null,
    user_id: payload.user_id || null,
    role_id: payload.role_id || null,
    action: payload.action || "team_activity",
    message: payload.message || "",
    metadata: payload.metadata || {},
  });
  ensureCrmArray(db, "team_activity_logs").push(log);
  return log;
}

function defaultCommunityIntelligenceSettings(brandId = null) {
  return {
    id: `community_intelligence_${brandId || "global"}`,
    brand_id: brandId || null,
    enabled: true,
    approval_required: true,
    mode: "manual_first",
    allowed_platforms: ["telegram", "reddit", "facebook", "instagram", "youtube", "linkedin"],
    blocked_actions: ["mass_dm", "spam_comment", "auto_post_without_approval"],
    default_keywords: ["usmle", "step 1", "step 2", "uworld", "nbme", "first aid", "pathoma", "sketchy"],
    max_drafts_per_day: 20,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function getCommunityIntelligenceSettings(db, brandId = null) {
  const existing = ensureCrmArray(db, "community_intelligence_settings").find((item) => !brandId || String(item.brand_id || "") === String(brandId));
  return existing ? { ...defaultCommunityIntelligenceSettings(brandId), ...existing } : defaultCommunityIntelligenceSettings(brandId);
}

// Dashboard grouping/settings so the CRM is not crowded on frontend.
app.get("/admin/crm/dashboard-settings", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    res.json({ success: true, settings: getDashboardSettings(db, brandId) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

app.put("/admin/crm/dashboard-settings", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const records = ensureCrmArray(db, "dashboard_settings");
    const existingIndex = records.findIndex((item) => String(item.brand_id || "") === String(brandId || ""));
    const existing = existingIndex >= 0 ? records[existingIndex] : getDashboardSettings(db, brandId);
    const updated = { ...existing, ...(req.body || {}), id: existing.id || `dashboard_${brandId || "global"}`, brand_id: brandId, updated_at: nowIso(), created_at: existing.created_at || nowIso() };
    if (existingIndex >= 0) records[existingIndex] = updated;
    else records.push(updated);
    await writeCrmDb(db);
    res.json({ success: true, settings: updated });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
  }
});

// AI Flow Builder
app.get("/admin/crm/flows", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const flows = filterCrmRecords(req, ensureCrmArray(db, "crm_flows"), brandId);
    res.json({ success: true, flows, count: flows.length });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/flows", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const flow = normalizeCrmFlow(req.body || {}, null, brandId);
    flow.created_by = user.id;
    ensureCrmArray(db, "crm_flows").push(flow);
    createCrmActionLog(db, { brand_id: brandId, agent_name: "system", action_type: "create_crm_flow", channel: "admin", output_text: flow.name, created_by: user.id });
    await writeCrmDb(db);
    res.json({ success: true, flow });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.get("/admin/crm/flows/:id", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const flow = ensureCrmArray(db, "crm_flows").find((item) => String(item.id) === String(req.params.id));
    if (!flow) return res.status(404).json({ success: false, error: "CRM flow not found" });
    const runs = ensureCrmArray(db, "crm_flow_runs").filter((run) => String(run.flow_id) === String(flow.id)).sort(sortNewestFirst).slice(0, 50);
    res.json({ success: true, flow, runs });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.put("/admin/crm/flows/:id", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const flows = ensureCrmArray(db, "crm_flows");
    const index = flows.findIndex((item) => String(item.id) === String(req.params.id));
    if (index < 0) return res.status(404).json({ success: false, error: "CRM flow not found" });
    flows[index] = normalizeCrmFlow(req.body || {}, flows[index], flows[index].brand_id);
    flows[index].updated_by = user.id;
    await writeCrmDb(db);
    res.json({ success: true, flow: flows[index] });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/flows/:id/run", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const flow = ensureCrmArray(db, "crm_flows").find((item) => String(item.id) === String(req.params.id));
    if (!flow) return res.status(404).json({ success: false, error: "CRM flow not found" });
    const lead = req.body.lead_id ? getLeadByAnyId(db, req.body.lead_id) : null;
    const run = withTimestamps({
      id: uuid(),
      brand_id: flow.brand_id || null,
      flow_id: flow.id,
      flow_name: flow.name,
      lead_id: lead?.id || req.body.lead_id || null,
      trigger: req.body.trigger || flow.trigger,
      status: "simulated",
      mode: req.body.mode || "manual_test",
      steps_snapshot: flow.steps || [],
      input: req.body || {},
      result_summary: "Flow run recorded. Execution engine is approval-first/manual until frontend enables automation.",
      executed_by: user.id,
    });
    ensureCrmArray(db, "crm_flow_runs").push(run);
    ensureCrmArray(db, "crm_flow_events").push(withTimestamps({ id: uuid(), flow_id: flow.id, run_id: run.id, lead_id: run.lead_id, event_type: "flow_run_created", message: run.result_summary }));
    await writeCrmDb(db);
    res.json({ success: true, run });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/flows/bootstrap-default", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const existing = ensureCrmArray(db, "crm_flows").find((item) => item.name === "Live Session Conversion Flow" && String(item.brand_id || "") === String(brandId || ""));
    if (existing) return res.json({ success: true, flow: existing, already_exists: true });
    const flow = normalizeCrmFlow({ name: "Live Session Conversion Flow", description: "Move qualified leads from inbound messages into live/demo sessions, post-session follow-up, plan recommendation, and sales handoff." }, null, brandId);
    flow.created_by = user.id;
    ensureCrmArray(db, "crm_flows").push(flow);
    await writeCrmDb(db);
    res.json({ success: true, flow, created: true });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

// Live Session Conversion Settings and Events
app.get("/admin/crm/live-conversion/settings", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    res.json({ success: true, settings: getLiveConversionSettings(db, brandId) });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.put("/admin/crm/live-conversion/settings", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    const records = ensureCrmArray(db, "live_conversion_settings");
    const index = records.findIndex((item) => String(item.brand_id || "") === String(brandId || ""));
    const existing = index >= 0 ? records[index] : getLiveConversionSettings(db, brandId);
    const updated = { ...existing, ...(req.body || {}), id: existing.id || `live_conversion_${brandId || "global"}`, brand_id: brandId, updated_at: nowIso(), created_at: existing.created_at || nowIso() };
    if (index >= 0) records[index] = updated; else records.push(updated);
    await writeCrmDb(db);
    res.json({ success: true, settings: updated });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.get("/admin/crm/live-conversion/eligible-sessions", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const liveDb = await readLiveDb();
    const crmDb = await readCrmDb();
    const brandId = getCrmBrandId(req, crmDb);
    const settings = getLiveConversionSettings(crmDb, brandId);
    const now = Date.now();
    const windowBefore = Number(settings.link_send_window_minutes_before || 120) * 60000;
    const windowAfter = Number(settings.link_send_window_minutes_after_start || 30) * 60000;
    let sessions = Object.values(liveDb.liveSessions || {}).map(sanitizeLiveSession).filter((s) => s.status !== "cancelled" && s.status !== "completed");
    if (req.query.course_id) sessions = sessions.filter((s) => String(s.course_id) === String(req.query.course_id));
    sessions = sessions.map((session) => {
      const start = getSessionStartUtc(session.scheduled_date, session.scheduled_time, session.scheduled_timezone || DEFAULT_TIMEZONE);
      const eligible_now = start ? now >= start.getTime() - windowBefore && now <= start.getTime() + windowAfter : false;
      return { ...session, start_utc: start ? start.toISOString() : null, eligible_now, join_link_available: Boolean(session.zoom_meeting_url || session.zoom_join_url || session.zoom_meeting_id) };
    }).sort((a, b) => String(a.start_utc || "").localeCompare(String(b.start_utc || "")));
    res.json({ success: true, settings, count: sessions.length, sessions });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/live-conversion/invite", async (req, res) => {
  try {
    const { user } = await requireCrmAdmin(req);
    const crmDb = await readCrmDb();
    const liveDb = await readLiveDb();
    const brandId = getCrmBrandId(req, crmDb);
    const lead = getLeadByAnyId(crmDb, req.body.lead_id);
    if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });
    const session = liveDb.liveSessions[String(req.body.session_id)] || null;
    if (!session) return res.status(404).json({ success: false, error: "Live session not found" });
    const settings = getLiveConversionSettings(crmDb, brandId);
    const existingInvites = ensureCrmArray(crmDb, "live_session_invites").filter((item) => String(item.lead_id) === String(lead.id));
    if (existingInvites.length >= Number(settings.max_session_invites_per_lead || 3)) {
      return res.status(400).json({ success: false, error: "Max session invites reached for this lead" });
    }
    const link = session.zoom_meeting_url || req.body.session_link || "";
    const message = String(req.body.message || settings.message_templates?.upcoming || "").replace("{{session_link}}", link).replace("{{session_time}}", `${session.scheduled_date || ""} ${session.scheduled_time || ""}`.trim());
    const invite = withTimestamps({
      id: uuid(), brand_id: brandId, lead_id: lead.id, session_id: session.id, course_id: session.course_id || null,
      session_topic: session.topic || session.title || "Live Session", session_link: link, message,
      status: settings.approval_required ? "needs_approval" : "ready_to_send", approval_required: Boolean(settings.approval_required), created_by: user.id,
    });
    ensureCrmArray(crmDb, "live_session_invites").push(invite);
    ensureCrmArray(crmDb, "live_conversion_events").push(withTimestamps({ id: uuid(), brand_id: brandId, lead_id: lead.id, session_id: session.id, event_type: "session_invite_created", message }));
    if (settings.approval_required) {
      ensureCrmArray(crmDb, "approval_queue").push(withTimestamps({ id: uuid(), brand_id: brandId, action_id: invite.id, action_type: "live_session_invite", channel: normalizeLeadSourcePlatform(lead), lead_id: lead.id, draft_content: message, status: "pending" }));
    }
    lead.status = "live_session_link_sent";
    lead.lead_status = lead.status;
    lead.last_live_session_invite_id = invite.id;
    lead.updated_at = nowIso();
    await writeCrmDb(crmDb);
    res.json({ success: true, invite, lead: normalizeLeadForResponse(lead) });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/live-conversion/events", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const event = withTimestamps({ id: uuid(), brand_id: getCrmBrandId(req, db), ...(req.body || {}) });
    ensureCrmArray(db, "live_conversion_events").push(event);
    const lead = req.body.lead_id ? getLeadByAnyId(db, req.body.lead_id) : null;
    if (lead && req.body.lead_status) { lead.status = req.body.lead_status; lead.lead_status = req.body.lead_status; lead.updated_at = nowIso(); }
    await writeCrmDb(db);
    res.json({ success: true, event, lead: lead ? normalizeLeadForResponse(lead) : null });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.get("/admin/crm/live-conversion/events", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const brandId = getCrmBrandId(req, db);
    let events = filterCrmRecords(req, ensureCrmArray(db, "live_conversion_events"), brandId);
    if (req.query.lead_id) events = events.filter((e) => String(e.lead_id) === String(req.query.lead_id));
    res.json({ success: true, events, count: events.length });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

// Follow-up Jobs execution structure
app.get("/admin/crm/followup-jobs", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const brandId = getCrmBrandId(req, db); const jobs = filterCrmRecords(req, ensureCrmArray(db, "scheduled_followup_jobs"), brandId); res.json({ success: true, jobs, count: jobs.length }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/followup-jobs", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const brandId = getCrmBrandId(req, db); const job = withTimestamps({ id: uuid(), brand_id: brandId, status: "scheduled", approval_required: true, ...(req.body || {}) }); ensureCrmArray(db, "scheduled_followup_jobs").push(job); await writeCrmDb(db); res.json({ success: true, job }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/followup-jobs/:id/execute", async (req, res) => {
  try { const { user } = await requireCrmAdmin(req); const db = await readCrmDb(); const job = ensureCrmArray(db, "scheduled_followup_jobs").find((j) => String(j.id) === String(req.params.id)); if (!job) return res.status(404).json({ success: false, error: "Follow-up job not found" }); job.status = req.body.status || "executed"; job.executed_at = nowIso(); job.executed_by = user.id; job.updated_at = nowIso(); const execution = withTimestamps({ id: uuid(), job_id: job.id, brand_id: job.brand_id || null, lead_id: job.lead_id || null, status: job.status, result: req.body.result || "Manual execution recorded" }); ensureCrmArray(db, "followup_executions").push(execution); await writeCrmDb(db); res.json({ success: true, job, execution }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

// Community Intelligence
app.get("/admin/crm/community-intelligence/settings", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const brandId = getCrmBrandId(req, db); res.json({ success: true, settings: getCommunityIntelligenceSettings(db, brandId) }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.put("/admin/crm/community-intelligence/settings", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const brandId = getCrmBrandId(req, db); const records = ensureCrmArray(db, "community_intelligence_settings"); const index = records.findIndex((i) => String(i.brand_id || "") === String(brandId || "")); const existing = index >= 0 ? records[index] : defaultCommunityIntelligenceSettings(brandId); const updated = { ...existing, ...(req.body || {}), id: existing.id || `community_intelligence_${brandId || "global"}`, brand_id: brandId, updated_at: nowIso(), created_at: existing.created_at || nowIso() }; if (index >= 0) records[index] = updated; else records.push(updated); await writeCrmDb(db); res.json({ success: true, settings: updated }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

for (const [route, collection, responseKey] of [
  ["/admin/crm/community-intelligence/tasks", "community_intelligence_tasks", "tasks"],
  ["/admin/crm/community-intelligence/opportunities", "community_opportunities", "opportunities"],
  ["/admin/crm/community-intelligence/reply-drafts", "community_reply_drafts", "drafts"],
  ["/admin/crm/community-intelligence/watch-keywords", "community_watch_keywords", "keywords"],
  ["/admin/crm/community-intelligence/rules", "community_rules", "rules"],
]) {
  app.get(route, async (req, res) => {
    try { await requireCrmAdmin(req); const db = await readCrmDb(); const brandId = getCrmBrandId(req, db); const records = filterCrmRecords(req, ensureCrmArray(db, collection), brandId); res.json({ success: true, [responseKey]: records, count: records.length }); }
    catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
  });
  app.post(route, async (req, res) => {
    try { await requireCrmAdmin(req); const db = await readCrmDb(); const brandId = getCrmBrandId(req, db); const record = withTimestamps({ id: uuid(), brand_id: brandId, status: req.body?.status || "draft", approval_required: req.body?.approval_required !== false, mode: req.body?.mode || "manual_first", ...(req.body || {}) }); ensureCrmArray(db, collection).push(record); await writeCrmDb(db); res.json({ success: true, record }); }
    catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
  });
}

app.post("/admin/crm/community-intelligence/opportunities/:id/create-lead", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const opp = ensureCrmArray(db, "community_opportunities").find((item) => String(item.id) === String(req.params.id));
    if (!opp) return res.status(404).json({ success: false, error: "Opportunity not found" });
    const brandId = opp.brand_id || getCrmBrandId(req, db);
    const payload = parseInboundSocialPayload({ platform: opp.platform || req.body.platform || "other", payload: { ...(opp.raw_payload || {}), ...(req.body || {}), text: req.body.message || opp.detected_text || opp.summary || "" }, integration: null });
    const { lead, created } = upsertSocialLead(db, payload.platform || opp.platform || "other", { ...payload, brand_id: brandId, source_community_id: opp.community_id || null, source_opportunity_id: opp.id });
    opp.lead_id = lead.id;
    opp.status = "lead_created";
    opp.updated_at = nowIso();
    await writeCrmDb(db);
    res.json({ success: true, lead: normalizeLeadForResponse(lead), opportunity: opp, created });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

// Team / Role Portal
app.get("/admin/crm/roles", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const roles = ensureCrmArray(db, "roles"); res.json({ success: true, roles, default_permission_sets: DEFAULT_ROLE_PERMISSION_SETS, count: roles.length }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/roles", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const roleKey = normalizeCrmLower(req.body.role_key || req.body.name || "custom_role").replace(/[^a-z0-9]+/g, "_"); const role = withTimestamps({ id: uuid(), role_key: roleKey, name: req.body.name || roleKey, description: req.body.description || "", permissions: Array.isArray(req.body.permissions) ? req.body.permissions : (DEFAULT_ROLE_PERMISSION_SETS[roleKey] || []), dashboard_modules: Array.isArray(req.body.dashboard_modules) ? req.body.dashboard_modules : [], status: req.body.status || "active" }); ensureCrmArray(db, "roles").push(role); await writeCrmDb(db); res.json({ success: true, role }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.put("/admin/crm/roles/:id", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const roles = ensureCrmArray(db, "roles"); const idx = roles.findIndex((r) => String(r.id) === String(req.params.id)); if (idx < 0) return res.status(404).json({ success: false, error: "Role not found" }); roles[idx] = { ...roles[idx], ...(req.body || {}), updated_at: nowIso() }; await writeCrmDb(db); res.json({ success: true, role: roles[idx] }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.get("/admin/crm/team-members", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); let members = filterCrmRecords(req, ensureCrmArray(db, "team_members"), null); members = members.map((m) => ({ ...m, stats: getTeamMemberStats(db, m.id) })); res.json({ success: true, members, count: members.length }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/team-members", async (req, res) => {
  try { const { user } = await requireCrmAdmin(req); const db = await readCrmDb(); const member = withTimestamps({ id: uuid(), user_id: req.body.user_id || null, name: req.body.name || req.body.full_name || "Team Member", email: normalizeEmail(req.body.email || ""), role_id: req.body.role_id || null, role_name: req.body.role_name || req.body.role || "Team Member", status: req.body.status || "active", permissions: Array.isArray(req.body.permissions) ? req.body.permissions : [], allowed_modules: Array.isArray(req.body.allowed_modules) ? req.body.allowed_modules : [], referral_code: normalizeCrmString(req.body.referral_code || "").toUpperCase(), commission_rule_id: req.body.commission_rule_id || null, created_by: user.id }); ensureCrmArray(db, "team_members").push(member); logTeamActivity(db, { team_member_id: member.id, action: "create_team_member", message: "Team member created", metadata: { created_by: user.id } }); await writeCrmDb(db); res.json({ success: true, member }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.get("/admin/crm/team-members/:id", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const member = ensureCrmArray(db, "team_members").find((m) => String(m.id) === String(req.params.id)); if (!member) return res.status(404).json({ success: false, error: "Team member not found" }); const stats = getTeamMemberStats(db, member.id); const referrals = ensureCrmArray(db, "referral_attributions").filter((a) => String(a.team_member_id) === String(member.id)); const logs = ensureCrmArray(db, "team_activity_logs").filter((l) => String(l.team_member_id) === String(member.id)).sort(sortNewestFirst).slice(0, 100); res.json({ success: true, member, stats, referrals, logs }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.put("/admin/crm/team-members/:id", async (req, res) => {
  try { const { user } = await requireCrmAdmin(req); const db = await readCrmDb(); const arr = ensureCrmArray(db, "team_members"); const idx = arr.findIndex((m) => String(m.id) === String(req.params.id)); if (idx < 0) return res.status(404).json({ success: false, error: "Team member not found" }); arr[idx] = { ...arr[idx], ...(req.body || {}), updated_at: nowIso(), updated_by: user.id }; logTeamActivity(db, { team_member_id: arr[idx].id, action: "update_team_member", message: "Team member updated", metadata: { updated_by: user.id } }); await writeCrmDb(db); res.json({ success: true, member: arr[idx] }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/team-members/:id/referral-link", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const member = ensureCrmArray(db, "team_members").find((m) => String(m.id) === String(req.params.id)); if (!member) return res.status(404).json({ success: false, error: "Team member not found" }); let code = member.referral_code || normalizeCrmString(req.body.code || member.name || member.id).toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12); if (!code) code = `REF${Date.now()}`; member.referral_code = code; let ref = findReferralCode(db, code); if (!ref) { ref = withTimestamps({ id: uuid(), team_member_id: member.id, code, status: "active", commission_rule_id: member.commission_rule_id || null, created_from: "team_member" }); ensureCrmArray(db, "referral_codes").push(ref); } const baseUrl = req.body.base_url || "https://live.nextgenusmlelms.com"; await writeCrmDb(db); res.json({ success: true, code, referral_code: ref, referral_link: `${String(baseUrl).replace(/\/$/, "")}/?ref=${encodeURIComponent(code)}` }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.get("/admin/crm/team-members/:id/dashboard", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const member = ensureCrmArray(db, "team_members").find((m) => String(m.id) === String(req.params.id)); if (!member) return res.status(404).json({ success: false, error: "Team member not found" }); const stats = getTeamMemberStats(db, member.id); const assignedLeads = ensureCrmArray(db, "leads").filter((l) => String(l.assigned_agent_id || l.assigned_team_member_id || "") === String(member.id)); const referralAttributions = ensureCrmArray(db, "referral_attributions").filter((a) => String(a.team_member_id) === String(member.id)); res.json({ success: true, member, stats, assigned_leads: assignedLeads.map(normalizeLeadForResponse), referral_attributions: referralAttributions }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

// Referral & Commission Settings
app.get("/admin/crm/referral-codes", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const codes = ensureCrmArray(db, "referral_codes").sort(sortNewestFirst); res.json({ success: true, codes, count: codes.length }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/referral-codes", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const code = normalizeCrmString(req.body.code || "").toUpperCase(); if (!code) return res.status(400).json({ success: false, error: "Referral code is required" }); if (findReferralCode(db, code)) return res.status(400).json({ success: false, error: "Referral code already exists" }); const ref = withTimestamps({ id: uuid(), code, team_member_id: req.body.team_member_id || null, commission_rule_id: req.body.commission_rule_id || null, status: req.body.status || "active", max_uses: req.body.max_uses || null, used_count: 0 }); ensureCrmArray(db, "referral_codes").push(ref); await writeCrmDb(db); res.json({ success: true, referral_code: ref }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.get("/admin/crm/commission-rules", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const rules = ensureCrmArray(db, "commission_rules").sort(sortNewestFirst); res.json({ success: true, rules, count: rules.length }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/commission-rules", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const rule = withTimestamps({ id: uuid(), name: req.body.name || "Commission Rule", commission_type: req.body.commission_type || "percentage", percent: Number(req.body.percent ?? req.body.commission_percent ?? 20), amount_usd: Number(req.body.amount_usd || 0), basis: req.body.basis || "net", plan_id: req.body.plan_id || null, team_member_id: req.body.team_member_id || null, active: req.body.active !== false, payout_requires_approval: req.body.payout_requires_approval !== false, refund_hold_days: Number(req.body.refund_hold_days || 0) }); ensureCrmArray(db, "commission_rules").push(rule); await writeCrmDb(db); res.json({ success: true, rule }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.get("/admin/crm/referral-attributions", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); let attributions = ensureCrmArray(db, "referral_attributions").sort(sortNewestFirst); if (req.query.team_member_id) attributions = attributions.filter((a) => String(a.team_member_id) === String(req.query.team_member_id)); res.json({ success: true, attributions, count: attributions.length }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/referral-attributions", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const code = normalizeCrmString(req.body.referral_code || req.body.code || "").toUpperCase();
    const ref = findReferralCode(db, code);
    const teamMemberId = req.body.team_member_id || ref?.team_member_id || null;
    const rule = ensureCrmArray(db, "commission_rules").find((r) => String(r.id) === String(req.body.commission_rule_id || ref?.commission_rule_id || "")) || ensureCrmArray(db, "commission_rules").find((r) => r.active !== false && (!r.team_member_id || String(r.team_member_id) === String(teamMemberId))) || null;
    const gross = Number(req.body.gross_revenue_usd || req.body.amount_usd || 0);
    const stripeFee = calculateStripeFeeUsd(gross, req.body.stripe_fee_usd);
    const net = Number((gross - stripeFee).toFixed(2));
    const commission = calculateCommission({ grossUsd: gross, netUsd: net, rule });
    const attr = withTimestamps({ id: uuid(), referral_code: code, referral_code_id: ref?.id || null, team_member_id: teamMemberId, lead_id: req.body.lead_id || null, user_id: req.body.user_id || null, payment_id: req.body.payment_id || null, plan_id: req.body.plan_id || null, gross_revenue_usd: gross, stripe_fee_usd: stripeFee, net_revenue_usd: net, commission_rule_id: rule?.id || null, commission_amount_usd: commission, payout_status: "pending", status: "active" });
    ensureCrmArray(db, "referral_attributions").push(attr);
    if (ref) { ref.used_count = Number(ref.used_count || 0) + 1; ref.updated_at = nowIso(); }
    ensureCrmArray(db, "revenue_attribution").push(withTimestamps({ id: uuid(), source: "referral", referral_attribution_id: attr.id, lead_id: attr.lead_id, team_member_id: teamMemberId, gross_revenue_usd: gross, stripe_fee_usd: stripeFee, ai_cost_usd: 0, commission_amount_usd: commission, net_retained_usd: Number((net - commission).toFixed(2)) }));
    await writeCrmDb(db);
    res.json({ success: true, attribution: attr });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.get("/admin/crm/commission-payouts", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); let payouts = ensureCrmArray(db, "commission_payouts").sort(sortNewestFirst); if (req.query.team_member_id) payouts = payouts.filter((p) => String(p.team_member_id) === String(req.query.team_member_id)); res.json({ success: true, payouts, count: payouts.length }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.post("/admin/crm/commission-payouts", async (req, res) => {
  try { const { user } = await requireCrmAdmin(req); const db = await readCrmDb(); const payout = withTimestamps({ id: uuid(), team_member_id: req.body.team_member_id || null, amount_usd: Number(req.body.amount_usd || 0), status: req.body.status || "pending_approval", method: req.body.method || "manual", notes: req.body.notes || "", created_by: user.id }); ensureCrmArray(db, "commission_payouts").push(payout); await writeCrmDb(db); res.json({ success: true, payout }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.patch("/admin/crm/commission-payouts/:id", async (req, res) => {
  try { const { user } = await requireCrmAdmin(req); const db = await readCrmDb(); const p = ensureCrmArray(db, "commission_payouts").find((x) => String(x.id) === String(req.params.id)); if (!p) return res.status(404).json({ success: false, error: "Payout not found" }); Object.assign(p, req.body || {}, { updated_at: nowIso(), updated_by: user.id }); if (p.status === "paid" && !p.paid_at) p.paid_at = nowIso(); await writeCrmDb(db); res.json({ success: true, payout: p }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.get("/admin/crm/revenue/enhanced-summary", async (req, res) => {
  try {
    await requireCrmAdmin(req);
    const db = await readCrmDb();
    const base = calculateCrmAnalytics(db, req);
    const attr = ensureCrmArray(db, "revenue_attribution");
    const referrals = ensureCrmArray(db, "referral_attributions");
    const gross = attr.length ? attr.reduce((s, x) => s + Number(x.gross_revenue_usd || 0), 0) : base.revenue_generated_usd;
    const stripeFees = attr.reduce((s, x) => s + Number(x.stripe_fee_usd || 0), 0) || referrals.reduce((s, x) => s + Number(x.stripe_fee_usd || 0), 0);
    const commissions = attr.reduce((s, x) => s + Number(x.commission_amount_usd || 0), 0) || referrals.reduce((s, x) => s + Number(x.commission_amount_usd || 0), 0);
    const voiceCost = ensureCrmArray(db, "voice_call_logs").reduce((s, x) => s + Number(x.cost_usd || 0), 0);
    const aiCost = Number(base.ai_usage_cost_usd || 0);
    const net = Number((gross - stripeFees - commissions - aiCost - voiceCost).toFixed(2));
    res.json({ success: true, summary: { ...base, gross_revenue_usd: Number(gross.toFixed(2)), stripe_fees_usd: Number(stripeFees.toFixed(2)), commission_amount_usd: Number(commissions.toFixed(2)), ai_cost_usd: aiCost, voice_cost_usd: Number(voiceCost.toFixed(2)), net_retained_usd: net } });
  } catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

// Voice call cost structure for future AI voice integration; live calling is not enabled here.
app.get("/admin/crm/voice-call-settings", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const settings = ensureCrmArray(db, "voice_call_settings")[0] || { id: "voice_settings_global", enabled: false, approval_required: true, max_calls_per_day: 20, max_minutes_per_call: 10, max_daily_cost_usd: 10, allowed_countries: [], created_at: nowIso(), updated_at: nowIso() }; res.json({ success: true, settings }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

app.put("/admin/crm/voice-call-settings", async (req, res) => {
  try { await requireCrmAdmin(req); const db = await readCrmDb(); const arr = ensureCrmArray(db, "voice_call_settings"); const existing = arr[0] || { id: "voice_settings_global", created_at: nowIso() }; const updated = { ...existing, ...(req.body || {}), updated_at: nowIso() }; if (arr.length) arr[0] = updated; else arr.push(updated); await writeCrmDb(db); res.json({ success: true, settings: updated }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, error: error.message }); }
});

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
        agents: ensureCrmArray(db, "agents").length,
        agent_logs: ensureCrmArray(db, "agent_logs").length,
        integrations: ensureCrmArray(db, "integrations").length,
        integration_logs: ensureCrmArray(db, "integration_logs").length,
        handoffs: ensureCrmArray(db, "handoffs").length,
        client_data_events: ensureCrmArray(db, "client_data_events").length,
        crm_flows: ensureCrmArray(db, "crm_flows").length,
        crm_flow_runs: ensureCrmArray(db, "crm_flow_runs").length,
        live_conversion_settings: ensureCrmArray(db, "live_conversion_settings").length,
        live_session_invites: ensureCrmArray(db, "live_session_invites").length,
        scheduled_followup_jobs: ensureCrmArray(db, "scheduled_followup_jobs").length,
        community_intelligence_tasks: ensureCrmArray(db, "community_intelligence_tasks").length,
        community_opportunities: ensureCrmArray(db, "community_opportunities").length,
        team_members: ensureCrmArray(db, "team_members").length,
        roles: ensureCrmArray(db, "roles").length,
        referral_codes: ensureCrmArray(db, "referral_codes").length,
        referral_attributions: ensureCrmArray(db, "referral_attributions").length,
        commission_rules: ensureCrmArray(db, "commission_rules").length,
        commission_payouts: ensureCrmArray(db, "commission_payouts").length,
        revenue_attribution: ensureCrmArray(db, "revenue_attribution").length,
        dashboard_settings: ensureCrmArray(db, "dashboard_settings").length,
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
