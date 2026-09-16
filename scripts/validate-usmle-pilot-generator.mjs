import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const configPath = path.join(root, "research", "usmle-step1-2026", "pilot-100", "config.json");
const queuePath = path.join(root, "research", "usmle-step1-2026", "coverage", "media-priority-queue-batch-001.json");
const runnerPath = path.join(root, "scripts", "run-usmle-pilot-generator.mjs");
const errors = [];

for (const filename of [configPath, queuePath, runnerPath]) {
  if (!fs.existsSync(filename)) errors.push(`missing ${path.relative(root, filename)}`);
}
let config = null;
let queue = null;
try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch (error) { errors.push(`invalid config: ${error.message}`); }
try { queue = JSON.parse(fs.readFileSync(queuePath, "utf8")); } catch (error) { errors.push(`invalid priority queue: ${error.message}`); }

if (config) {
  if (config.status !== "private_research_draft" || config.publication_allowed !== false) errors.push("pilot must remain private and publication-blocked");
  if (config.target_questions !== 100) errors.push("target_questions must equal 100");
  if (config.workers?.concurrency !== 10) errors.push("pilot concurrency must equal 10");
  if (config.limits?.maximum_api_requests > 220) errors.push("request ceiling may not exceed 220");
  if (config.limits?.maximum_retries_per_request > 1) errors.push("request retries may not exceed one");
  if (config.output?.write_into_release_drafts !== false || config.output?.commit_results_automatically !== false) {
    errors.push("pilot may not write release drafts or auto-commit results");
  }
  if (config.quality?.clinician_review_required !== true || config.quality?.proprietary_similarity_review_required !== true) {
    errors.push("clinician and proprietary-corpus similarity review must remain required");
  }
  const plannedCalls = Number(config.planner?.maximum_calls)
    + Number(config.workers?.writer_calls)
    + Number(config.workers?.reviewer_calls)
    + Number(config.workers?.maximum_revision_calls);
  if (plannedCalls > config.limits?.maximum_api_requests) {
    errors.push(`planned calls ${plannedCalls} exceed request ceiling`);
  }
}
if (queue && (!Array.isArray(queue.items) || queue.items.length < 25)) {
  errors.push("priority queue needs at least 25 clusters");
}

if (!errors.length) {
  const temporaryRunId = `validation-${Date.now()}`;
  const result = spawnSync(process.execPath, [runnerPath, "--dry-run"], {
    cwd: root,
    env: { ...process.env, AYLA_PILOT_RUN_ID: temporaryRunId },
    encoding: "utf8",
  });
  if (result.status !== 0) errors.push(`dry run failed: ${result.stderr || result.stdout}`);
  const runRoot = path.join(root, config.output.root, temporaryRunId);
  try {
    const state = JSON.parse(fs.readFileSync(path.join(runRoot, "state.json"), "utf8"));
    const objectives = JSON.parse(fs.readFileSync(path.join(runRoot, "planned-objectives.json"), "utf8"));
    if (state.status !== "dry_run_complete") errors.push("dry-run state did not complete");
    if (state.planned_questions !== 100 || objectives.length !== 100) errors.push("dry run did not plan exactly 100 questions");
    if (state.concurrent_workers !== 10) errors.push("dry-run concurrency changed");
  } catch (error) {
    errors.push(`dry-run outputs invalid: ${error.message}`);
  } finally {
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  generator: path.relative(root, runnerPath),
  target_questions: config?.target_questions || null,
  concurrency: config?.workers?.concurrency || null,
  maximum_api_requests: config?.limits?.maximum_api_requests || null,
  errors: errors.length,
}, null, 2));
if (errors.length) {
  errors.forEach((error) => console.error(`ERROR: ${error}`));
  process.exitCode = 1;
} else {
  console.log("USMLE 100-question pilot generator passed bounded dry-run validation.");
}
