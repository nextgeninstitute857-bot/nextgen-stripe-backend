import {
  normalizeContentTaxonomyKey,
} from "./content-taxonomy-control.js";

export const CONTENT_TAXONOMY_CLASSIFIER_EVIDENCE_LIMIT = 200;
export const CONTENT_TAXONOMY_CLASSIFIER_AUTO_APPROVAL_PERCENT = 97;
export const DEFAULT_CONTENT_TAXONOMY_CLASSIFIER_MAX_OUTPUT_TOKENS = 12_000;

function cleanText(value = "", maximum = 2_000) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function plainText(value = "", maximum = 900) {
  return cleanText(
    String(value || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'"),
    maximum,
  );
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(parsed)));
}

function canonicalSystem(value, allowedSystems = []) {
  const wanted = normalizeContentTaxonomyKey(value);
  return (Array.isArray(allowedSystems) ? allowedSystems : [])
    .find((system) => normalizeContentTaxonomyKey(system) === wanted) || "";
}

export function contentTaxonomyClassifierMaxOutputTokens(value) {
  return boundedInteger(
    value,
    DEFAULT_CONTENT_TAXONOMY_CLASSIFIER_MAX_OUTPUT_TOKENS,
    8_000,
    30_000,
  );
}

export function buildContentTaxonomyProviderPairRequest(pair = {}, evidence = {}, {
  examLabel = "",
  allowedSystems = [],
} = {}) {
  const questions = (Array.isArray(evidence.questions) ? evidence.questions : [])
    .slice(0, CONTENT_TAXONOMY_CLASSIFIER_EVIDENCE_LIMIT)
    .map((question) => ({
      id: cleanText(question.id, 80),
      student_qid: cleanText(question.student_qid, 80),
      title: plainText(question.title, 240),
      stem_signal: plainText(question.question_html, 800),
      explanation_signal: plainText(question.explanation_html, 500),
    }))
    .filter((question) => question.id);
  const expectedQuestionCount = Math.max(0, Number(
    evidence.total ?? evidence.question_count ?? pair.question_count ?? questions.length,
  ) || 0);
  if (!questions.length) {
    throw Object.assign(new Error("At least one MCQ is required for taxonomy classification"), {
      statusCode: 400,
    });
  }
  const uniqueQuestionIds = new Set(questions.map((question) => question.id));
  const evidenceComplete = expectedQuestionCount > 0
    && expectedQuestionCount <= CONTENT_TAXONOMY_CLASSIFIER_EVIDENCE_LIMIT
    && uniqueQuestionIds.size === expectedQuestionCount;
  const safeSystems = [...new Set(
    (Array.isArray(allowedSystems) ? allowedSystems : [])
      .map((system) => cleanText(system, 120))
      .filter(Boolean),
  )];
  if (!safeSystems.length) {
    throw Object.assign(new Error("The exam taxonomy must provide at least one allowed system"), {
      statusCode: 400,
    });
  }

  const systemPrompt = [
    "You are a medical education content taxonomist.",
    "Classify one imported MCQ provider pair for the named exam using the supplied questions only.",
    "The hierarchy is exam → system → subsystem → topic → subtopic (learning objective).",
    "Choose system exactly from the allowed system labels. Use concise, medically meaningful labels for the remaining levels.",
    "A provider pair can contain unrelated questions. Set pair_homogeneous=true only when every supplied question belongs to the exact same complete four-level hierarchy.",
    "Set every_question_reviewed=true only after checking every supplied question. List every outlier question ID.",
    "Do not force a uniform mapping, invent evidence, or use source numeric IDs as medical categories.",
    "Return only the strict JSON object.",
  ].join(" ");
  const userPrompt = JSON.stringify({
    exam: cleanText(examLabel || pair.exam_track, 160),
    allowed_systems: safeSystems,
    provider_pair: {
      exam_track: cleanText(pair.exam_track, 80),
      source_namespace: cleanText(pair.source_namespace, 160),
      source_system_id: cleanText(pair.source_system_id, 160),
      source_subject_id: cleanText(pair.source_subject_id, 160),
      expected_question_count: expectedQuestionCount,
      supplied_question_count: questions.length,
      evidence_complete: evidenceComplete,
    },
    questions,
  });
  return {
    pair: {
      exam_track: cleanText(pair.exam_track, 80),
      source_namespace: cleanText(pair.source_namespace, 160),
      source_system_id: cleanText(pair.source_system_id, 160),
      source_subject_id: cleanText(pair.source_subject_id, 160),
      question_count: expectedQuestionCount,
    },
    questions,
    expectedQuestionCount,
    evidenceComplete,
    allowedSystems: safeSystems,
    systemPrompt,
    userPrompt,
    reasoning: { effort: "low" },
    textFormat: {
      type: "json_schema",
      name: "content_taxonomy_provider_pair",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: [
          "system",
          "subsystem",
          "topic",
          "subtopic",
          "pair_homogeneous",
          "every_question_reviewed",
          "confidence_percent",
          "ambiguity_flags",
          "outlier_question_ids",
          "classification_reason",
        ],
        properties: {
          system: { type: "string" },
          subsystem: { type: "string" },
          topic: { type: "string" },
          subtopic: { type: "string" },
          pair_homogeneous: { type: "boolean" },
          every_question_reviewed: { type: "boolean" },
          confidence_percent: { type: "integer", minimum: 0, maximum: 100 },
          ambiguity_flags: {
            type: "array",
            maxItems: 30,
            items: { type: "string" },
          },
          outlier_question_ids: {
            type: "array",
            maxItems: CONTENT_TAXONOMY_CLASSIFIER_EVIDENCE_LIMIT,
            items: { type: "string" },
          },
          classification_reason: { type: "string" },
        },
      },
    },
  };
}

