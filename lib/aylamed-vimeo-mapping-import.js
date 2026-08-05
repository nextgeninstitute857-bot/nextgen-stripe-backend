import crypto from "node:crypto";

export const AYLA_VIMEO_MAPPING_IMPORT_BUILD = "v1-validation-first-private-mapping-import";
export const AYLA_VIMEO_MAPPING_ALLOWED_FOLDER_IDS = new Set([
  "29973623", // Boards & Beyond (legacy reviewed import)
  "30014230", // Pathoma
  "30032209", // Pixorize Biochemistry
  "30032227", // Pixorize Immunology
  "30036714", // Pixorize Microbiology
  "30043950", // Pixorize Pharmacology
]);

const text = (value, limit = 300) => String(value ?? "").trim().slice(0, limit);
const key = (value) => text(value, 300).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function normalizedMapping(row = {}) {
  return {
    vimeoId: text(row.vimeo_id ?? row.vimeoId, 80),
    sourceFolderId: text(row.source_folder_id ?? row.sourceFolderId ?? row.folder_id ?? row.folderId, 80),
    sourceTitle: text(row.source_title ?? row.sourceTitle, 500),
    exam: text(row.proposed_exam ?? row.exam, 160),
    system: text(row.proposed_system ?? row.system, 180),
    subsystem: text(row.proposed_subsystem ?? row.subsystem, 240),
    topic: text(row.proposed_topic ?? row.topic, 240),
    subtopic: text(row.proposed_subtopic ?? row.subtopic, 240),
    confidencePercent: Number(row.confidence_percent ?? row.confidencePercent ?? 0),
    decision: text(row.decision, 80),
    productionAction: text(row.production_action ?? row.productionAction, 80),
  };
}

