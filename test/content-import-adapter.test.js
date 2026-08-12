import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTENT_SOURCE_ADAPTERS,
  adaptSourceTaxonomy,
  adaptUniversalQuestion,
  contentHash,
  extractExternalVideoReferences,
  extractMediaReferences,
  isCdmSelfRatingQuestion,
  mediaMatchKeys,
  mediaReferencePathCandidates,
  normalizeExamTrack,
  pairQuestionAnswerFiles,
  resolveContentSourceExamHint,
  resolveContentSourceAdapter,
  sanitizeImportedHtml,
  validateAdaptedCdmStep,
  validateAdaptedQuestion,
} from "../lib/content-import-adapter.js";

test("exam aliases normalize without leaking track-specific IDs", () => {
  assert.equal(normalizeExamTrack("STEP 1"), "usmle-step-1");
  assert.equal(normalizeExamTrack("usmle_step_1"), "usmle-step-1");
  assert.equal(normalizeExamTrack("USMLE Step 2 CK"), "usmle-step-2");
  assert.equal(normalizeExamTrack("usmle_step_3"), "usmle-step-3");
  assert.equal(normalizeExamTrack("NCLEX"), "nclex");
});

test("question and answer files pair case-insensitively", () => {
  const pairs = pairQuestionAnswerFiles(["A_questions.json", "A_answers.json", "B_questions.json"]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].answerFile, "A_answers.json");
  assert.equal(pairs[1].answerFile, null);
});

test("media references normalize double extensions", () => {
  assert.deepEqual(extractMediaReferences('<img src="U612.jpg">', "L47301.jpg", "legacy.bmp"), ["U612.jpg", "L47301.jpg", "legacy.bmp"]);
  assert.deepEqual(extractMediaReferences("This sentence, however, is ordinary prose."), []);
  assert.deepEqual(extractMediaReferences("Listen to 12360.mp3, then review clip-1.mp4."), ["12360.mp3", "clip-1.mp4"]);
  assert.ok(mediaMatchKeys("iMD/U612.jpg.png").includes("u612"));
  assert.ok(mediaMatchKeys("legacy.bmp").includes("legacy"));
});

test("imported provider HTML keeps content but removes executable markup", () => {
  const sanitized = sanitizeImportedHtml(`
    <style>.danger { display: none }</style>
    <script>alert("no")</script>
    <button onclick="alert('no')">Show Hint</button>
    <div id="hintdiv" style="display:none;color:red">Useful hint</div>
    <a target="_blank" onclick="open_url(\`https://example.test/reference\`)">Reference</a>
    <img src="javascript:alert(1)" onerror="alert(2)">
  `);
  assert.doesNotMatch(sanitized, /<script|<style|onclick|onerror|javascript:/i);
  assert.doesNotMatch(sanitized, /display\s*:\s*none/i);
  assert.match(sanitized, /<strong>Show Hint<\/strong>/i);
  assert.match(sanitized, /href="https:\/\/example\.test\/reference"/i);
  assert.match(sanitized, /rel="noopener noreferrer"/i);
  assert.match(sanitized, /Useful hint/);
});

