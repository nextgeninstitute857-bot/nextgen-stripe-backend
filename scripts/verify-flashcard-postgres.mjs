#!/usr/bin/env node
import pg from "pg";
import { ensureFlashcardSchema, closeFlashcardPostgres } from "../lib/flashcard-postgres.js";

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const { Client } = pg;

async function main() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
  await ensureFlashcardSchema();
  const client = new Client({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    const tables = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('flashcard_cards','flashcard_review_events','flashcard_review_state','flashcard_migration_map','flashcard_migration_runs') ORDER BY table_name`);
    const counts = await client.query(`
      SELECT 'cards' AS kind, app, COUNT(*)::int AS count FROM flashcard_cards GROUP BY app
      UNION ALL SELECT 'events', app, COUNT(*)::int FROM flashcard_review_events GROUP BY app
      UNION ALL SELECT 'states', app, COUNT(*)::int FROM flashcard_review_state GROUP BY app
      ORDER BY kind, app
    `);
    const invalidScopes = await client.query(`
      SELECT COUNT(*)::int AS count FROM (
        SELECT app, scope_type FROM flashcard_cards
        UNION ALL SELECT app, scope_type FROM flashcard_review_events
        UNION ALL SELECT app, scope_type FROM flashcard_review_state
      ) x WHERE (app='lms' AND scope_type<>'course') OR (app='aylamed' AND scope_type<>'exam_track')
    `);
    const duplicateSources = await client.query(`SELECT app,source_namespace,external_id,COUNT(*)::int AS count FROM flashcard_cards GROUP BY app,source_namespace,external_id HAVING COUNT(*)>1 LIMIT 20`);
    const orphanStates = await client.query(`SELECT COUNT(*)::int AS count FROM flashcard_review_state s WHERE NOT EXISTS (SELECT 1 FROM flashcard_review_events e WHERE e.app=s.app AND e.id=s.last_review_event_id)`);
    const runs = await client.query(`SELECT id,source_file,source_sha256,counts,created_at FROM flashcard_migration_runs ORDER BY created_at DESC LIMIT 5`);
    const report = {
      success: tables.rows.length === 5 && invalidScopes.rows[0].count === 0 && duplicateSources.rows.length === 0,
      tables: tables.rows.map((row) => row.table_name), counts: counts.rows,
      safeguards: { invalid_scope_rows: invalidScopes.rows[0].count, duplicate_source_rows: duplicateSources.rows, orphan_states: orphanStates.rows[0].count },
      recent_runs: runs.rows,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.success) process.exitCode = 2;
  } finally { await client.end(); await closeFlashcardPostgres(); }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });
