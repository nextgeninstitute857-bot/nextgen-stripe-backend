import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const researchRoot = path.join(root, "research", "usmle-step1-2026");
const draftsRoot = path.join(researchRoot, "drafts");
const requiredTaxonomy = ["system", "subsystem", "topic", "subtopic"];
const proprietaryBrandPattern = /\b(?:uworld|amboss|world\s+qbank)\b/i;

function filesUnder(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory()
      ? filesUnder(absolute, suffix)
      : entry.name.endsWith(suffix) ? [absolute] : [];
  });
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

const errors = [];
const warnings = [];
const seenIds = new Set();
let questionCount = 0;
let mediaCount = 0;

for (const filename of filesUnder(draftsRoot, ".json")) {
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

const summary = {
  research_root: path.relative(root, researchRoot),
  batches: filesUnder(draftsRoot, ".json").length,
  questions: questionCount,
  media_references: mediaCount,
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