test("provider-aware adapters preserve useful taxonomy without creating thousands of false system groups", () => {
  const amboss = resolveContentSourceAdapter({
    sourceProvider: "AMBOSS",
    sourceFile: "ambossqb-USMLE Step 12025.db_questions.json",
  });
  assert.equal(amboss, CONTENT_SOURCE_ADAPTERS.ambossSba);
  assert.deepEqual(adaptSourceTaxonomy({ sysId: "9", subId: "2,12,22" }, amboss), {
    systemSourceId: "9",
    subjectSourceId: "",
    sourceTagIds: ["2", "12", "22"],
    orientation: "system_with_multi_value_tags",
    rawSystemId: "9",
    rawSubjectId: "2,12,22",
  });

  const canada = resolveContentSourceAdapter({
    sourceProvider: "CanadaQBank",
    sourceFile: "cqb-usmlestep1-2025.db_questions.json",
  });
  assert.equal(canada, CONTENT_SOURCE_ADAPTERS.canadaQbankSba);
  assert.deepEqual(adaptSourceTaxonomy({ sysId: 587, subId: 111 }, canada), {
    systemSourceId: "111",
    subjectSourceId: "",
    sourceTagIds: ["587"],
    orientation: "subject_as_system_with_topic_ids",
    rawSystemId: "587",
    rawSubjectId: "111",
  });

  const flat = resolveContentSourceAdapter({
    sourceProvider: "MPlusX",
    sourceFile: "mplusx-2025.db_questions.json",
  });
  assert.equal(flat, CONTENT_SOURCE_ADAPTERS.flatSystemSba);
  assert.equal(adaptSourceTaxonomy({ sysId: 26, subId: 0 }, flat).systemSourceId, "26");
  assert.equal(adaptSourceTaxonomy({ sysId: 26, subId: 0 }, flat).subjectSourceId, "");
});

test("exam hints use exact export evidence instead of treating a multi-exam provider as one exam", () => {
  assert.equal(resolveContentSourceExamHint({
    sourceProvider: "CanadaQBank",
    sourceFile: "cqb-usmlestep1-2025.db_questions.json",
  }), "usmle-step-1");
  assert.equal(resolveContentSourceExamHint({
    sourceProvider: "CanadaQBank",
    sourceNamespace: "canadaqbank-mccqe-2026",
  }), "mccqe");
  assert.equal(resolveContentSourceExamHint({
    sourceProvider: "CanadaQBank",
    sourceNamespace: "unlabelled-export",
  }), "");
  assert.equal(resolveContentSourceExamHint({ sourceProvider: "Amedex" }), "amc");
  assert.equal(resolveContentSourceExamHint({ sourceProvider: "MPlusX" }), "amc");
  assert.equal(resolveContentSourceExamHint({ sourceProvider: "ACE QBank" }), "mccqe");
});

test("CDM self-rating exports are detected and blocked from ordinary MCQ scoring", () => {
  const question = {
    id: 1,
    title: "CASE 1 - Question 1",
    question: "<p>CDM CASE 1</p>",
    explanation: "<p>Maximum number of allowed responses: 3</p><p>Correct answer(s)</p>",
    corrAns: 1,
  };
  const answers = [
    { id: 1, qId: 1, answerId: 1, answerText: "I know this" },
    { id: 2, qId: 1, answerId: 2, answerText: "I don't know this" },
  ];
  assert.equal(isCdmSelfRatingQuestion(question, answers), true);
  const row = adaptUniversalQuestion(question, answers, {
    examTrack: "mccqe",
    sourceProvider: "AceQBank",
    sourceNamespace: "aceqbank-cdm-2024",
    collectionKey: "cdm",
  });
  assert.equal(row.sourceData.source_adapter, CONTENT_SOURCE_ADAPTERS.cdmSelfRating);
  assert.equal(row.sourceData.item_format, "cdm_self_rating_case");
  assert.equal(row.sourceData.scoring_mode, "self_rating_not_mastery");
  assert.equal(row.sourceData.interaction_format, "legacy_cdm_write_in_v1");
  assert.equal(row.sourceData.case_source_id, "1");
  assert.equal(row.sourceData.case_number, 1);
  assert.equal(row.sourceData.step_number, 1);
  assert.equal(row.sourceData.max_responses, 3);
  assert.equal(row.sourceData.source_self_rating_controls_ignored, 2);
  assert.equal(row.correctAnswerId, -1);
  assert.deepEqual(row.answers, []);
  assert.deepEqual(validateAdaptedCdmStep(row), []);
  assert.ok(validateAdaptedQuestion(row).includes("specialized_cdm_interaction_required"));
});

