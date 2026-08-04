import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  ROOT, CONFIG_PATH, QUEUE_PATH, Budget, callResponses, isoRunId, readJson, writeJson,
} from "./lib/usmle-pilot-core.mjs";
import { objectiveSchema, questionSchema, reviewSchema } from "./lib/usmle-pilot-schemas.mjs";
import {
  balanceAuthoredPositions, jaccard, loadExistingQuestionFingerprints,
  normalizeQuestion, pool, shingles, validateQuestionShape,
} from "./lib/usmle-pilot-quality.mjs";

function createDryRunPlan(config, queue) {
  const clusters = queue.items.slice(0, 25);
  const objectives = clusters.flatMap((cluster, clusterIndex) => Array.from({ length: 4 }, (_, objectiveIndex) => ({
    seed_id: `DRY-${String(clusterIndex + 1).padStart(2, "0")}-${objectiveIndex + 1}`,
    system: cluster.system,
    subsystem: cluster.subsystem,
    topic: cluster.topic,
    subtopic: `planned objective ${objectiveIndex + 1}`,
    learning_objective: `Dry-run placeholder for ${cluster.topic} objective ${objectiveIndex + 1}`,
    difficulty: ["easy", "moderate", "moderate", "hard"][objectiveIndex],
    media_required: Boolean(cluster.media_required),
    media_type: cluster.media_modalities?.[0] || "none",
    research_queries: [`${cluster.topic} mechanism authoritative medical source`],
  })));
  if (objectives.length !== config.target_questions) {
    throw new Error(`Dry-run planned ${objectives.length}; expected ${config.target_questions}.`);
  }
  return { clusters, objectives };
}

function executionAllowed() {
  return process.argv.includes("--execute") && process.env.AYLA_PILOT_EXECUTE === "yes";
}

function assertExecutionEnvironment() {
  if (!String(process.env.OPENAI_API_KEY || "").trim()) throw new Error("OPENAI_API_KEY is required.");
  if (!Number.isFinite(Number(process.env.AYLA_INPUT_USD_PER_MILLION))) {
    throw new Error("AYLA_INPUT_USD_PER_MILLION is required for the dollar ceiling.");
  }
  if (!Number.isFinite(Number(process.env.AYLA_OUTPUT_USD_PER_MILLION))) {
    throw new Error("AYLA_OUTPUT_USD_PER_MILLION is required for the dollar ceiling.");
  }
}

async function planObjectives({ config, queue, budget, state, statePath, runRoot }) {
  const clusters = queue.items.slice(0, 25);
  const groups = Array.from({ length: 5 }, (_, index) => clusters.slice(index * 5, index * 5 + 5));
  const planned = [];
  for (const [groupIndex, group] of groups.entries()) {
    const result = await callResponses({
      config,
      budget,
      role: "planner",
      schemaName: "usmle_objective_plan",
      schema: objectiveSchema,
      instructions: "Plan distinct original USMLE Step 1 learning objectives. Use authoritative web sources only. Return exactly four non-overlapping objectives per supplied cluster and twenty objectives total. Never copy or closely paraphrase proprietary QBank content.",
      input: JSON.stringify({ group_index: groupIndex + 1, clusters: group }),
    });
    state.planning.push({ group_index: groupIndex + 1, response_id: result.responseId, usage: result.usage });
    planned.push(...result.data.objectives);
    state.budget = budget.snapshot();
    writeJson(statePath, state);
  }
  if (planned.length !== config.target_questions) {
    throw new Error(`Planner returned ${planned.length}; expected ${config.target_questions}.`);
  }
  writeJson(path.join(runRoot, "planned-objectives.json"), planned);
  return planned;
}

