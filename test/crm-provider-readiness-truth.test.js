import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = fs.readFileSync(path.join(here, "..", "server.js"), "utf8");

test("Meta credentials are not reported as live until permission checks are verified", () => {
  const providerStatus = server.slice(
    server.indexOf("function getProviderStatus()"),
    server.indexOf("function normalizePhoneForWhatsapp"),
  );

  assert.match(providerStatus, /META_PAGE_CONNECTION_VERIFIED/);
  assert.match(providerStatus, /INSTAGRAM_CONNECTION_VERIFIED/);
  assert.match(providerStatus, /ready: facebookVerified/);
  assert.match(providerStatus, /ready: instagramVerified/);
  assert.match(providerStatus, /permission_check_required/);
  assert.match(providerStatus, /credentials are saved, but live Page permissions are not verified/);
  assert.match(providerStatus, /professional account link and live messaging permissions are not verified/);
});
