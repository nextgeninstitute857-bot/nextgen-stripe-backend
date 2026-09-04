const clean = (value = "") => String(value ?? "").trim();
const cleanId = (value = "") => clean(value).replace(/^act_/i, "");

export const NEXTGEN_BRAND_ID = "brand_nextgen_usmle";
export const AYLAMED_BRAND_ID = "brand_aylamed";
export const LEGACY_NEXTGEN_META_AD_ACCOUNT_ID = "1575781874561019";
export const AYLAMED_META_AD_ACCOUNT_ID = "1594776822351544";

function parseDelimitedMap(value = "") {
  const output = new Map();
  const raw = clean(value);
  if (!raw) return output;

  if (raw.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("META_AD_ACCOUNT_BRAND_MAP must be valid JSON or account_id=brand_id pairs");
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("META_AD_ACCOUNT_BRAND_MAP must be an object keyed by Meta ad account ID");
    }
    for (const [accountId, brandId] of Object.entries(parsed)) {
      if (cleanId(accountId) && clean(brandId)) output.set(cleanId(accountId), clean(brandId));
    }
    return output;
  }

  for (const pair of raw.split(/[;,\n]+/).map((item) => item.trim()).filter(Boolean)) {
    const separator = pair.includes("=") ? "=" : ":";
    const index = pair.indexOf(separator);
    if (index <= 0 || !clean(pair.slice(index + 1))) {
      throw new Error("META_AD_ACCOUNT_BRAND_MAP must use account_id=brand_id pairs");
    }
    output.set(cleanId(pair.slice(0, index)), clean(pair.slice(index + 1)));
  }
  return output;
}

export function configuredMetaAdAccountBrandMap(env = process.env) {
  const mapping = parseDelimitedMap(env.META_AD_ACCOUNT_BRAND_MAP);
  const nextGenAccountId = cleanId(env.NEXTGEN_META_AD_ACCOUNT_ID);
  const aylaMedAccountId = cleanId(env.AYLAMED_META_AD_ACCOUNT_ID);
  const legacyAccountId = cleanId(env.META_AD_ACCOUNT_ID);
  const legacyBrandId = clean(env.META_AD_ACCOUNT_BRAND_ID);
  const explicitlyListedIds = new Set(
    clean(env.META_AD_ACCOUNT_IDS).split(/[;,\s]+/).map(cleanId).filter(Boolean),
  );

  if (nextGenAccountId) mapping.set(nextGenAccountId, NEXTGEN_BRAND_ID);
  if (aylaMedAccountId) mapping.set(aylaMedAccountId, AYLAMED_BRAND_ID);
  if (legacyAccountId && legacyBrandId) mapping.set(legacyAccountId, legacyBrandId);

  // Backward compatibility for the currently deployed NextGen-only account.
  // Any other single account must declare its brand instead of silently becoming NextGen.
  if (legacyAccountId === LEGACY_NEXTGEN_META_AD_ACCOUNT_ID && !mapping.has(legacyAccountId)) {
    mapping.set(legacyAccountId, NEXTGEN_BRAND_ID);
  }
  if (
    (legacyAccountId === AYLAMED_META_AD_ACCOUNT_ID || explicitlyListedIds.has(AYLAMED_META_AD_ACCOUNT_ID))
    && !mapping.has(AYLAMED_META_AD_ACCOUNT_ID)
  ) {
    mapping.set(AYLAMED_META_AD_ACCOUNT_ID, AYLAMED_BRAND_ID);
  }
  if (explicitlyListedIds.has(LEGACY_NEXTGEN_META_AD_ACCOUNT_ID) && !mapping.has(LEGACY_NEXTGEN_META_AD_ACCOUNT_ID)) {
    mapping.set(LEGACY_NEXTGEN_META_AD_ACCOUNT_ID, NEXTGEN_BRAND_ID);
  }
  return mapping;
}

export function configuredMetaAdAccountIds(env = process.env) {
  const ids = new Set();
  for (const value of clean(env.META_AD_ACCOUNT_IDS).split(/[;,\s]+/)) {
    if (cleanId(value)) ids.add(cleanId(value));
  }
  for (const value of [env.META_AD_ACCOUNT_ID, env.NEXTGEN_META_AD_ACCOUNT_ID, env.AYLAMED_META_AD_ACCOUNT_ID]) {
    if (cleanId(value)) ids.add(cleanId(value));
  }
  for (const accountId of configuredMetaAdAccountBrandMap(env).keys()) ids.add(accountId);
  return [...ids];
}

