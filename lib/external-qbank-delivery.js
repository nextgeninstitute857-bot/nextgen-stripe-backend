import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import {
  normalizeAylaQbankExamTrack,
  normalizeAylaQbankFilters,
  normalizeAylaQbankMode,
  sanitizeAylaQbankQuestion,
} from "./aylamed-qbank.js";

export const EXTERNAL_QBANK_API_VERSION = "v1";
export const EXTERNAL_QBANK_SCOPES = Object.freeze([
  "catalog:read",
  "sessions:read",
  "sessions:write",
  "answers:write",
]);

const EXTERNAL_QBANK_ISSUER = "nextgen-content-registry";
const EXTERNAL_QBANK_AUDIENCE = "nextgen-external-qbank";
const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,79}$/;

function deliveryError(message, statusCode = 400, code = "EXTERNAL_QBANK_INVALID_REQUEST") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function cleanString(value = "", max = 200) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function cleanOrigin(value = "") {
  const clean = cleanString(value, 500).replace(/\/$/, "");
  if (!clean || clean.includes("*")) return null;
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function cleanScopes(value, fallback = EXTERNAL_QBANK_SCOPES) {
  const rows = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : fallback;
  return [...new Set(rows.map((scope) => cleanString(scope, 80).toLowerCase()).filter((scope) => EXTERNAL_QBANK_SCOPES.includes(scope)))];
}

function requestedScopeRows(value, fallback = EXTERNAL_QBANK_SCOPES) {
  const rows = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : fallback;
  return [...new Set(rows.map((scope) => cleanString(scope, 80).toLowerCase()).filter(Boolean))];
}

function secretDigest(secret) {
  return crypto.createHash("sha256").update(String(secret || ""), "utf8").digest();
}

const DUMMY_CLIENT_SECRET_DIGEST = secretDigest("external-qbank-invalid-client-secret-digest");

function safeDigestEqual(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : secretDigest(left);
  const rightBuffer = Buffer.isBuffer(right) ? right : secretDigest(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function signingSecret(source = process.env) {
  const secret = String(source?.NEXTGEN_EXTERNAL_QBANK_TOKEN_SECRET || "").trim();
  if (secret.length < 32) {
    throw deliveryError("External QBank token signing is not configured", 503, "EXTERNAL_QBANK_SIGNING_NOT_CONFIGURED");
  }
  return secret;
}

function hmacReference(value, namespace, source = process.env) {
  return crypto.createHmac("sha256", signingSecret(source))
    .update(`${namespace}\u0000${cleanString(value, 500)}`, "utf8")
    .digest("hex");
}

function normalizeClient(row, index) {
  const clientId = cleanString(row?.client_id || row?.clientId, 80).toLowerCase();
  if (!CLIENT_ID_PATTERN.test(clientId)) throw new Error(`client at index ${index} has an invalid client_id`);
  const rawSecrets = [
    ...(Array.isArray(row?.client_secrets) ? row.client_secrets : []),
    row?.client_secret,
  ].map((secret) => String(secret || "").trim()).filter(Boolean);
  if (!rawSecrets.length || rawSecrets.some((secret) => secret.length < 24)) {
    throw new Error(`${clientId} requires at least one client secret of 24 or more characters`);
  }
  const rawExamTracks = (Array.isArray(row?.exam_tracks) ? row.exam_tracks : [row?.exam_track])
    .map((value) => cleanString(value, 120)).filter(Boolean);
  const normalizedExamTracks = rawExamTracks.map(normalizeAylaQbankExamTrack);
  if (normalizedExamTracks.some((value) => !value)) throw new Error(`${clientId} contains an unsupported exam track`);
  const examTracks = [...new Set(normalizedExamTracks)];
  if (!examTracks.length) throw new Error(`${clientId} requires at least one supported exam track`);
  const rawOrigins = Array.isArray(row?.allowed_origins) ? row.allowed_origins : [];
  const normalizedOrigins = rawOrigins.map(cleanOrigin);
  if (normalizedOrigins.some((value) => !value)) throw new Error(`${clientId} contains an invalid allowed origin; use exact HTTPS origins only`);
  const origins = [...new Set(normalizedOrigins)];
  if (!origins.length) throw new Error(`${clientId} requires at least one exact HTTPS allowed origin`);
  const configuredScopes = requestedScopeRows(row?.scopes);
  if (configuredScopes.some((scope) => !EXTERNAL_QBANK_SCOPES.includes(scope))) throw new Error(`${clientId} contains an unsupported scope`);
  const scopes = cleanScopes(configuredScopes);
  if (!scopes.length) throw new Error(`${clientId} requires at least one supported scope`);
  const destinationScope = cleanString(row?.destination_scope || clientId, 120).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(destinationScope)) throw new Error(`${clientId} has an invalid destination_scope`);
  return {
    id: clientId,
    name: cleanString(row?.name || clientId, 160),
    active: row?.active !== false,
    allowedOrigins: origins,
    examTracks,
    scopes,
    destinationScope,
    canIssueEntitlements: row?.can_issue_entitlements === true,
    tokenVersion: Math.max(1, Math.min(1_000_000, Math.trunc(Number(row?.token_version || 1) || 1))),
    tokenTtlSeconds: Math.max(60, Math.min(3_600, Math.trunc(Number(row?.token_ttl_seconds || 900) || 900))),
    entitlementMaxDays: Math.max(1, Math.min(366, Math.trunc(Number(row?.entitlement_max_days || 366) || 366))),
    maxSessionQuestions: Math.max(1, Math.min(100, Math.trunc(Number(row?.max_session_questions || 100) || 100))),
    secretDigests: rawSecrets.map(secretDigest),
  };
}

export function loadExternalQbankClients(source = process.env) {
  const raw = String(source?.NEXTGEN_EXTERNAL_QBANK_CLIENTS_JSON || "").trim();
  if (!raw) return { clients: [], errors: [] };
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { clients: [], errors: [{ client_id: null, error: "NEXTGEN_EXTERNAL_QBANK_CLIENTS_JSON is invalid JSON" }] }; }
  if (!Array.isArray(parsed)) return { clients: [], errors: [{ client_id: null, error: "External QBank client configuration must be an array" }] };
  const clients = [];
  const errors = [];
  const ids = new Set();
  parsed.forEach((row, index) => {
    try {
      const client = normalizeClient(row, index);
      if (ids.has(client.id)) throw new Error(`duplicate client_id ${client.id}`);
      ids.add(client.id);
      clients.push(client);
    } catch (error) {
      errors.push({ client_id: cleanString(row?.client_id || row?.clientId, 80) || null, error: error.message });
    }
  });
  return { clients, errors };
}

export function publicExternalQbankClient(client = {}) {
  return {
    client_id: client.id,
    name: client.name,
    active: client.active === true,
    allowed_origins: [...(client.allowedOrigins || [])],
    exam_tracks: [...(client.examTracks || [])],
    scopes: [...(client.scopes || [])],
    destination_scope: client.destinationScope || null,
    can_issue_entitlements: client.canIssueEntitlements === true,
    token_version: client.tokenVersion || 1,
    token_ttl_seconds: client.tokenTtlSeconds || null,
    max_session_questions: client.maxSessionQuestions || null,
  };
}

export function externalQbankConfigStatus(source = process.env) {
  const config = loadExternalQbankClients(source);
  let signingConfigured = true;
  try { signingSecret(source); } catch { signingConfigured = false; }
  return {
    configured: signingConfigured && config.clients.some((client) => client.active),
    signing_configured: signingConfigured,
    active_clients: config.clients.filter((client) => client.active).length,
    invalid_clients: config.errors.length,
    errors: config.errors,
    clients: config.clients.map(publicExternalQbankClient),
    api_version: EXTERNAL_QBANK_API_VERSION,
    content_destination: "external_qbank",
    database_copy_required: false,
  };
}

export function externalQbankAllowedOrigins(source = process.env) {
  return [...new Set(loadExternalQbankClients(source).clients
    .filter((client) => client.active)
    .flatMap((client) => client.allowedOrigins))];
}

export function externalQbankOriginAllowed(origin, client = null, source = process.env) {
  const clean = cleanOrigin(origin);
  if (!clean) return false;
  if (client) return client.active === true && client.allowedOrigins?.includes(clean);
  return externalQbankAllowedOrigins(source).includes(clean);
}

export function authenticateExternalQbankClient(authorization = "", source = process.env) {
  const match = String(authorization || "").match(/^Basic\s+(.+)$/i);
  if (!match) throw deliveryError("HTTP Basic client authentication is required", 401, "EXTERNAL_QBANK_CLIENT_AUTH_REQUIRED");
  let decoded = "";
  try { decoded = Buffer.from(match[1], "base64").toString("utf8"); } catch {}
  const separator = decoded.indexOf(":");
  if (separator < 1) throw deliveryError("External QBank client credentials are invalid", 401, "EXTERNAL_QBANK_CLIENT_AUTH_INVALID");
  const clientId = cleanString(decoded.slice(0, separator), 80).toLowerCase();
  const supplied = decoded.slice(separator + 1);
  const client = loadExternalQbankClients(source).clients.find((row) => row.id === clientId && row.active);
  const suppliedDigest = secretDigest(supplied);
  const candidateDigests = client?.secretDigests?.length ? client.secretDigests : [DUMMY_CLIENT_SECRET_DIGEST];
  let digestMatched = false;
  for (const digest of candidateDigests) digestMatched = safeDigestEqual(digest, suppliedDigest) || digestMatched;
  const valid = Boolean(client && digestMatched);
  if (!valid) throw deliveryError("External QBank client credentials are invalid", 401, "EXTERNAL_QBANK_CLIENT_AUTH_INVALID");
  return client;
}

export function issueExternalQbankEntitlementToken({
  client,
  externalSubject,
  examTrack,
  entitlementReference,
  entitlementExpiresAt,
  requestedScopes,
  now = new Date(),
} = {}, source = process.env) {
  if (!client?.id || client.active !== true || client.canIssueEntitlements !== true) {
    throw deliveryError("This client cannot issue QBank entitlements", 403, "EXTERNAL_QBANK_ENTITLEMENT_ISSUER_DENIED");
  }
  const subject = cleanString(externalSubject, 300);
  const entitlement = cleanString(entitlementReference, 300);
  if (!subject || !entitlement) throw deliveryError("external_subject and entitlement_reference are required");
  const normalizedExam = normalizeAylaQbankExamTrack(examTrack);
  if (!normalizedExam || !client.examTracks.includes(normalizedExam)) {
    throw deliveryError("The requested exam track is not allowed for this client", 403, "EXTERNAL_QBANK_EXAM_DENIED");
  }
  const nowDate = now instanceof Date ? now : new Date(now);
  const entitlementExpiry = new Date(entitlementExpiresAt);
  const maximumExpiry = nowDate.getTime() + client.entitlementMaxDays * 86400000;
  if (!Number.isFinite(entitlementExpiry.getTime()) || entitlementExpiry.getTime() <= nowDate.getTime()) {
    throw deliveryError("entitlement_expires_at must be in the future", 403, "EXTERNAL_QBANK_ENTITLEMENT_EXPIRED");
  }
  if (entitlementExpiry.getTime() > maximumExpiry) {
    throw deliveryError("entitlement_expires_at exceeds this client's allowed entitlement window", 403, "EXTERNAL_QBANK_ENTITLEMENT_WINDOW_EXCEEDED");
  }
  const requested = requestedScopes == null ? [...client.scopes] : requestedScopeRows(requestedScopes, []);
  const scopes = cleanScopes(requested, []);
  if (!scopes.length || scopes.length !== requested.length || scopes.some((scope) => !client.scopes.includes(scope))) {
    throw deliveryError("Requested scopes are not allowed for this client", 403, "EXTERNAL_QBANK_SCOPE_DENIED");
  }
  const ttlSeconds = Math.max(1, Math.min(client.tokenTtlSeconds, Math.floor((entitlementExpiry.getTime() - nowDate.getTime()) / 1000)));
  const subjectHash = hmacReference(subject, `subject:${client.id}`, source);
  const entitlementHash = hmacReference(entitlement, `entitlement:${client.id}`, source);
  const token = jwt.sign({
    purpose: "external_qbank_entitlement",
    client_id: client.id,
    exam_track: normalizedExam,
    scopes,
    token_version: client.tokenVersion,
    subject_hash: subjectHash,
    entitlement_hash: entitlementHash,
    entitlement_expires_at: entitlementExpiry.toISOString(),
  }, signingSecret(source), {
    algorithm: "HS256",
    issuer: EXTERNAL_QBANK_ISSUER,
    audience: EXTERNAL_QBANK_AUDIENCE,
    subject: subjectHash,
    jwtid: crypto.randomUUID(),
    expiresIn: ttlSeconds,
  });
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: ttlSeconds,
    exam_track: normalizedExam,
    scopes,
    subject_ref: subjectHash.slice(0, 20),
    entitlement_expires_at: entitlementExpiry.toISOString(),
  };
}

