import fs from "node:fs/promises";

const DEFAULT_BASE_URL = "https://nextgen-stripe-backend.onrender.com/api/ayla";
const EXAM_TRACKS = Object.freeze({
  "USMLE Step 1": "usmle_step_1",
  "USMLE Step 2 CK": "usmle_step_2_ck",
  "USMLE Step 3": "usmle_step_3",
  MCCQE: "mccqe",
  PLAB: "plab",
  AMC: "amc",
  NCLEX: "nclex",
});

const EXAM_ORIGINS = Object.freeze({
  "USMLE Step 1": "https://aylamedapp.com",
  "USMLE Step 2 CK": "https://aylamedapp.com",
  "USMLE Step 3": "https://aylamedapp.com",
  MCCQE: "https://mccqe.aylamedapp.com",
  PLAB: "https://plab.aylamedapp.com",
  AMC: "https://amc.aylamedapp.com",
  NCLEX: "https://nclex.aylamedapp.com",
});

function option(name, fallback = "") {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function parseAccounts(markdown) {
  const accountSection = String(markdown || "").split(/^## Test rules\s*$/m)[0];
  return accountSection.split(/\r?\n/).flatMap((line) => {
    if (!/^\|\s*(USMLE|MCCQE|PLAB|AMC|NCLEX)/.test(line)) return [];
    const [exam, scenario, email, password] = line.replace(/^\||\|$/g, "").split("|").map((value) => value.trim());
    if (!EXAM_TRACKS[exam] || !scenario || !email || !password) return [];
    return [{ exam, examTrack: EXAM_TRACKS[exam], scenario, email, password }];
  });
}

function query(path, values = {}) {
  const url = new URL(path, "https://qa.invalid/");
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return `${url.pathname.replace(/^\//, "")}${url.search}`;
}

async function requestJson(baseUrl, path, { token = "", method = "GET", body, timeoutMs = 35_000, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}/${String(path).replace(/^\/+/, "")}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    return {
      ok: response.ok,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
      payload,
      error: response.ok ? "" : String(payload?.error || payload?.message || payload || `HTTP ${response.status}`).slice(0, 240),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      durationMs: Math.round(performance.now() - startedAt),
      payload: null,
      error: error?.name === "AbortError" ? `Timed out after ${timeoutMs} ms` : String(error?.message || error).slice(0, 240),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function firstArrayLength(value, preferredKeys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return null;
  for (const key of preferredKeys) if (Array.isArray(value[key])) return value[key].length;
  for (const child of Object.values(value)) {
    const length = firstArrayLength(child, preferredKeys, depth + 1);
    if (length !== null) return length;
  }
  return null;
}

function nclexVariant(profilePayload = {}) {
  const student = profilePayload.student || profilePayload.data?.student || {};
  return student.examVariant || student.exam_variant || student.nclexType || student.nclex_type || null;
}

function rootPayload(payload = {}) {
  return payload?.data && typeof payload.data === "object" ? payload.data : payload;
}

function accountLabel(account) {
  return `${account.exam} — ${account.scenario}`;
}

async function auditAccount(account, { baseUrl, timeoutMs }) {
  const headers = { Origin: EXAM_ORIGINS[account.exam] };
  const login = await requestJson(baseUrl, "auth/login", {
    method: "POST",
    body: { email: account.email, password: account.password },
    timeoutMs,
    headers,
  });
  if (!login.ok || !login.payload?.token) {
    return {
      label: accountLabel(account), exam: account.exam, scenario: account.scenario,
      expectedExamTrack: account.examTrack, activeExamTrack: null, variant: null,
      passed: 0, total: 1, failures: [{ endpoint: "auth/login", status: login.status, error: login.error }],
      slow: login.durationMs >= 8_000 ? [{ endpoint: "auth/login", durationMs: login.durationMs }] : [],
      counts: {},
    };
  }

  const token = login.payload.token;
  const me = await requestJson(baseUrl, "auth/me", { token, timeoutMs, headers });
  const student = me.payload?.student || me.payload?.data?.student || null;
  const studentId = student?.id || me.payload?.shell?.active_student_id || me.payload?.activeDashboard?.student_id || null;
  const activeExamTrack = student?.examTrackId
    || me.payload?.shell?.active_exam_track_id
    || me.payload?.activeDashboard?.exam_track_id
    || null;
  if (!studentId) {
    return {
      label: accountLabel(account), exam: account.exam, scenario: account.scenario,
      expectedExamTrack: account.examTrack, activeExamTrack, variant: null,
      passed: Number(me.ok), total: 2,
      failures: [{ endpoint: "student-shell", status: me.status, error: me.error || "No active student dashboard" }],
      slow: [login, me].flatMap((row, index) => row.durationMs >= 8_000 ? [{ endpoint: index ? "auth/me" : "auth/login", durationMs: row.durationMs }] : []),
      counts: {},
    };
  }

  const paths = [
    ["account-profile", "account/profile"],
    ["learning-profile", "profile"],
    ["dashboard", `students/${studentId}/dashboard`],
    ["today-roadmap-assessments-flashcards-history", query(`students/${studentId}/daily-workspace`, { view: "today" })],
    ["progress-systems-weak-areas", `students/${studentId}/progress`],
    ["revision", `students/${studentId}/revision`],
    ["personal-tutor", `students/${studentId}/personal-tutor`],
    ["qbank-bank-summary", query("qbank/catalog", { student_id: studentId, exam_track: account.examTrack, view: "bank_summary" })],
    ["qbank-catalog", query("qbank/catalog", { student_id: studentId, exam_track: account.examTrack })],
    ["qbank-history", query("qbank/history", { student_id: studentId, exam_track: account.examTrack, limit: 8 })],
    ["qbank-bookmarks", query("qbank/bookmarks", { student_id: studentId })],
    ["qbank-notes", query("qbank/notes", { student_id: studentId })],
    ["qbank-revision", query("qbank/revision", { student_id: studentId })],
    ["self-assessment-center", query("nbme-center/catalog", { student_id: studentId, exam_track: account.examTrack })],
    ["self-assessment-history", query("nbme-center/history", { student_id: studentId, exam_track: account.examTrack })],
    ["content-hub", `students/${studentId}/content-hub`],
    ["library", `students/${studentId}/library`],
    ["notebook", `students/${studentId}/notebooks`],
    ["leaderboard", query("community/leaderboard", { studentId, period: "all_time" })],
    ["study-partner-matches", query("study-partners/matches", { studentId })],
    ["study-partner-requests", query("study-partners/requests", { studentId })],
    ["community-profile", "community/profile"],
    ["community-messages", query("community/messages", { limit: 20 })],
    ["referrals", `students/${studentId}/referral-center`],
  ];

  const results = [["auth/login", login], ["auth/me", me]];
  for (const [name, path] of paths) {
    const result = await requestJson(baseUrl, path, { token, timeoutMs, headers });
    const expectedNbmeDenial = !account.examTrack.startsWith("usmle_step_")
      && ["self-assessment-center", "self-assessment-history"].includes(name)
      && result.status === 409
      && /available only for USMLE Step 1, Step 2 CK, and Step 3 dashboards/i.test(result.error);
    results.push([name, expectedNbmeDenial ? { ...result, ok: true, expectedDenial: true } : result]);
  }

  const byName = Object.fromEntries(results);
  const profilePayload = byName["learning-profile"]?.payload || {};
  const failures = results.filter(([, result]) => !result.ok).map(([endpoint, result]) => ({
    endpoint, status: result.status, error: result.error,
  }));
  if (activeExamTrack !== account.examTrack) {
    failures.push({ endpoint: "exam-isolation", status: 0, error: `Expected ${account.examTrack}; received ${activeExamTrack || "none"}` });
  }
  const slow = results.filter(([, result]) => result.durationMs >= 8_000).map(([endpoint, result]) => ({
    endpoint, durationMs: result.durationMs,
  }));
  const qbankPayload = rootPayload(byName["qbank-catalog"]?.payload);
  const bankSummaryPayload = rootPayload(byName["qbank-bank-summary"]?.payload);
  const contentPayload = rootPayload(byName["content-hub"]?.payload);
  const libraryPayload = rootPayload(byName.library?.payload);
  const revisionPayload = rootPayload(byName.revision?.payload);
  const counts = {
    dailyAssignments: firstArrayLength(byName["today-roadmap-assessments-flashcards-history"]?.payload, ["assignments", "items"]),
    qbankBanks: Array.isArray(bankSummaryPayload?.catalog) ? bankSummaryPayload.catalog.length : null,
    qbankBankNames: Array.isArray(bankSummaryPayload?.catalog)
      ? bankSummaryPayload.catalog.map((row) => row.bank_name).filter(Boolean)
      : [],
    qbankCatalogRows: Number.isFinite(Number(qbankPayload?.count)) ? Number(qbankPayload.count) : null,
    qbankQuestions: Number.isFinite(Number(qbankPayload?.question_count)) ? Number(qbankPayload.question_count) : null,
    selfAssessments: firstArrayLength(byName["self-assessment-center"]?.payload, ["forms", "assessments", "items", "catalog"]),
    contentFolders: Array.isArray(contentPayload?.catalog?.playlists) ? contentPayload.catalog.playlists.length : null,
    contentFolderNames: Array.isArray(contentPayload?.catalog?.playlists)
      ? contentPayload.catalog.playlists.map((row) => row.title).filter(Boolean)
      : [],
    contentVideos: Number.isFinite(Number(contentPayload?.catalog?.total)) ? Number(contentPayload.catalog.total) : null,
    libraryBooks: Array.isArray(libraryPayload?.catalog?.books) ? libraryPayload.catalog.books.length : null,
    libraryResources: Number.isFinite(Number(libraryPayload?.catalog?.total)) ? Number(libraryPayload.catalog.total) : null,
    revisionItems: firstArrayLength(revisionPayload, ["items", "queue", "due", "upcoming"]),
  };
  const contentIssues = [
    counts.qbankQuestions === 0 ? "empty_qbank" : "",
    counts.contentVideos === 0 ? "empty_content_hub" : "",
    counts.libraryResources === 0 ? "empty_library" : "",
  ].filter(Boolean);
  return {
    label: accountLabel(account), exam: account.exam, scenario: account.scenario,
    expectedExamTrack: account.examTrack, activeExamTrack,
    variant: account.examTrack === "nclex" ? nclexVariant(profilePayload) : null,
    passed: results.filter(([, result]) => result.ok).length,
    total: results.length,
    failures, slow, counts, contentIssues,
  };
}

async function mapLimited(rows, concurrency, worker) {
  const results = new Array(rows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(rows[index], index);
      const result = results[index];
      process.stderr.write(
        `${result.failures.length ? "FAIL" : "PASS"} ${result.label}: ${result.passed}/${result.total}`
        + `${result.slow.length ? `; slow=${result.slow.length}` : ""}\n`,
      );
    }
  }));
  return results;
}

const accountsPath = option("accounts");
if (!accountsPath) throw new Error("Pass --accounts=<path to the private permanent QA account markdown>");
const baseUrl = option("base", DEFAULT_BASE_URL).replace(/\/+$/, "");
const concurrency = boundedInteger(option("concurrency", "2"), 2, 1, 4);
const timeoutMs = boundedInteger(option("timeout-ms", "35000"), 35_000, 5_000, 90_000);
const markdown = await fs.readFile(accountsPath, "utf8");
const accounts = parseAccounts(markdown);
if (!accounts.length) throw new Error("No permanent QA accounts were found");

const publicChecks = await Promise.all([
  requestJson(baseUrl, "health", { timeoutMs }),
  requestJson(baseUrl, "routes", { timeoutMs }),
  requestJson(baseUrl, "exams", { timeoutMs }),
]);
const results = await mapLimited(accounts, concurrency, (account) => auditAccount(account, { baseUrl, timeoutMs }));
const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  safety: {
    permanentQaAccountsOnly: true,
    existingStudentAccountsTouched: 0,
    answerWritesPerformed: 0,
    profileWritesPerformed: 0,
    roadmapRebuildsRequested: 0,
  },
  matrix: {
    accounts: results.length,
    expectedAccounts: 21,
    exams: [...new Set(results.map((row) => row.exam))].length,
    accountsPassingAllEndpoints: results.filter((row) => !row.failures.length).length,
    endpointChecks: results.reduce((sum, row) => sum + row.total, 0),
    endpointPasses: results.reduce((sum, row) => sum + row.passed, 0),
    slowChecks: results.reduce((sum, row) => sum + row.slow.length, 0),
    accountsWithContentIssues: results.filter((row) => row.contentIssues?.length).length,
  },
  publicChecks: ["health", "routes", "exams"].map((name, index) => ({
    name, ok: publicChecks[index].ok, status: publicChecks[index].status, durationMs: publicChecks[index].durationMs,
  })),
  results,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
