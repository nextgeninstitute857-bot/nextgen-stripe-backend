#!/usr/bin/env node
/**
 * NextGen CRM DB Compact Phase 1
 * Backs up /var/data/crm-db.json, archives old CRM logs, and compacts old delivery locks.
 */

import fs from "node:fs";
import path from "node:path";

const CRM_PATH = process.env.CRM_DB_PATH || "/var/data/crm-db.json";
const ARCHIVE_DIR = process.env.CRM_ARCHIVE_DIR || "/var/data/crm-archive";

const LIMITS = {
  message_logs: Number(process.env.CRM_KEEP_MESSAGE_LOGS || 4000),
  outbound_messages: Number(process.env.CRM_KEEP_OUTBOUND_MESSAGES || 4000),
  ai_auto_runs: Number(process.env.CRM_KEEP_AI_AUTO_RUNS || 1500),
  integration_logs: Number(process.env.CRM_KEEP_INTEGRATION_LOGS || 500),
  client_data_events: Number(process.env.CRM_KEEP_CLIENT_DATA_EVENTS || 500),
  crm_sales_briefs: Number(process.env.CRM_KEEP_SALES_BRIEFS || 200),
  ai_training_deletion_logs: Number(process.env.CRM_KEEP_TRAINING_DELETION_LOGS || 300),
  community_post_history: Number(process.env.CRM_KEEP_COMMUNITY_POST_HISTORY || 300),
};

const LOCKS_KEEP_FULL = Number(process.env.CRM_KEEP_FULL_DELIVERY_LOCKS || 4000);

