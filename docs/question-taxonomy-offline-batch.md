# Offline question classification preparation

This local tool prepares **proposals**, not approved mappings. It makes no network requests, reads no API key, submits no paid jobs, and cannot modify live content. No server startup or dependency installation is required. Use Node.js 20 or later.

## Prepare a bounded file

Save one authenticated admin question-evidence export from the [review API](question-taxonomy-review.md), then run:

```text
node scripts/question-taxonomy-batch.mjs prepare --input /private/evidence.json --out-dir /private/new-batch --model EXPLICIT_MODEL_ID
```

The output directory must not exist, and its parent must exist. A model identifier is mandatory; the tool does not choose a model, check its availability, verify Batch/Structured Outputs compatibility, or estimate prices. The caller must check those before separately authorizing any paid submission. This command never submits one.

`requests.jsonl` contains one question per `POST /v1/responses` request, with a unique `custom_id` and a strict `text.format` JSON schema. The format follows the official [Batch guide](https://developers.openai.com/api/docs/guides/batch) and [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs), checked September 8, 2026. The maximum output allowance is 2,500 tokens per request; it is not a price or expected-usage estimate. Models consuming this allowance on reasoning may return incomplete output, which validation holds explicitly.

`preparation.json` records the exact question UUIDs, exported server fingerprints, source variant, active override revision, per-request hashes, complete JSONL hash, byte totals and held IDs. Fingerprints are copied from the server, never reconstructed or guessed from local source. These are integrity records, not signatures; keep the original export, manifest and JSONL together under trusted local access. The server will still verify fresh evidence at the eventual reviewed apply step.

Hard limits are 25 prepared questions, 128 KiB per serialized request and 1 MiB per complete JSONL file. Optional `--max-questions`, `--max-request-bytes` and `--max-batch-bytes` can lower, never raise, these limits. Byte checks include the prompt, schema, evidence and line ending. The rough token number is UTF-8 bytes divided by four, rounded up; it is explicitly **not** model tokenization, a context-fit guarantee, or a bill estimate. Files read by the CLI are limited to 32 MiB.

The tool accepts one evidence page of up to 100 questions. It records question-count and byte-budget holdovers plus the export's `has_more`/`next_after` cursor. It never silently truncates a question and does not claim to cover unexported pages. Export the remaining identities/pages separately for subsequent batches; do not blindly resubmit the first 25.

Missing explanation/choices/correct-answer references and blocked or inconsistent NCLEX RN/PN provenance stay held. NCLEX uses each question's exact exported variant and system list. Source images/audio/video are not fetched or sent as media. Their HTML references and media flags are retained, and returned proposals cannot dismiss a detected media flag. A clinician must inspect any referenced media independently before review.

Full stems, all choices and complete explanations are sent once per section as `original_html`, with each choice's original answer ID. Every table, including nested tables, remains verbatim inside that HTML; separate table copies and alternate table-free views are not sent. Styles, whitespace and clinical wording are unchanged. Malformed table markup and media references remain flagged. The original evidence export stays unchanged on disk and must be retained with the preparation artifacts. This is conservative markup inspection, not a general HTML parser or sanitizer. The prompt explicitly treats every source field as untrusted data. Never render generated HTML without the existing authenticated safe renderer.

## Validate separately obtained results

Combine all rows from the downloaded Batch output and error files into one local JSONL file, then run:

```text
node scripts/question-taxonomy-batch.mjs validate --manifest /private/new-batch/preparation.json --results /private/results.jsonl --out /private/proposals.json
```

Results may arrive in any order. Unknown, duplicate or missing custom IDs reject the entire run; so do mismatched question IDs/fingerprints, extra proposal fields, malformed classifications, source-media flag downgrades, or any state other than `NEEDS_REVIEW`. Null taxonomy is an allowed abstention only with an ambiguity flag. Confidence is a model-reported subjective estimate and never an approval threshold.

API errors, refusals and incomplete/malformed responses are recorded with bounded reason codes alongside valid proposals; the artifact is marked `complete:false` and the process exits 2. It never silently drops a failed question. Invalid identity/schema/input causes exit 1 and writes no proposal file. A complete set of schema-valid proposals exits 0. Preparing zero eligible questions also exits 2 while retaining held identities. Existing output files are never overwritten. Logs contain counts and estimates, not clinical text or raw provider errors.

Every emitted artifact remains `NEEDS_REVIEW` and includes `independent_review_required:true`. This command intentionally emits no `review_id`, import `items`, approval flag or apply request. An independent reviewer must inspect each proposal against the full evidence, resolve abstentions/ambiguity/media issues, and deliberately prepare the reviewed manifest in the existing admin panel. The panel's dry-run and exact-payload apply remain mandatory. Structural validation here does not establish clinical correctness or source freshness.

## Privacy and tests

Exports and request JSONL contain full private clinical content. Store generated files outside the repository and do not commit, publish or include them in public logs. File creation uses restrictive permissions where supported; Windows directory ACLs remain the operator's responsibility.

```text
node --test test/question-taxonomy-batch-preparation.test.js
```

Tests use synthetic questions only, exercise the actual offline CLI, and cover full evidence retention, nested/malformed tables, NCLEX holds, count/UTF-8 payload bounds, identity/fingerprint checks, strict schema, refusal/error handling and private logging. No source questions or returned model content are committed.
