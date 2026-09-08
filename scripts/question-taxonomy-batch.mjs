#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, prepareQuestionTaxonomyBatch, parseBatchResultJsonl, validateQuestionTaxonomyBatchResults } from '../lib/question-taxonomy-batch-preparation.js';

const usage = `Offline question taxonomy proposals (no network, credentials or live writes).
prepare --input evidence.json --out-dir NEW_DIRECTORY --model EXPLICIT_MODEL
        [--max-questions 25] [--max-request-bytes 131072] [--max-batch-bytes 1048576]
validate --manifest preparation.json --results results.jsonl --out proposals.json
Combine downloaded output and error JSONL rows in results.jsonl before validation.
Output is NEEDS_REVIEW; this tool cannot create or apply an approved review manifest.`;

async function readBounded(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMITS.fileBytes) throw new Error('Input is not a regular file within the 32 MiB limit');
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text) > LIMITS.fileBytes) throw new Error('Input exceeds the 32 MiB limit');
    return text.replace(/^\uFEFF/, '');
  } finally { await handle.close(); }
}
async function readJson(file) {
  const text = await readBounded(file);
  try { return JSON.parse(text); } catch { throw new Error('Input file contains invalid JSON'); }
}
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') { console.log(usage); process.exit(0); }
  if (!['prepare', 'validate'].includes(command)) throw new Error(usage);
  const allowed = command === 'prepare' ? ['input', 'out-dir', 'model', 'max-questions', 'max-request-bytes', 'max-batch-bytes'] : ['manifest', 'results', 'out'];
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2); const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !allowed.includes(key) || Object.hasOwn(options, key) || !value || value.startsWith('--')) throw new Error('Unknown, duplicate or missing command option');
    options[key] = value;
  }
  for (const key of command === 'prepare' ? ['input', 'out-dir', 'model'] : ['manifest', 'results', 'out']) {
    if (!options[key]) throw new Error(`Required option: --${key}`);
  }
  if (command === 'prepare') {
    const prepared = prepareQuestionTaxonomyBatch(await readJson(options.input), { model: options.model,
      maxQuestions: options['max-questions'], maxRequestBytes: options['max-request-bytes'], maxBatchBytes: options['max-batch-bytes'] });
    // A new directory is mandatory: a failed/partial run can never overwrite a
    // prior batch. Write the manifest last so incomplete runs lack a receipt.
    await fs.mkdir(options['out-dir']);
    await fs.writeFile(path.join(options['out-dir'], 'requests.jsonl'), prepared.jsonl, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(options['out-dir'], 'preparation.json'), JSON.stringify(prepared.manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ state: 'NEEDS_REVIEW', prepared: prepared.manifest.prepared_count, held: prepared.manifest.held_count, estimate: prepared.manifest.estimate }));
    if (!prepared.manifest.prepared_count) process.exitCode = 2;
  } else {
    const result = validateQuestionTaxonomyBatchResults(await readJson(options.manifest), parseBatchResultJsonl(await readBounded(options.results)));
    await fs.writeFile(options.out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ state: result.state, complete: result.complete, proposals: result.proposal_count, failures: result.failed_count }));
    if (!result.complete) process.exitCode = 2;
  }
} catch (error) {
  // Native filesystem messages expose paths only; JSON/body parser diagnostics
  // are replaced above so full private clinical source never reaches stdout.
  console.error(error.message);
  process.exitCode = 1;
}
