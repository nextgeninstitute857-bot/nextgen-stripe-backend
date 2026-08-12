import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  MIXED_QBANK_UPLOAD_PURPOSE,
  contentAuthorizedExternalReleaseAllowed,
  contentRightsAreVerified,
  contentUploadPurposeAllowed,
  normalizeBulkQbankMediaAliases,
  normalizeBulkQbankManifest,
  normalizeContentRightsStatus,
} from "../lib/qbank-bulk-ingestion.js";

function bank(overrides = {}) {
  return {
    bundle_zip: "./bank.zip",
    exam_track: "usmle-step-1",
    source_provider: "AMBOSS",
    source_namespace: "amboss-step-1-2025",
    collection_title: "AMBOSS Step 1 2025",
    destinations: ["aylamed_qbank", "roadmap"],
    ...overrides,
  };
}

test("one mixed QBank ZIP can drive only the protected question and media lanes", () => {
  for (const purpose of [
    "question_zip",
    "media_zip",
    "image_zip",
    "video_zip",
    MIXED_QBANK_UPLOAD_PURPOSE,
  ]) {
    assert.equal(
      contentUploadPurposeAllowed(MIXED_QBANK_UPLOAD_PURPOSE, [purpose]),
      true,
    );
  }
  assert.equal(
    contentUploadPurposeAllowed("question_zip", ["media_zip"]),
    false,
  );
  assert.equal(
    contentUploadPurposeAllowed(MIXED_QBANK_UPLOAD_PURPOSE, ["unknown"]),
    false,
  );
});

test("bulk manifests are private-draft only, provider-aware, and bounded to two banks at once", () => {
  const manifest = normalizeBulkQbankManifest({
    concurrency: 99,
    banks: [
      bank(),
      bank({
        bundle_zip: "./amedex.zip",
        exam_track: "amc",
        source_provider: "Amedex",
        source_namespace: "amedex-amc-2025",
        collection_title: "Amedex AMC 2025",
      }),
    ],
  });
  assert.equal(manifest.version, "v239");
  assert.equal(manifest.mode, "private_draft_only");
  assert.equal(manifest.upload_purpose, MIXED_QBANK_UPLOAD_PURPOSE);
  assert.equal(manifest.concurrency, 2);
  assert.equal(manifest.banks[0].source_profile, "amboss_style");
  assert.equal(manifest.banks[1].source_profile, "amedex_style");
  assert.equal(manifest.banks.every((row) => row.draft_only), true);
  assert.equal(manifest.rights_verified, false);
  assert.throws(
    () => normalizeBulkQbankManifest({
      banks: [bank(), bank({ bundle_zip: "./duplicate.zip" })],
    }),
    (error) => error.code === "DUPLICATE_QBANK_NAMESPACE",
  );
  assert.throws(
    () => normalizeBulkQbankManifest({ banks: [bank({ draft_only: false })] }),
    (error) => error.code === "QBANK_BULK_DRAFT_ONLY",
  );
});

test("legacy universal JSON ZIP metadata remains compatible with the SBA importer", () => {
  for (const sourceFormat of [
    "universal_uworld_json_zip",
    "Universal UWorld-style JSON ZIP",
  ]) {
    const manifest = normalizeBulkQbankManifest({
      banks: [bank({ source_format: sourceFormat })],
    });
    assert.equal(manifest.banks[0].source_format, "single_best_answer_v1");
  }
});

test("reviewed media aliases are exact, fingerprinted, and cannot alter placement implicitly", () => {
  const aliases = normalizeBulkQbankMediaAliases([
    {
      source_item_id: "3114",
      media_ref: "wp-content/uploads/diagram.bmp",
      asset_path: "prepared/3114_diagram.bmp",
      placement: "question",
      evidence: "question_id_and_reference",
    },
  ]);
  assert.equal(aliases.length, 1);
  assert.match(aliases[0].alias_key, /^[a-f0-9]{64}$/);
  assert.equal(aliases[0].reviewed, true);
  const manifest = normalizeBulkQbankManifest({
    banks: [bank({ media_aliases: aliases })],
  });
  assert.equal(manifest.banks[0].media_aliases.length, 1);
  assert.match(manifest.banks[0].media_aliases_fingerprint, /^[a-f0-9]{64}$/);
  assert.throws(
    () => normalizeBulkQbankMediaAliases([{
      source_item_id: "3114",
      media_ref: "diagram.bmp",
      asset_path: "prepared/diagram.bmp",
      placement: "answer",
    }]),
    (error) => error.code === "INVALID_QBANK_MEDIA_ALIAS_PLACEMENT",
  );
});

