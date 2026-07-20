export const STUDENT_PROFILE_CONTRACT_VERSION = "v219.1";

export const STUDENT_PROFILE_POLICY = Object.freeze({
  update_limit: 10,
  update_window_seconds: 60 * 60,
  display_name_cooldown_seconds: 24 * 60 * 60,
  username_cooldown_seconds: 30 * 24 * 60 * 60,
  visibility_options: ["private", "students_only"],
  public_fields: ["display_name", "username", "bio", "profile_visibility", "discoverable", "avatar_url"],
  private_fields: [
    "phone",
    "phone_verified",
    "address_line_1",
    "address_line_2",
    "city",
    "region",
    "postal_code",
    "country_code",
    "timezone",
    "language",
  ],
  read_only_fields: [
    "email",
    "email_verified",
    "avatar_url",
    "role",
    "status",
    "student_id",
    "exam_track",
    "enrollments",
    "payments",
    "plans",
    "entitlements",
    "scores",
    "points",
  ],
  limits: {
    display_name: 60,
    username: 30,
    bio: 280,
    phone_digits: 15,
    address_line_1: 120,
    address_line_2: 120,
    city: 80,
    region: 80,
    postal_code: 20,
    country_code: 2,
    timezone: 64,
    language: 35,
  },
});

const PROFILE_ALIASES = Object.freeze({
  display_name: ["display_name", "displayName", "name"],
  username: ["username", "public_username", "publicUsername"],
  bio: ["bio"],
  phone: ["phone", "phone_number", "phoneNumber"],
  address_line_1: ["address_line_1", "addressLine1", "address"],
  address_line_2: ["address_line_2", "addressLine2"],
  city: ["city", "locality"],
  region: ["region", "state", "province"],
  postal_code: ["postal_code", "postalCode", "zip_code", "zipCode"],
  country_code: ["country_code", "countryCode", "country"],
  timezone: ["timezone", "time_zone", "timeZone"],
  language: ["language", "locale", "preferred_language", "preferredLanguage"],
  profile_visibility: ["profile_visibility", "profileVisibility", "visibility"],
  discoverable: ["discoverable", "profile_discoverable", "profileDiscoverable"],
});

const ADDRESS_ALIASES = Object.freeze({
  address_line_1: ["line_1", "line1", "address_line_1", "addressLine1"],
  address_line_2: ["line_2", "line2", "address_line_2", "addressLine2"],
  city: ["city", "locality"],
  region: ["region", "state", "province"],
  postal_code: ["postal_code", "postalCode", "zip_code", "zipCode"],
  country_code: ["country_code", "countryCode", "country"],
});

const KNOWN_PROFILE_KEYS = new Set([
  "profile",
  ...Object.values(PROFILE_ALIASES).flat(),
]);

const PUBLIC_FIELDS = new Set([
  "display_name",
  "username",
  "bio",
  "profile_visibility",
  "discoverable",
]);

const PROFANITY = [
  "fuck", "fucker", "fucking", "motherfucker", "shit", "bitch", "bastard", "asshole", "porn",
  "dick", "pussy", "cunt", "whore", "slut", "nigger", "nigga", "fag", "faggot",
  "harami", "madarchod", "behenchod", "benchod", "chutiya", "gaand", "gandu",
];

const MODERATION_ALLOWLIST = new Set([
  "pakistan", "pakistani", "pakistanis", "pak", "kafir", "kafirs",
]);

const RESERVED_IDENTITIES = new Set([
  "admin", "administrator", "moderator", "mod", "support", "staff", "official", "system",
  "root", "security", "aylamed", "aylamedai", "nextgen", "nextgenusmle",
  "aylamedsupport", "nextgensupport", "nextgenstudentservices", "supportteam", "customersupport",
  "studentservices", "moderationteam", "adminteam", "officialsupport",
]);

const ISO_COUNTRY_CODES = new Set((
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ "
  + "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR "
  + "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP "
  + "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT "
  + "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW "
  + "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG "
  + "UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW XK"
).split(" "));

const CONTROL_OR_INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u;
const PUBLIC_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const PUBLIC_URL = /(?:\bhttps?:\/\/|\bwww\.|\b[a-z0-9][a-z0-9.-]*\.(?:com|net|org|io|co|me|app|pk|uk|ca|au|edu|gg)\b)/iu;
const PUBLIC_PHONE = /(?:\+?\d[\s().-]*){8,}/u;
const PUBLIC_HANDLE = /(^|\s)@[A-Z0-9_.-]{3,}\b/iu;

