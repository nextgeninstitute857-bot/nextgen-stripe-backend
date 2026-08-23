import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTENT_DELIVERY_POLICY_VERSION,
  contentDeliveryPolicySnapshot,
  contentDeliveryPriorityRank,
  contentDeliveryRecordAllowed,
  contentDeliverySourceYearsForExam,
  contentDeliverySourceYearsForRecord,
  contentDeliveryUworldSource,
  inferContentSourceYear,
} from "../lib/content-delivery-priority.js";

test("content source year is inferred from explicit metadata, source rank, and import names", () => {
  assert.equal(inferContentSourceYear({ source_year: 2026 }), 2026);
  assert.equal(inferContentSourceYear({ source_rank: 20250301 }), 2025);
  assert.equal(inferContentSourceYear("aceqbank-cdm-2024"), 2024);
  assert.equal(inferContentSourceYear("collection-without-an-edition"), null);
});

test("year is the delivery priority and media presence never changes ranking", () => {
  const currentText = contentDeliveryPriorityRank({ id: "current-text", source_year: 2026 });
  const currentMedia = contentDeliveryPriorityRank({
    id: "current-media",
    source_year: 2026,
    has_verified_media: true,
  });
  const priorMedia = contentDeliveryPriorityRank({
    id: "prior-media",
    source_year: 2025,
    has_verified_media: true,
  });
  assert.equal(currentText, currentMedia);
  assert.equal(priorMedia, 10);
  assert.equal(contentDeliveryPriorityRank({ source_year: 2023 }), Number.POSITIVE_INFINITY);
});

test("repeat avoidance operates inside the same source year", () => {
  const seen = new Set(["seen-2026"]);
  assert.ok(
    contentDeliveryPriorityRank({ id: "fresh-2026", source_year: 2026 }, { seenQuestionIds: seen })
      < contentDeliveryPriorityRank({ id: "seen-2026", source_year: 2026 }, { seenQuestionIds: seen }),
  );
  assert.equal(
    contentDeliveryPriorityRank({ id: "fresh-2025", source_year: 2025 }, { seenQuestionIds: seen }),
    10,
  );
});

test("UWorld stays 2026-only while approved other banks can use verified recent editions", () => {
  assert.deepEqual(contentDeliverySourceYearsForExam("usmle_step_1"), [2026, 2025, 2024]);
  assert.deepEqual(contentDeliverySourceYearsForExam("mccqe"), [2026, 2025, 2024]);
  assert.deepEqual(contentDeliverySourceYearsForExam("plab"), [2026, 2025, 2024]);
  assert.deepEqual(contentDeliverySourceYearsForExam("AMC"), [2026, 2025, 2024]);
  assert.equal(contentDeliveryUworldSource({ source_profile: "uworld_style" }), true);
  assert.equal(contentDeliveryUworldSource({ title: "U World Step 1" }), true);
  assert.equal(contentDeliveryUworldSource({ source_provider: "AMBOSS" }), false);
  assert.deepEqual(
    contentDeliverySourceYearsForRecord({ source_profile: "uworld_style" }),
    [2026],
  );
  assert.deepEqual(
    contentDeliverySourceYearsForRecord({ source_provider: "AMBOSS" }),
    [2026, 2025, 2024],
  );
  assert.equal(
    contentDeliveryRecordAllowed({ source_profile: "uworld_style", source_year: 2025 }),
    false,
  );
  assert.equal(
    contentDeliveryRecordAllowed({ source_provider: "AMBOSS", source_year: 2025 }),
    true,
  );
  assert.equal(
    contentDeliveryRecordAllowed({ source_provider: "BoardVitals", source_year: 2025 }),
    true,
  );
  assert.equal(
    contentDeliveryPriorityRank(
      { id: "plab-fallback", exam_track: "plab", source_year: 2025 },
      { examTrack: "plab" },
    ),
    10,
  );
  assert.equal(
    contentDeliveryPriorityRank(
      { id: "step1-old-uworld", source_profile: "uworld_style", exam_track: "usmle_step_1", source_year: 2025 },
      { examTrack: "usmle_step_1" },
    ),
    Number.POSITIVE_INFINITY,
  );
  assert.equal(
    contentDeliveryPriorityRank(
      { id: "step1-amboss", source_provider: "AMBOSS", exam_track: "usmle_step_1", source_year: 2025 },
      { examTrack: "usmle_step_1" },
    ),
    10,
  );
});

test("policy snapshot describes media integrity as an eligibility gate, not a preference", () => {
  const policy = contentDeliveryPolicySnapshot();
  assert.equal(policy.version, CONTENT_DELIVERY_POLICY_VERSION);
  assert.deepEqual(policy.source_year_priority, [2026, 2025, 2024]);
  assert.deepEqual(policy.uworld_source_year_priority, [2026]);
  assert.deepEqual(policy.approved_other_bank_source_year_priority, [2026, 2025, 2024]);
  assert.equal(policy.fallback_strategy, "approved_provider_specific_fallback");
  assert.equal(policy.fallback_provider_scoped, true);
  assert.equal(policy.uworld_prior_years_excluded, true);
  assert.equal(policy.media_changes_ranking, false);
  assert.equal(policy.media_integrity_rule, "required_media_must_be_verified_and_playable");
  assert.equal(policy.incomplete_or_quarantined_media_excluded, true);

  const plabPolicy = contentDeliveryPolicySnapshot({ examTrack: "plab" });
  assert.deepEqual(plabPolicy.source_year_priority, [2026, 2025, 2024]);
  assert.equal(plabPolicy.fallback_strategy, "approved_provider_specific_fallback");
  assert.equal(plabPolicy.fallback_requires_mapped_taxonomy, true);
  assert.equal(plabPolicy.fallback_requires_verified_media, true);
});
