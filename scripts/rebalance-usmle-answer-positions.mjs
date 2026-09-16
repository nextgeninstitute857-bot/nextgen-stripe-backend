import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const draftsRoot = path.join(root, "research", "usmle-step1-2026", "drafts");
const checkOnly = process.argv.includes("--check");

function filesUnder(directory, suffix) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory()
      ? filesUnder(absolute, suffix)
      : entry.name.endsWith(suffix) ? [absolute] : [];
  }).sort();
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function assignBalancedPositions(records, optionCount) {
  const remaining = Array.from({ length: optionCount }, (_, index) => {
    const base = Math.floor(records.length / optionCount);
    const extra = index < records.length % optionCount ? 1 : 0;
    return base + extra;
  });
  const assignments = new Map();
  const recent = [];

  for (const record of records) {
    let candidates = remaining
      .map((count, index) => ({ position: index + 1, count }))
      .filter(({ count }) => count > 0);

    if (recent.length >= 2 && recent.at(-1) === recent.at(-2)) {
      const filtered = candidates.filter(({ position }) => position !== recent.at(-1));
      if (filtered.length) candidates = filtered;
    }

    candidates.sort((left, right) => {
      const leftRank = hash(`aylamed-authored-position-v1\u0000${record.draftId}\u0000${left.position}`);
      const rightRank = hash(`aylamed-authored-position-v1\u0000${record.draftId}\u0000${right.position}`);
      return leftRank.localeCompare(rightRank) || right.count - left.count || left.position - right.position;
    });

    const selected = candidates[0].position;
    assignments.set(record.draftId, selected);
    remaining[selected - 1] -= 1;
    recent.push(selected);
  }

  return assignments;
}

function reorderQuestion(question, targetPosition) {
  const correctId = String(question.correct_option_id);
  const correct = question.options.find((option) => String(option.id) === correctId);
  if (!correct) throw new Error(`${question.draft_id}: correct option is missing`);

  const distractors = question.options
    .filter((option) => String(option.id) !== correctId)
    .sort((left, right) => {
      const leftRank = hash(`aylamed-distractor-order-v1\u0000${question.draft_id}\u0000${left.id}`);
      const rightRank = hash(`aylamed-distractor-order-v1\u0000${question.draft_id}\u0000${right.id}`);
      return leftRank.localeCompare(rightRank) || Number(left.id) - Number(right.id);
    });

  const reordered = [...distractors];
  reordered.splice(targetPosition - 1, 0, correct);
  return { ...question, options: reordered };
}

const files = filesUnder(draftsRoot, ".json");
const loaded = files.map((filename) => {
  const source = fs.readFileSync(filename, "utf8");
  return { filename, source, pretty: source.includes("\n"), batch: JSON.parse(source) };
});

const records = [];
for (const file of loaded) {
  for (const question of file.batch.questions || []) {
    if (!Array.isArray(question.options) || question.options.length < 4 || question.options.length > 6) {
      throw new Error(`${question.draft_id}: expected 4-6 options`);
    }
    records.push({ draftId: String(question.draft_id), optionCount: question.options.length });
  }
}

const assignments = new Map();
for (const optionCount of [...new Set(records.map((record) => record.optionCount))].sort()) {
  const group = records
    .filter((record) => record.optionCount === optionCount)
    .sort((left, right) => left.draftId.localeCompare(right.draftId));
  for (const [draftId, position] of assignBalancedPositions(group, optionCount)) {
    assignments.set(draftId, position);
  }
}

let changedFiles = 0;
const positionCounts = {};
const sequence = [];
for (const file of loaded) {
  file.batch.questions = (file.batch.questions || []).map((question) => {
    const target = assignments.get(String(question.draft_id));
    const reordered = reorderQuestion(question, target);
    positionCounts[target] = (positionCounts[target] || 0) + 1;
    sequence.push(target);
    return reordered;
  });

  const next = file.pretty ? `${JSON.stringify(file.batch, null, 2)}\n` : JSON.stringify(file.batch);
  if (next !== file.source) {
    changedFiles += 1;
    if (!checkOnly) fs.writeFileSync(file.filename, next);
  }
}

let longestRun = 0;
let run = 0;
let previous = null;
for (const position of sequence) {
  run = position === previous ? run + 1 : 1;
  previous = position;
  longestRun = Math.max(longestRun, run);
}

const summary = {
  files: files.length,
  questions: records.length,
  correct_position_counts: positionCounts,
  longest_same_position_run: longestRun,
  changed_files: changedFiles,
  mode: checkOnly ? "check" : "write",
};
console.log(JSON.stringify(summary, null, 2));

if (longestRun > 3) {
  throw new Error(`authored answer-position run is too long: ${longestRun}`);
}
if (checkOnly && changedFiles) {
  throw new Error(`${changedFiles} draft files are not deterministically rebalanced`);
}
