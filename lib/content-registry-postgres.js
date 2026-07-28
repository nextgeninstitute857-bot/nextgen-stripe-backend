import crypto from "node:crypto";
import pg from "pg";
import {
  extractMediaReferences,
  mediaMatchKeys,
  mediaReferencePathCandidates,
  normalizeMediaReferencePath,
} from "./content-import-adapter.js";
import {
  CONTENT_TAXONOMY_EXAM_TRACKS,
  buildContentTaxonomyCoverageReport,
  normalizeContentTaxonomy,
  normalizeContentTaxonomyExamTrack,
  normalizeContentTaxonomyReviewAction,
  normalizeContentTaxonomyReviewState,
} from "./content-taxonomy-control.js";
import {
  contentRightsAreVerified,
  normalizeContentRightsStatus,
} from "./qbank-bulk-ingestion.js";

const { Pool } = pg;
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
let pool;
let schemaPromise;

const CONTENT_SOURCE_PROFILES = new Set([
  "uworld_style",
  "amboss_style",
  "canadaqbank_style",
  "aceqbank_style",
  "amedex_style",
  "mplusx_style",
  "aylamed_original",
  "other",
]);
const CONTENT_QBANK_PRESENTATION_MODES = new Set([
  "unified_aylamed",
  "source_switchable",
]);

export function normalizeContentSourceProfile(value = "", provider = "", { allowEmpty = false } = {}) {
  const clean = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!clean && allowEmpty) return "";
  const aliases = {
    uworld: "uworld_style",
    uworld_style: "uworld_style",
    explanation_led: "uworld_style",
    amboss: "amboss_style",
    amboss_style: "amboss_style",
    difficulty_stratified: "amboss_style",
    canadaqbank: "canadaqbank_style",
    canadaqbank_style: "canadaqbank_style",
    canada_qbank: "canadaqbank_style",
    aceqbank: "aceqbank_style",
    aceqbank_style: "aceqbank_style",
    ace_qbank: "aceqbank_style",
    amedex: "amedex_style",
    amedex_style: "amedex_style",
    mplusx: "mplusx_style",
    mplusx_style: "mplusx_style",
    mplus_x: "mplusx_style",
    aylamed: "aylamed_original",
    aylamed_original: "aylamed_original",
    original: "aylamed_original",
    internal: "aylamed_original",
    other: "other",
  };
  if (CONTENT_SOURCE_PROFILES.has(aliases[clean] || clean)) return aliases[clean] || clean;
  const providerKey = String(provider || "").trim().toLowerCase();
  if (providerKey.includes("uworld")) return "uworld_style";
  if (providerKey.includes("amboss")) return "amboss_style";
  if (providerKey.includes("canadaqbank") || providerKey.includes("canada qbank")) return "canadaqbank_style";
  if (providerKey.includes("aceqbank") || providerKey.includes("ace qbank")) return "aceqbank_style";
  if (providerKey.includes("amedex")) return "amedex_style";
  if (providerKey.includes("mplusx") || providerKey.includes("mplus x")) return "mplusx_style";
  if (providerKey.includes("aylamed")) return "aylamed_original";
  return "other";
}

export function normalizeContentQbankPresentationPolicy(input = {}, examTrack = "") {
  const canonicalExamTrack = normalizeContentTaxonomyExamTrack(
    examTrack || input.exam_track || input.examTrack,
  );
  if (!canonicalExamTrack) {
    throw Object.assign(new Error("A supported exam_track is required"), { statusCode: 400 });
  }
  const requestedMode = String(
    input.student_bank_mode || input.studentBankMode || input.mode || "unified_aylamed",
  ).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const modeAliases = {
    unified: "unified_aylamed",
    unified_aylamed: "unified_aylamed",
    aylamed: "unified_aylamed",
    source_switchable: "source_switchable",
    switchable: "source_switchable",
    student_choice: "source_switchable",
    provider_switchable: "source_switchable",
  };
  const studentBankMode = modeAliases[requestedMode] || requestedMode;
  if (!CONTENT_QBANK_PRESENTATION_MODES.has(studentBankMode)) {
    throw Object.assign(new Error("student_bank_mode must be unified_aylamed or source_switchable"), { statusCode: 400 });
  }
  return {
    exam_track: canonicalExamTrack,
    student_bank_mode: studentBankMode,
    student_can_choose_source_profile: studentBankMode === "source_switchable",
    student_brand_label: studentBankMode === "unified_aylamed" ? "AylaMed QBank" : "Question Bank",
    roadmap_source_strategy: "all_approved_profiles",
    personal_tutor_source_strategy: "all_approved_profiles",
    exact_duplicates_count_once: true,
  };
}

export function resolveContentQbankStudentSourceProfile(policy = {}, requestedSourceProfile = "") {
  const requested = normalizeContentSourceProfile(requestedSourceProfile, "", { allowEmpty: true });
  if (!requested) return "";
  if (String(policy.student_bank_mode || "") !== "source_switchable") {
    throw Object.assign(
      new Error("This exam uses one unified AylaMed QBank; students cannot select a source profile"),
      { statusCode: 403, code: "QBANK_SOURCE_SWITCH_DISABLED" },
    );
  }
  const available = new Set((Array.isArray(policy.available_source_profiles)
    ? policy.available_source_profiles
    : [])
    .filter((row) => Number(row?.question_count || 0) > 0)
    .map((row) => normalizeContentSourceProfile(row?.source_profile)));
  if (!available.has(requested)) {
    throw Object.assign(
      new Error("The selected QBank source profile has no approved questions for this exam"),
      { statusCode: 400, code: "QBANK_SOURCE_PROFILE_UNAVAILABLE" },
    );
  }
  return requested;
}

function getPool() {
  if (!DATABASE_URL) throw Object.assign(new Error("DATABASE_URL is required for Content Registry"), { statusCode: 503 });
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined,
      max: Math.max(1, Math.min(5, Number(process.env.NEXTGEN_CONTENT_PG_POOL_MAX || 3))),
      connectionTimeoutMillis: Math.max(500, Number(process.env.NEXTGEN_CONTENT_PG_CONNECT_TIMEOUT_MS || 2000)),
      idleTimeoutMillis: 30000,
    });
    pool.on("error", (error) => console.warn("Content Registry Postgres idle client error:", error.message));
  }
  return pool;
}

