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

export const AYLA_DIAGNOSTIC_BLUEPRINT_VERSION = 2;
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
  const referenced = [
    ...inlineMediaReferences(question.question_html || question.questionHtml),
    ...inlineMediaReferences(question.explanation_html || question.explanationHtml),
    ...answers.flatMap((answer) => inlineMediaReferences(
      answer.text_html || answer.textHtml || answer.text || "",
    )),
    ...(Array.isArray(question.media_refs) ? question.media_refs : []),
  ];
  const references = [...new Set(referenced.map(clean).filter(Boolean))];
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
  return {
    ready: missingRefs.length === 0 && unplayableAttachments.length === 0,
    referenceCount: references.length,
    attachmentCount: attached.length,
    missingRefs,
    unplayableAttachmentCount: unplayableAttachments.length,
  };
}

export function buildStep1DiagnosticSelection(candidates = [], {
  requestedCount = 40,
  minimumSystems = 12,
} = {}) {
  const safeCount = Math.max(1, Math.min(200, Math.trunc(Number(requestedCount) || 40)));
  const grouped = new Map(STEP_1_SYSTEMS.map((system) => [system, []]));
  const rejected = {
    missingMedia: [],
    unclassified: [],
  };
  let mediaReferenceCount = 0;

  for (const question of Array.isArray(candidates) ? candidates : []) {
    if (!question?.id) continue;
    const media = auditDiagnosticQuestionMedia(question);
    mediaReferenceCount += media.referenceCount;
    if (!media.ready) {
      rejected.missingMedia.push({
        id: String(question.id),
        title: clean(question.title),
        missingRefs: media.missingRefs,
      });
      continue;
    }
    const system = classifyStep1DiagnosticQuestion(question);
    if (!system || !grouped.has(system)) {
      rejected.unclassified.push({
        id: String(question.id),
        title: clean(question.title),
      });
      continue;
    }
    grouped.get(system).push({ ...question, diagnostic_system: system });
  }

  const availableSystemKeys = STEP_1_SYSTEMS.filter((system) => grouped.get(system).length > 0);
  const selected = [];
  let position = 0;
  while (selected.length < safeCount) {
    let added = false;
    for (const system of availableSystemKeys) {
      const row = grouped.get(system)[position];
      if (!row) continue;
      selected.push(row);
      added = true;
      if (selected.length >= safeCount) break;
    }
    if (!added) break;
    position += 1;
  }
  const selectedSystemKeys = STEP_1_SYSTEMS.filter((system) =>
    selected.some((question) => question.diagnostic_system === system));
  const requiredSystems = Math.max(
    1,
    Math.min(safeCount, STEP_1_SYSTEMS.length, Math.trunc(Number(minimumSystems) || 12)),
  );
  const ready = selected.length === safeCount && selectedSystemKeys.length >= requiredSystems;

  return {
    ready,
    selected,
    requestedCount: safeCount,
    eligibleQuestionCount: [...grouped.values()].reduce((sum, rows) => sum + rows.length, 0),
    availableSystemKeys,
    selectedSystemKeys,
    minimumSystems: requiredSystems,
    mediaReferenceCount,
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
  ) {
    return false;
  }
  const mappedSystems = mappings.map((mapping) =>
    canonicalStep1DiagnosticSystem(systemMap[String(mapping.contentQuestionId || "")]));
  if (mappedSystems.some((system) => !system)) return false;
  const minimumSystems = Math.max(1, Math.trunc(Number(quality.minimumSystemCount) || 1));
  return new Set(mappedSystems).size >= minimumSystems;
}