function snapshotRowsForAccountIds(rows, accountIds) {
  const allowed = new Set(accountIds.map(cleanId));
  return (Array.isArray(rows) ? rows : []).filter((row) => allowed.has(cleanId(row?.meta_account_id || row?.account_id)));
}

export function partitionMetaAdsSnapshotByBrand(snapshot = {}, env = process.env) {
  const mapping = configuredMetaAdAccountBrandMap(env);
  const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  const grouped = new Map();

  for (const account of accounts) {
    const accountId = cleanId(account?.meta_account_id || account?.account_id || account?.id);
    const brandId = mapping.get(accountId);
    if (!accountId || !brandId) {
      const error = new Error(`Meta ad account ${accountId || "(missing ID)"} has no configured CRM brand mapping`);
      error.statusCode = 503;
      throw error;
    }
    if (!grouped.has(brandId)) grouped.set(brandId, []);
    grouped.get(brandId).push(accountId);
  }

  return [...grouped.entries()].map(([brandId, accountIds]) => ({
    brand_id: brandId,
    snapshot: {
      ...snapshot,
      accounts: snapshotRowsForAccountIds(snapshot.accounts, accountIds),
      campaigns: snapshotRowsForAccountIds(snapshot.campaigns, accountIds),
      ad_sets: snapshotRowsForAccountIds(snapshot.ad_sets, accountIds),
      creatives: snapshotRowsForAccountIds(snapshot.creatives, accountIds),
      insights: snapshotRowsForAccountIds(snapshot.insights, accountIds),
      ad_insights: snapshotRowsForAccountIds(snapshot.ad_insights, accountIds),
      daily_insights: snapshotRowsForAccountIds(snapshot.daily_insights, accountIds),
      windows: snapshotRowsForAccountIds(snapshot.windows, accountIds),
    },
  }));
}

function normalizePlatform(value = "") {
  const platform = clean(value).toLowerCase();
  return platform === "x" ? "twitter" : platform;
}

function list(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value).split(/[;,\s]+/).map(clean).filter(Boolean);
}

export function integrationBrandIds(integration = {}) {
  return [...new Set([
    clean(integration.brand_id),
    ...list(integration.shared_brand_ids || integration.shared_brands || integration.brand_ids),
  ].filter(Boolean))];
}

export function integrationIsShared(integration = {}) {
  return integration.shared === true
    || integration.shared_number === true
    || integration.shared_number_test === true
    || integrationBrandIds(integration).length > 1;
}

export function providerEnvFallbackAllowed(integration = null, brandId = "") {
  const effectiveBrandId = clean(brandId || integration?.brand_id);
  return !effectiveBrandId
    || effectiveBrandId === NEXTGEN_BRAND_ID
    || integrationIsShared(integration || {});
}

export function inboundBrandRequiresManualReview(reason = "") {
  return ["cross_brand_identity_ambiguous", "shared_integration_ambiguous"].includes(clean(reason));
}

function integrationAccountIds(integration = {}) {
  return [
    integration.account_id,
    integration.page_id,
    integration.facebook_page_id,
    integration.instagram_business_account_id,
    integration.credentials?.account_id,
    integration.credentials?.page_id,
  ].map(cleanId).filter(Boolean);
}

function integrationPhoneNumberIds(integration = {}) {
  return [
    integration.phone_number_id,
    integration.credentials?.phone_number_id,
    integration.account_id,
    integration.credentials?.account_id,
  ].map(cleanId).filter(Boolean);
}

