import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  AYLA_DIAGNOSTIC_BLUEPRINT_VERSION,
  applyDiagnosticSystemOverride,
  auditDiagnosticQuestionMedia,
  buildStep1DiagnosticSelection,
  classifyStep1DiagnosticQuestion,
  diagnosticQuestionMatchProfile,
  diagnosticSessionUsesCurrentBlueprint,
} from "../lib/aylamed-diagnostic.js";

const TITLES = [
  "Osteoarthritis",
  "Postpartum Endometritis",
  "Inflammatory Bowel Disease",
  "Ischemic Stroke",
  "Prostate Cancer",
  "Digeorge Syndrome",
  "Hypothyroidism",
  "Hoarseness",
  "Callosities And Corns",
  "Sinusitis",
  "Intraventricular Hemorrhage",
  "Cytokines",
  "Beta Oxidation",
  "Interstitial Lung Disease",
  "Diabetic Kidney Disease",
  "Diabetic Foot",
  "Diabetes Mellitus",
  "Peptic Ulcer Disease",
  "Escherichia Coli",
  "GFR",
  "Pituitary Tumors",
  "Mosaicism",
  "Lesch Nyhan Syndrome",
  "Endometriosis",
  "Pagets Disease Of Bone",
  "Septic Arthritis",
  "FSGS",
  "Bacterial Gene Transfer",
  "Cardiac Physiology",
  "Embryologic Derivatives",
  "Physician Patient Communication",
  "Peptic Ulcer Disease",
  "G6PD Deficiency",
  "Asthma",
  "Genomic Imprinting",
  "Genetic Disorders",
  "Uterine Fibroids",
  "Laboratory Techniques",
  "Tetracycline",
  "Hearing Loss",
];

const IMAGE_REFS = new Map([
  [1, ["U23056.png"]],
  [4, ["highresdefault_U89821.png"]],
  [6, ["highresdefault_U64133.png"]],
  [7, ["highresdefault_U63979.png"]],
  [9, ["highresdefault_L24048.png"]],
  [10, ["highresdefault_U73734.png"]],
  [15, ["U51314.jpg"]],
  [17, ["L18322.jpg"]],
  [18, ["U41548.png"]],
  [20, ["GFR_A.gif", "GFR_B.gif", "GFR_C.gif", "GFR_D.gif", "GFR_E.gif"]],
  [21, [
    "highresdefault_U36559.jpg",
    "highresdefault_U36558.jpg",
    "highresdefault_U36563.jpg",
    "highresdefault_U36560.jpg",
    "highresdefault_U36562.jpg",
  ]],
  [24, ["U26233.png"]],
  [26, ["U22059.png"]],
]);

function fixture(index, { linked = true } = {}) {
  const questionNumber = index + 1;
  const refs = IMAGE_REFS.get(questionNumber) || [];
  return {
    id: `question-${questionNumber}`,
    title: TITLES[index],
    system_key: "1",
    taxonomy: { system_key: "1", topic_key: TITLES[index] },
    question_html: `<p>Clinical stem</p>${refs.map((ref) => `<img src="${ref}">`).join("")}`,
    explanation_html: "<p>Verified explanation</p>",
    answers: [{ answer_id: 1, text_html: "Choice A" }],
    media: linked
      ? refs.map((ref) => ({
          id: `media-${ref}`,
          ref,
          placement: "question",
          object_key: `private/step-1/${ref}`,
        }))
      : [],
  };
}

function imageReplacementFixture(index, overrides = {}) {
  const original = fixture(index, { linked: false });
  const system = classifyStep1DiagnosticQuestion(original);
  const ref = `replacement-${index + 1}.png`;
  return {
    ...original,
    id: `replacement-question-${index + 1}`,
    title: `${TITLES[index]} image variant`,
    exam_track: "usmle_step_1",
    system_key: system,
    subsystem_key: overrides.subsystem_key || "",
    topic_key: overrides.topic_key || TITLES[index],
    taxonomy: {
      system_key: system,
      subsystem_key: overrides.subsystem_key || "",
      topic_key: overrides.topic_key || TITLES[index],
      difficulty: overrides.difficulty || "medium",
    },
    question_html: `<p>Comparable approved clinical stem</p><img src="${ref}">`,
    media: [{
      id: `replacement-media-${index + 1}`,
      ref,
      kind: "image",
      content_type: "image/png",
      object_key: `private/step-1/${ref}`,
    }],
  };
}

