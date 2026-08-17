import { normalizeAylaNclexVariant } from "./aylamed-nclex-variant.js";

const RN_SOURCE = "https://www.nclex.com/files/2026_RN_Test%20Plan_English-F.pdf";
const PN_SOURCE = "https://www.nclex.com/files/2026_PN_Test%20Plan-F.pdf";
const EFFECTIVE_FROM = "2026-04-01";
const EFFECTIVE_TO = "2029-03-31";

function frozenCategory(key, label, minimumPercent, maximumPercent, targetPercent) {
  return Object.freeze({ key, label, minimumPercent, maximumPercent, targetPercent });
}

const SHARED_CLINICAL_JUDGMENT = Object.freeze({
  caseStudyCount: 3,
  itemsPerCaseStudy: 6,
  caseStudyItemCount: 18,
  approximateStandaloneItemPercent: 10,
  steps: Object.freeze([
    "Recognize cues",
    "Analyze cues",
    "Prioritize hypotheses",
    "Generate solutions",
    "Take action",
    "Evaluate outcomes",
  ]),
});

const BLUEPRINTS = Object.freeze({
  nclex_rn: Object.freeze({
    id: "ncsbn_nclex_rn_2026",
    variant: "nclex_rn",
    label: "2026 NCLEX-RN Test Plan",
    version: "2026-04-01_to_2029-03-31",
    effectiveFrom: EFFECTIVE_FROM,
    effectiveTo: EFFECTIVE_TO,
    sourceUrl: RN_SOURCE,
    reviewed: true,
    categories: Object.freeze([
      frozenCategory("management_of_care", "Management of Care", 15, 21, 18),
      frozenCategory("safety_and_infection_prevention_and_control", "Safety and Infection Prevention and Control", 10, 16, 13),
      frozenCategory("health_promotion_and_maintenance", "Health Promotion and Maintenance", 6, 12, 9),
      frozenCategory("psychosocial_integrity", "Psychosocial Integrity", 6, 12, 9),
      frozenCategory("basic_care_and_comfort", "Basic Care and Comfort", 6, 12, 9),
      frozenCategory("pharmacological_and_parenteral_therapies", "Pharmacological and Parenteral Therapies", 13, 19, 16),
      frozenCategory("reduction_of_risk_potential", "Reduction of Risk Potential", 9, 15, 12),
      frozenCategory("physiological_adaptation", "Physiological Adaptation", 11, 17, 14),
    ]),
    clinicalJudgment: SHARED_CLINICAL_JUDGMENT,
  }),
  nclex_pn: Object.freeze({
    id: "ncsbn_nclex_pn_2026",
    variant: "nclex_pn",
    label: "2026 NCLEX-PN Test Plan",
    version: "2026-04-01_to_2029-03-31",
    effectiveFrom: EFFECTIVE_FROM,
    effectiveTo: EFFECTIVE_TO,
    sourceUrl: PN_SOURCE,
    reviewed: true,
    categories: Object.freeze([
      frozenCategory("coordinated_care", "Coordinated Care", 18, 24, 21),
      frozenCategory("safety_and_infection_prevention_and_control", "Safety and Infection Prevention and Control", 10, 16, 13),
      frozenCategory("health_promotion_and_maintenance", "Health Promotion and Maintenance", 6, 12, 9),
      frozenCategory("psychosocial_integrity", "Psychosocial Integrity", 9, 15, 12),
      frozenCategory("basic_care_and_comfort", "Basic Care and Comfort", 7, 13, 10),
      frozenCategory("pharmacological_therapies", "Pharmacological Therapies", 10, 16, 13),
      frozenCategory("reduction_of_risk_potential", "Reduction of Risk Potential", 9, 15, 12),
      frozenCategory("physiological_adaptation", "Physiological Adaptation", 7, 13, 10),
    ]),
    clinicalJudgment: SHARED_CLINICAL_JUDGMENT,
  }),
});

function clean(value = "") {
  return String(value || "").replace(/\u0000/g, "").trim();
}

