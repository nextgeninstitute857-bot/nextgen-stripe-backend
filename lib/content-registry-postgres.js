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
    ALTER TABLE content_collections ADD COLUMN IF NOT EXISTS display_policy JSONB NOT NULL DEFAULT '{"question_id_mode":"internal","source_label_mode":"neutral"}'::jsonb;
    ALTER TABLE content_collections ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
    ALTER TABLE content_collections ADD COLUMN IF NOT EXISTS approved_by TEXT;

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
    ALTER TABLE content_questions ADD COLUMN IF NOT EXISTS taxonomy JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS content_taxonomy_mappings (
      id UUID PRIMARY KEY, exam_track TEXT NOT NULL, source_namespace TEXT NOT NULL,
      source_system_id TEXT NOT NULL DEFAULT '', source_subject_id TEXT NOT NULL DEFAULT '',
      system_key TEXT NOT NULL, subsystem_key TEXT NOT NULL DEFAULT '', topic_key TEXT NOT NULL DEFAULT '',
      subtopic_key TEXT NOT NULL DEFAULT '', labels JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(exam_track, source_namespace, source_system_id, source_subject_id)
    );
    CREATE INDEX IF NOT EXISTS idx_content_taxonomy_mapping_scope ON content_taxonomy_mappings(exam_track, source_namespace, status);

    CREATE TABLE IF NOT EXISTS content_collection_destinations (
      id UUID PRIMARY KEY, collection_id UUID NOT NULL REFERENCES content_collections(id) ON DELETE CASCADE,
      destination TEXT NOT NULL, destination_scope TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT FALSE,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb, updated_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(collection_id, destination, destination_scope)
    );
    CREATE INDEX IF NOT EXISTS idx_content_collection_destinations_delivery ON content_collection_destinations(destination, enabled, collection_id);

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

export async function findReusableContentVideo({ questionId, mediaRef, sha256 }) {
  await ensureContentRegistrySchema();
  const [mapping, asset] = await Promise.all([
    getPool().query(`SELECT qv.id, qv.video_asset_id, va.provider_id, va.provider_uri, va.embed_url
      FROM content_question_videos qv
      JOIN content_video_assets va ON va.id=qv.video_asset_id
      WHERE qv.question_id=$1 AND qv.media_ref=$2 LIMIT 1`, [questionId, mediaRef]),
    getPool().query(`SELECT va.id, va.provider_id, va.provider_uri, va.embed_url, va.status
      FROM content_video_assets va
      WHERE va.sha256=$1
      ORDER BY (SELECT COUNT(*) FROM content_question_videos qv WHERE qv.video_asset_id=va.id) DESC,
        va.created_at ASC LIMIT 1`, [sha256]),
  ]);
  return { mapping: mapping.rows[0] || null, asset: asset.rows[0] || null };
}

