import crypto from "node:crypto";

export const AYLA_ORIGINAL_MCQ_REPAIR_KEY = "aylamed-original-image-repair-v262";
export const AYLA_ORIGINAL_MCQ_REPAIR_CONFIRMATION = "PUBLISH 13 AYLA ORIGINAL REPLACEMENTS";

function question({
  key,
  title,
  brokenRefs,
  system,
  subsystem,
  topic,
  subtopic,
  stem,
  prompt,
  answers,
  correctAnswerId,
  explanation,
  references,
}) {
  return {
    key,
    sourceItemId: `AYLA-IMG-REPAIR-${String(key).toUpperCase()}`,
    title,
    brokenRefs,
    taxonomy: {
      system_key: system,
      subsystem_key: subsystem,
      topic_key: topic,
      subtopic_key: subtopic,
      labels: {
        system,
        subsystem,
        topic,
        subtopic,
      },
      source: "aylamed_original_editorial",
      review_status: "approved",
    },
    questionHtml: `<p>${stem}</p><p><strong>${prompt}</strong></p>`,
    answers: answers.map((text, index) => ({
      answerId: index + 1,
      textHtml: `<p>${text}</p>`,
    })),
    correctAnswerId,
    explanationHtml: `<p>${explanation}</p>`,
    references,
  };
}

