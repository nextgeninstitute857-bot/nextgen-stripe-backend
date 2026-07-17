#!/usr/bin/env node
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import pg from "pg";
import { ensureFlashcardSchema, closeFlashcardPostgres } from "../lib/flashcard-postgres.js";
import { flashcardContentFingerprint, normalizeFlashcardRating, scheduleFlashcardReview } from "../lib/flashcard-engine.js";

const DRY_RUN = process.argv.includes("--dry-run");
const DATA_DIR = process.env.DATA_DIR || "/var/data";
const LIVE_DB_PATH = process.env.LIVE_DB_PATH || path.join(DATA_DIR, "live-session-db.json");
const AYLA_DB_PATH = process.env.AYLA_DB_PATH || path.join(DATA_DIR, "aylamed-db.json");
const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const { Client } = pg;
const require = createRequire(import.meta.url);
const { chain } = require("stream-chain");
const { parser } = require("stream-json");
const { pick } = require("stream-json/filters/Pick");
const { streamObject } = require("stream-json/streamers/StreamObject");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const entries = (value) => Object.entries(value && typeof value === "object" && !Array.isArray(value) ? value : {});
const values = (value) => entries(value).map(([, row]) => row);
const safeDate = (value, fallback = new Date().toISOString()) => Number.isNaN(new Date(value).getTime()) ? fallback : new Date(value).toISOString();

