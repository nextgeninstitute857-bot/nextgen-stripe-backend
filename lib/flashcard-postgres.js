import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const SHADOW_WRITE = String(process.env.NEXTGEN_FLASHCARD_PG_SHADOW_WRITE || "false").toLowerCase() === "true";

let pool;
let schemaPromise;

export function flashcardPostgresStatus() {
  return {
    configured: Boolean(DATABASE_URL),
    shadow_write_enabled: Boolean(DATABASE_URL && SHADOW_WRITE),
    read_source: "json",
  };
}

function getPool() {
  if (!DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined,
      max: Math.max(1, Math.min(5, Number(process.env.NEXTGEN_FLASHCARD_PG_POOL_MAX || 3))),
      connectionTimeoutMillis: Math.max(500, Number(process.env.NEXTGEN_FLASHCARD_PG_CONNECT_TIMEOUT_MS || 1500)),
      idleTimeoutMillis: 30000,
    });
    pool.on("error", (error) => console.warn("Flashcard Postgres idle client error:", error.message));
  }
  return pool;
}

export async function ensureFlashcardSchema() {
  const activePool = getPool();
  if (!activePool) return false;
  if (!schemaPromise) {
    schemaPromise = activePool.query(`
      CREATE TABLE IF NOT EXISTS flashcard_cards (
        id TEXT PRIMARY KEY,
        app TEXT NOT NULL CHECK (app IN ('lms', 'aylamed')),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('course', 'exam_track')),
        scope_id TEXT NOT NULL,
        owner_user_id TEXT,
        source_namespace TEXT NOT NULL,
        external_id TEXT NOT NULL,
        front TEXT NOT NULL,
        back TEXT NOT NULL,
        explanation TEXT NOT NULL DEFAULT '',
        system_name TEXT NOT NULL DEFAULT '',
        topic_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'published',
        content_fingerprint TEXT NOT NULL DEFAULT '',
        source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (app, source_namespace, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_flashcard_cards_scope ON flashcard_cards(app, scope_type, scope_id, status);
      CREATE INDEX IF NOT EXISTS idx_flashcard_cards_owner ON flashcard_cards(app, owner_user_id) WHERE owner_user_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_flashcard_cards_fingerprint ON flashcard_cards(app, scope_id, content_fingerprint) WHERE content_fingerprint <> '';

      CREATE TABLE IF NOT EXISTS flashcard_review_events (
        id TEXT PRIMARY KEY,
        app TEXT NOT NULL CHECK (app IN ('lms', 'aylamed')),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('course', 'exam_track')),
        scope_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        flashcard_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        rating TEXT NOT NULL CHECK (rating IN ('again', 'hard', 'good', 'easy')),
        confidence TEXT,
        interval_days INTEGER NOT NULL CHECK (interval_days >= 0),
        ease_factor NUMERIC(4,2) NOT NULL,
        lapses INTEGER NOT NULL DEFAULT 0 CHECK (lapses >= 0),
        reviewed_at TIMESTAMPTZ NOT NULL,
        next_review_date DATE NOT NULL,
        source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (app, source_event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_flashcard_review_events_user_time ON flashcard_review_events(app, user_id, reviewed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_flashcard_review_events_card_time ON flashcard_review_events(app, user_id, flashcard_id, reviewed_at DESC);

      CREATE TABLE IF NOT EXISTS flashcard_review_state (
        app TEXT NOT NULL CHECK (app IN ('lms', 'aylamed')),
        scope_type TEXT NOT NULL CHECK (scope_type IN ('course', 'exam_track')),
        scope_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        flashcard_id TEXT NOT NULL,
        rating TEXT NOT NULL CHECK (rating IN ('again', 'hard', 'good', 'easy')),
        interval_days INTEGER NOT NULL CHECK (interval_days >= 0),
        ease_factor NUMERIC(4,2) NOT NULL,
        lapses INTEGER NOT NULL DEFAULT 0 CHECK (lapses >= 0),
        review_count INTEGER NOT NULL DEFAULT 0 CHECK (review_count >= 0),
        last_review_event_id TEXT NOT NULL,
        reviewed_at TIMESTAMPTZ NOT NULL,
        next_review_date DATE NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (app, user_id, flashcard_id)
      );
      CREATE INDEX IF NOT EXISTS idx_flashcard_review_state_due ON flashcard_review_state(app, scope_id, user_id, next_review_date);

      CREATE TABLE IF NOT EXISTS flashcard_migration_map (
        app TEXT NOT NULL CHECK (app IN ('lms', 'aylamed')),
        source_namespace TEXT NOT NULL,
        external_id TEXT NOT NULL,
        target_table TEXT NOT NULL,
        target_id TEXT NOT NULL,
        source_sha256 TEXT NOT NULL DEFAULT '',
        migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (app, source_namespace, external_id, target_table)
      );
      CREATE INDEX IF NOT EXISTS idx_flashcard_migration_map_target ON flashcard_migration_map(target_table, target_id);

      CREATE TABLE IF NOT EXISTS flashcard_migration_runs (
        id TEXT PRIMARY KEY,
        source_file TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        dry_run BOOLEAN NOT NULL DEFAULT FALSE,
        counts JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).then(() => true).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

export async function shadowWriteFlashcardReview({ event, state }) {
  if (!flashcardPostgresStatus().shadow_write_enabled) return { written: false, reason: "disabled" };
  await ensureFlashcardSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO flashcard_review_events (
        id, app, scope_type, scope_id, user_id, flashcard_id, source_event_id,
        rating, confidence, interval_days, ease_factor, lapses, reviewed_at,
        next_review_date, source_data
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
      ON CONFLICT (app, source_event_id) DO NOTHING
    `, [
      event.id, event.app, event.scope_type, event.scope_id, event.user_id,
      event.flashcard_id, event.source_event_id || event.id, event.rating,
      event.confidence || null, event.interval_days, event.ease_factor,
      event.lapses, event.reviewed_at, event.next_review_date,
      JSON.stringify(event.source_data || {}),
    ]);
    await client.query(`
      INSERT INTO flashcard_review_state (
        app, scope_type, scope_id, user_id, flashcard_id, rating, interval_days,
        ease_factor, lapses, review_count, last_review_event_id, reviewed_at,
        next_review_date, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
      ON CONFLICT (app, user_id, flashcard_id) DO UPDATE SET
        scope_type=EXCLUDED.scope_type, scope_id=EXCLUDED.scope_id,
        rating=EXCLUDED.rating, interval_days=EXCLUDED.interval_days,
        ease_factor=EXCLUDED.ease_factor, lapses=EXCLUDED.lapses,
        review_count=GREATEST(flashcard_review_state.review_count, EXCLUDED.review_count),
        last_review_event_id=EXCLUDED.last_review_event_id,
        reviewed_at=EXCLUDED.reviewed_at, next_review_date=EXCLUDED.next_review_date,
        updated_at=NOW()
      WHERE EXCLUDED.reviewed_at >= flashcard_review_state.reviewed_at
    `, [
      state.app, state.scope_type, state.scope_id, state.user_id,
      state.flashcard_id, state.rating, state.interval_days, state.ease_factor,
      state.lapses, state.review_count, state.last_review_event_id,
      state.reviewed_at, state.next_review_date,
    ]);
    await client.query("COMMIT");
    return { written: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function closeFlashcardPostgres() {
  if (pool) await pool.end();
  pool = undefined;
  schemaPromise = undefined;
}
