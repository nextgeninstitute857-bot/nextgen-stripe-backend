import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import Busboy from "busboy";
import yauzl from "yauzl";
import { adaptUniversalQuestion, mediaMatchKeys, pairQuestionAnswerFiles, slug, validateAdaptedQuestion } from "./content-import-adapter.js";
import { findDuplicateSignals } from "./content-registry-postgres.js";

const require = createRequire(import.meta.url);
const { chain } = require("stream-chain");
const { parser } = require("stream-json");
const { streamArray } = require("stream-json/streamers/StreamArray");

const MAX_UPLOAD_BYTES = Math.max(1024 * 1024, Number(process.env.NEXTGEN_CONTENT_MAX_ZIP_BYTES || 5 * 1024 ** 3));
const MAX_UNCOMPRESSED_BYTES = Math.max(MAX_UPLOAD_BYTES, Number(process.env.NEXTGEN_CONTENT_MAX_UNCOMPRESSED_BYTES || 10 * 1024 ** 3));
const MAX_ZIP_ENTRIES = Math.max(100, Number(process.env.NEXTGEN_CONTENT_MAX_ZIP_ENTRIES || 100000));
const MAX_QUESTIONS_PER_JOB = Math.max(1_000, Number(process.env.NEXTGEN_CONTENT_MAX_QUESTIONS_PER_JOB || 1_000_000));
const MAX_ANSWER_CHOICES_PER_COLLECTION = Math.max(1_000, Number(process.env.NEXTGEN_CONTENT_MAX_ANSWER_CHOICES_PER_COLLECTION || 250_000));

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}

function openEntry(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
}

async function sha256File(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function receiveContentZip(req, dataDir) {
  const uploadDir = path.join(dataDir, "content-imports", "uploads");
  await fsp.mkdir(uploadDir, { recursive: true });
  const tempPath = path.join(uploadDir, `${crypto.randomUUID()}.zip.part`);
  const fields = {};
  let originalFilename = "upload.zip";
  let fileSeen = false;
  let fileWrite;
  await new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD_BYTES, fields: 30, fieldSize: 1024 * 1024 } });
    busboy.on("field", (name, value) => { fields[name] = value; });
    busboy.on("file", (name, stream, info) => {
      if (name !== "zip" && name !== "file") { stream.resume(); return; }
      fileSeen = true;
      originalFilename = path.basename(info.filename || "upload.zip");
      if (!/\.zip$/i.test(originalFilename)) { stream.resume(); reject(Object.assign(new Error("Only ZIP uploads are accepted"), { statusCode: 400 })); return; }
      fileWrite = pipeline(stream, fs.createWriteStream(tempPath, { flags: "wx" }));
      stream.on("limit", () => reject(Object.assign(new Error("ZIP exceeds the configured streaming upload limit"), { statusCode: 413 })));
    });
    busboy.on("error", reject);
    busboy.on("finish", resolve);
    req.pipe(busboy);
  });
  if (!fileSeen || !fileWrite) throw Object.assign(new Error("Multipart field 'zip' is required"), { statusCode: 400 });
  await fileWrite;
  const finalPath = tempPath.replace(/\.part$/, "");
  await fsp.rename(tempPath, finalPath);
  return { file: finalPath, fields, originalFilename, sha256: await sha256File(finalPath) };
}