function rotatingFixture(index) {
  const baseIndex = index % TITLES.length;
  const variant = Math.floor(index / TITLES.length);
  const question = fixture(baseIndex);
  const system = classifyStep1DiagnosticQuestion(question);
  return {
    ...question,
    id: `rotation-question-${index + 1}`,
    exam_track: "usmle_step_1",
    system_key: system,
    subsystem_key: `${system} subsystem ${variant % 5}`,
    topic_key: `${TITLES[baseIndex]} topic ${variant % 8}`,
    subtopic_key: `${TITLES[baseIndex]} subtopic ${variant}`,
    taxonomy: {
      system_key: system,
      subsystem_key: `${system} subsystem ${variant % 5}`,
      topic_key: `${TITLES[baseIndex]} topic ${variant % 8}`,
      subtopic_key: `${TITLES[baseIndex]} subtopic ${variant}`,
      difficulty: ["easy", "medium", "hard"][variant % 3],
    },
  };
}

test("numeric source taxonomy is replaced by deterministic Step 1 topic classification", () => {
  assert.equal(classifyStep1DiagnosticQuestion(fixture(0)), "Musculoskeletal");
  assert.equal(classifyStep1DiagnosticQuestion(fixture(14)), "Renal");
  assert.equal(classifyStep1DiagnosticQuestion(fixture(18)), "Microbiology");
  assert.equal(classifyStep1DiagnosticQuestion(fixture(30)), "Biostatistics and Ethics");
  assert.equal(classifyStep1DiagnosticQuestion(fixture(38)), "Pharmacology");
});

test("reviewed compound source systems resolve through their verified subsystem and discipline labels", () => {
  const imported = (title, systemKey, subsystem, discipline = "") => ({
    id: title,
    title,
    system_key: systemKey,
    taxonomy: {
      system_key: systemKey,
      discipline,
      labels: { system: systemKey, subsystem, subtopic: title },
    },
  });

  assert.equal(classifyStep1DiagnosticQuestion(imported(
    "Migraine",
    "behavioral-nervous-special-senses",
    "Nervous System",
    "Pathophysiology",
  )), "Neurology");
  assert.equal(classifyStep1DiagnosticQuestion(imported(
    "Depression",
    "behavioral-nervous-special-senses",
    "Psychiatric/Behavioral & Substance Use",
    "Behavioral Sciences",
  )), "Behavioral Science");
  assert.equal(classifyStep1DiagnosticQuestion(imported(
    "Iron deficiency anemia",
    "blood-lymphoreticular-immune",
    "Hematology & Oncology",
  )), "Hematology");
  assert.equal(classifyStep1DiagnosticQuestion(imported(
    "Anaphylaxis",
    "blood-lymphoreticular-immune",
    "Allergy & Immunology",
  )), "Immunology");
  assert.equal(classifyStep1DiagnosticQuestion(imported(
    "Haemophilus influenzae",
    "blood-lymphoreticular-immune",
    "Infectious Diseases",
    "Microbiology",
  )), "Microbiology");
  assert.equal(classifyStep1DiagnosticQuestion(imported(
    "Fructose 2 6 biphosphate",
    "multisystem-processes-disorders",
    "General Principles",
    "Biochemistry",
  )), "Biochemistry");
});

test("all relative inline media must have a private playable attachment", () => {
  const ready = auditDiagnosticQuestionMedia(fixture(0));
  assert.equal(ready.ready, true);
  assert.equal(ready.referenceCount, 1);
  assert.equal(ready.hasPlayableImage, true);

  const broken = auditDiagnosticQuestionMedia(fixture(0, { linked: false }));
  assert.equal(broken.ready, false);
  assert.deepEqual(broken.missingRefs, ["U23056.png"]);
});