function profileError(message, code = "INVALID_STUDENT_PROFILE", statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function codePointLength(value = "") {
  return [...String(value || "")].length;
}

function normalizePlainText(value, field, { multiline = false } = {}) {
  if (value === null || value === undefined) return "";
  if (!["string", "number"].includes(typeof value)) {
    throw profileError(`${field} must be text`, "PROFILE_FIELD_TYPE_INVALID");
  }
  let output = String(value).normalize("NFKC").replace(/\r\n?/g, "\n");
  if (CONTROL_OR_INVISIBLE.test(output)) {
    throw profileError(`${field} contains hidden or unsupported control characters`, "PROFILE_HIDDEN_CHARACTERS");
  }
  if (/[<>]/u.test(output)) {
    throw profileError(`${field} must be plain text without HTML`, "PROFILE_HTML_NOT_ALLOWED");
  }
  if (!multiline && output.includes("\n")) {
    throw profileError(`${field} must be a single line`, "PROFILE_LINE_BREAK_NOT_ALLOWED");
  }
  if (multiline) {
    output = output
      .split("\n")
      .map((line) => line.replace(/[\t ]+/g, " ").trim())
      .filter((line, index, rows) => line || (index > 0 && rows[index - 1]))
      .join("\n")
      .trim();
    if (output.split("\n").length > 4) {
      throw profileError(`${field} can contain at most 4 lines`, "PROFILE_TOO_MANY_LINES");
    }
    return output;
  }
  return output.replace(/\s+/gu, " ").trim();
}

function moderationKey(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/0/g, "o")
    .replace(/[1!]/g, "i")
    .replace(/3/g, "e")
    .replace(/[4@]/g, "a")
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function moderationTokens(value = "") {
  const normalized = String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/0/g, "o")
    .replace(/[1!]/g, "i")
    .replace(/3/g, "e")
    .replace(/[4@]/g, "a")
    .replace(/[5$]/g, "s")
    .replace(/7/g, "t");
  return normalized.split(/[^\p{L}\p{N}]+/gu).map(moderationKey).filter(Boolean);
}

export function moderateStudentProfileText(value = "", { extraBlockedWords = [], strictCompact = false } = {}) {
  const tokens = moderationTokens(value);
  const blocked = [...PROFANITY, ...(Array.isArray(extraBlockedWords) ? extraBlockedWords : [])]
    .map(moderationKey)
    .filter((word) => word.length >= 3 && !MODERATION_ALLOWLIST.has(word));
  const blockedSet = new Set(blocked);

  const exact = tokens.find((token) => blockedSet.has(token) && !MODERATION_ALLOWLIST.has(token));
  if (exact) return { ok: false, mode: "exact_token" };

  for (let start = 0; start < tokens.length; start += 1) {
    if (codePointLength(tokens[start]) !== 1) continue;
    let joined = "";
    for (let end = start; end < Math.min(tokens.length, start + 16); end += 1) {
      if (codePointLength(tokens[end]) !== 1) break;
      joined += tokens[end];
      if (blockedSet.has(joined) && !MODERATION_ALLOWLIST.has(joined)) {
        return { ok: false, mode: "spaced_bypass" };
      }
    }
  }

  if (strictCompact) {
    const compact = moderationKey(value);
    const embedded = blocked.find((word) => word.length >= 4 && word !== "dick" && compact.includes(word));
    if (embedded) return { ok: false, mode: "embedded_bypass" };
  }

  return { ok: true, mode: null };
}

export function studentProfileContainsPublicContact(value = "") {
  const text = String(value || "");
  return PUBLIC_EMAIL.test(text) || PUBLIC_URL.test(text) || PUBLIC_PHONE.test(text) || PUBLIC_HANDLE.test(text);
}

function assertProfessionalPublicText(value, field, options = {}) {
  const moderation = moderateStudentProfileText(value, {
    extraBlockedWords: options.extraBlockedWords,
    strictCompact: true,
  });
  if (!moderation.ok) {
    throw profileError(`Please choose a professional ${field.replaceAll("_", " ")}`, "PROFILE_LANGUAGE_NOT_ALLOWED");
  }
  if (studentProfileContainsPublicContact(value)) {
    throw profileError(`${field.replaceAll("_", " ")} cannot publish phone numbers, email addresses, links, or social handles`, "PROFILE_PUBLIC_CONTACT_NOT_ALLOWED");
  }
}