function normalized(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function aylaNclexDiagnosticBlueprint(value = "") {
  const variant = normalizeAylaNclexVariant(value);
  return BLUEPRINTS[variant] || null;
}

export function aylaNclexDiagnosticSystems(value = "") {
  return (aylaNclexDiagnosticBlueprint(value)?.categories || []).map((row) => row.label);
}

export function aylaNclexDiagnosticTargetPercentages(value = "") {
  return Object.fromEntries((aylaNclexDiagnosticBlueprint(value)?.categories || [])
    .map((row) => [row.label, row.targetPercent]));
}

export function canonicalAylaNclexClientNeed(value = "", variantValue = "") {
  const variant = normalizeAylaNclexVariant(variantValue);
  if (!variant) return "";
  const text = normalized(value);
  if (!text || /^\d+$/.test(text) || ["general", "unknown", "unclassified", "nclex clinical practice"].includes(text)) return "";

  if (/safety.*infection|infection.*(?:prevention|control)|safe and effective care.*safety/.test(text)) {
    return "Safety and Infection Prevention and Control";
  }
  if (/health promotion|health maintenance|growth and development|early detection/.test(text)) {
    return "Health Promotion and Maintenance";
  }
  if (/psychosocial integrity|mental health|emotional.*social well being/.test(text)) {
    return "Psychosocial Integrity";
  }
  if (/basic care.*comfort|activities of daily living|personal care/.test(text)) {
    return "Basic Care and Comfort";
  }
  if (/pharmacolog|parenteral therap|medication administration/.test(text)) {
    return variant === "nclex_rn"
      ? "Pharmacological and Parenteral Therapies"
      : "Pharmacological Therapies";
  }
  if (/reduction of risk|risk potential|potential complication|diagnostic test/.test(text)) {
    return "Reduction of Risk Potential";
  }
  if (/physiological adaptation|acute.*chronic|life threatening|medical emergenc/.test(text)) {
    return "Physiological Adaptation";
  }
  if (variant === "nclex_rn" && /management of care|care management|prioritization|delegation/.test(text)) {
    return "Management of Care";
  }
  if (variant === "nclex_pn" && /coordinated care|care coordination|prioritization|delegation/.test(text)) {
    return "Coordinated Care";
  }
  return "";
}

function taxonomyRows(question = {}) {
  const taxonomy = question.taxonomy && typeof question.taxonomy === "object" ? question.taxonomy : {};
  const labels = taxonomy.labels && typeof taxonomy.labels === "object" ? taxonomy.labels : {};
  return [
    question.client_need,
    question.clientNeed,
    taxonomy.client_need,
    taxonomy.clientNeed,
    labels.client_need,
    labels.clientNeed,
    question.system_label,
    question.system_key,
    question.system,
    taxonomy.system_label,
    taxonomy.system_key,
    taxonomy.system,
    labels.system,
    question.subsystem_label,
    question.subsystem_key,
    question.subsystem,
    taxonomy.subsystem_label,
    taxonomy.subsystem_key,
    taxonomy.subsystem,
    labels.subsystem,
  ].map(clean).filter(Boolean);
}

export function aylaNclexDiagnosticQuestionClientNeed(question = {}, variantValue = "") {
  for (const candidate of taxonomyRows(question)) {
    const canonical = canonicalAylaNclexClientNeed(candidate, variantValue);
    if (canonical) return canonical;
  }
  return "";
}

export function aylaNclexDiagnosticBlueprintSnapshot(value = "") {
  const blueprint = aylaNclexDiagnosticBlueprint(value);
  if (!blueprint) return null;
  return {
    id: blueprint.id,
    variant: blueprint.variant,
    label: blueprint.label,
    version: blueprint.version,
    effective_from: blueprint.effectiveFrom,
    effective_to: blueprint.effectiveTo,
    source_url: blueprint.sourceUrl,
    reviewed: blueprint.reviewed,
    categories: blueprint.categories.map((row) => ({
      key: row.key,
      label: row.label,
      minimum_percent: row.minimumPercent,
      maximum_percent: row.maximumPercent,
      target_percent: row.targetPercent,
    })),
    clinical_judgment: {
      case_study_count: blueprint.clinicalJudgment.caseStudyCount,
      items_per_case_study: blueprint.clinicalJudgment.itemsPerCaseStudy,
      case_study_item_count: blueprint.clinicalJudgment.caseStudyItemCount,
      approximate_standalone_item_percent: blueprint.clinicalJudgment.approximateStandaloneItemPercent,
      steps: [...blueprint.clinicalJudgment.steps],
    },
  };
}

export const AYLA_NCLEX_DIAGNOSTIC_BLUEPRINTS = BLUEPRINTS;
