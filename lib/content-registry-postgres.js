import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
let pool;
let schemaPromise;

function getPool() {
  if (!DATABASE_URL) throw Object.assign(new Error("DATABASE_URL is required for Content Registry"), { statusCode: 503 });
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined,
      max: Math.max(1, Math.min(3, Number(process.env.NEXTGEN_CONTENT_PG_POOL_MAX || 2))),
      connectionTimeoutMillis: Math.max(500, Number(process.env.NEXTGEN_CONTENT_PG_CONNECT_TIMEOUT_MS || 2000)),
      idleTimeoutMillis: 30000,
    });
    pool.on("error", (error) => console.warn("Content Registry Postgres idle client error:", error.message));
  }
  return pool;
}

export function contentRegistryStatus() {
  return { configured: Boolean(DATABASE_URL), storage: "postgres", uploads_in_database: false };
}

export async function ensureContentRegistrySchema() {
  if (!schemaPromise) schemaPromise = getPool().query(`
    CREATE SEQUENCE IF NOT EXISTS content_student_qid_seq START 1;
    CREATE TABLE IF NOT EXISTS content_import_jobs (
      id UUID PRIMARY KEY, exam_track TEXT NOT NULL, source_namespace TEXT NOT NULL,
      source_provider TEXT NOT NULL, collection_title TEXT NOT NULL, original_filename TEXT NOT NULL,
      zip_sha256 TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'previewing', destinations JSONB NOT NULL DEFAULT '[]'::jsonb,
      counts JSONB NOT NULL DEFAULT '{}'::jsonb, errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_content_import_jobs_created ON content_import_jobs(created_at DESC);

    CREATE TABLE IF NOT EXISTS content_collections (
      id UUID PRIMARY KEY, exam_track TEXT NOT NULL, source_namespace TEXT NOT NULL,
      source_provider TEXT NOT NULL, collection_key TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', destinations JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(exam_track, source_namespace, collection_key)
    );

    CREATE TABLE IF NOT EXISTS content_questions (
      id UUID PRIMARY KEY,
      student_qid TEXT NOT NULL UNIQUE DEFAULT ('NGQ-' || LPAD(nextval('content_student_qid_seq')::text, 8, '0')),
      exam_track TEXT NOT NULL, canonical_hash TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
      question_html TEXT NOT NULL, explanation_html TEXT NOT NULL, correct_answer_id INTEGER NOT NULL,
      system_key TEXT NOT NULL DEFAULT '', subject_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
      media_refs JSONB NOT NULL DEFAULT '[]'::jsonb, source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(exam_track, canonical_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_content_questions_filter ON content_questions(exam_track, system_key, subject_key, status);

    CREATE TABLE IF NOT EXISTS content_answers (
      question_id UUID NOT NULL REFERENCES content_questions(id) ON DELETE CASCADE,
      answer_id INTEGER NOT NULL, text_html TEXT NOT NULL, is_correct BOOLEAN NOT NULL DEFAULT FALSE,
      source_data JSONB NOT NULL DEFAULT '{}'::jsonb, PRIMARY KEY(question_id, answer_id)
    );

    CREATE TABLE IF NOT EXISTS content_source_aliases (
      id UUID PRIMARY KEY, question_id UUID NOT NULL REFERENCES content_questions(id) ON DELETE CASCADE,
      collection_id UUID REFERENCES content_collections(id) ON DELETE SET NULL,
      exam_track TEXT NOT NULL, source_namespace TEXT NOT NULL, collection_key TEXT NOT NULL,
      source_item_id TEXT NOT NULL, source_updated_at TEXT NOT NULL DEFAULT '', source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(exam_track, source_namespace, collection_key, source_item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_content_alias_question ON content_source_aliases(question_id);

    CREATE TABLE IF NOT EXISTS content_destinations (
      id UUID PRIMARY KEY, question_id UUID NOT NULL REFERENCES content_questions(id) ON DELETE CASCADE,
      destination TEXT NOT NULL, destination_scope TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT FALSE,
      label_visible BOOLEAN NOT NULL DEFAULT TRUE, settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(question_id, destination, destination_scope)
    );
  `).then(() => true).catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

export async function createContentImportJob(job) {
  await ensureContentRegistrySchema();
  await getPool().query(`INSERT INTO content_import_jobs
    (id, exam_track, source_namespace, source_provider, collection_title, original_filename, zip_sha256, destinations, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, [
    job.id, job.examTrack, job.sourceNamespace, job.sourceProvider, job.collectionTitle,
    job.originalFilename, job.zipSha256, JSON.stringify(job.destinations || []), job.createdBy,
  ]);
}

export async function finishContentImportPreview(id, counts, errors = []) {
  await ensureContentRegistrySchema();
  await getPool().query(`UPDATE content_import_jobs SET status=$2, counts=$3::jsonb, errors=$4::jsonb, updated_at=NOW() WHERE id=$1`,
    [id, errors.length ? "preview_with_warnings" : "preview_ready", JSON.stringify(counts), JSON.stringify(errors.slice(0, 500))]);
}

export async function findDuplicateSignals(examTrack, hashes = [], aliases = []) {
  await ensureContentRegistrySchema();
  const uniqueHashes = [...new Set(hashes)].filter(Boolean);
  const exact = uniqueHashes.length ? await getPool().query(
    `SELECT canonical_hash, student_qid FROM content_questions WHERE exam_track=$1 AND canonical_hash=ANY($2::text[])`,
    [examTrack, uniqueHashes],
  ) : { rows: [] };
  const source = aliases.length ? await getPool().query(
    `SELECT source_namespace, collection_key, source_item_id, question_id FROM content_source_aliases
     WHERE exam_track=$1 AND (source_namespace, collection_key, source_item_id) IN
     (SELECT * FROM UNNEST($2::text[], $3::text[], $4::text[]))`,
    [examTrack, aliases.map((x) => x.sourceNamespace), aliases.map((x) => x.collectionKey), aliases.map((x) => x.sourceItemId)],
  ) : { rows: [] };
  return { exact: exact.rows, source: source.rows };
}

export async function getContentImportJob(id) {
  await ensureContentRegistrySchema();
  const result = await getPool().query("SELECT * FROM content_import_jobs WHERE id=$1", [id]);
  return result.rows[0] || null;
}