export async function extractSafeZipInventory(zipFile, jobId, dataDir) {
  const safeJobId = String(jobId || "").trim();
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(safeJobId)) throw Object.assign(new Error("Invalid content import work ID"), { statusCode: 400 });
  const workRoot = path.join(dataDir, "content-imports", "work");
  const workDir = path.join(workRoot, safeJobId);
  // Every attempt extracts into the same tightly-scoped directory. Clearing
  // only this generated job directory makes interrupted extraction retryable
  // without ever targeting the DATA_DIR or another import.
  await fsp.rm(workDir, { recursive: true, force: true });
  await fsp.mkdir(workDir, { recursive: true });
  const extractedJson = new Map();
  const mediaKeys = new Set();
  const names = [];
  const zip = await openZip(zipFile);
  let entryCount = 0;
  let uncompressedBytes = 0;
  await new Promise((resolve, reject) => {
    zip.on("entry", async (entry) => {
      try {
        entryCount += 1;
        if (entryCount > MAX_ZIP_ENTRIES) throw Object.assign(new Error("ZIP has too many entries"), { statusCode: 413 });
        const normalized = String(entry.fileName || "").replace(/\\/g, "/");
        if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw Object.assign(new Error("Unsafe ZIP entry path"), { statusCode: 400 });
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw Object.assign(new Error("Encrypted ZIP entries are not supported"), { statusCode: 400 });
        uncompressedBytes += Number(entry.uncompressedSize || 0);
        if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw Object.assign(new Error("ZIP expands beyond the configured safety limit"), { statusCode: 413 });
        if (/\/$/.test(normalized)) { zip.readEntry(); return; }
        names.push(normalized);
        if (/\.json$/i.test(normalized)) {
          const output = path.join(workDir, `${crypto.createHash("sha1").update(normalized).digest("hex")}.json`);
          const stream = await openEntry(zip, entry);
          await pipeline(stream, fs.createWriteStream(output, { flags: "wx" }));
          extractedJson.set(normalized, output);
        } else {
          mediaMatchKeys(normalized).forEach((key) => mediaKeys.add(key));
        }
        zip.readEntry();
      } catch (error) { zip.close(); reject(error); }
    });
    zip.on("end", resolve);
    zip.on("error", reject);
    zip.readEntry();
  });
  return { workDir, extractedJson, mediaKeys, names, entryCount, uncompressedBytes };
}

async function readJsonArray(file, onValue) {
  const pipelineStream = chain([fs.createReadStream(file), parser(), streamArray()]);
  let count = 0;
  for await (const { value } of pipelineStream) { count += 1; await onValue(value); }
  return count;
}

