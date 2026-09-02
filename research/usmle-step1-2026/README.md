# AylaMed USMLE Step 1 2026 Original QBank Research

Status: **private research branch only**  
Production status: **not merged, not deployed, not imported, not published to students**

## Objective

Build an original, clinician-reviewable USMLE Step 1 question bank mapped through:

`exam -> system -> subsystem -> topic -> subtopic -> learning objective -> media requirement`

Current public USMLE materials are the authoritative blueprint. Private QBank evidence may identify broad coverage signals only; proprietary wording, answer choices, explanations, screenshots, and media must never be copied or closely paraphrased.

## Backend evidence audit

The authenticated read-only export patched on August 4, 2026 contains:

- **7,937 question records**
- **2,647 unique normalized title clusters**
- **640 records omitted by the limited evidence route**
- ZIP SHA-256: `82803c11b441b35cbfd645da17256dcb827c5b072cb8741e53234af9ec8ae27e`

The export drives coverage prioritization and lexical originality screening only.

## Copyright, review, and publication controls

Every question requires a new scenario, original answer choices, plausible distractors, independently written explanations, authoritative references, original or properly licensed media, automated and human similarity review, factual review, media review, and clinician approval.

Draft lifecycle:

`research_seed -> generated_private_draft -> factual_review -> similarity_review -> media_review -> clinician_review -> approved_private -> separately authorized publication`

No stage in this branch performs live QBank writes or automatic publication.

## Answer-position controls

- Correct-answer positions are balanced across A–E.
- No authored position may exceed 30% within an option-count group.
- The same authored position may not repeat more than three times.
- Student options reshuffle independently for each question and attempt using a non-public attempt identifier.
- Option IDs remain immutable; scoring and correct-answer IDs remain server-side.
- Resumed attempts preserve their original option order.

Expected distribution after Batch 015: **A 40, B 39, C 39, D 39, E 39**.

## Completed research batches

1. Nutrition and special populations.
2. Respiratory and renal mechanisms.
3. Cardiovascular and endocrine mechanisms.
4. Gastrointestinal and nervous-system mechanisms.
5. Hematology and immunology.
6. Musculoskeletal, dermatology, and reproduction.
7. Multisystem foundations, pharmacology, microbiology, biostatistics, communication, and genetics.
8. First backend-driven media priorities.
9. Second backend-driven media priorities.
10. First accelerated in-chat 20-question block.
11. Second accelerated in-chat 20-question block.
12. Third accelerated in-chat 20-question block.
13. Fourth accelerated in-chat 20-question block.
14. Final 20-question block of the original accelerated pilot: familial hypercholesterolemia; VSD/Eisenmenger physiology; coarctation collaterals; minimal change disease; IgA nephropathy; type IV RTA; hemophilia A; CML; classical Hodgkin lymphoma; 22q11.2 deletion syndrome; ADA-SCID; Alzheimer APP processing; Huntington anticipation; childhood absence epilepsy; organophosphate toxicity; acetaminophen toxicity; FAP; hereditary hemochromatosis; MEN2; and primary adrenal insufficiency.
15. First post-pilot expansion block: dilated cardiomyopathy remodeling; glioblastoma hypoxia/VEGF; meningioma origin and psammoma bodies; PSC; PBC; pancreatic desmoplasia; cholera toxin; diphtheria toxin; tetanus; botulism; Wiskott–Aldrich syndrome; Lambert–Eaton syndrome; acromegaly dynamic testing; endometriosis histology; lithium nephrogenic DI; digoxin toxicity; Klinefelter syndrome; Robertsonian Down syndrome; osteoblastic prostate metastases; and warfarin skin necrosis.

## Accelerated-bank status

Batches 010–014 completed the planned **100-question pilot**. Batch 015 adds the first **20-question post-pilot expansion**, bringing Batches 010–015 to **120 original questions**.

A separate bounded API generator remains unexecuted and has spent no API credits.

## Expected private inventory after Batch 015

- **196 original private-draft MCQs**
- **193 original SVG teaching graphics / media references**
- **100 draft JSON files**
- Batch 015 positions: **A 4, B 4, C 4, D 4, E 4**
- Within-Batch-015 duplicate flags: **0**
- Publication and live-write blocks preserved

## Full-ZIP lexical similarity status

### Batch 014

- **158,740 external comparisons**
- exact normalized matches: **0**
- close-paraphrase quarantine flags: **0**
- maximum external five-token Jaccard: **0.032258**
- maximum external character ratio: **52.131%**

### Batch 015

- **158,740 external comparisons**
- exact normalized matches: **0**
- close-paraphrase quarantine flags: **0**
- maximum external five-token Jaccard: **0.037383**
- maximum external character ratio: **52.781%**

These are lexical screens only. Human semantic/copyright review, factual review, media review, and clinician approval remain mandatory.

## Required production gate

Before any question enters the live QBank, it must pass taxonomy completeness, single-best-answer validation, answer-position and shuffle validation, factual-reference verification, full automated and human similarity review, media ownership verification, clinician approval, disabled/private import, and a separate publication decision.

## Batch 015 commit layout

For bounded Git API publication, the 20-question Batch 015 draft is stored in five ordered four-question JSON files. This changes only repository packaging; the validated question content, answer-position distribution, audits, taxonomy, and media references are unchanged.