export const AYLA_ORIGINAL_MCQ_REPLACEMENTS = Object.freeze([
  question({
    key: "osteoarthritis",
    title: "Osteoarthritis: cartilage and subchondral remodeling",
    brokenRefs: ["U23056.png"],
    system: "Musculoskeletal",
    subsystem: "Joints",
    topic: "Osteoarthritis",
    subtopic: "Pathophysiology",
    stem: "A 68-year-old woman has gradually worsening knee pain that is greatest after walking and improves with rest. Morning stiffness lasts about 10 minutes. Examination shows crepitus and firm bony enlargement without warmth or marked erythema.",
    prompt: "Which process best explains this patient's joint disease?",
    answers: [
      "Progressive loss of articular cartilage with remodeling of subchondral bone",
      "Autoantibody-driven synovial inflammation with pannus formation",
      "Deposition of monosodium urate crystals in the joint space",
      "Hematogenous bacterial invasion of the synovium",
      "Interruption of the femoral-head blood supply",
    ],
    correctAnswerId: 1,
    explanation: "The activity-related pain, brief morning stiffness, crepitus, and bony enlargement are characteristic of osteoarthritis. The central structural changes are degeneration of articular cartilage and remodeling of the underlying bone.",
    references: ["https://www.niams.nih.gov/health-topics/osteoarthritis"],
  }),
  question({
    key: "ischemic-stroke",
    title: "Ischemic stroke: dominant middle cerebral artery",
    brokenRefs: ["highresdefault_U89821.png"],
    system: "Neurology",
    subsystem: "Cerebrovascular",
    topic: "Ischemic Stroke",
    subtopic: "Vascular localization",
    stem: "A 72-year-old right-handed man suddenly develops inability to speak and weakness of the right lower face and right arm that is greater than weakness of the right leg. His eyes deviate to the left.",
    prompt: "Occlusion of which artery best localizes this neurologic deficit?",
    answers: [
      "Left anterior cerebral artery",
      "Left middle cerebral artery",
      "Left posterior cerebral artery",
      "Right middle cerebral artery",
      "Basilar artery",
    ],
    correctAnswerId: 2,
    explanation: "A dominant-hemisphere middle cerebral artery infarct can cause aphasia, gaze preference toward the lesion, and contralateral face-and-arm deficits that exceed leg deficits.",
    references: ["https://professional.heart.org/en/science-news/2026-guideline-for-the-early-management-of-patients-with-acute-ischemic-stroke"],
  }),
  question({
    key: "digeorge-syndrome",
    title: "22q11.2 deletion syndrome: pharyngeal pouch development",
    brokenRefs: ["highresdefault_U64133.png"],
    system: "Immunology",
    subsystem: "Primary immunodeficiency",
    topic: "22q11.2 Deletion Syndrome",
    subtopic: "Embryology",
    stem: "A newborn has an interrupted aortic arch, hypocalcemic tetany, an absent thymic shadow, and a markedly reduced T-lymphocyte count.",
    prompt: "Abnormal development of which embryologic structures most directly explains this combination?",
    answers: [
      "First pharyngeal arch",
      "Second pharyngeal pouch",
      "Third and fourth pharyngeal pouches",
      "Dorsal pancreatic bud",
      "Metanephric blastema",
    ],
    correctAnswerId: 3,
    explanation: "The cardiac, thymic, and parathyroid findings indicate 22q11.2 deletion syndrome. Abnormal development of the third and fourth pharyngeal pouches produces thymic and parathyroid hypoplasia.",
    references: ["https://www.ncbi.nlm.nih.gov/books/NBK1523/"],
  }),
  question({
    key: "hypothyroidism",
    title: "Primary hypothyroidism: laboratory pattern",
    brokenRefs: ["highresdefault_U63979.png"],
    system: "Endocrine",
    subsystem: "Thyroid",
    topic: "Hypothyroidism",
    subtopic: "Diagnosis",
    stem: "A 46-year-old woman reports fatigue, constipation, cold intolerance, and weight gain. Examination shows dry skin and delayed relaxation of the ankle reflexes.",
    prompt: "Which laboratory pattern is most consistent with primary hypothyroidism?",
    answers: [
      "Low thyroid-stimulating hormone and high free thyroxine",
      "Low thyroid-stimulating hormone and low free thyroxine",
      "High thyroid-stimulating hormone and high free thyroxine",
      "High thyroid-stimulating hormone and low free thyroxine",
      "Normal thyroid-stimulating hormone and high free thyroxine",
    ],
    correctAnswerId: 4,
    explanation: "Failure of the thyroid gland lowers free thyroxine. Loss of negative feedback increases pituitary thyroid-stimulating hormone, producing a high-TSH, low-free-thyroxine pattern.",
    references: ["https://www.niddk.nih.gov/health-information/diagnostic-tests/thyroid"],
  }),
  question({
    key: "corns",
    title: "Corns: pressure relief",
    brokenRefs: ["highresdefault_L24048.png"],
    system: "Musculoskeletal",
    subsystem: "Foot and ankle",
    topic: "Corns and Calluses",
    subtopic: "Management",
    stem: "A 31-year-old woman who regularly wears narrow shoes has a sharply circumscribed, painful hyperkeratotic lesion with a firm central core over the dorsal proximal interphalangeal joint of her fifth toe. There is no drainage or surrounding erythema.",
    prompt: "What is the most appropriate initial management?",
    answers: [
      "Modify footwear and pad the area to remove repeated pressure",
      "Begin oral antibiotics",
      "Inject an intra-articular glucocorticoid",
      "Perform urgent surgical debridement",
      "Start long-term systemic antifungal therapy",
    ],
    correctAnswerId: 1,
    explanation: "This is a corn caused by repeated focal pressure and friction. Initial management removes the mechanical trigger with better-fitting footwear and protective padding.",
    references: ["https://www.aad.org/public/everyday-care/injured-skin/burns/treat-corns-calluses"],
  }),
  question({
    key: "sinusitis",
    title: "Acute bacterial rhinosinusitis: double worsening",
    brokenRefs: ["highresdefault_U73734.png"],
    system: "Respiratory",
    subsystem: "Upper respiratory tract",
    topic: "Acute Rhinosinusitis",
    subtopic: "Bacterial features",
    stem: "A 35-year-old woman develops nasal congestion and cough. The symptoms improve over 5 days, but on day 8 she develops a new fever, worsening purulent nasal discharge, and unilateral facial pain.",
    prompt: "Which feature most strongly supports acute bacterial rather than uncomplicated viral rhinosinusitis?",
    answers: [
      "Nasal congestion during the first 48 hours",
      "Cough accompanying the nasal symptoms",
      "Purulent discharge at any point in the illness",
      "Worsening after initial improvement",
      "An illness duration shorter than 10 days",
    ],
    correctAnswerId: 4,
    explanation: "A new deterioration after initial improvement is the double-worsening pattern used to identify likely acute bacterial rhinosinusitis.",
    references: ["https://www.cdc.gov/antibiotic-use/hcp/clinical-care/adult-outpatient.html"],
  }),
  question({
    key: "diabetic-kidney-disease",
    title: "Diabetic kidney disease: screening tests",
    brokenRefs: ["U51314.jpg"],
    system: "Renal",
    subsystem: "Glomerular disease",
    topic: "Diabetic Kidney Disease",
    subtopic: "Screening",
    stem: "A 58-year-old man with type 2 diabetes mellitus has no urinary symptoms and a normal physical examination. His clinician is screening for early diabetic kidney disease.",
    prompt: "Which pair of tests is most appropriate for routine screening?",
    answers: [
      "Urine culture and renal ultrasonography",
      "Spot urine albumin-to-creatinine ratio and estimated glomerular filtration rate",
      "Twenty-four-hour urine sodium and serum osmolality",
      "Urine cytology and cystoscopy",
      "Renal biopsy and serum complement levels",
    ],
    correctAnswerId: 2,
    explanation: "Diabetic kidney disease screening assesses urinary albumin excretion with a spot urine albumin-to-creatinine ratio and kidney filtration with estimated glomerular filtration rate.",
    references: [
      "https://www.niddk.nih.gov/health-information/diabetes/overview/preventing-problems/diabetic-kidney-disease",
    ],
  }),
  question({
    key: "diabetes-diagnosis",
    title: "Diabetes mellitus: diagnosis by repeated A1C",
    brokenRefs: ["L18322.jpg"],
    system: "Endocrine",
    subsystem: "Pancreas and metabolism",
    topic: "Diabetes Mellitus",
    subtopic: "Diagnosis",
    stem: "A 49-year-old asymptomatic man has a hemoglobin A1C of 6.8% at a routine visit. A repeat A1C obtained on a different day is 6.7%. Both measurements were performed in an accredited laboratory.",
    prompt: "Which interpretation is most accurate?",
    answers: [
      "Diabetes mellitus is confirmed",
      "Prediabetes is confirmed, but diabetes is excluded",
      "A random plasma glucose level is still required for diagnosis",
      "The result is normal because he has no symptoms",
      "Only an oral glucose tolerance test can establish the diagnosis",
    ],
    correctAnswerId: 1,
    explanation: "An A1C of at least 6.5% is in the diabetes range. In an asymptomatic person, confirmation with a second abnormal result establishes the diagnosis.",
    references: ["https://diabetesjournals.org/care/article/49/Supplement_1/S27/163926/2-Diagnosis-and-Classification-of-Diabetes"],
  }),
  question({
    key: "peptic-ulcer-disease",
    title: "NSAID-associated peptic ulcer disease",
    brokenRefs: ["U41548.png"],
    system: "Gastrointestinal",
    subsystem: "Stomach and duodenum",
    topic: "Peptic Ulcer Disease",
    subtopic: "NSAID pathophysiology",
    stem: "A 63-year-old man who takes naproxen daily for arthritis develops burning epigastric pain. Endoscopy shows a gastric ulcer, and testing for Helicobacter pylori is negative.",
    prompt: "Which change most directly contributed to this ulcer?",
    answers: [
      "Increased gastric prostaglandin synthesis",
      "Reduced mucus and bicarbonate protection due to cyclooxygenase inhibition",
      "Increased lower esophageal sphincter tone",
      "Autoimmune destruction of gastric parietal cells",
      "Increased pancreatic bicarbonate secretion",
    ],
    correctAnswerId: 2,
    explanation: "Nonsteroidal anti-inflammatory drugs inhibit cyclooxygenase and reduce protective gastric prostaglandins, weakening mucus, bicarbonate, and mucosal blood-flow defenses.",
    references: ["https://www.niddk.nih.gov/health-information/digestive-diseases/peptic-ulcers-stomach-ulcers"],
  }),
  question({
    key: "gfr-estimation",
    title: "GFR estimation: effect of muscle mass",
    brokenRefs: ["GFR_A.gif", "GFR_B.gif", "GFR_C.gif", "GFR_D.gif", "GFR_E.gif"],
    system: "Renal",
    subsystem: "Renal physiology",
    topic: "Glomerular Filtration Rate",
    subtopic: "Creatinine limitations",
    stem: "A healthy 28-year-old competitive weightlifter has a stable serum creatinine concentration that is mildly above the laboratory reference range. Urinalysis is normal, and a cystatin C-based estimate of glomerular filtration is normal.",
    prompt: "Which factor best explains the discrepancy between the creatinine- and cystatin C-based estimates?",
    answers: [
      "Increased creatinine generation from greater muscle mass",
      "Reduced filtration caused by isolated albuminuria",
      "Increased cystatin C secretion by renal tubules",
      "Complete inhibition of creatinine secretion",
      "Reduced creatinine production during exercise",
    ],
    correctAnswerId: 1,
    explanation: "Creatinine production depends partly on muscle mass. A muscular person can therefore have a higher serum creatinine and a lower creatinine-based estimated filtration rate despite preserved kidney function.",
    references: ["https://www.niddk.nih.gov/health-information/professionals/clinical-tools-patient-management/kidney-disease/laboratory-evaluation/glomerular-filtration-rate/clinical-measurements"],
  }),
  question({
    key: "pituitary-tumor",
    title: "Pituitary macroadenoma: optic chiasm compression",
    brokenRefs: [
      "highresdefault_U36551.jpg",
      "highresdefault_U36552.jpg",
      "highresdefault_U36553.jpg",
      "highresdefault_U36554.jpg",
      "highresdefault_U36555.jpg",
    ],
    system: "Endocrine",
    subsystem: "Pituitary",
    topic: "Pituitary Tumors",
    subtopic: "Mass effect",
    stem: "A 34-year-old woman has headaches, amenorrhea, and galactorrhea. Visual-field testing shows loss of the temporal field in both eyes.",
    prompt: "Compression of which structure most directly causes this visual deficit?",
    answers: [
      "Left optic nerve",
      "Optic chiasm",
      "Right optic tract",
      "Lateral geniculate nucleus",
      "Occipital visual cortex",
    ],
    correctAnswerId: 2,
    explanation: "A sellar mass can extend superiorly and compress the crossing nasal retinal fibers in the optic chiasm, producing bitemporal hemianopia.",
    references: ["https://www.cancer.gov/types/pituitary/hp/pituitary-treatment-pdq"],
  }),
  question({
    key: "endometriosis",
    title: "Endometriosis: clinical presentation",
    brokenRefs: ["U26233.png"],
    system: "Reproductive",
    subsystem: "Gynecology",
    topic: "Endometriosis",
    subtopic: "Clinical diagnosis",
    stem: "A 29-year-old woman has progressively worsening cyclic pelvic pain, deep pain during intercourse, painful defecation during menses, and 18 months of infertility.",
    prompt: "Which diagnosis best explains this presentation?",
    answers: [
      "Endometriosis",
      "Acute pelvic inflammatory disease",
      "Ectopic pregnancy",
      "Polycystic ovary syndrome",
      "Primary dysmenorrhea",
    ],
    correctAnswerId: 1,
    explanation: "Cyclic pelvic pain accompanied by deep dyspareunia, dyschezia, and infertility is a characteristic clinical pattern of endometriosis.",
    references: ["https://www.nichd.nih.gov/health/topics/endometri/conditioninfo/symptoms"],
  }),
  question({
    key: "septic-arthritis",
    title: "Septic arthritis: urgent arthrocentesis",
    brokenRefs: ["U22059.png"],
    system: "Musculoskeletal",
    subsystem: "Joints",
    topic: "Septic Arthritis",
    subtopic: "Diagnosis",
    stem: "A 61-year-old man presents with fever and a rapidly progressive, intensely painful swollen knee. The joint is warm, and both active and passive range of motion are severely limited.",
    prompt: "Which diagnostic step should be performed urgently?",
    answers: [
      "Serum uric acid measurement alone",
      "Plain radiography followed by outpatient observation",
      "Arthrocentesis with synovial fluid cell count, Gram stain, and culture",
      "Electromyography of the affected leg",
      "Antinuclear antibody testing",
    ],
    correctAnswerId: 3,
    explanation: "Acute febrile monoarthritis with marked pain on passive motion requires urgent evaluation for septic arthritis. Synovial fluid analysis and culture identify the infection and guide treatment.",
    references: ["https://www.ncbi.nlm.nih.gov/books/NBK538176/"],
  }),
]);

