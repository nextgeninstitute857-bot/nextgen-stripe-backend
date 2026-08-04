# AylaMed USMLE Step 1 2026 Original QBank Research

Status: **private research branch only**  
Production status: **not merged, not deployed, not imported, not published to students**

## Objective

Build an original, clinician-reviewable USMLE Step 1 question bank mapped through:

`exam -> system -> subsystem -> topic -> subtopic -> learning objective -> media requirement`

Current public USMLE materials are the authoritative blueprint. Private QBank evidence may identify broad coverage signals only; proprietary wording, answer choices, explanations, screenshots, and media must never be copied or closely paraphrased.

## Backend evidence audit

The authenticated read-only export supplied August 4, 2026 contains:

- **7,937 question records**
- **2,647 unique title clusters**
- **786 explicit media-required candidates**
- **640 records omitted by the limited evidence route**

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

Expected distribution after Batch 014: **A 36, B 35, C 35, D 35, E 35**.

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
14. Final accelerated in-chat 20-question block: familial hypercholesterolemia; VSD/Eisenmenger physiology; coarctation collaterals; minimal change disease; IgA nephropathy; type IV RTA; hemophilia A; CML; classical Hodgkin lymphoma; 22q11.2 deletion syndrome; ADA-SCID; Alzheimer APP processing; Huntington anticipation; childhood absence epilepsy; organophosphate toxicity; acetaminophen toxicity; FAP; hereditary hemochromatosis; MEN2; and primary adrenal insufficiency.

## Accelerated 100-question pilot

Batches 010–014 now contain **100 of 100 planned original pilot questions**. Each item includes five-level taxonomy, five answer choices, a single best answer, complete distractor rationales, authoritative verification references, an original SVG teaching graphic, and publication blocks.

A separate bounded API generator remains unexecuted and has spent no API credits.

## Expected private inventory after Batch 014

- **176 original private-draft MCQs**
- **173 original SVG teaching graphics / media references**
- **95 draft JSON files**
- Batch 014 positions: **A 4, B 4, C 4, D 4, E 4**
- Within-Batch-014 exact duplicate stems: **0**
- Publication and live-write blocks preserved

## Similarity status

Batches 012–013 were lexically compared against all 7,937 exported stem signals:

- 317,480 external comparisons
- 0 exact normalized matches
- 0 quarantine flags at the configured lexical thresholds
- maximum external five-token Jaccard: 0.025316
- maximum external character ratio: 54.068%

This remains lexical screening; human semantic and copyright review is still required.

The full 7,937-stem scan for **Batch 014 is pending the user's ZIP patch**. Batch 014 is private and publication-blocked until that scan and subsequent human review pass.

## Required production gate

Before any question enters the live QBank, it must pass taxonomy completeness, single-best-answer validation, answer-position and shuffle validation, factual-reference verification, full automated and human similarity review, media ownership verification, clinician approval, disabled/private import, and a separate publication decision.
