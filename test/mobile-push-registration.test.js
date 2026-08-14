import test from "node:test";
import assert from "node:assert/strict";
import { registerDeviceToken, revokeDeviceTokens, validateDeviceRegistration } from "../lib/mobile-push-registration.js";

test("registration ownership comes from authenticated user and deduplicates", () => {
  const records = {};
  const input = { platform: "ios", token: "a".repeat(64), app_id: "com.nextgenusmle.live", user_id: "attacker" };
  const first = registerDeviceToken(records, "student-1", input, "2026-01-01T00:00:00.000Z");
  const second = registerDeviceToken(records, "student-1", input, "2026-01-02T00:00:00.000Z");
  assert.equal(Object.keys(records).length, 1);
  assert.equal(first.user_id, "student-1");
  assert.equal(second.created_at, first.created_at);
  assert.equal(second.updated_at, "2026-01-02T00:00:00.000Z");
});

test("another user cannot revoke a token they do not own", () => {
  const records = {};
  registerDeviceToken(records, "student-1", { platform: "android", token: "b".repeat(64) });
  assert.equal(revokeDeviceTokens(records, "student-2", { token: "b".repeat(64) }), 0);
  assert.equal(Object.values(records)[0].active, true);
});

test("revocation requires a token or device id", () => {
  const records = {};
  registerDeviceToken(records, "student-1", { platform: "ios", token: "c".repeat(64) });
  assert.equal(revokeDeviceTokens(records, "student-1", {}), 0);
});

test("validation rejects unknown platforms, apps, and short tokens", () => {
  assert.throws(() => validateDeviceRegistration({ platform: "web", token: "a".repeat(64) }));
  assert.throws(() => validateDeviceRegistration({ platform: "ios", token: "a".repeat(64), app_id: "evil.app" }));
  assert.throws(() => validateDeviceRegistration({ platform: "ios", token: "short" }));
});