export const AYLA_BROKEN_IMAGE_MCQ_REFERENCES = Object.freeze(
  AYLA_ORIGINAL_MCQ_REPLACEMENTS.flatMap((item) => item.brokenRefs),
);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function aylaOriginalMcqContentHash(item = {}) {
  return crypto.createHash("sha256").update(stableJson({
    repairKey: AYLA_ORIGINAL_MCQ_REPAIR_KEY,
    sourceItemId: item.sourceItemId,
    title: item.title,
    taxonomy: item.taxonomy,
    questionHtml: item.questionHtml,
    answers: item.answers,
    correctAnswerId: item.correctAnswerId,
    explanationHtml: item.explanationHtml,
    references: item.references,
  })).digest("hex");
}

function originalQuestionText(row = {}) {
  return [
    row.question_html,
    row.explanation_html,
    JSON.stringify(row.media_refs || []),
  ].join("\n").toLowerCase();
}

export function matchAylaOriginalMcqRepairDefinition(row = {}) {
  const haystack = originalQuestionText(row);
  const matches = AYLA_ORIGINAL_MCQ_REPLACEMENTS.filter((item) => (
    item.brokenRefs.some((ref) => haystack.includes(ref.toLowerCase()))
  ));
  return matches.length === 1 ? matches[0] : null;
}

