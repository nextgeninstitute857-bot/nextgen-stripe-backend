import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const route = source.slice(
  source.indexOf('app.post("/demo/instant-start"'),
  source.indexOf('app.post("/demo/start"'),
);

test("instant demo keeps returning accounts behind a password check", () => {
  assert.match(route, /existing_account:\s*true/);
  assert.match(route, /requires_password:\s*true/);
  assert.ok(route.indexOf("findUserByEmail") < route.indexOf("createBackendUser"));
  assert.doesNotMatch(route, /signAuthToken\(existingUser\)/);
});

test("instant demo sends credentials before persisting and never returns the password", () => {
  const sendIndex = route.indexOf('templateKey: "instant_demo_credentials"');
  const deliveryGuardIndex = route.indexOf("credentialEmail.sent !== true");
  const writeIndex = route.indexOf("await writeLiveDb(db)");
  assert.ok(sendIndex > 0);
  assert.ok(sendIndex < deliveryGuardIndex);
  assert.ok(deliveryGuardIndex < writeIndex);
  assert.match(route, /force:\s*true/);

  const publicResponse = route.slice(route.indexOf("const safeUser"), route.indexOf("return res.json(result)"));
  assert.doesNotMatch(publicResponse, /temporaryPassword|temporary_password/);
  assert.match(publicResponse, /token:\s*signAuthToken\(user\)/);
});

test("instant demo creates all active demo courses and limits public requests", () => {
  assert.match(route, /all_courses:\s*true/);
  assert.match(route, /course_scope:\s*"all_active"/);
  assert.match(route, /ngTakeInstantDemoRateLimit/);
  assert.match(route, /INSTANT_DEMO_RATE_LIMITED/);
  assert.match(source, /instant_demo_credentials:\s*\{/);
  assert.match(source, /Password: \{\{temporary_password\}\}/);
});