async function fileSha(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function readSection(file, section) {
  const rows = {};
  const pipeline = chain([createReadStream(file), parser(), pick({ filter: section }), streamObject()]);
  for await (const { key, value } of pipeline) rows[String(key)] = value;
  return rows;
}

async function readJson(file, sections) {
  try {
    await fs.access(file);
    const sha = await fileSha(file);
    const sectionRows = [];
    // Scan one section at a time: bounded memory and bounded disk/CPU pressure.
    for (const section of sections) sectionRows.push([section, await readSection(file, section)]);
    return { file, sha, db: Object.fromEntries(sectionRows) };
  } catch (error) {
    if (error.code === "ENOENT") return { file, sha: sha256("{}"), db: {}, missing: true };
    throw error;
  }
}

function collect(live, ayla) {
  const cards = [];
  const events = [];
  const states = new Map();

  for (const [externalId, card] of entries(live.db.flashcards)) {
    const scopeId = String(card.course_id || "unscoped-lms");
    cards.push({
      id: `lms:${externalId}`, app: "lms", scopeType: "course", scopeId,
      ownerUserId: card.user_id ? String(card.user_id) : null,
      namespace: "lms.flashcards", externalId: String(externalId),
      front: String(card.front || card.question || ""), back: String(card.back || card.answer || ""),
      explanation: String(card.explanation || ""), system: String(card.system || ""),
      topic: String(card.topic || card.tag || ""), status: String(card.status || (card.is_published === false ? "draft" : "published")),
      fingerprint: flashcardContentFingerprint(card), source: card,
      createdAt: safeDate(card.created_at), updatedAt: safeDate(card.updated_at || card.created_at),
    });
  }

  for (const [externalId, progress] of entries(live.db.flashcardProgress)) {
    if (!progress?.user_id || !progress?.flashcard_id) continue;
    const reviewedAt = safeDate(progress.reviewed_at || progress.updated_at);
    const schedule = scheduleFlashcardReview(progress, progress.rating || progress.confidence || "good", reviewedAt);
    const event = {
      id: `legacy:lms-progress:${externalId}`, app: "lms", scopeType: "course",
      scopeId: String(progress.course_id || "unscoped-lms"), userId: String(progress.user_id),
      flashcardId: `lms:${progress.flashcard_id}`, sourceEventId: `legacy:lms-progress:${externalId}`,
      rating: schedule.rating, confidence: progress.confidence || null,
      intervalDays: Number(progress.interval_days ?? schedule.interval_days), easeFactor: Number(progress.ease_factor ?? schedule.ease_factor),
      lapses: Number(progress.lapses ?? schedule.lapses), reviewedAt,
      nextReviewDate: String(progress.next_review_date || progress.due_date || schedule.next_review_date).slice(0, 10), source: progress,
    };
    events.push(event);
    states.set(`lms:${event.userId}:${event.flashcardId}`, { ...event, reviewCount: Number(progress.review_count || 1), lastReviewEventId: event.id });
  }

  for (const [externalId, event] of entries(live.db.flashcardReviewEvents)) {
    if (!event?.user_id || !event?.flashcard_id) continue;
    const reviewedAt = safeDate(event.reviewed_at || event.created_at);
    const row = {
      id: `lms-event:${externalId}`, app: "lms", scopeType: "course", scopeId: String(event.course_id || "unscoped-lms"),
      userId: String(event.user_id), flashcardId: `lms:${event.flashcard_id}`, sourceEventId: `lms:${externalId}`,
      rating: normalizeFlashcardRating(event.rating || event.confidence), confidence: event.confidence || null,
      intervalDays: Math.max(0, Number(event.interval_days || 0)), easeFactor: Number(event.ease_factor || 2.5), lapses: Math.max(0, Number(event.lapses || 0)),
      reviewedAt, nextReviewDate: String(event.next_review_date || reviewedAt).slice(0, 10), source: event,
    };
    events.push(row);
  }

  const aylaCards = [
    ...entries(ayla.db.aylaFlashcards).map(([id, row]) => ["ayla.flashcards", id, row]),
    ...entries(ayla.db.aylaResources).filter(([, row]) => String(row?.type || row?.category).toLowerCase() === "flashcard").map(([id, row]) => ["ayla.resources", id, row]),
  ];
  for (const [namespace, externalId, card] of aylaCards) {
    const scopeId = String(card.examTrackId || card.exam_track_id || card.exam || "unscoped-aylamed");
    cards.push({
      id: `aylamed:${namespace}:${externalId}`, app: "aylamed", scopeType: "exam_track", scopeId,
      ownerUserId: card.ownerStudentId || card.studentId || null, namespace, externalId: String(externalId),
      front: String(card.front || card.question || card.title || ""), back: String(card.back || card.answer || card.content || ""),
      explanation: String(card.explanation || ""), system: String(card.system || ""), topic: String(card.topic || ""),
      status: String(card.status || "published"), fingerprint: flashcardContentFingerprint(card), source: card,
      createdAt: safeDate(card.createdAt || card.created_at), updatedAt: safeDate(card.updatedAt || card.updated_at || card.createdAt),
    });
  }

  for (const [externalId, review] of entries(ayla.db.aylaFlashcardReviews)) {
    if (!review?.studentId || !review?.resourceId) continue;
    const reviewedAt = safeDate(review.createdAt);
    const row = {
      id: `aylamed-event:${externalId}`, app: "aylamed", scopeType: "exam_track", scopeId: String(review.examTrackId || review.exam || "unscoped-aylamed"),
      userId: String(review.studentId), flashcardId: `aylamed:ayla.resources:${review.resourceId}`, sourceEventId: `aylamed:${externalId}`,
      rating: normalizeFlashcardRating(review.rating), confidence: null,
      intervalDays: Math.max(0, Number(review.intervalDays || 0)), easeFactor: Number(review.easeFactor || 2.5), lapses: Math.max(0, Number(review.lapses || 0)),
      reviewedAt, nextReviewDate: String(review.nextReviewDate || reviewedAt).slice(0, 10), source: review,
    };
    events.push(row);
    const key = `aylamed:${row.userId}:${row.flashcardId}`;
    const prior = states.get(key);
    if (!prior || row.reviewedAt >= prior.reviewedAt) states.set(key, { ...row, reviewCount: Number(prior?.reviewCount || 0) + 1, lastReviewEventId: row.id });
  }
  return { cards, events, states: [...states.values()] };
}

async function upsertCard(client, row, sourceSha) {
  await client.query(`INSERT INTO flashcard_cards (id,app,scope_type,scope_id,owner_user_id,source_namespace,external_id,front,back,explanation,system_name,topic_name,status,content_fingerprint,source_data,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)
    ON CONFLICT (app,source_namespace,external_id) DO UPDATE SET scope_type=EXCLUDED.scope_type,scope_id=EXCLUDED.scope_id,owner_user_id=EXCLUDED.owner_user_id,front=EXCLUDED.front,back=EXCLUDED.back,explanation=EXCLUDED.explanation,system_name=EXCLUDED.system_name,topic_name=EXCLUDED.topic_name,status=EXCLUDED.status,content_fingerprint=EXCLUDED.content_fingerprint,source_data=EXCLUDED.source_data,updated_at=EXCLUDED.updated_at`,
  [row.id,row.app,row.scopeType,row.scopeId,row.ownerUserId,row.namespace,row.externalId,row.front,row.back,row.explanation,row.system,row.topic,row.status,row.fingerprint,JSON.stringify(row.source),row.createdAt,row.updatedAt]);
  await client.query(`INSERT INTO flashcard_migration_map (app,source_namespace,external_id,target_table,target_id,source_sha256) VALUES ($1,$2,$3,'flashcard_cards',$4,$5)
    ON CONFLICT (app,source_namespace,external_id,target_table) DO UPDATE SET target_id=EXCLUDED.target_id,source_sha256=EXCLUDED.source_sha256,migrated_at=NOW()`, [row.app,row.namespace,row.externalId,row.id,sourceSha]);
}

async function upsertEvent(client, row) {
  await client.query(`INSERT INTO flashcard_review_events (id,app,scope_type,scope_id,user_id,flashcard_id,source_event_id,rating,confidence,interval_days,ease_factor,lapses,reviewed_at,next_review_date,source_data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) ON CONFLICT (app,source_event_id) DO NOTHING`,
  [row.id,row.app,row.scopeType,row.scopeId,row.userId,row.flashcardId,row.sourceEventId,row.rating,row.confidence,row.intervalDays,row.easeFactor,row.lapses,row.reviewedAt,row.nextReviewDate,JSON.stringify(row.source)]);
}

async function upsertState(client, row) {
  await client.query(`INSERT INTO flashcard_review_state (app,scope_type,scope_id,user_id,flashcard_id,rating,interval_days,ease_factor,lapses,review_count,last_review_event_id,reviewed_at,next_review_date)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (app,user_id,flashcard_id) DO UPDATE SET scope_type=EXCLUDED.scope_type,scope_id=EXCLUDED.scope_id,rating=EXCLUDED.rating,interval_days=EXCLUDED.interval_days,ease_factor=EXCLUDED.ease_factor,lapses=EXCLUDED.lapses,review_count=GREATEST(flashcard_review_state.review_count,EXCLUDED.review_count),last_review_event_id=EXCLUDED.last_review_event_id,reviewed_at=EXCLUDED.reviewed_at,next_review_date=EXCLUDED.next_review_date,updated_at=NOW() WHERE EXCLUDED.reviewed_at >= flashcard_review_state.reviewed_at`,
  [row.app,row.scopeType,row.scopeId,row.userId,row.flashcardId,row.rating,row.intervalDays,row.easeFactor,row.lapses,row.reviewCount,row.lastReviewEventId,row.reviewedAt,row.nextReviewDate]);
}

async function main() {
  const [live, ayla] = await Promise.all([
    readJson(LIVE_DB_PATH, ["flashcards", "flashcardProgress", "flashcardReviewEvents"]),
    readJson(AYLA_DB_PATH, ["aylaFlashcards", "aylaResources", "aylaFlashcardReviews"]),
  ]);
  const data = collect(live, ayla);
  const counts = { cards: data.cards.length, events: data.events.length, states: data.states.length, lms_cards: data.cards.filter((x) => x.app === "lms").length, aylamed_cards: data.cards.filter((x) => x.app === "aylamed").length };
  console.log(JSON.stringify({ dry_run: DRY_RUN, sources: [{ file: live.file, missing: !!live.missing, sha256: live.sha }, { file: ayla.file, missing: !!ayla.missing, sha256: ayla.sha }], counts }, null, 2));
  if (DRY_RUN) return;
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required unless --dry-run is used");
  await ensureFlashcardSchema();
  const client = new Client({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const row of data.cards) await upsertCard(client, row, row.app === "lms" ? live.sha : ayla.sha);
    for (const row of data.events) await upsertEvent(client, row);
    for (const row of data.states) await upsertState(client, row);
    const runId = `flashcards:${new Date().toISOString()}:${live.sha.slice(0, 12)}:${ayla.sha.slice(0, 12)}`;
    await client.query("INSERT INTO flashcard_migration_runs (id,source_file,source_sha256,dry_run,counts) VALUES ($1,$2,$3,FALSE,$4::jsonb)", [runId, `${live.file};${ayla.file}`, `${live.sha};${ayla.sha}`, JSON.stringify(counts)]);
    await client.query("COMMIT");
    console.log(`Migration committed: ${runId}`);
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { await client.end(); await closeFlashcardPostgres(); }
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exit(1); });
