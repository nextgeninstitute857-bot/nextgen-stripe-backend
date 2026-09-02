import path from "node:path";
import { EXISTING_DRAFTS_ROOT, filesUnder, readJson } from "./usmle-pilot-core.mjs";

function normalizeText(value) {
  return String(value || "").toLowerCase().replace(/<[^>]*>/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

export function shingles(value, size = 5) {
  const words = normalizeText(value).split(/\s+/).filter(Boolean);
  const result = new Set();
  for (let index = 0; index <= words.length - size; index += 1) {
    result.add(words.slice(index, index + size).join(" "));
  }
  return result;
}

export function jaccard(left, right) {
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection || 1);
}

export function normalizeQuestion(question) {
  if (!question || typeof question !== "object") return question;
  const wrong = Array.isArray(question.wrong_choice_explanations)
    ? Object.fromEntries(question.wrong_choice_explanations.map((item) => [String(item.option_id), item.explanation]))
    : question.wrong_choice_explanations || {};
  return { ...question, wrong_choice_explanations: wrong };
}

export function validateQuestionShape(question) {
  const errors = [];
  if (question.exam_track !== "usmle-step-1") errors.push("wrong exam track");
  if (!question.taxonomy || ["system", "subsystem", "topic", "subtopic"].some((key) => !String(question.taxonomy[key] || "").trim())) {
    errors.push("incomplete taxonomy");
  }
  if (!Array.isArray(question.options) || question.options.length !== 5) errors.push("exactly five options required");
  const ids = (question.options || []).map((option) => Number(option.id));
  if (new Set(ids).size !== 5 || !ids.includes(Number(question.correct_option_id))) errors.push("invalid option IDs or correct answer");
  for (const id of ids) {
    if (id !== Number(question.correct_option_id) && !String(question.wrong_choice_explanations?.[String(id)] || "").trim()) {
      errors.push(`missing rationale for ${id}`);
    }
  }
  if (!Array.isArray(question.references) || question.references.length < 2) errors.push("at least two references required");
  if (!question.media_spec || typeof question.media_spec.required !== "boolean") errors.push("media specification required");
  return errors;
}

export function loadExistingQuestionFingerprints() {
  const fingerprints = [];
  for (const filename of filesUnder(EXISTING_DRAFTS_ROOT)) {
    let batch;
    try { batch = readJson(filename); } catch { continue; }
    for (const question of batch.questions || []) {
      fingerprints.push({
        id: question.draft_id || path.basename(filename),
        shingles: shingles(`${question.stem_html || ""} ${question.educational_objective || ""}`),
      });
    }
  }
  return fingerprints;
}

export function balanceAuthoredPositions(questions) {
  return questions.map((question, index) => {
    const position = (index % 5) + 1;
    const options = [...question.options];
    const correctIndex = options.findIndex((option) => Number(option.id) === Number(question.correct_option_id));
    const [correct] = options.splice(correctIndex, 1);
    options.splice(position - 1, 0, correct);
    return { ...question, options };
  });
}

export async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}
