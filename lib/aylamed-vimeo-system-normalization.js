const mappingKey = (value = "") => String(value ?? "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const STEP1_DIRECT_ALIASES = Object.freeze({
  "nervous system": "Neurology",
  neuroscience: "Neurology",
  psychiatry: "Behavioral Science",
  "behavioral and social sciences": "Behavioral Science",
  "hematology and oncology": "Hematology",
  "hematology oncology": "Hematology",
  oncology: "Hematology",
  genetics: "Biochemistry",
  "general pathology": "Biochemistry",
  pathology: "Biochemistry",
  pulmonary: "Respiratory",
  pulmonology: "Respiratory",
  "pulmonary and critical care": "Respiratory",
  "respiratory system": "Respiratory",
  dermatology: "Musculoskeletal",
  "allergy and immunology": "Immunology",
  "infectious diseases": "Microbiology",
  "gastroenterology": "Gastrointestinal",
  "renal urinary systems and electrolytes": "Renal",
  "biostatistics and epidemiology": "Biostatistics and Ethics",
  epidemiology: "Biostatistics and Ethics",
  ethics: "Biostatistics and Ethics",
  "social sciences ethics legal professional": "Biostatistics and Ethics",
});

function step1CompositeTarget(systemKey, subsystemKey) {
  if (systemKey === "behavioral nervous special senses") {
    return subsystemKey.includes("psychiatric") || subsystemKey.includes("behavioral")
      ? "Behavioral Science"
      : "Neurology";
  }
  if (systemKey === "biostatistics epidemiology population health"
    || systemKey === "communication interpersonal skills") {
    return "Biostatistics and Ethics";
  }
  if (systemKey === "blood lymphoreticular immune") {
    if (subsystemKey.includes("allergy") || subsystemKey.includes("immunology")) return "Immunology";
    if (subsystemKey.includes("infectious") || subsystemKey.includes("microbiology")) return "Microbiology";
    return "Hematology";
  }
  if (systemKey === "human development") return "Biochemistry";
  if (systemKey === "multisystem processes disorders") {
    if (subsystemKey.includes("microbiology")) return "Microbiology";
    if (subsystemKey.includes("pharmacology")
      || subsystemKey.includes("anesthesia")
      || subsystemKey.includes("poisoning")) return "Pharmacology";
    return "Biochemistry";
  }
  if (systemKey === "musculoskeletal skin subcutaneous") return "Musculoskeletal";
  if (systemKey === "reproductive endocrine") {
    return subsystemKey.includes("endocrine")
      || subsystemKey.includes("diabetes")
      || subsystemKey.includes("metabolism")
      ? "Endocrine"
      : "Reproductive";
  }
  if (systemKey === "respiratory renal urinary") {
    return subsystemKey.includes("renal")
      || subsystemKey.includes("urinary")
      || subsystemKey.includes("electrolyte")
      ? "Renal"
      : "Respiratory";
  }
  return "";
}

export function canonicalAylaVimeoSystem({
  examTrackId = "",
  system = "",
  subsystem = "",
  allowedSystems = [],
} = {}) {
  const candidates = Array.isArray(allowedSystems) ? allowedSystems : [];
  const systemKey = mappingKey(system);
  const exact = candidates.find((candidate) => mappingKey(candidate) === systemKey);
  if (exact) return exact;
  if (mappingKey(examTrackId) !== "usmle step 1") return "";

  const target = STEP1_DIRECT_ALIASES[systemKey]
    || step1CompositeTarget(systemKey, mappingKey(subsystem));
  if (!target) return "";
  return candidates.find((candidate) => mappingKey(candidate) === mappingKey(target)) || "";
}
