import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  AYLA_PILOT_LOGIN_MAX_TTL_SECONDS,
  aylaPilotLoginFragmentPath,
  consumeAylaPilotLoginGrant,
  createAylaPilotLoginGrant,
  hashAylaPilotLoginToken,
  isAylaPilotLoginIdentity,
} from "../lib/aylamed-pilot-login.js";

const now = new Date("2026-07-30T10:00:00.000Z");
const user = {
  id: "pilot-user",
  email: "diagnostic.karachi@pilot.aylamed.local",
  role: "student",
  status: "active",
  pilotTest: true,
};
const student = {
  id: "pilot-student",
  ayla_user_id: user.id,
  pilotTest: true,
};

function fixedRandomBytes() {
  return Buffer.alloc(32, 7);
}

test("pilot access is restricted to active, owned @pilot.aylamed.local identities", () => {
  assert.equal(isAylaPilotLoginIdentity(user, student), true);
  assert.equal(isAylaPilotLoginIdentity({ ...user, email: "student@example.com" }, student), false);
  assert.equal(isAylaPilotLoginIdentity({ ...user, status: "disabled" }, student), false);
  assert.equal(isAylaPilotLoginIdentity({ ...user, role: "admin" }, student), false);
  assert.equal(isAylaPilotLoginIdentity({ ...user, pilotTest: false }, student), false);
  assert.equal(isAylaPilotLoginIdentity(user, { ...student, pilotTest: false }), false);
  assert.equal(isAylaPilotLoginIdentity(user, { ...student, ayla_user_id: "someone-else" }), false);
});

test("pilot grants store only a hash, are short-lived and use a URL fragment", () => {
  const { grant, token } = createAylaPilotLoginGrant({
    user,
    student,
    ttlSeconds: 60 * 60,
    now,
    randomBytes: fixedRandomBytes,
    idFactory: () => "grant-1",
  });

  assert.equal(grant.id, "grant-1");
  assert.equal(grant.tokenHash, hashAylaPilotLoginToken(token));
  assert.equal("token" in grant, false);
  assert.equal(grant.ttlSeconds, AYLA_PILOT_LOGIN_MAX_TTL_SECONDS);
  assert.equal(grant.expiresAt, "2026-07-30T10:15:00.000Z");
  assert.match(aylaPilotLoginFragmentPath(token), /^\/pilot-access#token=/);
  assert.equal(aylaPilotLoginFragmentPath(token).includes("?"), false);
});

test("pilot grant consumption is single-use and fails generically after use or expiry", () => {
  const { grant, token } = createAylaPilotLoginGrant({
    user,
    student,
    now,
    randomBytes: fixedRandomBytes,
    idFactory: () => "grant-1",
  });
  const first = consumeAylaPilotLoginGrant({
    grants: [grant],
    token,
    usersById: { [user.id]: user },
    studentsById: { [student.id]: student },
    now: new Date("2026-07-30T10:01:00.000Z"),
  });
  assert.equal(first.grant.status, "used");
  assert.equal(first.grant.usedAt, "2026-07-30T10:01:00.000Z");

  for (const invalidGrant of [
    first.grant,
    { ...grant, expiresAt: "2026-07-30T09:59:59.000Z" },
  ]) {
    assert.throws(
      () => consumeAylaPilotLoginGrant({
        grants: [invalidGrant],
        token,
        usersById: { [user.id]: user },
        studentsById: { [student.id]: student },
        now,
      }),
      (error) => error.statusCode === 401
        && error.code === "PILOT_LOGIN_INVALID"
        && error.message === "Invalid or expired pilot access link",
    );
  }
});

test("pilot grant creation rejects real students", () => {
  assert.throws(
    () => createAylaPilotLoginGrant({
      user: { ...user, email: "real.student@example.com" },
      student,
      now,
    }),
    (error) => error.statusCode === 409 && error.code === "PILOT_LOGIN_ACCOUNT_REQUIRED",
  );
});

test("server exposes only the admin creation and public fragment-exchange routes", () => {
  const serverSource = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(serverSource, /app\.post\("\/api\/ayla\/admin\/pilot-login-links"/);
  assert.match(serverSource, /app\.post\("\/api\/ayla\/auth\/pilot-exchange"/);
  assert.match(serverSource, /CREATE ONE-TIME LINK FOR/);
  assert.match(serverSource, /res\.setHeader\("Cache-Control", "no-store"\)/);
  assert.doesNotMatch(serverSource, /pilot-access\?token=/);
});