export function verifyExternalQbankEntitlementToken(token, { requiredScope = "", origin = "" } = {}, source = process.env) {
  let claims;
  try {
    claims = jwt.verify(String(token || ""), signingSecret(source), {
      algorithms: ["HS256"],
      issuer: EXTERNAL_QBANK_ISSUER,
      audience: EXTERNAL_QBANK_AUDIENCE,
    });
  } catch (error) {
    if (error?.code === "EXTERNAL_QBANK_SIGNING_NOT_CONFIGURED") throw error;
    throw deliveryError("External QBank entitlement token is invalid or expired", 401, "EXTERNAL_QBANK_TOKEN_INVALID");
  }
  if (claims?.purpose !== "external_qbank_entitlement") {
    throw deliveryError("External QBank token purpose is invalid", 401, "EXTERNAL_QBANK_TOKEN_INVALID");
  }
  const client = loadExternalQbankClients(source).clients.find((row) => row.id === claims.client_id && row.active);
  if (!client || Number(claims.token_version) !== Number(client.tokenVersion)) {
    throw deliveryError("External QBank entitlement has been revoked", 401, "EXTERNAL_QBANK_TOKEN_REVOKED");
  }
  if (!client.examTracks.includes(String(claims.exam_track || ""))) {
    throw deliveryError("External QBank exam scope is no longer allowed", 403, "EXTERNAL_QBANK_EXAM_DENIED");
  }
  if (!/^[0-9a-f]{64}$/.test(String(claims.subject_hash || ""))
    || !/^[0-9a-f]{64}$/.test(String(claims.entitlement_hash || ""))
    || String(claims.sub || "") !== String(claims.subject_hash || "")) {
    throw deliveryError("External QBank token identity is invalid", 401, "EXTERNAL_QBANK_TOKEN_INVALID");
  }
  const claimedScopes = requestedScopeRows(claims.scopes, []);
  const scopes = cleanScopes(claimedScopes, []);
  if (!scopes.length || scopes.length !== claimedScopes.length || scopes.some((scope) => !client.scopes.includes(scope))) {
    throw deliveryError("External QBank entitlement scopes have been revoked", 401, "EXTERNAL_QBANK_TOKEN_REVOKED");
  }
  if (requiredScope && (!scopes.includes(requiredScope) || !client.scopes.includes(requiredScope))) {
    throw deliveryError("External QBank token does not include the required scope", 403, "EXTERNAL_QBANK_SCOPE_DENIED");
  }
  if (origin && !externalQbankOriginAllowed(origin, client, source)) {
    throw deliveryError("This website origin is not allowed for the external QBank client", 403, "EXTERNAL_QBANK_ORIGIN_DENIED");
  }
  const entitlementExpiry = new Date(claims.entitlement_expires_at).getTime();
  if (!Number.isFinite(entitlementExpiry) || entitlementExpiry <= Date.now()) {
    throw deliveryError("External QBank entitlement is no longer active", 403, "EXTERNAL_QBANK_ENTITLEMENT_EXPIRED");
  }
  return { claims: { ...claims, scopes }, client };
}

