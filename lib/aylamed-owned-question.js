import crypto from "node:crypto";
import fs from "node:fs";

export const AYLA_OWNED_SBA_ADAPTER = "aylamed_owned_sba_v1";

const ledger = JSON.parse(fs.readFileSync(
  new URL("./aylamed-step1-taxonomy-import-ledger-v1.json", import.meta.url),
  "utf8",
));

const systemsById = new Map(ledger.systems.map((row) => [String(row.system_id), row]));
const subsystemsById = new Map(ledger.subsystems.map((row) => [String(row.subsystem_id), row]));
const topicsById = new Map(ledger.topics.map((row) => [String(row.topic_id), row]));
const disciplinesById = new Map(ledger.disciplines.map((row) => [Number(row.native_sub_id), row]));
const controlledQuestionTaxonomy = new Set(ledger.controlled_question_taxonomy_sha256 || []);

function cleanText(value = "") {
  return String(value ?? "").replace(/\u0000/g, "").trim();
}

function key(value = "") {
  return cleanText(value).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && cleanText(value));
}

function optionText(option) {
  if (typeof option === "string" || typeof option === "number") return cleanText(option);
  return cleanText(firstValue(option?.text_html, option?.text, option?.answerText, option?.label));
}

function controlledQuestionTaxonomyFingerprint(sourceItemId, taxonomy) {
  return crypto.createHash("sha256").update(JSON.stringify([
    cleanText(sourceItemId),
    cleanText(taxonomy.topic_key),
    Number(taxonomy.native_sys_id),
    cleanText(taxonomy.subtopic_key),
    cleanText(taxonomy.learning_objective_id),
  ])).digest("hex");
}

export function isAylaMedOwnedQuestion(question = {}) {
  const id = cleanText(firstValue(question.draft_id, question.question_id, question.id));
  const ownership = cleanText(firstValue(question.ownership, question.provenance?.owner));
  const hasTaxonomy = Boolean(question.controlled_taxonomy || question.taxonomy
    || (question.system && question.subsystem && question.topic && question.subtopic));
  return hasTaxonomy && (
    /^ay(?:la)?[-_]/i.test(id)
    || /^ay\d/i.test(id)
    || /\baylamed\b/i.test(ownership)
    || cleanText(question.controlled_taxonomy?.schema_version).startsWith("aylamed-")
  );
}

export function aylaMedOwnedAnswers(question = {}, separateAnswers = []) {
  const source = Array.isArray(question.options) && question.options.length
    ? question.options
    : separateAnswers;
  return source.map((option, index) => ({
    sourceId: cleanText(firstValue(option?.source_id, option?.id, option?.option_id, option?.answerId, index + 1)),
    answerId: Number(firstValue(option?.id, option?.option_id, option?.answerId, index + 1)),
    textHtml: optionText(option),
    correctPercentage: Number(firstValue(option?.correct_percentage, option?.correctPercentage, 0)) || 0,
  }));
}

export function aylaMedOwnedCorrectAnswerId(question = {}, answers = []) {
  const direct = firstValue(
    question.correct_option_id,
    question.correct_answer_id,
    question.correctOptionId,
    question.correctAnswerId,
    question.corrAns,
  );
  if (direct !== undefined) {
    const numeric = Number(direct);
    if (Number.isFinite(numeric)) return numeric;
  }
  const indexed = Number(firstValue(question.correct_index, question.correctIndex));
  if (Number.isInteger(indexed) && indexed >= 0 && indexed < answers.length) {
    return Number(answers[indexed]?.answerId);
  }
  const label = cleanText(firstValue(question.correct_option, question.correctOption, question.answer_label)).toUpperCase();
  if (/^[A-Z]$/.test(label)) {
    const index = label.charCodeAt(0) - 65;
    if (index >= 0 && index < answers.length) return Number(answers[index]?.answerId);
  }
  return Number.NaN;
}

function wrongExplanationMap(question = {}, answers = [], correctAnswerId) {
  const raw = question.wrong_choice_explanations || question.option_rationales || {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.fromEntries(Object.entries(raw).map(([id, value]) => [String(id), cleanText(value)]));
  }
  const incorrect = answers.filter((answer) => Number(answer.answerId) !== Number(correctAnswerId));
  const values = Array.isArray(raw) ? raw : [];
  return Object.fromEntries(incorrect.map((answer, index) => {
    const prefixed = values.find((value) => {
      const labelIndex = answers.findIndex((item) => Number(item.answerId) === Number(answer.answerId));
      const label = String.fromCharCode(65 + labelIndex);
      return new RegExp(`^\\s*${label}\\s*:`).test(cleanText(value));
    });
    return [String(answer.answerId), cleanText(prefixed || values[index] || "").replace(/^\s*[A-Z]\s*:\s*/, "")];
  }));
}

function reviewValue(value = "") {
  return cleanText(value).toLowerCase().replace(/[\s-]+/g, "_");
}

function reviewPass(value, allowed = []) {
  const normalized = reviewValue(value);
  return allowed.includes(normalized);
}