export async function saveContentVideoMatch({ videoJobId, parentJob, match, uploaded, reusableAssetId = null }) {
  await ensureContentRegistrySchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    let assetId = reusableAssetId;
    if (!assetId) {
      const proposedAssetId = crypto.randomUUID();
      const asset = await client.query(`INSERT INTO content_video_assets
        (id, exam_track, source_namespace, sha256, original_name, size_bytes, provider_uri, provider_id, embed_url, source_data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        ON CONFLICT (exam_track, source_namespace, sha256) DO UPDATE SET updated_at=NOW() RETURNING id`,
        [proposedAssetId, parentJob.exam_track, parentJob.source_namespace, match.video.sha256, match.video.originalName, match.video.sizeBytes,
          uploaded.providerUri, uploaded.providerId, uploaded.embedUrl, JSON.stringify({ video_import_job_id: videoJobId, content_import_job_id: parentJob.id })]);
      assetId = asset.rows[0].id;
    }
    const link = await client.query(`INSERT INTO content_question_videos
      (id, question_id, video_asset_id, media_ref, source_data) VALUES ($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT (question_id, media_ref) DO NOTHING`, [crypto.randomUUID(), match.questionId, assetId, match.mediaRef,
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
    await client.query(`UPDATE content_questions q SET taxonomy=jsonb_build_object(
        'system_key',m.system_key,'subsystem_key',m.subsystem_key,'topic_key',m.topic_key,
        'subtopic_key',m.subtopic_key,'labels',m.labels,'source','provider_mapping'
      ), updated_at=NOW()
      FROM content_taxonomy_mappings m
      WHERE m.exam_track=q.exam_track AND m.exam_track=$1 AND m.source_namespace=$2
        AND m.source_system_id=q.system_key AND m.source_subject_id=q.subject_key AND m.status='active'
        AND EXISTS (SELECT 1 FROM content_source_aliases a
          WHERE a.question_id=q.id AND a.collection_id=$3)`,
    [job.exam_track, job.source_namespace, activeCollectionId]);
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

const CONTENT_DESTINATIONS = new Set([
  'aylamed_qbank', 'aylamed_roadmap', 'aylamed_auto_assessment',
  'aylamed_personal_assessment', 'baseline_diagnostic', 'revision',
  'flashcards', 'lms_assessment', 'marketing', 'external_qbank',
]);

function cleanDestinationRows(destinations = []) {
  const rows = Array.isArray(destinations) ? destinations : [];
  const resolved = new Map();
  for (const item of rows) {
    const row = typeof item === 'string' ? { destination: item, enabled: true } : item || {};
    const destination = String(row.destination || row.key || '').trim().toLowerCase();
    if (!CONTENT_DESTINATIONS.has(destination)) continue;
    const scope = String(row.destination_scope || row.scope || '').trim().toLowerCase();
    resolved.set(`${destination}:${scope}`, {
      destination, destinationScope: scope, enabled: row.enabled === true,
      settings: row.settings && typeof row.settings === 'object' ? row.settings : {},
    });
  }
  return [...resolved.values()];
}

function cleanDisplayPolicy(policy = {}) {
  const questionIdMode = ['internal', 'source', 'both', 'hidden'].includes(String(policy.question_id_mode || policy.questionIdMode))
    ? String(policy.question_id_mode || policy.questionIdMode) : 'internal';
  const sourceLabelMode = ['provider', 'neutral', 'hidden'].includes(String(policy.source_label_mode || policy.sourceLabelMode))
    ? String(policy.source_label_mode || policy.sourceLabelMode) : 'neutral';
  return { question_id_mode: questionIdMode, source_label_mode: sourceLabelMode };
}

export async function listContentCollections({ examTrack = '', status = '', limit = 50, offset = 0 } = {}) {
  await ensureContentRegistrySchema();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const values = [];
  const where = [];
  if (examTrack) { values.push(String(examTrack)); where.push(`c.exam_track=$${values.length}`); }
  if (status) { values.push(String(status)); where.push(`c.status=$${values.length}`); }
  values.push(safeLimit, safeOffset);
  const result = await getPool().query(`
    SELECT c.*,
      COUNT(DISTINCT a.question_id)::int AS question_count,
      COUNT(DISTINCT a.question_id) FILTER (WHERE q.status='approved')::int AS approved_question_count,
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
        'destination', d.destination, 'destination_scope', d.destination_scope,
        'enabled', d.enabled, 'settings', d.settings
      )) FILTER (WHERE d.id IS NOT NULL), '[]'::jsonb) AS destination_controls
    FROM content_collections c
    LEFT JOIN content_source_aliases a ON a.collection_id=c.id
    LEFT JOIN content_questions q ON q.id=a.question_id
    LEFT JOIN content_collection_destinations d ON d.collection_id=c.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY c.id ORDER BY c.created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}
  `, values);
  return result.rows;
}

export async function updateContentCollectionControls({ collectionId, status, destinations, displayPolicy, actorId = '' }) {
  await ensureContentRegistrySchema();
  const cleanStatus = ['draft', 'approved', 'disabled'].includes(String(status)) ? String(status) : null;
  const controls = destinations === undefined ? null : cleanDestinationRows(destinations);
  const policy = displayPolicy === undefined ? null : cleanDisplayPolicy(displayPolicy);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM content_collections WHERE id=$1 FOR UPDATE', [collectionId]);
    if (!existing.rows[0]) throw Object.assign(new Error('Content collection not found'), { statusCode: 404 });
    const collection = existing.rows[0];
    await client.query(`UPDATE content_collections SET
      status=COALESCE($2,status), display_policy=COALESCE($3::jsonb,display_policy),
      approved_at=CASE WHEN $2='approved' THEN COALESCE(approved_at,NOW()) WHEN $2='draft' THEN NULL ELSE approved_at END,
      approved_by=CASE WHEN $2='approved' THEN $4 WHEN $2='draft' THEN NULL ELSE approved_by END,
      updated_at=NOW() WHERE id=$1`, [collectionId, cleanStatus, policy ? JSON.stringify(policy) : null, actorId]);
    if (controls) {
      for (const row of controls) {
        await client.query(`INSERT INTO content_collection_destinations
          (id,collection_id,destination,destination_scope,enabled,settings,updated_by)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
          ON CONFLICT (collection_id,destination,destination_scope) DO UPDATE SET
          enabled=EXCLUDED.enabled, settings=EXCLUDED.settings, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [crypto.randomUUID(), collectionId, row.destination, row.destinationScope, row.enabled, JSON.stringify(row.settings), actorId]);
      }
      await client.query(`UPDATE content_collections SET destinations=COALESCE((
        SELECT jsonb_agg(destination ORDER BY destination) FROM content_collection_destinations
        WHERE collection_id=$1 AND enabled=TRUE
      ), '[]'::jsonb), updated_at=NOW() WHERE id=$1`, [collectionId]);
    }
    if (cleanStatus) {
      await client.query(`UPDATE content_questions q SET status=CASE WHEN EXISTS (
          SELECT 1 FROM content_source_aliases approved_alias
          JOIN content_collections approved_collection ON approved_collection.id=approved_alias.collection_id
          WHERE approved_alias.question_id=q.id AND approved_collection.status='approved'
        ) THEN 'approved' ELSE 'draft' END, updated_at=NOW()
        WHERE EXISTS (SELECT 1 FROM content_source_aliases changed_alias
          WHERE changed_alias.collection_id=$1 AND changed_alias.question_id=q.id)`, [collectionId]);
    }
    await client.query('COMMIT');
    return (await listContentCollections({ examTrack: collection.exam_track, limit: 200 })).find((row) => String(row.id) === String(collectionId));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function upsertContentTaxonomyMapping({ examTrack, sourceNamespace, sourceSystemId = '', sourceSubjectId = '', taxonomy = {}, actorId = '' }) {
  await ensureContentRegistrySchema();
  const systemKey = String(taxonomy.system_key || taxonomy.systemKey || '').trim();
  if (!systemKey) throw Object.assign(new Error('system_key is required'), { statusCode: 400 });
  const values = {
    system_key: systemKey,
    subsystem_key: String(taxonomy.subsystem_key || taxonomy.subsystemKey || '').trim(),
    topic_key: String(taxonomy.topic_key || taxonomy.topicKey || '').trim(),
    subtopic_key: String(taxonomy.subtopic_key || taxonomy.subtopicKey || '').trim(),
  };
  const labels = taxonomy.labels && typeof taxonomy.labels === 'object' ? taxonomy.labels : {};
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`INSERT INTO content_taxonomy_mappings
      (id,exam_track,source_namespace,source_system_id,source_subject_id,system_key,subsystem_key,topic_key,subtopic_key,labels,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
      ON CONFLICT (exam_track,source_namespace,source_system_id,source_subject_id) DO UPDATE SET
      system_key=EXCLUDED.system_key, subsystem_key=EXCLUDED.subsystem_key, topic_key=EXCLUDED.topic_key,
      subtopic_key=EXCLUDED.subtopic_key, labels=EXCLUDED.labels, status='active', updated_at=NOW()
      RETURNING *`, [crypto.randomUUID(), examTrack, sourceNamespace, String(sourceSystemId), String(sourceSubjectId),
      values.system_key, values.subsystem_key, values.topic_key, values.subtopic_key, JSON.stringify(labels), actorId]);
    const taxonomyPayload = JSON.stringify({ ...values, labels, source: 'provider_mapping' });
    await client.query(`UPDATE content_questions q SET taxonomy=$5::jsonb, updated_at=NOW()
      WHERE q.exam_track=$1 AND q.system_key=$3 AND q.subject_key=$4
      AND EXISTS (SELECT 1 FROM content_source_aliases a WHERE a.question_id=q.id AND a.source_namespace=$2)`,
    [examTrack, sourceNamespace, String(sourceSystemId), String(sourceSubjectId), taxonomyPayload]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function getContentQbankCatalog({ examTrack, destination = 'aylamed_qbank' }) {
  await ensureContentRegistrySchema();
  const examTracks = qbankExamTrackAliases(examTrack);
  const result = await getPool().query(`
    SELECT COALESCE(NULLIF(q.taxonomy->>'system_key',''),'unclassified') AS system_key,
      COALESCE(NULLIF(q.taxonomy->>'subsystem_key',''),'unclassified') AS subsystem_key,
      COALESCE(NULLIF(q.taxonomy->>'topic_key',''),NULLIF(q.title,''),'unclassified') AS topic_key,
      COALESCE(NULLIF(q.taxonomy->>'subtopic_key',''),'unclassified') AS subtopic_key,
      COUNT(DISTINCT q.id)::int AS question_count
    FROM content_questions q
    WHERE q.exam_track=ANY($1::text[]) AND q.status='approved'
      AND EXISTS (
        SELECT 1 FROM content_source_aliases a
        JOIN content_collection_destinations d ON d.collection_id=a.collection_id
        JOIN content_collections c ON c.id=a.collection_id
        WHERE a.question_id=q.id AND c.status='approved' AND d.destination=$2 AND d.enabled=TRUE
      )
    GROUP BY 1,2,3,4 ORDER BY 1,2,3,4
  `, [examTracks, destination]);
  return result.rows;
}

function qbankExamTrackAliases(examTrack = '') {
  const clean = String(examTrack || '').trim();
  const aliases = {
    'usmle-step-1': ['usmle-step-1', 'usmle_step_1'],
    'usmle-step-2': ['usmle-step-2', 'usmle-step-2-ck', 'usmle_step_2', 'usmle_step_2_ck'],
    'usmle-step-3': ['usmle-step-3', 'usmle_step_3'],
  };
  return aliases[clean] || [clean];
}

export function contentQbankQuestionDisplay(row = {}) {
  const policy = row.display_policy && typeof row.display_policy === 'object' ? row.display_policy : {};
  const questionIdMode = ['internal', 'source', 'both', 'hidden'].includes(String(policy.question_id_mode))
    ? String(policy.question_id_mode) : 'internal';
  const sourceLabelMode = ['provider', 'neutral', 'hidden'].includes(String(policy.source_label_mode))
    ? String(policy.source_label_mode) : 'neutral';
  const internalId = String(row.student_qid || '').trim() || null;
  const sourceId = String(row.source_item_id || '').trim() || null;
  let displayQuestionId = null;
  let questionIdentifiers = null;
  if (questionIdMode === 'internal') {
    displayQuestionId = internalId;
    questionIdentifiers = internalId ? { internal: internalId } : null;
  } else if (questionIdMode === 'source') {
    displayQuestionId = sourceId;
    questionIdentifiers = sourceId ? { source: sourceId } : null;
  } else if (questionIdMode === 'both') {
    displayQuestionId = internalId || sourceId;
    questionIdentifiers = { ...(internalId ? { internal: internalId } : {}), ...(sourceId ? { source: sourceId } : {}) };
    if (!Object.keys(questionIdentifiers).length) questionIdentifiers = null;
  }
  const sourceLabel = sourceLabelMode === 'provider'
    ? (String(row.source_provider || '').trim() || null)
    : sourceLabelMode === 'neutral'
      ? 'Source QID'
      : null;
  const { student_qid: _studentQid, source_item_id: _sourceItemId, source_provider: _sourceProvider, display_policy: _displayPolicy, ...question } = row;
  return { ...question, display_question_id: displayQuestionId, question_identifiers: questionIdentifiers, source_label: sourceLabel };
}

const QBANK_QUESTION_PROJECTION = `
  SELECT q.id, q.student_qid, q.exam_track, q.title, q.question_html, q.explanation_html, q.correct_answer_id,
    q.taxonomy,
    COALESCE(NULLIF(q.taxonomy->>'system_key',''),q.system_key) AS system_key,
    COALESCE(q.taxonomy->>'subsystem_key','') AS subsystem_key,
    COALESCE(q.taxonomy->>'topic_key',NULLIF(q.title,''),'unclassified') AS topic_key,
    COALESCE(q.taxonomy->>'subtopic_key','') AS subtopic_key,
    delivery.source_item_id, delivery.source_provider, delivery.display_policy,
    COALESCE(answers.items, '[]'::jsonb) AS answers,
    COALESCE(media.items, '[]'::jsonb) AS media,
    COALESCE(videos.items, '[]'::jsonb) AS videos
  FROM content_questions q
  JOIN LATERAL (
    SELECT a.source_item_id, c.source_provider, c.display_policy
    FROM content_source_aliases a
    JOIN content_collection_destinations d ON d.collection_id=a.collection_id
    JOIN content_collections c ON c.id=a.collection_id
    WHERE a.question_id=q.id AND c.status='approved' AND d.destination=$2 AND d.enabled=TRUE
    ORDER BY c.approved_at DESC NULLS LAST, c.created_at ASC, a.created_at ASC
    LIMIT 1
  ) delivery ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('answer_id',ca.answer_id,'text_html',ca.text_html) ORDER BY ca.answer_id) AS items
    FROM content_answers ca WHERE ca.question_id=q.id
  ) answers ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id',ma.id,'ref',qm.media_ref,'placement',qm.placement,'content_type',ma.content_type,'object_key',ma.object_key)
      ORDER BY qm.created_at) AS items
    FROM content_question_media qm JOIN content_media_assets ma ON ma.id=qm.media_asset_id
    WHERE qm.question_id=q.id
  ) media ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id',va.id,'ref',qv.media_ref,'placement',qv.placement,'provider','vimeo','provider_id',va.provider_id,'embed_url',va.embed_url)
      ORDER BY qv.created_at) AS items
    FROM content_question_videos qv JOIN content_video_assets va ON va.id=qv.video_asset_id
    WHERE qv.question_id=q.id
  ) videos ON TRUE`;

export async function listContentQbankQuestions({
  examTrack,
  destination = 'aylamed_qbank',
  systemKey = '',
  subsystemKey = '',
  topicKey = '',
  subtopicKey = '',
  limit = 40,
  seed = '',
} = {}) {
  await ensureContentRegistrySchema();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 40));
  const safeSeed = String(seed || crypto.randomUUID());
  const examTracks = qbankExamTrackAliases(examTrack);
  const result = await getPool().query(`${QBANK_QUESTION_PROJECTION}
    WHERE q.exam_track=ANY($1::text[]) AND q.status='approved'
      AND ($3='' OR COALESCE(NULLIF(q.taxonomy->>'system_key',''),q.system_key)=$3)
      AND ($4='' OR COALESCE(q.taxonomy->>'subsystem_key','')=$4)
      AND ($5='' OR COALESCE(q.taxonomy->>'topic_key',NULLIF(q.title,''),'unclassified')=$5)
      AND ($6='' OR COALESCE(q.taxonomy->>'subtopic_key','')=$6)
    ORDER BY md5(q.id::text || $7), q.id
    LIMIT $8`, [examTracks, destination, String(systemKey), String(subsystemKey), String(topicKey), String(subtopicKey), safeSeed, safeLimit]);
  return result.rows.map(contentQbankQuestionDisplay);
}

export async function getContentQbankQuestions({ questionIds = [], examTrack, destination = 'aylamed_qbank' } = {}) {
  await ensureContentRegistrySchema();
  const ids = [...new Set((Array.isArray(questionIds) ? questionIds : []).map(String).filter(Boolean))].slice(0, 200);
  if (!ids.length) return [];
  const examTracks = qbankExamTrackAliases(examTrack);
  const result = await getPool().query(`${QBANK_QUESTION_PROJECTION}
    WHERE q.exam_track=ANY($1::text[]) AND q.status='approved' AND q.id=ANY($3::uuid[])
    ORDER BY array_position($3::uuid[],q.id)`, [examTracks, destination, ids]);
  return result.rows.map(contentQbankQuestionDisplay);
}

export async function getContentRegistryFlashcardQuestion({ questionId, examTrack }) {
  await ensureContentRegistrySchema();
  const result = await getPool().query(`
    SELECT q.id, q.student_qid, q.exam_track, q.title, q.question_html, q.explanation_html,
      q.taxonomy, q.system_key, q.subject_key,
      COALESCE(q.taxonomy->>'subsystem_key','') AS subsystem_key,
      COALESCE(q.taxonomy->>'topic_key',NULLIF(q.title,''),'unclassified') AS topic_key,
      COALESCE(q.taxonomy->>'subtopic_key','') AS subtopic_key,
      correct.text_html AS correct_answer_html,
      COALESCE(media.items, '[]'::jsonb) AS media,
      COALESCE(videos.items, '[]'::jsonb) AS videos
    FROM content_questions q
    JOIN content_answers correct ON correct.question_id=q.id AND correct.is_correct=TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id',ma.id,'ref',qm.media_ref,'placement',qm.placement,'content_type',ma.content_type,'object_key',ma.object_key)
        ORDER BY qm.created_at) AS items
      FROM content_question_media qm JOIN content_media_assets ma ON ma.id=qm.media_asset_id
      WHERE qm.question_id=q.id
    ) media ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id',va.id,'ref',qv.media_ref,'placement',qv.placement,'provider','vimeo','provider_id',va.provider_id,'embed_url',va.embed_url)
        ORDER BY qv.created_at) AS items
      FROM content_question_videos qv JOIN content_video_assets va ON va.id=qv.video_asset_id
      WHERE qv.question_id=q.id
    ) videos ON TRUE
    WHERE q.id=$1 AND q.exam_track=$2 AND q.status='approved'
      AND EXISTS (
        SELECT 1 FROM content_source_aliases a
        JOIN content_collection_destinations d ON d.collection_id=a.collection_id
        JOIN content_collections c ON c.id=a.collection_id
        WHERE a.question_id=q.id AND c.status='approved' AND d.destination='flashcards' AND d.enabled=TRUE
      )
    LIMIT 1
  `, [questionId, examTrack]);
  return result.rows[0] || null;
}

export async function listContentRegistryFlashcardQuestions({ examTrack, systemKey = '', subsystemKey = '', topicKey = '', limit = 40, offset = 0 }) {
  await ensureContentRegistrySchema();
  const safeLimit = Math.max(1, Math.min(100, Number(limit || 40)));
  const safeOffset = Math.max(0, Number(offset || 0));
  const result = await getPool().query(`
    SELECT q.id, q.student_qid, q.exam_track, q.title, q.question_html, q.explanation_html,
      q.taxonomy, q.system_key, q.subject_key,
      COALESCE(q.taxonomy->>'subsystem_key','') AS subsystem_key,
      COALESCE(q.taxonomy->>'topic_key',NULLIF(q.title,''),'unclassified') AS topic_key,
      COALESCE(q.taxonomy->>'subtopic_key','') AS subtopic_key,
      correct.text_html AS correct_answer_html,
      COALESCE(media.items, '[]'::jsonb) AS media,
      COALESCE(videos.items, '[]'::jsonb) AS videos
    FROM content_questions q
    JOIN content_answers correct ON correct.question_id=q.id AND correct.is_correct=TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id',ma.id,'ref',qm.media_ref,'placement',qm.placement,'content_type',ma.content_type,'object_key',ma.object_key)
        ORDER BY qm.created_at) AS items
      FROM content_question_media qm JOIN content_media_assets ma ON ma.id=qm.media_asset_id
      WHERE qm.question_id=q.id
    ) media ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id',va.id,'ref',qv.media_ref,'placement',qv.placement,'provider','vimeo','provider_id',va.provider_id,'embed_url',va.embed_url)
        ORDER BY qv.created_at) AS items
      FROM content_question_videos qv JOIN content_video_assets va ON va.id=qv.video_asset_id
      WHERE qv.question_id=q.id
    ) videos ON TRUE
    WHERE q.exam_track=$1 AND q.status='approved'
      AND ($2='' OR COALESCE(NULLIF(q.taxonomy->>'system_key',''),q.system_key)=$2)
      AND ($3='' OR COALESCE(q.taxonomy->>'subsystem_key','')=$3)
      AND ($4='' OR COALESCE(q.taxonomy->>'topic_key',NULLIF(q.title,''),'unclassified')=$4)
      AND EXISTS (
        SELECT 1 FROM content_source_aliases a
        JOIN content_collection_destinations d ON d.collection_id=a.collection_id
        JOIN content_collections c ON c.id=a.collection_id
        WHERE a.question_id=q.id AND c.status='approved' AND d.destination='flashcards' AND d.enabled=TRUE
      )
    ORDER BY q.student_qid, q.id
    LIMIT $5 OFFSET $6
  `, [examTrack, String(systemKey), String(subsystemKey), String(topicKey), safeLimit, safeOffset]);
  return result.rows;
}
