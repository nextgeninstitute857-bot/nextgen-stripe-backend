const key = (value = "") => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const examKey = (value = "") => {
  const normalized = key(value).replace(/ /g, "_");
  const aliases = {
    usmle_step_2: "usmle_step_2_ck",
    usmle_step_2_ck: "usmle_step_2_ck",
    usmle_step_3: "usmle_step_3",
    mccqe_1: "mccqe",
    mccqe_part_1: "mccqe",
    nclex_rn: "nclex",
  };
  return aliases[normalized] || normalized;
};

function targetForClinicalExam(exam, systemKey, subsystemKey) {
  const combined = `${systemKey} ${subsystemKey}`;
  const ethics = /ethic|communication|professional|legal|patient safety|biostat/.test(combined);
  const preventive = /prevent|population|public health|screen|health promotion/.test(combined);
  const emergency = /emergency|acute care|trauma|poison|toxic|resuscitat/.test(combined);
  const obstetrics = /obstet|gynae|gyne|female reproductive|pregnan|childbirth|puerper|women s health/.test(combined);
  const pediatrics = /paediatr|pediatr|child health|child and adolescent/.test(combined);
  const psychiatry = /psychiatr|mental health|behavioural health|behavioral health/.test(combined);
  const surgery = /surgery|surgical|perioperative/.test(combined);
  const family = /family medicine|general practice|primary care/.test(combined);

  if (exam === "mccqe") {
    if (systemKey === "internal and family medicine" || /canadian clinical practice/.test(systemKey)) return "Family Medicine";
    if (pediatrics) return "Pediatrics";
    if (obstetrics) return "Obstetrics and Gynecology";
    if (psychiatry) return "Psychiatry";
    if (surgery) return "Surgery";
    if (emergency) return "Emergency Medicine";
    if (preventive) return "Preventive Care";
    if (ethics) return "Ethics and Communication";
    if (family) return "Family Medicine";
    return "Internal Medicine";
  }

  if (exam === "usmle_step_2_ck" || exam === "usmle_step_3") {
    if (pediatrics) return "Pediatrics";
    if (obstetrics) return "Obstetrics and Gynecology";
    if (psychiatry) return "Psychiatry";
    if (surgery) return "Surgery";
    if (emergency) return "Emergency Medicine";
    if (family) return "Family Medicine";
    if (preventive) return "Preventive Medicine";
    if (ethics) return exam === "usmle_step_3" ? "Biostatistics and Ethics" : "Ethics and Biostatistics";
    if (exam === "usmle_step_3" && /computer based case|case simulation|ccs/.test(combined)) return "Computer-based Case Simulations";
    return "Internal Medicine";
  }

  if (exam === "plab") {
    if (pediatrics) return "Pediatrics";
    if (obstetrics) return "Obstetrics and Gynecology";
    if (psychiatry) return "Psychiatry";
    if (surgery) return "Surgery";
    if (emergency) return "Emergency Medicine";
    if (/patient safety/.test(combined)) return "Patient Safety";
    if (/communication/.test(combined)) return "Communication Skills";
    if (ethics) return "Clinical Ethics";
    if (family) return "General Practice";
    if (/guideline|nice|uk clinical/.test(combined)) return "UK Clinical Guidelines";
    return "Medicine";
  }

  if (exam === "amc") {
    if (pediatrics) return "Child Health";
    if (obstetrics) return "Women's Health";
    if (psychiatry) return "Mental Health";
    if (surgery) return "Surgery";
    if (preventive) return "Population Health";
    if (ethics) return "Ethics";
    if (/aboriginal|torres strait|rural remote/.test(combined)) return "Australian Clinical Practice";
    return "Medicine";
  }

  return "";
}

function targetForNclex(systemKey, subsystemKey) {
  const combined = `${systemKey} ${subsystemKey}`;
  if (/management of care/.test(combined)) return "Management of Care";
  if (/safety and infection/.test(combined)) return "Safety and Infection Control";
  if (/health promotion/.test(combined)) return "Health Promotion and Maintenance";
  if (/psychosocial/.test(combined)) return "Psychosocial Integrity";
  if (/basic care|comfort/.test(combined)) return "Basic Care and Comfort";
  if (/pharmacolog|parenteral therap/.test(combined)) return "Pharmacological Therapies";
  if (/reduction of risk|risk potential/.test(combined)) return "Reduction of Risk Potential";
  if (/physiological adaptation/.test(combined)) return "Physiological Adaptation";
  if (/prioritization|prioritisation|delegation/.test(combined)) return "Prioritization and Delegation";
  return "";
}

export function canonicalAylaAdaptiveSystem({
  examTrackId = "",
  system = "",
  subsystem = "",
  allowedSystems = [],
} = {}) {
  const allowed = Array.isArray(allowedSystems) ? allowedSystems : [];
  const rawParts = String(system || "").split(":").filter(Boolean);
  const source = rawParts.length > 1 ? rawParts[1].replace(/_/g, " ") : system;
  const sourceKey = key(source);
  const subsystemKey = key(subsystem);
  const exact = allowed.find((candidate) => key(candidate) === sourceKey);
  if (exact) return exact;
  const exam = examKey(examTrackId);
  const target = exam === "nclex"
    ? targetForNclex(sourceKey, subsystemKey)
    : targetForClinicalExam(exam, sourceKey, subsystemKey);
  return allowed.find((candidate) => key(candidate) === key(target)) || "";
}

