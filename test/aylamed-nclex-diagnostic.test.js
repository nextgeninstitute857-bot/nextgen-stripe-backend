import test from "node:test";
import assert from "node:assert/strict";

import {
  aylaNclexDiagnosticBlueprint,
  aylaNclexDiagnosticBlueprintSnapshot,
  aylaNclexDiagnosticQuestionClientNeed,
  aylaNclexDiagnosticSystems,
  aylaNclexDiagnosticTargetPercentages,
  canonicalAylaNclexClientNeed,
} from "../lib/aylamed-nclex-diagnostic.js";
import {
  AYLA_DIAGNOSTIC_BLUEPRINT_VERSION,
  buildMultiExamDiagnosticSelection,
  diagnosticSessionUsesCurrentBlueprint,
} from "../lib/aylamed-diagnostic.js";

function question(id, clientNeed, variant = "nclex_rn") {
  return {
    id: `${variant}-${id}`,
    title: `${clientNeed} clinical judgment item ${id}`,
    exam_track: "nclex",
    client_need: clientNeed,
    taxonomy: {
      client_need: clientNeed,
      labels: { system: clientNeed, topic: `${clientNeed} topic ${id}` },
      topic_key: `${clientNeed}:topic:${id}`,
    },
    question_html: "<p>Verified nursing stem</p>",
    explanation_html: "<p>Verified rationale</p>",
    answers: [{ answer_id: 1, text_html: "Choice A" }],
    media: [],
  };
}

function pool(variant) {
  return aylaNclexDiagnosticSystems(variant).flatMap((clientNeed) => (
    Array.from({ length: 20 }, (_, index) => question(`${clientNeed}-${index + 1}`, clientNeed, variant))
  ));
}

test("official 2026 RN and PN blueprints preserve their different Client Needs weights", () => {
  const rn = aylaNclexDiagnosticBlueprint("nclex_rn");
  const pn = aylaNclexDiagnosticBlueprint("nclex_pn");
  assert.equal(rn.sourceUrl, "https://www.nclex.com/files/2026_RN_Test%20Plan_English-F.pdf");
  assert.equal(pn.sourceUrl, "https://www.nclex.com/files/2026_PN_Test%20Plan-F.pdf");
  assert.equal(rn.categories[0].label, "Management of Care");
  assert.deepEqual([rn.categories[0].minimumPercent, rn.categories[0].maximumPercent], [15, 21]);
  assert.equal(pn.categories[0].label, "Coordinated Care");
  assert.deepEqual([pn.categories[0].minimumPercent, pn.categories[0].maximumPercent], [18, 24]);
  assert.equal(rn.categories.find((row) => row.label.startsWith("Pharmacological")).targetPercent, 16);
  assert.equal(pn.categories.find((row) => row.label.startsWith("Pharmacological")).targetPercent, 13);
  assert.equal(rn.clinicalJudgment.caseStudyItemCount, 18);
  assert.equal(pn.clinicalJudgment.approximateStandaloneItemPercent, 10);
});

test("RN and PN raw labels normalize to their own official categories without crossing variants", () => {
  assert.equal(canonicalAylaNclexClientNeed("Management of Care", "nclex_rn"), "Management of Care");
  assert.equal(canonicalAylaNclexClientNeed("Coordinated Care", "nclex_pn"), "Coordinated Care");
  assert.equal(canonicalAylaNclexClientNeed("Coordinated Care", "nclex_rn"), "");
  assert.equal(canonicalAylaNclexClientNeed("Management of Care", "nclex_pn"), "");
  assert.equal(canonicalAylaNclexClientNeed("Safety and Infection Control", "nclex_rn"), "Safety and Infection Prevention and Control");
  assert.equal(canonicalAylaNclexClientNeed("Pharmacological Therapies", "nclex_rn"), "Pharmacological and Parenteral Therapies");
  assert.equal(canonicalAylaNclexClientNeed("Pharmacological Therapies", "nclex_pn"), "Pharmacological Therapies");
  assert.equal(canonicalAylaNclexClientNeed("NCLEX Clinical Practice", "nclex_rn"), "");
});

