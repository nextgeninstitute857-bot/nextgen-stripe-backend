import crypto from "node:crypto";
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

    CREATE TABLE IF NOT EXISTS content_media_import_jobs (
      id UUID PRIMARY KEY, content_import_job_id UUID NOT NULL REFERENCES content_import_jobs(id) ON DELETE CASCADE,
      zip_sha256 TEXT NOT NULL, original_filename TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'uploading',
      counts JSONB NOT NULL DEFAULT '{}'::jsonb, errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_content_media_jobs_parent ON content_media_import_jobs(content_import_job_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS content_media_assets (
      id UUID PRIMARY KEY, exam_track TEXT NOT NULL, source_namespace TEXT NOT NULL,
      sha256 TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
      content_type TEXT NOT NULL, size_bytes BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
      source_data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(exam_track, source_namespace, sha256)
    );
    CREATE INDEX IF NOT EXISTS idx_content_media_assets_scope ON content_media_assets(exam_track, source_namespace, status);

    CREATE TABLE IF NOT EXISTS content_question_media (
      id UUID PRIMARY KEY, question_id UUID NOT NULL REFERENCES content_questions(id) ON DELETE CASCADE,
      media_asset_id UUID NOT NULL REFERENCES content_media_assets(id) ON DELETE RESTRICT,
      media_ref TEXT NOT NULL, placement TEXT NOT NULL DEFAULT 'explanation', status TEXT NOT NULL DEFAULT 'draft',
      source_data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(question_id, media_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_content_question_media_question ON content_question_media(question_id, status);

    CREATE TABLE IF NOT EXISTS content_video_import_jobs (
      id UUID PRIMARY KEY, content_import_job_id UUID NOT NULL REFERENCES content_import_jobs(id) ON DELETE CASCADE,
      zip_sha256 TEXT NOT NULL, original_filename TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'uploading',
      counts JSONB NOT NULL DEFAULT '{}'::jsonb, errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_content_video_jobs_parent ON content_video_import_jobs(content_import_job_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS content_video_assets (
      id UUID PRIMARY KEY, exam_track TEXT NOT NULL, source_namespace TEXT NOT NULL, sha256 TEXT NOT NULL,
      original_name TEXT NOT NULL, size_bytes BIGINT NOT NULL, provider TEXT NOT NULL DEFAULT 'vimeo',
      provider_uri TEXT NOT NULL, provider_id TEXT NOT NULL, embed_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft_processing', source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(exam_track, source_namespace, sha256)
    );
    CREATE TABLE IF NOT EXISTS content_question_videos (
      id UUID PRIMARY KEY, question_id UUID NOT NULL REFERENCES content_questions(id) ON DELETE CASCADE,
      video_asset_id UUID NOT NULL REFERENCES content_video_assets(id) ON DELETE RESTRICT,
      media_ref TEXT NOT NULL, placement TEXT NOT NULL DEFAULT 'explanation', status TEXT NOT NULL DEFAULT 'draft',
      source_data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(question_id, media_ref)
    );
  `).then(() => true).catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

export async function createContentMediaImportJob({ id, contentImportJobId, zipSha256, originalFilename, createdBy }) {
  await ensureContentRegistrySchema();
  const result = await getPool().query(`INSERT INTO content_media_import_jobs
    (id, content_import_job_id, zip_sha256, original_filename, created_by)
    VALUES ($1,$2,$3,$4,$5) RETURNING *`, [id, contentImportJobId, zipSha256, originalFilename, createdBy]);
  return result.rows[0];
}

export async function finishContentMediaImportJob(id, status, counts, errors = []) {
  await ensureContentRegistrySchema();
  await getPool().query(`UPDATE content_media_import_jobs SET status=$2, counts=$3::jsonb, errors=$4::jsonb, updated_at=NOW() WHERE id=$1`,
    [id, status, JSON.stringify(counts || {}), JSON.stringify(errors.slice(0, 500))]);
}

export async function getContentMediaImportJob(id) {
  await ensureContentRegistrySchema();
  const result = await getPool().query("SELECT * FROM content_media_import_jobs WHERE id=$1", [id]);
  return result.rows[0] || null;
}

export async function getContentMediaReferences(contentImportJobId, kind = "all") {
  await ensureContentRegistrySchema();
  const result = await getPool().query(`SELECT DISTINCT q.id AS question_id, q.student_qid, ref.value AS media_ref
    FROM content_source_aliases a
    JOIN content_questions q ON q.id=a.question_id
    CROSS JOIN LATERAL jsonb_array_elements_text(q.media_refs) ref(value)
    WHERE a.source_data->>'import_job_id'=$1 AND q.status='draft'`, [contentImportJobId]);
  const rows = result.rows.map((row) => ({ questionId: row.question_id, studentQid: row.student_qid, mediaRef: row.media_ref }));
  const video = (value) => /\.(mp4|mov|m4v|webm)(?:[?#].*)?$/i.test(String(value || ""));
  return kind === "video" ? rows.filter((row) => video(row.mediaRef)) : kind === "image" ? rows.filter((row) => !video(row.mediaRef)) : rows;
}

export async function createContentVideoImportJob({ id, contentImportJobId, zipSha256, originalFilename, createdBy }) {
  await ensureContentRegistrySchema();
  const result = await getPool().query(`INSERT INTO content_video_import_jobs
    (id, content_import_job_id, zip_sha256, original_filename, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, contentImportJobId, zipSha256, originalFilename, createdBy]);
  return result.rows[0];
}

export async function finishContentVideoImportJob(id, status, counts, errors = []) {
  await ensureContentRegistrySchema();
  await getPool().query(`UPDATE content_video_import_jobs SET status=$2, counts=$3::jsonb, errors=$4::jsonb, updated_at=NOW() WHERE id=$1`,
    [id, status, JSON.stringify(counts || {}), JSON.stringify(errors.slice(0, 500))]);
}

export async function getContentVideoImportJob(id) {
  await ensureContentRegistrySchema();
  const result = await getPool().query("SELECT * FROM content_video_import_jobs WHERE id=$1", [id]);
  return result.rows[0] || null;
}

export async function saveContentVideoMatch({ videoJobId, parentJob, match, uploaded }) {
  await ensureContentRegistrySchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const assetId = crypto.randomUUID();
    const asset = await client.query(`INSERT INTO content_video_assets
      (id, exam_track, source_namespace, sha256, original_name, size_bytes, provider_uri, provider_id, embed_url, source_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
      ON CONFLICT (exam_track, source_namespace, sha256) DO UPDATE SET updated_at=NOW() RETURNING id`,
      [assetId, parentJob.exam_track, parentJob.source_namespace, match.video.sha256, match.video.originalName, match.video.sizeBytes,
        uploaded.providerUri, uploaded.providerId, uploaded.embedUrl, JSON.stringify({ video_import_job_id: videoJobId, content_import_job_id: parentJob.id })]);
    const link = await client.query(`INSERT INTO content_question_videos
      (id, question_id, video_asset_id, media_ref, source_data) VALUES ($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT (question_id, media_ref) DO NOTHING`, [crypto.randomUUID(), match.questionId, asset.rows[0].id, match.mediaRef,
        JSON.stringify({ video_import_job_id: videoJobId, student_qid: match.studentQid })]);
    await client.query("COMMIT");
    return link.rowCount;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function saveContentMediaMatches({ mediaJobId, parentJob, assets, matches }) {
  await ensureContentRegistrySchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const assetIds = new Map();
    for (const asset of assets) {
      const id = crypto.randomUUID();
      const result = await client.query(`INSERT INTO content_media_assets
        (id, exam_track, source_namespace, sha256, object_key, original_name, content_type, size_bytes, status, source_data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',$9::jsonb)
        ON CONFLICT (exam_track, source_namespace, sha256) DO UPDATE SET original_name=EXCLUDED.original_name
        RETURNING id, object_key`, [id, parentJob.exam_track, parentJob.source_namespace, asset.sha256, asset.objectKey,
          asset.originalName, asset.contentType, asset.sizeBytes, JSON.stringify({ media_import_job_id: mediaJobId, content_import_job_id: parentJob.id })]);
      assetIds.set(asset.sha256, {
        id: result.rows[0].id, objectKey: result.rows[0].object_key,
        duplicate: result.rows[0].object_key !== asset.objectKey,
        duplicateObjectKey: result.rows[0].object_key !== asset.objectKey ? asset.objectKey : null,
      });
    }
    let links = 0;
    for (const match of matches) {
      const resolved = assetIds.get(match.asset.sha256);
      const result = await client.query(`INSERT INTO content_question_media
        (id, question_id, media_asset_id, media_ref, placement, status, source_data)
        VALUES ($1,$2,$3,$4,'explanation','draft',$5::jsonb)
        ON CONFLICT (question_id, media_ref) DO NOTHING`, [crypto.randomUUID(), match.questionId, resolved.id, match.mediaRef,
          JSON.stringify({ media_import_job_id: mediaJobId, student_qid: match.studentQid })]);
      links += result.rowCount;
    }
    await client.query("COMMIT");
    return { links, duplicateObjects: [...assetIds.values()].map((item) => item.duplicateObjectKey).filter(Boolean) };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
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

export async function setContentImportJobStatus(id, status, counts = null, errors = null) {
  await ensureContentRegistrySchema();
  await getPool().query(`UPDATE content_import_jobs SET status=$2,
    counts=COALESCE($3::jsonb, counts), errors=COALESCE($4::jsonb, errors), updated_at=NOW() WHERE id=$1`,
    [id, status, counts == null ? null : JSON.stringify(counts), errors == null ? null : JSON.stringify(errors.slice(0, 500))]);
}

export async function claimContentImportDraft(id) {
  await ensureContentRegistrySchema();
  const result = await getPool().query(`UPDATE content_import_jobs SET status='importing_draft', updated_at=NOW()
    WHERE id=$1 AND status IN ('preview_ready','preview_with_warnings') RETURNING *`, [id]);
  return result.rows[0] || null;
}

export async function importContentQuestionBatch({ job, collectionKey, collectionTitle, rows, destinations = [] }) {
  await ensureContentRegistrySchema();
  if (!rows.length) return { created: 0, reused: 0, aliasesCreated: 0, sourceDuplicates: 0, answers: 0 };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const collectionId = crypto.randomUUID();
    const collectionResult = await client.query(`INSERT INTO content_collections
      (id, exam_track, source_namespace, source_provider, collection_key, title, status, destinations)
      VALUES ($1,$2,$3,$4,$5,$6,'draft',$7::jsonb)
      ON CONFLICT (exam_track, source_namespace, collection_key) DO UPDATE SET
        title=EXCLUDED.title, destinations=EXCLUDED.destinations, updated_at=NOW()
      RETURNING id`, [collectionId, job.exam_track, job.source_namespace, job.source_provider, collectionKey, collectionTitle, JSON.stringify(destinations)]);
    const activeCollectionId = collectionResult.rows[0].id;
    const hashes = [...new Set(rows.map((row) => row.contentHash))];
    const existingQuestions = await client.query(`SELECT id, canonical_hash FROM content_questions WHERE exam_track=$1 AND canonical_hash=ANY($2::text[])`, [job.exam_track, hashes]);
    const questionIds = new Map(existingQuestions.rows.map((row) => [row.canonical_hash, row.id]));
    const newQuestionPayload = [];
    for (const row of rows) {
      if (questionIds.has(row.contentHash)) continue;
      const id = crypto.randomUUID();
      questionIds.set(row.contentHash, id);
      newQuestionPayload.push({
        id, canonical_hash: row.contentHash, title: row.title, question_html: row.questionHtml,
        explanation_html: row.explanationHtml, correct_answer_id: row.correctAnswerId,
        system_key: row.systemSourceId, subject_key: row.subjectSourceId,
        media_refs: row.media, source_data: { ...row.sourceData, statistics: row.statistics, source_updated_at: row.sourceUpdatedAt },
      });
    }
    if (newQuestionPayload.length) await client.query(`INSERT INTO content_questions
      (id, exam_track, canonical_hash, title, question_html, explanation_html, correct_answer_id, system_key, subject_key, status, media_refs, source_data)
      SELECT x.id::uuid, $1, x.canonical_hash, x.title, x.question_html, x.explanation_html, x.correct_answer_id,
        x.system_key, x.subject_key, 'draft', x.media_refs, x.source_data
      FROM jsonb_to_recordset($2::jsonb) AS x(id text, canonical_hash text, title text, question_html text,
        explanation_html text, correct_answer_id int, system_key text, subject_key text, media_refs jsonb, source_data jsonb)
      ON CONFLICT (exam_track, canonical_hash) DO NOTHING`, [job.exam_track, JSON.stringify(newQuestionPayload)]);
    const resolved = await client.query(`SELECT id, canonical_hash FROM content_questions WHERE exam_track=$1 AND canonical_hash=ANY($2::text[])`, [job.exam_track, hashes]);
    resolved.rows.forEach((row) => questionIds.set(row.canonical_hash, row.id));
    const existingAliases = await client.query(`SELECT collection_key, source_item_id FROM content_source_aliases
      WHERE exam_track=$1 AND source_namespace=$2 AND collection_key=$3 AND source_item_id=ANY($4::text[])`,
      [job.exam_track, job.source_namespace, collectionKey, rows.map((row) => row.sourceItemId)]);
    const existingAliasIds = new Set(existingAliases.rows.map((row) => String(row.source_item_id)));
    const aliasPayload = rows.filter((row) => !existingAliasIds.has(row.sourceItemId)).map((row) => ({
      id: crypto.randomUUID(), question_id: questionIds.get(row.contentHash), source_item_id: row.sourceItemId,
      source_updated_at: row.sourceUpdatedAt, source_data: { parent_source_id: row.parentSourceId, import_job_id: job.id },
    }));
    if (aliasPayload.length) await client.query(`INSERT INTO content_source_aliases
      (id, question_id, collection_id, exam_track, source_namespace, collection_key, source_item_id, source_updated_at, source_data)
      SELECT x.id::uuid, x.question_id::uuid, $1::uuid, $2, $3, $4, x.source_item_id, x.source_updated_at, x.source_data
      FROM jsonb_to_recordset($5::jsonb) AS x(id text, question_id text, source_item_id text, source_updated_at text, source_data jsonb)
      ON CONFLICT (exam_track, source_namespace, collection_key, source_item_id) DO NOTHING`,
      [activeCollectionId, job.exam_track, job.source_namespace, collectionKey, JSON.stringify(aliasPayload)]);
    const answerPayload = rows.flatMap((row) => row.answers.map((answer) => ({
      question_id: questionIds.get(row.contentHash), answer_id: answer.answerId, text_html: answer.textHtml,
      is_correct: answer.answerId === row.correctAnswerId,
      source_data: { source_id: answer.sourceId, correct_percentage: answer.correctPercentage },
    })));
    if (answerPayload.length) await client.query(`INSERT INTO content_answers (question_id, answer_id, text_html, is_correct, source_data)
      SELECT x.question_id::uuid, x.answer_id, x.text_html, x.is_correct, x.source_data
      FROM jsonb_to_recordset($1::jsonb) AS x(question_id text, answer_id int, text_html text, is_correct boolean, source_data jsonb)
      ON CONFLICT (question_id, answer_id) DO NOTHING`, [JSON.stringify(answerPayload)]);
    const destinationPayload = [...new Set(destinations)].flatMap((destination) => [...new Set(rows.map((row) => questionIds.get(row.contentHash)))].map((questionId) => ({ id: crypto.randomUUID(), question_id: questionId, destination })));
    if (destinationPayload.length) await client.query(`INSERT INTO content_destinations (id, question_id, destination, enabled, settings)
      SELECT x.id::uuid, x.question_id::uuid, x.destination, FALSE, jsonb_build_object('import_job_id',$1::text)
      FROM jsonb_to_recordset($2::jsonb) AS x(id text, question_id text, destination text)
      ON CONFLICT (question_id, destination, destination_scope) DO NOTHING`, [job.id, JSON.stringify(destinationPayload)]);
    await client.query("COMMIT");
    return {
      created: newQuestionPayload.length, reused: Math.max(0, rows.length - newQuestionPayload.length),
      aliasesCreated: aliasPayload.length, sourceDuplicates: existingAliasIds.size, answers: answerPayload.length,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}
