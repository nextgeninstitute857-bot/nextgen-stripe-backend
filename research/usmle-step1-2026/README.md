# AylaMed USMLE Step 1 2026 Original QBank Research

Status: **private research branch only**  
Production status: **not merged, not deployed, not imported, not published to students**

## Objective

Build an original, clinician-reviewable USMLE Step 1 question bank mapped through:

`exam -> system -> subsystem -> topic -> subtopic -> learning objective -> media requirement`

Current public USMLE materials are the authoritative blueprint. Licensed proprietary QBank material may identify broad coverage signals only inside the owner's private environment; wording, explanations, option structures, objectives, screenshots, and media must never be copied or closely paraphrased.

## Backend evidence audit

The authenticated read-only export supplied August 4, 2026 contains:

- **7,937 question records**
- **2,647 unique title clusters**
- **786 explicit media-required candidates**
- **640 questions omitted by the limited evidence route**

The export drives coverage prioritization and originality screening only. All AylaMed learner-facing material is independently created from official exam specifications and public medical evidence.

## 2026 priorities

- enhanced nutrition assessment;
- integrated foundational mechanisms in clinical contexts;
- graphic, tabular, gross-pathology, microscopic, and specimen interpretation;
- geriatrics and polypharmacy;
- veterans, military families, disability-related care, gender-affirming care, food insecurity, and communication;
- fourteen 30-minute blocks with no more than 20 items per block for Step 1 examinations beginning May 14, 2026.

## Source hierarchy

1. Current USMLE/NBME/FSMB public material
2. Peer-reviewed consensus statements and professional guidelines
3. Government and academic medical sources
4. Reputable educational reviews
5. Social/forum reports as unverified signals only

## Copyright, review, and publication controls

Every question requires a new scenario, original answer choices, plausible distractors, independently written explanations, authoritative references, original/public-domain/properly licensed media, similarity review, factual review, media review, and clinician approval.

Draft lifecycle:

`research_seed -> generated_private_draft -> factual_review -> similarity_review -> media_review -> clinician_review -> approved_private -> separately authorized publication`

No stage in this branch performs live QBank writes or automatic publication.

## Answer-position controls

- Correct-answer positions are balanced across A-E.
- No authored position may exceed 30% within an option-count group.
- The same authored position may not repeat more than three times.
- Student options must reshuffle independently for each question and attempt using a non-public attempt identifier.
- Option IDs remain immutable; scoring and correct-answer IDs remain server-side.
- Resumed attempts must preserve their original option order.
- Distractors must be medically plausible and must not reveal the answer through length, grammar, specificity, or obviously opposite wording.

Latest validated authored distribution after Batch 013: **A 32, B 31, C 31, D 31, E 31**. Longest same-position run: **3 or fewer**.

## Completed batches