test("media references preserve ZIP-relative paths and resolve them beside the source JSON", () => {
  assert.deepEqual(
    extractMediaReferences('<img src="../media/chapter-a/diagram.png?size=2">'),
    ["media/chapter-a/diagram.png"],
  );
  assert.deepEqual(
    mediaReferencePathCandidates("images/diagram.png", {
      sourceFile: "exports/step1/cardio_questions.json",
    }),
    [
      "exports/step1/images/diagram.png",
      "images/diagram.png",
    ],
  );
  assert.deepEqual(
    mediaReferencePathCandidates("../shared/diagram.png", {
      sourceFile: "exports/step1/cardio_questions.json",
    }),
    [
      "exports/shared/diagram.png",
      "shared/diagram.png",
    ],
  );
});

test("question/answer snapshots are ordered newest-first", () => {
  const pairs = pairQuestionAnswerFiles([
    "bank-2025-March_questions.json", "bank-2025-March_answers.json",
    "bank-2026-Mar_questions.json", "bank-2026-Mar_answers.json",
    "bank-2024-July_questions.json", "bank-2024-July_answers.json",
  ]);
  assert.equal(pairs[0].questionFile, "bank-2026-Mar_questions.json");
  assert.equal(pairs[2].questionFile, "bank-2024-July_questions.json");
});

test("high-resolution export prefixes map to the original JSON reference", () => {
  assert.ok(mediaMatchKeys("highresdefault_U17115.png").includes("u17115.png"));
  assert.ok(mediaMatchKeys("highresdefault_L29978.jpg.png").includes("l29978.jpg"));
});

test("exact duplicate hash ignores harmless HTML spacing", () => {
  const answers = [{ answerId: 1, answerText: "Alpha" }, { answerId: 2, answerText: "Beta" }];
  assert.equal(
    contentHash({ questionHtml: "<p>Question &nbsp; text</p>", answers }),
    contentHash({ questionHtml: "Question text", answers }),
  );
});

test("adapter validates correct answer and explanation", () => {
  const row = adaptUniversalQuestion({ id: 10, question: "<p>Stem?</p>", explanation: "Because", corrAns: 2 }, [
    { id: 1, qId: 10, answerId: 1, answerText: "A" },
    { id: 2, qId: 10, answerId: 2, answerText: "B" },
  ], { examTrack: "step 1", sourceNamespace: "provider-a", collectionKey: "march" });
  assert.deepEqual(validateAdaptedQuestion(row), []);
  assert.equal(row.examTrack, "usmle-step-1");
  assert.equal(row.correctAnswerId, 2);
});

test("UWorld Step 3 stays in the Step 3 namespace and preserves linked-item context", () => {
  const row = adaptUniversalQuestion({
    id: 5239,
    parentQId: 5238,
    question: "<p><strong>Item 2 of 2</strong></p><p>What is the best treatment?</p>",
    explanation: "<p>Step 3 management explanation</p>",
    corrAns: 2,
    sysId: 1005,
    subId: 102,
  }, [
    { id: 1, qId: 5239, answerId: 1, answerText: "First option" },
    { id: 2, qId: 5239, answerId: 2, answerText: "Second option" },
  ], {
    examTrack: "usmle-step-3",
    sourceProvider: "UWorld",
    sourceNamespace: "uworld-step3-2026-march",
    collectionKey: "uworldstep3-2026-march",
    collectionTitle: "UWorld USMLE Step 3 March 2026",
  });
  assert.deepEqual(validateAdaptedQuestion(row), []);
  assert.equal(row.examTrack, "usmle-step-3");
  assert.equal(row.sourceData.source_exam_track_hint, "usmle-step-3");
  assert.equal(row.parentSourceId, "5238");
  assert.equal(row.systemSourceId, "1005");
  assert.equal(row.subjectSourceId, "102");
});

test("adapter sanitizes stems, explanations and answers before persistence", () => {
  const row = adaptUniversalQuestion({
    id: 10,
    question: '<p onclick="alert(1)">Stem?</p>',
    explanation: '<script>alert(2)</script><p>Because</p>',
    corrAns: 2,
  }, [
    { id: 1, qId: 10, answerId: 1, answerText: '<span onmouseover="alert(3)">A</span>' },
    { id: 2, qId: 10, answerId: 2, answerText: "B" },
  ], { examTrack: "step 1", sourceNamespace: "provider-a", collectionKey: "march" });
  assert.doesNotMatch(`${row.questionHtml}${row.explanationHtml}${row.answers[0].textHtml}`, /on(?:click|mouseover)|<script/i);
  assert.equal(row.answers[0].textHtml, "<span>A</span>");
  assert.deepEqual(validateAdaptedQuestion(row), []);
});

