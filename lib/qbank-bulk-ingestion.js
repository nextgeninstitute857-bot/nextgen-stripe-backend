import path from "node:path";
import { normalizeExamTrack, slug } from "./content-import-adapter.js";

export const MIXED_QBANK_UPLOAD_PURPOSE = "mixed_qbank_zip";

export const CONTENT_UPLOAD_PURPOSES = Object.freeze([
  "question_zip",
  "media_zip",
  "image_zip",
  "video_zip",
  MIXED_QBANK_UPLOAD_PURPOSE,
]);

const CONTENT_UPLOAD_PURPOSE_SET = new Set(CONTENT_UPLOAD_PURPOSES);
const VERIFIED_RIGHTS_STATUSES = new Set(["owned", "licensed", "authorized"]);
const BULK_QBANK_SOURCE_PROFILES = new Set([
  "uworld_style",
  "amboss_style",
  "canadaqbank_style",
  "aceqbank_style",
  "amedex_style",
  "mplusx_style",
  "aylamed_original",
  "other",
]);
const BULK_QBANK_DESTINATIONS = new Set([
  "aylamed_qbank",
  "lms_assessment",
  "baseline_diagnostic",
  "roadmap",
  "personal_assessment",
  "revision",
  "flashcards",
  "marketing",
]);

function statusError(message, statusCode = 400, code = "INVALID_QBANK_BULK_REQUEST") {
  return Object.assign(new Error(message), { statusCode, code });
}

function cleanString(value = "", maximum = 240) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, maximum);
}

export function normalizeContentUploadPurpose(value = "question_zip") {
  const purpose = cleanString(value || "question_zip", 80).toLowerCase();
  if (!CONTENT_UPLOAD_PURPOSE_SET.has(purpose)) {
    throw statusError(
      `purpose must be one of ${CONTENT_UPLOAD_PURPOSES.join(", ")}`,
      400,
      "INVALID_CONTENT_UPLOAD_PURPOSE",
    );
  }
  return purpose;
}

export function contentUploadPurposeAllowed(actualPurpose, allowedPurposes = []) {
  const actual = normalizeContentUploadPurpose(actualPurpose);
  const allowed = new Set((Array.isArray(allowedPurposes) ? allowedPurposes : [])
    .map((value) => cleanString(value, 80).toLowerCase())
    .filter(Boolean));
  if (!allowed.size || allowed.has(actual)) return true;
  if (actual === "media_zip" && [...allowed].some((value) =>
    ["media_zip", "image_zip", "video_zip"].includes(value))) {
    return true;
  }
  if (actual === MIXED_QBANK_UPLOAD_PURPOSE && [...allowed].some((value) =>
    ["question_zip", "media_zip", "image_zip", "video_zip", MIXED_QBANK_UPLOAD_PURPOSE].includes(value))) {
    return true;
  }
  return false;
}