export function aylaMedOwnedPublicationGate(question = {}) {
  const review = question.review && typeof question.review === "object" ? question.review : {};
  const blueprint = question.uworld_2026_blueprint || question.blueprint_mapping || {};
  const audit = question.audit_metadata || {};
  const factual = firstValue(review.factual, question.factual_review, audit.clinician_review, blueprint.clinician_content_review_status);
  const similarity = firstValue(review.similarity, question.similarity_review, audit.final_corpus_similarity_review);
  const mediaRequired = question.media_required === true || (Array.isArray(question.media) && question.media.length > 0);
  const media = firstValue(review.media, question.media_review, mediaRequired ? "pending" : "not_required");
  const clinician = firstValue(question.clinician_approval, audit.clinician_review, blueprint.clinician_content_review_status, review.clinician);
  const factualReady = reviewPass(factual, ["approved", "pass", "complete"]);
  const similarityReady = reviewPass(similarity, ["human_approved", "human_pass", "approved", "complete"]);
  const mediaReady = !mediaRequired || reviewPass(media, ["approved", "pass", "complete", "not_required"]);
  const clinicianReady = reviewPass(clinician, ["approved", "pass", "complete"]);
  return {
    ready: factualReady && similarityReady && mediaReady && clinicianReady,
    factual: reviewValue(factual || "missing"),
    similarity: reviewValue(similarity || "missing"),
    media: reviewValue(media || "missing"),
    clinician: reviewValue(clinician || "missing"),
    factual_ready: factualReady,
    similarity_ready: similarityReady,
    media_ready: mediaReady,
    clinician_ready: clinicianReady,
  };
}

export function aylaMedOwnedTaxonomy(question = {}) {
  const labels = question.taxonomy && typeof question.taxonomy === "object"
    ? question.taxonomy
    : {};
  const controlled = question.controlled_taxonomy && typeof question.controlled_taxonomy === "object"
    ? question.controlled_taxonomy
    : {};
  const blueprint = question.uworld_2026_blueprint && typeof question.uworld_2026_blueprint === "object"
    ? question.uworld_2026_blueprint
    : {};
  const systemLabel = cleanText(firstValue(labels.system, question.system, controlled.system_name));
  const subsystemLabel = cleanText(firstValue(labels.subsystem, question.subsystem, controlled.clinical_labels?.subsystem, controlled.subsystem_name));
  const topicLabel = cleanText(firstValue(labels.topic, question.topic, controlled.clinical_labels?.topic, controlled.topic_name));
  const subtopicLabel = cleanText(firstValue(labels.subtopic, question.subtopic, controlled.clinical_labels?.subtopic, controlled.subtopic_name));
  const nativeSysId = Number(firstValue(controlled.native_sys_id, blueprint.native_sys_id));
  const nativeSubId = Number(firstValue(blueprint.native_sub_id, question.primary_sub_id, controlled.native_sub_id));
  return {
    system_key: cleanText(firstValue(controlled.system_id, labels.system_id, key(systemLabel))),
    subsystem_key: cleanText(firstValue(controlled.subsystem_id, labels.subsystem_id, key(subsystemLabel))),
    topic_key: cleanText(firstValue(controlled.topic_id, labels.topic_id, key(topicLabel))),
    subtopic_key: cleanText(firstValue(controlled.subtopic_id, labels.subtopic_id, key(subtopicLabel))),
    labels: {
      system: systemLabel,
      subsystem: subsystemLabel,
      topic: topicLabel,
      subtopic: subtopicLabel,
    },
    source: "aylamed_owned_json",
    review_status: "private_draft_validated",
    ledger_schema_version: ledger.schema_version,
    ledger_fingerprint: ledger.source_fingerprint,
    learning_objective_id: cleanText(firstValue(controlled.learning_objective_id, question.learning_objective_id)),
    native_sys_id: Number.isFinite(nativeSysId) ? nativeSysId : null,
    native_sub_id: Number.isFinite(nativeSubId) ? nativeSubId : null,
  };
}