test("adapter preserves question versus explanation media placement", () => {
  const row = adaptUniversalQuestion({
    id: 11,
    question: '<p>Stem</p><img src="question.png">',
    explanation: '<p>Why</p><img src="explanation.jpg">',
    otherMedias: "12360.mp3,clip.mp4",
    corrAns: 1,
  }, [{ id: 1, qId: 11, answerId: 1, answerText: "A" }, { id: 2, qId: 11, answerId: 2, answerText: "B" }], {
    examTrack: "step 1", sourceNamespace: "provider-a", collectionKey: "march",
  });
  assert.equal(row.sourceData.media_placements["question.png"], "question");
  assert.equal(row.sourceData.media_placements["explanation.jpg"], "explanation");
  assert.equal(row.sourceData.media_placements["12360.mp3"], "explanation");
  assert.equal(row.sourceData.media_placements["clip.mp4"], "explanation");
});

test("adapter keeps answer-choice images on the exact answer placement", () => {
  const row = adaptUniversalQuestion({
    id: 14,
    question: "<p>Stem</p>",
    explanation: "<p>Why</p>",
    corrAns: 2,
  }, [
    { id: 1, qId: 14, answerId: 1, answerText: '<span>A</span><img src="choice-a.bmp">' },
    { id: 2, qId: 14, answerId: 2, answerText: '<span>B</span><img src="choice-b.png">' },
  ], {
    examTrack: "amc",
    sourceProvider: "Amedex",
    sourceNamespace: "amedex-mcq-2025",
    collectionKey: "amedex",
  });
  assert.deepEqual(row.answers[0].mediaRefs, ["choice-a.bmp"]);
  assert.deepEqual(row.answers[1].mediaRefs, ["choice-b.png"]);
  assert.equal(row.sourceData.media_placements["choice-a.bmp"], "answer:1");
  assert.equal(row.sourceData.media_placements["choice-b.png"], "answer:2");
});

test("supplemental filenames containing spaces stay whole instead of creating a false suffix reference", () => {
  const row = adaptUniversalQuestion({
    id: 9812,
    question: "<p>Stem</p>",
    explanation: '<p>Why</p><img src="9812_Screen Shot 2021-11-01 at 2.12.25 pm.png">',
    otherMedias: "9812_Screen Shot 2021-11-01 at 2.12.25 pm.png",
    corrAns: 1,
  }, [
    { id: 1, qId: 9812, answerId: 1, answerText: "A" },
    { id: 2, qId: 9812, answerId: 2, answerText: "B" },
  ], {
    examTrack: "amc",
    sourceProvider: "MPlusX",
    sourceNamespace: "mplusx-2025",
    collectionKey: "mplusx",
  });
  assert.deepEqual(row.media, ["9812_Screen Shot 2021-11-01 at 2.12.25 pm.png"]);
  assert.equal(row.media.includes("pm.png"), false);
});

