import fs from "node:fs";
import path from "node:path";
import { correctPositionForAttempt } from "./lib/answer-order-policy.mjs";

const root = process.cwd();
const researchRoot = path.join(root, "research", "usmle-step1-2026");
const draftsRoot = path.join(researchRoot, "drafts");
const policy = JSON.parse(fs.readFileSync(path.join(researchRoot, "answer-order-policy.json"), "utf8"));

function filesUnder(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory()
      ? filesUnder(absolute, suffix)
      : entry.name.endsWith(suffix) ? [absolute] : [];
  }).sort();
}

function increment(counter, key) {
  counter[key] = (counter[key] || 0) + 1;
}

const questions = filesUnder(draftsRoot, ".json").flatMap((filename) => {
  const batch = JSON.parse(fs.readFileSync(filename, "utf8"));
  return (batch.questions || []).map((question, index) => ({
    question,
    pointer: `${path.relative(root, filename)}#questions[${index}]`,
  }));
});

const errors = [];
const authoredGroups = new Map();
const authoredCounts = {};
const authoredSequence = [];

for (const { question, pointer } of questions) {
  const options = Array.isArray(question.options) ? question.options : [];
  const position = options.findIndex(
    (option) => String(option?.id) === String(question.correct_option_id),
  ) + 1;
  if (!position) {
    errors.push(`${pointer}: correct option is missing from authored options`);
    continue;
  }

  increment(authoredCounts, String(position));
  authoredSequence.push(position);
  const group = authoredGroups.get(options.length) || { total: 0, counts: {} };
  group.total += 1;
  increment(group.counts, String(position));
  authoredGroups.set(options.length, group);
}

let longestRun = 0;
let run = 0;
let previous = null;
for (const position of authoredSequence) {
  run = position === previous ? run + 1 : 1;
  previous = position;
  longestRun = Math.max(longestRun, run);
}

const maxShare = Number(policy.authoring?.future_batch_max_authored_position_share);
const maxRun = Number(policy.authoring?.future_batch_max_consecutive_same_position);
for (const [optionCount, group] of authoredGroups.entries()) {
  for (let position = 1; position <= optionCount; position += 1) {
    const share = (group.counts[String(position)] || 0) / group.total;
    if (share > maxShare) {
      errors.push(
        `authored position ${position} has ${(share * 100).toFixed(1)}% of ${optionCount}-option answers; ` +
        `maximum is ${(maxShare * 100).toFixed(1)}%`,
      );
    }
  }
}
if (longestRun > maxRun) {
  errors.push(`authored answer position repeats ${longestRun} times; maximum is ${maxRun}`);
}

const attempts = Number(policy.validation?.synthetic_attempts);
const tolerance = Number(policy.validation?.maximum_absolute_position_share_deviation);
const simulatedGroups = new Map();
for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
  const attemptSeed = `validation-attempt-${attemptIndex + 1}`;
  for (const { question, pointer } of questions) {
    const optionCount = question.options.length;
    const position = correctPositionForAttempt(question, attemptSeed);
    if (!position) {
      errors.push(`${pointer}: shuffled order lost the correct option`);
      continue;
    }
    const group = simulatedGroups.get(optionCount) || { total: 0, counts: {} };
    group.total += 1;
    increment(group.counts, String(position));
    simulatedGroups.set(optionCount, group);
  }
}

const simulatedCounts = {};
for (const [optionCount, group] of simulatedGroups.entries()) {
  const expected = 1 / optionCount;
  simulatedCounts[String(optionCount)] = group.counts;
  for (let position = 1; position <= optionCount; position += 1) {
    const share = (group.counts[String(position)] || 0) / group.total;
    if (Math.abs(share - expected) > tolerance) {
      errors.push(
        `student shuffle position ${position} for ${optionCount}-option questions is biased: ` +
        `${share.toFixed(4)} versus ${expected.toFixed(4)}`,
      );
    }
  }
}

console.log(JSON.stringify({
  questions: questions.length,
  authored_correct_position_counts: authoredCounts,
  authored_longest_same_position_run: longestRun,
  simulated_student_position_counts: simulatedCounts,
  errors: errors.length,
}, null, 2));

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exitCode = 1;
} else {
  console.log("USMLE answer positions passed authored-balance and student-shuffle validation.");
}
