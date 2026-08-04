# AylaMed USMLE Step 1 2026 Original QBank Research

Status: **private research branch only**  
Production status: **not merged, not deployed, not published to students**

## Objective

Build an original, clinician-reviewable USMLE Step 1 question bank that covers:

`exam -> system -> subsystem -> topic -> subtopic -> learning objective -> media requirement`

The project uses current public USMLE materials as the authoritative blueprint. Licensed proprietary QBank material may be used only to identify broad coverage signals inside the owner's private environment. It must never be copied or closely paraphrased.

## Confirmed 2026 priorities

1. **Enhanced nutrition assessment across all Step exams.** The USMLE announced enhanced nutrition-science content beginning in June 2026. Step 1's published discipline specifications list Nutrition at 15-20%.
2. **Integrated foundational science.** Step 1 remains organized by system and process, with most items requiring application of foundational mechanisms in clinical contexts.
3. **Graphic and tabular interpretation.** Public USMLE guidance states that many Step 1 items require interpretation of graphic, tabular, gross-pathology, microscopic, or normal-specimen material.
4. **Special populations explicitly highlighted in the 2026 public outline:**
   - older adults and geriatric medicine;
   - recently returning military personnel, veterans, and families of deployed personnel;
   - people requiring health and gender-affirming care, including nonbinary and transgender patients;
   - patients with disabilities;
   - prescription-drug use and adverse effects.
5. **Communication and interpersonal skills remain examinable.** Public Step 1 specifications allocate 6-9% to this competency area.
6. **New 2026 delivery software.** Step 1 uses fourteen 30-minute blocks with no more than 20 items per block for examinations beginning May 14, 2026. The total item count and exam length are unchanged. AylaMed practice blocks should support this pacing model.

## Source hierarchy

1. Current USMLE/NBME/FSMB public material
2. Peer-reviewed consensus statements and current professional guidelines
3. Government and academic medical sources
4. Reputable educational reviews
5. Social-media and forum reports as **unverified signals only**

Social reports never establish that a topic is tested. They can only trigger a check against authoritative sources and the private coverage matrix.

## Copyright and originality controls

Every generated question must:

- use a new clinical scenario and independently selected patient details;
- use original answer choices and distractor logic;
- include an independently written explanation and wrong-choice analysis;
- cite medical sources used to verify the concept;
- use only original, public-domain, or properly licensed media;
- carry a similarity-review status before medical review;
- remain private until clinician approval.

The following are prohibited:

- copying or lightly rewriting UWorld, AMBOSS, NBME, or other proprietary stems;
- copying explanations, option sets, educational objectives, tables, screenshots, or illustrations;
- presenting AylaMed as approved, affiliated with, or sponsored by another QBank;
- automatic publication of generated content.

## Answer-position and distractor controls

- Authored correct-answer positions are balanced across A-E rather than concentrated in A or B.
- No authored answer position may exceed 30% within an option-count group.
- The same authored answer position may not repeat more than three consecutive times.
- Student delivery must reshuffle options independently for each question and attempt using a server-issued non-public attempt identifier.
- Option IDs remain immutable, scoring occurs server-side by option ID, and `correct_option_id` must not be exposed before submission.
- A resumed attempt must receive the same option order it had originally.
- Distractors must remain medically plausible and must not reveal the answer through length, grammar, specificity, or obviously opposite wording.

## Draft lifecycle

`research_seed -> generated_private_draft -> factual_review -> similarity_review -> media_review -> clinician_review -> approved_private -> separately authorized publication`

No stage in this branch performs production writes.

## Current work packages

- `source-register.json`: authoritative and signal sources with evidence status.
- `priority-deltas.json`: 2026-specific priority matrix and media requirements.
- `answer-order-policy.json`: authored-position limits and secure per-attempt student shuffling requirements.
- `coverage/`: five-level coverage matrices with learning objectives and media requirements.
- `drafts/`: original draft MCQs, answers, explanations, distractor rationales, references, and review gates.
- `media/`: original schematic SVG files only; no copied clinical images.
- `scripts/rebalance-usmle-answer-positions.mjs`: deterministic source-draft rebalancing while preserving option IDs and scoring correctness.
- `scripts/validate-usmle-research-drafts.mjs`: fail-closed validation of draft status, taxonomy, answer structure, references, media ownership, and publication blocking.
- `scripts/validate-usmle-answer-positions.mjs`: hard validation of authored answer-position balance and simulated student-facing shuffling.
- future audit tooling: compare a read-only backend export against the five-level matrix and produce missing-topic and missing-media queues.

## Completed research batches

- **Batch 001:** nutrition, anemia, post-bariatric physiology, growth, food insecurity, veterans, disability-related complications, gender-affirming physiology, and geriatric polypharmacy.
- **Batch 002:** respiratory and renal mechanisms, including tubular transport, renal hemodynamics, acid-base compensation, CKD mineral-bone physiology, pulmonary mechanics, neonatal surfactant deficiency, oxygen transport, and V/Q mismatch.
- **Batch 003:** cardiovascular and endocrine mechanisms, including aortic-stenosis pressure-volume loops, tamponade ventricular interdependence, dynamic outflow obstruction, AV nodal reentry, primary hyperaldosteronism, DKA potassium balance, pregnancy-related thyroid binding, and 21-hydroxylase deficiency.
- **Batch 004:** gastrointestinal and nervous-system mechanisms, including achalasia, pancreatic CFTR physiology, portal-systemic collateral anatomy, bile-acid malabsorption, spinal tract localization, basal-ganglia circuitry, neuromuscular-junction physiology, and internuclear ophthalmoplegia.
- **Batch 005:** hematology and immunology mechanisms, including erythrocyte membrane and redox disorders, thrombotic microangiopathy, primary hemostasis, class switching, phagocyte oxidative killing, terminal complement, and immune-complex disease.
- **Batch 006:** musculoskeletal, dermatologic, and reproductive mechanisms, including collagen quantity versus quality, dystrophin-mediated sarcolemmal stability, compartment perfusion, pemphigus immunopathology, ovarian failure feedback, androgen-receptor signaling, tubal implantation, and androgenetic molar pregnancy.
- **Batch 007:** remaining cross-system foundations, including oxygen-dependent aminoglycoside uptake, influenza reassortment, competitive antagonism, saturable phenytoin kinetics, likelihood-ratio reasoning, lead-time bias, qualified interpretation, and mitochondrial heteroplasmy.

Current private-draft inventory: **60 original MCQs and 57 original SVG teaching graphics**.

## Required production gate

Before any generated question enters the live QBank, it must pass:

1. taxonomy completeness;
2. valid single-best-answer structure;
3. authored answer-position balance and secure student-facing shuffling;
4. factual-reference verification;
5. automated and human similarity review;
6. media ownership/licence verification;
7. clinician review and approval;
8. disabled/private import followed by a separate publication decision.
