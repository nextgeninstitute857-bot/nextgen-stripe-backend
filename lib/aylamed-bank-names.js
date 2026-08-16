function text(value = "") {
  return String(value ?? "").trim();
}

export function aylaStudentBankName(bank = {}, { examTrack = "", supplemental = false } = {}) {
  const supplied = text(bank.name || bank.title || bank.bank_name || bank.collection_key || "Question Bank");
  const identity = [
    supplied,
    bank.collection_key,
    bank.source_provider,
    bank.source_profile,
    examTrack,
  ].filter(Boolean).join(" ").toLowerCase();

  if (/\bamboss\b/.test(identity)) return "AMBOSS";
  if (/canada\s*qbank|canadaqbank|\bcqb\b/.test(identity)) return "CanadaQBank";
  if (/\bace\b[\s_-]*qbank|aceqbank/.test(identity)) return "ACE QBank";
  if (/\bamedex\b/.test(identity)) return "Amedex";
  if (/m\s*\+\s*x|mplusx/.test(identity)) return "MPlusX";
  if (/bmj[\s_-]*(?:on)?examination|onexamination/.test(identity)) return "BMJ OnExamination";
  if (/pass[\s_-]*medicine|passmedicine/.test(identity)) return "PassMedicine";
  if (/board[\s_-]*vitals|boardvitals/.test(identity)) {
    if (/nclex[\s_-]*pn|\bpn\b/.test(identity)) return "BoardVitals NCLEX-PN";
    if (/nclex[\s_-]*rn|\brn\b/.test(identity)) return "BoardVitals NCLEX-RN";
    return "BoardVitals";
  }
  if (/\buworld\b|u[\s_-]*world/.test(identity)) {
    if (supplemental || /step[\s_-]*2|step2/.test(identity)) return "UWorld Step 2 CK";
    if (/nclex[\s_-]*pn|\bpn\b/.test(identity)) return "UWorld NCLEX-PN";
    if (/nclex[\s_-]*rn|\brn\b/.test(identity)) return "UWorld NCLEX-RN";
    return "UWorld";
  }

  const beforeRawSuffix = supplied.split(/\s*:\s*(?=[a-z0-9][a-z0-9_.-]*(?:\s|$))/i)[0].trim();
  return beforeRawSuffix
    .replace(/\.(?:zip|json|csv|db)$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "Question Bank";
}
