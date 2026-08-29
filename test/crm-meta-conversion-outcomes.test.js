import assert from "node:assert/strict";
import test from "node:test";

import { buildMetaConversionOutcomes } from "../lib/crm-meta-conversion-outcomes.js";

test("Meta outcome reporting separates contacts, qualification, demo use, and enrollment by ad", () => {
  const result = buildMetaConversionOutcomes({
    brandId: "nextgen",
    leads: [
      { id: "lead-1", brand_id: "nextgen", meta_ad_id: "doctor", meta_campaign_id: "pilot", status: "qualified", demo_login_at: "2026-08-29T10:00:00Z", email: "one@example.com" },
      { id: "lead-2", brand_id: "nextgen", meta_ad_id: "doctor", meta_campaign_id: "pilot", status: "new", phone: "+1 555 100 2000" },
      { id: "lead-3", brand_id: "nextgen", meta_ad_id: "cns", meta_campaign_id: "pilot", stage: "paid_enrolled" },
      { id: "lead-4", brand_id: "other", meta_ad_id: "doctor", meta_campaign_id: "pilot", status: "qualified" },
    ],
    payments: [{ customer_phone: "+15551002000", status: "completed" }],
  });

  assert.deepEqual(result.totals, { contacts: 3, qualified_conversations: 2, demo_attendance: 1, enrollments: 2 });
  assert.deepEqual(result.by_ad.doctor, { contacts: 2, qualified_conversations: 1, demo_attendance: 1, enrollments: 1 });
  assert.deepEqual(result.by_ad.cns, { contacts: 1, qualified_conversations: 1, demo_attendance: 0, enrollments: 1 });
  assert.deepEqual(result.by_campaign.pilot, result.totals);
});

test("organic contacts stay outside paid Meta outcome totals", () => {
  const result = buildMetaConversionOutcomes({
    leads: [{ id: "organic", status: "qualified" }, { id: "ad", meta_ad_id: "ad-1", status: "new" }],
  });
  assert.equal(result.totals.contacts, 1);
  assert.equal(result.totals.qualified_conversations, 0);
});
