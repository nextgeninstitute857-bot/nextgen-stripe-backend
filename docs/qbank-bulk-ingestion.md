# v238 private QBank bulk ingestion

This workflow removes the need to upload each question image through the CRM.
It sends one prepared ZIP per bank to private R2 staging, then reuses that exact
finalized upload for:

1. question preview;
2. disabled-draft question import;
3. exact stem, answer-choice and explanation media matching;
4. safe missing-link reconciliation after a read-only audit.

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

ACE CDM remains blocked from the ordinary MCQ importer, and eTG remains outside
the QBank workflow.