export function normalizeContentRightsStatus(value = "unverified") {
  const clean = cleanString(value || "unverified", 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const aliases = {
    unverified: "unverified",
    pending: "unverified",
    pending_review: "unverified",
    unknown: "unverified",
    own: "owned",
    owned: "owned",
    first_party: "owned",
    license: "licensed",
    licensed: "licensed",
    authorised: "authorized",
    authorized: "authorized",
    permission: "authorized",
    permitted: "authorized",
  };
  const normalized = aliases[clean];
  if (!normalized) {
    throw statusError(
      "source_rights_status must be unverified, owned, licensed, or authorized",
      400,
      "INVALID_CONTENT_RIGHTS_STATUS",
    );
  }
  return normalized;
}

export function contentRightsAreVerified(value = "") {
  return VERIFIED_RIGHTS_STATUSES.has(normalizeContentRightsStatus(value));
}

export function inferBulkQbankSourceProfile(provider = "") {
  const clean = cleanString(provider, 160).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (clean.includes("uworld")) return "uworld_style";
  if (clean.includes("amboss")) return "amboss_style";
  if (clean.includes("canadaqbank")) return "canadaqbank_style";
  if (clean.includes("aceqbank")) return "aceqbank_style";
  if (clean.includes("amedex")) return "amedex_style";
  if (clean.includes("mplusx")) return "mplusx_style";
  if (clean.includes("aylamed")) return "aylamed_original";
  return "other";
}

export function normalizeBulkQbankSourceProfile(value = "", provider = "") {
  const clean = cleanString(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const profile = clean || inferBulkQbankSourceProfile(provider);
  if (!BULK_QBANK_SOURCE_PROFILES.has(profile)) {
    throw statusError(
      `Unsupported source_profile ${value}`,
      400,
      "INVALID_QBANK_SOURCE_PROFILE",
    );
  }
  return profile;
}

function normalizeDestinations(input) {
  const rows = Array.isArray(input)
    ? input
    : String(input || "aylamed_qbank").split(",");
  const destinations = [...new Set(rows
    .map((value) => cleanString(value, 80).toLowerCase().replace(/[\s-]+/g, "_"))
    .filter((value) => BULK_QBANK_DESTINATIONS.has(value)))];
  if (!destinations.length) {
    throw statusError(
      "At least one supported private-draft destination is required",
      400,
      "QBANK_DESTINATION_REQUIRED",
    );
  }
  return destinations;
}

export function normalizeBulkQbankBank(input = {}, index = 0) {
  const bundlePath = cleanString(
    input.bundle_zip || input.bundleZip || input.zip || input.path || input.archive,
    2_000,
  );
  if (!bundlePath || !/\.zip$/i.test(bundlePath)) {
    throw statusError(
      `Bank ${index + 1} must reference a prepared .zip bundle`,
      400,
      "QBANK_ZIP_BUNDLE_REQUIRED",
    );
  }
  const examTrack = normalizeExamTrack(input.exam_track || input.examTrack);
  if (!examTrack || examTrack === "unknown") {
    throw statusError(
      `Bank ${index + 1} requires a supported exam_track`,
      400,
      "QBANK_EXAM_TRACK_REQUIRED",
    );
  }
  const sourceProvider = cleanString(input.source_provider || input.sourceProvider, 160);
  if (!sourceProvider) {
    throw statusError(
      `Bank ${index + 1} requires source_provider`,
      400,
      "QBANK_SOURCE_PROVIDER_REQUIRED",
    );
  }
  const sourceNamespace = slug(
    input.source_namespace || input.sourceNamespace || `${sourceProvider}-${examTrack}`,
  );
  if (!sourceNamespace || sourceNamespace === "unknown") {
    throw statusError(
      `Bank ${index + 1} requires source_namespace`,
      400,
      "QBANK_SOURCE_NAMESPACE_REQUIRED",
    );
  }
  const collectionTitle = cleanString(
    input.collection_title
      || input.collectionTitle
      || path.basename(bundlePath).replace(/\.zip$/i, ""),
    240,
  );
  if (!collectionTitle) {
    throw statusError(
      `Bank ${index + 1} requires collection_title`,
      400,
      "QBANK_COLLECTION_TITLE_REQUIRED",
    );
  }
  if (input.draft_only === false || input.draftOnly === false) {
    throw statusError(
      "The v238 bulk workflow is private-draft only",
      400,
      "QBANK_BULK_DRAFT_ONLY",
    );
  }
  return {
    bundle_zip: bundlePath,
    exam_track: examTrack,
    source_provider: sourceProvider,
    source_namespace: sourceNamespace,
    source_profile: normalizeBulkQbankSourceProfile(
      input.source_profile || input.sourceProfile,
      sourceProvider,
    ),
    source_rights_status: normalizeContentRightsStatus(
      input.source_rights_status || input.sourceRightsStatus || "unverified",
    ),
    collection_title: collectionTitle,
    destinations: normalizeDestinations(input.destinations),
    draft_only: true,
    attach_media: input.attach_media !== false && input.attachMedia !== false,
    import_packaged_videos: input.import_packaged_videos === true || input.importPackagedVideos === true,
  };
}

export function normalizeBulkQbankManifest(input = {}) {
  const rows = Array.isArray(input) ? input : input.banks;
  if (!Array.isArray(rows) || !rows.length) {
    throw statusError("The QBank manifest must contain at least one bank");
  }
  if (rows.length > 20) {
    throw statusError("A bulk run cannot contain more than 20 banks", 413);
  }
  const banks = rows.map(normalizeBulkQbankBank);
  const namespaces = new Set();
  for (const bank of banks) {
    const key = `${bank.exam_track}\u0000${bank.source_namespace}`;
    if (namespaces.has(key)) {
      throw statusError(
        `Duplicate exam/source namespace in manifest: ${bank.exam_track}/${bank.source_namespace}`,
        409,
        "DUPLICATE_QBANK_NAMESPACE",
      );
    }
    namespaces.add(key);
  }
  return {
    version: "v238",
    mode: "private_draft_only",
    upload_purpose: MIXED_QBANK_UPLOAD_PURPOSE,
    concurrency: Math.max(1, Math.min(2, Math.trunc(Number(input.concurrency) || 2))),
    apply_safe_link_repairs: input.apply_safe_link_repairs !== false,
    banks,
    rights_verified: banks.every((bank) => contentRightsAreVerified(bank.source_rights_status)),
  };
}
