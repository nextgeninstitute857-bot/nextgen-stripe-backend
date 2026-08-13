-- Run each statement outside a transaction before deploying the read-path fix.
-- CONCURRENTLY avoids blocking content imports or student delivery while the
-- existing tables are indexed.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_alias_collection_question
  ON content_source_aliases(collection_id, question_id)
  WHERE collection_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_import_jobs_draft_recovery
  ON content_import_jobs(exam_track, source_namespace, source_profile, created_at DESC)
  WHERE status IN ('draft_imported','draft_imported_with_warnings');
