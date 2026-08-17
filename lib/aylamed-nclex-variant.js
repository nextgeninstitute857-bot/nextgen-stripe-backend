export const AYLA_NCLEX_VARIANTS = Object.freeze([
  Object.freeze({ key: "nclex_rn", code: "rn", label: "NCLEX-RN" }),
  Object.freeze({ key: "nclex_pn", code: "pn", label: "NCLEX-PN" }),
]);

const VARIANT_BY_KEY = new Map(AYLA_NCLEX_VARIANTS.map((variant) => [variant.key, variant]));

function clean(value = "") {
  return String(value ?? "").trim().toLowerCase();
}

export function isAylaNclexExamTrack(value = "") {
  const normalized = clean(value).replace(/[^a-z0-9]+/g, "");
  return normalized === "nclex" || normalized === "nclexrn" || normalized === "nclexpn";
}

export function normalizeAylaNclexVariant(value = "") {
  const normalized = clean(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["rn", "nclex_rn", "registered_nurse", "registered_nursing"].includes(normalized)) return "nclex_rn";
  if (["pn", "nclex_pn", "practical_nurse", "practical_nursing", "lpn", "lvn"].includes(normalized)) return "nclex_pn";
  return "";
}

export function aylaNclexVariantCode(value = "") {
  return VARIANT_BY_KEY.get(normalizeAylaNclexVariant(value))?.code || "";
}

export function aylaNclexVariantLabel(value = "") {
  return VARIANT_BY_KEY.get(normalizeAylaNclexVariant(value))?.label || "NCLEX";
}

export function aylaStudentNclexVariant(student = {}) {
  return normalizeAylaNclexVariant(
    student.examVariant
      || student.exam_variant
      || student.nclexType
      || student.nclex_type
      || student.programVariant
      || student.program_variant,
  );
}

export function aylaNclexBankVariant(bank = {}) {
  const explicit = normalizeAylaNclexVariant(
    bank.nclex_variant || bank.nclexVariant || bank.exam_variant || bank.examVariant,
  );
  if (explicit) return explicit;

  const identity = [
    bank.name,
    bank.bank_name,
    bank.title,
    bank.collection_key,
    bank.source_namespace,
    bank.source_provider,
    bank.source_profile,
  ].filter(Boolean).join(" ").toLowerCase().replace(/[_-]+/g, " ");
  if (/\bnclex\s*pn\b/.test(identity) || (/\bnclex\b/.test(identity) && /\b(?:pn|lpn|lvn)\b/.test(identity))) return "nclex_pn";
  if (/\bnclex\s*rn\b/.test(identity) || (/\bnclex\b/.test(identity) && /\brn\b/.test(identity))) return "nclex_rn";
  return "";
}

export function requireAylaNclexVariant(student = {}, examTrack = "nclex") {
  if (!isAylaNclexExamTrack(examTrack)) return "";
  const variant = aylaStudentNclexVariant(student);
  if (variant) return variant;
  const error = new Error("Choose NCLEX-RN or NCLEX-PN in Profile & plan before opening NCLEX learning content");
  error.statusCode = 409;
  error.code = "NCLEX_VARIANT_REQUIRED";
  error.details = { code: error.code, profile_action_required: true, allowed_variants: AYLA_NCLEX_VARIANTS };
  throw error;
}

export function filterAylaNclexBanksForStudent(banks = [], student = {}, examTrack = "") {
  if (!isAylaNclexExamTrack(examTrack)) return [...banks];
  const variant = requireAylaNclexVariant(student, examTrack);
  return banks
    .filter((bank) => aylaNclexBankVariant(bank) === variant)
    .map((bank) => ({ ...bank, nclex_variant: variant }));
}

export function assertAylaNclexSessionVariant(student = {}, session = {}) {
  if (!isAylaNclexExamTrack(session.examTrack || session.exam_track || student.examTrackId || student.exam)) return "";
  const studentVariant = requireAylaNclexVariant(student, "nclex");
  const sessionVariant = normalizeAylaNclexVariant(session.nclexVariant || session.nclex_variant || session.examVariant || session.exam_variant);
  if (!sessionVariant) {
    const error = new Error("This earlier NCLEX session predates RN/PN separation. Start a new session from your isolated dashboard.");
    error.statusCode = 409;
    error.code = "LEGACY_NCLEX_SESSION_RESTART_REQUIRED";
    error.details = { code: error.code, restart_required: true };
    throw error;
  }
  if (sessionVariant !== studentVariant) {
    const error = new Error("This NCLEX session belongs to a different nursing program");
    error.statusCode = 403;
    error.code = "NCLEX_VARIANT_MISMATCH";
    error.details = { code: error.code };
    throw error;
  }
  return studentVariant;
}
