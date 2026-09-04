import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function passwordRecord(password) {
  const salt = "crm-mccqe-demo-test-password-salt";
  return { salt, password_hash: crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex") };
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function freePort() {
  const server = net.createServer(), port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function localSmtp() {
  const accepted = [], sockets = new Set();
  let reject = false;
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let pending = "", collecting = false, message = "";
    socket.setEncoding("utf8"); socket.write("220 localhost test smtp\r\n");
    socket.on("data", (chunk) => {
      pending += chunk;
      while (pending.includes("\r\n")) {
        const index = pending.indexOf("\r\n"), line = pending.slice(0, index); pending = pending.slice(index + 2);
        if (collecting) {
          if (line === ".") { collecting = false; accepted.push(message); message = ""; socket.write("250 2.0.0 accepted\r\n"); }
          else message += line + "\r\n";
        } else if (/^EHLO|^HELO/.test(line)) socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH /.test(line)) socket.write("235 2.7.0 authenticated\r\n");
        else if (/^RCPT /.test(line) && reject) socket.write("550 rejected for test\r\n");
        else if (line === "DATA") { collecting = true; socket.write("354 send message\r\n"); }
        else if (line === "QUIT") { socket.end("221 bye\r\n"); }
        else socket.write("250 ok\r\n");
      }
    });
  });
  const port = await listen(server);
  return { port, accepted, setReject: (value) => { reject = value; }, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); } };
}

