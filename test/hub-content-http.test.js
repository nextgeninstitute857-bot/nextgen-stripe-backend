import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyHubPublish, hubPublishKeyMatches, validateHubBundle } from "../lib/hub-content.js";

const KEY = "hub-publish-key-for-tests-0123456789";
const HUB = "https://hub.nextgenusmle.live";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child, output, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output.join("")}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not start:\n${output.join("")}`);
}

const bundle = (overrides = {}) => ({
  version: 1,
  plan: {
    name: "NextGen 120-Day",
    systems: [
      {
        name: "Hematology",
        days: [
          {
            id: "hem-d1",
            title: "Iron & heme <script>",
            firstAidPages: "409–413",
            lectureIds: ["1235229460", "not-a-vimeo-id"],
            topics: [{ id: "t1", topic: "Iron deficiency", subjects: ["Pathology"], qids: ["787", "787", "abc", 19135], difficulty: "nope" }],
          },
        ],
      },
    ],
  },
  announcements: [{ id: "a1", title: "Live class at 8 PM", text: "Zoom link in WhatsApp", tone: "warn", createdAt: "2026-10-24T10:00:00Z" }, { title: "" }],
  ...overrides,
});

test("validation cleans fields and enforces limits", () => {
  const clean = validateHubBundle(bundle());
  const day = clean.plan.systems[0].days[0];
  assert.deepEqual(day.lectureIds, ["1235229460"]);
  assert.deepEqual(day.topics[0].qids, ["787", "19135"]);
  assert.equal(day.topics[0].difficulty, "");
  assert.equal(day.systemDay, 1);
  assert.equal(clean.announcements.length, 1, "announcements without a title are dropped");
  assert.throws(() => validateHubBundle({}), /plan.systems/);
  assert.throws(() => validateHubBundle({ plan: { systems: [{ name: "x".repeat(2_100_000) }] } }), /larger than 2 MB/);
});

test("publish key needs 16+ characters and an exact match", () => {
  assert.equal(hubPublishKeyMatches(KEY, KEY), true);
  assert.equal(hubPublishKeyMatches("wrong", KEY), false);
  assert.equal(hubPublishKeyMatches("short", "short"), false);
  assert.equal(hubPublishKeyMatches("", KEY), false);
});

test("each publish bumps the revision and keeps the last versions", () => {
  const db = {};
  for (let i = 0; i < 8; i += 1) applyHubPublish(db, validateHubBundle(bundle()));
  assert.equal(db.hubContent.revision, 8);
  assert.equal(db.hubContentHistory.length, 5);
  assert.equal(db.hubContentHistory[0].revision, 7);
});

test("GET and POST /hub/content over HTTP", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hub-content-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      PORT: String(port),
      TZ: "UTC",
      DATA_DIR: dataDir,
      HUB_PUBLISH_KEY: KEY,
      AUTH_JWT_SECRET: "hub-content-secret",
      AYLA_AUTH_JWT_SECRET: "hub-content-ayla-secret",
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
      NEXTGEN_BACKEND_HEARTBEAT_ENABLED: "false",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false",
      NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => output.push(String(c)));
  child.stderr.on("data", (c) => output.push(String(c)));
  try {
    await waitForHealth(baseUrl, child, output);

    const empty = await fetch(`${baseUrl}/hub/content`, { headers: { Origin: HUB } });
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get("access-control-allow-origin"), HUB);
    assert.equal((await empty.json()).content, null);

    const preflight = await fetch(`${baseUrl}/hub/content`, {
      method: "OPTIONS",
      headers: { Origin: HUB, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-hub-publish-key" },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") || "", /x-hub-publish-key/i);

    const post = (headers, body = bundle()) =>
      fetch(`${baseUrl}/hub/content`, { method: "POST", headers: { Origin: HUB, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

    assert.equal((await post({})).status, 401, "no key");
    assert.equal((await post({ "x-hub-publish-key": "wrong-key-wrong-key" })).status, 401, "wrong key");
    assert.equal((await post({ "x-hub-publish-key": KEY }, { nope: true })).status, 400, "bad body");

    const ok = await post({ "x-hub-publish-key": KEY });
    const okBody = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(okBody));
    assert.equal(okBody.revision, 1);

    const second = await (await post({ "x-hub-publish-key": KEY })).json();
    assert.equal(second.revision, 2);

    const read = await (await fetch(`${baseUrl}/hub/content`)).json();
    assert.equal(read.content.revision, 2);
    assert.equal(read.content.plan.systems[0].days[0].topics[0].qids.join(","), "787,19135");
    assert.equal(read.content.announcements[0].title, "Live class at 8 PM");

    const stored = JSON.parse(await fs.readFile(path.join(dataDir, "live-db.json"), "utf8").catch(async () => {
      const files = await fs.readdir(dataDir);
      return fs.readFile(path.join(dataDir, files.find((f) => /live/i.test(f) && f.endsWith(".json"))), "utf8");
    }));
    assert.equal(stored.hubContent.revision, 2);
    assert.equal(stored.hubContentHistory.length, 1);

    const blocked = await fetch(`${baseUrl}/hub/content`, { headers: { Origin: "https://evil.example" } });
    assert.equal(blocked.status, 403, "unknown websites stay blocked");
  } finally {
    if (child.exitCode === null) await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