export function selectBrandIntegration(integrations = [], platform = "", selectors = {}) {
  const cleanPlatform = normalizePlatform(platform);
  let candidates = (Array.isArray(integrations) ? integrations : [])
    .filter((item) => normalizePlatform(item?.platform) === cleanPlatform);
  if (!candidates.length) return null;

  const integrationId = clean(selectors.integrationId || selectors.integration_id);
  if (integrationId) {
    return candidates.find((item) => clean(item.id) === integrationId) || null;
  }

  const phoneNumberId = cleanId(selectors.phoneNumberId || selectors.phone_number_id);
  const accountId = cleanId(selectors.accountId || selectors.account_id);
  if (phoneNumberId) {
    candidates = candidates.filter((item) => integrationPhoneNumberIds(item).includes(phoneNumberId));
    if (!candidates.length) return null;
  } else if (accountId) {
    candidates = candidates.filter((item) => integrationAccountIds(item).includes(accountId));
    if (!candidates.length) return null;
  }

  const brandId = clean(selectors.brandId || selectors.brand_id);
  if (brandId) {
    const exact = candidates.find((item) => clean(item.brand_id) === brandId);
    if (exact) return exact;
    const shared = candidates.find((item) => integrationBrandIds(item).includes(brandId));
    if (shared) return shared;
    if (selectors.allowUnbranded === true) {
      const unbranded = candidates.find((item) => !clean(item.brand_id));
      if (unbranded) return unbranded;
    }
    return selectors.allowPlatformFallback === true ? candidates[0] : null;
  }

  return candidates[0] || null;
}

export function extractInboundIntegrationIdentity(platform = "", payload = {}) {
  const cleanPlatform = normalizePlatform(platform);
  if (cleanPlatform === "whatsapp") {
    const value = payload?.entry?.[0]?.changes?.[0]?.value || payload?.value || payload || {};
    return {
      phone_number_id: cleanId(value?.metadata?.phone_number_id || payload?.phone_number_id),
      display_phone_number: clean(value?.metadata?.display_phone_number || payload?.display_phone_number),
    };
  }
  if (cleanPlatform === "facebook" || cleanPlatform === "instagram") {
    const entry = payload?.entry?.[0] || {};
    const messaging = entry?.messaging?.[0] || {};
    const value = entry?.changes?.[0]?.value || {};
    return {
      account_id: cleanId(
        messaging?.recipient?.id
        || value?.recipient?.id
        || entry?.id
        || payload?.recipient_id,
      ),
    };
  }
  return {};
}

function brandForExamTrack(examTrack = "") {
  const track = clean(examTrack).toLowerCase();
  if (track === "mccqe") return AYLAMED_BRAND_ID;
  if (track.startsWith("usmle_")) return NEXTGEN_BRAND_ID;
  return "";
}

export function resolveInboundBrandContext({
  platform = "",
  integration = null,
  targetedIntegration = null,
  creativeBrandId = "",
  examTrack = "",
  defaultBrandId = "",
} = {}) {
  const target = targetedIntegration || integration;
  if (target && !integrationIsShared(target) && clean(target.brand_id)) {
    return { brand_id: clean(target.brand_id), reason: `${normalizePlatform(platform) || "social"}_integration` };
  }

  if (clean(creativeBrandId)) return { brand_id: clean(creativeBrandId), reason: "meta_ad_creative" };

  const examBrandId = brandForExamTrack(examTrack);
  if (examBrandId) return { brand_id: examBrandId, reason: "exam_intent" };

  const targetDefault = clean(target?.default_inbound_brand_id);
  if (targetDefault) return { brand_id: targetDefault, reason: "integration_inbound_default" };

  if (target && integrationIsShared(target)) {
    return { brand_id: "", reason: "shared_integration_ambiguous" };
  }
  return { brand_id: clean(defaultBrandId), reason: clean(defaultBrandId) ? "crm_default" : "unassigned" };
}

function newestFirst(left = {}, right = {}) {
  const timestamp = (row) => Date.parse(row.last_inbound_at || row.last_message_at || row.updated_at || row.created_at || "") || 0;
  return timestamp(right) - timestamp(left);
}

export function chooseBrandSafeIdentityMatch(matches = [], brandId = "") {
  const rows = (Array.isArray(matches) ? [...matches] : []).sort(newestFirst);
  const requestedBrandId = clean(brandId);
  if (requestedBrandId) {
    const branded = rows.filter((row) => clean(row.brand_id) === requestedBrandId);
    if (branded.length) return branded[0];
    const unbranded = rows.filter((row) => !clean(row.brand_id));
    return unbranded.length === 1 ? unbranded[0] : null;
  }
  if (rows.length === 1) return rows[0];
  const brands = new Set(rows.map((row) => clean(row.brand_id)).filter(Boolean));
  if (brands.size <= 1) return rows[0] || null;
  const unbranded = rows.filter((row) => !clean(row.brand_id));
  return unbranded[0] || null;
}
