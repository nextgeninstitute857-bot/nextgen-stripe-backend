import { AYLA_STUDENT_FEATURES } from "./aylamed-student-shell.js";

const DIAGNOSTIC_FEATURE = Object.freeze({
  key: "diagnostic",
  label: "Diagnostic Setup",
  route: null,
  aliases: ["diagnostic", "diagnostics", "onboarding", "baseline_diagnostic"],
  navigation: false,
});

export const AYLA_PLAN_FEATURE_CATALOG = Object.freeze([
  DIAGNOSTIC_FEATURE,
  ...AYLA_STUDENT_FEATURES.map((feature) => Object.freeze({ ...feature, navigation: true })),
]);

const ALIAS_TO_FEATURE = new Map();
for (const feature of AYLA_PLAN_FEATURE_CATALOG) {
  ALIAS_TO_FEATURE.set(feature.key, feature.key);
}
for (const feature of AYLA_PLAN_FEATURE_CATALOG) {
  // Canonical keys always win when a historical alias was reused by another
  // screen (for example, `roadmap` also appeared in Progress aliases).
  for (const alias of feature.aliases || []) {
    if (!ALIAS_TO_FEATURE.has(alias)) ALIAS_TO_FEATURE.set(alias, feature.key);
  }
}

// Resolve legacy aliases to one canonical feature instead of letting a broad
// alias such as knowledge_search accidentally unlock several student screens.
ALIAS_TO_FEATURE.set("weak_areas", "revision");
ALIAS_TO_FEATURE.set("weak_area", "revision");
ALIAS_TO_FEATURE.set("knowledge_search", "library");
ALIAS_TO_FEATURE.set("ai_coach", "personal_tutor");

function cleanFeature(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function inputList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",");
  return [];
}

function controlError(message, code = "INVALID_PLAN_FEATURE") {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

export function normalizeAylaPlanFeature(value = "") {
  return ALIAS_TO_FEATURE.get(cleanFeature(value)) || null;
}

export function normalizeAylaPlanFeatures(value, { rejectUnknown = false } = {}) {
  const features = [];
  const unknown = [];
  for (const raw of inputList(value)) {
    const clean = cleanFeature(raw);
    if (!clean) continue;
    const canonical = normalizeAylaPlanFeature(clean);
    if (!canonical) unknown.push(clean);
    else if (!features.includes(canonical)) features.push(canonical);
  }
  if (rejectUnknown && unknown.length) {
    throw controlError(`Unsupported AylaMed plan feature(s): ${unknown.join(", ")}`, "UNKNOWN_PLAN_FEATURE");
  }
  const order = new Map(AYLA_PLAN_FEATURE_CATALOG.map((feature, index) => [feature.key, index]));
  features.sort((left, right) => Number(order.get(left) ?? 999) - Number(order.get(right) ?? 999));
  return { features, unknown: [...new Set(unknown)].sort() };
}

export function applyAylaPlanFeaturePatch(plan = {}, patch = {}) {
  const current = normalizeAylaPlanFeatures(plan.included_features || plan.features || []).features;
  let selected = new Set(current);
  let fullAccess = Boolean(plan.is_full_access);

  const hasReplacement = patch.included_features !== undefined || patch.features !== undefined;
  if (hasReplacement) {
    selected = new Set(normalizeAylaPlanFeatures(patch.included_features ?? patch.features, { rejectUnknown: true }).features);
    fullAccess = false;
  }

  const overrides = patch.feature_overrides || patch.featureOverrides;
  if (overrides !== undefined) {
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
      throw controlError("feature_overrides must be an object of feature booleans", "INVALID_FEATURE_OVERRIDES");
    }
    for (const [rawFeature, enabled] of Object.entries(overrides)) {
      const feature = normalizeAylaPlanFeature(rawFeature);
      if (!feature) throw controlError(`Unsupported AylaMed plan feature: ${cleanFeature(rawFeature)}`, "UNKNOWN_PLAN_FEATURE");
      if (enabled === true) selected.add(feature);
      else if (enabled === false) selected.delete(feature);
      else throw controlError(`Feature override for ${feature} must be true or false`, "INVALID_FEATURE_OVERRIDE_VALUE");
    }
    fullAccess = false;
  }

  if (patch.is_full_access !== undefined) {
    fullAccess = patch.is_full_access === true;
    if (fullAccess) selected = new Set(AYLA_PLAN_FEATURE_CATALOG.map((feature) => feature.key));
  }

  const normalized = normalizeAylaPlanFeatures([...selected]).features;
  return { included_features: normalized, is_full_access: fullAccess };
}

export function aylaPlanFeatureMatrixRow(plan = {}) {
  const normalized = normalizeAylaPlanFeatures(plan.included_features || plan.features || []).features;
  const enabled = new Set(plan.is_full_access === true ? AYLA_PLAN_FEATURE_CATALOG.map((feature) => feature.key) : normalized);
  return {
    id: plan.id || null,
    plan_id: plan.id || null,
    name: plan.name || "AylaMed Plan",
    plan_type: plan.plan_type || plan.type || "monthly",
    is_demo: plan.is_demo === true || ["demo", "trial"].includes(String(plan.plan_type || plan.type || "").toLowerCase()),
    is_full_access: plan.is_full_access === true,
    is_active: plan.is_active !== false,
    is_public: plan.is_public !== false,
    feature_matrix_version: Math.max(1, Number(plan.feature_matrix_version || 1)),
    included_features: normalized,
    features: Object.fromEntries(AYLA_PLAN_FEATURE_CATALOG.map((feature) => [feature.key, enabled.has(feature.key)])),
  };
}

export function publicAylaPlanFeatureCatalog() {
  return AYLA_PLAN_FEATURE_CATALOG.map((feature) => ({
    key: feature.key,
    label: feature.label,
    route: feature.route || null,
    navigation: feature.navigation === true,
  }));
}
