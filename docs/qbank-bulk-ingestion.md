# v239 QBank readiness with v240 legacy CDM case ingestion

This workflow removes the need to upload each question image through the CRM.
It sends one prepared ZIP per bank to private R2 staging, then reuses that exact
finalized upload for:

1. question preview;
2. disabled-draft question import;
3. exact stem, answer-choice and explanation media matching;
4. safe missing-link reconciliation after a read-only audit.

v239 also accepts a reviewed media-alias file per bank. An alias may only add
an exact packaged asset path to an existing question/media reference; it cannot
change the question, answer, placement, scoring or student visibility. The ZIP
hash and alias fingerprint are bound together in the resumable state file.

It never approves a collection, enables a student destination, publishes
content, or writes directly to PostgreSQL. External YouTube/Vimeo links remain
review metadata and are not copied. Packaged video processing is skipped unless
the preview finds matched video files and the manifest explicitly enables it.

## Safety gate

Copy `qbank-bulk-manifest.example.json`, point each `bundle_zip` at a prepared
ZIP, and record the current rights-review state:

- `unverified`
- `owned`
- `licensed`
- `authorized`

`unverified` permits private staging, preview and disabled-draft question/media
preparation. It blocks collection approval and every student destination. Set a
verified status only after AylaMed has confirmed that it owns, licenses or is
otherwise authorized to redistribute the bank. A repeat import cannot silently
downgrade a previously verified collection.

## Local validation

```sh
node scripts/run-qbank-bulk-draft-import.mjs \
  --manifest /secure/path/qbank-manifest.json
```

This reads and hashes the local ZIPs. It makes zero network requests.

## Full local rehearsal

```sh
node scripts/run-qbank-bulk-draft-import.mjs \
  --manifest /secure/path/qbank-manifest.json \
  --rehearse-local
```

The rehearsal runs the real streaming preview and draft importer against every
prepared ZIP, simulates exam-scoped duplicate reuse in memory, validates exact
stem/answer/explanation placement, and emits a quarantine report. It performs
zero network requests and zero database writes.

Each optional `media_aliases_file` is a private JSON file:

```json
{
  "aliases": [
    {
      "source_item_id": "3114",
      "media_ref": "wp-content/uploads/example.bmp",
      "asset_path": "prepared-bank/3114_example.bmp",
      "placement": "question",
      "evidence": "question_id_and_reference"
    }
  ]
}
```

Supported evidence values are `question_id_and_reference`,
`unique_semantic_suffix`, `unique_closest_semantic_suffix`, and
`admin_verified`. Missing or ambiguous assets remain quarantined; the runner
never guesses them.

## Private-draft execution

```sh
export AYLAMED_CRM_BASE_URL="https://your-backend.example"
export AYLAMED_CRM_ADMIN_TOKEN="your-existing-admin-jwt"
node scripts/run-qbank-bulk-draft-import.mjs \
  --manifest /secure/path/qbank-manifest.json \
  --execute-private-drafts
```

The runner stores resumable upload and job IDs in a state file under the
operating-system temporary directory by default. Use `--state-file` to choose a
durable private location. Tokens, archive passwords and commercial archives
must not be added to Git.

The supplied mapping is intentionally:

- AMBOSS archive: USMLE Step 1
- CanadaQBank `cqb-usmlestep1-2025` archive: USMLE Step 1
- Amedex: AMC
- MPlusX: AMC

ACE CDM remains blocked from the ordinary MCQ importer. In v240 it may be
prepared only with:

```json
{
  "exam_track": "mccqe",
  "source_format": "legacy_cdm_write_in_v1",
  "destinations": ["aylamed_cdm", "roadmap"]
}
```

That dedicated path discards the source `I know this / I don't know this`
controls, preserves the 144 case groups and 187 ordered steps, and keeps all
content private until rights, collection approval, and both delivery
destinations are explicitly enabled. eTG remains outside the QBank/CDM
workflow.