export function validateAylaOriginalMcqReplacements(
  replacements = AYLA_ORIGINAL_MCQ_REPLACEMENTS,
) {
  const errors = [];
  if (replacements.length !== 13) errors.push("replacement_count_must_equal_13");
  const keys = new Set();
  const aliases = new Set();
  for (const item of replacements) {
    if (!item?.key || keys.has(item.key)) errors.push(`duplicate_or_missing_key:${item?.key || ""}`);
    keys.add(item?.key);
    if (!item?.sourceItemId || aliases.has(item.sourceItemId)) {
      errors.push(`duplicate_or_missing_source_item_id:${item?.sourceItemId || ""}`);
    }
    aliases.add(item?.sourceItemId);
    if (!Array.isArray(item?.answers) || item.answers.length < 4 || item.answers.length > 5) {
      errors.push(`invalid_answer_count:${item?.key || ""}`);
    }
    if (!item?.answers?.some((answer) => answer.answerId === item.correctAnswerId)) {
      errors.push(`missing_correct_answer:${item?.key || ""}`);
    }
    if (!item?.taxonomy?.system_key || !item?.taxonomy?.topic_key) {
      errors.push(`incomplete_taxonomy:${item?.key || ""}`);
    }
    if (!Array.isArray(item?.references) || !item.references.length
      || item.references.some((url) => !String(url).startsWith("https://"))) {
      errors.push(`invalid_references:${item?.key || ""}`);
    }
    const authoredText = [
      item.title,
      item.questionHtml,
      item.explanationHtml,
      JSON.stringify(item.answers),
    ].join("\n").toLowerCase();
    if (/<img\b/i.test(authoredText)) errors.push(`image_dependency:${item?.key || ""}`);
    if (AYLA_BROKEN_IMAGE_MCQ_REFERENCES.some((ref) => authoredText.includes(ref.toLowerCase()))) {
      errors.push(`broken_reference_reused:${item?.key || ""}`);
    }
    if (["uworld", "amboss", "canadaqbank", "aceqbank", "amedex", "mplusx"]
      .some((provider) => authoredText.includes(provider))) {
      errors.push(`third_party_brand_reference:${item?.key || ""}`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    replacementCount: replacements.length,
    contentHashes: Object.fromEntries(
      replacements.map((item) => [item.key, aylaOriginalMcqContentHash(item)]),
    ),
  };
}

export function buildAylaOriginalMcqRepairPreview(rows = []) {
  const validation = validateAylaOriginalMcqReplacements();
  const matches = rows.map((row) => {
    const definition = matchAylaOriginalMcqRepairDefinition(row);
    return {
      originalQuestionId: String(row.id || ""),
      originalStudentQid: String(row.student_qid || ""),
      originalTitle: String(row.title || ""),
      originalStatus: String(row.status || ""),
      matchedBrokenRefs: definition
        ? definition.brokenRefs.filter((ref) => originalQuestionText(row).includes(ref.toLowerCase()))
        : [],
      replacementKey: definition?.key || null,
      replacementSourceItemId: definition?.sourceItemId || null,
      replacementTitle: definition?.title || null,
      replacementTaxonomy: definition?.taxonomy || null,
      replacementContentHash: definition ? aylaOriginalMcqContentHash(definition) : null,
    };
  }).sort((left, right) => (
    left.originalQuestionId.localeCompare(right.originalQuestionId)
  ));
  const perDefinition = new Map(AYLA_ORIGINAL_MCQ_REPLACEMENTS.map((item) => [item.key, 0]));
  for (const match of matches) {
    if (match.replacementKey) {
      perDefinition.set(match.replacementKey, (perDefinition.get(match.replacementKey) || 0) + 1);
    }
  }
  const mappingErrors = [];
  if (matches.length !== 13) mappingErrors.push(`catalog_match_count:${matches.length}`);
  for (const [key, count] of perDefinition) {
    if (count !== 1) mappingErrors.push(`definition_match_count:${key}:${count}`);
  }
  if (matches.some((match) => !match.replacementKey)) mappingErrors.push("ambiguous_or_unmatched_catalog_row");
  const fingerprint = crypto.createHash("sha256").update(stableJson({
    repairKey: AYLA_ORIGINAL_MCQ_REPAIR_KEY,
    originals: matches.map((match) => ({
      id: match.originalQuestionId,
      refs: match.matchedBrokenRefs,
      replacementKey: match.replacementKey,
      replacementContentHash: match.replacementContentHash,
    })),
  })).digest("hex");
  const errors = [...validation.errors, ...mappingErrors];
  return {
    repairKey: AYLA_ORIGINAL_MCQ_REPAIR_KEY,
    ready: errors.length === 0,
    errors,
    originalCount: matches.length,
    replacementCount: AYLA_ORIGINAL_MCQ_REPLACEMENTS.length,
    fingerprint,
    matches,
  };
}
