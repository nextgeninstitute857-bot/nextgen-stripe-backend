import test from "node:test";
import assert from "node:assert/strict";
import { fetchMetaAdsSnapshot, metaReportingDateRange, normalizeMetaCampaignInsight } from "../lib/crm-meta-ads.js";
import { createMetaReportingRunner, metaReportingConfig, metaReportingStatus, prepareMetaDailyLedger, saveMetaPerformanceSnapshot, preserveMetaReportingForLegacyWrite } from "../lib/crm-meta-ads-reporting.js";

const env = { META_ADS_ACCESS_TOKEN: "synthetic-private-token", META_AD_ACCOUNT_ID: "123" };
const now = Date.parse("2026-08-28T20:30:00Z");
const account = { meta_account_id: "123", currency: "usd", timezone_name: "Asia/Karachi" };
function snapshot() {
  const insight = { ...normalizeMetaCampaignInsight({ campaign_id: "c1", spend: "15", actions: [{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "3" }], date_start: "2026-08-28", date_stop: "2026-08-28" }, account), reporting_granularity: "day" };
  return { accounts: [account], campaigns: [{ meta_campaign_id: "c1", meta_account_id: "123", name: "US pilot", currency: "usd" }], creatives: [{ meta_ad_id: "a1", meta_campaign_id: "c1", meta_account_id: "123", name: "CNS" }], insights: [insight], ad_insights: [{ ...insight, meta_ad_id: "a1" }], daily_insights: [insight], synced_at: new Date(now).toISOString(), date_preset: "last_30d", windows: [{ meta_account_id: "123", since: "2026-07-30", until: "2026-08-28" }] };
}

test("overlapping Meta action aliases are not added; purchases are not LMS enrollments", () => {
  const insight = normalizeMetaCampaignInsight({ actions: [
    { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "3" },
    { action_type: "messaging_conversation_started_7d", value: "3" },
    { action_type: "onsite_conversion.messaging_first_reply", value: "2" },
    { action_type: "lead", value: "4" }, { action_type: "onsite_conversion.lead_grouped", value: "4" },
    { action_type: "purchase", value: "1" }, { action_type: "omni_purchase", value: "1" },
  ] });
  assert.equal(insight.messaging_conversations, 3);
  assert.equal(insight.leads, 4);
  assert.equal(insight.meta_purchases, 1);
  assert.equal(insight.enrollments, 0);
  assert.equal(normalizeMetaCampaignInsight({ actions: [{ action_type: "onsite_conversion.messaging_first_reply", value: "5" }] }).messaging_conversations, 0);
});

test("reporting includes today's date in the ad account clock, across midnight and month boundaries", () => {
  assert.deepEqual(metaReportingDateRange("today", "Asia/Karachi", new Date(now)), { since: "2026-08-29", until: "2026-08-29" });
  assert.deepEqual(metaReportingDateRange("last_30d", "Asia/Karachi", new Date(now)), { since: "2026-07-31", until: "2026-08-29" });
  assert.deepEqual(metaReportingDateRange("last_month", "UTC", new Date("2026-03-01T00:00Z")), { since: "2026-02-01", until: "2026-02-28" });
});

test("automatic reporting requires a dedicated account and respects the off switch", () => {
  assert.equal(metaReportingConfig({ META_ADS_ACCESS_TOKEN: "x" }).enabled, false);
  assert.equal(metaReportingConfig(env).enabled, true);
  assert.equal(metaReportingConfig({ ...env, META_ADS_AUTO_SYNC_ENABLED: "false" }).enabled, false);
  assert.equal(metaReportingConfig({ ...env, META_ADS_SYNC_INTERVAL_MINUTES: "1" }).interval_minutes, 15);
  assert.doesNotMatch(JSON.stringify(metaReportingConfig(env)), /synthetic-private/);
});

test("daily ledger prevents double counting, retains audit copies and preserves unrelated data", () => {
  const source = snapshot();
  const daily = source.daily_insights[0];
  const db = { ad_performance_logs: [{ ...daily, id: "old-rollup", reporting_granularity: undefined }, { ...daily, id: "day" }, { id: "manual", spend_usd: 7 }, { ...daily, meta_account_id: "other", id: "other" }, { ...daily, brand_id: "other-brand", id: "brand" }], leads: [{ id: "keep" }] };
  for (let i = 0; i < 2; i++) { prepareMetaDailyLedger(db, source, "nextgen"); db.ad_performance_logs.push(...source.daily_insights); }
  assert.equal(db.ad_performance_logs.filter((row) => row.meta_account_id === "123" && !row.brand_id).reduce((sum, row) => sum + row.spend_usd, 0), 15);
  assert.equal(db.meta_ads_rollup_archive.length, 1);
  assert.ok(db.ad_performance_logs.some((row) => row.id === "manual"));
  assert.ok(db.ad_performance_logs.some((row) => row.id === "other"));
  assert.ok(db.ad_performance_logs.some((row) => row.id === "brand"));
  assert.deepEqual(db.leads, [{ id: "keep" }]);
  prepareMetaDailyLedger(db, { ...source, daily_insights: [] }, "nextgen");
  assert.equal(db.ad_performance_logs.some((row) => row.meta_account_id === "123" && !row.brand_id), false, "corrected empty window removes stale daily spend");
  assert.throws(() => prepareMetaDailyLedger(db, { ...source, daily_insights: [{ ...daily, date_stop: "2026-08-29" }] }, "nextgen"));
});

