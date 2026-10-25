import fs from "node:fs";
import path from "node:path";
import { correctPositionForAttempt } from "./lib/answer-order-policy.mjs";

const root = process.cwd();
const researchRoot = path.join(root, "research", "usmle-step1-2026");
const draftsRoot = path.join(researchRoot, "drafts");
const answerPolicyPath = path.join(researchRoot, "answer-order-policy.json");
const requiredTaxonomy = ["system", "subsystem", "topic", "subtopic"];
const proprietaryBrandPattern = /\b(?:uworld|amboss|world\s+qbank)\b/i;

function filesUnder(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory()
      ? filesUnder(absolute, suffix)
      : entry.name.endsWith(suffix) ? [absolute] : [];
  }).sort();
}

function text(value) {
  return String(value ?? "").trim();
}

function questionBody(question = {}) {
  return [
    question.stem_html,
    question.explanation_html,
    question.educational_objective,
    ...(Array.isArray(question.options) ? question.options.map((option) => option?.text_html) : []),
    ...Object.values(question.wrong_choice_explanations || {}),
  ].map(text).join("\n");
}

function increment(counter, key) {
  counter[key] = (counter[key] || 0) + 1;
}

const errors = [];
const warnings = [];
const seenIds = new Set();
const questionRecords = [];
const authoredPositionCounts = {};
let questionCount = 0;
let mediaCount = 0;
let answerPolicy = null;

try {
  answerPolicy = JSON.parse(fs.readFileSync(answerPolicyPath, "utf8"));
} catch (error) {
  errors.push(`${path.relative(root, answerPolicyPath)}: missing or invalid answer-order policy (${error.message})`);
}

if (answerPolicy) {
  const delivery = answerPolicy.student_delivery || {};
  if (answerPolicy.status !== "private_research_draft") {
    errors.push("answer-order policy status must remain private_research_draft");
  }
  if (answerPolicy.publication_allowed !== false) {
    errors.push("answer-order policy publication_allowed must be false");
  }
  if (delivery.shuffle_required !== true || delivery.shuffle_scope !== "per_question_per_attempt") {
    errors.push("answer-order policy must require per-question, per-attempt shuffling");
  }
  if (delivery.algorithm !== "sha256_rank_v1") {
    errors.push("answer-order policy algorithm must be sha256_rank_v1");
  }
  if (delivery.seed_source !== "server_issued_non_public_attempt_identifier") {
    errors.push("answer-order policy seed must be a server-issued non-public attempt identifier");
  }
  if (delivery.preserve_option_ids !== true || delivery.score_by_option_id_server_side !== true) {
    errors.push("answer-order policy must preserve option IDs and score server-side by option ID");
  }
  if (delivery.expose_correct_option_id_before_submission !== false) {
    errors.push("correct_option_id must never be exposed before submission");
  }
  if (delivery.reuse_order_when_attempt_resumes !== true) {
    errors.push("resumed attempts must reuse their original option order");
  }
}

