import crypto from "node:crypto";

export const AYLA_PILOT_LOGIN_BUILD = "v262-pilot-one-time-access";
export const AYLA_PILOT_LOGIN_DEFAULT_TTL_SECONDS = 10 * 60;
export const AYLA_PILOT_LOGIN_MAX_TTL_SECONDS = 15 * 60;

function clean(value = "", max = 240) {
  return String(value || "").trim().slice(0, max);
}

function pilotLoginError(message, statusCode = 400, code = "PILOT_LOGIN_INVALID") {
  return Object.assign(new Error(message), { statusCode, code });
}

export function isAylaPilotLoginIdentity(user = {}, student = {}) {
  const email = clean(user.email, 320).toLowerCase();
  const userId = clean(user.id, 180);
  const ownerId = clean(
    student.ayla_user_id
      || student.aylaUserId
      || student.user_id
      || student.userId,
    180,
  );
  const activeUser = !["disabled", "deleted"].includes(clean(user.status, 40).toLowerCase());
  const activeStudent = !["disabled", "deleted"].includes(clean(student.status, 40).toLowerCase());
  const studentRole = clean(user.role, 40).toLowerCase() === "student";
  const explicitPilot = (user.pilotTest === true || user.pilot_test === true)
    && (student.pilotTest === true || student.pilot_test === true);
  return Boolean(
    activeUser
      && activeStudent
      && studentRole
      && explicitPilot
      && userId
      && ownerId === userId
      && email.endsWith("@pilot.aylamed.local"),
  );
}

export function hashAylaPilotLoginToken(token = "") {
  const cleanToken = clean(token, 300);
  if (cleanToken.length < 40) {
    throw pilotLoginError(
      "Invalid or expired pilot access link",
      401,
      "PILOT_LOGIN_INVALID",
    );
  }
  return crypto.createHash("sha256").update(cleanToken, "utf8").digest("hex");
}

export function createAylaPilotLoginGrant({
  user,
  student,
  createdBy = "aylamed-admin",
  ttlSeconds = AYLA_PILOT_LOGIN_DEFAULT_TTL_SECONDS,
  now = new Date(),
  randomBytes = crypto.randomBytes,
  idFactory = crypto.randomUUID,
} = {}) {
  if (!isAylaPilotLoginIdentity(user, student)) {
    throw pilotLoginError(
      "One-time pilot access is restricted to private @pilot.aylamed.local accounts",
      409,
      "PILOT_LOGIN_ACCOUNT_REQUIRED",
    );
  }
  const createdAt = new Date(now);
  if (!Number.isFinite(createdAt.getTime())) {
    throw pilotLoginError("A valid pilot-link creation time is required");
  }
  const boundedTtl = Math.max(
    60,
    Math.min(
      AYLA_PILOT_LOGIN_MAX_TTL_SECONDS,
      Math.trunc(Number(ttlSeconds) || AYLA_PILOT_LOGIN_DEFAULT_TTL_SECONDS),
    ),
  );
  const token = randomBytes(32).toString("base64url");
  const grant = {
    id: idFactory(),
    tokenHash: hashAylaPilotLoginToken(token),
    userId: clean(user.id, 180),
    studentId: clean(student.id, 180),
    status: "unused",
    createdBy: clean(createdBy, 180) || "aylamed-admin",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + boundedTtl * 1000).toISOString(),
    usedAt: null,
    ttlSeconds: boundedTtl,
    singleUse: true,
  };
  return { grant, token };
}

function hashesEqual(left = "", right = "") {
  const first = Buffer.from(String(left), "hex");
  const second = Buffer.from(String(right), "hex");
  return first.length === 32
    && second.length === 32
    && crypto.timingSafeEqual(first, second);
}

export function consumeAylaPilotLoginGrant({
  grants = [],
  token = "",
  usersById = {},
  studentsById = {},
  now = new Date(),
} = {}) {
  const tokenHash = hashAylaPilotLoginToken(token);
  const consumedAt = new Date(now);
  if (!Number.isFinite(consumedAt.getTime())) {
    throw pilotLoginError("Invalid or expired pilot access link", 401);
  }
  const grant = (Array.isArray(grants) ? grants : Object.values(grants || {}))
    .find((row) => hashesEqual(row?.tokenHash, tokenHash));
  const genericFailure = () => {
    throw pilotLoginError(
      "Invalid or expired pilot access link",
      401,
      "PILOT_LOGIN_INVALID",
    );
  };
  if (!grant || grant.status !== "unused" || grant.usedAt) genericFailure();
  if (new Date(grant.expiresAt || "").getTime() <= consumedAt.getTime()) genericFailure();
  const user = usersById?.[String(grant.userId)] || null;
  const student = studentsById?.[String(grant.studentId)] || null;
  if (!isAylaPilotLoginIdentity(user, student)) genericFailure();
  return {
    user,
    student,
    grant: {
      ...grant,
      status: "used",
      usedAt: consumedAt.toISOString(),
    },
  };
}

export function aylaPilotLoginFragmentPath(token = "") {
  const cleanToken = clean(token, 300);
  if (!cleanToken) throw pilotLoginError("Pilot access token is required");
  return `/pilot-access#token=${encodeURIComponent(cleanToken)}`;
}