test("private CRM demo HTTP flow issues once, preserves accounts and paid access, recovers linkage, and holds uncertain email", { timeout: 160000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "crm-mccqe-demo-http-"));
  const smtp = await localSmtp();
  const now = new Date().toISOString(), future = new Date(Date.now() + 30 * 86400000).toISOString();
  const adminPassword = "DemoAdmin9!", oldPassword = "ExistingDoctor9!";
  const lead = (id, email, extra = {}) => ({ id, email, name: id, brand_id: "brand_aylamed", exam_track: "mccqe", source_platform: "whatsapp", current_channel: "whatsapp",
    phone: "+18250000001", ai_mode: "auto", status: "new_lead", stage: "new_lead", created_at: now, ...extra });
  const leads = [lead("new", "new@example.com"), lead("existing", "existing@example.com"), lead("paid", "paid@example.com"),
    lead("uncertain", "uncertain@example.com"), lead("legacy", "new@example.com", { brand_id: "brand_nextgen_usmle", exam_track: "usmle_step1" })];
  const liveDb = { users: { admin: { id: "admin", email: "admin@example.com", name: "Admin", role: "admin", verified: true, ...passwordRecord(adminPassword) } }, courses: {}, plans: {}, enrollments: {}, payments: {}, liveSessions: {} };
  const crmDb = { brands: [{ id: "brand_aylamed", name: "AylaMed" }, { id: "brand_nextgen_usmle", name: "NextGen" }], leads,
    settings: { default_brand_id: "brand_aylamed" }, message_logs: leads.map((row) => ({ id: `in-${row.id}`, lead_id: row.id, brand_id: row.brand_id, channel: "whatsapp", direction: "inbound", text: "Please email my MCCQE demo", created_at: now })), ai_training_documents: [], ai_training_items: [] };
  const paidEnrollment = { id: "paid-enrollment", user_id: "paid-user", exam_track_id: "mccqe", type: "paid", is_demo: false, status: "active", access_granted: true, access_expires_at: future };
  const existingHash = passwordRecord(oldPassword);
  const aylaDb = { aylaUsers: { "existing-user": { id: "existing-user", email: "existing@example.com", role: "student", status: "active", authVersion: 3, ...existingHash },
    "paid-user": { id: "paid-user", email: "paid@example.com", role: "student", status: "active", authVersion: 2, ...passwordRecord("PaidDoctor9!") } },
    aylaStudents: {}, aylaEnrollments: { "paid-enrollment": paidEnrollment }, aylaPayments: {}, aylaPlans: {} };
  await fs.writeFile(path.join(dir, "live-session-db.json"), JSON.stringify(liveDb));
  await fs.writeFile(path.join(dir, "crm-db.json"), JSON.stringify(crmDb));
  await fs.writeFile(path.join(dir, "aylamed-db.json"), JSON.stringify(aylaDb));
  let child, token = "", baseUrl, output = [];
  async function stop() { if (!child || child.exitCode !== null) return; const ended = new Promise((resolve) => child.once("exit", resolve)); child.kill(); await ended; }
  async function start(enabled = true) {
    const port = await freePort(); baseUrl = `http://127.0.0.1:${port}`; output = [];
    child = spawn(process.execPath, ["server.js"], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env,
      PORT: String(port), DATA_DIR: dir, DATABASE_URL: "", AUTH_JWT_SECRET: "demo-http-secret", AYLA_AUTH_JWT_SECRET: "demo-http-ayla-secret",
      AYLAMED_MCCQE_DEMO_FLOW_ENABLED: String(enabled), AYLAMED_AI_AUTO_SEND_ENABLED: "false", OPENAI_API_KEY: "",
      WHATSAPP_ACCESS_TOKEN: "", WHATSAPP_PHONE_NUMBER_ID: "", AYLA_EMAIL_PROVIDER: "smtp", AYLA_EMAIL_FROM: "AylaMed <support@aylamedapp.com>",
      AYLA_SMTP_HOST: "127.0.0.1", AYLA_SMTP_PORT: String(smtp.port), AYLA_SMTP_SECURE: "false", AYLA_SMTP_USER: "local-test", AYLA_SMTP_PASS: "local-test",
      AYLA_RESEND_API_KEY: "", AYLA_SENDGRID_API_KEY: "", NEXTGEN_BACKEND_HEARTBEAT_ENABLED: "false", NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false", NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false", AYLA_CONTINUITY_EMAIL_RUNNER_ENABLED: "false",
    }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (data) => output.push(String(data))); child.stderr.on("data", (data) => output.push(String(data)));
    const deadline = Date.now() + 70000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Test backend exited: ${output.join("").slice(-4000)}`);
      try { if ((await fetch(`${baseUrl}/health`)).ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
    const login = await api("/auth/login", { method: "POST", body: { email: "admin@example.com", password: adminPassword } });
    assert.equal(login.status, 200, JSON.stringify(login.payload)); token = login.payload.token;
  }
  async function api(route, { method = "GET", body } = {}) {
    const response = await fetch(baseUrl + route, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, payload: await response.json() };
  }
  const body = (id, extra = {}) => ({ product: "aylamed", crm_demo: true, crm_lead_id: id, brand_id: "brand_aylamed", email: `${id}@example.com`, exam_track_id: "mccqe", idempotency_key: `request-${id}-001`, ...extra });
  const read = async (name) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
  try {
    await start();
    const wrong = await api("/admin/mobile/invitations", { method: "POST", body: body("legacy", { email: "new@example.com" }) });
    assert.equal(wrong.status, 409);
    const mismatch = await api("/admin/mobile/invitations", { method: "POST", body: body("new", { email: "wrong@example.com" }) });
    assert.equal(mismatch.status, 409);
    const results = await Promise.all([1, 2].map(() => api("/admin/mobile/invitations", { method: "POST", body: body("new", { access_duration: 999, access_unit: "months" }) })));
    for (const result of results) assert.equal(result.status, 201, JSON.stringify(result.payload));
    assert.equal(smtp.accepted.length, 1);
    let stored = await read("aylamed-db.json"), issuance = Object.values(stored.aylaCrmDemoIssuances)[0];
    assert.equal(issuance.email_delivery_status, "accepted");
    assert.equal(Date.parse(issuance.expires_at) - Date.parse(issuance.starts_at), 5 * 3600000);
    const enrollment = stored.aylaEnrollments[issuance.enrollment_id], user = stored.aylaUsers[issuance.user_id];
    assert.equal(enrollment.type, "demo"); assert.equal(enrollment.is_demo, true); assert.equal(enrollment.source, "crm_mccqe_demo");
    assert.equal(enrollment.exam_track_id, "mccqe");
    assert.equal(stored.aylaStudents[enrollment.student_id].onboardingPath, "starting_choice_pending");
    assert.match(smtp.accepted[0], /mccqe\.aylamedapp\.com/);
    assert.doesNotMatch(smtp.accepted[0], /nextgenusmle\.live/i);
    const replay = await api("/admin/mobile/invitations", { method: "POST", body: body("new", { idempotency_key: "request-new-002" }) });
    assert.equal(replay.payload.results[0].idempotent_replay, true);
    assert.equal(smtp.accepted.length, 1);
    stored = await read("aylamed-db.json");
    assert.equal(stored.aylaUsers[issuance.user_id].password_hash, user.password_hash);
    assert.equal(stored.aylaEnrollments[issuance.enrollment_id].access_expires_at, issuance.expires_at);
    let crm = await read("crm-db.json"), crmLead = crm.leads.find((row) => row.id === "new");
    assert.equal(crmLead.ayla_user_id, issuance.user_id); assert.equal(crmLead.ayla_experience_followups.length, 1);
    assert.equal(crmLead.ayla_experience_followups[0].due_at, issuance.expires_at);
    assert.equal(crm.leads.find((row) => row.id === "legacy").ayla_user_id, undefined);

    const existing = await api("/admin/mobile/invitations", { method: "POST", body: body("existing") });
    assert.equal(existing.status, 201, JSON.stringify(existing.payload));
    stored = await read("aylamed-db.json");
    assert.equal(stored.aylaUsers["existing-user"].password_hash, existingHash.password_hash);
    assert.equal(stored.aylaUsers["existing-user"].authVersion, 3);
    assert.equal(smtp.accepted.length, 2);
    const paid = await api("/admin/mobile/invitations", { method: "POST", body: body("paid") });
    assert.equal(paid.payload.results[0].reason, "already_purchased");
    stored = await read("aylamed-db.json");
    assert.equal(stored.aylaEnrollments["paid-enrollment"].access_expires_at, future);
    assert.equal(smtp.accepted.length, 2);

    smtp.setReject(true);
    const uncertain = await api("/admin/mobile/invitations", { method: "POST", body: body("uncertain") });
    assert.equal(uncertain.status, 201, JSON.stringify(uncertain.payload));
    assert.equal(uncertain.payload.results[0].demo.email_delivery_status, "uncertain");
    smtp.setReject(false);
    assert.equal((await api("/admin/mobile/invitations", { method: "POST", body: body("uncertain") })).payload.results[0].idempotent_replay, true);
    assert.equal(smtp.accepted.length, 2);
    crm = await read("crm-db.json");
    assert.equal(crm.leads.find((row) => row.id === "uncertain").ayla_experience_followups?.length || 0, 0);

    await stop();
    crm = await read("crm-db.json"); crmLead = crm.leads.find((row) => row.id === "new");
    delete crmLead.ayla_user_id; delete crmLead.aylamed_demo; delete crmLead.ayla_experience_followups;
    await fs.writeFile(path.join(dir, "crm-db.json"), JSON.stringify(crm));
    await start();
    assert.equal((await api("/admin/mobile/invitations", { method: "POST", body: body("new") })).payload.results[0].idempotent_replay, true);
    crm = await read("crm-db.json");
    assert.equal(crm.leads.find((row) => row.id === "new").ayla_experience_followups.length, 1);
    assert.equal(smtp.accepted.length, 2);

    await stop(); await start(false);
    const off = await api("/admin/mobile/invitations", { method: "POST", body: body("new") });
    assert.equal(off.status, 409); assert.equal(smtp.accepted.length, 2);
    assert.equal((await api("/health")).payload.crm_mccqe_demo_enabled, false);
  } finally { await stop(); await smtp.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
