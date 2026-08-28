import { randomUUID } from "node:crypto";
import { metaAdsReadiness, normalizeMetaCampaignInsight } from "./crm-meta-ads.js";

const array = (value) => Array.isArray(value) ? value : [];
const timestamp = (value) => Date.parse(value || "") || 0;
const minute = 60_000;

export function metaReportingConfig(env = process.env) {
  const readiness = metaAdsReadiness(env);
  const interval = Number(env.META_ADS_SYNC_INTERVAL_MINUTES || 15);
  return {
    enabled: readiness.configured && readiness.preferred_account_configured && String(env.META_ADS_AUTO_SYNC_ENABLED).toLowerCase() !== "false",
    interval_minutes: Number.isFinite(interval) ? Math.max(15, Math.min(1440, interval)) : 15,
    date_preset: "last_30d",
    read_only: true,
  };
}

export function safeMetaReportingError(error) {
  const code = Number(error?.response?.data?.error?.code || 0);
  if (code === 190) return "Meta reporting access expired or was revoked. Reconnect the read-only reporting token.";
  if ([10, 200].includes(code) || error?.statusCode === 403) return "Meta reporting access is missing for the configured ad account.";
  if ([4, 17, 32, 613].includes(code) || error?.response?.status === 429) return "Meta limited reporting requests. Automatic retry is scheduled.";
  if (error?.code === "REPORT_TIMEOUT") return "Meta reporting took too long. Previous figures are retained; automatic retry is scheduled.";
  // Never expose provider messages/URLs: Axios errors can contain credentials.
  return "Meta reporting could not refresh completely. Previous figures are retained; automatic retry is scheduled.";
}

export function metaReportingStatus(db = {}, env = process.env, now = Date.now()) {
  const config = metaReportingConfig(env);
  const state = db.meta_ads_sync_state || {};
  const last = timestamp(state.last_success_at || db.meta_ads_last_sync?.synced_at);
  return {
    ...config,
    status: state.status || (last ? "success" : "never_synced"),
    last_attempt_at: state.last_attempt_at || null,
    last_success_at: last ? new Date(last).toISOString() : null,
    next_attempt_at: config.enabled ? state.next_attempt_at || null : null,
    error: state.error || null,
    stale: !last || now - last > Math.max(30, config.interval_minutes * 2) * minute,
    refreshing: Boolean(state.lease_id && timestamp(state.lease_until) > now),
  };
}

// Period totals are for display. Only non-overlapping daily campaign rows go
// into the ledger consumed by revenue reports. Keep old imported rollups in an
// audit archive, not alongside daily figures where they would be counted twice.
export function prepareMetaDailyLedger(db, snapshot, brandId) {
  if (!Array.isArray(snapshot.daily_insights) || snapshot.daily_insights.some((row) => !row.date_start || row.date_start !== row.date_stop || !row.meta_campaign_id || !row.meta_account_id)) throw new Error("Incomplete daily reporting rows");
  const accountIds = new Set(array(snapshot.accounts).map((row) => String(row.meta_account_id)));
  const belongs = (row) => row.source === "meta_live" && accountIds.has(String(row.meta_account_id)) && (!row.brand_id || row.brand_id === brandId);
  const old = array(db.ad_performance_logs);
  const rollups = old.filter((row) => belongs(row) && row.reporting_granularity !== "day");
  if (rollups.length) {
    db.meta_ads_rollup_archive = [...array(db.meta_ads_rollup_archive), ...rollups.map((row) => ({ ...row, archived_reason: "replaced_by_daily_reporting", archived_at: snapshot.synced_at }))];
  }
  // Replace returned day keys (including corrected zero-day results), preserve
  // days outside this window, other accounts/brands and every manual entry.
  const keys = new Set(array(snapshot.daily_insights).map((row) => `${row.meta_account_id}:${row.meta_campaign_id}:${row.date_start}`));
  db.ad_performance_logs = old.filter((row) => {
    if (!belongs(row)) return true;
    if (row.reporting_granularity !== "day") return false;
    const window = array(snapshot.windows).find((item) => String(item.meta_account_id) === String(row.meta_account_id));
    if (window?.since && window?.until && row.date_start >= window.since && row.date_start <= window.until) return false;
    return !keys.has(`${row.meta_account_id}:${row.meta_campaign_id}:${row.date_start}`);
  });
}