test("an unverified external image URL is not treated as diagnostic-ready", () => {
  const question = fixture(1);
  question.question_html = '<img src="https://example.invalid/broken-figure.png">';
  const audit = auditDiagnosticQuestionMedia(question);
  assert.equal(audit.ready, false);
  assert.deepEqual(
    audit.missingRefs,
    ["https://example.invalid/broken-figure.png"],
  );
});

test("a required video is ready only when its verified playable mapping exists", () => {
  const question = fixture(1);
  question.question_html = '<video src="renal-loop.mp4"></video>';
  question.videos = [{
    ref: "renal-loop.mp4",
    provider_id: "987654",
    embed_url: "https://player.vimeo.com/video/987654",
  }];
  assert.equal(auditDiagnosticQuestionMedia(question).ready, true);

  question.videos = [];
  assert.equal(auditDiagnosticQuestionMedia(question).ready, false);
});

test("new diagnostics choose 2026 before 2025 for the same learning slot", () => {
  const current = {
    ...rotatingFixture(0),
    id: "current-question",
    source_year: 2026,
  };
  const prior = {
    ...rotatingFixture(0),
    id: "prior-question",
    source_year: 2025,
  };
  const result = buildStep1DiagnosticSelection([prior, current], {
    requestedCount: 1,
    minimumSystems: 1,
    selectionSeed: "year-priority",
  });
  assert.equal(result.ready, true);
  assert.equal(result.selected[0].id, "current-question");
});

test("the audited 40-question pilot set spans at least twelve canonical systems when media is linked", () => {
  const result = buildStep1DiagnosticSelection(
    TITLES.map((_, index) => fixture(index)),
    { requestedCount: 40, minimumSystems: 12 },
  );
  assert.equal(result.ready, true);
  assert.equal(result.selected.length, 40);
  assert.ok(result.selectedSystemKeys.length >= 12);
  assert.equal(result.rejectedMissingMediaCount, 0);
  assert.equal(result.selected.some((row) => row.diagnostic_system === "Renal"), true);
  assert.equal(result.selected.some((row) => row.diagnostic_system === "Reproductive"), true);
  assert.equal(result.selected.some((row) => row.diagnostic_system === "Biochemistry"), true);
});

test("broken figures make the diagnostic fail closed instead of showing unusable questions", () => {
  const result = buildStep1DiagnosticSelection(
    TITLES.map((_, index) => fixture(index, { linked: false })),
    { requestedCount: 40, minimumSystems: 12 },
  );
  assert.equal(result.ready, false);
  assert.equal(result.selected.length, 27);
  assert.equal(result.rejectedMissingMediaCount, 13);
  assert.equal(result.rejected.missingMedia.some((row) => row.missingRefs.includes("GFR_A.gif")), true);
  assert.equal(result.unmatchedReplacementCount, 13);
});

test("all thirteen broken image slots can be replaced one-for-one only by same-topic playable-image MCQs", () => {
  const originals = TITLES.map((_, index) => fixture(index, { linked: false }));
  const replacements = [...IMAGE_REFS.keys()]
    .map((questionNumber) => imageReplacementFixture(questionNumber - 1));
  const result = buildStep1DiagnosticSelection(
    [...originals, ...replacements],
    {
      requestedCount: 40,
      minimumSystems: 12,
      preferredQuestionIds: originals.map((question) => question.id),
    },
  );
  assert.equal(result.ready, true);
  assert.equal(result.selected.length, 40);
  assert.equal(result.governedReplacementCount, 13);
  assert.equal(result.unmatchedReplacementCount, 0);
  assert.equal(result.replacements.every((row) => (
    row.matchLevel === "topic"
    && row.replacementHasPlayableImage === true
    && row.imageRequired === true
  )), true);
  assert.equal(new Set(result.selected.map((question) => question.id)).size, 40);
  assert.equal(result.selected.some((question) => question.id === "question-1"), false);
  assert.equal(result.selected.some((question) => question.id === "replacement-question-1"), true);
});

