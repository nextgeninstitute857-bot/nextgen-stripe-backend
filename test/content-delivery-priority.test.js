import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTENT_DELIVERY_POLICY_VERSION,
  contentDeliveryPolicySnapshot,
  contentDeliveryPriorityRank,
  contentDeliverySourceYearsForExam,
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
  assert.equal(priorMedia, Number.POSITIVE_INFINITY);
  assert.equal(contentDeliveryPriorityRank({ source_year: 2023 }), Number.POSITIVE_INFINITY);
});

test("repeat avoidance operates inside the same source year", () => {
  const seen = new Set(["seen-2026"]);
  assert.ok(
    contentDeliveryPriorityRank({ id: "fresh-2026", source_year: 2026 }, { seenQuestionIds: seen })
      < contentDeliveryPriorityRank({ id: "seen-2026", source_year: 2026 }, { seenQuestionIds: seen }),
  );
  assert.ok(
    contentDeliveryPriorityRank({ id: "fresh-2025", source_year: 2025 }, { seenQuestionIds: seen })
      === Number.POSITIVE_INFINITY,
  );
});

test("verified prior-year fallback is limited to PLAB and AMC", () => {
  assert.deepEqual(contentDeliverySourceYearsForExam("usmle_step_1"), [2026]);
  assert.deepEqual(contentDeliverySourceYearsForExam("mccqe"), [2026]);
  assert.deepEqual(contentDeliverySourceYearsForExam("plab"), [2026, 2025, 2024]);
  assert.deepEqual(contentDeliverySourceYearsForExam("AMC"), [2026, 2025, 2024]);
  assert.equal(
    contentDeliveryPriorityRank(
      { id: "plab-fallback", exam_track: "plab", source_year: 2025 },
      { examTrack: "plab" },
    ),
    10,
  );
  assert.equal(
    contentDeliveryPriorityRank(
      { id: "step1-old", exam_track: "usmle_step_1", source_year: 2025 },
      { examTrack: "usmle_step_1" },
    ),
    Number.POSITIVE_INFINITY,
  );
});

test("policy snapshot describes media integrity as an eligibility gate, not a preference", () => {
  const policy = contentDeliveryPolicySnapshot();
  assert.equal(policy.version, CONTENT_DELIVERY_POLICY_VERSION);
  assert.deepEqual(policy.source_year_priority, [2026]);
  assert.equal(policy.fallback_strategy, "no_prior_year_fallback");
  assert.equal(policy.media_changes_ranking, false);
  assert.equal(policy.media_integrity_rule, "required_media_must_be_verified_and_playable");
  assert.equal(policy.incomplete_or_quarantined_media_excluded, true);

  const plabPolicy = contentDeliveryPolicySnapshot({ examTrack: "plab" });
  assert.deepEqual(plabPolicy.source_year_priority, [2026, 2025, 2024]);
  assert.equal(plabPolicy.fallback_strategy, "approved_exam_specific_fallback_when_2026_unavailable");
  assert.equal(plabPolicy.fallback_requires_mapped_taxonomy, true);
  assert.equal(plabPolicy.fallback_requires_verified_media, true);
});