function assertLength(value, field, min, max) {
  const length = codePointLength(value);
  if (length < min || length > max) {
    throw profileError(`${field.replaceAll("_", " ")} must be between ${min} and ${max} characters`, "PROFILE_LENGTH_INVALID");
  }
}

function normalizeDisplayName(value, options) {
  const output = normalizePlainText(value, "display_name");
  assertLength(output, "display_name", 2, STUDENT_PROFILE_POLICY.limits.display_name);
  if (!/^[\p{L}\p{M}\p{N} .\-'’]+$/u.test(output) || !/[\p{L}\p{N}]/u.test(output)) {
    throw profileError("Display name can only include letters, numbers, spaces, apostrophes, periods, and hyphens", "PROFILE_DISPLAY_NAME_INVALID");
  }
  const identity = moderationKey(output);
  if (RESERVED_IDENTITIES.has(identity) || /^(?:official)?(?:aylamed|nextgenusmle)(?:official|support|staff)?$/u.test(identity)) {
    throw profileError("This display name is reserved for official platform accounts", "PROFILE_IDENTITY_RESERVED");
  }
  assertProfessionalPublicText(output, "display_name", options);
  return output;
}

function normalizeUsername(value, options) {
  const output = normalizePlainText(value, "username").toLocaleLowerCase("en-US");
  if (!output) return "";
  assertLength(output, "username", 3, STUDENT_PROFILE_POLICY.limits.username);
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,28}[a-z0-9])$/u.test(output) || /[._-]{2,}/u.test(output)) {
    throw profileError("Username must use 3–30 lowercase letters, numbers, dots, dashes, or underscores and cannot start or end with punctuation", "PROFILE_USERNAME_INVALID");
  }
  const identity = moderationKey(output);
  if (RESERVED_IDENTITIES.has(identity) || [...RESERVED_IDENTITIES].some((word) => identity === `${word}official` || identity === `official${word}`)) {
    throw profileError("This username is reserved for official platform accounts", "PROFILE_IDENTITY_RESERVED");
  }
  assertProfessionalPublicText(output, "username", options);
  return output;
}

function normalizeBio(value, options) {
  const output = normalizePlainText(value, "bio", { multiline: true });
  if (codePointLength(output) > STUDENT_PROFILE_POLICY.limits.bio) {
    throw profileError(`Bio must be ${STUDENT_PROFILE_POLICY.limits.bio} characters or fewer`, "PROFILE_LENGTH_INVALID");
  }
  if (output) assertProfessionalPublicText(output, "bio", options);
  return output;
}

export function normalizeStudentProfilePhone(value) {
  const output = normalizePlainText(value, "phone");
  if (!output) return "";
  let compact = output.replace(/[\s().-]/g, "");
  if (compact.startsWith("00")) compact = `+${compact.slice(2)}`;
  if (!/^\+[1-9]\d{7,14}$/u.test(compact)) {
    throw profileError("Phone must use international E.164 format, for example +923001234567", "PROFILE_PHONE_INVALID");
  }
  return compact;
}

function normalizeAddress(value, field, max) {
  const output = normalizePlainText(value, field);
  if (codePointLength(output) > max) {
    throw profileError(`${field.replaceAll("_", " ")} must be ${max} characters or fewer`, "PROFILE_LENGTH_INVALID");
  }
  if (output && !/^[\p{L}\p{M}\p{N} .,'’#()\/&:-]+$/u.test(output)) {
    throw profileError(`${field.replaceAll("_", " ")} contains unsupported characters`, "PROFILE_ADDRESS_INVALID");
  }
  return output;
}

function normalizePostalCode(value) {
  const output = normalizePlainText(value, "postal_code").toLocaleUpperCase("en-US");
  if (codePointLength(output) > STUDENT_PROFILE_POLICY.limits.postal_code || (output && !/^[A-Z0-9 -]+$/u.test(output))) {
    throw profileError("Postal code must use 20 or fewer letters, numbers, spaces, or hyphens", "PROFILE_POSTAL_CODE_INVALID");
  }
  return output;
}

function normalizeCountryCode(value) {
  const output = normalizePlainText(value, "country_code").toLocaleUpperCase("en-US");
  if (output && (!/^[A-Z]{2}$/u.test(output) || !ISO_COUNTRY_CODES.has(output))) {
    throw profileError("Country must use a two-letter ISO country code", "PROFILE_COUNTRY_CODE_INVALID");
  }
  return output;
}

function normalizeTimezone(value) {
  const output = normalizePlainText(value, "timezone");
  if (!output) return "";
  if (codePointLength(output) > STUDENT_PROFILE_POLICY.limits.timezone) {
    throw profileError("Timezone is too long", "PROFILE_TIMEZONE_INVALID");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: output }).format();
  } catch {
    throw profileError("Timezone must be a valid IANA timezone such as Asia/Karachi", "PROFILE_TIMEZONE_INVALID");
  }
  return output;
}

