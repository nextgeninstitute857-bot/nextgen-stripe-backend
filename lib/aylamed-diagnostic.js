const STEP_1_SYSTEMS = Object.freeze([
  "Cardiovascular",
  "Renal",
  "Respiratory",
  "Gastrointestinal",
  "Neurology",
  "Endocrine",
  "Reproductive",
  "Hematology",
  "Immunology",
  "Musculoskeletal",
  "Behavioral Science",
  "Biochemistry",
  "Pharmacology",
  "Microbiology",
  "Biostatistics and Ethics",
]);

export const AYLA_DIAGNOSTIC_BLUEPRINT_VERSION = 3;
export const AYLA_STEP_1_DIAGNOSTIC_SYSTEMS = STEP_1_SYSTEMS;

const SYSTEM_ALIASES = new Map([
  ["cardiovascular", "Cardiovascular"],
  ["cardiology", "Cardiovascular"],
  ["renal", "Renal"],
  ["nephrology", "Renal"],
  ["respiratory", "Respiratory"],
  ["pulmonology", "Respiratory"],
  ["gastrointestinal", "Gastrointestinal"],
  ["gastroenterology", "Gastrointestinal"],
  ["neurology", "Neurology"],
  ["neuroscience", "Neurology"],
  ["endocrine", "Endocrine"],
  ["endocrinology", "Endocrine"],
  ["reproductive", "Reproductive"],
  ["reproductive medicine", "Reproductive"],
  ["hematology", "Hematology"],
  ["haematology", "Hematology"],
  ["immunology", "Immunology"],
  ["musculoskeletal", "Musculoskeletal"],
  ["orthopedics", "Musculoskeletal"],
  ["orthopaedics", "Musculoskeletal"],
  ["behavioral science", "Behavioral Science"],
  ["behavioural science", "Behavioral Science"],
  ["psychiatry", "Behavioral Science"],
  ["biochemistry", "Biochemistry"],
  ["genetics", "Biochemistry"],
  ["pharmacology", "Pharmacology"],
  ["microbiology", "Microbiology"],
  ["biostatistics and ethics", "Biostatistics and Ethics"],
  ["biostatistics", "Biostatistics and Ethics"],
  ["ethics", "Biostatistics and Ethics"],
]);

