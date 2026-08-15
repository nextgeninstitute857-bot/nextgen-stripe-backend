import crypto from "node:crypto";

export const MULTI_EXAM_SOURCE_TAXONOMY_ADAPTER = "multi_exam_source_taxonomy_v1";

const DISCIPLINES = Object.freeze({
  102: "Medicine",
  103: "Obstetrics and Gynaecology",
  104: "Paediatrics",
  105: "Psychiatry",
  106: "Surgery",
});

const STEP3_SYSTEMS = Object.freeze({
  1000: "Allergy and Immunology",
  1001: "Biostatistics and Epidemiology",
  1002: "Cardiovascular",
  1003: "Dermatology",
  1004: "Ear, Nose and Throat",
  1005: "Endocrine",
  1006: "Female Reproductive and Breast",
  1007: "Gastrointestinal",
  1008: "General Principles and Preventive Care",
  1009: "Haematology and Oncology",
  1010: "Infectious Diseases",
  1011: "Male Reproductive",
  1012: "Multisystem and General Medicine",
  1013: "Neurology",
  1014: "Ophthalmology",
  1015: "Poisoning and Environmental Medicine",
  1016: "Pregnancy, Childbirth and Puerperium",
  1017: "Psychiatry",
  1018: "Pulmonary",
  1019: "Renal and Urinary",
  1020: "Rheumatology and Orthopaedics",
  1021: "Ethics, Communication and Patient Safety",
});

// AMBOSS exports use a compact provider-wide 1-18 system ledger across the
// USMLE banks. These labels were verified against the local Step 1/2/3 source
// corpora; subId is a multi-value provider tag list, not a discipline ID.
const AMBOSS_SYSTEMS = Object.freeze({
  1: "Psychiatry",
  2: "Biostatistics and Epidemiology",
  3: "Haematology and Oncology",
  4: "Cardiovascular",
  5: "Endocrine",
  6: "Female Reproductive and Breast",
  7: "Gastrointestinal",
  8: "General Principles and Preventive Care",
  9: "Infectious Diseases and Immunology",
  10: "Male Reproductive",
  11: "Multisystem and General Medicine",
  12: "Rheumatology and Orthopaedics",
  13: "Neurology",
  14: "Pregnancy, Childbirth and Puerperium",
  15: "Renal and Urinary",
  16: "Pulmonary and Ear, Nose and Throat",
  17: "Dermatology",
  18: "Ethics, Communication and Patient Safety",
});

const STEP2_SYSTEM_RANGES = Object.freeze([
  [1000, 1004, "Allergy and Immunology"],
  [1005, 1009, "Biostatistics and Epidemiology"],
  [1010, 1019, "Cardiovascular"],
  [1020, 1025, "Dermatology"],
  [1026, 1026, "Ear, Nose and Throat"],
  [1027, 1035, "Endocrine"],
  [1036, 1042, "Female Reproductive and Breast"],
  [1043, 1052, "Gastrointestinal"],
  [1053, 1053, "Emergency, Trauma and General Care"],
  [1054, 1061, "Haematology and Oncology"],
  [1062, 1069, "Infectious Diseases"],
  [1070, 1070, "Male Reproductive"],
  [1071, 1071, "Genetics and Multisystem"],
  [1072, 1087, "Neurology"],
  [1088, 1088, "Ophthalmology"],
  [1089, 1090, "Poisoning and Environmental Medicine"],
  [1091, 1092, "Pregnancy, Childbirth and Puerperium"],
  [1093, 1102, "Psychiatry"],
  [1103, 1112, "Pulmonary"],
  [1113, 1123, "Renal and Urinary"],
  [1124, 1131, "Rheumatology and Orthopaedics"],
  [1132, 1137, "Ethics, Communication and Patient Safety"],
]);

const AMEDEX_SYSTEMS = Object.freeze({
  217: "Dermatology", 218: "Ophthalmology", 219: "Neurology",
  220: "Musculoskeletal and Rheumatology", 221: "Cardiovascular",
  223: "Respiratory", 224: "Gastrointestinal", 225: "Endocrine and Breast",
  227: "Women's Health and Obstetrics/Gynaecology", 228: "Haematology",
  229: "Urology and Men's Health", 230: "Mental Health", 231: "Child Health",
  232: "Nutrition and Metabolic Medicine", 233: "Infectious Diseases",
  234: "Pharmacology", 235: "Oncology", 236: "Transplant Medicine",
  237: "Emergency and Trauma", 249: "Preventive and Population Health",
  1633: "Ethics and Communication",
});

