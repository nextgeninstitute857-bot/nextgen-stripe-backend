import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("AylaMed invitations use a dedicated branded email transport", () => {
  const start = server.indexOf("async function ngAdminMobileSendAylaInvite");
  const end = server.indexOf("async function ngAdminMobileInviteAyla", start);
  assert.ok(start > 0 && end > start, "AylaMed invitation sender should exist");

  const block = server.slice(start, end);
  assert.match(block, /transport:\s*["']aylamed["']/);
  assert.match(block, /brand:\s*["']aylamed["']/);
  assert.match(block, /Temporary password:/);
  assert.match(block, /must change this temporary password immediately/);
  assert.doesNotMatch(block, /Use your existing password/);
});

test("AylaMed transport is isolated from the NextGen SMTP account", () => {
  for (const key of [
    "AYLA_EMAIL_PROVIDER",
    "AYLA_EMAIL_FROM",
    "AYLA_EMAIL_REPLY_TO",
    "AYLA_SMTP_HOST",
    "AYLA_SMTP_PORT",
    "AYLA_SMTP_SECURE",
    "AYLA_SMTP_USER",
    "AYLA_SMTP_PASS",
  ]) {
    assert.match(server, new RegExp(key));
  }
  assert.match(server, /function ngAylaEmailTransportStatus/);
  assert.match(server, /ngEmailTextToHtml\(cleanText, \{ brand: isAylaTransport \? ["']aylamed["']/);
});
