import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createRequire } from "node:module";
import Busboy from "busboy";
import {
  CONTENT_SOURCE_ADAPTERS,
  CONTENT_CDM_INTERACTION_FORMAT,
  adaptUniversalQuestion,
  mediaMatchKeys,
  pairQuestionAnswerFiles,
  slug,
  validateAdaptedCdmStep,
  validateAdaptedQuestion,
} from "./content-import-adapter.js";
import { aylaMedTaxonomyLedgerSummary } from "./aylamed-owned-question.js";
import { step1SourceTaxonomyLedgerSummary } from "./step1-source-taxonomy.js";
import { findDuplicateSignals } from "./content-registry-postgres.js";
import { openContentZip, openContentZipEntry } from "./content-zip-source.js";
import { createReferencedAssetMatcher } from "./content-media-matcher.js";

const require = createRequire(import.meta.url);
const { chain } = require("stream-chain");
const { parser } = require("stream-json");
const { streamArray } = require("stream-json/streamers/StreamArray");

const MAX_UPLOAD_BYTES = Math.max(1024 * 1024, Number(process.env.NEXTGEN_CONTENT_MAX_ZIP_BYTES || 5 * 1024 ** 3));
const MAX_UNCOMPRESSED_BYTES = Math.max(MAX_UPLOAD_BYTES, Number(process.env.NEXTGEN_CONTENT_MAX_UNCOMPRESSED_BYTES || 10 * 1024 ** 3));
const MAX_ZIP_ENTRIES = Math.max(100, Number(process.env.NEXTGEN_CONTENT_MAX_ZIP_ENTRIES || 100000));
const MAX_QUESTIONS_PER_JOB = Math.max(1_000, Number(process.env.NEXTGEN_CONTENT_MAX_QUESTIONS_PER_JOB || 1_000_000));
const MAX_ANSWER_CHOICES_PER_COLLECTION = Math.max(1_000, Number(process.env.NEXTGEN_CONTENT_MAX_ANSWER_CHOICES_PER_COLLECTION || 250_000));
const BLOCKING_VALIDATION_ERRORS = new Set([
  "missing_answers_file",
  "specialized_cdm_interaction_required",
  "source_exam_track_mismatch",
  "source_format_item_mismatch",
  "cdm_incompatible_destination",
]);
const CDM_DESTINATIONS = new Set(["aylamed_cdm", "aylamed_roadmap", "roadmap"]);
const IMAGE_MEDIA_EXTENSIONS = new Set([
  ".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp",
]);
const AUDIO_MEDIA_EXTENSIONS = new Set([
  ".aac", ".flac", ".m4a", ".mp3", ".oga", ".ogg", ".wav",
]);
const VIDEO_MEDIA_EXTENSIONS = new Set([
  ".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv",
]);