const MPLUSX_SYSTEMS = Object.freeze({
  3: "Child Health", 4: "Musculoskeletal and Rheumatology", 5: "Mental Health",
  9: "Ethics and Communication", 10: "Biostatistics and Epidemiology",
  11: "Ophthalmology", 24: "Renal, Urology and Men's Health",
  25: "Preventive and Population Health", 26: "Obstetrics",
  27: "Gynaecology and Women's Health", 28: "Haematology", 29: "Dermatology",
  31: "Emergency and Trauma", 32: "Endocrine", 33: "Infectious Diseases",
  35: "Neurology", 36: "Vascular Medicine", 37: "Rheumatology",
  38: "Ear, Nose and Throat", 39: "Cardiovascular", 41: "Respiratory",
  42: "Gastrointestinal", 43: "General Medicine and Toxicology", 44: "Breast",
  45: "Oncology", 1000: "Mixed Clinical Practice",
});

const MCCQE_CANADAQBANK_DISCIPLINES = Object.freeze({
  203: "Internal and Family Medicine",
  204: "Paediatrics",
  205: "Obstetrics and Gynaecology",
  206: "Psychiatry and Behavioural Health",
  207: "Surgery and Perioperative Care",
  208: "Preventive Care, Ethics and Communication",
});

const MCCQE_ACE_DISCIPLINES = Object.freeze({
  1: "Cardiovascular", 2: "Respiratory", 3: "Gastrointestinal",
  4: "Endocrine and Metabolic", 5: "Renal and Urinary",
  6: "Rheumatology", 7: "Neurology", 8: "Dermatology",
  9: "Urology and Men's Health", 10: "Haematology", 11: "Infectious Diseases",
  12: "Ophthalmology", 13: "Musculoskeletal and Orthopaedics",
  15: "Ear, Nose and Throat", 16: "Ethics, Law and Communication",
  17: "Obstetrics and Gynaecology", 18: "Paediatrics",
  19: "Psychiatry and Geriatric Care", 20: "Surgery",
  21: "Emergency Medicine and Toxicology", 22: "Population Health and Biostatistics",
  23: "Family Medicine and Mixed Clinical Practice",
});

const EXAM_LABELS = Object.freeze({
  "usmle-step-1": "USMLE Step 1",
  "usmle-step-2": "USMLE Step 2 CK",
  "usmle-step-3": "USMLE Step 3",
  amc: "AMC",
  mccqe: "MCCQE",
  nclex: "NCLEX",
  plab: "PLAB",
});