test("legacy CDM manifests are MCCQE-only and cannot enter SBA destinations", () => {
  const manifest = normalizeBulkQbankManifest({
    banks: [bank({
      bundle_zip: "./ace-cdm.zip",
      exam_track: "mccqe",
      source_provider: "ACE QBank",
      source_namespace: "aceqbank-cdm-2024",
      collection_title: "ACE Legacy CDM 2024",
      source_format: "legacy_cdm_write_in_v1",
      destinations: ["aylamed_cdm", "roadmap"],
    })],
  });
  assert.equal(manifest.version, "v240");
  assert.equal(manifest.banks[0].source_profile, "aceqbank_style");
  assert.equal(manifest.banks[0].source_format, "legacy_cdm_write_in_v1");
  assert.throws(
    () => normalizeBulkQbankManifest({
      banks: [bank({
        source_format: "legacy_cdm_write_in_v1",
        destinations: ["aylamed_cdm", "aylamed_qbank"],
      })],
    }),
    (error) => error.code === "CDM_EXAM_TRACK_MISMATCH"
      || error.code === "CDM_DESTINATION_MISMATCH",
  );
  assert.throws(
    () => normalizeBulkQbankManifest({
      banks: [bank({ destinations: ["aylamed_cdm"] })],
    }),
    (error) => error.code === "CDM_SOURCE_FORMAT_REQUIRED",
  );
});

test("rights metadata permits private preparation but distinguishes verified distribution rights", () => {
  assert.equal(normalizeContentRightsStatus("pending review"), "unverified");
  assert.equal(normalizeContentRightsStatus("authorised"), "authorized");
  assert.equal(contentRightsAreVerified("unverified"), false);
  for (const status of ["owned", "licensed", "authorized"]) {
    assert.equal(contentRightsAreVerified(status), true);
    const manifest = normalizeBulkQbankManifest({
      banks: [bank({ source_rights_status: status })],
    });
    assert.equal(manifest.rights_verified, true);
  }
});

test("authorized external release is restricted to the confirmed provider and exam scopes", () => {
  for (const row of [
    { source_provider: "Amedex", source_profile: "amedex_style", exam_track: "amc" },
    { source_provider: "MPlusX", source_profile: "mplusx_style", exam_track: "amc" },
    { source_provider: "CanadaQBank", source_profile: "canadaqbank_style", exam_track: "mccqe" },
    { source_provider: "ACE QBank", source_profile: "aceqbank_style", exam_track: "mccqe" },
    { source_provider: "UWorld", source_profile: "uworld_style", exam_track: "usmle-step-2" },
    { source_provider: "UWorld", source_profile: "uworld_style", exam_track: "usmle-step-3" },
  ]) {
    assert.equal(contentAuthorizedExternalReleaseAllowed({
      ...row,
      source_rights_status: "authorized",
    }), true);
  }
  assert.equal(contentAuthorizedExternalReleaseAllowed({
    source_provider: "UWorld",
    source_profile: "uworld_style",
    exam_track: "amc",
    source_rights_status: "authorized",
  }), false);
  assert.equal(contentAuthorizedExternalReleaseAllowed({
    source_provider: "Amedex",
    source_profile: "amedex_style",
    exam_track: "amc",
    source_rights_status: "unverified",
  }), false);
});

test("bulk runner is resumable, checksum-bound, memory-bounded, and never enables delivery", () => {
  const runner = fs.readFileSync(
    new URL("../scripts/run-qbank-bulk-draft-import.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /upload\?\.expected_sha256 === bank\.sha256/);
  assert.match(runner, /for \(const index of missing\)/);
  assert.doesNotMatch(runner, /missing\.slice\(offset, offset \+ 2\)/);
  assert.match(runner, /let stateWrite = Promise\.resolve\(\)/);
  assert.match(runner, /Promise\.allSettled/);
  assert.match(runner, /collections_approved: 0/);
  assert.match(runner, /student_destinations_enabled: 0/);
  assert.match(runner, /--rehearse-local/);
  assert.match(runner, /input_signature/);
  assert.doesNotMatch(runner, /requireBulkQbankExecutionRights/);
});