function normalizeLanguage(value) {
  const output = normalizePlainText(value, "language");
  if (!output) return "";
  if (codePointLength(output) > STUDENT_PROFILE_POLICY.limits.language) {
    throw profileError("Language code is too long", "PROFILE_LANGUAGE_INVALID");
  }
  try {
    return Intl.getCanonicalLocales(output)[0] || "";
  } catch {
    throw profileError("Language must be a valid BCP 47 code such as en, ur, or en-US", "PROFILE_LANGUAGE_INVALID");
  }
}

function normalizeVisibility(value) {
  const output = normalizePlainText(value, "profile_visibility").toLocaleLowerCase("en-US");
  if (!STUDENT_PROFILE_POLICY.visibility_options.includes(output)) {
    throw profileError("Profile visibility must be private or students_only", "PROFILE_VISIBILITY_INVALID");
  }
  return output;
}

function normalizeDiscoverable(value) {
  if (typeof value !== "boolean") {
    throw profileError("discoverable must be true or false", "PROFILE_DISCOVERABLE_INVALID");
  }
  return value;
}

function keyFingerprint(key = "") {
  return String(key || "").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

function isImmutableProfileKey(key) {
  const clean = keyFingerprint(key);
  return /^(?:id|userid|studentid|email|emailverified|role|status|verified|phoneverified|password|passwordhash|salt|authversion|authprovider|permissions?|enrollments?|payments?|plans?|entitlements?|exam|examtrack|examtrackid|points?|scores?|createdat|updatedat|avatarurl|profileimageurl)$/u.test(clean);
}

function flattenProfilePayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw profileError("Profile update must be a JSON object", "PROFILE_PAYLOAD_INVALID");
  }
  const nested = payload.profile;
  if (nested !== undefined && (!nested || typeof nested !== "object" || Array.isArray(nested))) {
    throw profileError("profile must be a JSON object", "PROFILE_PAYLOAD_INVALID");
  }
  for (const [key, value] of Object.entries(nested || {})) {
    if (key !== "profile" && Object.prototype.hasOwnProperty.call(payload, key) && JSON.stringify(payload[key]) !== JSON.stringify(value)) {
      throw profileError(`Conflicting values were supplied for ${key}`, "PROFILE_FIELD_CONFLICT");
    }
  }
  const source = { ...payload, ...(nested || {}) };
  delete source.profile;
  if (source.address && typeof source.address === "object" && !Array.isArray(source.address)) {
    const address = source.address;
    const allowedAddressKeys = new Set(Object.values(ADDRESS_ALIASES).flat());
    const forbiddenAddressKeys = Object.keys(address).filter(isImmutableProfileKey);
    if (forbiddenAddressKeys.length) {
      throw profileError(
        `Security-controlled profile fields cannot be nested in address: ${forbiddenAddressKeys.join(", ")}`,
        "PROFILE_FIELD_IMMUTABLE",
        403,
        { fields: forbiddenAddressKeys.map((key) => `address.${key}`) },
      );
    }
    const unknownAddressKeys = Object.keys(address).filter((key) => !allowedAddressKeys.has(key));
    if (unknownAddressKeys.length) {
      throw profileError(
        `Unsupported address fields: ${unknownAddressKeys.join(", ")}`,
        "PROFILE_FIELD_UNSUPPORTED",
        400,
        { fields: unknownAddressKeys.map((key) => `address.${key}`) },
      );
    }
    for (const [field, aliases] of Object.entries(ADDRESS_ALIASES)) {
      const nestedAliases = aliases.filter((alias) => Object.prototype.hasOwnProperty.call(address, alias));
      if (!nestedAliases.length) continue;
      const nestedValues = nestedAliases.map((alias) => address[alias]);
      if (new Set(nestedValues.map((value) => JSON.stringify(value))).size > 1) {
        throw profileError(`Conflicting values were supplied for address.${field}`, "PROFILE_FIELD_CONFLICT");
      }
      const topAliases = PROFILE_ALIASES[field]
        .filter((alias) => alias !== "address" && Object.prototype.hasOwnProperty.call(source, alias));
      const allValues = [...topAliases.map((alias) => source[alias]), nestedValues[0]];
      if (new Set(allValues.map((value) => JSON.stringify(value))).size > 1) {
        throw profileError(`Conflicting values were supplied for ${field}`, "PROFILE_FIELD_CONFLICT");
      }
      source[field] = nestedValues[0];
    }
    delete source.address;
  }
  return source;
}

