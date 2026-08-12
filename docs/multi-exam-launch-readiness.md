# AylaMed multi-exam launch readiness

Status date: 2026-08-12

This repository now treats the AylaMed products as five websites, not future placeholders:

| Website | Exam dashboards | Landing identity | Domain setting |
|---|---|---|---|
| USMLE | Step 1, Step 2 CK, Step 3 | Shared USMLE selector | `AYLA_USMLE_PUBLIC_URL` |
| MCCQE | MCCQE | Canadian clinical decisions and dimensions of care | `AYLA_MCCQE_PUBLIC_URL` |
| AMC | AMC | Australian patient groups, disciplines and clinical tasks | `AYLA_AMC_PUBLIC_URL` |
| NCLEX | NCLEX | Clinical judgment, safety, priority and delegation | `AYLA_NCLEX_PUBLIC_URL` |
| PLAB | PLAB | UK clinical practice, communication and safety | `AYLA_PLAB_PUBLIC_URL` |

The standalone sites are pinned to their exam. The shared USMLE site may switch only among Steps 1, 2 CK and 3. Content, progress, entitlements, assessments and analytics retain separate exam namespaces.

## Source taxonomy audit

All audited source questions resolve to `system > subsystem > topic > subtopic`. Native source IDs remain attached for review and re-import.

| Source | Exam placement | Items | Complete hierarchy | Notes |
|---|---|---:|---:|---|
| UWorld Step 2 March 2026 | USMLE Step 2 CK | 4,085 | 4,085 (100%) | 22 clinical systems, 5 disciplines, 8 physician activities |
| UWorld Step 3 March 2026 | USMLE Step 3 | 2,136 | 2,136 (100%) | 22 clinical systems, 5 disciplines, 8 physician activities |
| Amedex AMC 2025 | AMC | 1,463 | 1,463 (100%) | AMC clinical field, patient group, topic and clinical task |
| MPlusX AMC 2025 | AMC | 5,281 | 5,281 (100%) | Generic source titles receive a clinical-presentation topic |
| CanadaQBank MCCQE 2025 | MCCQE | 3,469 | 3,469 (100%) | 6 disciplines, 5 dimensions of care, clinical-presentation topics |
| ACE QBank 2025 | MCCQE | 3,102 | 3,102 (100%) | 22 disciplines, 5 dimensions of care, source clinical topics |
| ACE QBank CDM 2024 | MCCQE supplemental case format | 187 | 187 (100%) | Retained as legacy CDM interaction; never scored as an ordinary SBA |

AMC has 6,744 raw source items and 6,682 unique items after the existing deduplication plan. The taxonomy audit covers all raw items so deduplication cannot create a classification gap.

NCLEX and PLAB have complete exam taxonomy definitions and launch terminology, but no QBank source bundle was supplied in this workspace. They must remain content-empty until an approved bank is added; no placeholder questions are generated.

## MCCQE supplemental boundary

USMLE Step 2 CK resources can be selected inside MCCQE as **Step 2 CK Supplemental** when their publication switch is enabled. They may appear in Content Hub, QBank browsing, Personal Tutor, Roadmap and Revision.

They are excluded from MCCQE diagnostic, assessment, readiness, scoring, weakness and attempt evidence. Watching or studying a Step 2 supplement cannot change the MCCQE readiness score.

## Publication controls

Every exam has a master publication switch. Each QBank collection, Vimeo folder/video, book and flashcard collection can also be controlled individually and by destination.

- Exam OFF overrides every live resource destination.
- The saved resource switch states are not changed while the exam is OFF.
- Turning the exam back ON restores those saved states.
- Existing progress, completed assignments and history remain readable.
- New Content Hub delivery, QBank sessions, Personal Tutor planning, Roadmap generation, diagnostics and assessments are blocked while the exam is OFF.

Admin routes:

- `GET /api/ayla/admin/publication-controls`
- `PUT /api/ayla/admin/publication-controls/exams/:examTrack`
- `PUT /api/ayla/admin/publication-controls/resources/:resourceType/:resourceId`

## Vimeo inventory

The existing reviewed catalogue contains 1,336 videos with complete hierarchy. Folder `30014230` is already included and is not re-imported.

The following private folders are accepted by the validation-first import, but their video inventory and exam assignment cannot be completed without authenticated Vimeo folder metadata:

| Folder ID | Current safe state |
|---|---|
| 30018662 | Awaiting authenticated inventory and exact exam assignment |
| 30159726 | Awaiting authenticated inventory and exact exam assignment |
| 30157751 | Awaiting authenticated inventory and exact exam assignment |
| 30160677 | Awaiting authenticated inventory and exact exam assignment |
| 30154270 | Awaiting authenticated inventory and exact exam assignment |
| 30154281 | Awaiting authenticated inventory and exact exam assignment |
| 30142803 | Awaiting authenticated inventory and exact exam assignment |
| 30127339 | Awaiting authenticated inventory and exact exam assignment |

No folder title, video list or exam placement was guessed. An authenticated preview must retrieve each folder, after which every video must receive an explicit exam and complete hierarchy before import. Step 2 videos assigned to MCCQE will automatically receive the non-scoring supplemental boundary above.

## Release boundary

The code and controls are prepared, but this change does not publish resources, bind domains, push the branch or deploy production. Those remain explicit release actions after the private Vimeo inventory and final content-rights review are complete.
