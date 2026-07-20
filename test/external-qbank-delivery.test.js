import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import jwt from "jsonwebtoken";
import {
  ExternalQbankRateLimiter,
  authenticateExternalQbankClient,
  externalQbankConfigStatus,
  issueExternalQbankEntitlementToken,
  loadExternalQbankClients,
  normalizeExternalQbankSessionRequest,
  sanitizeExternalQbankQuestion,
  sanitizeExternalQbankSession,
  verifyExternalQbankEntitlementToken,
} from "../lib/external-qbank-delivery.js";

const TOKEN_SECRET = "external-qbank-test-signing-secret-that-is-long-enough-123456";
const CLIENT_SECRET = "external-client-secret-that-is-long-enough";

function externalSource(overrides = {}) {
  const client = {
    client_id: "nclex-site",
    client_secret: CLIENT_SECRET,
    name: "NCLEX Practice",
    active: true,
    allowed_origins: ["https://nclex.example.com"],
    exam_tracks: ["nclex"],
    scopes: ["catalog:read", "sessions:read", "sessions:write", "answers:write"],
    destination_scope: "nclex-site",
    can_issue_entitlements: true,
    token_version: 3,
    token_ttl_seconds: 900,
    max_session_questions: 75,
    ...overrides,
  };
  return {
    NEXTGEN_EXTERNAL_QBANK_TOKEN_SECRET: TOKEN_SECRET,
    NEXTGEN_EXTERNAL_QBANK_CLIENTS_JSON: JSON.stringify([client]),
  };
}

function basicAuthorization(clientId = "nclex-site", secret = CLIENT_SECRET) {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
}

function issueToken(source = externalSource(), overrides = {}) {
  const client = authenticateExternalQbankClient(basicAuthorization(), source);
  return issueExternalQbankEntitlementToken({
    client,
    externalSubject: "student-private-identity-123",
    examTrack: "nclex",
    entitlementReference: "subscription-private-reference-456",
    entitlementExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    requestedScopes: ["catalog:read", "sessions:read", "sessions:write", "answers:write"],
    ...overrides,
  }, source);
}

test("v218 client configuration rejects weak secrets and non-exact origins", () => {
  const wildcard = loadExternalQbankClients(externalSource({
    allowed_origins: ["https://nclex.example.com", "https://*.example.com"],
  }));
  assert.equal(wildcard.clients.length, 0);
  assert.match(wildcard.errors[0].error, /exact HTTPS origins/i);

  const insecure = loadExternalQbankClients(externalSource({ allowed_origins: ["http://nclex.example.com"] }));
  assert.equal(insecure.clients.length, 0);
  assert.match(insecure.errors[0].error, /exact HTTPS origins/i);

  const weak = loadExternalQbankClients(externalSource({ client_secret: "too-short" }));
  assert.equal(weak.clients.length, 0);
  assert.match(weak.errors[0].error, /24 or more characters/i);

  const weakSigning = externalQbankConfigStatus({
    ...externalSource(),
    NEXTGEN_EXTERNAL_QBANK_TOKEN_SECRET: "short",
  });
  assert.equal(weakSigning.configured, false);
  assert.equal(weakSigning.signing_configured, false);
});

test("v218 Basic authentication never exposes configured client secrets", () => {
  const source = externalSource();
  const client = authenticateExternalQbankClient(basicAuthorization(), source);
  assert.equal(client.id, "nclex-site");
  assert.equal(Object.hasOwn(client, "clientSecret"), false);
  assert.equal(JSON.stringify(client).includes(CLIENT_SECRET), false);
  assert.throws(
    () => authenticateExternalQbankClient(basicAuthorization("nclex-site", "wrong-secret-value-that-is-long"), source),
    (error) => error.statusCode === 401 && error.code === "EXTERNAL_QBANK_CLIENT_AUTH_INVALID",
  );
});

test("v218 entitlement tokens contain pseudonymous hashes, never raw site identities", () => {
  const source = externalSource();
  const issued = issueToken(source);
  const decoded = jwt.decode(issued.access_token);
  assert.equal(decoded.client_id, "nclex-site");
  assert.equal(decoded.exam_track, "nclex");
  assert.match(decoded.subject_hash, /^[0-9a-f]{64}$/);
  assert.match(decoded.entitlement_hash, /^[0-9a-f]{64}$/);
  assert.equal(decoded.token_version, 3);
  assert.equal(JSON.stringify(decoded).includes("student-private-identity-123"), false);
  assert.equal(JSON.stringify(decoded).includes("subscription-private-reference-456"), false);
  assert.equal(JSON.stringify(issued).includes(decoded.subject_hash), false);
  assert.equal(JSON.stringify(issued).includes(decoded.entitlement_hash), false);
});