const TITLE_RULES = Object.freeze([
  {
    system: "Renal",
    pattern: /\b(?:gfr|fsgs|renal|kidney|nephro|glomerul|diabetic kidney|acid[- ]base|electrolyte)\b/i,
  },
  {
    system: "Hematology",
    pattern: /\b(?:g6pd|hemat|haemat|anemi|hemoglobin|coagul|platelet|leukem|lymphom|myeloprolif)\b/i,
  },
  {
    system: "Reproductive",
    pattern: /\b(?:postpartum|endometritis|endometriosis|uter(?:us|ine)|ovari|prostat\w*|reproduct|pregnan|gestation|placent|testicul|varicocele)\b/i,
  },
  {
    system: "Musculoskeletal",
    pattern: /\b(?:osteoarthritis|paget'?s disease of bone|septic arthritis|arthritis|musculoskeletal|orthop|bone|joint|callosit\w*|corns?)\b/i,
  },
  {
    system: "Microbiology",
    pattern: /\b(?:bacterial gene transfer|escherichia coli|e\.?\s*coli|microbiol|bacteri|viral|virus|fung|parasite|mycobacter|infection)\b/i,
  },
  {
    system: "Immunology",
    pattern: /\b(?:digeorge|cytokines?|immun|hypersens|complement|transplant rejection)\b/i,
  },
  {
    system: "Respiratory",
    pattern: /\b(?:interstitial lung|asthma|sinusitis|respirat|pulmon|lung|copd|pneum)\b/i,
  },
  {
    system: "Gastrointestinal",
    pattern: /\b(?:inflammatory bowel|peptic ulcer|gastro|intestinal|bowel|hepatic|liver|biliary|pancrea|colon|malabsorp)\b/i,
  },
  {
    system: "Neurology",
    pattern: /\b(?:ischemic stroke|intraventricular hemorrhage|hearing loss|hoarseness|neurolog|brain|stroke|cranial|vestib|demyelin|myasthenia)\b/i,
  },
  {
    system: "Endocrine",
    pattern: /\b(?:hypothyroid\w*|diabetes mellitus|diabetic foot|pituitary|endocr|thyroid|adrenal|pheochrom|insulin)\b/i,
  },
  {
    system: "Cardiovascular",
    pattern: /\b(?:cardiac physiology|cardiovascular|cardiology|cardiac|heart|coronary|arrhythm|valv|myocard|aortic|pericard)\b/i,
  },
  {
    system: "Biostatistics and Ethics",
    pattern: /\b(?:physician patient communication|patient communication|biostat|ethic|evidence[- ]based|study design|sensitivity|specificity)\b/i,
  },
  {
    system: "Behavioral Science",
    pattern: /\b(?:behavior|behaviour|psychiatr|anxiety|depress|delirium|personality|sleep disorder)\b/i,
  },
  {
    system: "Pharmacology",
    pattern: /\b(?:tetracycline|pharmac|anticoagul|benzodiazep|anticholin|nitrate|drug toxicity|toxicology)\b/i,
  },
  {
    system: "Biochemistry",
    pattern: /\b(?:beta oxidation|mosaicism|lesch[- ]nyhan|genomic imprinting|genetic disorders?|embryologic derivatives|laboratory techniques|biochem|genetic|chromosom|metaboli|rna|protein synthesis|translation|transcription|apoptosis)\b/i,
  },
]);

const MEDIA_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp|mp3|m4a|ogg|wav)(?:[?#].*)?$/i;
const IMAGE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i;

function clean(value = "") {
  return String(value || "").replace(/\u0000/g, "").trim();
}

function normalizedLabel(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function referenceKeys(value = "") {
  const raw = clean(value)
    .replace(/&amp;/gi, "&")
    .split(/[?#]/, 1)[0]
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .toLowerCase();
  if (!raw) return [];
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const basename = decoded.split("/").filter(Boolean).pop() || "";
  return [...new Set([raw, decoded, basename].filter(Boolean))];
}

function inlineMediaReferences(value = "") {
  const html = String(value || "");
  const references = [];
  const mediaTag = /<(?:audio|img|source|video)\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  let match;
  while ((match = mediaTag.exec(html))) {
    const reference = clean(match[2]);
    if (reference) references.push(reference);
  }
  const mediaLink = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  while ((match = mediaLink.exec(html))) {
    const reference = clean(match[2]);
    if (MEDIA_EXTENSION.test(reference)) references.push(reference);
  }
  return references;
}

function inlineImageReferences(value = "") {
  const html = String(value || "");
  const references = [];
  const imageTag = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
  let match;
  while ((match = imageTag.exec(html))) {
    const reference = clean(match[2]);
    if (reference) references.push(reference);
  }
  return references;
}

function questionText(question = {}) {
  const taxonomy = question.taxonomy && typeof question.taxonomy === "object"
    ? question.taxonomy
    : {};
  const labels = taxonomy.labels && typeof taxonomy.labels === "object"
    ? taxonomy.labels
    : {};
  return [
    question.title,
    question.topic_key,
    question.topicKey,
    taxonomy.topic_key,
    taxonomy.topicKey,
    question.subtopic_key,
    question.subtopicKey,
    taxonomy.subtopic_key,
    taxonomy.subtopicKey,
    labels.topic,
    labels.subtopic,
  ].map(clean).filter(Boolean).join(" ");
}

export function canonicalStep1DiagnosticSystem(value = "") {
  const label = normalizedLabel(value);
  if (!label || /^\d+$/.test(label)) return null;
  return SYSTEM_ALIASES.get(label) || null;
}

export function classifyStep1DiagnosticQuestion(question = {}) {
  const taxonomy = question.taxonomy && typeof question.taxonomy === "object"
    ? question.taxonomy
    : {};
  const labels = taxonomy.labels && typeof taxonomy.labels === "object"
    ? taxonomy.labels
    : {};
  const candidates = [
    question.system_label,
    question.systemLabel,
    labels.system,
    labels.system_label,
    taxonomy.system_label,
    taxonomy.systemLabel,
    question.system_key,
    question.systemKey,
    taxonomy.system_key,
    taxonomy.systemKey,
    question.system,
  ];
  for (const candidate of candidates) {
    const system = canonicalStep1DiagnosticSystem(candidate);
    if (system) return system;
  }
  const text = questionText(question);
  return TITLE_RULES.find((rule) => rule.pattern.test(text))?.system || null;
}

export function auditDiagnosticQuestionMedia(question = {}) {
  const answers = Array.isArray(question.answers) ? question.answers : [];
  const htmlValues = [
    question.question_html || question.questionHtml,
    question.explanation_html || question.explanationHtml,
    ...answers.map((answer) => answer.text_html || answer.textHtml || answer.text || ""),
  ];
  const referenced = [
    ...htmlValues.flatMap(inlineMediaReferences),
    ...(Array.isArray(question.media_refs) ? question.media_refs : []),
  ];
  const references = [...new Set(referenced.map(clean).filter(Boolean))];
  const imageReferences = [...new Set([
    ...htmlValues.flatMap(inlineImageReferences),
    ...(Array.isArray(question.media_refs)
      ? question.media_refs.filter((reference) => IMAGE_EXTENSION.test(clean(reference)))
      : []),
  ].map(clean).filter(Boolean))];
  const attached = Array.isArray(question.media) ? question.media : [];
  const attachedByKey = new Map();
  for (const item of attached) {
    const hasPlayableSource = Boolean(
      clean(item?.object_key || item?.objectKey)
      || /^https?:\/\//i.test(clean(item?.url)),
    );
    for (const candidate of [item?.ref, item?.name, item?.filename]) {
      for (const key of referenceKeys(candidate)) {
        if (!attachedByKey.has(key) || hasPlayableSource) {
          attachedByKey.set(key, hasPlayableSource);
        }
      }
    }
  }
  const missingRefs = references.filter((reference) => {
    if (/^(?:data:|blob:)/i.test(reference)) return false;
    return !referenceKeys(reference).some((key) => attachedByKey.get(key) === true);
  });
  const unplayableAttachments = attached.filter((item) => !(
    clean(item?.object_key || item?.objectKey)
    || /^https?:\/\//i.test(clean(item?.url))
  ));
  const playableImageAttachments = attached.filter((item) => {
    const isImage = String(item?.kind || item?.media_kind || "").toLowerCase() === "image"
      || /^image\//i.test(clean(item?.content_type || item?.contentType))
      || [item?.ref, item?.name, item?.filename].some((value) => IMAGE_EXTENSION.test(clean(value)));
    return isImage && Boolean(
      clean(item?.object_key || item?.objectKey)
      || /^https?:\/\//i.test(clean(item?.url)),
    );
  });
  const inlinePlayableImageCount = imageReferences.filter((reference) => (
    /^(?:data:image\/|blob:)/i.test(reference)
  )).length;
  const playableImageCount = playableImageAttachments.length + inlinePlayableImageCount;
  return {
    ready: missingRefs.length === 0 && unplayableAttachments.length === 0,
    referenceCount: references.length,
    attachmentCount: attached.length,
    imageReferenceCount: imageReferences.length,
    playableImageCount,
    hasPlayableImage: playableImageCount > 0
      && imageReferences.every((reference) => (
        /^(?:data:image\/|blob:)/i.test(reference)
        || referenceKeys(reference).some((key) => attachedByKey.get(key) === true)
      )),
    missingRefs,
    unplayableAttachmentCount: unplayableAttachments.length,
  };
}

function diagnosticTaxonomyValue(question = {}, keys = []) {
  const taxonomy = question.taxonomy && typeof question.taxonomy === "object"
    ? question.taxonomy
    : {};
  const labels = taxonomy.labels && typeof taxonomy.labels === "object"
    ? taxonomy.labels
    : {};
  for (const key of keys) {
    const values = [
      question[key],
      taxonomy[key],
      labels[key],
    ];
    const match = values.map(clean).find(Boolean);
    if (match) return match;
  }
  return "";
}

function diagnosticMatchLabel(value = "") {
  const label = normalizedLabel(value);
  if (!label || /^\d+$/.test(label) || ["unclassified", "unknown", "none", "general"].includes(label)) {
    return "";
  }
  return label;
}

function diagnosticDifficultyRank(question = {}) {
  const raw = diagnosticTaxonomyValue(question, [
    "difficulty",
    "difficulty_key",
    "difficultyKey",
    "difficulty_label",
    "difficultyLabel",
  ]);
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return Math.max(1, Math.min(5, Math.round(numeric)));
  const label = normalizedLabel(raw);
  if (["easy", "basic", "foundation", "foundational", "recall"].includes(label)) return 1;
  if (["medium", "moderate", "standard", "application"].includes(label)) return 2;
  if (["hard", "difficult", "advanced", "challenge", "challenging"].includes(label)) return 3;
  return null;
}

export function diagnosticQuestionMatchProfile(question = {}) {
  return {
    id: clean(question.id),
    examTrack: normalizedLabel(question.exam_track || question.examTrack),
    system: classifyStep1DiagnosticQuestion(question),
    subsystem: diagnosticMatchLabel(diagnosticTaxonomyValue(question, [
      "subsystem_key",
      "subsystemKey",
      "subsystem",
    ])),
    topic: diagnosticMatchLabel(diagnosticTaxonomyValue(question, [
      "topic_key",
      "topicKey",
      "topic",
    ]) || question.title),
    subtopic: diagnosticMatchLabel(diagnosticTaxonomyValue(question, [
      "subtopic_key",
      "subtopicKey",
      "subtopic",
    ])),
    objective: diagnosticMatchLabel(diagnosticTaxonomyValue(question, [
      "objective_key",
      "objectiveKey",
      "learning_objective",
      "learningObjective",
      "objective",
    ])),
    difficultyRank: diagnosticDifficultyRank(question),
  };
}

function diagnosticReplacementMatch(original, candidate) {
  const source = original.profile;
  const replacement = candidate.profile;
  if (!source.system || source.system !== replacement.system) return null;
  if (source.examTrack && replacement.examTrack && source.examTrack !== replacement.examTrack) return null;

  const exactSubtopic = Boolean(source.subtopic && source.subtopic === replacement.subtopic);
  const exactTopic = Boolean(source.topic && source.topic === replacement.topic);
  const exactSubsystem = Boolean(source.subsystem && source.subsystem === replacement.subsystem);
  if (!exactSubtopic && !exactTopic && !exactSubsystem) return null;

  const difficultyDelta = source.difficultyRank !== null && replacement.difficultyRank !== null
    ? Math.abs(source.difficultyRank - replacement.difficultyRank)
    : null;
  if (difficultyDelta !== null && difficultyDelta > 1) return null;

  const exactObjective = Boolean(source.objective && source.objective === replacement.objective);
  const matchLevel = exactSubtopic
    ? "subtopic"
    : exactTopic
      ? "topic"
      : "subsystem";
  const score = (exactSubtopic ? 120 : 0)
    + (exactTopic ? 90 : 0)
    + (exactSubsystem ? 55 : 0)
    + (exactObjective ? 30 : 0)
    + (difficultyDelta === 0 ? 15 : difficultyDelta === 1 ? 6 : 0);
  return {
    score,
    matchLevel,
    exactObjective,
    difficultyDelta,
  };
}

function balancedDiagnosticQuestions(grouped, requestedCount) {
  const availableSystemKeys = STEP_1_SYSTEMS.filter((system) => grouped.get(system)?.length);
  const selected = [];
  let position = 0;
  while (selected.length < requestedCount) {
    let added = false;
    for (const system of availableSystemKeys) {
      const row = grouped.get(system)?.[position];
      if (!row) continue;
      selected.push(row);
      added = true;
      if (selected.length >= requestedCount) break;
    }
    if (!added) break;
    position += 1;
  }
  return selected;
}

export function buildStep1DiagnosticSelection(candidates = [], {
  requestedCount = 40,
  minimumSystems = 12,
  preferredQuestionIds = [],
} = {}) {
  const safeCount = Math.max(1, Math.min(200, Math.trunc(Number(requestedCount) || 40)));
  const grouped = new Map(STEP_1_SYSTEMS.map((system) => [system, []]));
  const mediaReadyGrouped = new Map(STEP_1_SYSTEMS.map((system) => [system, []]));
  const rejected = {
    missingMedia: [],
    unclassified: [],
    preferredUnavailable: [],
    unmatchedReplacements: [],
  };
  const records = [];
  let mediaReferenceCount = 0;

  for (const question of Array.isArray(candidates) ? candidates : []) {
    if (!question?.id) continue;
    const media = auditDiagnosticQuestionMedia(question);
    mediaReferenceCount += media.referenceCount;
    const profile = diagnosticQuestionMatchProfile(question);
    const system = profile.system;
    if (!system || !grouped.has(system)) {
      rejected.unclassified.push({
        id: String(question.id),
        title: clean(question.title),
      });
      continue;
    }
    const record = {
      question: { ...question, diagnostic_system: system },
      profile,
      media,
    };
    records.push(record);
    grouped.get(system).push(record);
    if (media.ready) {
      mediaReadyGrouped.get(system).push(record);
    } else {
      rejected.missingMedia.push({
        id: String(question.id),
        title: clean(question.title),
        system,
        subsystem: profile.subsystem,
        topic: profile.topic,
        subtopic: profile.subtopic,
        imageReferenceCount: media.imageReferenceCount,
        missingRefs: media.missingRefs,
      });
    }
  }

  const recordsById = new Map(records.map((record) => [record.profile.id, record]));
  const requestedPreferredIds = [...new Set(
    (Array.isArray(preferredQuestionIds) ? preferredQuestionIds : [])
      .map((value) => clean(value))
      .filter(Boolean),
  )].slice(0, safeCount);
  const preferredRecords = [];
  for (const id of requestedPreferredIds) {
    const record = recordsById.get(id);
    if (record) preferredRecords.push(record);
    else rejected.preferredUnavailable.push({ id });
  }
  const baseSelected = [...preferredRecords];
  const baseIds = new Set(baseSelected.map((record) => record.profile.id));
  for (const record of balancedDiagnosticQuestions(grouped, safeCount)) {
    if (baseSelected.length >= safeCount) break;
    if (baseIds.has(record.profile.id)) continue;
    baseIds.add(record.profile.id);
    baseSelected.push(record);
  }

  const selected = [];
  const replacements = [];
  const usedReplacementIds = new Set();
  for (const [slotIndex, original] of baseSelected.entries()) {
    if (original.media.ready) {
      selected.push(original.question);
      continue;
    }
    const requiresImage = original.media.imageReferenceCount > 0;
    const matches = records
      .filter((candidate) => (
        candidate.media.ready
        && !baseIds.has(candidate.profile.id)
        && !usedReplacementIds.has(candidate.profile.id)
        && (!requiresImage || candidate.media.hasPlayableImage)
      ))
      .map((candidate) => ({
        candidate,
        match: diagnosticReplacementMatch(original, candidate),
      }))
      .filter((row) => row.match)
      .sort((left, right) => (
        right.match.score - left.match.score
        || left.candidate.profile.id.localeCompare(right.candidate.profile.id)
      ));
    const best = matches[0];
    if (!best) {
      rejected.unmatchedReplacements.push({
        slot: slotIndex + 1,
        originalQuestionId: original.profile.id,
        system: original.profile.system,
        subsystem: original.profile.subsystem,
        topic: original.profile.topic,
        subtopic: original.profile.subtopic,
        difficultyRank: original.profile.difficultyRank,
        imageRequired: requiresImage,
      });
      continue;
    }
    usedReplacementIds.add(best.candidate.profile.id);
    selected.push({
      ...best.candidate.question,
      diagnostic_replacement_for: original.profile.id,
      diagnostic_replacement_reason: "governed_media_replacement",
    });
    replacements.push({
      slot: slotIndex + 1,
      originalQuestionId: original.profile.id,
      replacementQuestionId: best.candidate.profile.id,
      system: original.profile.system,
      subsystem: original.profile.subsystem,
      topic: original.profile.topic,
      subtopic: original.profile.subtopic,
      matchLevel: best.match.matchLevel,
      exactObjective: best.match.exactObjective,
      difficultyDelta: best.match.difficultyDelta,
      imageRequired: requiresImage,
      replacementHasPlayableImage: best.candidate.media.hasPlayableImage,
    });
  }

  const availableSystemKeys = STEP_1_SYSTEMS.filter((system) => mediaReadyGrouped.get(system).length > 0);
  const selectedSystemKeys = STEP_1_SYSTEMS.filter((system) =>
    selected.some((question) => question.diagnostic_system === system));
  const requiredSystems = Math.max(
    1,
    Math.min(safeCount, STEP_1_SYSTEMS.length, Math.trunc(Number(minimumSystems) || 12)),
  );
  const ready = baseSelected.length === safeCount
    && selected.length === safeCount
    && selectedSystemKeys.length >= requiredSystems
    && rejected.preferredUnavailable.length === 0
    && rejected.unmatchedReplacements.length === 0;

  return {
    ready,
    selected,
    replacements,
    requestedCount: safeCount,
    baseQuestionCount: baseSelected.length,
    preferredQuestionCount: requestedPreferredIds.length,
    eligibleQuestionCount: [...mediaReadyGrouped.values()].reduce((sum, rows) => sum + rows.length, 0),
    availableSystemKeys,
    selectedSystemKeys,
    minimumSystems: requiredSystems,
    mediaReferenceCount,
    selectedImageQuestionCount: selected.filter((question) => (
      auditDiagnosticQuestionMedia(question).hasPlayableImage
    )).length,
    governedReplacementCount: replacements.length,
    unmatchedReplacementCount: rejected.unmatchedReplacements.length,
    preferredUnavailableCount: rejected.preferredUnavailable.length,
    rejectedMissingMediaCount: rejected.missingMedia.length,
    rejectedUnclassifiedCount: rejected.unclassified.length,
    rejected,
  };
}

export function applyDiagnosticSystemOverride(question = {}, system = "") {
  const canonical = canonicalStep1DiagnosticSystem(system);
  if (!canonical) return question;
  const taxonomy = question.taxonomy && typeof question.taxonomy === "object"
    ? question.taxonomy
    : {};
  const labels = taxonomy.labels && typeof taxonomy.labels === "object"
    ? taxonomy.labels
    : {};
  return {
    ...question,
    system_key: canonical,
    system_label: canonical,
    taxonomy: {
      ...taxonomy,
      system_key: canonical,
      system_label: canonical,
      labels: {
        ...labels,
        system: canonical,
        system_label: canonical,
      },
      diagnostic_blueprint_version: AYLA_DIAGNOSTIC_BLUEPRINT_VERSION,
    },
  };
}

export function diagnosticSessionUsesCurrentBlueprint(session = {}) {
  if (String(session.purpose || "") !== "baseline_diagnostic") return true;
  const mappings = Array.isArray(session.questions) ? session.questions : [];
  const systemMap = session.diagnosticSystemByQuestionId;
  const quality = session.diagnosticQuality && typeof session.diagnosticQuality === "object"
    ? session.diagnosticQuality
    : {};
  if (
    Number(session.diagnosticBlueprintVersion || 0) !== AYLA_DIAGNOSTIC_BLUEPRINT_VERSION
    || !systemMap
    || typeof systemMap !== "object"
    || mappings.length === 0
    || quality.mediaReady !== true
    || quality.taxonomyReady !== true
    || quality.governedReplacementReady !== true
    || Number(quality.unmatchedReplacementCount || 0) !== 0
  ) {
    return false;
  }
  const mappedSystems = mappings.map((mapping) =>
    canonicalStep1DiagnosticSystem(systemMap[String(mapping.contentQuestionId || "")]));
  if (mappedSystems.some((system) => !system)) return false;
  const minimumSystems = Math.max(1, Math.trunc(Number(quality.minimumSystemCount) || 1));
  return new Set(mappedSystems).size >= minimumSystems;
}