export function validateAylaMedOwnedQuestion(question = {}, answers = [], correctAnswerId, taxonomy = aylaMedOwnedTaxonomy(question)) {
  const errors = [];
  const sourceItemId = cleanText(firstValue(question.draft_id, question.question_id, question.id));
  const stem = cleanText(firstValue(question.stem_html, question.stem, question.question));
  const explanation = cleanText(firstValue(question.explanation_html, question.correct_explanation, question.explanation));
  const objective = cleanText(firstValue(question.educational_objective, question.educational_takeaway, question.learning_objective));
  const references = Array.isArray(question.references)
    ? question.references
    : question.source ? [question.source] : [];
  const wrong = wrongExplanationMap(question, answers, correctAnswerId);

  if (!sourceItemId) errors.push("missing_source_item_id");
  if (!stem) errors.push("missing_question_stem");
  if (answers.length !== 5) errors.push("aylamed_requires_exactly_five_answers");
  if (answers.some((answer) => !Number.isFinite(Number(answer.answerId)) || !cleanText(answer.textHtml))) {
    errors.push("invalid_answer_choice");
  }
  if (new Set(answers.map((answer) => Number(answer.answerId))).size !== answers.length) {
    errors.push("duplicate_answer_ids");
  }
  if (!answers.some((answer) => Number(answer.answerId) === Number(correctAnswerId))) {
    errors.push("correct_answer_not_found");
  }
  if (!explanation) errors.push("missing_explanation");
  if (!objective) errors.push("missing_educational_objective");
  for (const answer of answers) {
    if (Number(answer.answerId) === Number(correctAnswerId)) continue;
    if (!cleanText(wrong[String(answer.answerId)])) errors.push("missing_wrong_choice_explanation");
  }
  if (!references.length || references.some((reference) => !cleanText(reference?.citation || reference?.title || reference?.url))) {
    errors.push("missing_verification_reference");
  }
  if (!cleanText(question.difficulty)) errors.push("missing_difficulty");
  if (!cleanText(firstValue(question.cognitive_task_class, question.cognitive_task, question.clinical_task))) {
    errors.push("missing_cognitive_task");
  }

  const controlled = question.controlled_taxonomy || {};
  const blueprint = question.uworld_2026_blueprint || {};
  const system = systemsById.get(taxonomy.system_key);
  const subsystem = subsystemsById.get(taxonomy.subsystem_key);
  const topic = topicsById.get(taxonomy.topic_key);
  const discipline = disciplinesById.get(Number(taxonomy.native_sub_id));
  if (!system) errors.push("taxonomy_system_not_in_approved_ledger");
  if (!subsystem || String(subsystem.system_id) !== taxonomy.system_key) {
    errors.push("taxonomy_subsystem_not_in_approved_ledger");
  }
  if (!topic
    || String(topic.system_id) !== taxonomy.system_key
    || String(topic.subsystem_id) !== taxonomy.subsystem_key
    || Number(topic.native_sys_id) !== Number(taxonomy.native_sys_id)) {
    errors.push("taxonomy_topic_not_in_approved_ledger");
  }
  if (!taxonomy.subtopic_key
    || !taxonomy.subtopic_key.startsWith(`subtopic:uw-sys-${taxonomy.native_sys_id}:`)) {
    errors.push("taxonomy_subtopic_not_controlled");
  }
  if (!taxonomy.learning_objective_id) errors.push("missing_learning_objective_id");
  if (!controlledQuestionTaxonomy.has(controlledQuestionTaxonomyFingerprint(sourceItemId, taxonomy))) {
    errors.push("taxonomy_subtopic_objective_not_in_approved_ledger");
  }
  if (!discipline) errors.push("taxonomy_primary_discipline_not_in_approved_ledger");
  if (Number(blueprint.native_sys_id) !== Number(taxonomy.native_sys_id)
    || Number(blueprint.native_sub_id) !== Number(taxonomy.native_sub_id)) {
    errors.push("taxonomy_blueprint_ids_do_not_match_controlled_taxonomy");
  }
  if (cleanText(blueprint.ayla_system_id) !== taxonomy.system_key) {
    errors.push("taxonomy_blueprint_system_does_not_match_controlled_taxonomy");
  }
  if (!cleanText(controlled.schema_version).startsWith("aylamed-controlled-taxonomy-")) {
    errors.push("unsupported_controlled_taxonomy_version");
  }
  if (Object.values(taxonomy.labels).some((value) => !cleanText(value))) {
    errors.push("incomplete_taxonomy_labels");
  }

  return [...new Set(errors)];
}

export function aylaMedOwnedSourceData(question = {}, answers = [], correctAnswerId) {
  const taxonomy = aylaMedOwnedTaxonomy(question);
  const publicationGate = aylaMedOwnedPublicationGate(question);
  return {
    taxonomy,
    wrong_choice_explanations: wrongExplanationMap(question, answers, correctAnswerId),
    educational_objective: cleanText(firstValue(question.educational_objective, question.educational_takeaway, question.learning_objective)),
    difficulty: cleanText(question.difficulty),
    cognitive_task: cleanText(firstValue(question.cognitive_task_class, question.cognitive_task, question.clinical_task)),
    references: Array.isArray(question.references) ? question.references : question.source ? [question.source] : [],
    ownership: cleanText(firstValue(question.ownership, question.provenance?.ownership, question.provenance?.owner)),
    provenance: question.provenance && typeof question.provenance === "object" ? question.provenance : {},
    review: question.review && typeof question.review === "object" ? question.review : {},
    publication_gate: publicationGate,
    private_import_ready: true,
    publication_gate_ready: publicationGate.ready,
    controlled_taxonomy: question.controlled_taxonomy || {},
    blueprint_mapping: question.uworld_2026_blueprint || {},
    audit_metadata: question.audit_metadata || {},
  };
}

export function aylaMedTaxonomyLedgerSummary() {
  return {
    schema_version: ledger.schema_version,
    source_schema_version: ledger.source_schema_version,
    source_fingerprint: ledger.source_fingerprint,
    hierarchy: ledger.hierarchy,
    systems: ledger.systems.length,
    subsystems: ledger.subsystems.length,
    topics: ledger.topics.length,
    disciplines: ledger.disciplines.length,
    controlled_question_taxonomy_records: controlledQuestionTaxonomy.size,
  };
}