export function extractStudentProfilePatch(payload = {}, { ignoreUnknown = false } = {}) {
  const source = flattenProfilePayload(payload);
  const forbidden = Object.keys(source).filter(isImmutableProfileKey);
  if (forbidden.length) {
    throw profileError(
      `Security-controlled profile fields cannot be edited here: ${forbidden.join(", ")}`,
      "PROFILE_FIELD_IMMUTABLE",
      403,
      { fields: forbidden },
    );
  }
  if (!ignoreUnknown) {
    const unknown = Object.keys(source).filter((key) => !KNOWN_PROFILE_KEYS.has(key));
    if (unknown.length) {
      throw profileError(`Unsupported profile fields: ${unknown.join(", ")}`, "PROFILE_FIELD_UNSUPPORTED", 400, { fields: unknown });
    }
  }

  const patch = {};
  for (const [field, aliases] of Object.entries(PROFILE_ALIASES)) {
    const supplied = aliases.filter((alias) => Object.prototype.hasOwnProperty.call(source, alias));
    if (!supplied.length) continue;
    const values = supplied.map((alias) => source[alias]);
    const signatures = new Set(values.map((value) => JSON.stringify(value)));
    if (signatures.size > 1) {
      throw profileError(`Conflicting values were supplied for ${field}`, "PROFILE_FIELD_CONFLICT");
    }
    patch[field] = values[0];
  }
  if (!Object.keys(patch).length) {
    throw profileError("Provide at least one editable profile field", "PROFILE_PATCH_EMPTY");
  }
  return patch;
}

function legacyProfileValue(record, profile, field, aliases = []) {
  if (profile[field] !== undefined && profile[field] !== null) return profile[field];
  for (const alias of aliases) {
    if (record?.[alias] !== undefined && record?.[alias] !== null) return record[alias];
  }
  return "";
}

export function normalizeStudentProfileRecord(record = {}) {
  const stored = record?.student_profile && typeof record.student_profile === "object"
    ? record.student_profile
    : record?.studentProfile && typeof record.studentProfile === "object"
      ? record.studentProfile
      : {};
  const address = stored.address && typeof stored.address === "object" ? stored.address : {};
  const visibility = String(legacyProfileValue(record, stored, "profile_visibility", ["profile_visibility", "profileVisibility"]) || "private");
  return {
    contract_version: STUDENT_PROFILE_CONTRACT_VERSION,
    display_name: String(legacyProfileValue(record, stored, "display_name", ["display_name", "displayName", "name"]) || ""),
    username: String(legacyProfileValue(record, stored, "username", ["public_username", "publicUsername", "username"]) || ""),
    bio: String(legacyProfileValue(record, stored, "bio", ["bio"]) || ""),
    phone: String(legacyProfileValue(record, stored, "phone", ["phone"]) || ""),
    phone_verified: stored.phone_verified === true || record.phone_verified === true || record.phoneVerified === true,
    phone_verified_at: stored.phone_verified_at || record.phone_verified_at || record.phoneVerifiedAt || null,
    address_line_1: String(stored.address_line_1 ?? address.line_1 ?? record.address_line_1 ?? record.addressLine1 ?? ""),
    address_line_2: String(stored.address_line_2 ?? address.line_2 ?? record.address_line_2 ?? record.addressLine2 ?? ""),
    city: String(stored.city ?? address.city ?? record.city ?? ""),
    region: String(stored.region ?? address.region ?? record.region ?? record.state ?? record.province ?? ""),
    postal_code: String(stored.postal_code ?? address.postal_code ?? record.postal_code ?? record.postalCode ?? ""),
    country_code: String(stored.country_code ?? address.country_code ?? record.country_code ?? record.countryCode ?? ""),
    timezone: String(legacyProfileValue(record, stored, "timezone", ["timezone"]) || ""),
    language: String(legacyProfileValue(record, stored, "language", ["language", "locale"]) || ""),
    profile_visibility: STUDENT_PROFILE_POLICY.visibility_options.includes(visibility) ? visibility : "private",
    discoverable: stored.discoverable === true || record.discoverable === true,
    display_name_changed_at: stored.display_name_changed_at || record.display_name_changed_at || record.displayNameChangedAt || null,
    username_changed_at: stored.username_changed_at || record.username_changed_at || record.usernameChangedAt || null,
    created_at: stored.created_at || record.created_at || record.createdAt || null,
    updated_at: stored.updated_at || record.updated_at || record.updatedAt || null,
  };
}