export function normalizeContentTaxonomyProviderPairClassification(proposal = {}, request = {}) {
  const allowedSystems = Array.isArray(request.allowedSystems) ? request.allowedSystems : [];
  const system = canonicalSystem(proposal.system, allowedSystems);
  const subsystem = cleanText(proposal.subsystem, 160);
  const topic = cleanText(proposal.topic, 160);
  const subtopic = cleanText(proposal.subtopic, 160);
  const ambiguityFlags = [...new Set(
    (Array.isArray(proposal.ambiguity_flags) ? proposal.ambiguity_flags : [])
      .map((flag) => cleanText(flag, 160))
      .filter(Boolean),
  )].slice(0, 30);
  const suppliedQuestionIds = new Set(
    (Array.isArray(request.questions) ? request.questions : [])
      .map((question) => cleanText(question.id, 80))
      .filter(Boolean),
  );
  const outlierQuestionIds = [...new Set(
    (Array.isArray(proposal.outlier_question_ids) ? proposal.outlier_question_ids : [])
      .map((id) => cleanText(id, 80))
      .filter((id) => id && suppliedQuestionIds.has(id)),
  )].slice(0, CONTENT_TAXONOMY_CLASSIFIER_EVIDENCE_LIMIT);
  const confidencePercent = boundedInteger(proposal.confidence_percent, 0, 0, 100);
  const pairHomogeneous = proposal.pair_homogeneous === true;
  const everyQuestionReviewed = proposal.every_question_reviewed === true;
  const mappingTaxonomy = {
    system_key: normalizeContentTaxonomyKey(system || "unclassified"),
    subsystem_key: normalizeContentTaxonomyKey(subsystem),
    topic_key: normalizeContentTaxonomyKey(topic),
    subtopic_key: normalizeContentTaxonomyKey(subtopic),
    labels: {
      system: system || cleanText(proposal.system, 160) || "Unclassified",
      subsystem,
      topic,
      subtopic,
    },
  };
  const hierarchyComplete = Boolean(
    system
      && mappingTaxonomy.subsystem_key
      && mappingTaxonomy.topic_key
      && mappingTaxonomy.subtopic_key,
  );
  const autoApprovalReady = Boolean(
    request.evidenceComplete === true
      && hierarchyComplete
      && pairHomogeneous
      && everyQuestionReviewed
      && outlierQuestionIds.length === 0
      && ambiguityFlags.length === 0
      && confidencePercent >= CONTENT_TAXONOMY_CLASSIFIER_AUTO_APPROVAL_PERCENT,
  );
  const reviewReasons = [];
  if (!request.evidenceComplete) reviewReasons.push("incomplete_pair_evidence");
  if (!system) reviewReasons.push("system_outside_exam_taxonomy");
  if (!hierarchyComplete) reviewReasons.push("incomplete_hierarchy");
  if (!pairHomogeneous) reviewReasons.push("heterogeneous_provider_pair");
  if (!everyQuestionReviewed) reviewReasons.push("not_every_question_reviewed");
  if (outlierQuestionIds.length) reviewReasons.push("question_outliers");
  if (ambiguityFlags.length) reviewReasons.push("classifier_ambiguity");
  if (confidencePercent < CONTENT_TAXONOMY_CLASSIFIER_AUTO_APPROVAL_PERCENT) {
    reviewReasons.push("below_auto_approval_confidence");
  }
  return {
    mappingTaxonomy,
    hierarchyComplete,
    pairHomogeneous,
    everyQuestionReviewed,
    confidencePercent,
    confidence: confidencePercent / 100,
    ambiguityFlags,
    outlierQuestionIds,
    classificationReason: cleanText(proposal.classification_reason, 2_000),
    autoApprovalReady,
    reviewReasons: [...new Set(reviewReasons)],
  };
}
