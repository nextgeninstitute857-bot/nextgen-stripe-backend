# Reviewed question taxonomy API

These Ayla admin APIs classify existing canonical questions. They do not create questions, publish banks, change answers or scoring rules, or edit student history. Export and preview are read-only. An explicit reviewed batch is committed atomically with per-question audit records.

## Export evidence

`GET /api/ayla/admin/resources/content-taxonomy/questions`

Query parameters:

- `exam_track`: required; accepts existing registry/shell exam aliases.
- `limit`: 1–100, default 100.
- `after`: previous `next_after` UUID, for stable cursor pagination without a total-row cap.
- `source_namespace`: optional exact source filter.
- `question_ids`: optional comma-separated list of at most 100 UUIDs, deduplicated. Mutually exclusive with `after`; `limit` must cover every requested question. Any missing or out-of-exam/source question rejects the whole request with 404.

Response fields are top-level beside `success` and `build`:

```json
{
  "evidence_version": "question-taxonomy-review-v1",
  "exam_track": "usmle-step-2",
  "allowed_systems": ["Internal Medicine"],
  "count": 1,
  "has_more": false,
  "next_after": null,
  "questions": [{
    "id": "00000000-0000-4000-8000-000000000001",
    "student_qid": "NGQ-example",
    "exam_track": "usmle-step-2",
    "status": "approved",
    "title": "Existing question title",
    "question_html": "Full existing question evidence",
    "explanation_html": "Full existing explanation evidence",
    "correct_answer_id": 1,
    "answers": [{"answer_id": 1, "text_html": "Existing answer"}],
    "native": {"system_key": "native-system-id", "subject_key": "native-subject-id", "labels": {}},
    "sources": [{"source_namespace": "example", "source_item_id": "native-id", "collection_id": "00000000-0000-4000-8000-000000000002"}],
    "taxonomy": {},
    "override": null,
    "evidence_fingerprint": "64-character SHA256 from the server",
    "allowed_systems": ["Internal Medicine"],
    "nclex_variant": null,
    "variant_evidence": [],
    "classification_blocked_reason": null
  }]
}
```

The illustrative system list above is abbreviated. Always use the actual returned per-question `allowed_systems`. Native labels and current taxonomy are evidence, not a preapproved proposal. The scope includes registered AylaMed QBank questions, including unpublished preparation work; this export count is not the learner-visible denominator.

Source records also contain safe collection identity fields and a source-file basename. Raw imported `source_data`, provider credentials, and signed delivery URLs are not exported. Full HTML/answer evidence is admin-only and must be rendered safely by an authenticated review interface. Do not put full question content in public logs or review summaries.

## NCLEX source variants

For NCLEX, the page `allowed_systems` is empty. Each question receives the RN or PN categories from the existing reviewed diagnostic blueprint only when all participating QBank source aliases have resolvable, agreeing variant provenance. Collection namespace/title/key/provider/profile and import filename are considered; question clinical wording is never used to infer a variant. Explicit retained question variant hints must agree.

Missing and conflicting provenance returns `classification_blocked_reason: nclex_variant_missing` or `nclex_variant_conflict`, an empty system list, and null `nclex_variant`. These rows remain exportable for source review but cannot be applied. A canonical question shared by conflicting RN/PN sources must be adjudicated before assigning a global taxonomy.

## Prepare and preview a reviewed batch

`POST /api/ayla/admin/resources/content-taxonomy/question-mapping-import`

```json
{
  "exam_track": "usmle-step-2",
  "review_id": "00000000-0000-4000-8000-000000000010",
  "items": [{
    "question_id": "00000000-0000-4000-8000-000000000001",
    "expected_evidence_fingerprint": "copy the exact exported fingerprint",
    "taxonomy": {
      "system_key": "internal_medicine",
      "subsystem_key": "cardiovascular",
      "topic_key": "aortic_stenosis",
      "subtopic_key": "diagnosis",
      "labels": {
        "system": "Internal Medicine",
        "subsystem": "Cardiovascular",
        "topic": "Aortic stenosis",
        "subtopic": "Diagnosis"
      }
    },
    "reason": "Reviewer explanation grounded in the supplied evidence."
  }],
  "apply": false
}
```

