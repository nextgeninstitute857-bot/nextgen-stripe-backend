import test from "node:test";
import assert from "node:assert/strict";

import { resolveLmsSmtpAuthMethod } from "../lib/email-auth.js";

test("LMS SMTP defaults to Hostinger-compatible LOGIN authentication", () => {
  assert.equal(resolveLmsSmtpAuthMethod(), "LOGIN");
  assert.equal(resolveLmsSmtpAuthMethod(""), "LOGIN");
  assert.equal(resolveLmsSmtpAuthMethod(" login "), "LOGIN");
});

test("LMS SMTP still permits an explicit supported override", () => {
  assert.equal(resolveLmsSmtpAuthMethod("plain"), "PLAIN");
});