test("reviewed media aliases add an exact asset path without changing placement", () => {
  const row = adaptUniversalQuestion({
    id: 3114,
    question: '<p>Stem</p><img src="wp-content/uploads/diagram.bmp">',
    explanation: "<p>Why</p>",
    corrAns: 1,
  }, [
    { id: 1, qId: 3114, answerId: 1, answerText: "A" },
    { id: 2, qId: 3114, answerId: 2, answerText: "B" },
  ], {
    examTrack: "amc",
    sourceProvider: "MPlusX",
    sourceNamespace: "mplusx-2025",
    collectionKey: "mplusx",
    mediaAliases: [{
      alias_key: "reviewed-alias",
      source_item_id: "3114",
      media_ref: "wp-content/uploads/diagram.bmp",
      asset_path: "mplusx/3114_diagram.bmp",
      placement: "question",
      evidence: "question_id_and_reference",
    }],
  });
  assert.deepEqual(row.sourceData.media_match_paths["wp-content/uploads/diagram.bmp"], [
    "mplusx/3114_diagram.bmp",
    "wp-content/uploads/diagram.bmp",
  ]);
  assert.equal(row.sourceData.media_placements["wp-content/uploads/diagram.bmp"], "question");
  assert.deepEqual(row.sourceData.media_aliases_applied, [{
    alias_key: "reviewed-alias",
    media_ref: "wp-content/uploads/diagram.bmp",
    asset_path: "mplusx/3114_diagram.bmp",
    placement: "question",
    evidence: "question_id_and_reference",
  }]);
});

test("external explanation videos are preserved as private review metadata, not upload media", () => {
  const html = '<a onclick="open_url(`https://youtu.be/AbCdEf12345`)">Watch</a>';
  const videos = extractExternalVideoReferences({ html, placement: "explanation" });
  assert.deepEqual(videos, [{
    provider: "youtube",
    provider_id: "AbCdEf12345",
    placement: "explanation",
    source_url: "https://www.youtube.com/watch?v=AbCdEf12345",
    review_status: "private_unreviewed",
  }]);
  const row = adaptUniversalQuestion({
    id: 15,
    question: "<p>Stem</p>",
    explanation: html,
    corrAns: 1,
  }, [
    { id: 1, qId: 15, answerId: 1, answerText: "A" },
    { id: 2, qId: 15, answerId: 2, answerText: "B" },
  ], {
    examTrack: "amc",
    sourceProvider: "Amedex",
    sourceNamespace: "amedex-mcq-2025",
    collectionKey: "amedex",
  });
  assert.deepEqual(row.media, []);
  assert.deepEqual(row.sourceData.external_video_references, videos);
  assert.doesNotMatch(row.explanationHtml, /onclick=/i);
  assert.match(row.explanationHtml, /href="https:\/\/youtu\.be\/AbCdEf12345"/i);
});

test("adapter stores contextual media match paths without changing the question placement", () => {
  const row = adaptUniversalQuestion({
    id: 13,
    question: '<p>Stem</p><img src="images/shared.png">',
    explanation: "<p>Why</p>",
    corrAns: 1,
  }, [{ id: 1, qId: 13, answerId: 1, answerText: "A" }, { id: 2, qId: 13, answerId: 2, answerText: "B" }], {
    examTrack: "step 1",
    sourceNamespace: "provider-a",
    collectionKey: "march",
    sourceFile: "exports/cardio/cardio_questions.json",
  });
  assert.deepEqual(row.media, ["images/shared.png"]);
  assert.deepEqual(row.sourceData.media_match_paths["images/shared.png"], [
    "exports/cardio/images/shared.png",
    "images/shared.png",
  ]);
  assert.equal(row.sourceData.media_placements["images/shared.png"], "question");
});

test("adapter collapses semantic low/high-resolution duplicates without moving question figures", () => {
  const row = adaptUniversalQuestion({
    id: 12,
    question: '<p>Stem</p><img src="U442.png">',
    explanation: '<p>Why</p><img src="highresdefault_L1436.jpg">',
    otherMedias: "highresdefault_U442.png,L1436.jpg,highresdefault_L1436.jpg",
    corrAns: 1,
  }, [{ id: 1, qId: 12, answerId: 1, answerText: "A" }, { id: 2, qId: 12, answerId: 2, answerText: "B" }], {
    examTrack: "step 1", sourceNamespace: "provider-a", collectionKey: "march",
  });
  assert.deepEqual(row.media, ["U442.png", "highresdefault_L1436.jpg"]);
  assert.equal(row.sourceData.media_placements["U442.png"], "question");
  assert.equal(row.sourceData.media_placements["highresdefault_L1436.jpg"], "explanation");
});