export function normalizeExternalQbankSessionRequest(input = {}, client = {}) {
  const count = Number(input.question_count ?? input.questionCount ?? 40);
  if (!Number.isInteger(count) || count < 1 || count > Number(client.maxSessionQuestions || 100)) {
    throw deliveryError(`question_count must be an integer between 1 and ${client.maxSessionQuestions || 100}`);
  }
  const mode = normalizeAylaQbankMode(input.mode || "tutor");
  const blockSize = Math.max(1, Math.min(40, Math.trunc(Number(input.block_size ?? input.blockSize ?? 40) || 40)));
  const rawTimeLimit = input.time_limit_minutes ?? input.timeLimitMinutes ?? null;
  let timeLimitMinutes = null;
  if (mode === "test" && rawTimeLimit != null && rawTimeLimit !== "") {
    const parsed = Number(rawTimeLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600) {
      throw deliveryError("time_limit_minutes must be an integer between 1 and 600");
    }
    timeLimitMinutes = parsed;
  }
  return {
    questionCount: count,
    blockSize,
    mode,
    filters: normalizeAylaQbankFilters(input.filters || input),
    timeLimitMinutes,
  };
}

export function externalQbankSessionModel(row = {}) {
  const items = Array.isArray(row.items) ? row.items : [];
  const answers = {};
  for (const item of items) {
    if (item.selected_answer_id == null) continue;
    answers[item.question_ref] = {
      questionRef: item.question_ref,
      selectedAnswerId: Number(item.selected_answer_id),
      correct: item.is_correct === true,
      answeredAt: item.answered_at || null,
    };
  }
  return {
    id: row.id,
    userId: row.subject_hash,
    studentId: row.subject_hash,
    examTrack: row.exam_track,
    mode: row.mode,
    status: row.status === "active" ? "in_progress" : row.status,
    filters: row.filters || {},
    questionCount: Number(row.question_count || items.length),
    blockSize: Number(row.block_size || 40),
    timeLimitMinutes: row.time_limit_minutes == null ? null : Number(row.time_limit_minutes),
    questions: items.map((item) => ({ ref: item.question_ref, contentQuestionId: item.question_id })),
    answers,
    marks: {},
    answeredCount: Number(row.answered_count || Object.keys(answers).length),
    correctCount: Number(row.correct_count || 0),
    incorrectCount: Number(row.incorrect_count || 0),
    unansweredCount: Number(row.unanswered_count || 0),
    scorePercent: row.score_percent == null ? null : Number(row.score_percent),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    startedAt: row.started_at || row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || null,
  };
}