async function writeQuestions({ config, planned, budget, state, statePath, runRoot }) {
  return pool(planned, config.workers.concurrency, async (objective, index) => {
    try {
      const result = await callResponses({
        config,
        budget,
        role: "writer",
        schemaName: "usmle_question_draft",
        schema: questionSchema,
        instructions: "Write one original USMLE Step 1 single-best-answer question. Verify facts with authoritative web sources, use five plausible options, explain every distractor, avoid answer-pattern clues, and never copy or closely paraphrase proprietary QBank text or media.",
        input: JSON.stringify({ sequence: index + 1, objective }),
      });
      const question = normalizeQuestion(result.data);
      const errors = validateQuestionShape(question);
      const row = { index, objective, response_id: result.responseId, usage: result.usage, question, errors };
      state.writing[index] = { index, response_id: result.responseId, errors };
      state.budget = budget.snapshot();
      writeJson(path.join(runRoot, "writer", `${String(index + 1).padStart(3, "0")}.json`), row);
      writeJson(statePath, state);
      return row;
    } catch (error) {
      const row = { index, objective, error: error.message };
      state.writing[index] = row;
      writeJson(path.join(runRoot, "writer", `${String(index + 1).padStart(3, "0")}.json`), row);
      writeJson(statePath, state);
      return row;
    }
  });
}

async function reviewQuestions({ config, written, budget, state, statePath, runRoot }) {
  return pool(written, config.workers.concurrency, async (row, index) => {
    if (!row.question || row.errors?.length) {
      return { index, accepted: false, error: row.error || row.errors?.join("; ") || "writer_failed" };
    }
    try {
      const result = await callResponses({
        config,
        budget,
        role: "reviewer",
        schemaName: "usmle_question_review",
        schema: reviewSchema,
        instructions: "Act as an independent medical editor. Verify facts and citations with authoritative web sources. Reject ambiguity, unsupported claims, weak distractors, answer leakage, multiple-correct options, or unsafe/outdated medicine. Revise when needed. Never approve publication.",
        input: JSON.stringify({ objective: row.objective, question: row.question }),
      });
      const finalQuestion = normalizeQuestion(result.data.final_question);
      result.data.final_question = finalQuestion;
      const shapeErrors = validateQuestionShape(finalQuestion);
      const scoreFailure = Object.values(result.data.scores || {}).some(
        (value) => Number(value) < config.quality.minimum_reviewer_score,
      );
      const accepted = !shapeErrors.length && !scoreFailure && result.data.decision !== "reject";
      const reviewRow = {
        index,
        response_id: result.responseId,
        usage: result.usage,
        review: result.data,
        accepted,
        shape_errors: shapeErrors,
      };
      state.reviewing[index] = {
        index,
        response_id: result.responseId,
        accepted,
        decision: result.data.decision,
        shape_errors: shapeErrors,
      };
      state.budget = budget.snapshot();
      writeJson(path.join(runRoot, "reviewer", `${String(index + 1).padStart(3, "0")}.json`), reviewRow);
      writeJson(statePath, state);
      return reviewRow;
    } catch (error) {
      const reviewRow = { index, accepted: false, error: error.message };
      state.reviewing[index] = reviewRow;
      writeJson(path.join(runRoot, "reviewer", `${String(index + 1).padStart(3, "0")}.json`), reviewRow);
      writeJson(statePath, state);
      return reviewRow;
    }
  });
}

