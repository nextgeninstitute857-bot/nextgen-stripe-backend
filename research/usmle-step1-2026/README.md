# AylaMed USMLE Step 1 2026 Original QBank Research

Status: **private research branch only**  
Production status: **not merged, not deployed, not published to students**

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

The export drives coverage prioritization only. All AylaMed learner-facing material is independently created from official exam specifications and public medical evidence.

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

Latest validated authored distribution: **A 14, B 14, C 14, D 13, E 13**. Longest same-position run: **3**.

## Completed batches

1. Nutrition, anemia, post-bariatric physiology, growth, food insecurity, veterans, disability-related complications, gender-affirming physiology, and geriatric polypharmacy.
2. Respiratory and renal foundational mechanisms.
3. Cardiovascular and endocrine foundational mechanisms.
4. Gastrointestinal and nervous-system foundational mechanisms.
5. Hematology and immunology foundational mechanisms.
6. Musculoskeletal, dermatologic, and reproductive mechanisms.
7. Multisystem foundations, microbiology, pharmacology, biostatistics, communication, and mitochondrial genetics.
8. First backend-driven media-priority gaps: bilateral vestibular schwannoma/NF2, sarcoid calcitriol physiology, clear-cell RCC/VHL-HIF, ACL biomechanics, sickle functional asplenia, psoriasis IL-23/Th17, allergic bronchopulmonary aspergillosis, and invasive Aspergillus angioinvasion.

## Current inventory and validation

- **68 original private-draft MCQs**
- **65 original SVG teaching graphics**
- **50 draft JSON files**
- **0 validation errors**
- **0 validation warnings**
- student-delivery shuffle simulation passed

## Required production gate

Before any generated question enters the live QBank, it must pass taxonomy completeness, single-best-answer validation, answer-position and shuffle validation, factual-reference verification, automated and human similarity review, media ownership verification, clinician approval, disabled/private import, and a separate publication decision.