test("a playable image from the same system but a different topic cannot fill a broken slot", () => {
  const original = fixture(0, { linked: false });
  original.exam_track = "usmle_step_1";
  const mismatch = imageReplacementFixture(0, { topic_key: "Bone tumors" });
  const result = buildStep1DiagnosticSelection(
    [original, mismatch],
    {
      requestedCount: 1,
      minimumSystems: 1,
      preferredQuestionIds: [original.id],
    },
  );
  assert.equal(diagnosticQuestionMatchProfile(original).system, "Musculoskeletal");
  assert.equal(result.ready, false);
  assert.equal(result.unmatchedReplacementCount, 1);
});

test("student-attempt seeds create different balanced diagnostics while the same seed is resumable", () => {
  const candidates = Array.from({ length: 400 }, (_, index) => rotatingFixture(index));
  const first = buildStep1DiagnosticSelection(candidates, {
    requestedCount: 40,
    minimumSystems: 12,
    selectionSeed: "student-a:attempt-1:server-nonce-a",
  });
  const replay = buildStep1DiagnosticSelection(candidates, {
    requestedCount: 40,
    minimumSystems: 12,
    selectionSeed: "student-a:attempt-1:server-nonce-a",
  });
  const friend = buildStep1DiagnosticSelection(candidates, {
    requestedCount: 40,
    minimumSystems: 12,
    selectionSeed: "student-b:attempt-1:server-nonce-b",
  });
  const firstIds = first.selected.map((question) => question.id);
  const replayIds = replay.selected.map((question) => question.id);
  const friendIds = friend.selected.map((question) => question.id);
  const overlap = friendIds.filter((id) => new Set(firstIds).has(id)).length;

  assert.equal(first.ready, true);
  assert.equal(friend.ready, true);
  assert.equal(first.studentAttemptSeeded, true);
  assert.equal(first.selectionMode, "student_attempt_seeded");
  assert.deepEqual(replayIds, firstIds);
  assert.notDeepEqual(friendIds, firstIds);
  assert.ok(overlap < 20, `expected strong anti-sharing variation, received ${overlap} shared questions`);
  assert.ok(first.selectedSystemKeys.length >= 12);
  assert.equal(first.taxonomyDepthReady, true);
  assert.equal(first.taxonomyCoverage.topicMappedQuestionCount, 40);
  assert.ok(first.taxonomyCoverage.subsystems >= 12);
  assert.ok(first.taxonomyCoverage.topics >= 20);
});

test("a later diagnostic prefers unseen questions before repeating student history", () => {
  const candidates = Array.from({ length: 400 }, (_, index) => rotatingFixture(index));
  const first = buildStep1DiagnosticSelection(candidates, {
    requestedCount: 40,
    minimumSystems: 12,
    selectionSeed: "student-a:attempt-1:nonce",
  });
  const exposures = Object.fromEntries(
    first.selected.map((question) => [question.id, 1]),
  );
  const next = buildStep1DiagnosticSelection(candidates, {
    requestedCount: 40,
    minimumSystems: 12,
    selectionSeed: "student-a:attempt-2:nonce",
    questionExposureCounts: exposures,
  });
  const firstIds = new Set(first.selected.map((question) => question.id));
  const repeated = next.selected.filter((question) => firstIds.has(question.id));

  assert.equal(next.ready, true);
  assert.equal(repeated.length, 0);
  assert.equal(next.repeatedQuestionCount, 0);
  assert.equal(next.freshQuestionCount, 40);
  assert.equal(next.maximumPriorExposure, 0);
});

