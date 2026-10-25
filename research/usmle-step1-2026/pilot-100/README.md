# AylaMed 100-question pilot generator

This is a bounded, resumable **private research generator**. It does not write to the live QBank, does not publish questions, and does not place generated items in the release-draft directory.

## Pipeline

1. Read the backend-derived media-priority queue.
2. Plan 100 distinct learning objectives in five bounded planning calls.
3. Generate questions with ten concurrent writer workers.
4. Independently review every question with a separate reviewer call.
5. Quarantine rejected, ambiguous, unsupported, or internally similar items.
6. Balance authored correct-answer positions across A-E.
7. Save accepted outputs under a run-specific private directory.
8. Require the existing factual, similarity, media, clinician, and publication gates before promotion.

## Hard limits

- 100 target questions
- 10 concurrent workers
- 220 maximum API requests
- one retry per request
- input/output token ceilings
- estimated-dollar ceiling based on operator-supplied current model rates
- no automatic merge, deployment, import, or publication

## Execution switches

A real run requires all of the following:

- `OPENAI_API_KEY`
- planner, writer, and reviewer model names, directly or through `AI_MODEL`
- current input/output prices through `AYLA_INPUT_USD_PER_MILLION` and `AYLA_OUTPUT_USD_PER_MILLION`
- `AYLA_PILOT_EXECUTE=yes`
- command-line flag `--execute`

Without both execution switches, the script performs a dry run only.

## Commands

```bash
node scripts/run-usmle-pilot-generator.mjs --dry-run
node scripts/validate-usmle-pilot-generator.mjs

AYLA_PILOT_EXECUTE=yes \
OPENAI_API_KEY=... \
AYLA_PILOT_WRITER_MODEL=... \
AYLA_PILOT_REVIEWER_MODEL=... \
AYLA_PILOT_PLANNER_MODEL=... \
AYLA_INPUT_USD_PER_MILLION=... \
AYLA_OUTPUT_USD_PER_MILLION=... \
node scripts/run-usmle-pilot-generator.mjs --execute
```

## Validated status

The first branch-only dry run completed successfully:

- 25 backend-derived priority clusters loaded
- exactly 100 generation slots planned
- concurrency fixed at 10
- request ceiling fixed at 220
- no API key accessed
- no API request made
- no credits spent
- no live data changed

## Output lifecycle

Generated content remains in `pilot-100/runs/<run-id>/` and is not counted as release-ready. Promotion into `research/usmle-step1-2026/drafts/` requires a separate controlled step after media production, similarity review, factual review, and clinician approval.