test("campaign and ad reporting use separate totals; no-delivery is zero only after a complete snapshot", () => {
  const db = {};
  const s = snapshot();
  s.creatives.push({ meta_ad_id: "a2", meta_campaign_id: "c1", meta_account_id: "123" });
  saveMetaPerformanceSnapshot(db, s, "nextgen");
  assert.equal(db.meta_ads_performance.campaigns[0].performance.spend_amount, 15);
  assert.equal(db.meta_ads_performance.ads[0].performance.spend_amount, 15);
  assert.equal(db.meta_ads_performance.ads[1].performance.spend_amount, 0);
  assert.equal(db.meta_ads_performance.ads[1].performance.no_delivery, true);
});

function harness(fetchSnapshot = async () => snapshot()) {
  let db = { leads: [{ id: "original" }], meta_ads_performance: { previous: true } };
  let clock = now;
  const deps = { env, now: () => clock, read: async () => structuredClone(db),
    mutate: async (fn) => { const copy = structuredClone(db); const value = await fn(copy); db = copy; return value; },
    fetchSnapshot, applySnapshot: (state, data) => { saveMetaPerformanceSnapshot(state, data, "nextgen"); return { status: "success" }; } };
  return { deps, run: createMetaReportingRunner(deps), get db() { return db; }, advance: (ms) => { clock += ms; } };
}

test("refresh is single-flight and atomic; new leads arriving during Meta reads survive", async () => {
  let finish;
  let calls = 0;
  const h = harness(async () => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const one = h.run(); const two = h.run();
  assert.equal(one, two);
  await new Promise((resolve) => setImmediate(resolve));
  const secondWorker = createMetaReportingRunner(h.deps);
  assert.equal((await secondWorker({ force: true })).reason, "refresh_in_progress");
  await h.deps.mutate((db) => db.leads.push({ id: "arrived-while-fetching" }));
  finish(snapshot());
  assert.equal((await one).success, true);
  assert.equal(calls, 1);
  assert.equal(h.db.leads.length, 2);
  assert.equal((await h.run()).reason, "not_due");
  assert.equal(metaReportingStatus(h.db, env, now).stale, false);
});

test("provider failure retains last good data, redacts credentials and schedules backoff", async () => {
  const h = harness(async () => { throw new Error(`private token ${env.META_ADS_ACCESS_TOKEN}`); });
  const result = await h.run();
  assert.equal(result.success, false);
  assert.deepEqual(h.db.meta_ads_performance, { previous: true });
  assert.doesNotMatch(JSON.stringify(h.db), /synthetic-private-token/);
  assert.equal((await h.run()).reason, "not_due");
  h.advance(15 * 60_000);
  await h.run();
  assert.equal(h.db.meta_ads_sync_state.consecutive_failures, 2);
  assert.equal(Date.parse(h.db.meta_ads_sync_state.next_attempt_at) - (now + 15 * 60_000), 30 * 60_000);
});

test("read-only API import retrieves campaign totals, each ad and daily ledger; requests include today", async () => {
  const requests = [];
  const axiosClient = { get: async (url, options) => {
    requests.push({ url, options });
    const path = new URL(url).pathname;
    let data = [];
    if (path.endsWith("/adaccounts")) data = [{ id: "act_123", currency: "USD", timezone_name: "Asia/Karachi" }];
    if (path.endsWith("/campaigns")) data = [{ id: "c1" }];
    if (path.endsWith("/ads")) data = [{ id: "a1", campaign_id: "c1" }];
    if (path.endsWith("/insights")) data = [{ campaign_id: "c1", ...(options.params.level === "ad" ? { ad_id: "a1" } : {}), spend: "15", date_start: "2026-08-28", date_stop: "2026-08-28" }];
    return { data: { data } };
  } };
  const result = await fetchMetaAdsSnapshot({ axiosClient, env });
  assert.equal(requests.length, 7);
  assert.equal(result.ad_insights[0].meta_ad_id, "a1");
  assert.equal(result.daily_insights[0].reporting_granularity, "day");
  for (const call of requests.filter((r) => r.url.endsWith("/insights"))) assert.ok(JSON.parse(call.options.params.time_range).until);
});

test("malformed or truncated Meta results cannot be displayed as a successful zero-spend refresh", async () => {
  await assert.rejects(fetchMetaAdsSnapshot({ env, axiosClient: { get: async () => ({ data: {} }) } }), /incomplete/);
  await assert.rejects(fetchMetaAdsSnapshot({ env, axiosClient: { get: async () => ({ data: { data: [], paging: { next: "https://graph.facebook.com/v26.0/more" } } }) } }), /pagination limit/);
  await assert.rejects(fetchMetaAdsSnapshot({ env, axiosClient: { get: async () => ({ data: { data: [], paging: { next: "https://evil.example/more" } } }) } }), /invalid paging/);
});

test("legacy heartbeat saves cannot wipe a newer reporting lease, snapshot or ledger", () => {
  const current = { meta_ads_sync_state: { lease_id: "new-lease" }, meta_ads_performance: { synced_at: "new" }, meta_ads_last_sync: { synced_at: "new" }, meta_ads_rollup_archive: [{ id: "archived" }], ad_performance_logs: [{ id: "new-daily", source: "meta_live", spend_usd: 15 }], leads: [{ id: "current-lead" }] };
  const incoming = { meta_ads_sync_state: null, meta_ads_performance: null, ad_performance_logs: [{ id: "manual", spend_usd: 4 }], leads: [{ id: "incoming-lead" }] };
  const safe = { ...incoming, ...preserveMetaReportingForLegacyWrite(current, incoming) };
  assert.equal(safe.meta_ads_sync_state.lease_id, "new-lease");
  assert.equal(safe.meta_ads_performance.synced_at, "new");
  assert.equal(safe.ad_performance_logs.length, 2);
  assert.deepEqual(safe.leads, incoming.leads, "this narrow guard must not rewrite unrelated lead data");
  assert.deepEqual(preserveMetaReportingForLegacyWrite({}, incoming), {});
});
