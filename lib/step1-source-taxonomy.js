import crypto from "node:crypto";
import fs from "node:fs";

export const STEP1_SOURCE_TAXONOMY_ADAPTER = "step1_source_taxonomy_sba_v1";

const ledger = JSON.parse(fs.readFileSync(
  new URL("./aylamed-step1-taxonomy-import-ledger-v1.json", import.meta.url),
  "utf8",
));

const systemsById = new Map(
  ledger.systems.map((row) => [String(row.system_id), row]),
);
const subsystemsById = new Map(
  ledger.subsystems.map((row) => [String(row.subsystem_id), row]),
);
const topicsByNativeId = new Map(
  ledger.topics.map((row) => [Number(row.native_sys_id), row]),
);
const disciplinesByNativeId = new Map(
  ledger.disciplines.map((row) => [Number(row.native_sub_id), row]),
);

function cleanText(value = "") {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
}

function slug(value = "", fallback = "untitled") {
  const clean = cleanText(value).normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return clean || fallback;
}

function compactFingerprint(parts = []) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(parts.map((part) => cleanText(part).toLowerCase())))
    .digest("hex")
    .slice(0, 12);
}

export function resolveStep1SourceTaxonomy({
  nativeSysId,
  nativeSubId,
  title,
} = {}) {
  const systemId = Number(nativeSysId);
  const disciplineId = Number(nativeSubId);
  const cleanTitle = cleanText(title);
  const topic = topicsByNativeId.get(systemId);
  const system = topic ? systemsById.get(String(topic.system_id)) : null;
  const subsystem = topic ? subsystemsById.get(String(topic.subsystem_id)) : null;
  const discipline = disciplinesByNativeId.get(disciplineId);
  const errors = [];

  if (!Number.isInteger(systemId) || !topic) errors.push("taxonomy_topic_not_in_step1_ledger");
  if (!system) errors.push("taxonomy_system_not_in_step1_ledger");
  if (!subsystem || String(subsystem.system_id) !== String(topic?.system_id || "")) {
    errors.push("taxonomy_subsystem_not_in_step1_ledger");
  }
  if (!Number.isInteger(disciplineId) || !discipline) {
    errors.push("taxonomy_discipline_not_in_step1_ledger");
  }
  if (!cleanTitle) errors.push("taxonomy_subtopic_title_required");
  if (errors.length) return { taxonomy: null, errors: [...new Set(errors)] };

  const subtopicSlug = slug(cleanTitle);
  const subtopicFingerprint = compactFingerprint([systemId, cleanTitle]);
  const topicLabel = `${subsystem.subsystem_name} · Topic ${systemId}`;
  return {
    taxonomy: {
      system_key: String(system.system_id),
      subsystem_key: String(subsystem.subsystem_id),
      topic_key: String(topic.topic_id),
      subtopic_key: `subtopic:uw-sys-${systemId}:${subtopicSlug}:${subtopicFingerprint}`,
      labels: {
        system: cleanText(system.system_name),
        subsystem: cleanText(subsystem.subsystem_name),
        topic: topicLabel,
        subtopic: cleanTitle,
      },
      source: "step1_source_taxonomy_ledger",
      review_status: "private_draft_taxonomy_validated",
      ledger_schema_version: ledger.schema_version,
      ledger_fingerprint: ledger.source_fingerprint,
      native_sys_id: systemId,
      native_sub_id: disciplineId,
      discipline: cleanText(discipline.discipline),
      subtopic_title_fingerprint: subtopicFingerprint,
    },
    errors: [],
  };
}

export function step1SourceQuestionTaxonomy(question = {}) {
  return resolveStep1SourceTaxonomy({
    nativeSysId: question.sysId ?? question.native_sys_id ?? question.system_key,
    nativeSubId: question.subId ?? question.native_sub_id ?? question.subject_key,
    title: question.title,
  });
}

export function isStep1SourceTaxonomyQuestion(question = {}) {
  const nativeSysId = question.sysId ?? question.native_sys_id ?? question.system_key;
  const nativeSubId = question.subId ?? question.native_sub_id ?? question.subject_key;
  return cleanText(nativeSysId) !== "" && cleanText(nativeSubId) !== "";
}

export function step1SourceTaxonomyLedgerSummary() {
  return {
    schema_version: ledger.schema_version,
    source_schema_version: ledger.source_schema_version,
    source_fingerprint: ledger.source_fingerprint,
    hierarchy: ledger.hierarchy,
    systems: systemsById.size,
    subsystems: subsystemsById.size,
    topics: topicsByNativeId.size,
    disciplines: disciplinesByNativeId.size,
  };
}
