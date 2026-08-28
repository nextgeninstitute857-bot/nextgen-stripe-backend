import crypto from "crypto";

export const NEXTGEN_PUSH_APP_ID = "com.nextgenusmle.live";
const PLATFORMS = new Set(["ios", "android"]);

function clean(value, max = 512) {
  return String(value || "").trim().slice(0, max);
}

export function validateDeviceRegistration(input = {}) {
  const platform = clean(input.platform, 16).toLowerCase();
  const token = clean(input.token, 4096);
  const appId = clean(input.app_id || input.appId, 200) || NEXTGEN_PUSH_APP_ID;
  const deviceId = clean(input.device_id || input.deviceId, 200);

  if (!PLATFORMS.has(platform)) {
    const error = new Error("platform must be ios or android");
    error.statusCode = 400;
    throw error;
  }
  if (appId !== NEXTGEN_PUSH_APP_ID) {
    const error = new Error("Unknown mobile app");
    error.statusCode = 400;
    throw error;
  }
  if (token.length < 16) {
    const error = new Error("A valid device token is required");
    error.statusCode = 400;
    throw error;
  }
  return { platform, token, app_id: appId, device_id: deviceId || null };
}

export function deviceTokenKey({ platform, token, app_id: appId }) {
  return crypto.createHash("sha256").update(`${appId}\0${platform}\0${token}`).digest("hex");
}

export function registerDeviceToken(records = {}, userId, input, now = new Date().toISOString()) {
  const normalized = validateDeviceRegistration(input);
  const id = deviceTokenKey(normalized);
  const prior = records[id] || {};
  records[id] = {
    id,
    user_id: String(userId),
    platform: normalized.platform,
    token: normalized.token,
    app_id: normalized.app_id,
    device_id: normalized.device_id,
    active: true,
    created_at: prior.created_at || now,
    updated_at: now,
    revoked_at: null,
  };
  return records[id];
}

export function revokeDeviceTokens(records = {}, userId, input = {}, now = new Date().toISOString()) {
  const token = clean(input.token, 4096);
  const deviceId = clean(input.device_id || input.deviceId, 200);
  let revoked = 0;
  for (const record of Object.values(records)) {
    if (!record || String(record.user_id) !== String(userId) || record.active !== true) continue;
    if (token && record.token !== token) continue;
    if (!token && deviceId && record.device_id !== deviceId) continue;
    if (!token && !deviceId) continue;
    record.active = false;
    record.revoked_at = now;
    record.updated_at = now;
    revoked += 1;
  }
  return revoked;
}

export function publicDeviceRegistration(record) {
  return {
    id: record.id,
    platform: record.platform,
    app_id: record.app_id,
    device_id: record.device_id,
    active: record.active === true,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}
