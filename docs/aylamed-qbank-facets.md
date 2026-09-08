# QBank facet integration contract

The library change does not register routes. `server.js` integration is owned separately.

## Routes and trusted scope

Use the same authenticated owner/student/exam entitlement, published bank resolution, private destination scope, presentation policy, source profile, and supplemental bank rules already used by catalog and session creation. Never use arbitrary requested collections before those checks. For destination exams with supplemental banks, combine all selected bank IDs **within each normalized source exam** before querying, then merge source-exam responses. Question IDs are unique within the COUNT(DISTINCT q.id) pool; q.exam_track makes distinct normalized source-exam groups disjoint.

```js
import { getContentQbankFacets, countContentQbankQuestions } from './lib/content-registry-postgres.js';
import { mergeAylaQbankFacets } from './lib/aylamed-qbank-facets.js';
```

`getContentQbankFacets({examTrack, destination: 'aylamed_qbank', destinationScope, sourceProfile, collectionIds, filters, history})` returns:

```js
{
  source_exam_track, taxonomy_version, question_count,
  nodes: [{
    id, label, level, parent_id,
    path: [{id, label, level, key}],
    selection_path: {system_key, subsystem_key?, topic_key?, subtopic_key?},
    question_count, mapping_status, unmapped_question_count,
    children: [], children_incomplete?
  }],
  supported_statuses: ['all', 'unused', 'incorrect', 'marked'],
  coverage: {
    reviewed_question_count, source_grouped_question_count,
    unmapped_question_count, deeper_mapping_needed_question_count
  }
}
```

Levels are lowercase `system`, `subsystem`, `topic`, `subtopic`. Mapping status is `reviewed`, `source_grouping`, `unmapped`, or `mixed`. Selection paths use exact stored keys; IDs are stable hashes of exam and exact ancestry, independent of counts and label changes. `taxonomy_version` is a representation fingerprint, including current counts; it is not an immutable curriculum version or an authorization token.

`mergeAylaQbankFacets(results, {examTrack: destinationExam})` merges distinct source exam groups, rekeys nodes under the destination, sums common raw paths and coverage, and rejects repeated `source_exam_track` groups. It must not receive separate results per bank because bank aliases can overlap.

GET `/api/ayla/qbank/facets` should accept existing identity/bank inputs plus `difficulty` and `status` and pass these as `filters`. Omit selection_paths here so all currently eligible branches remain available while the learner changes selection. Resolve history from the destination student's practice records. Node counts then describe the current bank, difficulty, and history scope.

POST `/api/ayla/qbank/selection-count` accepts identity/bank inputs plus `filters:{difficulty,status,selection_paths}`. `countContentQbankQuestions` accepts the same options as facets and returns an integer. Sum its results only across disjoint normalized source exam groups. Return `{question_count,taxonomy_version}`; use the corresponding facet representation version, or omit/null it until the route has that representation. Do not advertise a content revision that was not calculated. Recount at creation rather than trusting the client count/version.

## Session selection patch

`listContentQbankQuestions` retains all old options and adds:

```js
selectionPaths: filters.selection_paths,
status: filters.status || 'all',
history: scopedHistory,
```

Pass these into both ordinary-practice calls inside `aylaSelectQbankSessionQuestions` (named-bank/source-exam path and ordinary fallback path). Pass `scopedHistory` into that helper from the authenticated session-create route. Baseline diagnostic and roadmap assignment paths should retain their explicitly controlled selection, with their current empty scalar filters and status all. Do not pass user custom facets to diagnostic discovery or exact roadmap-question loading.

`normalizeAylaQbankFilters` retains legacy scalar fields and now preserves status/selection_paths in the saved session. Legacy scalars are ANDed with the multi-branch union if both are supplied. Omitted selection_paths preserves old/all behavior; explicit `[]` means no content. Null, malformed paths, non-contiguous ancestry, array-valued scalars, and unsupported statuses fail with 400. An empty/inadequate result must never trigger a mixed-pool fallback. The route should reject explicit empty selections and quantities above the authoritative count before creating a session.

## History semantics

`history` is a **server-only** argument, never copied from request JSON:

```js
{ seenQuestionIds: [], incorrectQuestionIds: [], markedQuestionIds: [] }
```

For non-all status, all three arrays must be supplied. Each contains scoped canonical Content Registry question UUIDs. Empty Incorrect/Marked arrays produce zero results. Filtering does not reuse the existing 5,000-ID bounded novelty-sort list; up to 100,000 IDs are supported without silent truncation. Incomplete/invalid history fails closed.

Recommended route semantics: Unused means never included in that destination student's prior practice sessions; Incorrect means the latest *graded* attempt is wrong (exclude unfinished sealed Test answers); Marked reflects active question marks, not bookmarks unless the UI explicitly labels them jointly. Scope history by owner + student + destination exam, including that student's supplemental question IDs; do not read other destination profiles or other learners. The route owns the final semantic choice and must apply the same history to facets, count, and creation.

## Coverage and labels

The query exposes existing approved provider-map labels, explicit question overrides, and approved AylaMed-owned authored taxonomy through all four levels where labels/keys exist. Source adapters preserve only their source system/subsystem labels. Their lower topic labels may contain question stems or generated tasks; they are not promoted into clinical topics. Unknown fields remain honest source groupings. No classifier is called, and no clinical concept is inferred from question text or raw lower keys.

If some direct parent content lacks representable children, the incomplete child list is withheld and the whole parent stays selectable (`children_incomplete:true`). Whenever children are supplied, their counts exactly sum to the parent, so deselecting a child cannot silently discard a hidden remainder. Coverage flags identify what still needs editorial mapping.

## Verification

Normal regression: `node --test test/aylamed-qbank-facets.test.js test/aylamed-qbank.test.js`.

Optional self-contained PostgreSQL execution test: install `@electric-sql/pglite` in a separate local validation directory; set `AYLA_TEST_PGLITE_PATH` to its `dist/index.js`, then run `node --test test/aylamed-qbank-facets-postgres.test.js`. This test creates a fresh in-memory PostgreSQL database and never connects to a service. It exercises cross-bank duplicate IDs, approved/draft/disabled/private/media/source-year/item-format/exam boundaries, OR branches, AND facets, status history, explicit zero pools, SQL-injection-shaped values, and source-label suppression. No package was added to production dependencies.
