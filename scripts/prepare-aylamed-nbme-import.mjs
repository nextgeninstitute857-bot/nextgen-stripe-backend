#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  normalizeAylaNbmeManifest,
  parseAylaNbmeCollectionKey,
} from "../lib/aylamed-nbme-center.js";
import { extractMediaReferences } from "../lib/content-import-adapter.js";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

function text(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/\s+/g, " ").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filename, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function safeFilename(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) return null;
  return normalized;
}

function decodedReference(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function mediaLookupKeys(value) {
  const clean = decodedReference(value)
    .split(/[?#]/, 1)[0]
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .toLowerCase();
  if (!clean) return [];
  return [...new Set([
    clean,
    path.posix.basename(clean),
    clean.replace(/\//g, "_"),
  ])];
}

async function listFiles(directory, prefix = "") {
  const rows = [];
  for (const entry of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) rows.push(...await listFiles(directory, relative));
    else rows.push(relative);
  }
  return rows;
}

async function buildMediaInventory(sourceDirectory) {
  const files = (await listFiles(sourceDirectory))
    .filter((filename) => !/\.json$/i.test(filename))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  const lookup = new Map();
  const assets = [];
  for (const relativePath of files) {
    const absolutePath = path.join(sourceDirectory, ...relativePath.split("/"));
    const buffer = await fs.readFile(absolutePath);
    const declaredExtension = path.extname(relativePath).toLowerCase();
    const detectedExtension = imageExtension(buffer, declaredExtension);
    const asset = {
      relativePath,
      absolutePath,
      buffer,
      declaredExtension,
      detectedExtension,
    };
    assets.push(asset);
    for (const key of mediaLookupKeys(relativePath)) {
      if (!lookup.has(key)) lookup.set(key, new Set());
      lookup.get(key).add(asset);
    }
  }
  return { assets, lookup };
}

function resolveMediaReference(reference, inventory) {
  const matches = new Set();
  for (const key of mediaLookupKeys(reference)) {
    for (const asset of inventory.lookup.get(key) || []) matches.add(asset);
  }
  if (matches.size !== 1) {
    return {
      asset: null,
      ambiguous: matches.size > 1,
    };
  }
  return { asset: [...matches][0], ambiguous: false };
}

function imageExtension(buffer, fallback = "") {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ".png";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return ".gif";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  return fallback.toLowerCase();
}

function replaceMediaReference(question, original, replacement) {
  if (original === replacement) return question;
  const fields = ["question", "explanation", "otherMedias", "mediaName"];
  const next = { ...question };
  for (const field of fields) {
    if (typeof next[field] === "string") next[field] = next[field].split(original).join(replacement);
  }
  return next;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function findFormFiles(formDirectory) {
  const names = await fs.readdir(formDirectory);
  const questionFile = names.find((name) => /\.db_questions\.json$/i.test(name));
  const answerFile = names.find((name) => /\.db_answers\.json$/i.test(name));
  if (!questionFile || !answerFile) throw new Error(`Missing question/answer JSON pair in ${formDirectory}`);
  return {
    questionFile: path.join(formDirectory, questionFile),
    answerFile: path.join(formDirectory, answerFile),
  };
}

async function prepareForm({ sourceDirectory, packageDirectory, collectionKey }) {
  const definition = parseAylaNbmeCollectionKey(collectionKey);
  if (!definition) throw new Error(`Unsupported source form: ${collectionKey}`);
  const canonicalCollectionKey = definition.collectionKey;
  const { questionFile, answerFile } = await findFormFiles(sourceDirectory);
  const [questionBytes, answerBytes] = await Promise.all([
    fs.readFile(questionFile),
    fs.readFile(answerFile),
  ]);
  const sourceQuestions = JSON.parse(questionBytes.toString("utf8"));
  const sourceAnswers = JSON.parse(answerBytes.toString("utf8"));
  if (!Array.isArray(sourceQuestions) || !Array.isArray(sourceAnswers)) {
    throw new Error(`${collectionKey} must contain JSON arrays`);
  }
  const questionIds = new Set(sourceQuestions.map((row) => String(row?.id ?? row?.qId ?? row?.questionId ?? "")).filter(Boolean));
  const answersByQuestion = new Map();
  for (const answer of sourceAnswers) {
    const questionId = String(answer?.qId ?? answer?.questionId ?? "");
    if (!answersByQuestion.has(questionId)) answersByQuestion.set(questionId, []);
    answersByQuestion.get(questionId).push(answer);
  }
  const orphanAnswerQuestionIds = [...answersByQuestion.keys()].filter((id) => !questionIds.has(id));
  let missingExplanations = 0;
  let invalidAnswerKeys = 0;
  let missingQuestionStems = 0;
  const importableQuestions = [];
  const validIds = new Set();
  const registryReadyIds = new Set();
  for (const [index, question] of sourceQuestions.entries()) {
    const sourceItemId = String(question?.id ?? question?.qId ?? question?.questionId ?? "");
    const answers = answersByQuestion.get(sourceItemId) || [];
    const correctAnswerId = Number(question?.corrAns ?? question?.correctAnswerId ?? question?.correct_answer_id);
    const explanationReady = Boolean(text(question?.explanation));
    const questionReady = Boolean(text(question?.question || question?.stem));
    const answerKeyReady = answers.length >= 2 && answers.some((answer) =>
      Number(answer?.answerId ?? answer?.id) === correctAnswerId);
    if (!explanationReady) missingExplanations += 1;
    if (!questionReady) missingQuestionStems += 1;
    if (!answerKeyReady) invalidAnswerKeys += 1;
    // Preserve source-authentic questions as private drafts even when an
    // explanation is absent. The form-level quality gate prevents student
    // enablement until the source is complete; nothing is fabricated here.
    if (!sourceItemId || !questionReady || !answerKeyReady) continue;
    importableQuestions.push({ ...question, sourcePosition: index + 1 });
    validIds.add(sourceItemId);
    if (explanationReady) registryReadyIds.add(sourceItemId);
  }
  const validAnswers = sourceAnswers.filter((answer) => validIds.has(String(answer?.qId ?? answer?.questionId ?? "")));
  const registryReadyAnswers = sourceAnswers.filter((answer) =>
    registryReadyIds.has(String(answer?.qId ?? answer?.questionId ?? "")));
  const inventory = await buildMediaInventory(sourceDirectory);
  const allReferences = new Set(sourceQuestions.flatMap((question) =>
    extractMediaReferences(question.question, question.explanation, question.otherMedias, question.mediaName)));
  const importableReferences = new Set(importableQuestions.flatMap((question) =>
    extractMediaReferences(question.question, question.explanation, question.otherMedias, question.mediaName)));
  const outputFormDirectory = path.join(packageDirectory, "forms", canonicalCollectionKey);
  await fs.mkdir(outputFormDirectory, { recursive: true });
  const allResolvedAssets = new Set();
  const importedAssets = new Set();
  const unresolvedReferences = new Set();
  const ambiguousReferences = new Set();
  let corruptMedia = 0;
  let renamedMimeMismatches = 0;
  const renamedMedia = new Map();
  for (const reference of allReferences) {
    const resolved = resolveMediaReference(reference, inventory);
    if (resolved.ambiguous) ambiguousReferences.add(reference);
    else if (!resolved.asset) unresolvedReferences.add(reference);
    else allResolvedAssets.add(resolved.asset);
  }
  for (const reference of [...importableReferences].sort()) {
    const safe = safeFilename(reference);
    if (!safe) {
      unresolvedReferences.add(reference);
      continue;
    }
    const resolved = resolveMediaReference(reference, inventory);
    if (resolved.ambiguous) {
      ambiguousReferences.add(reference);
      continue;
    }
    if (!resolved.asset) {
      unresolvedReferences.add(reference);
      continue;
    }
    const {
      relativePath,
      buffer,
      declaredExtension,
      detectedExtension,
    } = resolved.asset;
    if (![".png", ".gif", ".jpg", ".jpeg"].includes(detectedExtension)) {
      corruptMedia += 1;
      continue;
    }
    const targetReference = detectedExtension === declaredExtension
      || (declaredExtension === ".jpeg" && detectedExtension === ".jpg")
      ? relativePath
      : `${relativePath.slice(0, -declaredExtension.length)}${detectedExtension}`;
    renamedMedia.set(reference, targetReference);
    if (importedAssets.has(resolved.asset)) continue;
    importedAssets.add(resolved.asset);
    if (targetReference !== relativePath) renamedMimeMismatches += 1;
    const target = path.resolve(outputFormDirectory, targetReference);
    const outputRoot = `${path.resolve(outputFormDirectory)}${path.sep}`;
    if (!target.startsWith(outputRoot)) throw new Error(`Unsafe output media path: ${targetReference}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer, { flag: "wx" });
  }
  const rewrittenQuestions = importableQuestions.map((question) => {
    let next = question;
    for (const [original, replacement] of renamedMedia) next = replaceMediaReference(next, original, replacement);
    return next;
  });
  const questionOutput = path.join(outputFormDirectory, `${canonicalCollectionKey}_questions.json`);
  const answerOutput = path.join(outputFormDirectory, `${canonicalCollectionKey}_answers.json`);
  await fs.writeFile(questionOutput, `${JSON.stringify(rewrittenQuestions)}\n`, { flag: "wx" });
  await fs.writeFile(answerOutput, `${JSON.stringify(validAnswers)}\n`, { flag: "wx" });
  return {
    collection_key: canonicalCollectionKey,
    exam_track: definition.examTrack,
    form_type: definition.formType,
    family: definition.family,
    form_number: definition.formNumber,
    specialty_key: definition.specialtyKey,
    expected_question_count: definition.expectedQuestionCount,
    source_question_count: sourceQuestions.length,
    packaged_question_count: rewrittenQuestions.length,
    imported_question_count: registryReadyIds.size,
    answer_choice_count: sourceAnswers.length,
    packaged_answer_choice_count: validAnswers.length,
    imported_answer_choice_count: registryReadyAnswers.length,
    media_count: inventory.assets.length,
    referenced_media_count: allResolvedAssets.size,
    imported_media_count: importedAssets.size,
    unreferenced_media: Math.max(0, inventory.assets.length - allResolvedAssets.size),
    missing_explanations: missingExplanations,
    missing_question_stems: missingQuestionStems,
    orphan_answers: orphanAnswerQuestionIds.length,
    invalid_answer_keys: invalidAnswerKeys,
    missing_media: unresolvedReferences.size,
    ambiguous_media: ambiguousReferences.size,
    corrupt_media: corruptMedia,
    renamed_mime_mismatches: renamedMimeMismatches,
    source_sha256: sha256(Buffer.concat([questionBytes, Buffer.from("\u0000"), answerBytes])),
  };
}

function summarizeForms(forms) {
  return {
    forms: forms.length,
    source_questions: forms.reduce((sum, row) => sum + row.source_question_count, 0),
    packaged_questions: forms.reduce((sum, row) => sum + row.packaged_question_count, 0),
    imported_questions: forms.reduce((sum, row) => sum + row.imported_question_count, 0),
    answer_choices: forms.reduce((sum, row) => sum + row.answer_choice_count, 0),
    packaged_answer_choices: forms.reduce((sum, row) => sum + row.packaged_answer_choice_count, 0),
    imported_answer_choices: forms.reduce((sum, row) => sum + row.imported_answer_choice_count, 0),
    media: forms.reduce((sum, row) => sum + row.media_count, 0),
    imported_media: forms.reduce((sum, row) => sum + row.imported_media_count, 0),
    unreferenced_media: forms.reduce((sum, row) => sum + row.unreferenced_media, 0),
    missing_explanations: forms.reduce((sum, row) => sum + row.missing_explanations, 0),
    orphan_answers: forms.reduce((sum, row) => sum + row.orphan_answers, 0),
    invalid_answer_keys: forms.reduce((sum, row) => sum + row.invalid_answer_keys, 0),
    missing_media: forms.reduce((sum, row) => sum + row.missing_media, 0),
    ambiguous_media: forms.reduce((sum, row) => sum + row.ambiguous_media, 0),
    corrupt_media: forms.reduce((sum, row) => sum + row.corrupt_media, 0),
    renamed_mime_mismatches: forms.reduce((sum, row) => sum + row.renamed_mime_mismatches, 0),
  };
}

async function main() {
  const source = path.resolve(argument("--source"));
  const output = path.resolve(argument("--output"));
  if (!argument("--source") || !argument("--output")) {
    throw new Error("Usage: prepare-aylamed-nbme-import.mjs --source <extracted-directory> --output <new-output-directory> [--archive-sha256 <sha256>]");
  }
  const archiveSha256 = argument("--archive-sha256").trim().toLowerCase();
  if (archiveSha256 && !/^[0-9a-f]{64}$/.test(archiveSha256)) throw new Error("--archive-sha256 must contain 64 hexadecimal characters");
  const sourceStat = await fs.stat(source);
  if (!sourceStat.isDirectory()) throw new Error("--source must be an extracted archive directory");
  await fs.mkdir(output, { recursive: false });
  const sourceEntries = await fs.readdir(source, { withFileTypes: true });
  const formDirectories = sourceEntries
    .filter((entry) => entry.isDirectory() && parseAylaNbmeCollectionKey(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  if (!formDirectories.length) throw new Error("No recognized self-assessment form directories were found");
  const packageNames = {
    "usmle-step-1": "aylamed-nbme-step-1",
    "usmle-step-2": "aylamed-nbme-step-2-ck",
    "usmle-step-3": "aylamed-nbme-step-3",
  };
  const packageDirectories = {};
  for (const name of Object.values(packageNames)) {
    packageDirectories[name] = path.join(output, name);
    await fs.mkdir(packageDirectories[name], { recursive: false });
  }
  const forms = [];
  for (const collectionKey of formDirectories) {
    const definition = parseAylaNbmeCollectionKey(collectionKey);
    const packageName = packageNames[definition.examTrack];
    forms.push(await prepareForm({
      sourceDirectory: path.join(source, collectionKey),
      packageDirectory: packageDirectories[packageName],
      collectionKey,
    }));
  }
  const manifest = normalizeAylaNbmeManifest({
    version: 1,
    archive_sha256: archiveSha256 || null,
    forms,
  });
  const publicManifest = {
    version: manifest.version,
    archive_sha256: manifest.archiveSha256,
    generated_at: new Date().toISOString(),
    totals: summarizeForms(forms),
    forms,
  };
  await fs.writeFile(path.join(output, "aylamed-nbme-manifest.json"), `${JSON.stringify(publicManifest, null, 2)}\n`, { flag: "wx" });
  for (const [examTrack, packageName] of Object.entries(packageNames)) {
    const packageForms = forms.filter((row) => row.exam_track === examTrack);
    const packageManifest = {
      ...publicManifest,
      exam_track: examTrack,
      totals: summarizeForms(packageForms),
      forms: packageForms,
    };
    await fs.writeFile(
      path.join(packageDirectories[packageName], "aylamed-nbme-manifest.json"),
      `${JSON.stringify(packageManifest, null, 2)}\n`,
      { flag: "wx" },
    );
    const zipPath = path.join(output, `${packageName}.zip`);
    // Keep zip's transient working file outside the deliverable directory so
    // an interrupted package build cannot leave a partial archive beside the
    // reviewed outputs.
    await run("zip", ["-q", "-r", "-b", "/tmp", zipPath, "."], { cwd: packageDirectories[packageName] });
    packageManifest.package_sha256 = await sha256File(zipPath);
    packageManifest.package_bytes = (await fs.stat(zipPath)).size;
    await fs.writeFile(
      path.join(output, `${packageName}.upload.json`),
      `${JSON.stringify({
        filename: path.basename(zipPath),
        purpose: "mixed_qbank_zip",
        sha256: packageManifest.package_sha256,
        total_bytes: packageManifest.package_bytes,
        metadata: {
          exam_track: examTrack,
          source_namespace: packageName,
          source_provider: "NBME source archive",
          source_profile: "other",
          source_rights_status: "unverified",
          source_format: "single_best_answer_v1",
          collection_title: packageName.replace(/^aylamed-/, "").replace(/-/g, " "),
          destinations: ["aylamed_nbme"],
        },
      }, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  process.stdout.write(`${JSON.stringify({
    output,
    manifest: path.join(output, "aylamed-nbme-manifest.json"),
    totals: publicManifest.totals,
    packages: Object.values(packageNames).map((name) => `${name}.zip`),
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
