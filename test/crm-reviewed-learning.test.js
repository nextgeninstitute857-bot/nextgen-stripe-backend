import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { normalizeLearningCorrection, reviewedLearningRules, learningGuidance, learningEvidence, preserveLearningRecords } from "../lib/crm-reviewed-learning.js";
import { buildAylaConversationPrompt } from "../lib/crm-ayla-conversation-engine.js";

const approved = (patch = {}) => ({ id: "rule-1", brand_id: "nextgen", area: "marketing", status: "approved", admin_approved: true, approved_by: "owner", approved_at: "2026-08-28T12:00:00Z", rule_text: "Acknowledge a busy hospital shift before offering flexible catch-up.", ...patch });

test("the correction form's actual field names are preserved and blank corrections are rejected", () => {
  const result = normalizeLearningCorrection({ mistake: "Generic pitch", correction: "Answer the doctor's specific concern first.", correct_next_action: "Then explain one relevant benefit.", create_pending_rule: true });
  assert.equal(result.bad_reply, "Generic pitch");
  assert.equal(result.corrected_reply, "Answer the doctor's specific concern first.");
  assert.match(result.rule_text, /specific concern first/);
  assert.match(result.rule_text, /one relevant benefit/);
  assert.equal(result.status, "pending_review");
  assert.throws(() => normalizeLearningCorrection({ mistake: "Bad reply" }), /correction/i);
});

test("only explicitly reviewed, active, same-brand sales corrections reach WhatsApp", () => {
  const db = { approved_learning_rules: [approved(), approved({ id: "pending", status: "pending_review" }), approved({ id: "off", is_active: false }), approved({ id: "community", area: "community" }), approved({ id: "other", brand_id: "aylamed" }), approved({ id: "unreviewed", approved_by: null }), approved({ id: "legacy", brand_id: null })], ai_learning_lessons: [approved({ id: "raw-lesson" })] };
  assert.deepEqual(reviewedLearningRules(db, "nextgen").map(r => r.id), ["rule-1"]);
  assert.deepEqual(reviewedLearningRules(db, "aylamed").map(r => r.id), ["other"]);
  assert.deepEqual(reviewedLearningRules(db, null).map(r => r.id), ["legacy"]);
});

test("guidance is not a script or an override of current facts, opt-out, support or permission", () => {
  const rules = reviewedLearningRules({ approved_learning_rules: [approved()] }, "nextgen");
  const guidance = learningGuidance(rules);
  assert.match(guidance, /never override/i);
  assert.match(guidance, /opt-out/i);
  assert.match(guidance, /not a script/i);
  const prompt = buildAylaConversationPrompt({ reviewedLearning: guidance });
  assert.match(prompt, /busy hospital shift/);
  assert.match(prompt, /Never invent a country discount/);
  assert.doesNotMatch(buildAylaConversationPrompt(), /busy hospital shift/);
});

test("evidence identifies exact guidance revisions, not a training percentage", () => {
  const first = learningEvidence([approved()], { at: "2026-08-28T12:00:00Z", model: "test-model" });
  const changed = learningEvidence([approved({ rule_text: "A different correction." })]);
  assert.equal(first.rule_count, 1);
  assert.equal(first.rules[0].id, "rule-1");
  assert.notEqual(first.rules[0].revision, changed.rules[0].revision);
  assert.equal(first.method, "reviewed_guidance_not_model_training");
  assert.equal(first.improvement_proven, false);
});

test("production uses reviewed coaching and records its revision only after delivery", () => {
  const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(source, /reviewedLearning: learningGuidance\(reviewedRules\)/);
  const commit = source.slice(source.indexOf("function ngAylaCommitConversationTurnAfterDelivery"), source.indexOf('// Admin-only, no-send conversation evaluation'));
  assert.ok(commit.indexOf('if (!delivered || !ai.conversation_state) return false') < commit.indexOf('lead.ayla_learning_evidence ='));
  const correction = source.slice(source.indexOf('app.post("/admin/crm/ai-sales-learning/mistake-corrections"'), source.indexOf('app.get("/admin/crm/community-intelligence/learning"'));
  assert.match(correction, /normalizeLearningCorrection/);
  assert.match(correction, /mutateCrmDb/);
  assert.doesNotMatch(correction, /writeCrmDb/);
});

test("a stale background save cannot erase a new correction, approval or archived rule", () => {
  const current = { approved_learning_rules: [approved({ updated_at: "2026-08-28T12:00:00Z" }), approved({ id: "removed", status: "archived", updated_at: "2026-08-28T12:00:00Z" })], ai_mistake_reports: [{ id: "correction", created_at: "2026-08-28T12:00:00Z" }] };
  const stale = { approved_learning_rules: [approved({ id: "removed", updated_at: "2026-08-28T11:00:00Z" })], ai_mistake_reports: [] };
  const saved = preserveLearningRecords(current, stale);
  assert.equal(saved.approved_learning_rules.length, 2);
  assert.equal(saved.approved_learning_rules.find(r => r.id === "removed").status, "archived");
  assert.equal(saved.ai_mistake_reports.length, 1);
  const newer = preserveLearningRecords(current, { approved_learning_rules: [approved({ status: "inactive", updated_at: "2026-08-28T13:00:00Z" })] });
  assert.equal(newer.approved_learning_rules.find(r => r.id === "rule-1").status, "inactive");
  assert.equal(preserveLearningRecords(current, { approved_learning_rules: {} }).approved_learning_rules.length, 2);
});
