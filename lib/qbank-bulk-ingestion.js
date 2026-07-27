import crypto from "node:crypto";
import path from "node:path";
import {
  normalizeExamTrack,
  normalizeMediaReferencePath,
  slug,
} from "./content-import-adapter.js";

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
  "aylamed_cdm",
]);
const BULK_QBANK_MEDIA_ALIAS_EVIDENCE = new Set([
  "question_id_and_reference",
  "unique_semantic_suffix",
  "unique_closest_semantic_suffix",
  "admin_verified",
]);

function statusError(message, statusCode = 400, code = "INVALID_QBANK_BULK_REQUEST") {
  return Object.assign(new Error(message), { statusCode, code });
}

function cleanString(value = "", maximum = 240) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, maximum);
}

function parseJsonArray(value, label) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw statusError(`${label} must be a JSON array`, 400, "INVALID_QBANK_MEDIA_ALIASES");
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.aliases)) return parsed.aliases;
  } catch {
    // Use the common validation error below.
  }
  throw statusError(`${label} must be a JSON array`, 400, "INVALID_QBANK_MEDIA_ALIASES");
}

function normalizeMediaAliasPlacement(value = "") {
  const placement = cleanString(value || "", 80).toLowerCase();
  if (!placement) return "";
  if (placement === "question" || placement === "explanation" || /^answer:\d+$/.test(placement)) {
    return placement;
  }
  throw statusError(
    "media alias placement must be question, explanation, or answer:<number>",
    400,
    "INVALID_QBANK_MEDIA_ALIAS_PLACEMENT",
  );
}

export function normalizeBulkQbankMediaAliases(input = []) {
  const rows = parseJsonArray(input, "media_aliases");
  if (rows.length > 5_000) {
    throw statusError(
      "A bank cannot contain more than 5,000 reviewed media aliases",
      413,
      "QBANK_MEDIA_ALIAS_LIMIT",
    );
  }
  const aliases = [];
  const keys = new Set();
  for (const [index, row] of rows.entries()) {
    const sourceItemId = cleanString(
      row?.source_item_id || row?.sourceItemId || row?.question_id || row?.questionId,
      240,
    );
    const mediaRef = normalizeMediaReferencePath(row?.media_ref || row?.mediaRef);
    const assetPath = normalizeMediaReferencePath(row?.asset_path || row?.assetPath);
    const placement = normalizeMediaAliasPlacement(row?.placement);
    const evidence = cleanString(row?.evidence || "admin_verified", 80)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!sourceItemId || !mediaRef || !assetPath) {
      throw statusError(
        `Media alias ${index + 1} requires source_item_id, media_ref and asset_path`,
        400,
        "INVALID_QBANK_MEDIA_ALIAS",
      );
    }
    if (!BULK_QBANK_MEDIA_ALIAS_EVIDENCE.has(evidence)) {
      throw statusError(
        `Unsupported media alias evidence ${evidence}`,
        400,
        "INVALID_QBANK_MEDIA_ALIAS_EVIDENCE",
      );
    }
    const aliasKey = `${sourceItemId}\u0000${placement}\u0000${mediaRef}`;
    if (keys.has(aliasKey)) {
      throw statusError(
        `Duplicate media alias for question ${sourceItemId} and ${mediaRef}`,
        409,
        "DUPLICATE_QBANK_MEDIA_ALIAS",
      );
    }
    keys.add(aliasKey);
    aliases.push({
      alias_key: crypto.createHash("sha256").update(aliasKey).digest("hex"),
      source_item_id: sourceItemId,
      media_ref: mediaRef,
      asset_path: assetPath,
      placement,
      evidence,
      reviewed: true,
    });
  }
  return aliases;
}

export function bulkQbankMediaAliasFingerprint(input = []) {
  const aliases = normalizeBulkQbankMediaAliases(input);
  return aliases.length
    ? crypto.createHash("sha256").update(JSON.stringify(aliases)).digest("hex")
    : "";
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

function normalizeSourceFormat(value = "") {
  const clean = cleanString(value || "single_best_answer_v1", 80)
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (["cdm", "legacy_cdm", "cdm_write_in", "legacy_cdm_write_in"].includes(clean)) {
    return "legacy_cdm_write_in_v1";
  }
  if ([
    "single_best_answer",
    "sba",
    "mcq",
    "universal_uworld_json_zip",
    "universal_uworld_style_json_zip",
  ].includes(clean)) return "single_best_answer_v1";
  if (!["single_best_answer_v1", "legacy_cdm_write_in_v1"].includes(clean)) {
    throw statusError(
      "source_format must be single_best_answer_v1 or legacy_cdm_write_in_v1",
      400,
      "INVALID_QBANK_SOURCE_FORMAT",
    );
  }
  return clean;
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
      "The v239 bulk workflow is private-draft only",
      400,
      "QBANK_BULK_DRAFT_ONLY",
    );
  }
  const mediaAliases = normalizeBulkQbankMediaAliases(
    input.media_aliases || input.mediaAliases || [],
  );
  const sourceFormat = normalizeSourceFormat(input.source_format || input.sourceFormat);
  const destinations = normalizeDestinations(input.destinations);
  if (sourceFormat === "legacy_cdm_write_in_v1") {
    if (examTrack !== "mccqe") {
      throw statusError(
        "Legacy CDM bundles must use the MCCQE exam track",
        409,
        "CDM_EXAM_TRACK_MISMATCH",
      );
    }
    if (!destinations.includes("aylamed_cdm")
      || destinations.some((destination) => !["aylamed_cdm", "roadmap"].includes(destination))) {
      throw statusError(
        "Legacy CDM bundles require aylamed_cdm and may additionally use roadmap; ordinary QBank destinations are forbidden",
        409,
        "CDM_DESTINATION_MISMATCH",
      );
    }
  } else if (destinations.includes("aylamed_cdm")) {
    throw statusError(
      "The aylamed_cdm destination requires legacy_cdm_write_in_v1",
      409,
      "CDM_SOURCE_FORMAT_REQUIRED",
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
    source_format: sourceFormat,
    collection_title: collectionTitle,
    destinations,
    draft_only: true,
    attach_media: input.attach_media !== false && input.attachMedia !== false,
    import_packaged_videos: input.import_packaged_videos === true || input.importPackagedVideos === true,
    media_aliases: mediaAliases,
    media_aliases_fingerprint: bulkQbankMediaAliasFingerprint(mediaAliases),
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
    version: banks.some((bank) => bank.source_format === "legacy_cdm_write_in_v1") ? "v240" : "v239",
    mode: "private_draft_only",
    upload_purpose: MIXED_QBANK_UPLOAD_PURPOSE,
    concurrency: Math.max(1, Math.min(2, Math.trunc(Number(input.concurrency) || 2))),
    apply_safe_link_repairs: input.apply_safe_link_repairs !== false,
    banks,
    rights_verified: banks.every((bank) => contentRightsAreVerified(bank.source_rights_status)),
  };
}
