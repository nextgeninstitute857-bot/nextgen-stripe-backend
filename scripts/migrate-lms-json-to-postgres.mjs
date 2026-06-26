#!/usr/bin/env node
/**
 * NextGen LMS Postgres Migration Phase 1
 *
 * Safe purpose:
 * - Copies /var/data/live-session-db.json LMS data into Render Postgres.
 * - Creates generic JSONB tables first, so existing backend routes are not changed yet.
 * - Optional --clean-json removes/shortens heavy fields from the JSON file after backup.
 *
 * Run from backend root on Render Shell:
 *   node --max-old-space-size=1536 scripts/migrate-lms-json-to-postgres.mjs --dry-run
 *   node --max-old-space-size=1536 scripts/migrate-lms-json-to-postgres.mjs
 *   node --max-old-space-size=1536 scripts/migrate-lms-json-to-postgres.mjs --clean-json
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const CLEAN_JSON = args.has("--clean-json");
const NO_LARGE_TEXT = args.has("--no-large-text");

const DATA_DIR = process.env.DATA_DIR || "/var/data";
const LIVE_DB_PATH = process.env.LIVE_DB_PATH || path.join(DATA_DIR, "live-session-db.json");
const DATABASE_URL = process.env.DATABASE_URL || "";

const LARGE_TEXT_THRESHOLD = Number(process.env.NEXTGEN_PG_LARGE_TEXT_THRESHOLD || 20000);
const TRANSCRIPT_TEXT_KEEP_CHARS = Number(process.env.NEXTGEN_JSON_TRANSCRIPT_TEXT_KEEP_CHARS || 80000);
const RAW_VTT_KEEP_THRESHOLD = Number(process.env.NEXTGEN_JSON_RAW_VTT_KEEP_THRESHOLD || 50000);

const SINGLETON_SECTIONS = new Set(["demoSettings"]);

const ASSESSMENT_HEAVY_FIELDS = [
  "source_text",
  "sourceText",
  "generation_source_text",
  "raw_source",
  "source_material",
  "source_notes_text",
  "generation_prompt",
  "prompt",
  "raw_prompt",
  "raw_response"
];

const NOTE_HEAVY_REMOVE_FIELDS = [
  "raw_prompt",
  "raw_response",
  "generation_prompt",
  "source_text",
  "sourceText"
];

const AI_LOG_HEAVY_FIELDS = [
  "prompt",
  "raw_prompt",
  "raw_response",
  "response_text",
  "messages",
  "source_text",
  "sourceText",
  "input",
  "output"
];

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function isObjectMap(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function removeField(obj, field, counter) {
  if (obj && Object.prototype.hasOwnProperty.call(obj, field)) {
    delete obj[field];
    counter.changed += 1;
  }
}

function trimField(obj, field, maxLen, counter) {
  const value = String(obj?.[field] || "");
  if (value.length > maxLen) {
    obj[field] = value.slice(0, maxLen);
    counter.changed += 1;
  }
}

function cleanDbForJson(db) {
  const cleaned = cloneJson(db);
  const counter = { changed: 0 };

  for (const item of Object.values(cleaned.assessments || {})) {
    ASSESSMENT_HEAVY_FIELDS.forEach((field) => removeField(item, field, counter));

    if (item.metadata && typeof item.metadata === "object") {
      ASSESSMENT_HEAVY_FIELDS.forEach((field) => removeField(item.metadata, field, counter));
    }
  }

  for (const item of Object.values(cleaned.notes || {})) {
    if (String(item.transcript_raw_vtt || "").length > RAW_VTT_KEEP_THRESHOLD) {
      item.transcript_raw_vtt = "";
      counter.changed += 1;
    }

    trimField(item, "transcript_text", TRANSCRIPT_TEXT_KEEP_CHARS, counter);
    NOTE_HEAVY_REMOVE_FIELDS.forEach((field) => removeField(item, field, counter));
  }

  for (const item of Object.values(cleaned.aiUsageLogs || {})) {
    AI_LOG_HEAVY_FIELDS.forEach((field) => removeField(item, field, counter));
  }

  for (const item of Object.values(cleaned.recordings || {})) {
    if (item.learning_content_processing_result) {
      const result = item.learning_content_processing_result;
      item.learning_content_processing_result = {
        success: result.success === true,
        skipped: result.skipped === true,
        reason: result.reason || null,
        error: result.error || null,
        cleaned_notes_saved: result.cleaned_notes_saved === true,
        session_flashcards_created: Number(result.session_flashcards_created || 0),
        weekly_assessment_created: result.weekly_assessment_created === true,
        warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 3) : [],
      };
      counter.changed += 1;
    }
  }

  cleaned.updatedAt = nowIso();

  return { cleaned, changed: counter.changed };
}

async function loadPg() {
  try {
    const pg = await import("pg");
    return pg;
  } catch (error) {
    console.error("\nERROR: Missing npm package: pg");
    console.error("Run this once in your backend project and commit package.json/package-lock:");
    console.error("  npm install pg");
    console.error("\nThen redeploy and run this script again.\n");
    process.exit(1);
  }
}

async function createTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS lms_json_store (
      section TEXT NOT NULL,
      record_id TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (section, record_id)
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_lms_json_store_section
    ON lms_json_store(section);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS lms_large_text (
      section TEXT NOT NULL,
      record_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      content TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      content_length INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (section, record_id, field_name)
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_lms_large_text_section_record
    ON lms_large_text(section, record_id);
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS lms_migration_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_size_bytes BIGINT NOT NULL,
      section_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      large_text_count INTEGER NOT NULL DEFAULT 0,
      cleaned_json BOOLEAN NOT NULL DEFAULT FALSE,
      clean_json_changed_fields INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function collectRecords(db) {
  const records = [];
  const sectionCounts = {};

  for (const [section, value] of Object.entries(db || {})) {
    if (section === "updatedAt") {
      records.push({ section: "_meta", record_id: "updatedAt", data: { value } });
      sectionCounts["_meta"] = (sectionCounts["_meta"] || 0) + 1;
      continue;
    }

    if (SINGLETON_SECTIONS.has(section)) {
      records.push({ section, record_id: "default", data: value || {} });
      sectionCounts[section] = 1;
      continue;
    }

    if (isObjectMap(value)) {
      const entries = Object.entries(value);
      sectionCounts[section] = entries.length;
      for (const [record_id, data] of entries) {
        records.push({ section, record_id: String(record_id), data: data ?? {} });
      }
      continue;
    }

    records.push({ section: "_meta", record_id: section, data: { value } });
    sectionCounts["_meta"] = (sectionCounts["_meta"] || 0) + 1;
  }

  return { records, sectionCounts };
}

function extractLargeText(section, record_id, data) {
  if (NO_LARGE_TEXT) return { data, largeTexts: [] };

  const copy = cloneJson(data);
  const largeTexts = [];

  function visit(obj, prefix = "") {
    if (!obj || typeof obj !== "object") return;

    for (const [key, value] of Object.entries(obj)) {
      const fieldPath = prefix ? `${prefix}.${key}` : key;

      if (typeof value === "string" && value.length > LARGE_TEXT_THRESHOLD) {
        const digest = sha256(value);
        largeTexts.push({
          section,
          record_id,
          field_name: fieldPath,
          content: value,
          content_sha256: digest,
          content_length: value.length,
        });

        obj[key] = {
          stored_in: "lms_large_text",
          field_name: fieldPath,
          content_sha256: digest,
          content_length: value.length,
        };
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        visit(value, fieldPath);
      }
    }
  }

  visit(copy);

  return { data: copy, largeTexts };
}

async function upsertRecord(client, record) {
  const { data, largeTexts } = extractLargeText(record.section, record.record_id, record.data);

  await client.query(
    `
    INSERT INTO lms_json_store(section, record_id, data, updated_at)
    VALUES ($1, $2, $3::jsonb, NOW())
    ON CONFLICT (section, record_id)
    DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
    `,
    [record.section, record.record_id, JSON.stringify(data)]
  );

  for (const textItem of largeTexts) {
    await client.query(
      `
      INSERT INTO lms_large_text(section, record_id, field_name, content, content_sha256, content_length, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (section, record_id, field_name)
      DO UPDATE SET
        content = EXCLUDED.content,
        content_sha256 = EXCLUDED.content_sha256,
        content_length = EXCLUDED.content_length,
        updated_at = NOW()
      `,
      [
        textItem.section,
        textItem.record_id,
        textItem.field_name,
        textItem.content,
        textItem.content_sha256,
        textItem.content_length,
      ]
    );
  }

  return largeTexts.length;
}

async function main() {
  if (!DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is missing.");
    console.error("Add Render Postgres Internal Database URL to backend env as DATABASE_URL.");
    process.exit(1);
  }

  if (!existsSync(LIVE_DB_PATH)) {
    console.error(`ERROR: JSON DB not found: ${LIVE_DB_PATH}`);
    process.exit(1);
  }

  const stat = await fs.stat(LIVE_DB_PATH);
  console.log("NextGen LMS Postgres Migration Phase 1");
  console.log("Source:", LIVE_DB_PATH);
  console.log("Source size MB:", (stat.size / 1024 / 1024).toFixed(2));
  console.log("Mode:", DRY_RUN ? "DRY RUN" : "WRITE");
  console.log("Clean JSON after migration:", CLEAN_JSON ? "YES" : "NO");
  console.log("");

  const raw = await fs.readFile(LIVE_DB_PATH, "utf8");
  const db = JSON.parse(raw);
  const { records, sectionCounts } = collectRecords(db);

  console.log("Records to migrate:", records.length);
  console.table(Object.entries(sectionCounts).map(([section, count]) => ({ section, count })));

  if (DRY_RUN) {
    const preview = records.slice(0, 10).map((r) => ({
      section: r.section,
      record_id: r.record_id,
      keys: isObjectMap(r.data) ? Object.keys(r.data).slice(0, 8).join(", ") : typeof r.data,
    }));
    console.log("Preview:");
    console.table(preview);
    console.log("Dry run complete. No Postgres writes and no JSON cleanup done.");
    return;
  }

  const { Client } = await loadPg();
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();

  let largeTextCount = 0;
  const runId = crypto.randomUUID();

  try {
    await client.query("BEGIN");
    await createTables(client);

    for (let i = 0; i < records.length; i++) {
      largeTextCount += await upsertRecord(client, records[i]);

      if ((i + 1) % 500 === 0) {
        console.log(`Migrated ${i + 1}/${records.length} records...`);
      }
    }

    await client.query(
      `
      INSERT INTO lms_migration_runs(
        id, mode, source_file, source_size_bytes, section_counts, large_text_count, cleaned_json, clean_json_changed_fields
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
      `,
      [
        runId,
        CLEAN_JSON ? "migrate_and_clean_json" : "migrate_only",
        LIVE_DB_PATH,
        stat.size,
        JSON.stringify(sectionCounts),
        largeTextCount,
        false,
        0,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }

  console.log("");
  console.log("Postgres migration complete.");
  console.log("Migration run:", runId);
  console.log("Large text fields moved into lms_large_text:", largeTextCount);

  if (CLEAN_JSON) {
    const backupPath = `${LIVE_DB_PATH}.backup-before-pg-clean.${backupStamp()}.json`;
    await fs.copyFile(LIVE_DB_PATH, backupPath);

    const { cleaned, changed } = cleanDbForJson(db);
    await fs.writeFile(LIVE_DB_PATH, JSON.stringify(cleaned, null, 2), "utf8");

    const after = await fs.stat(LIVE_DB_PATH);
    console.log("");
    console.log("JSON cleanup complete.");
    console.log("Backup saved:", backupPath);
    console.log("Changed fields:", changed);
    console.log("Before MB:", (stat.size / 1024 / 1024).toFixed(2));
    console.log("After MB:", (after.size / 1024 / 1024).toFixed(2));
    console.log("Reduced MB:", ((stat.size - after.size) / 1024 / 1024).toFixed(2));
  }

  console.log("");
  console.log("IMPORTANT:");
  console.log("Keep NEXTGEN_USE_POSTGRES_LMS=false until backend routes are switched safely.");
}

main().catch((error) => {
  console.error("\nMigration failed:");
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
