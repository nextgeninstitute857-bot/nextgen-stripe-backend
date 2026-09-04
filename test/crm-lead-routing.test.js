import test from "node:test";
import assert from "node:assert/strict";

import {
  applyLeadInboxRouting,
  classifyInboundLead,
  inferLeadExamTrack,
} from "../lib/crm-lead-routing.js";

test("MCCQE ad attribution routes a short enquiry into the MCCQE inbox", () => {
  const lead = { meta_ad_headline: "Build your MCCQE baseline with AylaMed" };
  const result = applyLeadInboxRouting(lead, { text: "Hi" });

  assert.equal(result.relevance, "exam_lead");
  assert.equal(lead.exam_track, "mccqe");
  assert.equal(lead.inbox_bucket, "exam:mccqe");
  assert.equal(lead.ai_suppressed, false);
});

test("USMLE steps stay in their own exam tracks", () => {
  assert.equal(inferLeadExamTrack({ source_text: "I need a Step 2 CK study plan" }), "usmle_step2_ck");
  assert.equal(inferLeadExamTrack({ source_text: "Preparing for USMLE Step 3 and CCS" }), "usmle_step3");
  assert.equal(inferLeadExamTrack({ source_text: "USMLE Step 1 question bank" }), "usmle_step1");
});

test("obvious SEO, design, job and partnership solicitations are filtered without AI", () => {
  const examples = [
    ["We provide SEO and backlinks to improve your Google ranking", "seo_sales"],
    ["I am a graphic designer and can design your logo", "design_sales"],
    ["Are you hiring? I am looking for a job and my CV is attached", "job_request"],
    ["I have a business partnership proposal for your company", "partnership_request"],
  ];

  for (const [text, reason] of examples) {
    const result = classifyInboundLead({ text });
    assert.equal(result.suppress_ai, true, text);
    assert.equal(result.reason, reason, text);
  }
});

test("a genuine candidate is not filtered just because the message also mentions work", () => {
  const result = classifyInboundLead({
    text: "I am a doctor preparing for MCCQE and need help balancing study with my job",
  });

  assert.equal(result.suppress_ai, false);
  assert.equal(result.relevance, "exam_lead");
  assert.equal(result.exam_track, "mccqe");
});

test("unknown greetings remain eligible for qualification", () => {
  const result = classifyInboundLead({ text: "Hello" });
  assert.equal(result.suppress_ai, false);
  assert.equal(result.relevance, "unknown");
});

test("a later genuine MCCQE message restores a previously filtered contact", () => {
  const lead = {};
  applyLeadInboxRouting(lead, { text: "We offer SEO services and backlinks" });
  assert.equal(lead.inbox_bucket, "filtered");
  assert.equal(lead.ai_suppressed, true);

  applyLeadInboxRouting(lead, { text: "I am a doctor preparing for MCCQE and want a demo" });
  assert.equal(lead.exam_track, "mccqe");
  assert.equal(lead.inbox_bucket, "exam:mccqe");
  assert.equal(lead.lead_relevance, "exam_lead");
  assert.equal(lead.ai_suppressed, false);
});

test("a generic follow-up does not reopen a filtered solicitation", () => {
  const lead = { meta_ad_headline: "MCCQE preparation with AylaMed" };
  applyLeadInboxRouting(lead, { text: "Do you need social media marketing services?" });
  applyLeadInboxRouting(lead, { text: "Hello?" });

  assert.equal(lead.inbox_bucket, "filtered");
  assert.equal(lead.ai_suppressed, true);
});

test("an exam-related career question is not mistaken for a job solicitation", () => {
  const result = classifyInboundLead({ text: "Are there job opportunities for doctors after MCCQE?" });
  assert.equal(result.suppress_ai, false);
  assert.equal(result.exam_track, "mccqe");
});

test("being a doctor does not make an SEO sales pitch a student enquiry", () => {
  const result = classifyInboundLead({ text: "I am a doctor and I offer SEO backlinks for your website" });
  assert.equal(result.suppress_ai, true);
  assert.equal(result.reason, "seo_sales");
});

test("exam interest never clears an unrelated opt-out suppression", () => {
  const lead = { ai_suppressed: true, suppressed: true, stop_requested: true };
  applyLeadInboxRouting(lead, { text: "I am preparing for MCCQE" });

  assert.equal(lead.exam_track, "mccqe");
  assert.equal(lead.inbox_bucket, "exam:mccqe");
  assert.equal(lead.ai_suppressed, true);
  assert.equal(lead.stop_requested, true);
});
