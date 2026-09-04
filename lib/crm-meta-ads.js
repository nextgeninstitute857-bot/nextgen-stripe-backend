import { configuredMetaAdAccountIds } from "./crm-brand-routing.js";

const GRAPH_HOST = "graph.facebook.com";

function clean(value = "") {
  return String(value ?? "").trim();
}

function cleanId(value = "") {
  return clean(value).replace(/^act_/i, "");
}

function amountFromMinorUnits(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric / 100 : 0;
}

function amount(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function actionValue(actions, acceptedTypes) {
  // Meta reports overlapping aggregates/aliases, not independent conversions.
  for (const type of acceptedTypes) {
    const item = (Array.isArray(actions) ? actions : []).find((row) => clean(row?.action_type) === type);
    if (item) return amount(item.value);
  }
  return 0;
}

function firstWhatsAppMessage(payload = {}) {
  return payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    || payload?.value?.messages?.[0]
    || payload?.message
    || null;
}

export function extractClickToWhatsAppAttribution(payload = {}) {
  const referral = firstWhatsAppMessage(payload)?.referral;
  if (!referral || typeof referral !== "object") return {};

  const clickId = clean(referral.ctwa_clid);
  const sourceId = clean(referral.source_id);
  const sourceType = clean(referral.source_type || "ad").toLowerCase();
  const headline = clean(referral.headline);
  const mediaUrl = clean(
    referral.image_url
    || referral.video_url
    || referral.thumbnail_url,
  );

  if (!clickId && !sourceId) return {};

  return {
    meta_ctwa_clid: clickId,
    meta_source_type: sourceType,
    meta_source_id: sourceId,
    meta_ad_id: sourceType === "ad" ? sourceId : "",
    meta_source_url: clean(referral.source_url),
    meta_ad_headline: headline,
    meta_ad_body: clean(referral.body),
    meta_media_type: clean(referral.media_type).toLowerCase(),
    meta_media_url: mediaUrl,
    lead_origin: "click_to_whatsapp_ad",
    lead_source: "click_to_whatsapp_ad",
    source_channel: "click_to_whatsapp_ad",
    source_detail: headline || sourceId,
    opt_in_status: "click_to_whatsapp_inbound",
  };
}

export function metaAdsReadiness(env = process.env) {
  const token = clean(env.META_ADS_ACCESS_TOKEN);
  const preferredAccounts = configuredMetaAdAccountIds(env);
  const version = clean(env.META_GRAPH_API_VERSION || env.FACEBOOK_GRAPH_API_VERSION || "v26.0");

  return {
    configured: Boolean(token),
    access_token_configured: Boolean(token),
    preferred_account_configured: preferredAccounts.length > 0,
    graph_api_version: /^v\d+\.\d+$/.test(version) ? version : "v26.0",
  };
}

export function normalizeMetaAdAccount(record = {}) {
  const metaAccountId = cleanId(record.account_id || record.id);
  const statusCode = Number(record.account_status);
  const status = statusCode === 1 ? "active" : statusCode === 2 ? "disabled" : clean(record.status || "configured").toLowerCase();

  return {
    platform: "meta",
    provider: "meta_marketing_api",
    source: "meta_live",
    meta_account_id: metaAccountId,
    account_id: metaAccountId,
    provider_account_id: `act_${metaAccountId}`,
    name: clean(record.name || record.business_name || `Meta Ad Account ${metaAccountId}`),
    business_name: clean(record.business_name),
    status,
    account_status_code: Number.isFinite(statusCode) ? statusCode : null,
    currency: clean(record.currency || "USD").toLowerCase(),
    timezone_name: clean(record.timezone_name),
    meta_synced_at: new Date().toISOString(),
  };
}

export function normalizeMetaCampaign(record = {}, account = {}) {
  const currency = clean(account.currency || "usd").toLowerCase();
  const dailyBudget = amountFromMinorUnits(record.daily_budget);
  const lifetimeBudget = amountFromMinorUnits(record.lifetime_budget);

  return {
    platform: "meta",
    provider: "meta_marketing_api",
    source: "meta_live",
    meta_campaign_id: clean(record.id),
    provider_campaign_id: clean(record.id),
    meta_account_id: cleanId(account.meta_account_id || account.account_id || account.id),
    name: clean(record.name || "Meta campaign"),
    status: clean(record.status || "unknown").toLowerCase(),
    effective_status: clean(record.effective_status || record.status || "unknown").toLowerCase(),
    objective: clean(record.objective || "").toLowerCase(),
    currency,
    daily_budget_amount: dailyBudget,
    lifetime_budget_amount: lifetimeBudget,
    daily_budget_usd: currency === "usd" ? dailyBudget : 0,
    total_budget_usd: currency === "usd" ? lifetimeBudget : 0,
    start_time: clean(record.start_time),
    stop_time: clean(record.stop_time),
    provider_updated_at: clean(record.updated_time),
    meta_synced_at: new Date().toISOString(),
    ai_publish_requires_approval: true,
  };
}

export function normalizeMetaAdSet(record = {}, account = {}) {
  const currency = clean(account.currency || "usd").toLowerCase();
  const dailyBudget = amountFromMinorUnits(record.daily_budget);
  const lifetimeBudget = amountFromMinorUnits(record.lifetime_budget);
  const countries = record?.targeting?.geo_locations?.countries;

  return {
    platform: "meta",
    provider: "meta_marketing_api",
    source: "meta_live",
    meta_ad_set_id: clean(record.id),
    provider_ad_set_id: clean(record.id),
    meta_campaign_id: clean(record.campaign_id),
    meta_account_id: cleanId(account.meta_account_id || account.account_id || account.id),
    name: clean(record.name || "Meta ad set"),
    status: clean(record.status || "unknown").toLowerCase(),
    effective_status: clean(record.effective_status || record.status || "unknown").toLowerCase(),
    currency,
    daily_budget_amount: dailyBudget,
    lifetime_budget_amount: lifetimeBudget,
    daily_budget_usd: currency === "usd" ? dailyBudget : 0,
    targeting: record.targeting && typeof record.targeting === "object" ? record.targeting : {},
    target_countries: Array.isArray(countries) ? countries.map(clean).filter(Boolean) : [],
    start_time: clean(record.start_time),
    end_time: clean(record.end_time),
    provider_updated_at: clean(record.updated_time),
    meta_synced_at: new Date().toISOString(),
  };
}

export function normalizeMetaAdCreative(record = {}, account = {}) {
  const creative = record.creative && typeof record.creative === "object" ? record.creative : {};
  const story = creative.object_story_spec && typeof creative.object_story_spec === "object"
    ? creative.object_story_spec
    : {};
  const linkData = story.link_data && typeof story.link_data === "object" ? story.link_data : {};
  const videoData = story.video_data && typeof story.video_data === "object" ? story.video_data : {};
  const asset = Object.keys(linkData).length ? linkData : videoData;

  return {
    platform: "meta",
    provider: "meta_marketing_api",
    source: "meta_live",
    meta_ad_id: clean(record.id),
    provider_ad_id: clean(record.id),
    meta_creative_id: clean(creative.id),
    meta_ad_set_id: clean(record.adset_id),
    meta_campaign_id: clean(record.campaign_id),
    meta_account_id: cleanId(account.meta_account_id || account.account_id || account.id),
    name: clean(record.name || creative.name || "Meta ad"),
    creative_name: clean(creative.name),
    status: clean(record.status || "unknown").toLowerCase(),
    effective_status: clean(record.effective_status || record.status || "unknown").toLowerCase(),
    headline: clean(creative.title || asset.name || asset.title),
    primary_text: clean(creative.body || asset.message),
    description: clean(asset.description),
    destination_url: clean(asset.link),
    image_url: clean(creative.image_url || asset.image_url || creative.thumbnail_url),
    thumbnail_url: clean(creative.thumbnail_url),
    provider_updated_at: clean(record.updated_time),
    meta_synced_at: new Date().toISOString(),
  };
}

export function normalizeMetaCampaignInsight(record = {}, account = {}) {
  const currency = clean(account.currency || "usd").toLowerCase();
  const spend = amount(record.spend);
  const messagingConversations = actionValue(record.actions, [
    "onsite_conversion.messaging_conversation_started_7d",
    "messaging_conversation_started_7d",
  ]);
  const leads = actionValue(record.actions, [
    "lead",
    "onsite_conversion.lead_grouped",
    "onsite_conversion.messaging_lead",
  ]);
  const purchases = actionValue(record.actions, ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"]);
  const revenue = actionValue(record.action_values, ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"]);

  return {
    platform: "meta",
    provider: "meta_marketing_api",
    source: "meta_live",
    meta_campaign_id: clean(record.campaign_id),
    meta_ad_id: clean(record.ad_id),
    ad_name: clean(record.ad_name),
    campaign_name: clean(record.campaign_name),
    meta_account_id: cleanId(account.meta_account_id || account.account_id || account.id),
    currency,
    spend_amount: spend,
    spend_usd: currency === "usd" ? spend : 0,
    impressions: amount(record.impressions),
    reach: amount(record.reach),
    clicks: amount(record.clicks),
    leads,
    messaging_conversations: messagingConversations,
    // A Meta-attributed purchase is not proof of a saved LMS enrollment.
    enrollments: 0,
    meta_purchases: purchases,
    revenue_amount: revenue,
    revenue_usd: currency === "usd" ? revenue : 0,
    date_start: clean(record.date_start),
    date_stop: clean(record.date_stop),
    logged_at: clean(record.date_stop) || new Date().toISOString(),
    meta_synced_at: new Date().toISOString(),
  };
}

function graphUrl(version, path) {
  return `https://${GRAPH_HOST}/${version}/${String(path || "").replace(/^\/+/, "")}`;
}

export function metaReportingDateRange(preset, timezone = "UTC", now = new Date()) {
  if (preset === "maximum") return null;
  let parts;
  try { parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now); }
  catch { throw new Error("Meta account timezone could not be resolved"); }
  const value = (type) => parts.find((part) => part.type === type).value;
  const today = `${value("year")}-${value("month")}-${value("day")}`;
  const shift = (date, days) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  if (preset === "yesterday") return { since: shift(today, -1), until: shift(today, -1) };
  if (preset === "this_month") return { since: `${today.slice(0, 7)}-01`, until: today };
  if (preset === "last_month") { const until = shift(`${today.slice(0, 7)}-01`, -1); return { since: `${until.slice(0, 7)}-01`, until }; }
  const days = { today: 1, last_7d: 7, last_14d: 14, last_30d: 30 }[preset] || 30;
  return { since: shift(today, 1 - days), until: today };
}

function validatePagingUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.hostname !== GRAPH_HOST) {
    throw new Error("Meta returned an invalid paging URL");
  }
  return parsed.toString();
}