test("v218 entitlement verification rechecks exact origin, exam, scope, and token version", () => {
  const source = externalSource();
  const issued = issueToken(source);
  const verified = verifyExternalQbankEntitlementToken(issued.access_token, {
    requiredScope: "sessions:read",
    origin: "https://nclex.example.com",
  }, source);
  assert.equal(verified.client.destinationScope, "nclex-site");
  assert.equal(verified.claims.exam_track, "nclex");

  assert.throws(
    () => verifyExternalQbankEntitlementToken(issued.access_token, { origin: "https://evil.example.com" }, source),
    (error) => error.statusCode === 403 && error.code === "EXTERNAL_QBANK_ORIGIN_DENIED",
  );
  assert.throws(
    () => verifyExternalQbankEntitlementToken(issued.access_token, { requiredScope: "unknown:scope" }, source),
    (error) => error.statusCode === 403 && error.code === "EXTERNAL_QBANK_SCOPE_DENIED",
  );
  const scopeRevokedSource = externalSource({
    scopes: ["catalog:read", "sessions:write", "answers:write"],
  });
  assert.throws(
    () => verifyExternalQbankEntitlementToken(issued.access_token, { requiredScope: "catalog:read" }, scopeRevokedSource),
    (error) => error.statusCode === 401 && error.code === "EXTERNAL_QBANK_TOKEN_REVOKED",
  );
  assert.throws(
    () => issueToken(source, { examTrack: "plab" }),
    (error) => error.statusCode === 403 && error.code === "EXTERNAL_QBANK_EXAM_DENIED",
  );

  const revokedSource = externalSource({ token_version: 4 });
  assert.throws(
    () => verifyExternalQbankEntitlementToken(issued.access_token, {}, revokedSource),
    (error) => error.statusCode === 401 && error.code === "EXTERNAL_QBANK_TOKEN_REVOKED",
  );
});

test("v218 session request validation is bounded and test-only timing is normalized", () => {
  const client = loadExternalQbankClients(externalSource()).clients[0];
  assert.deepEqual(normalizeExternalQbankSessionRequest({
    mode: "test",
    question_count: 50,
    block_size: 20,
    time_limit_minutes: 60,
    filters: { system_key: "Cardiology" },
  }, client), {
    mode: "test",
    questionCount: 50,
    blockSize: 20,
    timeLimitMinutes: 60,
    filters: { system_key: "Cardiology", subsystem_key: "", topic_key: "", subtopic_key: "" },
  });
  assert.equal(normalizeExternalQbankSessionRequest({ mode: "tutor", time_limit_minutes: 30 }, client).timeLimitMinutes, null);
  assert.throws(() => normalizeExternalQbankSessionRequest({ question_count: 76 }, client), /between 1 and 75/);
  assert.throws(() => normalizeExternalQbankSessionRequest({ mode: "test", time_limit_minutes: 601 }, client), /between 1 and 600/);
});

function sessionRow({ mode = "test", status = "active", answered = true } = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    client_id: "nclex-site",
    subject_hash: "private-subject-hash",
    entitlement_hash: "private-entitlement-hash",
    destination_scope: "nclex-site",
    exam_track: "nclex",
    mode,
    status,
    question_count: 1,
    block_size: 40,
    filters: {},
    answered_count: answered ? 1 : 0,
    correct_count: answered ? 1 : 0,
    incorrect_count: 0,
    unanswered_count: answered ? 0 : 1,
    score_percent: answered ? 100 : null,
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:01:00.000Z",
    submitted_at: status === "submitted" ? "2026-01-01T00:01:00.000Z" : null,
    items: [{
      question_ref: "22222222-2222-4222-8222-222222222222",
      question_id: "33333333-3333-4333-8333-333333333333",
      position: 0,
      selected_answer_id: answered ? 2 : null,
      is_correct: answered ? true : null,
      answered_at: answered ? "2026-01-01T00:00:30.000Z" : null,
    }],
  };
}

const question = {
  id: "33333333-3333-4333-8333-333333333333",
  title: "Safe question",
  question_html: "<p>Question?</p>",
  explanation_html: "<p>Server-only explanation</p>",
  correct_answer_id: 2,
  answers: [
    { answer_id: 1, text_html: "Choice A" },
    { answer_id: 2, text_html: "Choice B" },
  ],
  media: [{ id: "image", placement: "explanation", url: "https://private.example/image" }],
  videos: [{ id: "video", placement: "explanation", embed_url: "https://player.vimeo.com/video/123" }],
};