function fingerprint(rows) {
  return crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function validateAylaVimeoMappingImport({ mappings = [], drafts = [] } = {}) {
  const rows = Array.isArray(mappings) ? mappings.map(normalizedMapping) : [];
  const allDrafts = Array.isArray(drafts) ? drafts : Object.values(drafts || {});
  const declaredFolderIds = new Set(rows.map((row) => row.sourceFolderId).filter(Boolean));
  if (!declaredFolderIds.size) {
    for (const row of rows) {
      const draft = allDrafts.find((candidate) => text(candidate.vimeoId ?? candidate.vimeo_id, 80) === row.vimeoId);
      const folderId = text(draft?.folderId ?? draft?.folder_id, 80);
      if (folderId) declaredFolderIds.add(folderId);
    }
  }
  const catalogue = allDrafts.filter((row) => declaredFolderIds.has(text(row.folderId ?? row.folder_id, 80)));
  const catalogueByVimeoId = new Map(catalogue.map((row) => [text(row.vimeoId ?? row.vimeo_id, 80), row]));
  const expectedCount = catalogueByVimeoId.size;
  const seen = new Set();
  const errors = [];
  const warnings = [];

  for (const folderId of declaredFolderIds) {
    if (!AYLA_VIMEO_MAPPING_ALLOWED_FOLDER_IDS.has(folderId)) {
      errors.push(`Vimeo folder ${folderId} is not approved for mapping import`);
    }
  }

  if (!expectedCount) {
    errors.push("The production Vimeo catalogue is empty");
  }
  if (catalogue.length !== expectedCount) {
    errors.push("The production Vimeo catalogue contains duplicate Vimeo IDs");
  }
  if (rows.length !== expectedCount) {
    errors.push(`Expected exactly ${expectedCount} mappings for the current catalogue; received ${rows.length}`);
  }

  rows.forEach((row, index) => {
    const label = row.vimeoId || `row ${index + 1}`;
    if (!row.vimeoId) errors.push(`Row ${index + 1}: vimeo_id is required`);
    if (seen.has(row.vimeoId)) errors.push(`${label}: duplicate vimeo_id`);
    seen.add(row.vimeoId);
    const draft = catalogueByVimeoId.get(row.vimeoId);
    if (!draft) errors.push(`${label}: Vimeo ID is not present in the production catalogue`);
    const draftFolderId = text(draft?.folderId ?? draft?.folder_id, 80);
    if (row.sourceFolderId && draft && draftFolderId !== row.sourceFolderId) {
      errors.push(`${label}: source_folder_id does not match the production catalogue`);
    }
    if (draft && row.sourceTitle && text(draft.sourceTitle, 500) !== row.sourceTitle) {
      errors.push(`${label}: source title does not match the catalogue`);
    }
    for (const field of ["exam", "system", "subsystem", "topic", "subtopic"]) {
      if (!row[field]) errors.push(`${label}: ${field} is required`);
    }
    if (!Number.isFinite(row.confidencePercent) || row.confidencePercent < 0 || row.confidencePercent > 100) {
      errors.push(`${label}: confidence_percent must be between 0 and 100`);
    }
    if (row.decision && row.decision !== "reviewed_offline") warnings.push(`${label}: decision is not reviewed_offline`);
    if (row.productionAction && row.productionAction !== "none") errors.push(`${label}: production_action must remain none`);
  });

  const catalogueIds = new Set(catalogueByVimeoId.keys());
  const missingCatalogueIds = [...catalogueIds].filter((id) => !seen.has(id));
  if (missingCatalogueIds.length) errors.push(`${missingCatalogueIds.length} catalogue Vimeo IDs are missing from the import`);

  return {
    build: AYLA_VIMEO_MAPPING_IMPORT_BUILD,
    valid: errors.length === 0,
    dry_run: true,
    expected_count: expectedCount,
    mapping_count: rows.length,
    unique_vimeo_ids: seen.size,
    matched_catalogue_ids: rows.filter((row) => catalogueByVimeoId.has(row.vimeoId)).length,
    folder_ids: [...declaredFolderIds].sort(),
    errors,
    warnings,
    fingerprint: fingerprint(rows),
    normalized_mappings: rows,
    safeguards: {
      preserves_status: true,
      preserves_review_status: true,
      preserves_approval: true,
      preserves_privacy: true,
      creates_active_resources: false,
      starts_classifier_jobs: false,
    },
  };
}

export function applyAylaVimeoMappings(drafts = [], validation, { actor = {}, now = new Date() } = {}) {
  if (!validation?.valid) throw Object.assign(new Error("A successful dry-run validation is required"), { statusCode: 400 });
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const byVimeoId = new Map(validation.normalized_mappings.map((row) => [row.vimeoId, row]));
  let updated = 0;
  const next = drafts.map((draft) => {
    const mapping = byVimeoId.get(text(draft.vimeoId ?? draft.vimeo_id, 80));
    if (!mapping) return draft;
    updated += 1;
    return {
      ...draft,
      seedMapping: {
        ...(draft.seedMapping || {}),
        system: mapping.system,
        subsystem: mapping.subsystem,
        topic: mapping.topic,
        subtopic: mapping.subtopic,
      },
      classification: {
        ...(draft.classification || {}),
        medicalSystem: mapping.system,
        medicalSubsystem: mapping.subsystem,
        canonicalTopic: mapping.topic,
        subtopic: mapping.subtopic,
        qbankTopic: {
          ...(draft.classification?.qbankTopic || {}),
          systemKey: key(mapping.system),
          subsystemKey: key(mapping.subsystem),
          topicKey: key(mapping.topic),
          subtopicKey: key(mapping.subtopic),
        },
        confidencePercent: mapping.confidencePercent,
        approvalReadiness: "ready_for_owner_approval",
        classificationReason: "Owner-reviewed offline B&B catalogue mapping import",
        importedMappingFingerprint: validation.fingerprint,
        importedMappingAt: timestamp,
        importedMappingBy: { id: text(actor.id, 160), email: text(actor.email, 240), name: text(actor.name, 240) },
      },
      mappingImport: {
        build: AYLA_VIMEO_MAPPING_IMPORT_BUILD,
        fingerprint: validation.fingerprint,
        importedAt: timestamp,
      },
      revision: Math.max(0, Number(draft.revision || 0)) + 1,
      updatedAt: timestamp,
    };
  });
  return { drafts: next, updated, fingerprint: validation.fingerprint };
}