function clean(value = "", maximum = 500) {
  return String(value ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function key(value = "", fallback = "general") {
  const result = clean(value, 240).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  return result || fallback;
}

function normalizedExam(value = "") {
  const valueKey = key(value).replace(/_/g, "-");
  const aliases = {
    "usmle-step-1": "usmle-step-1",
    "usmle-step-2-ck": "usmle-step-2", "usmle-step-2": "usmle-step-2",
    "usmle-step-3": "usmle-step-3", mccqe1: "mccqe", "mccqe-part-i": "mccqe",
    "mccqe-part-1": "mccqe", "nclex-rn": "nclex",
  };
  return aliases[valueKey] || valueKey;
}

function step2System(nativeId) {
  const id = Number(nativeId);
  return STEP2_SYSTEM_RANGES.find(([from, to]) => id >= from && id <= to)?.[2] || "Mixed Clinical Practice";
}

function clinicalTask(question = {}) {
  const text = clean(`${question.lead_in || question.leadIn || ""} ${question.question || question.stem || ""}`, 5000).toLowerCase();
  if (/ethic|confidential|consent|communicat|professional|legal|disclos|capacity/.test(text)) return "Communication, Ethics and Professionalism";
  if (/prevent|screen|vaccin|prophyl|risk factor|health maintenance/.test(text)) return "Prevention and Health Promotion";
  if (/prognos|complication|natural history|most likely outcome/.test(text)) return "Prognosis and Complications";
  if (/drug|medication|pharmac|antibiotic|adverse effect|mechanism of action/.test(text)) return "Pharmacotherapy";
  if (/next best step|management|treatment|intervention|initial step|most appropriate action/.test(text)) return "Management";
  if (/test|investigation|laboratory|imaging|confirm|workup/.test(text)) return "Investigation and Interpretation";
  if (/diagnos|most likely cause|underlying|pathophysiolog/.test(text)) return "Diagnosis and Mechanism";
  return "Clinical Reasoning";
}

function dimensionOfCare(question = {}) {
  const text = clean(`${question.title || ""} ${question.question || question.stem || ""}`, 5000).toLowerCase();
  if (/ethic|confidential|consent|communicat|professional|legal|maid|capacity|indigenous/.test(text)) return "Psychosocial Aspects and Communication";
  if (/prevent|screen|vaccin|prophyl|population|biostat|risk reduction|health maintenance/.test(text)) return "Health Promotion and Illness Prevention";
  if (/emergency|acute|resuscitat|unstable|trauma|poison|toxicity|arrest/.test(text)) return "Acute Care";
  if (/chronic|follow-up|long-term|rehabil|palliative|frail|geriatric/.test(text)) return "Chronic Care";
  return "Assessment and Management";
}

function patientGroup(question = {}) {
  const text = clean(question.question || question.stem || "", 5000).toLowerCase();
  if (/aboriginal|torres strait|indigenous australian/.test(text)) return "Aboriginal and Torres Strait Islander Health";
  if (/pregnan|gestation|postpartum|puerper/.test(text)) return "Pregnancy and Postpartum";
  const age = Number(text.match(/\b(\d{1,3})-year-old/)?.[1]);
  if (/newborn|neonat|infant|child|boy|girl|adolescent/.test(text) || (age >= 0 && age <= 18)) return "Child and Adolescent Health";
  if (/older adult|elderly/.test(text) || age >= 65) return "Older Adult Health";
  return "Adult and General Population";
}

function sourceProvider(context = {}) {
  return clean(`${context.sourceProvider || ""} ${context.sourceNamespace || ""} ${context.collectionKey || ""}`).toLowerCase();
}

function isAmbossSource(context = {}) {
  return /amboss/.test(sourceProvider(context));
}

function systemLabel(exam, question, context) {
  const nativeId = Number(question.sysId ?? question.native_sys_id ?? question.system_key);
  if (isAmbossSource(context)) return AMBOSS_SYSTEMS[nativeId] || "Multisystem and General Medicine";
  if (exam === "usmle-step-2") return step2System(nativeId);
  if (exam === "usmle-step-3") return STEP3_SYSTEMS[nativeId] || "Multisystem and General Medicine";
  if (exam === "amc") {
    const provider = sourceProvider(context);
    return (/amedex/.test(provider) ? AMEDEX_SYSTEMS[nativeId] : MPLUSX_SYSTEMS[nativeId])
      || AMEDEX_SYSTEMS[nativeId] || MPLUSX_SYSTEMS[nativeId] || "Mixed Clinical Practice";
  }
  if (exam === "mccqe") {
    const provider = sourceProvider(context);
    const nativeSubId = Number(question.subId ?? question.native_sub_id ?? question.subject_key);
    if (/canada\s*qbank|canadaqbank|cqb/.test(provider)) {
      return MCCQE_CANADAQBANK_DISCIPLINES[nativeSubId] || "Canadian Clinical Practice";
    }
    if (/ace/.test(provider)) {
      return MCCQE_ACE_DISCIPLINES[nativeSubId]
        || (nativeSubId === 0 ? "Clinical Decision-Making Cases" : "Canadian Clinical Practice");
    }
    return MCCQE_ACE_DISCIPLINES[nativeSubId]
      || MCCQE_CANADAQBANK_DISCIPLINES[nativeSubId]
      || "Canadian Clinical Practice";
  }
  return clean(question.system || question.system_name || question.category || question.domain)
    || `${EXAM_LABELS[exam] || "Exam"} Clinical Practice`;
}

function subsystemLabel(exam, question) {
  const nativeSubId = Number(question.subId ?? question.native_sub_id ?? question.subject_key);
  if (exam === "usmle-step-2" || exam === "usmle-step-3") return DISCIPLINES[nativeSubId] || "General Clinical Practice";
  if (exam === "amc") return patientGroup(question);
  if (exam === "mccqe") return clean(question.dimension_of_care || question.dimensionOfCare || question.subsystem) || dimensionOfCare(question);
  if (exam === "nclex") return clean(question.client_need || question.clientNeed || question.subsystem) || "Client Needs";
  if (exam === "plab") return clean(question.capability || question.presentation || question.subsystem) || "Clinical Capability";
  return "General Clinical Practice";
}

function ambossTaxonomy(exam, question, context) {
  const nativeSysId = clean(question.sysId ?? question.native_sys_id ?? question.system_key);
  const nativeSubId = clean(question.subId ?? question.native_sub_id ?? question.subject_key);
  const primarySystemId = Number(nativeSysId.split(",")[0]);
  const system = AMBOSS_SYSTEMS[primarySystemId] || "Multisystem and General Medicine";
  const subsystem = `${system} Clinical Practice`;
  const topic = clinicalTask(question);
  const subtopic = `${system} Core Concepts`;
  const sourceFingerprint = fingerprint([exam, "amboss", nativeSysId, nativeSubId, topic]);
  return {
    taxonomy: {
      system_key: `${key(exam)}:${key(system)}`,
      subsystem_key: `${key(exam)}:${key(system)}:clinical_practice`,
      topic_key: `${key(exam)}:${key(system)}:${key(topic)}`,
      subtopic_key: `${key(exam)}:${key(system)}:${key(topic)}:core_concepts`,
      labels: { system, subsystem, topic, subtopic },
      source: MULTI_EXAM_SOURCE_TAXONOMY_ADAPTER,
      review_status: "source_evidence_verified_mapping",
      exam_track: exam,
      native_sys_id: nativeSysId,
      native_sub_id: nativeSubId,
      provider_tag_ids: nativeSubId.split(",").map((value) => value.trim()).filter(Boolean),
      clinical_task: topic,
      source_fingerprint: sourceFingerprint,
    },
    errors: AMBOSS_SYSTEMS[primarySystemId] ? [] : ["amboss_system_not_in_verified_map"],
  };
}

function topicLabel(question, system) {
  const title = clean(question.title || question.topic || question.topic_name, 240)
    .replace(/^\s*question\s*[-:#]?\s*\d+\s*[-.:)]\s*/i, "")
    .replace(/^\s*\d{1,6}\s*[-.:)]\s*/, "")
    .replace(/^question\s*[-:#]?\s*\d+$/i, "");
  const cdm = clean(question.title).match(/case\s*(\d+)/i);
  const firstSentence = clean(question.question || question.stem, 500)
    .split(/(?<=[.!?])\s+/)[0]
    .replace(/^\s*(?:a|an|the)\s+/i, "")
    .slice(0, 180);
  return title && !/^case\s*\d+\s*-?\s*question\s*\d+$/i.test(title)
    ? title
    : cdm ? `Clinical Decision-Making Case ${cdm[1]}`
      : firstSentence || `${system} Core Concepts`;
}

function fingerprint(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 12);
}

export function multiExamSourceQuestionTaxonomy(question = {}, context = {}) {
  const exam = normalizedExam(context.examTrack || context.exam_track || question.examTrack || question.exam);
  if (!Object.hasOwn(EXAM_LABELS, exam)) return { taxonomy: null, errors: [] };
  if (isAmbossSource(context)) return ambossTaxonomy(exam, question, context);
  const nativeSysId = clean(question.sysId ?? question.native_sys_id ?? question.system_key);
  const nativeSubId = clean(question.subId ?? question.native_sub_id ?? question.subject_key);
  const system = systemLabel(exam, question, context);
  const subsystem = subsystemLabel(exam, question);
  const topic = topicLabel(question, system);
  const subtopic = clinicalTask(question);
  const sourceFingerprint = fingerprint([exam, sourceProvider(context), nativeSysId, nativeSubId, topic, subtopic]);
  return {
    taxonomy: {
      system_key: `${key(exam)}:${key(system)}`,
      subsystem_key: `${key(exam)}:${key(system)}:${key(subsystem)}`,
      topic_key: `${key(exam)}:${key(system)}:${key(topic)}`,
      subtopic_key: `${key(exam)}:${key(system)}:${key(topic)}:${key(subtopic)}`,
      labels: { system, subsystem, topic, subtopic },
      source: MULTI_EXAM_SOURCE_TAXONOMY_ADAPTER,
      review_status: "private_draft_taxonomy_validated",
      exam_track: exam,
      native_sys_id: nativeSysId,
      native_sub_id: nativeSubId,
      clinical_task: subtopic,
      source_fingerprint: sourceFingerprint,
    },
    errors: [],
  };
}

export function isMultiExamSourceTaxonomyQuestion(question = {}, context = {}) {
  const exam = normalizedExam(context.examTrack || context.exam_track || question.examTrack || question.exam);
  return Object.hasOwn(EXAM_LABELS, exam)
    && (exam !== "usmle-step-1" || isAmbossSource(context));
}

export function multiExamSourceTaxonomySummary() {
  return {
    adapter: MULTI_EXAM_SOURCE_TAXONOMY_ADAPTER,
    exams: Object.keys(EXAM_LABELS),
    amboss_systems: Object.keys(AMBOSS_SYSTEMS).length,
    step2_system_ranges: STEP2_SYSTEM_RANGES.length,
    step3_systems: Object.keys(STEP3_SYSTEMS).length,
    amedex_systems: Object.keys(AMEDEX_SYSTEMS).length,
    mplusx_systems: Object.keys(MPLUSX_SYSTEMS).length,
    mccqe_canadaqbank_disciplines: Object.keys(MCCQE_CANADAQBANK_DISCIPLINES).length,
    mccqe_ace_disciplines: Object.keys(MCCQE_ACE_DISCIPLINES).length,
    hierarchy: ["system", "subsystem", "topic", "subtopic"],
  };
}
