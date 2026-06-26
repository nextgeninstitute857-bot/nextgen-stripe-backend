#!/usr/bin/env node
/**
 * Verify NextGen LMS Postgres Phase 1 migration.
 *
 * Run from backend root:
 *   node scripts/verify-lms-postgres.mjs
 */

const DATABASE_URL = process.env.DATABASE_URL || "";

async function loadPg() {
  try {
    const pg = await import("pg");
    return pg;
  } catch {
    console.error("Missing npm package: pg. Run: npm install pg");
    process.exit(1);
  }
}

async function main() {
  if (!DATABASE_URL) {
    console.error("DATABASE_URL is missing.");
    process.exit(1);
  }

  const { Client } = await loadPg();
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();

  try {
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('lms_json_store', 'lms_large_text', 'lms_migration_runs')
      ORDER BY table_name
    `);

    console.log("Tables:");
    console.table(tables.rows);

    const counts = await client.query(`
      SELECT section, COUNT(*)::int AS count
      FROM lms_json_store
      GROUP BY section
      ORDER BY section
    `);

    console.log("lms_json_store counts:");
    console.table(counts.rows);

    const large = await client.query(`
      SELECT section, COUNT(*)::int AS count, SUM(content_length)::bigint AS total_chars
      FROM lms_large_text
      GROUP BY section
      ORDER BY total_chars DESC NULLS LAST
    `);

    console.log("lms_large_text counts:");
    console.table(large.rows);

    const runs = await client.query(`
      SELECT id, mode, source_size_bytes, large_text_count, cleaned_json, clean_json_changed_fields, created_at
      FROM lms_migration_runs
      ORDER BY created_at DESC
      LIMIT 5
    `);

    console.log("Recent migration runs:");
    console.table(runs.rows);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