test("the classifier reads reviewed client-need fields before broader source systems", () => {
  const row = question(1, "Reduction of Risk Potential");
  row.system_key = "NCLEX Clinical Practice";
  assert.equal(aylaNclexDiagnosticQuestionClientNeed(row, "nclex_rn"), "Reduction of Risk Potential");
});

for (const variant of ["nclex_rn", "nclex_pn"]) {
  test(`${variant} builds an exact 40-question officially weighted diagnostic`, () => {
    const systems = aylaNclexDiagnosticSystems(variant);
    const result = buildMultiExamDiagnosticSelection(pool(variant), {
      requestedCount: 40,
      minimumSystems: 8,
      allowedSystems: systems,
      resolveSystem: (row) => aylaNclexDiagnosticQuestionClientNeed(row, variant),
      selectionSeed: `${variant}:student:attempt`,
      targetPercentBySystem: aylaNclexDiagnosticTargetPercentages(variant),
    });
    assert.equal(result.ready, true);
    assert.equal(result.selected.length, 40);
    assert.equal(result.selectedSystemKeys.length, 8);
    assert.equal(result.weightingReady, true);
    assert.equal(Object.values(result.selectedQuestionCountBySystem).reduce((sum, count) => sum + count, 0), 40);
    assert.deepEqual(result.selectedQuestionCountBySystem, result.targetQuestionCountBySystem);

    const blueprint = aylaNclexDiagnosticBlueprint(variant);
    for (const category of blueprint.categories) {
      const actualPercent = (result.selectedQuestionCountBySystem[category.label] / 40) * 100;
      assert.ok(actualPercent >= category.minimumPercent - 0.001, `${category.label} fell below its official range`);
      assert.ok(actualPercent <= category.maximumPercent + 0.001, `${category.label} exceeded its official range`);
    }

    assert.equal(diagnosticSessionUsesCurrentBlueprint({
      purpose: "baseline_diagnostic",
      examTrack: "nclex",
      nclexVariant: variant,
      diagnosticBlueprintVersion: AYLA_DIAGNOSTIC_BLUEPRINT_VERSION,
      questions: result.selected.map((row) => ({ contentQuestionId: row.id })),
      diagnosticSystemByQuestionId: Object.fromEntries(result.selected.map((row) => [row.id, row.diagnostic_system])),
      diagnosticQuality: {
        mediaReady: true,
        taxonomyReady: true,
        governedReplacementReady: true,
        studentAttemptSeeded: true,
        taxonomyDepthReady: true,
        unmatchedReplacementCount: 0,
        minimumSystemCount: 8,
        weightingRequired: true,
        weightingReady: true,
        officialBlueprintRequired: true,
        officialBlueprintId: blueprint.id,
        examVariant: variant,
      },
    }), true);
  });
}

test("an under-covered official category fails closed instead of silently reweighting", () => {
  const variant = "nclex_pn";
  const systems = aylaNclexDiagnosticSystems(variant);
  const candidates = pool(variant).filter((row) => row.client_need !== "Coordinated Care");
  const result = buildMultiExamDiagnosticSelection(candidates, {
    requestedCount: 40,
    minimumSystems: 8,
    allowedSystems: systems,
    resolveSystem: (row) => aylaNclexDiagnosticQuestionClientNeed(row, variant),
    selectionSeed: "pn-under-covered",
    targetPercentBySystem: aylaNclexDiagnosticTargetPercentages(variant),
  });
  assert.equal(result.ready, false);
  assert.equal(result.selectedQuestionCountBySystem["Coordinated Care"], 0);
  assert.equal(result.weightingReady, false);
});

test("the public snapshot is reviewable and contains no question content", () => {
  const snapshot = aylaNclexDiagnosticBlueprintSnapshot("nclex_rn");
  assert.equal(snapshot.reviewed, true);
  assert.equal(snapshot.categories.length, 8);
  assert.equal(snapshot.clinical_judgment.steps.length, 6);
  assert.equal("questions" in snapshot, false);
});