export async function previewUniversalQuestionZip({ inventory, examTrack, sourceNamespace, sourceProvider, collectionTitle, duplicateLookup = findDuplicateSignals }) {
  const pairs = pairQuestionAnswerFiles(inventory.names);
  const counts = {
    collections: pairs.length, question_files: pairs.length, answer_files: pairs.filter((pair) => pair.answerFile).length,
    questions_seen: 0, valid_questions: 0, quarantined: 0, answer_choices: 0,
    exact_duplicates_in_zip: 0, exact_duplicates_existing: 0, source_aliases_existing: 0,
    media_references: 0, media_matched: 0, media_missing: 0,
    zip_entries: inventory.entryCount, uncompressed_bytes: inventory.uncompressedBytes,
  };
  const errors = [];
  const seenHashes = new Set();
  const missingMedia = new Set();
  let hashBatch = [];
  let aliasBatch = [];

  async function flushDuplicateBatch() {
    if (!hashBatch.length && !aliasBatch.length) return;
    const found = await duplicateLookup(examTrack, hashBatch, aliasBatch);
    counts.exact_duplicates_existing += found.exact.length;
    counts.source_aliases_existing += found.source.length;
    hashBatch = [];
    aliasBatch = [];
  }

  for (const pair of pairs) {
    if (!pair.answerFile) { errors.push({ collection: pair.collectionKey, error: "missing_answers_file" }); continue; }
    const questionPath = inventory.extractedJson.get(pair.questionFile);
    const answerPath = inventory.extractedJson.get(pair.answerFile);
    if (!questionPath || !answerPath) { errors.push({ collection: pair.collectionKey, error: "json_entry_not_extracted" }); continue; }
    const answersByQuestion = new Map();
    let answerChoicesInCollection = 0;
    await readJsonArray(answerPath, async (answer) => {
      const key = String(answer.qId ?? answer.questionId ?? "");
      if (!answersByQuestion.has(key)) answersByQuestion.set(key, []);
      answersByQuestion.get(key).push(answer);
      counts.answer_choices += 1;
      answerChoicesInCollection += 1;
      if (answerChoicesInCollection > MAX_ANSWER_CHOICES_PER_COLLECTION || counts.answer_choices > MAX_QUESTIONS_PER_JOB * 12) {
        throw Object.assign(new Error("A collection is too large for the bounded-memory preview; split it into smaller collections"), { statusCode: 413 });
      }
    });
    await readJsonArray(questionPath, async (question) => {
      counts.questions_seen += 1;
      if (counts.questions_seen > MAX_QUESTIONS_PER_JOB) {
        throw Object.assign(new Error("Question ZIP exceeds the configured per-job question limit; split it into multiple imports"), { statusCode: 413 });
      }
      const sourceItemId = String(question.id ?? question.qId ?? question.questionId ?? "");
      const row = adaptUniversalQuestion(question, answersByQuestion.get(sourceItemId) || [], {
        examTrack, sourceNamespace, sourceProvider, collectionKey: pair.collectionKey,
        collectionTitle: `${collectionTitle}: ${pair.collectionKey}`,
      });
      const validation = validateAdaptedQuestion(row);
      if (validation.length) {
        counts.quarantined += 1;
        if (errors.length < 500) errors.push({ collection: pair.collectionKey, source_item_id: sourceItemId, errors: validation });
        return;
      }
      counts.valid_questions += 1;
      if (seenHashes.has(row.contentHash)) counts.exact_duplicates_in_zip += 1;
      else seenHashes.add(row.contentHash);
      row.media.forEach((name) => {
        counts.media_references += 1;
        const matched = mediaMatchKeys(name).some((key) => inventory.mediaKeys.has(key));
        if (matched) counts.media_matched += 1;
        else { counts.media_missing += 1; if (missingMedia.size < 500) missingMedia.add(name); }
      });
      hashBatch.push(row.contentHash);
      aliasBatch.push({ sourceNamespace: slug(sourceNamespace), collectionKey: row.collectionKey, sourceItemId });
      if (hashBatch.length >= 1000) await flushDuplicateBatch();
    });
    answersByQuestion.clear();
  }
  await flushDuplicateBatch();
  counts.unique_questions_in_zip = seenHashes.size;
  return { counts, errors, missingMedia: [...missingMedia], collections: pairs.map((pair) => ({ key: pair.collectionKey, question_file: pair.questionFile, answer_file: pair.answerFile })) };
}

