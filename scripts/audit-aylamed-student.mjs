const DEFAULT_BASE_URL = "https://nextgen-stripe-backend.onrender.com/api/ayla";

function argument(name, fallback = "") {
  const prefix = `--${name}=`;
  const entry = process.argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : fallback;
}

async function request(baseUrl, path, { token = "", method = "GET", body } = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    return {
      status: response.status,
      ok: response.ok && payload?.success !== false,
      milliseconds: Date.now() - startedAt,
      payload,
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      milliseconds: Date.now() - startedAt,
      error: `${error.name}: ${error.message}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const email = argument("email");
const password = argument("password");
const baseUrl = argument("base", DEFAULT_BASE_URL).replace(/\/+$/, "");

if (!email || !password) {
  console.error("Usage: node scripts/audit-aylamed-student.mjs --email=... --password=...");
  process.exit(2);
}

const login = await request(baseUrl, "/auth/login", {
  method: "POST",
  body: { email, password },
});

if (!login.ok) {
  console.log(JSON.stringify({ email, login }, null, 2));
  process.exit(1);
}

const token = login.payload.token;
const studentId = login.payload.user?.studentId;
const paths = {
  shell: "/shell",
  dashboard: `/students/${studentId}/dashboard`,
  today: `/students/${studentId}/daily-workspace?view=today`,
  roadmap: `/students/${studentId}/daily-workspace`,
  progress: `/students/${studentId}/progress`,
  revision: `/students/${studentId}/revision`,
  personal_tutor: `/students/${studentId}/personal-tutor`,
  content_hub: `/students/${studentId}/content-hub`,
  library: `/students/${studentId}/library`,
  notebooks: `/students/${studentId}/notebooks`,
  qbank_catalog: "/qbank/catalog",
  qbank_history: "/qbank/history",
  nbme_catalog: "/nbme-center/catalog",
  leaderboard: "/community/leaderboard",
  study_partners: "/study-partners/matches",
  referrals: `/students/${studentId}/referral-center`,
};

const checks = {};
for (const [name, path] of Object.entries(paths)) {
  const result = await request(baseUrl, path, { token });
  checks[name] = {
      status: result.status,
      ok: result.ok,
      milliseconds: result.milliseconds,
      error: result.payload?.error || result.error || null,
  };
}

const failures = Object.entries(checks)
  .filter(([, result]) => !result.ok)
  .map(([name]) => name);

console.log(JSON.stringify({
  email,
  studentId,
  login: {
    status: login.status,
    ok: login.ok,
    milliseconds: login.milliseconds,
  },
  checks,
  failures,
}, null, 2));

process.exitCode = failures.length ? 1 : 0;