1. Nutrition, anemia, post-bariatric physiology, growth, food insecurity, veterans, disability-related complications, gender-affirming physiology, and geriatric polypharmacy.
2. Respiratory and renal foundational mechanisms.
3. Cardiovascular and endocrine foundational mechanisms.
4. Gastrointestinal and nervous-system foundational mechanisms.
5. Hematology and immunology foundational mechanisms.
6. Musculoskeletal, dermatologic, and reproductive mechanisms.
7. Multisystem foundations, microbiology, pharmacology, biostatistics, communication, and mitochondrial genetics.
8. First backend-driven media-priority gaps: bilateral vestibular schwannoma/NF2, sarcoid calcitriol physiology, clear-cell RCC/VHL-HIF, ACL biomechanics, sickle functional asplenia, psoriasis IL-23/Th17, allergic bronchopulmonary aspergillosis, and invasive Aspergillus angioinvasion.
9. Second backend-driven media-priority gaps: dominant superior-division MCA infarction, membranous nephropathy, poststreptococcal glomerulonephritis, tension pneumothorax, bullous pemphigoid, femoral-neck fracture vascular anatomy, day 3-7 myocardial-infarction rupture risk, and anti-TNF tuberculosis reactivation.
10. First 20-question in-chat accelerated batch: RANKL blockade, pneumococcal opsonization, mu-opioid respiratory signaling, meningococcal LOS/TLR4, Hashimoto Hürthle cells, HIT, antral H. pylori physiology, Graves uptake, S. gallolyticus and colon disease, Lynch mismatch repair, HFrEF neurohormonal remodeling, atrial-fibrillation appendage stasis, BRCA homologous recombination, HSV temporal-limbic disease, fimbrial STIC, hepatorenal hemodynamics, gout inflammasome signaling, EGFR-driven lung adenocarcinoma, myeloma cast nephropathy, and flecainide use dependence.
11. Second 20-question in-chat accelerated batch: UIP/TGF-beta fibrosis, infantile hemangioma/propranolol, HPV-positive oropharyngeal carcinoma, posterior urethral valves, allergic contact dermatitis, melanoma Breslow depth, Fanconi syndrome, osteosarcoma, EBV infectious mononucleosis, Kaposi sarcoma, osteoarthritis, actinic keratosis, scabies, obstructive atelectasis, keloids, Erb palsy, alpha-1 antitrypsin deficiency, Crohn-associated enteric hyperoxaluria, pituitary chiasmal compression, and pancreatitis fat saponification.
12. Third 20-question in-chat accelerated batch: aortic-dissection malperfusion, pleural pseudoexudates, ARDS diffuse alveolar damage, scaphoid vascular anatomy, struvite stones, Burkitt MYC, APL differentiation therapy, AL amyloid, falciparum sequestration, carcinoid first-pass physiology, ADPKD aneurysm risk, pheochromocytoma blockade sequence, cerebral toxoplasmosis, acute cholecystitis, beta-thalassemia, preeclampsia, aplastic anemia, primary syphilis, ASD fixed splitting, and aortic-regurgitation pressure-volume physiology.
13. Fourth 20-question in-chat accelerated batch: Tetralogy hypercyanotic spells, mitral-stenosis gradients, celiac antigen presentation, Wilson copper transport, rheumatoid pannus/RANKL, lupus immune complexes, multiple-sclerosis CNS demyelination, WPW preexcitation, testicular torsion, hyperparathyroid bone signaling, Cushing mineralocorticoid effects, anti-GBM disease, granulomatosis with polyangiitis, Meckel bleeding, Guillain-Barre molecular mimicry, Fragile X silencing, congenital long QT, tuberous-sclerosis mTOR signaling, Whipple disease, and rheumatic-fever molecular mimicry.

## In-chat 100-question pilot

The in-chat accelerated pilot has completed **80 of 100** planned original questions across Batches 010-013. Each 20-question cycle uses backend evidence only for coverage signals and originality review, then adds de novo questions, original graphics, complete five-level taxonomy, references, distractor rationales, publication blocks, and repository validation.

A separate bounded API generator remains available but has not been executed and has spent no API credits.

## Current inventory and validation

- **156 original private-draft MCQs**
- **153 original SVG teaching graphics / media references**
- **94 research JSON files**
- Batch 012 authored positions: **A 4, B 4, C 4, D 4, E 4**
- Batch 013 authored positions: **A 4, B 4, C 4, D 4, E 4**
- intra-batch duplicate flags: **0**
- authored-position balance passed locally
- student-delivery shuffle requirement preserved
- media paths and SVG XML parsing passed locally
- publication and live-write blocks preserved

## External similarity gate

The title inventory and 786 explicit media-candidate stems were available for targeted screening during Batches 012 and 013. The raw 7,937-stem ZIP was not mounted in this runtime, so these batches deliberately do **not** claim a completed full-export Jaccard result.

Before any disabled import approval, both batches must be rerun against the complete 7,937-stem export and pass automated and human close-paraphrase review. Until then they remain private, draft, and publication-blocked.

## Required production gate

Before any generated question enters the live QBank, it must pass taxonomy completeness, single-best-answer validation, answer-position and shuffle validation, factual-reference verification, automated and human similarity review, media ownership verification, clinician approval, disabled/private import, and a separate publication decision.