export async function importUniversalQuestionZip({ inventory, job, onBatch, batchSize = 100, checkpoint = {}, onCheckpoint = async () => {} }) {
  const pairs = pairQuestionAnswerFiles(inventory.names);
  const emptyTotals = { collections: 0, questions_seen: 0, valid_questions: 0, quarantined: 0, created: 0, reused: 0, aliases_created: 0, source_duplicates: 0, answers: 0 };
  const totals = { ...emptyTotals, ...(checkpoint?.totals && typeof checkpoint.totals === "object" ? checkpoint.totals : {}) };
  const errors = Array.isArray(checkpoint?.errors) ? checkpoint.errors.slice(0, 500) : [];
  const resumePairIndex = Math.max(0, Number(checkpoint?.pair_index || 0));
  const resumeQuestionOffset = Math.max(0, Number(checkpoint?.questions_processed_in_pair || 0));
  for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
    if (pairIndex < resumePairIndex) continue;
    const pair = pairs[pairIndex];
    if (!pair.answerFile) {
      errors.push({ collection: pair.collectionKey, error: "missing_answers_file" });
      await onCheckpoint({ version: 1, pair_index: pairIndex + 1, collection_key: null, questions_processed_in_pair: 0,
        totals: { ...totals }, errors: errors.slice(0, 500) }, {
        stage: "skipping_invalid_collection", collection_index: pairIndex + 1, collection_count: pairs.length,
        collection_key: pair.collectionKey, totals: { ...totals },
      });
      continue;
    }
    const questionPath = inventory.extractedJson.get(pair.questionFile);
    const answerPath = inventory.extractedJson.get(pair.answerFile);
    if (!questionPath || !answerPath) {
      errors.push({ collection: pair.collectionKey, error: "json_entry_not_extracted" });
      await onCheckpoint({ version: 1, pair_index: pairIndex + 1, collection_key: null, questions_processed_in_pair: 0,
        totals: { ...totals }, errors: errors.slice(0, 500) }, {
        stage: "skipping_invalid_collection", collection_index: pairIndex + 1, collection_count: pairs.length,
        collection_key: pair.collectionKey, totals: { ...totals },
      });
      continue;
    }
    const answersByQuestion = new Map();
    let answerChoicesInCollection = 0;
    await readJsonArray(answerPath, async (answer) => {
      const key = String(answer.qId ?? answer.questionId ?? "");
      if (!answersByQuestion.has(key)) answersByQuestion.set(key, []);
      answersByQuestion.get(key).push(answer);
      answerChoicesInCollection += 1;
      if (answerChoicesInCollection > MAX_ANSWER_CHOICES_PER_COLLECTION) {
        throw Object.assign(new Error("A collection is too large for bounded-memory import; split it into smaller collections"), { statusCode: 413 });
      }
    });
    let batch = [];
    let questionsProcessedInPair = 0;
    const flush = async () => {
      if (!batch.length) return;
      const result = await onBatch({
        collectionKey: pair.collectionKey,
        collectionTitle: `${job.collection_title}: ${pair.collectionKey}`,
        rows: batch,
      });
      totals.created += result.created || 0; totals.reused += result.reused || 0;
      totals.aliases_created += result.aliasesCreated || 0; totals.source_duplicates += result.sourceDuplicates || 0;
      totals.answers += result.answers || 0; batch = [];
      await onCheckpoint({
        version: 1,
        pair_index: pairIndex,
        collection_key: pair.collectionKey,
        questions_processed_in_pair: questionsProcessedInPair,
        totals: { ...totals },
        errors: errors.slice(0, 500),
      }, {
        stage: "importing_questions",
        collection_index: pairIndex + 1,
        collection_count: pairs.length,
        collection_key: pair.collectionKey,
        questions_processed_in_pair: questionsProcessedInPair,
        totals: { ...totals },
      });
    };
    await readJsonArray(questionPath, async (question) => {
      questionsProcessedInPair += 1;
      if (pairIndex === resumePairIndex && questionsProcessedInPair <= resumeQuestionOffset) return;
      totals.questions_seen += 1;
      if (totals.questions_seen > MAX_QUESTIONS_PER_JOB) {
        throw Object.assign(new Error("Question ZIP exceeds the configured per-job question limit; split it into multiple imports"), { statusCode: 413 });
      }
      const sourceItemId = String(question.id ?? question.qId ?? question.questionId ?? "");
      const row = adaptUniversalQuestion(question, answersByQuestion.get(sourceItemId) || [], {
        examTrack: job.exam_track, sourceNamespace: job.source_namespace, sourceProvider: job.source_provider,
        collectionKey: pair.collectionKey, collectionTitle: job.collection_title,
      });
      const validation = validateAdaptedQuestion(row);
      if (validation.length) {
        totals.quarantined += 1;
        if (errors.length < 500) errors.push({ collection: pair.collectionKey, source_item_id: sourceItemId, errors: validation });
        return;
      }
      totals.valid_questions += 1; batch.push(row);
      if (batch.length >= Math.max(10, Number(batchSize || 100))) await flush();
    });
    await flush(); answersByQuestion.clear(); totals.collections += 1;
    await onCheckpoint({
      version: 1,
      pair_index: pairIndex + 1,
      collection_key: null,
      questions_processed_in_pair: 0,
      totals: { ...totals },
      errors: errors.slice(0, 500),
    }, {
      stage: "importing_questions",
      collection_index: pairIndex + 1,
      collection_count: pairs.length,
      totals: { ...totals },
    });
  }
  return { totals, errors };
}

export async function cleanupContentImportFiles(...pathsToRemove) {
  for (const target of pathsToRemove.filter(Boolean)) await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
}