export function saveMetaPerformanceSnapshot(db, snapshot, brandId) {
  const zero = (row) => ({ ...normalizeMetaCampaignInsight({ campaign_id: row.meta_campaign_id, ad_id: row.meta_ad_id }, snapshot.accounts.find((account) => account.meta_account_id === row.meta_account_id)), no_delivery: true });
  db.meta_ads_performance = {
    brand_id: brandId, synced_at: snapshot.synced_at, date_preset: snapshot.date_preset,
    windows: array(snapshot.windows),
    accounts: array(snapshot.accounts).map(({ meta_account_id, currency, timezone_name }) => ({ meta_account_id, currency, timezone_name })),
    campaigns: array(snapshot.campaigns).map((row) => ({ ...row, performance: array(snapshot.insights).find((insight) => insight.meta_campaign_id === row.meta_campaign_id && insight.meta_account_id === row.meta_account_id) || zero(row) })),
    ads: array(snapshot.creatives).map((row) => ({ ...row, performance: array(snapshot.ad_insights).find((insight) => insight.meta_ad_id === row.meta_ad_id && insight.meta_account_id === row.meta_account_id) || zero(row) })),
  };
  return db.meta_ads_performance;
}

// Legacy CRM jobs still save a whole snapshot after network work. They do not
// own reporting state and must not erase a newer lease/report when finishing.
// Protect only the reporting worker's fields, not unrelated CRM collections.
export function preserveMetaReportingForLegacyWrite(current = {}, incoming = {}) {
  if (!current.meta_ads_sync_state && !current.meta_ads_performance) return {};
  const protectedFields = {};
  for (const key of ["meta_ads_sync_state", "meta_ads_performance", "meta_ads_last_sync", "meta_ads_rollup_archive"]) {
    if (Object.hasOwn(current, key)) protectedFields[key] = current[key];
  }
  if (current.meta_ads_performance?.synced_at && current.meta_ads_performance.synced_at !== incoming.meta_ads_performance?.synced_at) {
    for (const key of ["ad_accounts", "ad_campaigns", "ad_sets", "ad_creatives", "ad_performance_logs"]) {
      protectedFields[key] = [...array(incoming[key]).filter((row) => row.source !== "meta_live"), ...array(current[key]).filter((row) => row.source === "meta_live")];
    }
  }
  return protectedFields;
}

export function createMetaReportingRunner({ read, mutate, fetchSnapshot, applySnapshot, env = process.env, now = Date.now }) {
  let running = null;
  const run = async ({ force = false, datePreset = "last_30d" } = {}) => {
    const config = metaReportingConfig(env);
    const ready = metaAdsReadiness(env);
    if (!ready.configured || !ready.preferred_account_configured) return { skipped: true, reason: "not_configured" };
    if (!force && !config.enabled) return { skipped: true, reason: "disabled" };
    const initial = await read();
    if (!force && timestamp(initial.meta_ads_sync_state?.next_attempt_at) > now()) return { skipped: true, reason: "not_due" };
    const leaseId = randomUUID();
    const claimed = await mutate((db) => {
      const state = db.meta_ads_sync_state || {};
      if (state.lease_id && timestamp(state.lease_until) > now()) return false;
      if (!force && timestamp(state.next_attempt_at) > now()) return false;
      db.meta_ads_sync_state = { ...state, status: "refreshing", lease_id: leaseId, lease_until: new Date(now() + 10 * minute).toISOString(), last_attempt_at: new Date(now()).toISOString() };
      return true;
    });
    if (!claimed) return { skipped: true, reason: "refresh_in_progress" };
    let deadline;
    try {
      const snapshot = await Promise.race([
        fetchSnapshot({ datePreset }),
        new Promise((_, reject) => { deadline = setTimeout(() => reject(Object.assign(new Error("Reporting timeout"), { code: "REPORT_TIMEOUT" })), 4 * minute); deadline.unref?.(); }),
      ]);
      return await mutate((db) => {
        if (db.meta_ads_sync_state?.lease_id !== leaseId) return { skipped: true, reason: "lease_changed" };
        // Fetch outside the write lock; apply to the latest CRM, never to an old
        // copy that could overwrite leads arriving during the Meta request.
        const sync = applySnapshot(db, snapshot);
        db.meta_ads_sync_state = { status: "success", last_attempt_at: db.meta_ads_sync_state.last_attempt_at, last_success_at: new Date(now()).toISOString(), next_attempt_at: new Date(now() + config.interval_minutes * minute).toISOString(), consecutive_failures: 0, error: null };
        return { success: true, sync };
      });
    } catch (error) {
      const message = safeMetaReportingError(error);
      await mutate((db) => {
        if (db.meta_ads_sync_state?.lease_id !== leaseId) return;
        const state = db.meta_ads_sync_state;
        const failures = Number(state.consecutive_failures || 0) + 1;
        db.meta_ads_sync_state = { ...state, status: "failed", lease_id: null, lease_until: null, error: message, consecutive_failures: failures, next_attempt_at: new Date(now() + Math.min(120, config.interval_minutes * 2 ** Math.min(3, failures - 1)) * minute).toISOString() };
      });
      return { success: false, error: message };
    } finally { clearTimeout(deadline); }
  };
  return (options) => {
    if (running) return running;
    running = run(options).finally(() => { running = null; });
    return running;
  };
}