Supply 1–100 unique question UUIDs. Keys must exactly equal the lowercase underscore-normalized label. Every label is required, at most 140 characters; sentinel, raw identifier, and stem-shaped labels are rejected. The system label must exactly match an allowed system. Lower clinical labels still require substantive review; structural validation does not establish medical correctness.

An existing active override requires the item's explicit `expected_override_revision` from export. NCLEX items additionally require the exact exported `nclex_variant`. Omit that field for other exams. Each item requires a 10–2,000-character review reason; the authenticated admin identity supplies the actor, never a caller-provided reviewer identity.

Preview returns `valid`, `dry_run`, `applied`, `review_id`, `exam_track`, `fingerprint`, `count`, `updated_count`, `unchanged_count`, and `rows`. Each row includes question UUID, before/after taxonomy, `action` (`update` or `unchanged`), current override revision, review reason, and evidence fingerprint. Preview makes no table, audit, or classification writes.

## Apply and recover uncertain responses

Submit the **same** manifest with `apply:true` and `expected_fingerprint` equal to the preview fingerprint. Any edit requires another preview. The transaction locks sorted collection rows and existing destination registrations before sorted questions, answers, aliases, and overrides. It verifies that the alias parent set did not change during lock acquisition, reads fresh evidence, and rejects stale content/revisions or changed scope before updating classifications. Existing foreign keys plus parent locks block new linked rows during the transaction. Source/classification fingerprints include answers, source aliases, current taxonomy and override state. Local lock and statement timeouts are 5 and 15 seconds respectively; conflicts/timeouts roll back and return 409.

The stored override is active; the question taxonomy explicitly records `source:question_override`, its override UUID, `review_status:approved`, and the review UUID. Canonical question UUIDs and all non-taxonomy question fields are retained. A review receipt stores the normalized manifest, payload fingerprint, authenticated actor, and exact result. Normal registry cache invalidation runs after successful apply.

If a network error leaves the result uncertain, keep the exact sealed apply request and retry it unchanged. The same review UUID and manifest returns the original receipt with `replayed:true`, before checking now-old evidence fingerprints. Do not require a fresh preview of an already applied batch to recover its result. Reusing that UUID with a different manifest fails with 409.

Validation errors return 400, blocked source provenance 422, absent/out-of-scope identities 404, and stale/changed batch conflicts 409. Error bodies are `{success:false,error,details}`; unexpected database details are not exposed. No partial batch remains after an error.

Per-question audit records capture the exact previous question taxonomy and override. Existing override-removal APIs restore the unique approved provider map or saved previous taxonomy. A rollback of one particular batch should compare its current resulting revision against the receipt first, so later reviews are not lost; this endpoint does not implement automatic batch rollback.

Same-canonical-hash metadata reimports preserve reviewed overrides. A deliberate full clinical-content replacement is a separate existing repair workflow; it must review or invalidate prior classification rather than blindly carry it forward. This patch does not change that repair workflow's behavior.

## Validation

Run the pure workflow/classifier and actual-route tests normally. To execute the PostgreSQL transaction tests locally, set `AYLA_TEST_PGLITE_PATH` to an installed `@electric-sql/pglite/dist/index.js`, then run:

```text
node --test test/content-question-taxonomy-review*.test.js test/content-taxonomy-classifier.test.js test/content-taxonomy-progress.test.js test/content-question-taxonomy-import-preservation.test.js
```

The PostgreSQL fixtures are synthetic and never connect to production. They cover pagination beyond 200 questions, explicit UUID scope, mixed paths, facet counts, idempotent replay, current override preservation, stale evidence, rollback after partial work, and RN/PN provenance. Independent sessions contending on a native PostgreSQL server are not simulated by the single-session WASM runtime.