function applySimilarityAndReviewGates({ reviewed, config, runId }) {
  const existingFingerprints = loadExistingQuestionFingerprints();
  const accepted = [];
  const quarantined = [];
  for (const [index, row] of reviewed.entries()) {
    if (!row.accepted) {
      quarantined.push({ index, reason: row.error || row.review?.decision || "review_failed" });
      continue;
    }
    const question = row.review.final_question;
    const candidate = shingles(`${question.stem_html} ${question.educational_objective}`);
    let maximum = 0;
    let closest = null;
    for (const fingerprint of existingFingerprints) {
      const similarity = jaccard(candidate, fingerprint.shingles);
      if (similarity > maximum) {
        maximum = similarity;
        closest = fingerprint.id;
      }
    }
    for (const existing of accepted) {
      const similarity = jaccard(candidate, shingles(`${existing.stem_html} ${existing.educational_objective}`));
      if (similarity > maximum) {
        maximum = similarity;
        closest = existing.draft_id;
      }
    }
    if (maximum > config.quality.maximum_internal_shingle_similarity) {
      quarantined.push({
        index,
        draft_id: question.draft_id,
        reason: "internal_similarity",
        maximum_similarity: maximum,
        closest,
      });
      continue;
    }
    accepted.push({
      ...question,
      review: {
        factual: "machine_pre_review_passed_clinician_pending",
        similarity: "internal_passed_proprietary_corpus_pending",
        media: question.media_spec.required ? "specification_ready_asset_pending" : "not_required",
        publication: "blocked",
      },
      pilot_provenance: {
        run_id: runId,
        writer_index: index + 1,
        reviewer_response_id: row.response_id,
      },
    });
  }
  return { accepted: balanceAuthoredPositions(accepted), quarantined };
}

async function main() {
  const config = readJson(CONFIG_PATH);
  const queue = readJson(QUEUE_PATH);
  const execute = executionAllowed();
  if (process.argv.includes("--execute") && !execute) {
    throw new Error("Execution requires both --execute and AYLA_PILOT_EXECUTE=yes.");
  }
  if (execute) assertExecutionEnvironment();

  const runId = process.env.AYLA_PILOT_RUN_ID || isoRunId();
  const runRoot = path.join(ROOT, config.output.root, runId);
  fs.mkdirSync(runRoot, { recursive: true });
  const statePath = path.join(runRoot, "state.json");
  const state = fs.existsSync(statePath) ? readJson(statePath) : {
    schema_version: "aylamed-usmle-pilot-run-v1",
    run_id: runId,
    status: execute ? "running" : "dry_run",
    created_at: new Date().toISOString(),
    publication_allowed: false,
    live_writes_performed: 0,
    planning: [],
    writing: [],
    reviewing: [],
    accepted: [],
    quarantined: [],
    budget: {},
  };

  if (!execute) {
    const plan = createDryRunPlan(config, queue);
    state.status = "dry_run_complete";
    state.planned_clusters = plan.clusters.length;
    state.planned_questions = plan.objectives.length;
    state.maximum_api_requests = config.limits.maximum_api_requests;
    state.concurrent_workers = config.workers.concurrency;
    writeJson(statePath, state);
    writeJson(path.join(runRoot, "planned-objectives.json"), plan.objectives);
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  const budget = new Budget(config);
  const planned = await planObjectives({ config, queue, budget, state, statePath, runRoot });
  const written = await writeQuestions({ config, planned, budget, state, statePath, runRoot });
  const reviewed = await reviewQuestions({ config, written, budget, state, statePath, runRoot });
  const gated = applySimilarityAndReviewGates({ reviewed, config, runId });

  state.status = gated.accepted.length === config.target_questions
    ? "completed"
    : "completed_with_quarantine";
  state.accepted = gated.accepted.map((question) => question.draft_id);
  state.quarantined = gated.quarantined;
  state.budget = budget.snapshot();
  state.completed_at = new Date().toISOString();
  writeJson(path.join(runRoot, "accepted-private-drafts.json"), {
    schema_version: "aylamed-usmle-pilot-accepted-v1",
    status: "private_research_draft",
    publication_allowed: false,
    run_id: runId,
    target: config.target_questions,
    accepted_count: gated.accepted.length,
    questions: gated.accepted,
  });
  writeJson(path.join(runRoot, "quarantine.json"), gated.quarantined);
  writeJson(statePath, state);
  console.log(JSON.stringify({
    run_id: runId,
    status: state.status,
    accepted: gated.accepted.length,
    quarantined: gated.quarantined.length,
    budget: state.budget,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