const draftFiles = filesUnder(draftsRoot, ".json");
for (const filename of draftFiles) {
  let batch;
  try {
    batch = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    errors.push(`${path.relative(root, filename)}: invalid JSON (${error.message})`);
    continue;
  }

  const relative = path.relative(root, filename);
  if (batch.status !== "private_research_draft") {
    errors.push(`${relative}: status must remain private_research_draft`);
  }
  if (batch.publication_allowed !== false) {
    errors.push(`${relative}: publication_allowed must be false`);
  }
  if (!Array.isArray(batch.questions) || !batch.questions.length) {
    errors.push(`${relative}: questions array is empty`);
    continue;
  }

  for (const [index, question] of batch.questions.entries()) {
    questionCount += 1;
    const pointer = `${relative}#questions[${index}]`;
    const id = text(question.draft_id);
    if (!id) errors.push(`${pointer}: missing draft_id`);
    else if (seenIds.has(id)) errors.push(`${pointer}: duplicate draft_id ${id}`);
    else seenIds.add(id);

    if (question.exam_track !== "usmle-step-1") {
      errors.push(`${pointer}: exam_track must be usmle-step-1`);
    }
    for (const field of requiredTaxonomy) {
      if (!text(question.taxonomy?.[field])) errors.push(`${pointer}: missing taxonomy.${field}`);
    }
    if (!text(question.stem_html)) errors.push(`${pointer}: missing stem_html`);
    if (!text(question.explanation_html)) errors.push(`${pointer}: missing explanation_html`);
    if (!text(question.educational_objective)) errors.push(`${pointer}: missing educational_objective`);

    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length < 4 || options.length > 6) {
      errors.push(`${pointer}: expected 4-6 answer options, found ${options.length}`);
    }
    const optionIds = options.map((option) => Number(option?.id));
    if (new Set(optionIds).size !== optionIds.length || optionIds.some((idValue) => !Number.isFinite(idValue))) {
      errors.push(`${pointer}: option IDs must be unique finite numbers`);
    }
    if (!optionIds.includes(Number(question.correct_option_id))) {
      errors.push(`${pointer}: correct_option_id does not match an option`);
    }
    if (options.some((option) => !text(option?.text_html))) {
      errors.push(`${pointer}: every option needs text_html`);
    }

    const authoredPosition = options.findIndex(
      (option) => Number(option?.id) === Number(question.correct_option_id),
    ) + 1;
    if (authoredPosition > 0) increment(authoredPositionCounts, String(authoredPosition));
    questionRecords.push({ pointer, question, optionCount: options.length });

    const wrong = question.wrong_choice_explanations || {};
    for (const option of options) {
      if (Number(option.id) === Number(question.correct_option_id)) continue;
      if (!text(wrong[String(option.id)])) {
        errors.push(`${pointer}: missing wrong-choice explanation for option ${option.id}`);
      }
    }

    if (!Array.isArray(question.references) || !question.references.length) {
      errors.push(`${pointer}: at least one verification reference is required`);
    } else if (question.references.some((reference) => !text(reference?.citation))) {
      errors.push(`${pointer}: every reference requires a citation`);
    }

    if (question.review?.publication !== "blocked") {
      errors.push(`${pointer}: review.publication must remain blocked`);
    }
    if (!text(question.review?.factual) || !text(question.review?.similarity)) {
      errors.push(`${pointer}: factual and similarity review states are required`);
    }

    if (proprietaryBrandPattern.test(questionBody(question))) {
      errors.push(`${pointer}: proprietary QBank brand text appears inside learner-facing content`);
    }

    const media = Array.isArray(question.media) ? question.media : [];
    for (const item of media) {
      mediaCount += 1;
      const mediaPath = text(item?.path);
      if (!mediaPath) {
        errors.push(`${pointer}: media entry is missing path`);
        continue;
      }
      const absolute = path.resolve(root, mediaPath);
      if (!absolute.startsWith(path.resolve(researchRoot))) {
        errors.push(`${pointer}: media path escapes the private research directory`);
      }
      if (!fs.existsSync(absolute)) errors.push(`${pointer}: missing media file ${mediaPath}`);
      if (item.ownership !== "AylaMed original") {
        errors.push(`${pointer}: media ownership must be AylaMed original`);
      }
      if (!text(item.alt_text)) errors.push(`${pointer}: media requires alt_text`);
    }

    if (!media.length && question.review?.media !== "not_required") {
      warnings.push(`${pointer}: no media attached but review.media is ${question.review?.media || "unset"}`);
    }
  }
}

const simulatedStudentPositionCounts = {};
if (answerPolicy && questionRecords.length) {
  const attempts = Number(answerPolicy.validation?.synthetic_attempts);
  const tolerance = Number(answerPolicy.validation?.maximum_absolute_position_share_deviation);
  if (!Number.isInteger(attempts) || attempts < 20 || attempts > 1000) {
    errors.push("answer-order policy synthetic_attempts must be an integer from 20 to 1000");
  }
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 0.15) {
    errors.push("answer-order policy position-share deviation must be greater than 0 and at most 0.15");
  }

  if (Number.isInteger(attempts) && attempts >= 20 && attempts <= 1000 && Number.isFinite(tolerance)) {
    const groups = new Map();
    for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
      const attemptSeed = `validation-attempt-${attemptIndex + 1}`;
      for (const record of questionRecords) {
        const position = correctPositionForAttempt(record.question, attemptSeed);
        if (!position) {
          errors.push(`${record.pointer}: shuffled order lost the correct option`);
          continue;
        }
        const group = groups.get(record.optionCount) || { total: 0, counts: {} };
        group.total += 1;
        increment(group.counts, String(position));
        groups.set(record.optionCount, group);
      }
    }

    for (const [optionCount, group] of groups.entries()) {
      const expectedShare = 1 / optionCount;
      simulatedStudentPositionCounts[String(optionCount)] = group.counts;
      for (let position = 1; position <= optionCount; position += 1) {
        const actualShare = (group.counts[String(position)] || 0) / group.total;
        if (Math.abs(actualShare - expectedShare) > tolerance) {
          errors.push(
            `student-facing shuffle is biased for ${optionCount}-option questions at position ${position}: ` +
            `${actualShare.toFixed(4)} versus expected ${expectedShare.toFixed(4)}`,
          );
        }
      }
    }
  }
}

const summary = {
  research_root: path.relative(root, researchRoot),
  batches: draftFiles.length,
  questions: questionCount,
  media_references: mediaCount,
  authored_correct_position_counts: authoredPositionCounts,
  student_delivery_shuffle: answerPolicy?.student_delivery?.shuffle_required === true,
  simulated_student_position_counts: simulatedStudentPositionCounts,
  errors: errors.length,
  warnings: warnings.length,
};

console.log(JSON.stringify(summary, null, 2));
for (const warning of warnings) console.warn(`WARNING: ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exitCode = 1;
} else {
  console.log("USMLE research drafts passed fail-closed validation.");
}