export function contentRegistryStatus() {
  return {
    configured: Boolean(DATABASE_URL),
    storage: "postgres",
    uploads_in_database: false,
    taxonomy_governance: "v209",
    taxonomy_review_queue: true,
    taxonomy_question_overrides: true,
    taxonomy_all_exam_coverage: true,
    content_hub_delivery: "v210",
    content_hub_embedded_vimeo: true,
    content_hub_roadmap_routing: true,
    operations_resumability: "v234",
    contextual_media_matching: "v236",
    contextual_mapping_repair_audit: true,
    reviewed_qbank_media_aliases: "v239",
    legacy_cdm_case_delivery: "v240",
    legacy_cdm_scoring: "student_self_review_only",
    background_job_state: "postgres_with_disk_recovery_copy",
    background_job_execution_leases: true,
    background_job_binaries_in_postgres: false,
    external_qbank_delivery: "v218",
    external_qbank_database_copy_required: false,
  };
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
    ALTER TABLE content_import_jobs ADD COLUMN IF NOT EXISTS source_profile TEXT NOT NULL DEFAULT 'other';
    ALTER TABLE content_import_jobs ADD COLUMN IF NOT EXISTS source_rights_status TEXT NOT NULL DEFAULT 'unverified';
    ALTER TABLE content_import_jobs ADD COLUMN IF NOT EXISTS media_aliases JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE content_import_jobs ADD COLUMN IF NOT EXISTS media_aliases_fingerprint TEXT NOT NULL DEFAULT '';
    ALTER TABLE content_import_jobs ADD COLUMN IF NOT EXISTS source_format TEXT NOT NULL DEFAULT 'single_best_answer_v1';
    UPDATE content_import_jobs SET source_profile=CASE
      WHEN LOWER(source_provider) LIKE '%uworld%' THEN 'uworld_style'
      WHEN LOWER(source_provider) LIKE '%amboss%' THEN 'amboss_style'
      WHEN LOWER(source_provider) LIKE '%canadaqbank%' OR LOWER(source_provider) LIKE '%canada qbank%' THEN 'canadaqbank_style'
      WHEN LOWER(source_provider) LIKE '%aceqbank%' OR LOWER(source_provider) LIKE '%ace qbank%' THEN 'aceqbank_style'
      WHEN LOWER(source_provider) LIKE '%amedex%' THEN 'amedex_style'
      WHEN LOWER(source_provider) LIKE '%mplusx%' OR LOWER(source_provider) LIKE '%mplus x%' THEN 'mplusx_style'
      WHEN LOWER(source_provider) LIKE '%aylamed%' THEN 'aylamed_original'
      ELSE source_profile END
      WHERE source_profile='other';
    CREATE INDEX IF NOT EXISTS idx_content_import_jobs_created ON content_import_jobs(created_at DESC);

    CREATE TABLE IF NOT EXISTS content_collections (
      id UUID PRIMARY KEY, exam_track TEXT NOT NULL, source_namespace TEXT NOT NULL,
      source_provider TEXT NOT NULL, collection_key TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', destinations JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(exam_track, source_namespace, collection_key)
    );
    ALTER TABLE content_collections ADD COLUMN IF NOT EXISTS source_profile TEXT NOT NULL DEFAULT 'other';
    ALTER TABLE content_collections ADD COLUMN IF NOT EXISTS source_rights_status TEXT NOT NULL DEFAULT 'unverified';
    ALTER TABLE content_collections ADD COLUMN IF NOT EXISTS source_format TEXT NOT NULL DEFAULT 'single_best_answer_v1';
    UPDATE content_collections SET source_profile=CASE
      WHEN LOWER(source_provider) LIKE '%uworld%' THEN 'uworld_style'
      WHEN LOWER(source_provider) LIKE '%amboss%' THEN 'amboss_style'
      WHEN LOWER(source_provider) LIKE '%canadaqbank%' OR LOWER(source_provider) LIKE '%canada qbank%' THEN 'canadaqbank_style'
      WHEN LOWER(source_provider) LIKE '%aceqbank%' OR LOWER(source_provider) LIKE '%ace qbank%' THEN 'aceqbank_style'
      WHEN LOWER(source_provider) LIKE '%amedex%' THEN 'amedex_style'
      WHEN LOWER(source_provider) LIKE '%mplusx%' OR LOWER(source_provider) LIKE '%mplus x%' THEN 'mplusx_style'
      WHEN LOWER(source_provider) LIKE '%aylamed%' THEN 'aylamed_original'
      ELSE source_profile END
      WHERE source_profile='other';
    ALTER TABLE content_collections ADD COLUMN IF NOT EXISTS display_policy JSONB NOT NULL DEFAULT '{"question_id_mode":"internal","source_label_mode":"neutral"}'::jsonb;
    ALTER TABLE content_collections ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
    ALTER TABLE content_collections ADD COLUMN IF NOT EXISTS approved_by TEXT;
    CREATE INDEX IF NOT EXISTS idx_content_collections_source_profile
      ON content_collections(exam_track, source_profile, status);

    CREATE TABLE IF NOT EXISTS content_qbank_presentation_policies (
      exam_track TEXT PRIMARY KEY,
      student_bank_mode TEXT NOT NULL DEFAULT 'unified_aylamed',
      updated_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    ALTER TABLE content_taxonomy_mappings ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'approved';
    ALTER TABLE content_taxonomy_mappings ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';
    ALTER TABLE content_taxonomy_mappings ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION;
    ALTER TABLE content_taxonomy_mappings ADD COLUMN IF NOT EXISTS review_notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE content_taxonomy_mappings ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT '';
    ALTER TABLE content_taxonomy_mappings ADD COLUMN IF NOT EXISTS reviewed_by TEXT NOT NULL DEFAULT '';
    ALTER TABLE content_taxonomy_mappings ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
    ALTER TABLE content_taxonomy_mappings ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
    CREATE INDEX IF NOT EXISTS idx_content_taxonomy_mapping_scope ON content_taxonomy_mappings(exam_track, source_namespace, status);
    CREATE INDEX IF NOT EXISTS idx_content_taxonomy_mapping_review ON content_taxonomy_mappings(exam_track, source_namespace, review_status, status);

    CREATE TABLE IF NOT EXISTS content_question_taxonomy_overrides (
      id UUID PRIMARY KEY, question_id UUID NOT NULL UNIQUE REFERENCES content_questions(id) ON DELETE CASCADE,
      exam_track TEXT NOT NULL, taxonomy JSONB NOT NULL, previous_taxonomy JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'active',
      reason TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE content_question_taxonomy_overrides ADD COLUMN IF NOT EXISTS previous_taxonomy JSONB NOT NULL DEFAULT '{}'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_content_question_taxonomy_override_scope ON content_question_taxonomy_overrides(exam_track, status);

    CREATE TABLE IF NOT EXISTS content_taxonomy_audit_events (
      id UUID PRIMARY KEY, mapping_id UUID REFERENCES content_taxonomy_mappings(id) ON DELETE SET NULL,
      question_id UUID REFERENCES content_questions(id) ON DELETE SET NULL,
      exam_track TEXT NOT NULL, source_namespace TEXT NOT NULL DEFAULT '',
      source_system_id TEXT NOT NULL DEFAULT '', source_subject_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL, before_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      after_state JSONB NOT NULL DEFAULT '{}'::jsonb, note TEXT NOT NULL DEFAULT '',
      actor_id TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_content_taxonomy_audit_scope ON content_taxonomy_audit_events(exam_track, created_at DESC);

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
    CREATE INDEX IF NOT EXISTS idx_content_alias_taxonomy_scope ON content_source_aliases(exam_track, source_namespace, question_id);

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
    ALTER TABLE content_media_assets ADD COLUMN IF NOT EXISTS media_kind TEXT NOT NULL DEFAULT 'image';
    CREATE INDEX IF NOT EXISTS idx_content_media_assets_scope ON content_media_assets(exam_track, source_namespace, status);

    CREATE TABLE IF NOT EXISTS content_media_import_assets (
      media_import_job_id UUID NOT NULL REFERENCES content_media_import_jobs(id) ON DELETE CASCADE,
      entry_index INTEGER NOT NULL, original_name TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL, content_type TEXT NOT NULL, size_bytes BIGINT NOT NULL,
      media_kind TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(media_import_job_id, entry_index)
    );
    CREATE INDEX IF NOT EXISTS idx_content_media_import_assets_job
      ON content_media_import_assets(media_import_job_id, entry_index);

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

    CREATE TABLE IF NOT EXISTS external_qbank_sessions (
      id UUID PRIMARY KEY, client_id TEXT NOT NULL, subject_hash TEXT NOT NULL,
      entitlement_hash TEXT NOT NULL, exam_track TEXT NOT NULL, destination_scope TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('tutor','test')), status TEXT NOT NULL DEFAULT 'active',
      question_count INTEGER NOT NULL CHECK (question_count BETWEEN 1 AND 100),
      block_size INTEGER NOT NULL DEFAULT 40 CHECK (block_size BETWEEN 1 AND 40),
      filters JSONB NOT NULL DEFAULT '{}'::jsonb, time_limit_minutes INTEGER,
      idempotency_key TEXT, request_fingerprint TEXT NOT NULL,
      answered_count INTEGER NOT NULL DEFAULT 0, correct_count INTEGER NOT NULL DEFAULT 0,
      incorrect_count INTEGER NOT NULL DEFAULT 0, unanswered_count INTEGER NOT NULL DEFAULT 0,
      score_percent NUMERIC(6,2), duration_ms BIGINT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), submitted_at TIMESTAMPTZ,
      entitlement_expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(client_id, subject_hash, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_external_qbank_sessions_owner
      ON external_qbank_sessions(client_id, subject_hash, exam_track, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_external_qbank_sessions_status
      ON external_qbank_sessions(client_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS external_qbank_session_items (
      session_id UUID NOT NULL REFERENCES external_qbank_sessions(id) ON DELETE CASCADE,
      question_ref UUID NOT NULL, question_id UUID NOT NULL REFERENCES content_questions(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL, selected_answer_id INTEGER, is_correct BOOLEAN, elapsed_ms BIGINT,
      answered_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(session_id, question_ref), UNIQUE(session_id, question_id), UNIQUE(session_id, position),
      FOREIGN KEY(question_id, selected_answer_id) REFERENCES content_answers(question_id, answer_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_external_qbank_items_question ON external_qbank_session_items(question_id);

    CREATE TABLE IF NOT EXISTS external_qbank_audit_events (
      id UUID PRIMARY KEY, client_id TEXT NOT NULL, subject_hash TEXT NOT NULL DEFAULT '',
      entitlement_hash TEXT NOT NULL DEFAULT '',
      session_id UUID REFERENCES external_qbank_sessions(id) ON DELETE SET NULL,
      exam_track TEXT NOT NULL DEFAULT '', action TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE external_qbank_audit_events ADD COLUMN IF NOT EXISTS entitlement_hash TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS idx_external_qbank_audit_client
      ON external_qbank_audit_events(client_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS content_background_jobs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, lane TEXT NOT NULL DEFAULT 'default',
      status TEXT NOT NULL, priority DOUBLE PRECISION NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      idempotency_key TEXT NOT NULL DEFAULT '', payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb, progress JSONB NOT NULL DEFAULT '{}'::jsonb,
      checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb, error TEXT,
      interrupted_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
      queued_at TIMESTAMPTZ, started_at TIMESTAMPTZ, heartbeat_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ, next_retry_at TIMESTAMPTZ,
      lease_owner TEXT, lease_expires_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_content_background_jobs_schedule
      ON content_background_jobs(status, priority DESC, queued_at ASC);
    CREATE INDEX IF NOT EXISTS idx_content_background_jobs_domain
      ON content_background_jobs((metadata->>'domain_job_id'), updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_content_background_jobs_lease
      ON content_background_jobs(lease_expires_at) WHERE lease_owner IS NOT NULL;
  `).then(() => true).catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

function contentBackgroundJob(row = {}) {
  return {
    id: row.id,
    type: row.type,
    lane: row.lane,
    status: row.status,
    priority: Number(row.priority || 0),
    attempts: Number(row.attempts || 0),
    max_attempts: Number(row.max_attempts || 3),
    idempotency_key: row.idempotency_key || "",
    payload: row.payload || {},
    metadata: row.metadata || {},
    progress: row.progress || {},
    checkpoint: row.checkpoint || {},
    error: row.error || null,
    interrupted_count: Number(row.interrupted_count || 0),
    created_at: row.created_at?.toISOString?.() || row.created_at || null,
    updated_at: row.updated_at?.toISOString?.() || row.updated_at || null,
    queued_at: row.queued_at?.toISOString?.() || row.queued_at || null,
    started_at: row.started_at?.toISOString?.() || row.started_at || null,
    heartbeat_at: row.heartbeat_at?.toISOString?.() || row.heartbeat_at || null,
    finished_at: row.finished_at?.toISOString?.() || row.finished_at || null,
    next_retry_at: row.next_retry_at?.toISOString?.() || row.next_retry_at || null,
    _lease_owner: row.lease_owner || null,
    _lease_expires_at: row.lease_expires_at?.toISOString?.() || row.lease_expires_at || null,
  };
}

/**
 * PostgreSQL is authoritative for background job checkpoints and execution
 * leases. The queue still keeps a disk recovery copy because upload bytes live
 * outside PostgreSQL and the service intentionally remains single-disk.
 */
export function createContentBackgroundJobStore({
  ownerId,
  leaseMs = 120_000,
  recoveryHistoryLimit = 100,
} = {}) {
  const cleanOwner = String(ownerId || `content-worker-${process.pid}-${crypto.randomUUID()}`).slice(0, 240);
  const safeLeaseMs = Math.max(30_000, Math.min(10 * 60 * 1000, Number(leaseMs) || 120_000));
  const safeRecoveryHistoryLimit = Math.max(
    10,
    Math.min(500, Math.floor(Number(recoveryHistoryLimit) || 100)),
  );
  return {
    kind: "postgres",
    ownerId: cleanOwner,
    leaseMs: safeLeaseMs,

    async load() {
      await ensureContentRegistrySchema();
      const result = await getPool().query(`WITH active_jobs AS (
          SELECT * FROM content_background_jobs
          WHERE status IN ('queued','running','retry_wait','paused','pause_requested','cancel_requested')
        ), recent_terminal_jobs AS (
          SELECT * FROM content_background_jobs
          WHERE status NOT IN ('queued','running','retry_wait','paused','pause_requested','cancel_requested')
          ORDER BY updated_at DESC
          LIMIT $1
        )
        SELECT * FROM active_jobs
        UNION ALL
        SELECT * FROM recent_terminal_jobs
        ORDER BY updated_at DESC`, [safeRecoveryHistoryLimit]);
      return result.rows.map(contentBackgroundJob);
    },

    async save(job = {}) {
      await ensureContentRegistrySchema();
      await getPool().query(`INSERT INTO content_background_jobs
        (id,type,lane,status,priority,attempts,max_attempts,idempotency_key,payload,metadata,
          progress,checkpoint,error,interrupted_count,created_at,updated_at,queued_at,started_at,
          heartbeat_at,finished_at,next_retry_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,
          $15::timestamptz,$16::timestamptz,$17::timestamptz,$18::timestamptz,$19::timestamptz,
          $20::timestamptz,$21::timestamptz)
        ON CONFLICT (id) DO UPDATE SET
          type=EXCLUDED.type,lane=EXCLUDED.lane,status=EXCLUDED.status,priority=EXCLUDED.priority,
          attempts=EXCLUDED.attempts,max_attempts=EXCLUDED.max_attempts,
          idempotency_key=EXCLUDED.idempotency_key,payload=EXCLUDED.payload,metadata=EXCLUDED.metadata,
          progress=EXCLUDED.progress,checkpoint=EXCLUDED.checkpoint,error=EXCLUDED.error,
          interrupted_count=EXCLUDED.interrupted_count,updated_at=EXCLUDED.updated_at,
          queued_at=EXCLUDED.queued_at,started_at=EXCLUDED.started_at,
          heartbeat_at=EXCLUDED.heartbeat_at,finished_at=EXCLUDED.finished_at,
          next_retry_at=EXCLUDED.next_retry_at`, [
        String(job.id),
        String(job.type),
        String(job.lane || "default"),
        String(job.status),
        Number(job.priority || 0),
        Number(job.attempts || 0),
        Number(job.max_attempts || 3),
        String(job.idempotency_key || ""),
        JSON.stringify(job.payload || {}),
        JSON.stringify(job.metadata || {}),
        JSON.stringify(job.progress || {}),
        JSON.stringify(job.checkpoint || {}),
        job.error || null,
        Number(job.interrupted_count || 0),
        job.created_at,
        job.updated_at,
        job.queued_at || null,
        job.started_at || null,
        job.heartbeat_at || null,
        job.finished_at || null,
        job.next_retry_at || null,
      ]);
    },

    async acquireLease(jobId) {
      await ensureContentRegistrySchema();
      const result = await getPool().query(`UPDATE content_background_jobs SET
          lease_owner=$2,lease_expires_at=NOW()+($3::bigint * INTERVAL '1 millisecond')
        WHERE id=$1 AND (
          lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= NOW() OR lease_owner=$2
        )
        RETURNING lease_expires_at`, [String(jobId), cleanOwner, safeLeaseMs]);
      return result.rowCount === 1;
    },

    async renewLease(jobId) {
      await ensureContentRegistrySchema();
      const result = await getPool().query(`UPDATE content_background_jobs SET
          lease_expires_at=NOW()+($3::bigint * INTERVAL '1 millisecond')
        WHERE id=$1 AND lease_owner=$2 RETURNING lease_expires_at`,
      [String(jobId), cleanOwner, safeLeaseMs]);
      return result.rowCount === 1;
    },

    async releaseLease(jobId) {
      await ensureContentRegistrySchema();
      await getPool().query(`UPDATE content_background_jobs
        SET lease_owner=NULL,lease_expires_at=NULL
        WHERE id=$1 AND lease_owner=$2`, [String(jobId), cleanOwner]);
    },
  };
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

function contentMediaImportAsset(row = {}) {
  return {
    mediaImportJobId: String(row.media_import_job_id || ""),
    entryIndex: Number(row.entry_index),
    originalName: row.original_name,
    objectKey: row.object_key,
    sha256: row.sha256,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes || 0),
    mediaKind: row.media_kind || "image",
  };
}

export async function listContentMediaImportAssets(mediaImportJobId) {
  await ensureContentRegistrySchema();
  const result = await getPool().query(`SELECT entry_index, original_name, object_key, sha256,
      content_type, size_bytes, media_kind
    FROM content_media_import_assets
    WHERE media_import_job_id=$1
    ORDER BY entry_index ASC`, [mediaImportJobId]);
  return result.rows.map(contentMediaImportAsset);
}

export async function listContentMediaImportAssetsForParent(contentImportJobId) {
  await ensureContentRegistrySchema();
  const result = await getPool().query(`SELECT assets.media_import_job_id, assets.entry_index,
      assets.original_name, assets.object_key, assets.sha256, assets.content_type,
      assets.size_bytes, assets.media_kind
    FROM content_media_import_jobs jobs
    JOIN content_media_import_assets assets ON assets.media_import_job_id=jobs.id
    WHERE jobs.content_import_job_id=$1
      AND jobs.status LIKE 'draft_imported%'
    ORDER BY jobs.created_at ASC, assets.media_import_job_id ASC, assets.entry_index ASC`,
  [contentImportJobId]);
  return result.rows.map(contentMediaImportAsset);
}

export async function stageContentMediaImportAsset({ mediaImportJobId, entryIndex, asset }) {
  const rows = await stageContentMediaImportAssets({
    mediaImportJobId,
    assets: [{ ...asset, entryIndex }],
  });
  return rows[0] || null;
}

export async function stageContentMediaImportAssets({ mediaImportJobId, assets = [] }) {
  await ensureContentRegistrySchema();
  const staged = (Array.isArray(assets) ? assets : [])
    .map((asset) => ({
      entry_index: Number(asset.entryIndex),
      original_name: String(asset.originalName || ""),
      object_key: String(asset.objectKey || ""),
      sha256: String(asset.sha256 || ""),
      content_type: String(asset.contentType || "application/octet-stream"),
      size_bytes: Number(asset.sizeBytes || 0),
      media_kind: String(asset.mediaKind || "image"),
    }))
    .filter((asset) => Number.isInteger(asset.entry_index) && asset.entry_index > 0);
  if (!staged.length) return [];
  const result = await getPool().query(`INSERT INTO content_media_import_assets
      (media_import_job_id, entry_index, original_name, object_key, sha256, content_type, size_bytes, media_kind)
    SELECT $1::uuid, staged_row.entry_index, staged_row.original_name, staged_row.object_key, staged_row.sha256,
      staged_row.content_type, staged_row.size_bytes, staged_row.media_kind
    FROM jsonb_to_recordset($2::jsonb) AS staged_row(
      entry_index INTEGER,
      original_name TEXT,
      object_key TEXT,
      sha256 TEXT,
      content_type TEXT,
      size_bytes BIGINT,
      media_kind TEXT
    )
    ON CONFLICT (media_import_job_id, entry_index) DO UPDATE SET
      original_name=EXCLUDED.original_name,
      object_key=EXCLUDED.object_key,
      sha256=EXCLUDED.sha256,
      content_type=EXCLUDED.content_type,
      size_bytes=EXCLUDED.size_bytes,
      media_kind=EXCLUDED.media_kind
    RETURNING entry_index, original_name, object_key, sha256, content_type, size_bytes, media_kind`,
  [mediaImportJobId, JSON.stringify(staged)]);
  return result.rows
    .map(contentMediaImportAsset)
    .sort((left, right) => left.entryIndex - right.entryIndex);
}

export async function getContentMediaReferences(contentImportJobId, kind = "all") {
  await ensureContentRegistrySchema();
  const result = await getPool().query(`SELECT DISTINCT ON (q.id)
      q.id AS question_id, q.student_qid, q.media_refs, q.question_html,
      q.explanation_html, q.source_data,
      ARRAY(
        SELECT DISTINCT ax.collection_key
        FROM content_source_aliases ax
        WHERE ax.question_id=q.id
          AND ax.exam_track=a.exam_track
          AND ax.source_namespace=a.source_namespace
        ORDER BY ax.collection_key
      ) AS source_snapshot_aliases
    FROM content_source_aliases a
    JOIN content_questions q ON q.id=a.question_id
    WHERE a.source_data->>'import_job_id'=$1 AND q.status='draft'
    ORDER BY q.id`, [contentImportJobId]);
  const rows = result.rows.flatMap((row) => {
    const sourceData = row.source_data && typeof row.source_data === "object"
      ? row.source_data
      : {};
    const sourceFile = String(sourceData.source_file || "");
    const storedPaths = sourceData.media_match_paths && typeof sourceData.media_match_paths === "object"
      ? sourceData.media_match_paths
      : {};
    const placements = sourceData.media_placements && typeof sourceData.media_placements === "object"
      ? sourceData.media_placements
      : {};
    const contextualReferences = [
      ...extractMediaReferences(row.question_html).map((reference) => ({
        reference,
        placement: "question",
      })),
      ...extractMediaReferences(row.explanation_html).map((reference) => ({
        reference,
        placement: "explanation",
      })),
    ];
    return (Array.isArray(row.media_refs) ? row.media_refs : []).map((mediaRef) => {
      const normalizedRef = normalizeMediaReferencePath(mediaRef);
      const referenceKeys = new Set(mediaMatchKeys(normalizedRef || mediaRef));
      const contextualMatches = contextualReferences.filter(({ reference }) =>
        mediaMatchKeys(reference).some((key) => referenceKeys.has(key)));
      const configuredPaths = Array.isArray(storedPaths[mediaRef])
        ? storedPaths[mediaRef]
        : storedPaths[mediaRef]
          ? [storedPaths[mediaRef]]
          : [];
      const matchPaths = [
        ...configuredPaths.flatMap((reference) =>
          mediaReferencePathCandidates(reference, { sourceFile })),
        ...contextualMatches.flatMap(({ reference }) =>
          mediaReferencePathCandidates(reference, { sourceFile })),
        ...mediaReferencePathCandidates(mediaRef, { sourceFile }),
      ].filter(Boolean);
      const contextualPlacement = contextualMatches.find(({ placement }) =>
        placement === "question")?.placement
        || contextualMatches[0]?.placement;
      return {
        questionId: row.question_id,
        studentQid: row.student_qid,
        mediaRef: String(mediaRef || ""),
        placement: placements[mediaRef] || contextualPlacement || "explanation",
        matchPaths: [...new Set(matchPaths)],
        sourceSnapshot: sourceFile,
        sourceSnapshotAliases: Array.isArray(row.source_snapshot_aliases)
          ? row.source_snapshot_aliases.map((value) => String(value || "")).filter(Boolean)
          : [],
      };
    });
  });
  const video = (value) => /\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg|wmv)(?:[?#].*)?$/i.test(String(value || ""));
  const audio = (value) => /\.(mp3|wav|m4a|aac|ogg|oga)(?:[?#].*)?$/i.test(String(value || ""));
  if (kind === "video") return rows.filter((row) => video(row.mediaRef));
  if (kind === "audio") return rows.filter((row) => audio(row.mediaRef));
  if (kind === "image") return rows.filter((row) => !video(row.mediaRef) && !audio(row.mediaRef));
  if (kind === "r2") return rows.filter((row) => !video(row.mediaRef));
  return rows;
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

export async function listContentOperationalJobs({ limit = 50 } = {}) {
  await ensureContentRegistrySchema();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const [questionJobs, mediaJobs, videoJobs] = await Promise.all([
    getPool().query(`SELECT id, exam_track, source_namespace, source_provider, source_profile, collection_title,
      source_rights_status, original_filename, zip_sha256, status, destinations, counts, errors,
      created_by, created_at, updated_at
      FROM content_import_jobs ORDER BY created_at DESC LIMIT $1`, [safeLimit]),
    getPool().query(`SELECT id, content_import_job_id, original_filename, zip_sha256, status,
      counts, errors, created_by, created_at, updated_at
      FROM content_media_import_jobs ORDER BY created_at DESC LIMIT $1`, [safeLimit]),
    getPool().query(`SELECT id, content_import_job_id, original_filename, zip_sha256, status,
      counts, errors, created_by, created_at, updated_at
      FROM content_video_import_jobs ORDER BY created_at DESC LIMIT $1`, [safeLimit]),
  ]);
  return {
    question_imports: questionJobs.rows,
    image_imports: mediaJobs.rows,
    video_imports: videoJobs.rows,
  };
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

export async function findReusableContentVideos(matches = []) {
  await ensureContentRegistrySchema();
  const input = (Array.isArray(matches) ? matches : []).slice(0, 1_000).map((match) => ({
    question_id: String(match?.questionId || ""),
    media_ref: String(match?.mediaRef || ""),
    sha256: String(match?.video?.sha256 || ""),
  })).filter((row) => row.question_id && row.media_ref && row.sha256);
  if (!input.length) return { mappingKeys: new Set(), assetsBySha: new Map() };
  const shas = [...new Set(input.map((row) => row.sha256))];
  const [mappingResult, assetResult] = await Promise.all([
    getPool().query(`WITH input AS (
        SELECT x.question_id::uuid AS question_id,x.media_ref
        FROM jsonb_to_recordset($1::jsonb) AS x(question_id TEXT,media_ref TEXT)
      )
      SELECT input.question_id::text,input.media_ref,qv.video_asset_id::text,
        va.provider_id,va.provider_uri,va.embed_url
      FROM input
      JOIN content_question_videos qv
        ON qv.question_id=input.question_id AND qv.media_ref=input.media_ref
      JOIN content_video_assets va ON va.id=qv.video_asset_id`, [JSON.stringify(input)]),
    getPool().query(`SELECT DISTINCT ON (va.sha256)
        va.id::text,va.sha256,va.provider_id,va.provider_uri,va.embed_url,va.status
      FROM content_video_assets va
      WHERE va.sha256=ANY($1::text[])
      ORDER BY va.sha256,
        (SELECT COUNT(*) FROM content_question_videos qv WHERE qv.video_asset_id=va.id) DESC,
        va.created_at ASC`, [shas]),
  ]);
  return {
    mappingKeys: new Set(mappingResult.rows.map((row) =>
      `${row.question_id}\u0000${row.media_ref}`)),
    assetsBySha: new Map(assetResult.rows.map((row) => [String(row.sha256), row])),
  };
}

export async function auditContentVideoMappings(matches = []) {
  await ensureContentRegistrySchema();
  const unique = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    const questionId = String(match?.questionId || "");
    const mediaRef = String(match?.mediaRef || "");
    if (!questionId || !mediaRef) continue;
    const key = `${questionId}\u0000${mediaRef}`;
    if (!unique.has(key)) {
      unique.set(key, {
        question_id: questionId,
        media_ref: mediaRef,
      });
    }
  }
  const input = [...unique.values()];
  if (!input.length) return { linked: [], missing: [] };
  const result = await getPool().query(`WITH input AS (
      SELECT x.question_id::uuid AS question_id,x.media_ref
      FROM jsonb_to_recordset($1::jsonb) AS x(
        question_id TEXT,
        media_ref TEXT
      )
    )
    SELECT input.question_id::text,input.media_ref,
      qv.id::text AS link_id,va.provider_id,va.status
    FROM input
    LEFT JOIN content_question_videos qv
      ON qv.question_id=input.question_id AND qv.media_ref=input.media_ref
    LEFT JOIN content_video_assets va ON va.id=qv.video_asset_id`,
  [JSON.stringify(input)]);
  const linkedKeys = new Set(result.rows
    .filter((row) => row.link_id)
    .map((row) => `${row.question_id}\u0000${row.media_ref}`));
  const byKey = new Map((Array.isArray(matches) ? matches : []).map((match) => [
    `${String(match?.questionId || "")}\u0000${String(match?.mediaRef || "")}`,
    match,
  ]));
  return {
    linked: [...linkedKeys].map((key) => byKey.get(key)).filter(Boolean),
    missing: [...byKey.entries()]
      .filter(([key]) => !linkedKeys.has(key))
      .map(([, match]) => match),
  };
}

export async function findContentVideoAssetsByOriginalNames({
  examTrack,
  sourceNamespace,
  originalNames = [],
} = {}) {
  await ensureContentRegistrySchema();
  const names = [...new Set((Array.isArray(originalNames) ? originalNames : [])
    .map(String)
    .filter(Boolean))].slice(0, 1_000);
  if (!names.length) return new Map();
  const result = await getPool().query(`SELECT id::text,sha256,original_name,
      provider_id,provider_uri,embed_url,status
    FROM content_video_assets
    WHERE exam_track=$1 AND source_namespace=$2
      AND original_name=ANY($3::text[])
    ORDER BY original_name,created_at ASC`, [
    String(examTrack || ""),
    String(sourceNamespace || ""),
    names,
  ]);
  const assets = new Map();
  for (const row of result.rows) {
    if (!assets.has(String(row.original_name))) {
      assets.set(String(row.original_name), row);
    }
  }
  return assets;
}

export async function auditContentVideoAliasMappings(matches = []) {
  await ensureContentRegistrySchema();
  const unique = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    const questionId = String(match?.questionId || "");
    const mediaRef = String(match?.mediaRef || "");
    const sha256 = String(match?.video?.sha256 || "");
    if (!questionId || !mediaRef || !sha256) continue;
    const key = `${questionId}\u0000${mediaRef}`;
    if (!unique.has(key)) unique.set(key, {
      question_id: questionId,
      media_ref: mediaRef,
      expected_sha256: sha256,
    });
  }
  const input = [...unique.values()];
  if (!input.length) {
    return { exactMatches: [], missingMatches: [], conflictingMatches: [] };
  }
  const result = await getPool().query(`WITH input AS (
      SELECT x.question_id::uuid AS question_id,x.media_ref,x.expected_sha256
      FROM jsonb_to_recordset($1::jsonb) AS x(
        question_id TEXT,media_ref TEXT,expected_sha256 TEXT
      )
    )
    SELECT input.question_id::text,input.media_ref,input.expected_sha256,
      qv.id::text AS link_id,va.sha256 AS linked_sha256
    FROM input
    LEFT JOIN content_question_videos qv
      ON qv.question_id=input.question_id AND qv.media_ref=input.media_ref
    LEFT JOIN content_video_assets va ON va.id=qv.video_asset_id`,
  [JSON.stringify(input)]);
  const exactKeys = new Set();
  const missingKeys = new Set();
  const conflictingKeys = new Set();
  for (const row of result.rows) {
    const key = `${row.question_id}\u0000${row.media_ref}`;
    if (!row.link_id) missingKeys.add(key);
    else if (String(row.linked_sha256 || "") === String(row.expected_sha256 || "")) {
      exactKeys.add(key);
    } else {
      conflictingKeys.add(key);
    }
  }
  const byKey = new Map((Array.isArray(matches) ? matches : []).map((match) => [
    `${String(match?.questionId || "")}\u0000${String(match?.mediaRef || "")}`,
    match,
  ]));
  return {
    exactMatches: [...exactKeys].map((key) => byKey.get(key)).filter(Boolean),
    missingMatches: [...missingKeys].map((key) => byKey.get(key)).filter(Boolean),
    conflictingMatches: [...conflictingKeys].map((key) => byKey.get(key)).filter(Boolean),
  };
}

export async function saveContentVideoAsset({
  videoJobId,
  parentJob,
  video,
  uploaded,
}) {
  await ensureContentRegistrySchema();
  const result = await getPool().query(`INSERT INTO content_video_assets
      (id,exam_track,source_namespace,sha256,original_name,size_bytes,
        provider_uri,provider_id,embed_url,source_data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT (exam_track,source_namespace,sha256) DO UPDATE SET updated_at=NOW()
    RETURNING id::text,sha256,provider_id,provider_uri,embed_url,status`, [
    crypto.randomUUID(),
    parentJob.exam_track,
    parentJob.source_namespace,
    String(video.sha256),
    String(video.originalName || ""),
    Number(video.sizeBytes || 0),
    uploaded.providerUri,
    uploaded.providerId,
    uploaded.embedUrl,
    JSON.stringify({
      video_import_job_id: videoJobId,
      content_import_job_id: parentJob.id,
    }),
  ]);
  return result.rows[0];
}

export async function saveContentVideoLinksBatch({
  videoJobId,
  matches = [],
  assetsBySha = new Map(),
}) {
  await ensureContentRegistrySchema();
  const rows = [];
  for (const match of Array.isArray(matches) ? matches : []) {
    const asset = assetsBySha instanceof Map
      ? assetsBySha.get(String(match?.video?.sha256 || ""))
      : assetsBySha?.[String(match?.video?.sha256 || "")];
    if (!asset?.id) continue;
    rows.push({
      id: crypto.randomUUID(),
      question_id: String(match.questionId),
      video_asset_id: String(asset.id),
      media_ref: String(match.mediaRef),
      placement: String(match.placement || "explanation"),
      student_qid: String(match.studentQid || ""),
    });
  }
  if (!rows.length) return { linksVerified: 0, linksCreated: 0 };
  const result = await getPool().query(`INSERT INTO content_question_videos
      (id,question_id,video_asset_id,media_ref,placement,status,source_data)
    SELECT x.id::uuid,x.question_id::uuid,x.video_asset_id::uuid,x.media_ref,
      x.placement,'draft',
      jsonb_build_object('video_import_job_id',$2::text,'student_qid',x.student_qid)
    FROM jsonb_to_recordset($1::jsonb) AS x(
      id TEXT,question_id TEXT,video_asset_id TEXT,media_ref TEXT,placement TEXT,student_qid TEXT
    )
    ON CONFLICT (question_id,media_ref) DO NOTHING
    RETURNING id`, [JSON.stringify(rows), String(videoJobId)]);
  return {
    linksVerified: rows.length,
    linksCreated: result.rowCount,
  };
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
      (id, question_id, video_asset_id, media_ref, placement, source_data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT (question_id, media_ref) DO NOTHING`, [crypto.randomUUID(), match.questionId, assetId, match.mediaRef, match.placement || 'explanation',
        JSON.stringify({ video_import_job_id: videoJobId, student_qid: match.studentQid })]);
    await client.query("COMMIT");
    return link.rowCount;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function saveContentMediaMatchBatch({
  mediaJobId,
  parentJob,
  assets = [],
  matches = [],
}) {
  await ensureContentRegistrySchema();
  const assetRowsBySha = new Map();
  for (const asset of Array.isArray(assets) ? assets : []) {
    const sha256 = String(asset?.sha256 || "");
    if (!sha256 || assetRowsBySha.has(sha256)) continue;
    assetRowsBySha.set(sha256, {
      id: crypto.randomUUID(),
      sha256,
      object_key: String(asset.objectKey || ""),
      original_name: String(asset.originalName || ""),
      content_type: String(asset.contentType || "application/octet-stream"),
      size_bytes: Math.max(0, Number(asset.sizeBytes || 0)),
      media_kind: String(asset.mediaKind || "image"),
    });
  }
  const assetRows = [...assetRowsBySha.values()];
  if (!assetRows.length) {
    return {
      links: 0,
      linksCreated: 0,
      linkConflicts: 0,
      duplicateObjects: [],
    };
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const assetResult = await client.query(`INSERT INTO content_media_assets
        (id, exam_track, source_namespace, sha256, object_key, original_name, content_type, size_bytes, media_kind, status, source_data)
      SELECT x.id::uuid, $1, $2, x.sha256, x.object_key, x.original_name,
        x.content_type, x.size_bytes, x.media_kind, 'draft',
        jsonb_build_object('media_import_job_id',$4::text,'content_import_job_id',$5::text)
      FROM jsonb_to_recordset($3::jsonb) AS x(
        id TEXT,
        sha256 TEXT,
        object_key TEXT,
        original_name TEXT,
        content_type TEXT,
        size_bytes BIGINT,
        media_kind TEXT
      )
        ON CONFLICT (exam_track, source_namespace, sha256) DO UPDATE SET original_name=EXCLUDED.original_name, media_kind=EXCLUDED.media_kind
      RETURNING id, sha256, object_key`,
    [
      parentJob.exam_track,
      parentJob.source_namespace,
      JSON.stringify(assetRows),
      mediaJobId,
      parentJob.id,
    ]);
    const assetIds = new Map(assetResult.rows.map((row) => [
      String(row.sha256),
      { id: row.id, objectKey: row.object_key },
    ]));
    const duplicateObjects = [...new Set((Array.isArray(assets) ? assets : [])
      .map((asset) => {
        const resolved = assetIds.get(String(asset?.sha256 || ""));
        const objectKey = String(asset?.objectKey || "");
        return resolved && objectKey && String(resolved.objectKey) !== objectKey
          ? objectKey
          : null;
      })
      .filter(Boolean))];
    const linkRows = [];
    const seenLinks = new Set();
    for (const match of Array.isArray(matches) ? matches : []) {
      const resolved = assetIds.get(String(match?.asset?.sha256 || ""));
      if (!resolved) continue;
      const key = `${String(match.questionId || "")}\u0000${String(match.mediaRef || "")}`;
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      linkRows.push({
        id: crypto.randomUUID(),
        question_id: String(match.questionId || ""),
        media_asset_id: String(resolved.id),
        media_ref: String(match.mediaRef || ""),
        placement: String(match.placement || "explanation"),
        student_qid: String(match.studentQid || ""),
      });
    }
    let linksCreated = 0;
    let links = 0;
    if (linkRows.length) {
      const linkResult = await client.query(`INSERT INTO content_question_media
        (id, question_id, media_asset_id, media_ref, placement, status, source_data)
      SELECT x.id::uuid, x.question_id::uuid, x.media_asset_id::uuid,
        x.media_ref, x.placement, 'draft',
        jsonb_build_object('media_import_job_id',$1::text,'student_qid',x.student_qid)
      FROM jsonb_to_recordset($2::jsonb) AS x(
        id TEXT,
        question_id TEXT,
        media_asset_id TEXT,
        media_ref TEXT,
        placement TEXT,
        student_qid TEXT
      )
      ON CONFLICT (question_id, media_ref) DO NOTHING`,
      [mediaJobId, JSON.stringify(linkRows)]);
      linksCreated = linkResult.rowCount;
      const verification = await client.query(`SELECT COUNT(*)::int AS linked
        FROM content_question_media qm
        JOIN jsonb_to_recordset($1::jsonb) AS x(
          question_id TEXT,
          media_asset_id TEXT,
          media_ref TEXT
        )
          ON qm.question_id=x.question_id::uuid
          AND qm.media_asset_id=x.media_asset_id::uuid
          AND qm.media_ref=x.media_ref`,
      [JSON.stringify(linkRows)]);
      links = Number(verification.rows[0]?.linked || 0);
    }
    await client.query("COMMIT");
    return {
      links,
      linksCreated,
      linkConflicts: Math.max(0, linkRows.length - links),
      duplicateObjects,
    };
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function saveContentMediaMatches(options) {
  return saveContentMediaMatchBatch(options);
}

export async function auditContentMediaLinks(matches = []) {
  await ensureContentRegistrySchema();
  const unique = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    const questionId = String(match?.questionId || "");
    const mediaRef = String(match?.mediaRef || "");
    const sha256 = String(match?.asset?.sha256 || "");
    if (!questionId || !mediaRef || !sha256) continue;
    const key = `${questionId}\u0000${mediaRef}`;
    if (!unique.has(key)) unique.set(key, {
      question_id: questionId,
      media_ref: mediaRef,
      expected_sha256: sha256,
    });
  }
  const input = [...unique.values()];
  if (!input.length) {
    return {
      exactMatches: [],
      missingMatches: [],
      conflictingMatches: [],
    };
  }
  const result = await getPool().query(`WITH input AS (
      SELECT x.question_id::uuid AS question_id,x.media_ref,x.expected_sha256
      FROM jsonb_to_recordset($1::jsonb) AS x(
        question_id TEXT,
        media_ref TEXT,
        expected_sha256 TEXT
      )
    )
    SELECT input.question_id::text,input.media_ref,input.expected_sha256,
      qm.id::text AS link_id,ma.sha256 AS linked_sha256
    FROM input
    LEFT JOIN content_question_media qm
      ON qm.question_id=input.question_id AND qm.media_ref=input.media_ref
    LEFT JOIN content_media_assets ma ON ma.id=qm.media_asset_id`,
  [JSON.stringify(input)]);
  const exactKeys = new Set();
  const missingKeys = new Set();
  const conflictingKeys = new Set();
  for (const row of result.rows) {
    const key = `${row.question_id}\u0000${row.media_ref}`;
    if (!row.link_id) missingKeys.add(key);
    else if (String(row.linked_sha256 || "") === String(row.expected_sha256 || "")) {
      exactKeys.add(key);
    } else {
      conflictingKeys.add(key);
    }
  }
  const byKey = new Map((Array.isArray(matches) ? matches : []).map((match) => [
    `${String(match?.questionId || "")}\u0000${String(match?.mediaRef || "")}`,
    match,
  ]));
  return {
    exactMatches: [...exactKeys].map((key) => byKey.get(key)).filter(Boolean),
    missingMatches: [...missingKeys].map((key) => byKey.get(key)).filter(Boolean),
    conflictingMatches: [...conflictingKeys].map((key) => byKey.get(key)).filter(Boolean),
  };
}

export async function createContentImportJob(job) {
  await ensureContentRegistrySchema();
  await getPool().query(`INSERT INTO content_import_jobs
    (id, exam_track, source_namespace, source_provider, source_profile, source_rights_status,
      source_format, collection_title, original_filename, zip_sha256, destinations, media_aliases,
      media_aliases_fingerprint, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)`, [
    job.id, job.examTrack, job.sourceNamespace, job.sourceProvider,
    normalizeContentSourceProfile(job.sourceProfile, job.sourceProvider),
    normalizeContentRightsStatus(job.sourceRightsStatus),
    String(job.sourceFormat || "single_best_answer_v1"),
    job.collectionTitle, job.originalFilename, job.zipSha256,
    JSON.stringify(job.destinations || []), JSON.stringify(job.mediaAliases || []),
    String(job.mediaAliasesFingerprint || ""), job.createdBy,
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
    WHERE id=$1 AND status IN ('preview_ready','preview_with_warnings')
      AND COALESCE((counts->>'import_blocked')::boolean, false)=false
      AND COALESCE((counts->>'blocking_issues')::int, 0)=0
    RETURNING *`, [id]);
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
      (id, exam_track, source_namespace, source_provider, source_profile, source_rights_status, source_format,
        collection_key, title, status, destinations)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10::jsonb)
      ON CONFLICT (exam_track, source_namespace, collection_key) DO UPDATE SET
        title=EXCLUDED.title, source_provider=EXCLUDED.source_provider,
        source_profile=EXCLUDED.source_profile,
        source_format=EXCLUDED.source_format,
        source_rights_status=CASE
          WHEN content_collections.source_rights_status IN ('owned','licensed','authorized')
            THEN content_collections.source_rights_status
          ELSE EXCLUDED.source_rights_status
        END,
        destinations=EXCLUDED.destinations, updated_at=NOW()
      RETURNING id`, [
      collectionId, job.exam_track, job.source_namespace, job.source_provider,
      normalizeContentSourceProfile(job.source_profile, job.source_provider),
      normalizeContentRightsStatus(job.source_rights_status),
      String(job.source_format || "single_best_answer_v1"),
      collectionKey, collectionTitle, JSON.stringify(destinations),
    ]);
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
    const preferredRows = new Map();
    for (const row of rows) {
      const previous = preferredRows.get(row.contentHash);
      if (!previous || Number(row.sourceData?.source_rank || 0) > Number(previous.sourceData?.source_rank || 0)) preferredRows.set(row.contentHash, row);
    }
    const metadataPayload = [...preferredRows.values()].map((row) => ({
      canonical_hash: row.contentHash, title: row.title, question_html: row.questionHtml, explanation_html: row.explanationHtml,
      system_key: row.systemSourceId, subject_key: row.subjectSourceId, media_refs: row.media,
      source_rank: Number(row.sourceData?.source_rank || 0),
      source_data: { ...row.sourceData, statistics: row.statistics, source_updated_at: row.sourceUpdatedAt },
    }));
    if (metadataPayload.length) await client.query(`UPDATE content_questions q SET
      title=x.title, question_html=x.question_html, explanation_html=x.explanation_html, system_key=x.system_key, subject_key=x.subject_key,
      media_refs=x.media_refs, source_data=x.source_data, updated_at=NOW()
      FROM jsonb_to_recordset($2::jsonb) AS x(canonical_hash text, title text, question_html text, explanation_html text,
        system_key text, subject_key text, media_refs jsonb, source_rank bigint, source_data jsonb)
      WHERE q.exam_track=$1 AND q.canonical_hash=x.canonical_hash AND q.status='draft'
        AND (CASE WHEN COALESCE(q.source_data->>'source_rank','') ~ '^[0-9]+$'
          THEN (q.source_data->>'source_rank')::bigint ELSE 0 END) < x.source_rank`, [job.exam_track, JSON.stringify(metadataPayload)]);
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
    // Lock collection questions before reading override state. A concurrent
    // question override either wins before this lock and is observed below, or
    // waits and writes after the provider mapping, so the exception always wins.
    await client.query(`SELECT q.id FROM content_questions q
      WHERE EXISTS (SELECT 1 FROM content_source_aliases a
        WHERE a.question_id=q.id AND a.collection_id=$1) FOR UPDATE`, [activeCollectionId]);
    await client.query(`UPDATE content_questions q SET taxonomy=jsonb_build_object(
        'system_key',m.system_key,'subsystem_key',m.subsystem_key,'topic_key',m.topic_key,
        'subtopic_key',m.subtopic_key,'labels',m.labels,'source','provider_mapping',
        'mapping_id',m.id::text,'review_status',m.review_status
      ), updated_at=NOW()
      FROM content_taxonomy_mappings m
      WHERE m.exam_track=q.exam_track AND m.exam_track=$1 AND m.source_namespace=$2
        AND m.source_system_id=q.system_key AND m.source_subject_id=q.subject_key
        AND m.status='active' AND m.review_status='approved'
        AND EXISTS (SELECT 1 FROM content_source_aliases a
          WHERE a.question_id=q.id AND a.collection_id=$3)
        AND NOT EXISTS (SELECT 1 FROM content_question_taxonomy_overrides o
          WHERE o.question_id=q.id AND o.status='active')`,
    [job.exam_track, job.source_namespace, activeCollectionId]);
    const answerPayload = rows.flatMap((row) => row.answers.map((answer) => ({
      question_id: questionIds.get(row.contentHash), answer_id: answer.answerId, text_html: answer.textHtml,
      is_correct: answer.answerId === row.correctAnswerId,
      source_data: {
        source_id: answer.sourceId,
        correct_percentage: answer.correctPercentage,
        media_refs: Array.isArray(answer.mediaRefs) ? answer.mediaRefs : [],
      },
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
  'aylamed_content_hub', 'aylamed_cdm',
]);

const CONTENT_DESTINATION_ALIASES = Object.freeze({
  roadmap: 'aylamed_roadmap',
  content_hub: 'aylamed_content_hub',
  video_library: 'aylamed_content_hub',
  automatic_assessment: 'aylamed_auto_assessment',
  personal_assessment: 'aylamed_personal_assessment',
  cdm: 'aylamed_cdm',
  legacy_cdm: 'aylamed_cdm',
});

function cleanContentDestination(value = '') {
  const clean = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return CONTENT_DESTINATION_ALIASES[clean] || clean;
}

function cleanDestinationRows(destinations = []) {
  const rows = Array.isArray(destinations) ? destinations : [];
  const resolved = new Map();
  for (const item of rows) {
    const row = typeof item === 'string' ? { destination: item, enabled: true } : item || {};
    const destination = cleanContentDestination(row.destination || row.key);
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

export function contentCollectionDestinationCompatibility({
  itemFormats = [],
  destinations = [],
} = {}) {
  const formats = new Set((Array.isArray(itemFormats) ? itemFormats : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  const enabled = new Set((Array.isArray(destinations) ? destinations : [])
    .map((value) => cleanContentDestination(
      typeof value === 'string' ? value : value?.destination || value?.key,
    ))
    .filter(Boolean));
  const hasCdm = formats.has('cdm_self_rating_case');
  const hasOrdinary = [...formats].some((format) => format !== 'cdm_self_rating_case');
  const errors = [];
  if (hasCdm && hasOrdinary) errors.push('mixed_cdm_and_ordinary_items');
  if (hasCdm) {
    const allowed = new Set(['aylamed_cdm', 'aylamed_roadmap']);
    if ([...enabled].some((destination) => !allowed.has(destination))) {
      errors.push('cdm_incompatible_destination');
    }
    if (!enabled.has('aylamed_cdm')) errors.push('cdm_delivery_destination_required');
  }
  if (!hasCdm && enabled.has('aylamed_cdm')) errors.push('cdm_destination_requires_cdm_items');
  return [...new Set(errors)];
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

export async function updateContentCollectionControls({
  collectionId,
  status,
  destinations,
  displayPolicy,
  sourceProfile,
  sourceRightsStatus,
  actorId = '',
}) {
  await ensureContentRegistrySchema();
  const cleanStatus = ['draft', 'approved', 'disabled'].includes(String(status)) ? String(status) : null;
  const controls = destinations === undefined ? null : cleanDestinationRows(destinations);
  const policy = displayPolicy === undefined ? null : cleanDisplayPolicy(displayPolicy);
  const cleanSourceProfile = sourceProfile === undefined
    ? null
    : normalizeContentSourceProfile(sourceProfile);
  const cleanSourceRightsStatus = sourceRightsStatus === undefined
    ? null
    : normalizeContentRightsStatus(sourceRightsStatus);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM content_collections WHERE id=$1 FOR UPDATE', [collectionId]);
    if (!existing.rows[0]) throw Object.assign(new Error('Content collection not found'), { statusCode: 404 });
    const collection = existing.rows[0];
    const [formatRows, savedDestinationRows] = await Promise.all([
      client.query(`SELECT DISTINCT COALESCE(NULLIF(q.source_data->>'item_format',''),'single_best_answer') AS item_format
        FROM content_source_aliases a JOIN content_questions q ON q.id=a.question_id
        WHERE a.collection_id=$1`, [collectionId]),
      client.query(`SELECT destination,destination_scope,enabled,settings
        FROM content_collection_destinations WHERE collection_id=$1`, [collectionId]),
    ]);
    const effectiveDestinationRows = new Map(savedDestinationRows.rows.map((row) => [
      `${cleanContentDestination(row.destination)}:${String(row.destination_scope || '')}`,
      { ...row, destination: cleanContentDestination(row.destination) },
    ]));
    for (const row of controls || []) {
      effectiveDestinationRows.set(`${row.destination}:${row.destinationScope}`, row);
    }
    const compatibilityErrors = contentCollectionDestinationCompatibility({
      itemFormats: formatRows.rows.map((row) => row.item_format),
      destinations: [...effectiveDestinationRows.values()]
        .filter((row) => row.enabled === true)
        .map((row) => row.destination),
    });
    if (compatibilityErrors.length && (
      cleanStatus === 'approved'
      || [...effectiveDestinationRows.values()].some((row) => row.enabled === true)
    )) {
      throw Object.assign(
        new Error(`Collection destination is incompatible with its interaction format: ${compatibilityErrors.join(', ')}`),
        { statusCode: 409, code: 'CONTENT_FORMAT_DESTINATION_MISMATCH', details: compatibilityErrors },
      );
    }
    const nextRightsStatus = cleanSourceRightsStatus || collection.source_rights_status || 'unverified';
    const requiresVerifiedRights = cleanStatus === 'approved'
      || Boolean(controls?.some((row) => row.enabled));
    if (requiresVerifiedRights && !contentRightsAreVerified(nextRightsStatus)) {
      throw Object.assign(
        new Error('Verify that AylaMed owns, licenses, or is authorized to distribute this collection before approving it or enabling a destination'),
        { statusCode: 409, code: 'CONTENT_RIGHTS_VERIFICATION_REQUIRED' },
      );
    }
    if (cleanSourceRightsStatus && !contentRightsAreVerified(cleanSourceRightsStatus)
      && collection.status === 'approved') {
      throw Object.assign(
        new Error('Disable this approved collection before changing its content-rights status to unverified'),
        { statusCode: 409, code: 'CONTENT_RIGHTS_DOWNGRADE_REQUIRES_DISABLE' },
      );
    }
    await client.query(`UPDATE content_collections SET
      status=COALESCE($2,status), display_policy=COALESCE($3::jsonb,display_policy),
      source_profile=COALESCE($4,source_profile),
      source_rights_status=COALESCE($5,source_rights_status),
      approved_at=CASE WHEN $2='approved' THEN COALESCE(approved_at,NOW()) WHEN $2='draft' THEN NULL ELSE approved_at END,
      approved_by=CASE WHEN $2='approved' THEN $6 WHEN $2='draft' THEN NULL ELSE approved_by END,
      updated_at=NOW() WHERE id=$1`, [
      collectionId,
      cleanStatus,
      policy ? JSON.stringify(policy) : null,
      cleanSourceProfile,
      cleanSourceRightsStatus,
      actorId,
    ]);
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

export async function getContentQbankPresentationPolicy({ examTrack } = {}) {
  await ensureContentRegistrySchema();
  const normalized = normalizeContentQbankPresentationPolicy({}, examTrack);
  const examTracks = qbankExamTrackAliases(normalized.exam_track);
  const [saved, profileCounts] = await Promise.all([
    getPool().query(
      `SELECT exam_track,student_bank_mode,updated_by,created_at,updated_at
       FROM content_qbank_presentation_policies WHERE exam_track=$1`,
      [normalized.exam_track],
    ),
    getPool().query(`SELECT c.source_profile,COUNT(DISTINCT a.question_id)::int AS question_count,
        COUNT(DISTINCT c.id)::int AS collection_count
      FROM content_collections c
      JOIN content_source_aliases a ON a.collection_id=c.id
      JOIN content_questions q ON q.id=a.question_id
      JOIN content_collection_destinations d ON d.collection_id=c.id
      WHERE c.exam_track=ANY($1::text[]) AND c.status='approved' AND q.status='approved'
        AND d.destination='aylamed_qbank' AND d.enabled=TRUE
      GROUP BY c.source_profile ORDER BY c.source_profile`, [examTracks]),
  ]);
  const policy = normalizeContentQbankPresentationPolicy(saved.rows[0] || normalized, normalized.exam_track);
  return {
    ...policy,
    available_source_profiles: profileCounts.rows.map((row) => ({
      source_profile: normalizeContentSourceProfile(row.source_profile),
      question_count: Number(row.question_count || 0),
      collection_count: Number(row.collection_count || 0),
    })),
    updated_by: saved.rows[0]?.updated_by || '',
    created_at: saved.rows[0]?.created_at || null,
    updated_at: saved.rows[0]?.updated_at || null,
  };
}

export async function upsertContentQbankPresentationPolicy({
  examTrack,
  studentBankMode,
  actorId = '',
} = {}) {
  await ensureContentRegistrySchema();
  const policy = normalizeContentQbankPresentationPolicy({
    student_bank_mode: studentBankMode,
  }, examTrack);
  await getPool().query(`INSERT INTO content_qbank_presentation_policies
      (exam_track,student_bank_mode,updated_by)
    VALUES ($1,$2,$3)
    ON CONFLICT (exam_track) DO UPDATE SET
      student_bank_mode=EXCLUDED.student_bank_mode,
      updated_by=EXCLUDED.updated_by,
      updated_at=NOW()`, [
    policy.exam_track,
    policy.student_bank_mode,
    String(actorId || ''),
  ]);
  return getContentQbankPresentationPolicy({ examTrack: policy.exam_track });
}

function contentTaxonomyExamAliases(examTrack = '') {
  const clean = normalizeContentTaxonomyExamTrack(examTrack);
  const aliases = {
    'usmle-step-1': ['usmle-step-1', 'usmle_step_1'],
    'usmle-step-2': ['usmle-step-2', 'usmle-step-2-ck', 'usmle_step_2', 'usmle_step_2_ck'],
    'usmle-step-3': ['usmle-step-3', 'usmle_step_3'],
  };
  return clean ? aliases[clean] || [clean] : [];
}

function contentTaxonomyReviewStatus(value = 'approved') {
  const clean = String(value || '').trim().toLowerCase();
  return ['approved', 'pending', 'rejected'].includes(clean) ? clean : 'approved';
}

function requireContentRegistryUuid(value, label) {
  const clean = String(value || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean)) {
    throw Object.assign(new Error(`${label} must be a valid UUID`), { statusCode: 400 });
  }
  return clean;
}

function contentTaxonomyStoragePayload(taxonomy, metadata = {}) {
  return {
    ...taxonomy,
    source: metadata.source || 'provider_mapping',
    ...(metadata.mappingId ? { mapping_id: String(metadata.mappingId) } : {}),
    ...(metadata.overrideId ? { override_id: String(metadata.overrideId) } : {}),
    ...(metadata.reviewStatus ? { review_status: metadata.reviewStatus } : {}),
  };
}

async function contentTaxonomyAudit(client, {
  mappingId = null, questionId = null, examTrack, sourceNamespace = '', sourceSystemId = '',
  sourceSubjectId = '', action, beforeState = {}, afterState = {}, note = '', actorId = '',
}) {
  await client.query(`INSERT INTO content_taxonomy_audit_events
    (id,mapping_id,question_id,exam_track,source_namespace,source_system_id,source_subject_id,
      action,before_state,after_state,note,actor_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`, [
    crypto.randomUUID(), mappingId, questionId, examTrack, sourceNamespace, String(sourceSystemId),
    String(sourceSubjectId), action, JSON.stringify(beforeState || {}), JSON.stringify(afterState || {}),
    String(note || '').trim().slice(0, 2000), String(actorId || ''),
  ]);
}

async function applyContentTaxonomyMapping(client, mapping) {
  if (!mapping || mapping.status !== 'active' || mapping.review_status !== 'approved') return 0;
  const taxonomy = normalizeContentTaxonomy(mapping);
  const payload = contentTaxonomyStoragePayload(taxonomy, {
    source: 'provider_mapping', mappingId: mapping.id, reviewStatus: mapping.review_status,
  });
  await client.query(`SELECT q.id FROM content_questions q
    WHERE q.exam_track=$1 AND q.system_key=$3 AND q.subject_key=$4
      AND EXISTS (SELECT 1 FROM content_source_aliases a
        WHERE a.question_id=q.id AND a.source_namespace=$2) FOR UPDATE`, [
    mapping.exam_track, mapping.source_namespace, mapping.source_system_id, mapping.source_subject_id,
  ]);
  const result = await client.query(`UPDATE content_questions q SET taxonomy=$5::jsonb, updated_at=NOW()
    WHERE q.exam_track=$1 AND q.system_key=$3 AND q.subject_key=$4
      AND EXISTS (SELECT 1 FROM content_source_aliases a
        WHERE a.question_id=q.id AND a.source_namespace=$2)
      AND NOT EXISTS (SELECT 1 FROM content_question_taxonomy_overrides o
        WHERE o.question_id=q.id AND o.status='active')`, [
    mapping.exam_track, mapping.source_namespace, mapping.source_system_id,
    mapping.source_subject_id, JSON.stringify(payload),
  ]);
  return result.rowCount;
}

export async function upsertContentTaxonomyMapping({
  examTrack, sourceNamespace, sourceSystemId = '', sourceSubjectId = '', taxonomy = {}, actorId = '',
  reviewStatus = 'approved', origin = 'manual_override', confidence = null, reviewNotes = '',
}) {
  await ensureContentRegistrySchema();
  examTrack = normalizeContentTaxonomyExamTrack(examTrack);
  sourceNamespace = String(sourceNamespace || '').trim().toLowerCase();
  if (!examTrack || !sourceNamespace) throw Object.assign(new Error('A supported examTrack and sourceNamespace are required'), { statusCode: 400 });
  const cleanOrigin = String(origin || 'manual_override').trim().toLowerCase().slice(0, 80) || 'manual_override';
  const cleanReviewStatus = cleanOrigin === 'automatic_suggestion' ? 'pending' : contentTaxonomyReviewStatus(reviewStatus);
  const normalized = normalizeContentTaxonomy(taxonomy, { requireTopic: cleanReviewStatus === 'approved' });
  const status = cleanReviewStatus === 'approved' ? 'active' : cleanReviewStatus;
  const cleanConfidence = confidence === null || confidence === undefined || confidence === ''
    ? null : Math.max(0, Math.min(1, Number(confidence)));
  if (cleanConfidence !== null && !Number.isFinite(cleanConfidence)) {
    throw Object.assign(new Error('confidence must be a number between 0 and 1'), { statusCode: 400 });
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const before = await client.query(`SELECT * FROM content_taxonomy_mappings
      WHERE exam_track=$1 AND source_namespace=$2 AND source_system_id=$3 AND source_subject_id=$4
      FOR UPDATE`, [examTrack, sourceNamespace, String(sourceSystemId), String(sourceSubjectId)]);
    if (cleanOrigin === 'automatic_suggestion' && before.rows[0]?.status === 'active' && before.rows[0]?.review_status === 'approved') {
      await contentTaxonomyAudit(client, {
        mappingId: before.rows[0].id, examTrack, sourceNamespace, sourceSystemId, sourceSubjectId,
        action: 'automatic_suggestion_skipped', beforeState: before.rows[0],
        afterState: { suggested_taxonomy: normalized, confidence: cleanConfidence },
        note: reviewNotes || 'Approved mapping retained', actorId,
      });
      await client.query('COMMIT');
      return { ...before.rows[0], affected_questions: 0, suggestion_skipped: true };
    }
    const proposedId = before.rows[0]?.id || crypto.randomUUID();
    const result = await client.query(`INSERT INTO content_taxonomy_mappings
      (id,exam_track,source_namespace,source_system_id,source_subject_id,system_key,subsystem_key,
        topic_key,subtopic_key,labels,status,review_status,origin,confidence,review_notes,
        created_by,updated_by,reviewed_by,reviewed_at,revision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$16,
        CASE WHEN $12 IN ('approved','rejected') THEN $16 ELSE '' END,
        CASE WHEN $12 IN ('approved','rejected') THEN NOW() ELSE NULL END,1)
      ON CONFLICT (exam_track,source_namespace,source_system_id,source_subject_id) DO UPDATE SET
        system_key=EXCLUDED.system_key, subsystem_key=EXCLUDED.subsystem_key,
        topic_key=EXCLUDED.topic_key, subtopic_key=EXCLUDED.subtopic_key, labels=EXCLUDED.labels,
        status=EXCLUDED.status, review_status=EXCLUDED.review_status, origin=EXCLUDED.origin,
        confidence=EXCLUDED.confidence, review_notes=EXCLUDED.review_notes,
        updated_by=EXCLUDED.updated_by, reviewed_by=EXCLUDED.reviewed_by,
        reviewed_at=EXCLUDED.reviewed_at, revision=content_taxonomy_mappings.revision+1, updated_at=NOW()
      RETURNING *`, [
      proposedId, examTrack, sourceNamespace, String(sourceSystemId), String(sourceSubjectId),
      normalized.system_key, normalized.subsystem_key, normalized.topic_key, normalized.subtopic_key,
      JSON.stringify(normalized.labels), status, cleanReviewStatus, cleanOrigin,
      cleanConfidence, String(reviewNotes || '').trim().slice(0, 2000), String(actorId || ''),
    ]);
    const mapping = result.rows[0];
    const affectedQuestions = await applyContentTaxonomyMapping(client, mapping);
    await contentTaxonomyAudit(client, {
      mappingId: mapping.id, examTrack, sourceNamespace, sourceSystemId, sourceSubjectId,
      action: before.rows[0] ? 'mapping_overridden' : 'mapping_created',
      beforeState: before.rows[0] || {}, afterState: mapping, note: reviewNotes, actorId,
    });
    await client.query('COMMIT');
    return { ...mapping, affected_questions: affectedQuestions };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function reviewContentTaxonomyMapping({ mappingId, action, taxonomy = null, note = '', actorId = '', confidence = undefined }) {
  await ensureContentRegistrySchema();
  mappingId = requireContentRegistryUuid(mappingId, 'mappingId');
  const cleanAction = normalizeContentTaxonomyReviewAction(action);
  if (!cleanAction) throw Object.assign(new Error('action must be approve, reject, disable, or reopen'), { statusCode: 400 });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM content_taxonomy_mappings WHERE id=$1 FOR UPDATE', [mappingId]);
    const before = existing.rows[0];
    if (!before) throw Object.assign(new Error('Taxonomy mapping not found'), { statusCode: 404 });
    const normalized = taxonomy
      ? normalizeContentTaxonomy({
          system_key: taxonomy.system_key ?? taxonomy.systemKey ?? before.system_key,
          subsystem_key: taxonomy.subsystem_key ?? taxonomy.subsystemKey ?? before.subsystem_key,
          topic_key: taxonomy.topic_key ?? taxonomy.topicKey ?? before.topic_key,
          subtopic_key: taxonomy.subtopic_key ?? taxonomy.subtopicKey ?? before.subtopic_key,
          labels: taxonomy.labels ?? before.labels,
        }, { requireTopic: cleanAction === 'approve' })
      : cleanAction === 'approve'
        ? normalizeContentTaxonomy(before, { requireTopic: true })
        : {
            system_key: before.system_key,
            subsystem_key: before.subsystem_key,
            topic_key: before.topic_key,
            subtopic_key: before.subtopic_key,
            labels: before.labels && typeof before.labels === 'object' ? before.labels : {},
          };
    const status = cleanAction === 'approve' ? 'active' : cleanAction === 'reopen' ? 'pending' : cleanAction === 'reject' ? 'rejected' : 'disabled';
    const reviewStatus = cleanAction === 'approve' ? 'approved' : cleanAction === 'reject' ? 'rejected' : cleanAction === 'reopen' ? 'pending' : before.review_status;
    const nextConfidence = confidence === undefined || confidence === null || confidence === '' ? before.confidence : Math.max(0, Math.min(1, Number(confidence)));
    if (nextConfidence !== null && !Number.isFinite(Number(nextConfidence))) {
      throw Object.assign(new Error('confidence must be a number between 0 and 1'), { statusCode: 400 });
    }
    const updated = await client.query(`UPDATE content_taxonomy_mappings SET
      system_key=$2, subsystem_key=$3, topic_key=$4, subtopic_key=$5, labels=$6::jsonb,
      status=$7, review_status=$8, confidence=$9, review_notes=$10, updated_by=$11,
      reviewed_by=CASE WHEN $8 IN ('approved','rejected') OR $7='disabled' THEN $11 ELSE reviewed_by END,
      reviewed_at=CASE WHEN $8 IN ('approved','rejected') OR $7='disabled' THEN NOW() ELSE reviewed_at END,
      revision=revision+1, updated_at=NOW() WHERE id=$1 RETURNING *`, [
      mappingId, normalized.system_key, normalized.subsystem_key, normalized.topic_key,
      normalized.subtopic_key, JSON.stringify(normalized.labels), status, reviewStatus,
      nextConfidence, String(note || '').trim().slice(0, 2000), String(actorId || ''),
    ]);
    const mapping = updated.rows[0];
    const affectedQuestions = await applyContentTaxonomyMapping(client, mapping);
    await contentTaxonomyAudit(client, {
      mappingId: mapping.id, examTrack: mapping.exam_track, sourceNamespace: mapping.source_namespace,
      sourceSystemId: mapping.source_system_id, sourceSubjectId: mapping.source_subject_id,
      action: `mapping_${cleanAction}`, beforeState: before, afterState: mapping, note, actorId,
    });
    await client.query('COMMIT');
    return { ...mapping, affected_questions: affectedQuestions };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function listContentTaxonomyReviewQueue({ examTrack = '', sourceNamespace = '', state = '', limit = 100, offset = 0 } = {}) {
  await ensureContentRegistrySchema();
  const examAliases = examTrack ? contentTaxonomyExamAliases(examTrack) : null;
  if (examTrack && !examAliases?.length) throw Object.assign(new Error('Unsupported exam_track'), { statusCode: 400 });
  const cleanState = state ? normalizeContentTaxonomyReviewState(state) : '';
  if (state && !cleanState) throw Object.assign(new Error('Unsupported taxonomy review state'), { statusCode: 400 });
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const result = await getPool().query(`WITH provider_pairs AS (
      SELECT q.exam_track, a.source_namespace, q.system_key AS source_system_id,
        q.subject_key AS source_subject_id, COUNT(DISTINCT q.id)::int AS question_count,
        COUNT(DISTINCT q.id) FILTER (WHERE q.status='approved')::int AS approved_question_count,
        COUNT(DISTINCT o.question_id) FILTER (WHERE o.status='active')::int AS question_override_count
      FROM content_questions q
      JOIN content_source_aliases a ON a.question_id=q.id
      LEFT JOIN content_question_taxonomy_overrides o ON o.question_id=q.id
      WHERE ($1::text[] IS NULL OR q.exam_track=ANY($1::text[]))
        AND ($2='' OR a.source_namespace=$2)
      GROUP BY q.exam_track,a.source_namespace,q.system_key,q.subject_key
    ), queue AS (
      SELECT p.*, m.id AS mapping_id, m.system_key, m.subsystem_key, m.topic_key, m.subtopic_key,
        m.labels, m.status AS mapping_status, m.review_status, m.origin, m.confidence,
        m.review_notes, m.revision, m.updated_by, m.reviewed_by, m.reviewed_at, m.updated_at,
        CASE WHEN m.id IS NULL THEN 'unmapped'
          WHEN m.status='disabled' THEN 'disabled'
          WHEN m.status='rejected' OR m.review_status='rejected' THEN 'rejected'
          WHEN m.status='pending' OR m.review_status='pending' THEN 'needs_review'
          WHEN m.status='active' AND m.review_status='approved' THEN 'approved'
          ELSE 'needs_review' END AS review_state
      FROM provider_pairs p LEFT JOIN content_taxonomy_mappings m
        ON m.exam_track=p.exam_track AND m.source_namespace=p.source_namespace
        AND m.source_system_id=p.source_system_id AND m.source_subject_id=p.source_subject_id
    )
    SELECT queue.*, COALESCE((SELECT jsonb_agg(sample) FROM (
      SELECT DISTINCT q2.id, q2.student_qid, q2.title, q2.status
      FROM content_questions q2 JOIN content_source_aliases a2 ON a2.question_id=q2.id
      WHERE q2.exam_track=queue.exam_track AND a2.source_namespace=queue.source_namespace
        AND q2.system_key=queue.source_system_id AND q2.subject_key=queue.source_subject_id
      ORDER BY q2.student_qid LIMIT 5
    ) sample), '[]'::jsonb) AS samples
    FROM queue WHERE ($3='' OR queue.review_state=$3)
    ORDER BY CASE queue.review_state WHEN 'unmapped' THEN 0 WHEN 'needs_review' THEN 1
      WHEN 'rejected' THEN 2 WHEN 'disabled' THEN 3 ELSE 4 END,
      queue.question_count DESC, queue.exam_track, queue.source_namespace
    LIMIT $4 OFFSET $5`, [examAliases, String(sourceNamespace || '').trim(), cleanState, safeLimit, safeOffset]);
  return result.rows;
}

export async function upsertContentQuestionTaxonomyOverride({ questionId, taxonomy = {}, reason = '', actorId = '' }) {
  await ensureContentRegistrySchema();
  questionId = requireContentRegistryUuid(questionId, 'questionId');
  const normalized = normalizeContentTaxonomy(taxonomy, { requireTopic: true });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const questionResult = await client.query('SELECT * FROM content_questions WHERE id=$1 FOR UPDATE', [questionId]);
    const question = questionResult.rows[0];
    if (!question) throw Object.assign(new Error('Content question not found'), { statusCode: 404 });
    const existing = await client.query('SELECT * FROM content_question_taxonomy_overrides WHERE question_id=$1 FOR UPDATE', [questionId]);
    const overrideId = existing.rows[0]?.id || crypto.randomUUID();
    const result = await client.query(`INSERT INTO content_question_taxonomy_overrides
      (id,question_id,exam_track,taxonomy,previous_taxonomy,status,reason,created_by,updated_by,revision)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'active',$6,$7,$7,1)
      ON CONFLICT (question_id) DO UPDATE SET taxonomy=EXCLUDED.taxonomy,status='active',
        previous_taxonomy=CASE WHEN content_question_taxonomy_overrides.status='active'
          THEN content_question_taxonomy_overrides.previous_taxonomy ELSE EXCLUDED.previous_taxonomy END,
        reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,
        revision=content_question_taxonomy_overrides.revision+1,updated_at=NOW()
      RETURNING *`, [overrideId, questionId, question.exam_track, JSON.stringify(normalized),
      JSON.stringify(question.taxonomy || {}), String(reason || '').trim().slice(0, 2000), String(actorId || '')]);
    const override = result.rows[0];
    const payload = contentTaxonomyStoragePayload(normalized, { source: 'question_override', overrideId: override.id });
    await client.query('UPDATE content_questions SET taxonomy=$2::jsonb,updated_at=NOW() WHERE id=$1', [questionId, JSON.stringify(payload)]);
    await contentTaxonomyAudit(client, {
      questionId, examTrack: question.exam_track,
      action: existing.rows[0] ? 'question_override_updated' : 'question_override_created',
      beforeState: existing.rows[0] || { question_taxonomy: question.taxonomy || {} }, afterState: override, note: reason, actorId,
    });
    await client.query('COMMIT');
    return { ...override, taxonomy: payload };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function removeContentQuestionTaxonomyOverride({ questionId, reason = '', actorId = '' }) {
  await ensureContentRegistrySchema();
  questionId = requireContentRegistryUuid(questionId, 'questionId');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const questionResult = await client.query('SELECT * FROM content_questions WHERE id=$1 FOR UPDATE', [questionId]);
    const question = questionResult.rows[0];
    if (!question) throw Object.assign(new Error('Content question not found'), { statusCode: 404 });
    const existing = await client.query('SELECT * FROM content_question_taxonomy_overrides WHERE question_id=$1 FOR UPDATE', [questionId]);
    const override = existing.rows[0];
    if (!override || override.status !== 'active') throw Object.assign(new Error('Active taxonomy override not found'), { statusCode: 404 });
    const disabled = await client.query(`UPDATE content_question_taxonomy_overrides SET status='disabled',reason=$2,
      updated_by=$3,revision=revision+1,updated_at=NOW() WHERE question_id=$1 RETURNING *`, [
      questionId, String(reason || '').trim().slice(0, 2000), String(actorId || ''),
    ]);
    const candidates = await client.query(`SELECT DISTINCT m.* FROM content_taxonomy_mappings m
      JOIN content_source_aliases a ON a.question_id=$1 AND a.source_namespace=m.source_namespace
      WHERE m.exam_track=$2 AND m.source_system_id=$3 AND m.source_subject_id=$4
        AND m.status='active' AND m.review_status='approved'`, [
      questionId, question.exam_track, question.system_key, question.subject_key,
    ]);
    const candidateTaxonomies = new Map(candidates.rows.map((mapping) => {
      const normalized = normalizeContentTaxonomy(mapping);
      return [JSON.stringify(normalized), { mapping, normalized }];
    }));
    const selected = candidateTaxonomies.size === 1 ? [...candidateTaxonomies.values()][0] : null;
    const fallback = selected
      ? contentTaxonomyStoragePayload(selected.normalized, { source: 'provider_mapping', mappingId: selected.mapping.id, reviewStatus: 'approved' })
      : (override.previous_taxonomy && typeof override.previous_taxonomy === 'object' ? override.previous_taxonomy : {});
    await client.query('UPDATE content_questions SET taxonomy=$2::jsonb,updated_at=NOW() WHERE id=$1', [questionId, JSON.stringify(fallback)]);
    await contentTaxonomyAudit(client, {
      questionId, examTrack: question.exam_track, action: 'question_override_removed',
      beforeState: override, afterState: { ...disabled.rows[0], restored_taxonomy: fallback }, note: reason, actorId,
    });
    await client.query('COMMIT');
    return { ...disabled.rows[0], restored_taxonomy: fallback, provider_mapping_restored: Boolean(selected) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function listContentTaxonomyAuditEvents({ mappingId = '', questionId = '', limit = 100 } = {}) {
  await ensureContentRegistrySchema();
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const result = await getPool().query(`SELECT * FROM content_taxonomy_audit_events
    WHERE ($1='' OR mapping_id::text=$1) AND ($2='' OR question_id::text=$2)
    ORDER BY created_at DESC LIMIT $3`, [String(mappingId || ''), String(questionId || ''), safeLimit]);
  return result.rows;
}

export async function getContentTaxonomyCoverage({ examTracks = CONTENT_TAXONOMY_EXAM_TRACKS.map((exam) => exam.id) } = {}) {
  await ensureContentRegistrySchema();
  const requested = [...new Set((Array.isArray(examTracks) ? examTracks : [examTracks])
    .map(normalizeContentTaxonomyExamTrack).filter(Boolean))];
  const safeExamTracks = requested.length ? requested : CONTENT_TAXONOMY_EXAM_TRACKS.map((exam) => exam.id);
  const result = await getPool().query(`WITH question_metrics AS (
      SELECT CASE
          WHEN q.exam_track IN ('usmle-step-1','usmle_step_1') THEN 'usmle-step-1'
          WHEN q.exam_track IN ('usmle-step-2','usmle-step-2-ck','usmle_step_2','usmle_step_2_ck') THEN 'usmle-step-2'
          WHEN q.exam_track IN ('usmle-step-3','usmle_step_3') THEN 'usmle-step-3'
          ELSE q.exam_track END AS exam_track,
        COUNT(*)::int AS total_questions,
        COUNT(*) FILTER (WHERE q.status='approved')::int AS approved_questions,
        COUNT(*) FILTER (WHERE COALESCE(NULLIF(q.taxonomy->>'system_key',''),'unclassified')<>'unclassified')::int AS system_classified_questions,
        COUNT(*) FILTER (WHERE COALESCE(NULLIF(q.taxonomy->>'topic_key',''),'unclassified')<>'unclassified')::int AS topic_classified_questions,
        COUNT(*) FILTER (WHERE COALESCE(NULLIF(q.taxonomy->>'system_key',''),'unclassified')<>'unclassified'
          AND COALESCE(NULLIF(q.taxonomy->>'topic_key',''),'unclassified')<>'unclassified')::int AS complete_questions,
        COUNT(*) FILTER (WHERE q.taxonomy->>'source'='question_override')::int AS question_override_count
      FROM content_questions q GROUP BY 1
    ), provider_pairs AS (
      SELECT DISTINCT q.exam_track AS raw_exam_track,
        CASE
          WHEN q.exam_track IN ('usmle-step-1','usmle_step_1') THEN 'usmle-step-1'
          WHEN q.exam_track IN ('usmle-step-2','usmle-step-2-ck','usmle_step_2','usmle_step_2_ck') THEN 'usmle-step-2'
          WHEN q.exam_track IN ('usmle-step-3','usmle_step_3') THEN 'usmle-step-3'
          ELSE q.exam_track END AS exam_track,
        a.source_namespace,q.system_key AS source_system_id,q.subject_key AS source_subject_id
      FROM content_questions q JOIN content_source_aliases a ON a.question_id=q.id
    ), pair_metrics AS (
      SELECT p.exam_track,COUNT(*)::int AS provider_pairs_total,
        COUNT(*) FILTER (WHERE m.status='active' AND m.review_status='approved')::int AS provider_pairs_approved,
        COUNT(*) FILTER (WHERE m.id IS NOT NULL AND (m.status='pending' OR m.review_status='pending'))::int AS provider_pairs_pending,
        COUNT(*) FILTER (WHERE m.id IS NOT NULL AND (m.status='rejected' OR m.review_status='rejected'))::int AS provider_pairs_rejected,
        COUNT(*) FILTER (WHERE m.id IS NOT NULL AND m.status='disabled')::int AS provider_pairs_disabled,
        COUNT(*) FILTER (WHERE m.id IS NULL)::int AS provider_pairs_unmapped
      FROM provider_pairs p LEFT JOIN content_taxonomy_mappings m
        ON m.exam_track=p.raw_exam_track AND m.source_namespace=p.source_namespace
        AND m.source_system_id=p.source_system_id AND m.source_subject_id=p.source_subject_id
      GROUP BY p.exam_track
    )
    SELECT requested.exam_track,
      COALESCE(q.total_questions,0)::int AS total_questions,
      COALESCE(q.approved_questions,0)::int AS approved_questions,
      COALESCE(q.system_classified_questions,0)::int AS system_classified_questions,
      COALESCE(q.topic_classified_questions,0)::int AS topic_classified_questions,
      COALESCE(q.complete_questions,0)::int AS complete_questions,
      COALESCE(q.question_override_count,0)::int AS question_override_count,
      COALESCE(p.provider_pairs_total,0)::int AS provider_pairs_total,
      COALESCE(p.provider_pairs_approved,0)::int AS provider_pairs_approved,
      COALESCE(p.provider_pairs_pending,0)::int AS provider_pairs_pending,
      COALESCE(p.provider_pairs_rejected,0)::int AS provider_pairs_rejected,
      COALESCE(p.provider_pairs_disabled,0)::int AS provider_pairs_disabled,
      COALESCE(p.provider_pairs_unmapped,0)::int AS provider_pairs_unmapped
    FROM unnest($1::text[]) requested(exam_track)
    LEFT JOIN question_metrics q ON q.exam_track=requested.exam_track
    LEFT JOIN pair_metrics p ON p.exam_track=requested.exam_track
    ORDER BY requested.exam_track`, [safeExamTracks]);
  return buildContentTaxonomyCoverageReport(result.rows, safeExamTracks);
}

export async function listContentHubVideos({
  examTrack,
  destinations = ['aylamed_content_hub'],
  systemKey = '',
  subsystemKey = '',
  topicKey = '',
  subtopicKey = '',
  limit = 500,
  offset = 0,
} = {}) {
  await ensureContentRegistrySchema();
  const canonicalExamTrack = normalizeContentTaxonomyExamTrack(examTrack);
  if (!canonicalExamTrack) throw Object.assign(new Error('A supported examTrack is required'), { statusCode: 400 });
  const examTracks = qbankExamTrackAliases(canonicalExamTrack);
  const requestedDestinations = Array.isArray(destinations) ? destinations : [destinations];
  const cleanDestinations = [...new Set(requestedDestinations.map(cleanContentDestination).filter((value) => CONTENT_DESTINATIONS.has(value)))];
  if (!cleanDestinations.length) throw Object.assign(new Error('A supported Content Hub destination is required'), { statusCode: 400 });
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 500)));
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const result = await getPool().query(`WITH eligible AS (
      SELECT va.id,q.exam_track,va.original_name,va.provider_id,va.embed_url,va.status,
        NULLIF(va.source_data->>'title','') AS asset_title,
        NULLIF(va.source_data->>'description','') AS asset_description,
        NULLIF(va.source_data->>'duration_seconds','') AS duration_seconds,
        COALESCE(NULLIF(q.taxonomy->>'system_key',''),NULLIF(q.system_key,''),'General') AS system_key,
        COALESCE(NULLIF(q.taxonomy->>'subsystem_key',''),'') AS subsystem_key,
        COALESCE(NULLIF(q.taxonomy->>'topic_key',''),NULLIF(q.title,''),'Core review') AS topic_key,
        COALESCE(NULLIF(q.taxonomy->>'subtopic_key',''),'') AS subtopic_key,
        c.id AS collection_id,c.title AS collection_title,c.source_provider,c.display_policy,
        d.destination,d.settings,
        ROW_NUMBER() OVER (PARTITION BY va.id ORDER BY
          CASE d.destination WHEN 'aylamed_content_hub' THEN 0 ELSE 1 END,
          c.approved_at DESC NULLS LAST,c.created_at ASC,q.id ASC) AS preference_rank
      FROM content_video_assets va
      JOIN content_question_videos qv ON qv.video_asset_id=va.id
      JOIN content_questions q ON q.id=qv.question_id
      JOIN content_source_aliases a ON a.question_id=q.id
      JOIN content_collections c ON c.id=a.collection_id
      JOIN content_collection_destinations d ON d.collection_id=c.id
      WHERE q.exam_track=ANY($1::text[])
        AND q.status='approved' AND c.status='approved' AND d.enabled=TRUE
        AND d.destination=ANY($2::text[])
        AND LOWER(COALESCE(va.status,'')) NOT IN ('archived','deleted','disabled','quarantined','rejected')
        AND LOWER(COALESCE(qv.status,'')) NOT IN ('archived','deleted','disabled','quarantined','rejected')
        AND ($3='' OR COALESCE(NULLIF(q.taxonomy->>'system_key',''),NULLIF(q.system_key,''),'General')=$3)
        AND ($4='' OR COALESCE(NULLIF(q.taxonomy->>'subsystem_key',''),'')=$4)
        AND ($5='' OR COALESCE(NULLIF(q.taxonomy->>'topic_key',''),NULLIF(q.title,''),'Core review')=$5)
        AND ($6='' OR COALESCE(NULLIF(q.taxonomy->>'subtopic_key',''),'')=$6)
    ), grouped AS (
      SELECT id,exam_track,original_name,provider_id,embed_url,status,
        MAX(asset_title) AS asset_title,MAX(asset_description) AS asset_description,
        MAX(duration_seconds) AS duration_seconds,
        ARRAY_AGG(DISTINCT destination ORDER BY destination) AS delivery_destinations,
        ARRAY_AGG(DISTINCT system_key ORDER BY system_key) AS systems,
        ARRAY_AGG(DISTINCT subsystem_key ORDER BY subsystem_key) AS subsystems,
        ARRAY_AGG(DISTINCT topic_key ORDER BY topic_key) AS topics,
        ARRAY_AGG(DISTINCT subtopic_key ORDER BY subtopic_key) AS subtopics,
        MAX(CASE WHEN preference_rank=1 THEN system_key END) AS primary_system_key,
        MAX(CASE WHEN preference_rank=1 THEN subsystem_key END) AS primary_subsystem_key,
        MAX(CASE WHEN preference_rank=1 THEN topic_key END) AS primary_topic_key,
        MAX(CASE WHEN preference_rank=1 THEN subtopic_key END) AS primary_subtopic_key,
        MAX(CASE WHEN preference_rank=1 THEN collection_id::text END) AS primary_collection_id,
        MAX(CASE WHEN preference_rank=1 THEN collection_title END) AS primary_collection_title,
        MAX(CASE WHEN preference_rank=1 THEN source_provider END) AS primary_source_provider,
        MAX(CASE WHEN preference_rank=1 THEN display_policy->>'source_label_mode' END) AS primary_source_label_mode,
        MAX(CASE WHEN preference_rank=1 THEN settings->>'playlist_key' END) AS playlist_key,
        MAX(CASE WHEN preference_rank=1 THEN settings->>'playlist_title' END) AS playlist_title,
        MAX(CASE WHEN preference_rank=1 THEN settings->>'roadmap_priority' END) AS roadmap_priority
      FROM eligible
      GROUP BY id,exam_track,original_name,provider_id,embed_url,status
    )
    SELECT 'registry-video:' || id::text AS resource_id,id AS video_asset_id,exam_track,
      COALESCE(asset_title,original_name,primary_collection_title,'Video lesson') AS title,
      COALESCE(asset_description,'') AS description,provider_id,embed_url,status,
      primary_system_key AS system_key,primary_subsystem_key AS subsystem_key,primary_topic_key AS topic_key,
      primary_subtopic_key AS subtopic_key,primary_collection_id AS collection_id,
      COALESCE(NULLIF(playlist_key,''),primary_system_key) AS playlist_key,
      COALESCE(NULLIF(playlist_title,''),primary_system_key) AS playlist_title,
      CASE primary_source_label_mode
        WHEN 'provider' THEN NULLIF(primary_source_provider,'')
        WHEN 'neutral' THEN 'Source'
        ELSE NULL END AS source_label,
      delivery_destinations,systems,subsystems,topics,subtopics,
      CASE WHEN COALESCE(duration_seconds,'') ~ '^[0-9]+$' AND LENGTH(duration_seconds)<=6
        THEN LEAST(duration_seconds::int,86400) ELSE 0 END AS duration_seconds,
      CASE WHEN COALESCE(roadmap_priority,'') ~ '^[-]?[0-9]+([.][0-9]+)?$' AND LENGTH(roadmap_priority)<=20
        THEN GREATEST(-1000,LEAST(1000,roadmap_priority::double precision)) ELSE 30 END AS roadmap_priority,
      'approved_collection' AS authorization_status,
      'approved_content_registry' AS verification_status,
      'approved_registry_taxonomy' AS mapping_status,
      'registry' AS source_type,TRUE AS approved
    FROM grouped
    ORDER BY primary_system_key,primary_subsystem_key,primary_topic_key,title,id
    LIMIT $7 OFFSET $8`, [
    examTracks,
    cleanDestinations,
    String(systemKey || ''),
    String(subsystemKey || ''),
    String(topicKey || ''),
    String(subtopicKey || ''),
    safeLimit,
    safeOffset,
  ]);
  return result.rows;
}

export async function getContentQbankCatalog({
  examTrack,
  destination = 'aylamed_qbank',
  destinationScope = '',
  sourceProfile = '',
}) {
  await ensureContentRegistrySchema();
  const examTracks = qbankExamTrackAliases(examTrack);
  const cleanSourceProfile = normalizeContentSourceProfile(sourceProfile, '', { allowEmpty: true });
  const result = await getPool().query(`
    SELECT COALESCE(NULLIF(q.taxonomy->>'system_key',''),'unclassified') AS system_key,
      COALESCE(NULLIF(q.taxonomy->>'subsystem_key',''),'unclassified') AS subsystem_key,
      COALESCE(NULLIF(q.taxonomy->>'topic_key',''),NULLIF(q.title,''),'unclassified') AS topic_key,
      COALESCE(NULLIF(q.taxonomy->>'subtopic_key',''),'unclassified') AS subtopic_key,
      COUNT(DISTINCT q.id)::int AS question_count
    FROM content_questions q
    WHERE q.exam_track=ANY($1::text[]) AND q.status='approved'
      AND COALESCE(NULLIF(q.source_data->>'item_format',''),'single_best_answer')='single_best_answer'
      AND EXISTS (
        SELECT 1 FROM content_source_aliases a
        JOIN content_collection_destinations d ON d.collection_id=a.collection_id
        JOIN content_collections c ON c.id=a.collection_id
        WHERE a.question_id=q.id AND c.status='approved' AND d.destination=$2 AND d.enabled=TRUE
          AND (d.destination_scope='' OR d.destination_scope=$3)
          AND ($4='' OR c.source_profile=$4)
      )
    GROUP BY 1,2,3,4 ORDER BY 1,2,3,4
  `, [examTracks, destination, String(destinationScope || ''), cleanSourceProfile]);
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
  const {
    student_qid: _studentQid,
    source_item_id: _sourceItemId,
    source_provider: _sourceProvider,
    source_profile: _sourceProfile,
    display_policy: _displayPolicy,
    ...question
  } = row;
  return { ...question, display_question_id: displayQuestionId, question_identifiers: questionIdentifiers, source_label: sourceLabel };
}

function qbankQuestionProjection(destinationScopeParameter, sourceProfileParameter) { return `
  SELECT q.id, q.student_qid, q.exam_track, q.title, q.question_html, q.explanation_html, q.correct_answer_id,
    q.taxonomy,
    COALESCE(NULLIF(q.taxonomy->>'system_key',''),q.system_key) AS system_key,
    COALESCE(q.taxonomy->>'subsystem_key','') AS subsystem_key,
    COALESCE(q.taxonomy->>'topic_key',NULLIF(q.title,''),'unclassified') AS topic_key,
    COALESCE(q.taxonomy->>'subtopic_key','') AS subtopic_key,
    delivery.source_item_id, delivery.source_provider, delivery.source_profile, delivery.display_policy,
    COALESCE(answers.items, '[]'::jsonb) AS answers,
    COALESCE(media.items, '[]'::jsonb) AS media,
    COALESCE(videos.items, '[]'::jsonb) AS videos
  FROM content_questions q
  JOIN LATERAL (
    SELECT a.source_item_id, c.source_provider, c.source_profile, c.display_policy
    FROM content_source_aliases a
    JOIN content_collection_destinations d ON d.collection_id=a.collection_id
    JOIN content_collections c ON c.id=a.collection_id
    WHERE a.question_id=q.id AND c.status='approved' AND d.destination=$2 AND d.enabled=TRUE
      AND (d.destination_scope='' OR d.destination_scope=${destinationScopeParameter})
      AND (${sourceProfileParameter}='' OR c.source_profile=${sourceProfileParameter})
    ORDER BY CASE WHEN d.destination_scope=${destinationScopeParameter} AND ${destinationScopeParameter}<>'' THEN 0 ELSE 1 END,
      c.approved_at DESC NULLS LAST, c.created_at ASC, a.created_at ASC
    LIMIT 1
  ) delivery ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('answer_id',ca.answer_id,'text_html',ca.text_html) ORDER BY ca.answer_id) AS items
    FROM content_answers ca WHERE ca.question_id=q.id
  ) answers ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id',ma.id,'ref',qm.media_ref,'placement',qm.placement,'kind',ma.media_kind,'content_type',ma.content_type,'object_key',ma.object_key)
      ORDER BY qm.created_at) AS items
    FROM content_question_media qm JOIN content_media_assets ma ON ma.id=qm.media_asset_id
    WHERE qm.question_id=q.id
  ) media ON TRUE
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('id',va.id,'ref',qv.media_ref,'placement',qv.placement,'provider','vimeo','provider_id',va.provider_id,'embed_url',va.embed_url)
      ORDER BY qv.created_at) AS items
    FROM content_question_videos qv JOIN content_video_assets va ON va.id=qv.video_asset_id
    WHERE qv.question_id=q.id
  ) videos ON TRUE`; }

export async function listContentQbankQuestions({
  examTrack,
  destination = 'aylamed_qbank',
  destinationScope = '',
  systemKey = '',
  subsystemKey = '',
  topicKey = '',
  subtopicKey = '',
  sourceProfile = '',
  limit = 40,
  seed = '',
} = {}) {
  await ensureContentRegistrySchema();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 40));
  const safeSeed = String(seed || crypto.randomUUID());
  const cleanSourceProfile = normalizeContentSourceProfile(sourceProfile, '', { allowEmpty: true });
  const examTracks = qbankExamTrackAliases(examTrack);
  const result = await getPool().query(`${qbankQuestionProjection('$9', '$10')}
    WHERE q.exam_track=ANY($1::text[]) AND q.status='approved'
      AND COALESCE(NULLIF(q.source_data->>'item_format',''),'single_best_answer')='single_best_answer'
      AND ($3='' OR COALESCE(NULLIF(q.taxonomy->>'system_key',''),q.system_key)=$3)
      AND ($4='' OR COALESCE(q.taxonomy->>'subsystem_key','')=$4)
      AND ($5='' OR COALESCE(q.taxonomy->>'topic_key',NULLIF(q.title,''),'unclassified')=$5)
      AND ($6='' OR COALESCE(q.taxonomy->>'subtopic_key','')=$6)
    ORDER BY md5(q.id::text || $7), q.id
    LIMIT $8`, [
    examTracks,
    destination,
    String(systemKey),
    String(subsystemKey),
    String(topicKey),
    String(subtopicKey),
    safeSeed,
    safeLimit,
    String(destinationScope || ''),
    cleanSourceProfile,
  ]);
  return result.rows.map(contentQbankQuestionDisplay);
}

export async function getContentQbankQuestions({
  questionIds = [],
  examTrack,
  destination = 'aylamed_qbank',
  destinationScope = '',
  sourceProfile = '',
} = {}) {
  await ensureContentRegistrySchema();
  const ids = [...new Set((Array.isArray(questionIds) ? questionIds : []).map(String).filter(Boolean))].slice(0, 200);
  if (!ids.length) return [];
  const examTracks = qbankExamTrackAliases(examTrack);
  const cleanSourceProfile = normalizeContentSourceProfile(sourceProfile, '', { allowEmpty: true });
  const result = await getPool().query(`${qbankQuestionProjection('$4', '$5')}
    WHERE q.exam_track=ANY($1::text[]) AND q.status='approved'
      AND COALESCE(NULLIF(q.source_data->>'item_format',''),'single_best_answer')='single_best_answer'
      AND q.id=ANY($3::uuid[])
    ORDER BY array_position($3::uuid[],q.id)`, [
    examTracks,
    destination,
    ids,
    String(destinationScope || ''),
    cleanSourceProfile,
  ]);
  return result.rows.map(contentQbankQuestionDisplay);
}

function contentCdmSourceLabel(row = {}) {
  const policy = row.display_policy && typeof row.display_policy === 'object'
    ? row.display_policy
    : {};
  if (String(policy.source_label_mode || 'neutral') === 'provider') {
    return String(row.source_provider || '').trim() || null;
  }
  if (String(policy.source_label_mode || 'neutral') === 'neutral') return 'Clinical decision source';
  return null;
}

export async function listContentCdmCases({
  examTrack,
  destination = 'aylamed_cdm',
  destinationScope = '',
  systemKey = '',
  subsystemKey = '',
  topicKey = '',
  limit = 50,
  seed = '',
} = {}) {
  await ensureContentRegistrySchema();
  const examTracks = qbankExamTrackAliases(examTrack);
  const safeLimit = Math.max(1, Math.min(200, Math.trunc(Number(limit) || 50)));
  const safeSeed = String(seed || crypto.randomUUID());
  const result = await getPool().query(`WITH eligible AS (
      SELECT q.id,q.exam_track,q.title,q.taxonomy,q.system_key,q.source_data,
        delivery.collection_id,delivery.source_item_id,delivery.source_provider,delivery.display_policy,
        COALESCE(NULLIF(q.source_data->>'case_source_id',''),delivery.source_item_id) AS case_source_id,
        CASE WHEN COALESCE(q.source_data->>'case_number','') ~ '^[0-9]+$'
          THEN (q.source_data->>'case_number')::int ELSE 0 END AS case_number,
        CASE WHEN COALESCE(q.source_data->>'step_number','') ~ '^[0-9]+$'
          THEN (q.source_data->>'step_number')::int ELSE 1 END AS step_number,
        CASE WHEN COALESCE(q.source_data->>'max_responses','') ~ '^[0-9]+$'
          THEN LEAST(20,GREATEST(1,(q.source_data->>'max_responses')::int)) ELSE 1 END AS max_responses,
        COALESCE(jsonb_array_length(q.media_refs),0) AS media_reference_count
      FROM content_questions q
      JOIN LATERAL (
        SELECT c.id AS collection_id,a.source_item_id,c.source_provider,c.display_policy
        FROM content_source_aliases a
        JOIN content_collection_destinations d ON d.collection_id=a.collection_id
        JOIN content_collections c ON c.id=a.collection_id
        WHERE a.question_id=q.id AND c.status='approved' AND d.destination=$2 AND d.enabled=TRUE
          AND (d.destination_scope='' OR d.destination_scope=$3)
        ORDER BY CASE WHEN d.destination_scope=$3 AND $3<>'' THEN 0 ELSE 1 END,
          c.approved_at DESC NULLS LAST,c.created_at ASC,a.created_at ASC
        LIMIT 1
      ) delivery ON TRUE
      WHERE q.exam_track=ANY($1::text[]) AND q.status='approved'
        AND q.source_data->>'item_format'='cdm_self_rating_case'
        AND ($4='' OR COALESCE(NULLIF(q.taxonomy->>'system_key',''),q.system_key,'unclassified')=$4)
        AND ($5='' OR COALESCE(q.taxonomy->>'subsystem_key','')=$5)
        AND ($6='' OR COALESCE(q.taxonomy->>'topic_key',NULLIF(q.title,''),'Clinical decision practice')=$6)
    )
    SELECT (array_agg(id ORDER BY step_number,id))[1]::text AS case_id,
      collection_id::text AS collection_id,exam_track,case_source_id,
      MAX(case_number)::int AS case_number,
      COUNT(*)::int AS step_count,
      SUM(media_reference_count)::int AS media_reference_count,
      (array_agg(title ORDER BY step_number,id))[1] AS title,
      COALESCE(NULLIF((array_agg(taxonomy->>'system_key' ORDER BY step_number,id))[1],''),'unclassified') AS system_key,
      COALESCE(NULLIF((array_agg(taxonomy->>'subsystem_key' ORDER BY step_number,id))[1],''),'') AS subsystem_key,
      COALESCE(NULLIF((array_agg(taxonomy->>'topic_key' ORDER BY step_number,id))[1],''),'Clinical decision practice') AS topic_key,
      (array_agg(source_provider ORDER BY step_number,id))[1] AS source_provider,
      (array_agg(display_policy ORDER BY step_number,id))[1] AS display_policy,
      MAX(max_responses)::int AS largest_response_limit
    FROM eligible
    GROUP BY collection_id,exam_track,case_source_id
    ORDER BY md5((array_agg(id ORDER BY step_number,id))[1]::text || $7),case_number,case_source_id
    LIMIT $8`, [
    examTracks,
    cleanContentDestination(destination),
    String(destinationScope || ''),
    String(systemKey || ''),
    String(subsystemKey || ''),
    String(topicKey || ''),
    safeSeed,
    safeLimit,
  ]);
  return result.rows.map((row) => {
    const {
      source_provider: _sourceProvider,
      display_policy: _displayPolicy,
      ...record
    } = row;
    return {
      ...record,
      title: row.case_number
        ? `Case ${row.case_number}`
        : String(row.title || 'Clinical decision case').replace(/\s*[-–—:]\s*(?:Question|Step)\s*\d+\s*$/i, ''),
      source_label: contentCdmSourceLabel(row),
      interaction_format: 'legacy_cdm_write_in_v1',
      scoring_mode: 'student_self_review_not_exam_score',
      legacy_exam_format: true,
    };
  });
}

export async function getContentCdmCase({
  caseId,
  examTrack,
  destination = 'aylamed_cdm',
  destinationScope = '',
} = {}) {
  await ensureContentRegistrySchema();
  const cleanCaseId = String(caseId || '').trim();
  if (!cleanCaseId) return null;
  const examTracks = qbankExamTrackAliases(examTrack);
  const result = await getPool().query(`WITH selected AS (
      SELECT q.id,q.exam_track,
        delivery.collection_id,
        COALESCE(NULLIF(q.source_data->>'case_source_id',''),delivery.source_item_id) AS case_source_id
      FROM content_questions q
      JOIN LATERAL (
        SELECT c.id AS collection_id,a.source_item_id
        FROM content_source_aliases a
        JOIN content_collection_destinations d ON d.collection_id=a.collection_id
        JOIN content_collections c ON c.id=a.collection_id
        WHERE a.question_id=q.id AND c.status='approved' AND d.destination=$2 AND d.enabled=TRUE
          AND (d.destination_scope='' OR d.destination_scope=$4)
        ORDER BY CASE WHEN d.destination_scope=$4 AND $4<>'' THEN 0 ELSE 1 END,
          c.approved_at DESC NULLS LAST,c.created_at ASC,a.created_at ASC
        LIMIT 1
      ) delivery ON TRUE
      WHERE q.id::text=$3 AND q.exam_track=ANY($1::text[]) AND q.status='approved'
        AND q.source_data->>'item_format'='cdm_self_rating_case'
      LIMIT 1
    )
    SELECT q.id::text,q.exam_track,q.title,q.question_html,q.explanation_html,q.taxonomy,q.source_data,
      a.source_item_id,c.id::text AS collection_id,c.source_provider,c.display_policy,
      COALESCE(media.items,'[]'::jsonb) AS media,
      COALESCE(videos.items,'[]'::jsonb) AS videos
    FROM selected s
    JOIN content_source_aliases a ON a.collection_id=s.collection_id
    JOIN content_questions q ON q.id=a.question_id
      AND q.exam_track=s.exam_track AND q.status='approved'
      AND q.source_data->>'item_format'='cdm_self_rating_case'
      AND COALESCE(NULLIF(q.source_data->>'case_source_id',''),a.source_item_id)=s.case_source_id
    JOIN content_collections c ON c.id=a.collection_id AND c.status='approved'
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id',ma.id,'ref',qm.media_ref,'placement',qm.placement,'kind',ma.media_kind,
        'content_type',ma.content_type,'object_key',ma.object_key
      ) ORDER BY qm.created_at) AS items
      FROM content_question_media qm JOIN content_media_assets ma ON ma.id=qm.media_asset_id
      WHERE qm.question_id=q.id
    ) media ON TRUE
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'id',va.id,'ref',qv.media_ref,'placement',qv.placement,'provider','vimeo',
        'provider_id',va.provider_id,'embed_url',va.embed_url
      ) ORDER BY qv.created_at) AS items
      FROM content_question_videos qv JOIN content_video_assets va ON va.id=qv.video_asset_id
      WHERE qv.question_id=q.id
    ) videos ON TRUE
    ORDER BY CASE WHEN COALESCE(q.source_data->>'step_number','') ~ '^[0-9]+$'
      THEN (q.source_data->>'step_number')::int ELSE 1 END,q.id
    LIMIT 20`, [
    examTracks,
    cleanContentDestination(destination),
    cleanCaseId,
    String(destinationScope || ''),
  ]);
  if (!result.rows.length) return null;
  const steps = result.rows.map((row, index) => {
    const sourceData = row.source_data && typeof row.source_data === 'object' ? row.source_data : {};
    return {
      id: row.id,
      exam_track: row.exam_track,
      title: row.title,
      question_html: row.question_html,
      explanation_html: row.explanation_html,
      taxonomy: row.taxonomy || {},
      source_item_id: row.source_item_id,
      case_source_id: sourceData.case_source_id || row.source_item_id,
      case_number: Number(sourceData.case_number || 0) || null,
      step_number: Number(sourceData.step_number || index + 1),
      max_responses: Math.max(1, Math.min(20, Number(sourceData.max_responses || 1))),
      has_dangerous_acts: sourceData.has_dangerous_acts === true,
      interaction_format: 'legacy_cdm_write_in_v1',
      media: Array.isArray(row.media) ? row.media : [],
      videos: Array.isArray(row.videos) ? row.videos : [],
    };
  });
  const first = result.rows[0];
  const caseNumber = Number(first.source_data?.case_number || 0) || null;
  return {
    case_id: cleanCaseId,
    collection_id: first.collection_id,
    exam_track: first.exam_track,
    title: caseNumber
      ? `Case ${caseNumber}`
      : String(first.title || 'Clinical decision case').replace(/\s*[-–—:]\s*(?:Question|Step)\s*\d+\s*$/i, ''),
    case_number: caseNumber,
    step_count: steps.length,
    source_label: contentCdmSourceLabel(first),
    interaction_format: 'legacy_cdm_write_in_v1',
    scoring_mode: 'student_self_review_not_exam_score',
    legacy_exam_format: true,
    steps,
  };
}

const EXTERNAL_QBANK_SESSION_SELECT = `
  SELECT s.*,
    COALESCE(jsonb_agg(jsonb_build_object(
      'question_ref',i.question_ref::text,'question_id',i.question_id::text,'position',i.position,
      'selected_answer_id',i.selected_answer_id,'is_correct',i.is_correct,
      'elapsed_ms',i.elapsed_ms,'answered_at',i.answered_at
    ) ORDER BY i.position) FILTER (WHERE i.question_ref IS NOT NULL), '[]'::jsonb) AS items
  FROM external_qbank_sessions s
  LEFT JOIN external_qbank_session_items i ON i.session_id=s.id`;

async function selectExternalQbankSession({ sessionId, clientId, subjectHash, entitlementHash = '' }, queryable = getPool()) {
  const result = await queryable.query(`${EXTERNAL_QBANK_SESSION_SELECT}
    WHERE s.id=$1 AND s.client_id=$2 AND s.subject_hash=$3
      AND ($4='' OR s.entitlement_hash=$4)
    GROUP BY s.id LIMIT 1`, [sessionId, clientId, subjectHash, String(entitlementHash || '')]);
  return result.rows[0] || null;
}

export async function recordExternalQbankAuditEvent({
  clientId,
  subjectHash = '',
  entitlementHash = '',
  sessionId = null,
  examTrack = '',
  action,
  metadata = {},
} = {}, queryable = null) {
  await ensureContentRegistrySchema();
  const runner = queryable || getPool();
  await runner.query(`INSERT INTO external_qbank_audit_events
    (id,client_id,subject_hash,entitlement_hash,session_id,exam_track,action,metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [
    crypto.randomUUID(), String(clientId || ''), String(subjectHash || ''), String(entitlementHash || ''), sessionId || null,
    String(examTrack || ''), String(action || ''), JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
  ]);
}

export async function createExternalQbankDeliverySession({
  id,
  clientId,
  subjectHash,
  entitlementHash,
  examTrack,
  destinationScope = '',
  mode,
  questions = [],
  filters = {},
  blockSize = 40,
  timeLimitMinutes = null,
  entitlementExpiresAt,
  idempotencyKey = null,
  requestFingerprint,
} = {}) {
  await ensureContentRegistrySchema();
  const cleanQuestions = [...new Set((Array.isArray(questions) ? questions : []).map((row) => String(row?.id || row?.question_id || row || '')).filter(Boolean))].slice(0, 100);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (idempotencyKey) {
      const replay = await client.query(`SELECT id,request_fingerprint FROM external_qbank_sessions
        WHERE client_id=$1 AND subject_hash=$2 AND idempotency_key=$3 LIMIT 1`, [clientId, subjectHash, idempotencyKey]);
      if (replay.rows[0]) {
        if (String(replay.rows[0].request_fingerprint) !== String(requestFingerprint)) {
          throw Object.assign(new Error('Idempotency key was already used for a different external QBank session request'), { statusCode: 409 });
        }
        await client.query('COMMIT');
        return { session: await selectExternalQbankSession({ sessionId: replay.rows[0].id, clientId, subjectHash, entitlementHash }, client), replayed: true };
      }
    }
    if (!cleanQuestions.length) throw Object.assign(new Error('No eligible external QBank questions were selected'), { statusCode: 409 });
    const eligible = await client.query(`SELECT q.id::text
      FROM content_questions q
      WHERE q.id=ANY($1::uuid[]) AND q.exam_track=ANY($2::text[]) AND q.status='approved'
        AND EXISTS (
          SELECT 1 FROM content_source_aliases a
          JOIN content_collection_destinations d ON d.collection_id=a.collection_id
          JOIN content_collections c ON c.id=a.collection_id
          WHERE a.question_id=q.id AND c.status='approved' AND d.destination='external_qbank'
            AND d.enabled=TRUE AND (d.destination_scope='' OR d.destination_scope=$3)
        )`, [cleanQuestions, qbankExamTrackAliases(examTrack), String(destinationScope || '')]);
    const eligibleIds = new Set(eligible.rows.map((row) => String(row.id)));
    if (eligibleIds.size !== cleanQuestions.length) {
      throw Object.assign(new Error('One or more selected questions are no longer approved for this external QBank client'), { statusCode: 409 });
    }
    const inserted = await client.query(`INSERT INTO external_qbank_sessions
      (id,client_id,subject_hash,entitlement_hash,exam_track,destination_scope,mode,status,
       question_count,block_size,filters,time_limit_minutes,idempotency_key,request_fingerprint,entitlement_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10::jsonb,$11,$12,$13,$14)
      ON CONFLICT (client_id,subject_hash,idempotency_key) DO NOTHING RETURNING id`, [
      id, clientId, subjectHash, entitlementHash, examTrack, String(destinationScope || ''), mode,
      cleanQuestions.length, Math.max(1, Math.min(40, Number(blockSize) || 40)), JSON.stringify(filters || {}),
      timeLimitMinutes == null ? null : Math.max(1, Math.min(600, Number(timeLimitMinutes) || 1)),
      idempotencyKey || null, requestFingerprint, entitlementExpiresAt,
    ]);
    if (!inserted.rows[0]) {
      const replay = await client.query(`SELECT id,request_fingerprint FROM external_qbank_sessions
        WHERE client_id=$1 AND subject_hash=$2 AND idempotency_key=$3 LIMIT 1`, [clientId, subjectHash, idempotencyKey]);
      if (!replay.rows[0] || String(replay.rows[0].request_fingerprint) !== String(requestFingerprint)) {
        throw Object.assign(new Error('External QBank session idempotency conflict'), { statusCode: 409 });
      }
      await client.query('COMMIT');
      return { session: await selectExternalQbankSession({ sessionId: replay.rows[0].id, clientId, subjectHash, entitlementHash }, client), replayed: true };
    }
    const items = cleanQuestions.map((questionId, position) => ({ question_ref: crypto.randomUUID(), question_id: questionId, position }));
    await client.query(`INSERT INTO external_qbank_session_items (session_id,question_ref,question_id,position)
      SELECT $1::uuid,x.question_ref::uuid,x.question_id::uuid,x.position
      FROM jsonb_to_recordset($2::jsonb) AS x(question_ref text,question_id text,position int)`, [id, JSON.stringify(items)]);
    await recordExternalQbankAuditEvent({
      clientId, subjectHash, entitlementHash, sessionId: id, examTrack, action: 'session_created',
      metadata: { mode, question_count: cleanQuestions.length, filters, destination_scope: String(destinationScope || '') },
    }, client);
    await client.query('COMMIT');
    return { session: await selectExternalQbankSession({ sessionId: id, clientId, subjectHash, entitlementHash }, client), replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function getExternalQbankDeliverySession({ sessionId, clientId, subjectHash, entitlementHash = '' } = {}) {
  await ensureContentRegistrySchema();
  return selectExternalQbankSession({ sessionId, clientId, subjectHash, entitlementHash });
}

export async function listExternalQbankDeliverySessions({ clientId, subjectHash, entitlementHash, examTrack = '', limit = 50, offset = 0 } = {}) {
  await ensureContentRegistrySchema();
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const result = await getPool().query(`${EXTERNAL_QBANK_SESSION_SELECT}
    WHERE s.client_id=$1 AND s.subject_hash=$2 AND s.entitlement_hash=$3 AND ($4='' OR s.exam_track=$4)
    GROUP BY s.id ORDER BY s.created_at DESC LIMIT $5 OFFSET $6`, [clientId, subjectHash, entitlementHash, String(examTrack || ''), safeLimit, safeOffset]);
  return result.rows;
}

export async function recordExternalQbankDeliveryAnswer({
  sessionId,
  clientId,
  subjectHash,
  entitlementHash,
  questionRef,
  selectedAnswerId,
  isCorrect,
  elapsedMs = null,
} = {}) {
  await ensureContentRegistrySchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const sessionResult = await client.query(`SELECT * FROM external_qbank_sessions
      WHERE id=$1 AND client_id=$2 AND subject_hash=$3 AND entitlement_hash=$4 FOR UPDATE`, [sessionId, clientId, subjectHash, entitlementHash]);
    const session = sessionResult.rows[0];
    if (!session) throw Object.assign(new Error('External QBank session not found'), { statusCode: 404 });
    if (session.status !== 'active') throw Object.assign(new Error('External QBank session is already closed'), { statusCode: 409 });
    const itemResult = await client.query(`SELECT * FROM external_qbank_session_items
      WHERE session_id=$1 AND question_ref=$2 FOR UPDATE`, [sessionId, questionRef]);
    const item = itemResult.rows[0];
    if (!item) throw Object.assign(new Error('Question does not belong to this external QBank session'), { statusCode: 404 });
    if (item.selected_answer_id != null) {
      if (Number(item.selected_answer_id) !== Number(selectedAnswerId)) {
        throw Object.assign(new Error('This answer is locked and cannot be changed'), { statusCode: 409, code: 'EXTERNAL_QBANK_ANSWER_LOCKED' });
      }
      await client.query('COMMIT');
      return { session: await selectExternalQbankSession({ sessionId, clientId, subjectHash, entitlementHash }, client), replayed: true };
    }
    const safeElapsed = Number.isFinite(Number(elapsedMs)) ? Math.max(0, Math.min(86400000, Math.round(Number(elapsedMs)))) : null;
    await client.query(`UPDATE external_qbank_session_items SET selected_answer_id=$3,is_correct=$4,
      elapsed_ms=$5,answered_at=NOW(),updated_at=NOW() WHERE session_id=$1 AND question_ref=$2`,
    [sessionId, questionRef, Number(selectedAnswerId), isCorrect === true, safeElapsed]);
    await client.query(`UPDATE external_qbank_sessions s SET answered_count=(
        SELECT COUNT(*)::int FROM external_qbank_session_items i WHERE i.session_id=s.id AND i.selected_answer_id IS NOT NULL
      ),updated_at=NOW() WHERE s.id=$1`, [sessionId]);
    await recordExternalQbankAuditEvent({
      clientId, subjectHash, entitlementHash, sessionId, examTrack: session.exam_track, action: 'answer_recorded',
      metadata: { question_ref: String(questionRef), result: isCorrect === true ? 'correct' : 'incorrect' },
    }, client);
    await client.query('COMMIT');
    return { session: await selectExternalQbankSession({ sessionId, clientId, subjectHash, entitlementHash }, client), replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function submitExternalQbankDeliverySession({ sessionId, clientId, subjectHash, entitlementHash } = {}) {
  await ensureContentRegistrySchema();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT * FROM external_qbank_sessions
      WHERE id=$1 AND client_id=$2 AND subject_hash=$3 AND entitlement_hash=$4 FOR UPDATE`, [sessionId, clientId, subjectHash, entitlementHash]);
    const session = result.rows[0];
    if (!session) throw Object.assign(new Error('External QBank session not found'), { statusCode: 404 });
    if (session.status === 'submitted') {
      await client.query('COMMIT');
      return { session: await selectExternalQbankSession({ sessionId, clientId, subjectHash, entitlementHash }, client), replayed: true };
    }
    if (session.status !== 'active') throw Object.assign(new Error('External QBank session is already closed'), { statusCode: 409 });
    const totals = await client.query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE selected_answer_id IS NOT NULL)::int AS answered,
      COUNT(*) FILTER (WHERE is_correct=TRUE)::int AS correct
      FROM external_qbank_session_items WHERE session_id=$1`, [sessionId]);
    const total = Number(totals.rows[0]?.total || 0);
    const answered = Number(totals.rows[0]?.answered || 0);
    const correct = Number(totals.rows[0]?.correct || 0);
    const score = total ? Math.round((correct / total) * 10000) / 100 : 0;
    await client.query(`UPDATE external_qbank_sessions SET status='submitted',answered_count=$2,
      correct_count=$3,incorrect_count=$4,unanswered_count=$5,score_percent=$6,
      duration_ms=GREATEST(0,EXTRACT(EPOCH FROM (NOW()-started_at))*1000)::bigint,
      submitted_at=NOW(),updated_at=NOW() WHERE id=$1`,
    [sessionId, answered, correct, Math.max(0, total - correct), Math.max(0, total - answered), score]);
    await recordExternalQbankAuditEvent({
      clientId, subjectHash, entitlementHash, sessionId, examTrack: session.exam_track, action: 'session_submitted',
      metadata: { question_count: total, answered_count: answered, correct_count: correct, score_percent: score },
    }, client);
    await client.query('COMMIT');
    return { session: await selectExternalQbankSession({ sessionId, clientId, subjectHash, entitlementHash }, client), replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listExternalQbankAuditEvents({ clientId = '', sessionId = null, limit = 100, offset = 0 } = {}) {
  await ensureContentRegistrySchema();
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const result = await getPool().query(`SELECT id,client_id,subject_hash,entitlement_hash,session_id,exam_track,action,metadata,created_at
    FROM external_qbank_audit_events
    WHERE ($1='' OR client_id=$1) AND ($2::uuid IS NULL OR session_id=$2)
    ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [String(clientId || ''), sessionId || null, safeLimit, safeOffset]);
  return result.rows.map((row) => ({
    ...row,
    subject_hash: row.subject_hash ? `${String(row.subject_hash).slice(0, 20)}…` : '',
    entitlement_hash: row.entitlement_hash ? `${String(row.entitlement_hash).slice(0, 20)}…` : '',
  }));
}

export async function getContentRegistryFlashcardQuestion({ questionId, examTrack, destinationScope = '' }) {
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
      SELECT jsonb_agg(jsonb_build_object('id',ma.id,'ref',qm.media_ref,'placement',qm.placement,'kind',ma.media_kind,'content_type',ma.content_type,'object_key',ma.object_key)
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
          AND (d.destination_scope='' OR d.destination_scope=$3)
      )
    LIMIT 1
  `, [questionId, examTrack, String(destinationScope || '')]);
  return result.rows[0] || null;
}

export async function listContentRegistryFlashcardQuestions({
  examTrack,
  destinationScope = '',
  systemKey = '',
  subsystemKey = '',
  topicKey = '',
  limit = 40,
  offset = 0,
}) {
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
      SELECT jsonb_agg(jsonb_build_object('id',ma.id,'ref',qm.media_ref,'placement',qm.placement,'kind',ma.media_kind,'content_type',ma.content_type,'object_key',ma.object_key)
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
          AND (d.destination_scope='' OR d.destination_scope=$5)
      )
    ORDER BY q.student_qid, q.id
    LIMIT $6 OFFSET $7
  `, [
    examTrack,
    String(systemKey),
    String(subsystemKey),
    String(topicKey),
    String(destinationScope || ''),
    safeLimit,
    safeOffset,
  ]);
  return result.rows;
}