const DATE_FIELDS = [
  "created_at", "createdAt", "timestamp", "time", "date", "sent_at", "sentAt",
  "updated_at", "updatedAt", "scheduled_at", "scheduledAt", "delivered_at", "deliveredAt",
  "last_sent_at", "lastSentAt"
];

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function mb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function jsonSizeMb(value) {
  return mb(Buffer.byteLength(JSON.stringify(value ?? {})));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function getTime(item, index) {
  for (const field of DATE_FIELDS) {
    const value = item?.[field];
    if (!value) continue;
    const t = new Date(value).getTime();
    if (Number.isFinite(t)) return t;
  }
  return index;
}

function splitKeepArchive(arr, keepCount) {
  const indexed = arr.map((item, index) => ({ item, index, score: getTime(item, index) }));
  indexed.sort((a, b) => b.score - a.score || b.index - a.index);
  const keepIndex = new Set(indexed.slice(0, keepCount).map((x) => x.index));
  const keep = [];
  const archive = [];
  arr.forEach((item, index) => {
    if (keepIndex.has(index)) keep.push(item);
    else archive.push(item);
  });
  return { keep, archive };
}

function archiveSection(section, records) {
  if (!records?.length) return "";
  ensureDir(ARCHIVE_DIR);
  const file = path.join(ARCHIVE_DIR, `${section}-${stamp()}.json`);
  fs.writeFileSync(file, JSON.stringify({ section, archived_at: new Date().toISOString(), count: records.length, records }, null, 2));
  return file;
}

function compactLock(item) {
  const compact = {};
  const keepFields = [
    "id", "key", "lock_key", "lockKey", "dedupe_key", "dedupeKey", "message_key", "messageKey",
    "lead_id", "leadId", "contact_id", "contactId", "conversation_id", "conversationId",
    "message_id", "messageId", "campaign_id", "campaignId", "template_name", "templateName",
    "phone", "to", "channel", "type", "status", "scheduled_at", "scheduledAt", "sent_at", "sentAt",
    "created_at", "createdAt", "updated_at", "updatedAt"
  ];
  for (const field of keepFields) {
    if (Object.prototype.hasOwnProperty.call(item || {}, field)) compact[field] = item[field];
  }
  compact.compacted = true;
  compact.compacted_at = new Date().toISOString();
  return compact;
}

function sectionTable(db) {
  const rows = [];
  for (const [key, value] of Object.entries(db || {})) {
    let count = 0;
    if (Array.isArray(value)) count = value.length;
    else if (value && typeof value === "object") count = Object.keys(value).length;
    rows.push({ section: key, type: Array.isArray(value) ? "array" : typeof value, count, size_mb: jsonSizeMb(value) });
  }
  rows.sort((a, b) => b.size_mb - a.size_mb);
  return rows.slice(0, 50);
}

function main() {
  console.log("CRM compact started");
  console.log("CRM_PATH:", CRM_PATH);
  console.log("ARCHIVE_DIR:", ARCHIVE_DIR);

  if (!fs.existsSync(CRM_PATH)) {
    console.error("CRM DB not found:", CRM_PATH);
    process.exit(1);
  }

  ensureDir(ARCHIVE_DIR);
  const beforeStat = fs.statSync(CRM_PATH);
  console.log("Before CRM file size MB:", mb(beforeStat.size));

  const raw = fs.readFileSync(CRM_PATH, "utf8");
  const db = JSON.parse(raw);

  console.log("Before largest sections:");
  console.table(sectionTable(db).slice(0, 15));

  const backupPath = path.join(ARCHIVE_DIR, `crm-db.backup-before-compact-${stamp()}.json`);
  fs.copyFileSync(CRM_PATH, backupPath);
  console.log("Backup saved:", backupPath);

  const archiveReport = [];
  for (const [section, keepCount] of Object.entries(LIMITS)) {
    const value = db[section];
    if (!Array.isArray(value)) {
      archiveReport.push({ section, action: "skipped_not_array", before: 0, kept: 0, archived: 0, archive_file: "" });
      continue;
    }
    if (value.length <= keepCount) {
      archiveReport.push({ section, action: "kept_all", before: value.length, kept: value.length, archived: 0, archive_file: "" });
      continue;
    }
    const { keep, archive } = splitKeepArchive(value, keepCount);
    const archiveFile = archiveSection(section, archive);
    db[section] = keep;
    archiveReport.push({ section, action: "archived_old_records", before: value.length, kept: keep.length, archived: archive.length, archive_file: archiveFile });
  }

  if (Array.isArray(db.message_delivery_locks)) {
    const locks = db.message_delivery_locks;
    const indexed = locks.map((item, index) => ({ item, index, score: getTime(item, index) }));
    indexed.sort((a, b) => b.score - a.score || b.index - a.index);
    const keepFullIndex = new Set(indexed.slice(0, LOCKS_KEEP_FULL).map((x) => x.index));
    let compacted = 0;
    db.message_delivery_locks = locks.map((item, index) => {
      if (keepFullIndex.has(index)) return item;
      compacted += 1;
      return compactLock(item);
    });
    archiveReport.push({ section: "message_delivery_locks", action: "compacted_old_records_kept_all", before: locks.length, kept: locks.length, archived: 0, compacted, archive_file: "" });
  }

  db.crm_compaction_meta = {
    ...(db.crm_compaction_meta || {}),
    last_compacted_at: new Date().toISOString(),
    backup_path: backupPath,
    archive_dir: ARCHIVE_DIR,
    report: archiveReport,
  };

  const tmpPath = `${CRM_PATH}.tmp-${stamp()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
  fs.renameSync(tmpPath, CRM_PATH);

  const afterStat = fs.statSync(CRM_PATH);
  console.log("Compaction report:");
  console.table(archiveReport);
  console.log("After largest sections:");
  console.table(sectionTable(db).slice(0, 15));
  console.log("CRM compact complete");
  console.log("Before MB:", mb(beforeStat.size));
  console.log("After MB:", mb(afterStat.size));
  console.log("Reduced MB:", mb(beforeStat.size - afterStat.size));
  console.log("Backup:", backupPath);
  console.log("Archive dir:", ARCHIVE_DIR);
}

main();