test("dynamic diagnostics quarantine the thirteen broken image questions instead of fixing them into every test", () => {
  const broken = [...IMAGE_REFS.keys()]
    .map((questionNumber) => fixture(questionNumber - 1, { linked: false }));
  const fresh = Array.from({ length: 400 }, (_, index) => rotatingFixture(index));
  const result = buildStep1DiagnosticSelection([...broken, ...fresh], {
    requestedCount: 40,
    minimumSystems: 12,
    selectionSeed: "student-c:attempt-1:nonce",
  });
  const brokenIds = new Set(broken.map((question) => question.id));

  assert.equal(result.ready, true);
  assert.equal(result.rejectedMissingMediaCount, 13);
  assert.equal(result.governedReplacementCount, 0);
  assert.equal(result.unmatchedReplacementCount, 0);
  assert.equal(result.selected.some((question) => brokenIds.has(question.id)), false);
});

test("stored system overrides feed verified attempts and baseline scoring", () => {
  const question = applyDiagnosticSystemOverride(
    { id: "question-1", system_key: "1", taxonomy: { system_key: "1" } },
    "Renal",
  );
  assert.equal(question.system_key, "Renal");
  assert.equal(question.taxonomy.system_key, "Renal");
  assert.equal(question.taxonomy.diagnostic_blueprint_version, AYLA_DIAGNOSTIC_BLUEPRINT_VERSION);
});

test("only current mapped diagnostic sessions can answer or submit", () => {
  assert.equal(diagnosticSessionUsesCurrentBlueprint({ purpose: "practice" }), true);
  assert.equal(diagnosticSessionUsesCurrentBlueprint({
    purpose: "baseline_diagnostic",
    diagnosticBlueprintVersion: 1,
  }), false);
  assert.equal(diagnosticSessionUsesCurrentBlueprint({
    purpose: "baseline_diagnostic",
    diagnosticBlueprintVersion: AYLA_DIAGNOSTIC_BLUEPRINT_VERSION,
    questions: [{ contentQuestionId: "question-1" }],
    diagnosticSystemByQuestionId: { "question-1": "Renal" },
    diagnosticQuality: {
      mediaReady: true,
      taxonomyReady: true,
      governedReplacementReady: true,
      studentAttemptSeeded: true,
      taxonomyDepthReady: true,
      unmatchedReplacementCount: 0,
      minimumSystemCount: 1,
    },
  }), true);
  assert.equal(diagnosticSessionUsesCurrentBlueprint({
    purpose: "baseline_diagnostic",
    diagnosticBlueprintVersion: AYLA_DIAGNOSTIC_BLUEPRINT_VERSION,
    questions: [{ contentQuestionId: "question-1" }],
    diagnosticSystemByQuestionId: {},
    diagnosticQuality: {
      mediaReady: true,
      taxonomyReady: true,
      governedReplacementReady: true,
      studentAttemptSeeded: true,
      taxonomyDepthReady: true,
      unmatchedReplacementCount: 0,
      minimumSystemCount: 1,
    },
  }), false);
  assert.equal(diagnosticSessionUsesCurrentBlueprint({
    purpose: "baseline_diagnostic",
    diagnosticBlueprintVersion: AYLA_DIAGNOSTIC_BLUEPRINT_VERSION,
    questions: [{ contentQuestionId: "question-1" }],
    diagnosticSystemByQuestionId: { "question-1": "Renal" },
    diagnosticQuality: {
      mediaReady: false,
      taxonomyReady: true,
      governedReplacementReady: true,
      studentAttemptSeeded: true,
      taxonomyDepthReady: true,
      unmatchedReplacementCount: 0,
      minimumSystemCount: 1,
    },
  }), false);
  assert.equal(diagnosticSessionUsesCurrentBlueprint({
    purpose: "baseline_diagnostic",
    diagnosticBlueprintVersion: AYLA_DIAGNOSTIC_BLUEPRINT_VERSION,
    questions: [{ contentQuestionId: "question-1" }],
    diagnosticSystemByQuestionId: { "question-1": "Renal" },
    diagnosticQuality: {
      mediaReady: true,
      taxonomyReady: true,
      governedReplacementReady: false,
      studentAttemptSeeded: true,
      taxonomyDepthReady: true,
      unmatchedReplacementCount: 1,
      minimumSystemCount: 1,
    },
  }), false);
  assert.equal(diagnosticSessionUsesCurrentBlueprint({
    purpose: "baseline_diagnostic",
    diagnosticBlueprintVersion: AYLA_DIAGNOSTIC_BLUEPRINT_VERSION,
    questions: [{ contentQuestionId: "question-1" }],
    diagnosticSystemByQuestionId: { "question-1": "Renal" },
    diagnosticQuality: {
      mediaReady: true,
      taxonomyReady: true,
      governedReplacementReady: true,
      studentAttemptSeeded: false,
      taxonomyDepthReady: true,
      unmatchedReplacementCount: 0,
      minimumSystemCount: 1,
    },
  }), false);
});