test("v218 correct answers remain server-only until tutor answer or final test submission", () => {
  const testActive = sessionRow({ mode: "test", status: "active", answered: true });
  const hidden = sanitizeExternalQbankQuestion(question, testActive, testActive.items[0]);
  assert.equal(hidden.selected_answer_id, 2);
  assert.equal(hidden.result, null);
  assert.equal(hidden.correct_answer_id, null);
  assert.equal(hidden.explanation_html, null);
  assert.equal(hidden.media.length, 0);
  assert.equal(hidden.videos.length, 0);

  const tutor = sessionRow({ mode: "tutor", status: "active", answered: true });
  const tutorReveal = sanitizeExternalQbankQuestion(question, tutor, tutor.items[0]);
  assert.equal(tutorReveal.result.correct, true);
  assert.equal(tutorReveal.correct_answer_id, 2);
  assert.match(tutorReveal.explanation_html, /Server-only explanation/);

  const submitted = sessionRow({ mode: "test", status: "submitted", answered: true });
  const finalReveal = sanitizeExternalQbankQuestion(question, submitted, submitted.items[0]);
  assert.equal(finalReveal.result.correct, true);
  assert.equal(finalReveal.correct_answer_id, 2);
});

test("v218 public session shape excludes identity hashes and Content Registry IDs", () => {
  const row = sessionRow({ mode: "test", status: "active", answered: true });
  const safe = sanitizeExternalQbankSession(row);
  const serialized = JSON.stringify(safe);
  assert.equal(serialized.includes(row.subject_hash), false);
  assert.equal(serialized.includes(row.entitlement_hash), false);
  assert.equal(serialized.includes(row.items[0].question_id), false);
  assert.equal(safe.correct_count, null);
  assert.equal(safe.questions[0].answered, true);
});

test("v218 rate limiter is bounded and returns a retry interval", () => {
  let now = 1_000;
  const limiter = new ExternalQbankRateLimiter({ maxBuckets: 100, now: () => now });
  assert.equal(limiter.take("client:subject", { limit: 2, windowMs: 1_000 }).allowed, true);
  assert.equal(limiter.take("client:subject", { limit: 2, windowMs: 1_000 }).allowed, true);
  const denied = limiter.take("client:subject", { limit: 2, windowMs: 1_000 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.retry_after_seconds, 1);
  now += 1_000;
  assert.equal(limiter.take("client:subject", { limit: 2, windowMs: 1_000 }).allowed, true);
  for (let index = 0; index < 150; index += 1) limiter.take(`attacker:${index}`, { limit: 1, windowMs: 10_000 });
  assert.equal(limiter.buckets.size, 100);
});

test("v218 persistence and routes keep binaries, provider secrets, and answers out of public delivery", async () => {
  const postgres = await fs.readFile(new URL("../lib/content-registry-postgres.js", import.meta.url), "utf8");
  const server = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  const delivery = await fs.readFile(new URL("../lib/external-qbank-delivery.js", import.meta.url), "utf8");
  const sessionTables = postgres.slice(
    postgres.indexOf("CREATE TABLE IF NOT EXISTS external_qbank_sessions"),
    postgres.indexOf("export async function createContentMediaImportJob"),
  );
  assert.match(sessionTables, /external_qbank_sessions/);
  assert.match(sessionTables, /external_qbank_session_items/);
  assert.match(sessionTables, /external_qbank_audit_events/);
  assert.match(sessionTables, /subject_hash TEXT NOT NULL/);
  assert.match(sessionTables, /entitlement_hash TEXT NOT NULL/);
  assert.match(sessionTables, /selected_answer_id INTEGER/);
  assert.doesNotMatch(sessionTables, /BYTEA|object_key|provider_secret|correct_answer_id/i);
  assert.match(postgres, /d\.destination='external_qbank'/);
  assert.match(postgres, /d\.destination_scope='' OR d\.destination_scope=\$3/);
  assert.match(postgres, /CASE WHEN d\.destination_scope=\$\{destinationScopeParameter\} AND \$\{destinationScopeParameter\}<>'' THEN 0 ELSE 1 END/);
  assert.match(sessionTables, /FOREIGN KEY\(question_id, selected_answer_id\) REFERENCES content_answers/);
  assert.match(delivery, /NEXTGEN_EXTERNAL_QBANK_CLIENTS_JSON/);
  assert.match(server, /entitlements\/exchange/);
  assert.match(server, /external-qbank\/clients/);
  assert.match(server, /external-qbank\/audit/);
  assert.match(server, /destination: "external_qbank"/);
  assert.match(server, /ngExternalQbankAssertOwnedSession/);
  assert.match(server, /EXTERNAL_QBANK_SERVER_TO_SERVER_REQUIRED/);
});