async function graphGetAll({ axiosClient, url, token, params = {}, maxPages = 10 }) {
  const output = [];
  let next = url;
  let page = 0;
  let nextParams = { ...params, access_token: token };

  while (next && page < maxPages) {
    const response = await axiosClient.get(next, { params: nextParams, timeout: 30_000 });
    if (!Array.isArray(response?.data?.data)) throw new Error("Meta returned an incomplete reporting response");
    output.push(...response.data.data);
    const pagingNext = clean(response?.data?.paging?.next);
    next = pagingNext ? validatePagingUrl(pagingNext) : "";
    nextParams = {};
    page += 1;
  }
  if (next) throw new Error("Meta reporting pagination limit reached; previous figures retained");
  return output;
}

export async function fetchMetaAdsSnapshot({ axiosClient, env = process.env, datePreset = "last_30d" }) {
  const readiness = metaAdsReadiness(env);
  if (!readiness.configured) {
    const error = new Error("Meta Ads access is not configured");
    error.statusCode = 503;
    throw error;
  }
  if (!axiosClient?.get) throw new Error("An HTTP client is required");

  const token = clean(env.META_ADS_ACCESS_TOKEN);
  const preferredAccounts = new Set(configuredMetaAdAccountIds(env).map(cleanId));
  const version = readiness.graph_api_version;
  const accountRows = await graphGetAll({
    axiosClient,
    url: graphUrl(version, "me/adaccounts"),
    token,
    params: {
      fields: "id,account_id,name,account_status,currency,timezone_name,business_name",
      limit: 100,
    },
  });
  const accounts = accountRows
    .map(normalizeMetaAdAccount)
    .filter((account) => !preferredAccounts.size || preferredAccounts.has(account.meta_account_id));

  if (preferredAccounts.size && accounts.length !== preferredAccounts.size) {
    const error = new Error("One or more configured Meta ad accounts are not available to this access token");
    error.statusCode = 403;
    throw error;
  }

  const campaigns = [];
  const adSets = [];
  const creatives = [];
  const insights = [];
  const adInsights = [];
  const dailyInsights = [];
  const windows = [];
  for (const account of accounts) {
    const accountPath = `act_${account.meta_account_id}`;
    // Use explicit account-local dates so the live pilot includes today.
    const range = metaReportingDateRange(datePreset, account.timezone_name);
    const dates = range ? { time_range: JSON.stringify(range) } : { date_preset: datePreset };
    windows.push({ meta_account_id: account.meta_account_id, ...range });
    const [campaignRows, adSetRows, adRows, insightRows, adInsightRows, dailyInsightRows] = await Promise.all([
      graphGetAll({
        axiosClient,
        url: graphUrl(version, `${accountPath}/campaigns`),
        token,
        params: {
          fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time,updated_time",
          limit: 100,
        },
      }),
      graphGetAll({
        axiosClient,
        url: graphUrl(version, `${accountPath}/adsets`),
        token,
        params: {
          fields: "id,campaign_id,name,status,effective_status,daily_budget,lifetime_budget,targeting,start_time,end_time,updated_time",
          limit: 100,
        },
      }),
      graphGetAll({
        axiosClient,
        url: graphUrl(version, `${accountPath}/ads`),
        token,
        params: {
          fields: "id,campaign_id,adset_id,name,status,effective_status,updated_time,creative{id,name,title,body,thumbnail_url,image_url,object_story_spec}",
          limit: 100,
        },
      }),
      graphGetAll({
        axiosClient,
        url: graphUrl(version, `${accountPath}/insights`),
        token,
        params: {
          level: "campaign",
          fields: "campaign_id,campaign_name,spend,impressions,clicks,reach,actions,action_values,date_start,date_stop",
          ...dates,
          limit: 500,
        },
      }),
      graphGetAll({ axiosClient, url: graphUrl(version, `${accountPath}/insights`), token,
        params: { level: "ad", fields: "ad_id,ad_name,campaign_id,campaign_name,spend,impressions,clicks,reach,actions,action_values,date_start,date_stop", ...dates, limit: 500 } }),
      graphGetAll({ axiosClient, url: graphUrl(version, `${accountPath}/insights`), token,
        params: { level: "campaign", fields: "campaign_id,campaign_name,spend,impressions,clicks,reach,actions,action_values,date_start,date_stop", ...dates, time_increment: 1, limit: 500 } }),
    ]);
    campaigns.push(...campaignRows.map((row) => normalizeMetaCampaign(row, account)));
    adSets.push(...adSetRows.map((row) => normalizeMetaAdSet(row, account)));
    creatives.push(...adRows.map((row) => normalizeMetaAdCreative(row, account)));
    insights.push(...insightRows.map((row) => normalizeMetaCampaignInsight(row, account)));
    adInsights.push(...adInsightRows.map((row) => normalizeMetaCampaignInsight(row, account)));
    dailyInsights.push(...dailyInsightRows.map((row) => ({ ...normalizeMetaCampaignInsight(row, account), reporting_granularity: "day" })));
  }

  return {
    accounts,
    campaigns,
    ad_sets: adSets,
    creatives,
    insights,
    ad_insights: adInsights,
    daily_insights: dailyInsights,
    windows,
    date_preset: datePreset,
    synced_at: new Date().toISOString(),
  };
}