test("server gates diagnostic creation, playback, answering and submission through the verified blueprint", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /buildStep1DiagnosticSelection\(candidates/);
  assert.match(server, /DIAGNOSTIC_CONTENT_NOT_READY/);
  assert.match(server, /media_incomplete_questions: blueprint\.rejectedMissingMediaCount/);
  assert.match(server, /diagnosticReplacementLineage = selection\.diagnosticReplacementLineage/);
  assert.match(server, /const diagnosticSelectionSeed = purpose === "baseline_diagnostic"/);
  assert.match(server, /questionExposureCounts: diagnosticQuestionExposureCounts/);
  assert.match(server, /selectionSeed: diagnosticSelectionSeed/);
  assert.doesNotMatch(server, /preferredDiagnosticQuestionIds/);
  assert.match(server, /session\.diagnosticTaxonomyByQuestionId = selection\.diagnosticTaxonomyByQuestionId/);
  assert.match(server, /studentAttemptSeeded: blueprint\.studentAttemptSeeded/);
  assert.match(server, /taxonomyDepthReady: blueprint\.taxonomyDepthReady/);
  assert.match(server, /untestedTaxonomyIsUnknown: true/);
  assert.match(server, /\/api\/ayla\/admin\/diagnostic\/step1\/media-replacements\/preview/);
  assert.match(server, /write_performed: false/);
  assert.match(server, /session\.diagnosticSystemByQuestionId = selection\.diagnosticSystemByQuestionId/);
  assert.match(server, /diagnostic_session_superseded/);
  assert.match(server, /ANSWERED_DIAGNOSTIC_REVIEW_REQUIRED/);
  assert.match(
    server,
    /const reviewQuestions = rawReviewQuestions\.map\(\(question\) =>\s*aylaDiagnosticQuestionForSession/,
  );
  assert.ok(
    (server.match(/aylaRequireCurrentDiagnosticBlueprint\(/g) || []).length >= 6,
    "all diagnostic entry and mutation paths should fail closed on a legacy blueprint",
  );
});

test("daily roadmap and Tutor stay diagnostic-only until a verified baseline exists", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /title: "Complete your verified 40-question diagnostic"/);
  assert.match(server, /actionRoute: "\/dashboard\/qbank\?diagnostic=1"/);
  assert.match(server, /aylaV258CompleteDiagnosticAssignments/);
  assert.match(server, /completedDiagnosticAssignments/);
});

test("pilot QBank and recall resources require canonical taxonomy and ready media", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /async function aylaV250EligibleQbankQuestions/);
  assert.match(server, /const canonicalSystem = classifyStep1DiagnosticQuestion\(row\)/);
  assert.match(server, /const media = auditDiagnosticQuestionMedia\(row\)/);
  assert.match(server, /qbank_registry_no_media_ready_canonical_questions_for_focus/);
  assert.match(server, /const canonicalSystem = classifyStep1DiagnosticQuestion\(question\)/);
});

test("Personal Tutor receives a server-derived Step 1 pace estimate", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /function aylaV258TutorPathwayEstimate/);
  assert.match(server, /uniqueVerifiedQuestions/);
  assert.match(server, /baselineVerified: student\.serverVerifiedBaseline === true/);
  assert.match(server, /pathwayEstimate,/);
});