function normalizeField(field, value, options) {
  switch (field) {
    case "display_name": return normalizeDisplayName(value, options);
    case "username": return normalizeUsername(value, options);
    case "bio": return normalizeBio(value, options);
    case "phone": return normalizeStudentProfilePhone(value);
    case "address_line_1": return normalizeAddress(value, field, STUDENT_PROFILE_POLICY.limits.address_line_1);
    case "address_line_2": return normalizeAddress(value, field, STUDENT_PROFILE_POLICY.limits.address_line_2);
    case "city": return normalizeAddress(value, field, STUDENT_PROFILE_POLICY.limits.city);
    case "region": return normalizeAddress(value, field, STUDENT_PROFILE_POLICY.limits.region);
    case "postal_code": return normalizePostalCode(value);
    case "country_code": return normalizeCountryCode(value);
    case "timezone": return normalizeTimezone(value);
    case "language": return normalizeLanguage(value);
    case "profile_visibility": return normalizeVisibility(value);
    case "discoverable": return normalizeDiscoverable(value);
    default: throw profileError(`Unsupported profile field: ${field}`, "PROFILE_FIELD_UNSUPPORTED");
  }
}

function eventTimestamp(event = {}) {
  const timestamp = event.created_at || event.createdAt || event.timestamp || null;
  const parsed = timestamp ? new Date(timestamp).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function assertUpdateRate(events, userId, nowMs) {
  const windowMs = STUDENT_PROFILE_POLICY.update_window_seconds * 1000;
  const recent = (Array.isArray(events) ? events : Object.values(events || {}))
    .filter((event) => String(event.user_id || event.userId || "") === String(userId || ""))
    .map(eventTimestamp)
    .filter((timestamp) => timestamp !== null && timestamp > nowMs - windowMs && timestamp <= nowMs);
  if (recent.length < STUDENT_PROFILE_POLICY.update_limit) return;
  const earliest = Math.min(...recent);
  const retryAfterSeconds = Math.max(1, Math.ceil((earliest + windowMs - nowMs) / 1000));
  throw profileError("Too many profile changes. Please wait before trying again.", "PROFILE_RATE_LIMITED", 429, { retry_after_seconds: retryAfterSeconds });
}

function assertCooldown(field, lastChangedAt, cooldownSeconds, nowMs) {
  if (!lastChangedAt) return;
  const changedMs = new Date(lastChangedAt).getTime();
  if (!Number.isFinite(changedMs) || changedMs > nowMs) return;
  const retryAfterSeconds = Math.ceil((changedMs + cooldownSeconds * 1000 - nowMs) / 1000);
  if (retryAfterSeconds > 0) {
    throw profileError(`${field.replaceAll("_", " ")} was changed recently. Please wait before changing it again.`, "PROFILE_FIELD_COOLDOWN", 429, { field, retry_after_seconds: retryAfterSeconds });
  }
}

export function applyStudentProfilePatch(record = {}, payload = {}, options = {}) {
  const patch = options.payloadIsCanonical === true ? payload : extractStudentProfilePatch(payload);
  const current = normalizeStudentProfileRecord(record);
  const next = { ...current };
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw profileError("Profile update time is invalid", "PROFILE_TIME_INVALID", 500);
  const nowIso = now.toISOString();
  assertUpdateRate(options.events || [], options.userId || record.id, nowMs);

  const changedFields = [];
  for (const [field, rawValue] of Object.entries(patch)) {
    const normalized = normalizeField(field, rawValue, options);
    if (normalized === current[field]) continue;
    if (field === "display_name" && current.display_name) {
      assertCooldown(field, current.display_name_changed_at, STUDENT_PROFILE_POLICY.display_name_cooldown_seconds, nowMs);
    }
    if (field === "username" && current.username && normalized) {
      assertCooldown(field, current.username_changed_at, STUDENT_PROFILE_POLICY.username_cooldown_seconds, nowMs);
    }
    if (field === "username" && normalized && typeof options.isUsernameAvailable === "function" && !options.isUsernameAvailable(normalized)) {
      throw profileError("This username is already taken", "PROFILE_USERNAME_TAKEN", 409);
    }
    next[field] = normalized;
    changedFields.push(field);
  }

  if (!changedFields.length) {
    return { changed: false, changedFields: [], publicChangedFields: [], phoneChanged: false, profile: current };
  }

  if (changedFields.includes("profile_visibility") && next.profile_visibility === "private" && next.discoverable) {
    next.discoverable = false;
    if (!changedFields.includes("discoverable")) changedFields.push("discoverable");
  }
  if (next.discoverable && next.profile_visibility !== "students_only") {
    throw profileError("A discoverable profile must use students_only visibility", "PROFILE_DISCOVERABILITY_CONFLICT");
  }
  if (next.discoverable && !next.username) {
    throw profileError("Set a username before making the profile discoverable", "PROFILE_USERNAME_REQUIRED");
  }

  const phoneChanged = changedFields.includes("phone");
  if (phoneChanged) {
    next.phone_verified = false;
    next.phone_verified_at = null;
  }
  if (changedFields.includes("display_name")) next.display_name_changed_at = nowIso;
  if (changedFields.includes("username")) next.username_changed_at = nowIso;
  next.contract_version = STUDENT_PROFILE_CONTRACT_VERSION;
  next.created_at = next.created_at || nowIso;
  next.updated_at = nowIso;

  return {
    changed: true,
    changedFields,
    publicChangedFields: changedFields.filter((field) => PUBLIC_FIELDS.has(field)),
    phoneChanged,
    profile: next,
  };
}

function avatarForRecord(record = {}) {
  return record.avatar_url || record.avatarUrl || record.profileImageUrl || record.profile_image_url || "";
}

export function sanitizeStudentProfileForOwner(record = {}) {
  const profile = normalizeStudentProfileRecord(record);
  return {
    contract_version: STUDENT_PROFILE_CONTRACT_VERSION,
    display_name: profile.display_name,
    username: profile.username,
    bio: profile.bio,
    profile_visibility: profile.profile_visibility,
    discoverable: profile.discoverable,
    avatar_url: avatarForRecord(record) || null,
    email: String(record.email || ""),
    email_verified: record.email_verified === true || record.emailVerified === true || record.verified === true,
    phone: profile.phone,
    phone_verified: profile.phone_verified,
    address_line_1: profile.address_line_1,
    address_line_2: profile.address_line_2,
    city: profile.city,
    region: profile.region,
    postal_code: profile.postal_code,
    country_code: profile.country_code,
    timezone: profile.timezone,
    language: profile.language,
    updated_at: profile.updated_at,
  };
}

export function sanitizeStudentProfileForPublic(record = {}) {
  const profile = normalizeStudentProfileRecord(record);
  if (profile.profile_visibility !== "students_only") return null;
  return {
    contract_version: STUDENT_PROFILE_CONTRACT_VERSION,
    display_name: profile.display_name,
    username: profile.username,
    bio: profile.bio,
    avatar_url: avatarForRecord(record) || null,
    profile_visibility: "students_only",
    discoverable: profile.discoverable,
  };
}

export function studentProfilePolicy() {
  return JSON.parse(JSON.stringify({
    contract_version: STUDENT_PROFILE_CONTRACT_VERSION,
    ...STUDENT_PROFILE_POLICY,
    privacy: {
      phone_and_address: "owner_only",
      profile_audience: "authenticated_students_only",
      email_change: "separate_reverification_required",
      phone_change: "stored_unverified_and_never_used_as_an_authenticator",
      avatar_change: "managed_upload_required",
      audit_values: "field_names_only",
    },
  }));
}
