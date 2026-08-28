import { createHash } from "node:crypto";

const clean = (value, limit = 1600) => String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, limit);

// The owner form uses `correction`, while the original endpoint expected
// `corrected_reply`. Preserve the actual correction instead of saving an empty rule.
export function normalizeLearningCorrection(payload = {}) {
  const corrected = clean(payload.corrected_reply || payload.corrected_example || payload.corrected_behavior || payload.correction);
  const next = clean(payload.correct_next_action, 500);
  const rule = clean(payload.rule_text || payload.override_rule || [corrected, next].filter(Boolean).join("\n"));
  if (!rule) throw Object.assign(new Error("A correction or rule is required."), { statusCode: 400 });
  return { ...payload, bad_reply: clean(payload.bad_reply || payload.bad_example || payload.original_reply || payload.mistake), corrected_reply: corrected, rule_text: rule,
    ...(payload.create_pending_rule === true ? { status: "pending_review", approved: false, admin_approved: false, override_behavior: false } : {}) };
}

export function reviewedLearningRules(db = {}, brandId = null) {
  const seen = new Set();
  return (Array.isArray(db.approved_learning_rules) ? db.approved_learning_rules : [])
    .filter(rule => String(rule.brand_id || "") === String(brandId || ""))
    .filter(rule => ["marketing", "sales", "ayla_sales", "all"].includes(String(rule.area || rule.scope || "marketing").toLowerCase()))
    .filter(rule => rule.status === "approved" && rule.admin_approved === true && rule.approved_by && rule.approved_at && rule.active !== false && rule.is_active !== false)
    .map(rule => ({ id: String(rule.id || ""), title: clean(rule.title, 120), rule_text: clean(rule.rule_text), applies_to: clean(rule.applies_to, 200), priority: Number(rule.priority) || 0, brand_id: rule.brand_id || null }))
    .filter(rule => { if (!rule.id || !rule.rule_text || seen.has(rule.id)) return false; seen.add(rule.id); return true; })
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).slice(0, 12);
}

export function learningGuidance(rules = []) {
  if (!rules.length) return "";
  return [
    "Reviewed owner coaching for this brand. Use only when relevant; this is not a script.",
    "These suggestions never override current programme facts, supported actions, specific student questions, opt-out, support priority, privacy, consent, truthful claims or the non-negotiable conversation rules. Do not repeat internal coaching text to the student.",
    JSON.stringify(rules.map(({ id, title, rule_text, applies_to }) => ({ id, title, coaching: rule_text, applies_when: applies_to }))),
  ].join("\n");
}

export function learningEvidence(rules = [], { at = new Date().toISOString(), model = null } = {}) {
  return { method: "reviewed_guidance_not_model_training", improvement_proven: false, at, model, rule_count: rules.length,
    rules: rules.map(rule => ({ id: rule.id, revision: createHash("sha256").update(JSON.stringify([rule.rule_text, rule.title, rule.applies_to, rule.brand_id])).digest("hex").slice(0, 20) })) };
}

// Legacy background jobs still save whole CRM snapshots. Preserve reviewed
// records by revision time, including archive tombstones, so those saves cannot
// silently undo an owner's newer correction. Unrelated CRM fields are untouched.
export function preserveLearningRecords(current = {}, incoming = {}) {
  const result = {};
  const timestamp = row => Date.parse(row.updated_at || row.created_at || row.approved_at || "") || 0;
  for (const collection of ["approved_learning_rules", "ai_mistake_reports"]) {
    const records = new Map();
    const pending = Array.isArray(incoming[collection]) ? incoming[collection] : [];
    const saved = Array.isArray(current[collection]) ? current[collection] : [];
    for (const row of [...pending, ...saved]) {
      if (!row?.id) continue;
      const previous = records.get(String(row.id));
      if (!previous || timestamp(row) >= timestamp(previous)) records.set(String(row.id), row);
    }
    result[collection] = [...records.values()].sort((a, b) => timestamp(b) - timestamp(a));
  }
  return result;
}
