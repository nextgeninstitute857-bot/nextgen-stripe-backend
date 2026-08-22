import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const route = server.slice(
  server.indexOf('app.post("/admin/crm/debug/clear-leads-inbox"'),
  server.indexOf("// CRM core CRUD routes"),
);

test("CRM fresh start is admin-confirmed, backed up, and isolated from LMS data", () => {
  assert.match(route, /requireCrmCollectionAccess\(req, "leads", "write"\)/);
  assert.match(route, /phrase !== "DELETE CRM"/);
  assert.match(route, /crm-db-before-fresh-start/);
  assert.match(route, /whatsapp-webhook-journal-before-fresh-start/);
  assert.match(route, /lms_database_untouched: true/);
  assert.doesNotMatch(route, /LIVE_DB_PATH/);
  assert.doesNotMatch(route, /readLiveDb/);
  assert.doesNotMatch(route, /writeLiveDb/);
});

test("CRM fresh start clears lead treatment memory but preserves configuration", () => {
  for (const key of [
    "leads",
    "conversations",
    "crm_message_logs",
    "ai_auto_runs",
    "message_delivery_locks",
    "suppression_list",
    "website_chat_sessions",
    "support_tickets",
  ]) {
    assert.match(route, new RegExp(`"${key}"`));
  }

  for (const protectedKey of [
    "ai_training",
    "ai_learning_lessons",
    "approved_learning_rules",
    "media_assets",
    "integrations",
    "provider_settings",
    "campaigns",
    "communities",
    "team_members",
    "referral_attributions",
    "commission_payouts",
    "settings",
  ]) {
    assert.doesNotMatch(route, new RegExp(`^\\s*"${protectedKey}",?$`, "m"));
  }
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, output, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode})\n${output.join("")}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Health timeout\n${output.join("")}`);
}

async function api(baseUrl, routeName, { method = "GET", token = "", body = null } = {}) {
  const response = await fetch(`${baseUrl}${routeName}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, payload: await response.json() };
}

test("CRM fresh start clears only CRM activity and leaves LMS enrollment data byte-for-byte unchanged", { timeout: 150_000 }, async () => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "crm-fresh-start-"));
  const adminEmail = "crm-admin@example.com";
  const adminPassword = "FreshStartAdmin9!";
  const lmsFixture = {
    users: {},
    courses: { course: { id: "course", name: "Protected LMS Course" } },
    enrollments: {
      enrollment: {
        id: "enrollment",
        user_id: "protected-student",
        course_id: "course",
        access_granted: true,
        progress_percent: 47,
      },
    },
    assessmentAttempts: { attempt: { id: "attempt", score: 81 } },
    recordings: { recording: { id: "recording", title: "Protected recording" } },
  };
  const protectedCrm = {
    ai_training: [{ id: "training", title: "Approved programme knowledge", status: "approved" }],
    ai_learning_lessons: [{ id: "lesson", status: "approved" }],
    approved_learning_rules: [{ id: "rule", status: "approved" }],
    media_assets: [{ id: "media", name: "LMS preview" }],
    integrations: [{ id: "whatsapp", platform: "whatsapp", enabled: true }],
    provider_settings: [{ id: "provider" }],
    campaigns: [{ id: "campaign" }],
    communities: [{ id: "community" }],
    team_members: [{ id: "team" }],
    referral_attributions: [{ id: "attribution" }],
    commission_payouts: [{ id: "payout" }],
    settings: { global_ai_enabled: true, whatsapp_ai_enabled: true },
  };
  const disposableCrm = {
    leads: [{ id: "lead" }],
    conversations: [{ id: "conversation", lead_id: "lead" }],
    crm_message_logs: [{ id: "crm-message", lead_id: "lead" }],
    ai_auto_runs: [{ id: "run", lead_id: "lead" }],
    message_delivery_locks: [{ id: "lock", lead_id: "lead" }],
    suppression_list: [{ id: "suppressed", lead_id: "lead" }],
    website_chat_sessions: [{ id: "chat", lead_id: "lead" }],
    support_tickets: [{ id: "ticket", lead_id: "lead" }],
  };

  await fsp.writeFile(path.join(dataDir, "live-session-db.json"), JSON.stringify(lmsFixture, null, 2));
  await fsp.writeFile(path.join(dataDir, "crm-db.json"), JSON.stringify({ ...protectedCrm, ...disposableCrm }, null, 2));
  await fsp.writeFile(path.join(dataDir, "aylamed-db.json"), JSON.stringify({ schema_version: 15 }));
  await fsp.writeFile(path.join(dataDir, "whatsapp-webhook-journal.jsonl"), `${JSON.stringify({ record_type: "processed", id: "old-event" })}\n`);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      AUTH_JWT_SECRET: "crm-fresh-start-test-secret",
      AYLA_AUTH_JWT_SECRET: "crm-fresh-start-ayla-secret",
      BOOTSTRAP_ADMIN_EMAIL: adminEmail,
      BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      NEXTGEN_BACKEND_HEARTBEAT_ENABLED: "false",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false",
      NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);
    const login = await api(baseUrl, "/auth/login", {
      method: "POST",
      body: { email: adminEmail, password: adminPassword },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));

    const lmsBefore = await fsp.readFile(path.join(dataDir, "live-session-db.json"), "utf8");
    const clear = await api(baseUrl, "/admin/crm/debug/clear-leads-inbox", {
      method: "POST",
      token: login.payload.token,
      body: { confirm: "DELETE CRM" },
    });
    assert.equal(clear.response.status, 200, JSON.stringify(clear.payload));
    assert.equal(clear.payload.lms_database_untouched, true);

    const lmsAfter = await fsp.readFile(path.join(dataDir, "live-session-db.json"), "utf8");
    assert.equal(lmsAfter, lmsBefore);

    const crmAfter = JSON.parse(await fsp.readFile(path.join(dataDir, "crm-db.json"), "utf8"));
    for (const key of Object.keys(disposableCrm)) assert.deepEqual(crmAfter[key], [], key);
    for (const [key, value] of Object.entries(protectedCrm)) {
      if (key === "settings") {
        assert.equal(crmAfter.settings.whatsapp_ai_enabled, true);
      } else {
        assert.deepEqual(crmAfter[key], value, key);
      }
    }

    assert.equal(await fsp.readFile(path.join(dataDir, "whatsapp-webhook-journal.jsonl"), "utf8"), "");
    assert.ok(clear.payload.crm_backup_path.startsWith(path.join(dataDir, "backups")));
    assert.ok(clear.payload.whatsapp_journal_backup_path.startsWith(path.join(dataDir, "backups")));
    assert.ok((await fsp.stat(clear.payload.crm_backup_path)).size > 0);
    assert.ok((await fsp.stat(clear.payload.whatsapp_journal_backup_path)).size > 0);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
});
