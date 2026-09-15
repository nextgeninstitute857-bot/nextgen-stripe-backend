# Lecture-grounded assessment generation

Admin > Assessments > Automatic assessment drafts owns two independent, per-course switches.
Default settings are disabled until saved by an authorized assessment creator. The initial editable
weekly schedule is Saturday 17:00 America/New_York. The IANA zone handles EST/EDT. The weekly
period is the previous scheduled cutoff (inclusive) to this cutoff (exclusive), using lecture start
times; all lectures must also have ended by the cutoff. Changing day/time takes effect prospectively.

Weekly defaults: 40 questions, 2 × 20-question/30-minute blocks. Grand defaults: 80 questions,
4 blocks. Counts are editable from 20–120 in multiples of 20. Grand generation starts after the last
lecture of that system in the published roadmap, not based on individual student completion.
Already-finished systems are not backfilled when enabled. Keep the full system roadmap published
before enabling; cancelled/holiday/assessment-only days are not sources.

The canonical roadmap-to-session mapping and published notes determine source eligibility. Missing
sessions, invalid timing, unpublished/short notes, and incomplete lectures hold generation. Weekly
generation never borrows a previous week's notes; grand generation never borrows another system.
There is no automatic student publication, notification or result issuance.

## Quality pipeline

1. Read all selected notes in 10,000-character overlapping chunks; over-budget requests fail explicitly.
2. Extract supported objectives with exact, checked source quotations; flag suspected source errors.
3. Assign at least one objective to each lecture, then spread additional questions across sources.
4. Write small batches of original clinical/experimental one-best-answer questions with five options.
5. Reject malformed items, duplicate options/stems, weak explanations, and out-of-scope evidence.
6. Independently solve each question without exposing the writer's answer key; require agreement and
   approval for medical accuracy, relevance, reasoning and plausible distractors.
7. Separately review explanations against source evidence and option order. One bounded repair is
   allowed; unresolved problems hold the whole run. Save only a complete, AI-reviewed draft.
8. Require explicit tutor-review confirmation before publishing. AI checks do not certify medical
   accuracy, official USMLE equivalence, psychometric validity or exam-readiness prediction.

The existing manual MCQ generation routes use the same quality engine. Notes-based generation
always saves a draft regardless of a legacy publish-now request. Existing assessments are not
regenerated or regraded. New explanations use choice-independent text; the student player removes
legacy option-letter prefixes without changing scoring.

## Operations

The server checks due work each minute. `assessmentAutomation.settings` and `.runs` persist in
the existing LMS database using its serialized atomic mutation queue. The current service uses
one process and its persistent disk; horizontal/multi-process deployment requires a database-backed
distributed claim before scaling this runner. AI calls run outside the database lock.

One deterministic run key per weekly date or course/system prevents duplicates. In-flight reservations
survive restarts; a two-hour stale heartbeat becomes held for explicit retry. Missing notes are
rechecked every 30 minutes while that period is current. A failed quality/API check requires the
admin's Retry same scope action (no unbounded paid retry loop). An explicit older-period retry keeps
the original cutoff/source selection. Schedule/source changes during generation cancel persistence.
An off switch stops new runs and cancels in-flight work at its next checkpoint; a current API call
may finish but no draft is saved after cancellation. Existing drafts remain untouched.

Server kill switch: `NEXTGEN_ASSESSMENT_SCHEDULER_ENABLED=false`. AI configuration uses the existing
key and AI_MODEL; optional ASSESSMENT_AI_MODEL and ASSESSMENT_REVIEW_MODEL override models independently.
Structured Outputs support is required. No API keys enter frontend responses. Per-stage AI usage is
logged even if a later review fails. Settings changes are actor/timestamp attributed.

Tests run the production pipeline with deterministic AI fixtures, plus isolated HTTP auth/settings
tests. They do not spend AI credits or create production assessments. Tutor evaluation of generated
drafts remains required, particularly before making claims about exam-level difficulty.
