import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const CLIENT_SECRET = "external-http-client-secret-that-is-long-enough";
const ALLOWED_ORIGIN = "https://nclex-site.example.com";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, child, output, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode})\n${output.join("")}`);
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Health timeout\n${output.join("")}`);
}

async function jsonResponse(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch { throw new Error(`${options.method || "GET"} ${url} returned ${response.status}: ${text.slice(0, 500)}`); }
  }
  return { response, payload };
}

test("v218 HTTP boundary allows an external site only on its QBank routes", { timeout: 40_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-v218-http-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const clientConfig = [{
    client_id: "nclex-site",
    client_secret: CLIENT_SECRET,
    name: "NCLEX Site",
    active: true,
    allowed_origins: [ALLOWED_ORIGIN],
    exam_tracks: ["nclex"],
    scopes: ["catalog:read", "sessions:read", "sessions:write", "answers:write"],
    destination_scope: "nclex-site",
    can_issue_entitlements: true,
    token_version: 1,
  }];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      NEXTGEN_EXTERNAL_QBANK_TOKEN_SECRET: "external-http-signing-secret-that-is-long-enough-123456789",
      NEXTGEN_EXTERNAL_QBANK_CLIENTS_JSON: JSON.stringify(clientConfig),
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

    const status = await jsonResponse(`${baseUrl}/api/external-qbank/v1/status`);
    assert.equal(status.response.status, 200, JSON.stringify(status.payload));
    assert.equal(status.payload.configured, false);
    assert.equal(status.payload.api_version, "v1");
    assert.equal(JSON.stringify(status.payload).includes(CLIENT_SECRET), false);
    assert.equal(Object.hasOwn(status.payload, "clients"), false);

    const allowedPreflight = await fetch(`${baseUrl}/api/external-qbank/v1/catalog`, {
      method: "OPTIONS",
      headers: {
        origin: ALLOWED_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    assert.equal(allowedPreflight.status, 204);
    assert.equal(allowedPreflight.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);

    const crossover = await jsonResponse(`${baseUrl}/auth/me`, {
      method: "OPTIONS",
      headers: { origin: ALLOWED_ORIGIN, "access-control-request-method": "GET" },
    });
    assert.equal(crossover.response.status, 403, JSON.stringify(crossover.payload));
    assert.match(crossover.payload.error, /origin is not allowed/i);

    const wrongOrigin = await jsonResponse(`${baseUrl}/api/external-qbank/v1/catalog`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.com", "access-control-request-method": "GET" },
    });
    assert.equal(wrongOrigin.response.status, 403, JSON.stringify(wrongOrigin.payload));

    const noCredentials = await jsonResponse(`${baseUrl}/api/external-qbank/v1/entitlements/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(noCredentials.response.status, 401, JSON.stringify(noCredentials.payload));
    assert.equal(noCredentials.payload.code, "EXTERNAL_QBANK_CLIENT_AUTH_REQUIRED");

    const basic = `Basic ${Buffer.from(`nclex-site:${CLIENT_SECRET}`).toString("base64")}`;
    const browserExchange = await jsonResponse(`${baseUrl}/api/external-qbank/v1/entitlements/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: basic, origin: ALLOWED_ORIGIN },
      body: JSON.stringify({
        external_subject: "student-1",
        exam_track: "nclex",
        entitlement_reference: "subscription-1",
        entitlement_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    });
    assert.equal(browserExchange.response.status, 403, JSON.stringify(browserExchange.payload));
    assert.equal(browserExchange.payload.code, "EXTERNAL_QBANK_SERVER_TO_SERVER_REQUIRED");

    const wrongExam = await jsonResponse(`${baseUrl}/api/external-qbank/v1/entitlements/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: basic },
      body: JSON.stringify({
        external_subject: "student-1",
        exam_track: "plab",
        entitlement_reference: "subscription-1",
        entitlement_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    });
    assert.equal(wrongExam.response.status, 403, JSON.stringify(wrongExam.payload));
    assert.equal(wrongExam.payload.code, "EXTERNAL_QBANK_EXAM_DENIED");
    assert.equal(JSON.stringify(wrongExam.payload).includes("student-1"), false);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