export function sanitizeExternalQbankSession(row = {}) {
  const model = externalQbankSessionModel(row);
  const blocks = [];
  for (let index = 0; index < model.questions.length; index += model.blockSize) {
    blocks.push({
      index: blocks.length,
      question_refs: model.questions.slice(index, index + model.blockSize).map((item) => item.ref),
    });
  }
  const submitted = model.status === "submitted";
  return {
    id: model.id,
    exam_track: model.examTrack,
    mode: model.mode,
    status: model.status,
    filters: model.filters,
    question_count: model.questionCount,
    questions: (row.items || []).map((item) => ({
      question_ref: item.question_ref,
      position: Number(item.position),
      answered: item.selected_answer_id != null,
    })),
    blocks,
    block_size: model.blockSize,
    time_limit_minutes: model.timeLimitMinutes,
    answered_count: model.answeredCount,
    correct_count: submitted ? model.correctCount : null,
    incorrect_count: submitted ? model.incorrectCount : null,
    unanswered_count: submitted ? model.unansweredCount : null,
    score_percent: submitted ? model.scorePercent : null,
    duration_ms: submitted ? model.durationMs : null,
    started_at: model.startedAt,
    submitted_at: model.submittedAt,
    updated_at: model.updatedAt,
  };
}

export function sanitizeExternalQbankQuestion(question, sessionRow, item) {
  return sanitizeAylaQbankQuestion(question, {
    session: externalQbankSessionModel(sessionRow),
    questionRef: item.question_ref,
  });
}

export class ExternalQbankRateLimiter {
  constructor({ maxBuckets = 10_000, now = () => Date.now() } = {}) {
    this.maxBuckets = Math.max(100, Number(maxBuckets) || 10_000);
    this.now = now;
    this.buckets = new Map();
  }

  take(key, { limit, windowMs }) {
    const now = this.now();
    const cleanKey = cleanString(key, 300) || "unknown";
    const previous = this.buckets.get(cleanKey);
    const bucket = !previous || now >= previous.resetAt
      ? { count: 0, resetAt: now + windowMs }
      : previous;
    bucket.count += 1;
    this.buckets.set(cleanKey, bucket);
    if (this.buckets.size > this.maxBuckets) {
      for (const [bucketKey, value] of this.buckets) {
        if (now >= value.resetAt) this.buckets.delete(bucketKey);
        if (this.buckets.size <= this.maxBuckets) break;
      }
      while (this.buckets.size > this.maxBuckets) {
        const oldestKey = this.buckets.keys().next().value;
        if (oldestKey === undefined) break;
        this.buckets.delete(oldestKey);
      }
    }
    return {
      allowed: bucket.count <= limit,
      remaining: Math.max(0, limit - bucket.count),
      retry_after_seconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
}
