# Durable incremental AylaMed state

Ordinary learner mutations now write `aylamed-state-deltas.jsonl` beside `aylamed-db.json`. A normal answer no longer serializes the entire approximately 111 MB state file. Session creation, practice answers, submission state, diagnostic answers and roadmap mutations use one ordered journal and the existing single writer queue.

Each record contains a monotonically increasing `state_journal_version`, its expected previous version, changed JSON paths and a SHA-256 checksum. Unchanged copy-on-write branches are not traversed or serialized. Deletes and array replacement are supported. The file and its directory entry are synced before the new cache is published or the caller receives success. Partial writes are rolled back and synced. If rollback is uncertain, the cache is invalidated and the next operation recovers durable state before choosing another version.

Recovery reads the existing diagnostic and roadmap journals first, then the new ordered deltas. Those legacy journals are no longer written by the new mutation paths. Incomplete trailing bytes are removed before the journal is reused; corrupt complete records, conflicting versions or gaps fail closed. Duplicate records already included in an atomic checkpoint cannot roll state back. A missing base file with pending deltas is an error, not a new empty database.

## Checkpoints and configuration

Existing whole-state saves remain atomic checkpoints. They now reject an outdated state version with HTTP 409 rather than overwrite newer durable learner changes. A successful whole-state save increments `state_journal_version`, allowing background jobs to detect any changed source snapshot.

Idle compaction runs on the same writer queue once either threshold is reached and no successful mutation has occurred for the idle window:

| Variable | Default | Allowed bounds |
|---|---:|---:|
| `AYLA_STATE_CHECKPOINT_IDLE_MS` | 60,000 ms | 10,000–3,600,000 ms |
| `AYLA_STATE_CHECKPOINT_BYTES` | 8,388,608 bytes | 262,144–67,108,864 bytes |
| `AYLA_STATE_CHECKPOINT_RECORDS` | 500 | 10–10,000 |

Checkpointing syncs a temporary snapshot, atomically renames it, syncs the containing directory and only then clears the old journals. A crash after rename but before clearing is safe because the snapshot includes the journal version. Checkpoint failure leaves recoverable state on disk. Compaction can still pause a newly arriving mutation while the snapshot is written; this staged repair deliberately keeps that rare work on the existing queue rather than taking concurrent snapshots of legacy mutable state. Sustained traffic can defer compaction beyond the thresholds, so monitor journal growth and checkpoint logs. Large administrative whole-state saves also retain their existing cost.

The persistent disk remains single-process storage. **Do not add independent service instances pointing at divergent local files.** A future PostgreSQL learner-state migration remains the scalable replacement.

## Backup and rollback

- The existing authenticated `POST /api/ayla/admin/backup` now executes under the writer queue and serializes freshly replayed durable state. Its returned `backup_path` is a standalone complete JSON snapshot, including acknowledged deltas; it excludes unsaved mutable request snapshots. No scheduled AylaMed application backup or raw full-Ayla export path was found; the separate LMS/CRM backup routes are unaffected.
- When using external disk snapshots instead, back up `aylamed-db.json`, `aylamed-state-deltas.jsonl`, `aylamed-diagnostic-answers.jsonl` and `aylamed-roadmap-state.jsonl` together using an application-consistent snapshot of the persistent disk. A base JSON file alone may now omit recent acknowledged work.
- Do not roll back directly to a binary that cannot replay the new journal while deltas are pending. First stop writes and produce/verify a complete checkpoint with the current binary, or restore a consistent base-and-journal backup with a compatible binary. Prefer a forward fix if the service cannot be quiesced safely.
- `state_journal_version` is internal concurrency metadata. Do not edit it manually. A background plan job should prepare against a snapshot and compare its version inside `mutateAylaDb` before assigning changed collections. On mismatch it must discard/retry its calculation.

Concrete rollback preparation: quiesce student writes and background mutation workers; call the existing authenticated `POST /api/ayla/admin/backup` with JSON body `{"checkpoint":true}`; require a successful response with `standalone_snapshot:true` and `primary_checkpoint_updated:true`; keep the returned backup, and verify the new journal is empty via `GET /api/ayla/admin/storage-safety` (`state_journal.size_bytes:0`). Keep writers quiesced until rollback is complete. This operation saves a complete backup and checkpoints/clears journals under the same queue. Taking a checkpoint without quiescing writers is safe for the current service but is not sufficient preparation for an old binary, since new deltas could arrive afterward.

## Validation

The new tests execute the real server persistence functions with real temporary files and isolated synthetic state. They cover concurrent writes, cross-mode ordering, crash recovery from legacy journals, hard process termination after fsync/before cache publication, pending-fsync/no-ACK behavior, truncated append rollback, fsync and rollback failures, duplicate/version-gap rejection, checkpoint crash windows, stale snapshots and idle compaction.

Run:

```text
node --test test/aylamed-state-journal.test.js test/aylamed-qbank-journal.test.js test/aylamed-roadmap-journal.test.js test/json-copy-on-write.test.js test/aylamed-qbank.test.js test/aylamed-portal-performance.test.js
node scripts/benchmark-aylamed-state-journal.mjs
```

September 8, 2026 local synthetic benchmark: 112,077,973-byte snapshot with 20,000 resources; 11 answer saves wrote 5,159 total journal bytes. First durable delta took 68 ms; subsequent median 17 ms and max 151 ms. The actual legacy full-state streaming writer took 4,145 ms locally; cold recovery took 843 ms and recovered all 11 answers. These are workstation persistence measurements, not production request percentiles. Production answer grading, authentication, network, contention and background adaptation must still be measured after rollout.