function mediaReferenceKind(value = "") {
  const clean = String(value || "").split(/[?#]/, 1)[0].toLowerCase();
  const extension = path.extname(clean);
  if (IMAGE_MEDIA_EXTENSIONS.has(extension)) return "image";
  if (AUDIO_MEDIA_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_MEDIA_EXTENSIONS.has(extension)) return "video";
  return "unknown";
}

function normalizedImportDestination(value = "") {
  const clean = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (clean === "cdm" || clean === "legacy_cdm") return "aylamed_cdm";
  return clean;
}

function normalizedSourceFormat(value = "") {
  const clean = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["cdm", "legacy_cdm", "cdm_write_in", "legacy_cdm_write_in"].includes(clean)) {
    return CONTENT_CDM_INTERACTION_FORMAT;
  }
  return clean;
}

export function validateContentImportRow(row, {
  sourceFormat = "",
  destinations = [],
} = {}) {
  const itemFormat = String(row?.sourceData?.item_format || "");
  const isCdm = itemFormat === "cdm_self_rating_case";
  const format = normalizedSourceFormat(sourceFormat);
  const destinationSet = new Set((Array.isArray(destinations) ? destinations : [])
    .map(normalizedImportDestination)
    .filter(Boolean));
  const dedicatedCdmImport = format === CONTENT_CDM_INTERACTION_FORMAT
    && destinationSet.has("aylamed_cdm");
  let errors;
  if (isCdm && dedicatedCdmImport) {
    errors = validateAdaptedCdmStep(row);
    if ([...destinationSet].some((destination) => !CDM_DESTINATIONS.has(destination))) {
      errors.push("cdm_incompatible_destination");
    }
  } else if (isCdm) {
    errors = validateAdaptedQuestion(row);
  } else {
    errors = validateAdaptedQuestion(row);
    if (format === CONTENT_CDM_INTERACTION_FORMAT) errors.push("source_format_item_mismatch");
    if (destinationSet.has("aylamed_cdm")) errors.push("source_format_item_mismatch");
  }
  return [...new Set(errors)];
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

export async function extractSafeZipInventory(zipFile, jobId, dataDir, {
  directoryCacheKey = "",
  onDirectoryCacheProgress,
} = {}) {
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
  const zip = await openContentZip(zipFile, {
    directoryCacheKey,
    onDirectoryCacheProgress,
  });
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
          const stream = await openContentZipEntry(zip, entry);
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

async function readJsonArray(file, onValue, onProgress) {
  const source = fs.createReadStream(file);
  const size = Number((await fsp.stat(file)).size || 0);
  const pipelineStream = chain([source, parser(), streamArray()]);
  let count = 0;
  for await (const { value } of pipelineStream) {
    count += 1;
    await onValue(value);
    if (onProgress && (count === 1 || count % 25 === 0)) {
      await onProgress({ count, bytesRead: Math.min(size, Number(source.bytesRead || 0)), size });
    }
  }
  if (onProgress) await onProgress({ count, bytesRead: size, size, completed: true });
  return count;
}

function mediaAliasesBySourceItem(mediaAliases = []) {
  const bySourceItem = new Map();
  for (const alias of Array.isArray(mediaAliases) ? mediaAliases : []) {
    const sourceItemId = String(alias?.source_item_id || alias?.sourceItemId || "").trim();
    if (!sourceItemId) continue;
    if (!bySourceItem.has(sourceItemId)) bySourceItem.set(sourceItemId, []);
    bySourceItem.get(sourceItemId).push(alias);
  }
  return bySourceItem;
}

function previewMediaReference(row, sourceItemId, mediaRef) {
  const storedPaths = row.sourceData?.media_match_paths || {};
  const placement = row.sourceData?.media_placements?.[mediaRef] || "explanation";
  return {
    questionId: sourceItemId,
    mediaRef,
    placement,
    matchPaths: Array.isArray(storedPaths[mediaRef])
      ? storedPaths[mediaRef]
      : storedPaths[mediaRef]
        ? [storedPaths[mediaRef]]
        : [],
  };
}

export async function previewUniversalQuestionZip({
  inventory,
  examTrack,
  sourceNamespace,
  sourceProvider,
  collectionTitle,
  sourceFormat = "",
  destinations = [],
  mediaAliases = [],
  duplicateLookup = findDuplicateSignals,
  onProgress = async () => {},
}) {
  const pairs = pairQuestionAnswerFiles(inventory.names);
  if (!pairs.length) {
    throw Object.assign(
      new Error("ZIP must contain at least one JSON array named *_questions.json"),
      { statusCode: 400, code: "CONTENT_QUESTION_FILE_REQUIRED" },
    );
  }
  const counts = {
    collections: pairs.length, question_files: pairs.length, answer_files: pairs.filter((pair) => pair.answerFile).length,
    questions_seen: 0, valid_questions: 0, quarantined: 0, answer_choices: 0,
    blocking_issues: 0, import_blocked: false,
    exact_duplicates_in_zip: 0, exact_duplicates_existing: 0, source_aliases_existing: 0,
    raw_media_references: 0, media_references: 0, media_matched: 0, media_missing: 0,
    media_ambiguous: 0,
    answer_media_references: 0, external_video_references: 0, external_video_questions: 0,
    image_media_references: 0, audio_media_references: 0, video_media_references: 0,
    packaged_image_references: 0, packaged_audio_references: 0, packaged_video_references: 0,
    media_aliases_declared: Array.isArray(mediaAliases) ? mediaAliases.length : 0,
    media_aliases_applied: 0, media_aliases_unapplied: 0,
    media_aliases_asset_missing: 0, media_aliases_ambiguous: 0,
    cdm_cases: 0, cdm_steps: 0, cdm_self_rating_controls_ignored: 0,
    aylamed_owned_questions: 0, step1_source_taxonomy_questions: 0,
    taxonomy_ledger_complete: 0, taxonomy_ledger_incomplete: 0,
    publication_gate_ready: 0, publication_gate_blocked: 0,
    zip_entries: inventory.entryCount, uncompressed_bytes: inventory.uncompressedBytes,
  };
  const errors = [];
  const seenHashes = new Set();
  const missingMedia = new Set();
  const mediaQuarantine = [];
  const aliasIndex = mediaAliasesBySourceItem(mediaAliases);
  const appliedAliasKeys = new Set();
  const mediaAssets = inventory.names
    .filter((name) => mediaReferenceKind(name) !== "unknown")
    .map((originalName) => ({ originalName }));
  const matchMedia = createReferencedAssetMatcher(mediaAssets);
  const sourceAdapterCounts = new Map();
  const itemFormatCounts = new Map();
  const blockingReasonCounts = new Map();
  const blockingCollections = new Set();
  const cdmCases = new Set();
  let hashBatch = [];
  let aliasBatch = [];
  const jsonPaths = [...new Set(pairs.flatMap((pair) => [
    inventory.extractedJson.get(pair.questionFile),
    pair.answerFile ? inventory.extractedJson.get(pair.answerFile) : null,
  ]).filter(Boolean))];
  const jsonSizes = new Map(await Promise.all(jsonPaths.map(async (file) => [
    file,
    Number((await fsp.stat(file)).size || 0),
  ])));
  const jsonBytesTotal = [...jsonSizes.values()].reduce((total, size) => total + size, 0);
  let completedJsonBytes = 0;

  async function readPreviewArray(file, stage, onValue) {
    const fileSize = Number(jsonSizes.get(file) || 0);
    await readJsonArray(file, onValue, async ({ bytesRead }) => {
      const bytesProcessed = Math.min(jsonBytesTotal, completedJsonBytes + Number(bytesRead || 0));
      await onProgress({
        stage,
        bytes_processed: bytesProcessed,
        bytes_total: jsonBytesTotal,
        questions_processed: counts.questions_seen,
        percent: jsonBytesTotal > 0
          ? Math.min(99, Math.round((bytesProcessed / jsonBytesTotal) * 100))
          : 0,
        movement: true,
      });
    });
    completedJsonBytes = Math.min(jsonBytesTotal, completedJsonBytes + fileSize);
  }

  async function flushDuplicateBatch() {
    if (!hashBatch.length && !aliasBatch.length) return;
    const found = await duplicateLookup(examTrack, hashBatch, aliasBatch);
    counts.exact_duplicates_existing += found.exact.length;
    counts.source_aliases_existing += found.source.length;
    hashBatch = [];
    aliasBatch = [];
  }

  for (const pair of pairs) {
    const questionPath = inventory.extractedJson.get(pair.questionFile);
    const answerPath = pair.answerFile ? inventory.extractedJson.get(pair.answerFile) : null;
    if (!questionPath || (pair.answerFile && !answerPath)) { errors.push({ collection: pair.collectionKey, error: "json_entry_not_extracted" }); continue; }
    const answersByQuestion = new Map();
    let answerChoicesInCollection = 0;
    if (answerPath) {
      await readPreviewArray(answerPath, "previewing_answers", async (answer) => {
        const key = String(answer.qId ?? answer.questionId ?? answer.question_id ?? answer.draft_id ?? "");
        if (!answersByQuestion.has(key)) answersByQuestion.set(key, []);
        answersByQuestion.get(key).push(answer);
        counts.answer_choices += 1;
        answerChoicesInCollection += 1;
        if (answerChoicesInCollection > MAX_ANSWER_CHOICES_PER_COLLECTION || counts.answer_choices > MAX_QUESTIONS_PER_JOB * 12) {
          throw Object.assign(new Error("A collection is too large for the bounded-memory preview; split it into smaller collections"), { statusCode: 413 });
        }
      });
    }
    let sourcePosition = 0;
    await readPreviewArray(questionPath, "previewing_questions", async (question) => {
      sourcePosition += 1;
      counts.questions_seen += 1;
      if (counts.questions_seen > MAX_QUESTIONS_PER_JOB) {
        throw Object.assign(new Error("Question ZIP exceeds the configured per-job question limit; split it into multiple imports"), { statusCode: 413 });
      }
      const sourceItemId = String(question.draft_id ?? question.question_id ?? question.id ?? question.qId ?? question.questionId ?? "");
      const row = adaptUniversalQuestion(question, answersByQuestion.get(sourceItemId) || [], {
        examTrack, sourceNamespace, sourceProvider, collectionKey: pair.collectionKey,
        collectionTitle: `${collectionTitle}: ${pair.collectionKey}`,
        sourceFile: pair.questionFile, sourceRank: pair.sourceRank,
        sourcePosition,
        mediaAliases: aliasIndex.get(sourceItemId) || [],
      });
      const sourceAdapter = String(row.sourceData?.source_adapter || "unknown");
      const itemFormat = String(row.sourceData?.item_format || "unknown");
      sourceAdapterCounts.set(sourceAdapter, (sourceAdapterCounts.get(sourceAdapter) || 0) + 1);
      itemFormatCounts.set(itemFormat, (itemFormatCounts.get(itemFormat) || 0) + 1);
      const isAylaOwned = row.sourceData?.source_adapter === CONTENT_SOURCE_ADAPTERS.aylaMedOwnedSba;
      const isStep1SourceTaxonomy = row.sourceData?.source_adapter
        === CONTENT_SOURCE_ADAPTERS.step1SourceTaxonomySba;
      const validation = validateContentImportRow(row, { sourceFormat, destinations });
      if (!pair.answerFile && !isAylaOwned) validation.push("missing_answers_file");
      if (validation.length) {
        counts.quarantined += 1;
        if (isAylaOwned || isStep1SourceTaxonomy) counts.taxonomy_ledger_incomplete += 1;
        const blockingReasons = validation.filter((reason) => (
          isAylaOwned || isStep1SourceTaxonomy || BLOCKING_VALIDATION_ERRORS.has(reason)
        ));
        if (blockingReasons.length) {
          counts.blocking_issues += 1;
          blockingCollections.add(pair.collectionKey);
          for (const reason of blockingReasons) {
            blockingReasonCounts.set(reason, (blockingReasonCounts.get(reason) || 0) + 1);
          }
        }
        if (errors.length < 500) errors.push({ collection: pair.collectionKey, source_item_id: sourceItemId, errors: validation });
        return;
      }
      counts.valid_questions += 1;
      if (isAylaOwned) {
        counts.aylamed_owned_questions += 1;
        counts.taxonomy_ledger_complete += 1;
        if (row.sourceData?.publication_gate_ready === true) counts.publication_gate_ready += 1;
        else counts.publication_gate_blocked += 1;
        counts.answer_choices += row.answers.length;
      }
      if (isStep1SourceTaxonomy) {
        counts.step1_source_taxonomy_questions += 1;
        counts.taxonomy_ledger_complete += 1;
      }
      if (itemFormat === "cdm_self_rating_case") {
        counts.cdm_steps += 1;
        counts.cdm_self_rating_controls_ignored += Number(
          row.sourceData?.source_self_rating_controls_ignored || 0,
        );
        if (row.sourceData?.case_source_id) {
          cdmCases.add(`${pair.collectionKey}\u0000${row.sourceData.case_source_id}`);
        }
      }
      counts.raw_media_references += row.media.length;
      counts.answer_media_references += row.answers.reduce(
        (total, answer) => total + (Array.isArray(answer.mediaRefs) ? answer.mediaRefs.length : 0),
        0,
      );
      const externalVideos = Array.isArray(row.sourceData?.external_video_references)
        ? row.sourceData.external_video_references
        : [];
      counts.external_video_references += externalVideos.length;
      if (externalVideos.length) counts.external_video_questions += 1;
      if (seenHashes.has(row.contentHash)) counts.exact_duplicates_in_zip += 1;
      else {
        seenHashes.add(row.contentHash);
        const references = row.media.map((name) =>
          previewMediaReference(row, sourceItemId, name));
        const mediaReport = matchMedia(references);
        const matchedByRef = new Map(mediaReport.matches.map((item) => [item.mediaRef, item]));
        const missingByRef = new Map(mediaReport.missing.map((item) => [item.mediaRef, item]));
        const ambiguousByRef = new Map(mediaReport.ambiguous.map((item) => [item.mediaRef, item]));
        for (const alias of row.sourceData?.media_aliases_applied || []) {
          if (alias.alias_key) appliedAliasKeys.add(String(alias.alias_key));
        }
        row.media.forEach((name) => {
          counts.media_references += 1;
          const kind = mediaReferenceKind(name);
          if (kind === "image") counts.image_media_references += 1;
          if (kind === "audio") counts.audio_media_references += 1;
          if (kind === "video") counts.video_media_references += 1;
          const matched = matchedByRef.has(name);
          const ambiguous = ambiguousByRef.get(name);
          const appliedAlias = (row.sourceData?.media_aliases_applied || [])
            .find((alias) => alias.media_ref === name);
          if (matched) {
            counts.media_matched += 1;
            if (kind === "image") counts.packaged_image_references += 1;
            if (kind === "audio") counts.packaged_audio_references += 1;
            if (kind === "video") counts.packaged_video_references += 1;
          } else if (ambiguous) {
            counts.media_ambiguous += 1;
            if (appliedAlias) counts.media_aliases_ambiguous += 1;
            if (mediaQuarantine.length < 500) {
              mediaQuarantine.push({
                source_item_id: sourceItemId,
                placement: ambiguous.placement || "explanation",
                media_ref: name,
                reason: appliedAlias
                  ? "accepted_alias_ambiguous"
                  : "ambiguous_packaged_assets",
                candidates: (ambiguous.candidates || []).slice(0, 20),
              });
            }
          } else if (missingByRef.has(name)) {
            counts.media_missing += 1;
            if (appliedAlias) counts.media_aliases_asset_missing += 1;
            if (missingMedia.size < 500) missingMedia.add(name);
            if (mediaQuarantine.length < 500) {
              mediaQuarantine.push({
                source_item_id: sourceItemId,
                placement: missingByRef.get(name)?.placement || "explanation",
                media_ref: name,
                reason: appliedAlias
                  ? "accepted_alias_asset_missing"
                  : "packaged_asset_missing",
                accepted_asset_path: appliedAlias?.asset_path || "",
                candidates: [],
              });
            }
          }
        });
      }
      hashBatch.push(row.contentHash);
      aliasBatch.push({ sourceNamespace: slug(sourceNamespace), collectionKey: row.collectionKey, sourceItemId });
      if (hashBatch.length >= 1000) await flushDuplicateBatch();
    });
    answersByQuestion.clear();
  }
  await flushDuplicateBatch();
  counts.unique_questions_in_zip = seenHashes.size;
  counts.cdm_cases = cdmCases.size;
  counts.media_aliases_applied = appliedAliasKeys.size;
  const declaredAliasKeys = new Set((Array.isArray(mediaAliases) ? mediaAliases : [])
    .map((alias) => String(alias?.alias_key || alias?.aliasKey || ""))
    .filter(Boolean));
  const unappliedAliases = (Array.isArray(mediaAliases) ? mediaAliases : [])
    .filter((alias) => !appliedAliasKeys.has(String(alias?.alias_key || alias?.aliasKey || "")));
  counts.media_aliases_unapplied = Math.max(
    0,
    declaredAliasKeys.size - appliedAliasKeys.size,
  );
  for (const alias of unappliedAliases.slice(0, Math.max(0, 500 - errors.length))) {
    errors.push({
      source_item_id: alias.source_item_id,
      media_ref: alias.media_ref,
      warning: "reviewed_media_alias_did_not_match_question_reference",
    });
  }
  counts.import_blocked = counts.blocking_issues > 0;
  counts.blocking_collections = [...blockingCollections];
  counts.blocking_reasons = Object.fromEntries(blockingReasonCounts);
  counts.source_adapters = Object.fromEntries(sourceAdapterCounts);
  counts.item_formats = Object.fromEntries(itemFormatCounts);
  counts.taxonomy_coverage_percent = counts.taxonomy_ledger_complete || counts.taxonomy_ledger_incomplete
    ? Number(((counts.taxonomy_ledger_complete / Math.max(1, counts.taxonomy_ledger_complete + counts.taxonomy_ledger_incomplete)) * 100).toFixed(2))
    : 0;
  await onProgress({
    stage: "preview_complete",
    bytes_processed: jsonBytesTotal,
    bytes_total: jsonBytesTotal,
    questions_processed: counts.questions_seen,
    questions_total: counts.questions_seen,
    percent: 100,
    completed: true,
    movement: true,
  });
  return {
    counts,
    errors,
    missingMedia: [...missingMedia],
    mediaQuarantine,
    collections: pairs.map((pair) => ({
      key: pair.collectionKey,
      question_file: pair.questionFile,
      answer_file: pair.answerFile,
    })),
    taxonomyLedger: {
      ...aylaMedTaxonomyLedgerSummary(),
      step1_source: step1SourceTaxonomyLedgerSummary(),
    },
  };
}

export async function importUniversalQuestionZip({ inventory, job, onBatch, batchSize = 100, checkpoint = {}, onCheckpoint = async () => {} }) {
  const pairs = pairQuestionAnswerFiles(inventory.names);
  if (!pairs.length) {
    throw Object.assign(
      new Error("ZIP must contain at least one JSON array named *_questions.json"),
      { statusCode: 400, code: "CONTENT_QUESTION_FILE_REQUIRED" },
    );
  }
  const aliasIndex = mediaAliasesBySourceItem(job?.media_aliases || job?.mediaAliases || []);
  const emptyTotals = { collections: 0, questions_seen: 0, valid_questions: 0, quarantined: 0, created: 0, reused: 0, aliases_created: 0, source_duplicates: 0, answers: 0 };
  const totals = { ...emptyTotals, ...(checkpoint?.totals && typeof checkpoint.totals === "object" ? checkpoint.totals : {}) };
  const errors = Array.isArray(checkpoint?.errors) ? checkpoint.errors.slice(0, 500) : [];
  const questionsTotal = Math.max(0, Number(job?.counts?.questions_seen || 0));
  const importProgress = (stage, extra = {}) => ({
    stage,
    questions_processed: totals.questions_seen,
    questions_total: questionsTotal,
    percent: questionsTotal > 0
      ? Math.min(99, Math.round((totals.questions_seen / questionsTotal) * 100))
      : 0,
    ...extra,
  });
  const resumePairIndex = Math.max(0, Number(checkpoint?.pair_index || 0));
  const resumeQuestionOffset = Math.max(0, Number(checkpoint?.questions_processed_in_pair || 0));
  for (let pairIndex = 0; pairIndex < pairs.length; pairIndex += 1) {
    if (pairIndex < resumePairIndex) continue;
    const pair = pairs[pairIndex];
    const questionPath = inventory.extractedJson.get(pair.questionFile);
    const answerPath = pair.answerFile ? inventory.extractedJson.get(pair.answerFile) : null;
    if (!questionPath || (pair.answerFile && !answerPath)) {
      errors.push({ collection: pair.collectionKey, error: "json_entry_not_extracted" });
      await onCheckpoint({ version: 1, pair_index: pairIndex + 1, collection_key: null, questions_processed_in_pair: 0,
        totals: { ...totals }, errors: errors.slice(0, 500) }, importProgress("skipping_invalid_collection", {
        collection_index: pairIndex + 1, collection_count: pairs.length,
        collection_key: pair.collectionKey, totals: { ...totals }, movement: true,
      }));
      continue;
    }
    const answersByQuestion = new Map();
    let answerChoicesInCollection = 0;
    if (answerPath) {
      await readJsonArray(answerPath, async (answer) => {
        const key = String(answer.qId ?? answer.questionId ?? answer.question_id ?? answer.draft_id ?? "");
        if (!answersByQuestion.has(key)) answersByQuestion.set(key, []);
        answersByQuestion.get(key).push(answer);
        answerChoicesInCollection += 1;
        if (answerChoicesInCollection > MAX_ANSWER_CHOICES_PER_COLLECTION) {
          throw Object.assign(new Error("A collection is too large for bounded-memory import; split it into smaller collections"), { statusCode: 413 });
        }
      });
    }
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
      }, importProgress("importing_questions", {
        collection_index: pairIndex + 1,
        collection_count: pairs.length,
        collection_key: pair.collectionKey,
        questions_processed_in_pair: questionsProcessedInPair,
        totals: { ...totals },
        movement: true,
      }));
    };
    await readJsonArray(questionPath, async (question) => {
      questionsProcessedInPair += 1;
      if (pairIndex === resumePairIndex && questionsProcessedInPair <= resumeQuestionOffset) return;
      totals.questions_seen += 1;
      if (totals.questions_seen > MAX_QUESTIONS_PER_JOB) {
        throw Object.assign(new Error("Question ZIP exceeds the configured per-job question limit; split it into multiple imports"), { statusCode: 413 });
      }
      const sourceItemId = String(question.draft_id ?? question.question_id ?? question.id ?? question.qId ?? question.questionId ?? "");
      const row = adaptUniversalQuestion(question, answersByQuestion.get(sourceItemId) || [], {
        examTrack: job.exam_track, sourceNamespace: job.source_namespace, sourceProvider: job.source_provider,
        collectionKey: pair.collectionKey, collectionTitle: job.collection_title,
        sourceFile: pair.questionFile, sourceRank: pair.sourceRank,
        sourcePosition: questionsProcessedInPair,
        mediaAliases: aliasIndex.get(sourceItemId) || [],
      });
      const validation = validateContentImportRow(row, {
        sourceFormat: job.source_format || job.sourceFormat,
        destinations: Array.isArray(job.destinations) ? job.destinations : [],
      });
      if (!pair.answerFile && row.sourceData?.source_adapter !== CONTENT_SOURCE_ADAPTERS.aylaMedOwnedSba) {
        validation.push("missing_answers_file");
      }
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
    }, importProgress("importing_questions", {
      collection_index: pairIndex + 1,
      collection_count: pairs.length,
      totals: { ...totals },
      movement: true,
    }));
  }
  return { totals, errors };
}

export async function cleanupContentImportFiles(...pathsToRemove) {
  for (const target of pathsToRemove.filter(Boolean)) await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
}
