# Provider hints in student QBank delivery

Imported HTML intentionally retains provider hints for complete admin evidence.
The historical import sanitizer turns `Show Hint` buttons into static text and
removes `display:none` from `id="hintdiv"`. Returning that stored stem verbatim
therefore exposed hints before answering.

`sanitizeAylaQbankQuestion` now applies a student-only projection. It removes the
complete `hintdiv` node and its exact `Show Hint` control, including nested HTML.
The pinned parse5 HTML parser supplies source locations; the projection removes
source spans instead of serializing the DOM, preserving surrounding clinical
text, table markup, styles, and Unicode. No stored question, answer, source hash,
review fingerprint, taxonomy, publication rule, or score is changed.

Question-gallery images/videos referenced only inside the removed hint are also
withheld. A reference shared with the normal stem or answer choices remains.
A reference shared only with the explanation is delivered as explanation media
when the existing Tutor-answer or final-Test-submit boundary permits it. The
explanation HTML itself is unchanged.

The shared boundary covers new and reopened QBank sessions, question refreshes,
saved-question delivery, the external QBank adapter, and NBME's shared MCQ DTO.
The legacy CDM student DTO applies the same projection while keeping its existing
response/explanation gating and the current HTTP 410 retirement block unchanged.
Existing sessions store question references and therefore receive the projection
on their next fetch. An already-loaded browser page requires a refresh to replace
its old response.

Validation uses synthetic clinical content only:

```sh
node --test test/aylamed-qbank-student-hints.test.js test/aylamed-qbank.test.js test/aylamed-qbank-batch-routes.test.js test/content-import-adapter.test.js test/external-qbank-delivery.test.js test/aylamed-cdm.test.js
```

The new regression executes the real server session GET, session/question delivery
functions and playable-media boundary with storage/auth mocked. It verifies Test
and Tutor reopen, old durable session shapes, nested and malformed hints, tables
before/after, answer/explanation gating, hint-only galleries, and unchanged admin
evidence fingerprints. Existing batch-route and import suites remain unchanged.
