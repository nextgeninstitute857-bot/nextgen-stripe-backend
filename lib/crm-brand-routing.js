const clean = (value = "") => String(value ?? "").trim();
const cleanId = (value = "") => clean(value).replace(/^act_/i, "");

export const NEXTGEN_BRAND_ID = "brand_nextgen_usmle";
export const AYLAMED_BRAND_ID = "brand_aylamed";
export const LEGACY_NEXTGEN_META_AD_ACCOUNT_ID = "1575781874561019";
export const AYLAMED_META_AD_ACCOUNT_ID = "1594776822351544";

function setAccountBrand(mapping, accountId, brandId, source = "configuration") {
  const id = cleanId(accountId);
  const brand = clean(brandId);
  if (!id || !brand) return;
  const existing = mapping.get(id);
  if (existing && existing !== brand) {
    throw new Error(`Meta ad account ${id} has conflicting CRM brand mappings (${existing} vs ${brand}) from ${source}`);
  }
  mapping.set(id, brand);
}

function assertKnownAccountBrands(mapping) {
  const known = new Map([
    [LEGACY_NEXTGEN_META_AD_ACCOUNT_ID, NEXTGEN_BRAND_ID],
    [AYLAMED_META_AD_ACCOUNT_ID, AYLAMED_BRAND_ID],
  ]);
  for (const [accountId, expectedBrandId] of known) {
    const actualBrandId = mapping.get(accountId);
    if (actualBrandId && actualBrandId !== expectedBrandId) {
      throw new Error(`Known Meta ad account ${accountId} must map to ${expectedBrandId}, not ${actualBrandId}`);
    }
  }
}

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
      setAccountBrand(output, accountId, brandId, "META_AD_ACCOUNT_BRAND_MAP");
    }
    return output;
  }

  for (const pair of raw.split(/[;,\n]+/).map((item) => item.trim()).filter(Boolean)) {
    const separator = pair.includes("=") ? "=" : ":";
    const index = pair.indexOf(separator);
    if (index <= 0 || !clean(pair.slice(index + 1))) {
      throw new Error("META_AD_ACCOUNT_BRAND_MAP must use account_id=brand_id pairs");
    }
    setAccountBrand(output, pair.slice(0, index), pair.slice(index + 1), "META_AD_ACCOUNT_BRAND_MAP");
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

  setAccountBrand(mapping, nextGenAccountId, NEXTGEN_BRAND_ID, "NEXTGEN_META_AD_ACCOUNT_ID");
  setAccountBrand(mapping, aylaMedAccountId, AYLAMED_BRAND_ID, "AYLAMED_META_AD_ACCOUNT_ID");
  setAccountBrand(mapping, legacyAccountId, legacyBrandId, "META_AD_ACCOUNT_ID/META_AD_ACCOUNT_BRAND_ID");

  // Backward compatibility for the currently deployed NextGen-only account.
  // Any other single account must declare its brand instead of silently becoming NextGen.
  if (legacyAccountId === LEGACY_NEXTGEN_META_AD_ACCOUNT_ID && !mapping.has(legacyAccountId)) {
    setAccountBrand(mapping, legacyAccountId, NEXTGEN_BRAND_ID, "known NextGen account");
  }
  if (
    (legacyAccountId === AYLAMED_META_AD_ACCOUNT_ID || explicitlyListedIds.has(AYLAMED_META_AD_ACCOUNT_ID))
    && !mapping.has(AYLAMED_META_AD_ACCOUNT_ID)
  ) {
    setAccountBrand(mapping, AYLAMED_META_AD_ACCOUNT_ID, AYLAMED_BRAND_ID, "known AylaMed account");
  }
  if (explicitlyListedIds.has(LEGACY_NEXTGEN_META_AD_ACCOUNT_ID) && !mapping.has(LEGACY_NEXTGEN_META_AD_ACCOUNT_ID)) {
    setAccountBrand(mapping, LEGACY_NEXTGEN_META_AD_ACCOUNT_ID, NEXTGEN_BRAND_ID, "known NextGen account");
  }
  assertKnownAccountBrands(mapping);
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

export function reconcileMetaLiveBrandRecords(db = {}, accountBrandMap = new Map()) {
  const mapping = accountBrandMap instanceof Map
    ? accountBrandMap
    : new Map(Object.entries(accountBrandMap || {}).map(([id, brand]) => [cleanId(id), clean(brand)]));
  const collections = ["ad_accounts", "ad_campaigns", "ad_sets", "ad_creatives", "ad_performance_logs"];
  const byCollection = {};
  let migrated = 0;
  for (const collection of collections) {
    let count = 0;
    for (const row of Array.isArray(db[collection]) ? db[collection] : []) {
      if (clean(row?.source).toLowerCase() !== "meta_live") continue;
      const accountId = cleanId(row?.meta_account_id || (collection === "ad_accounts" ? row?.account_id : ""));
      const expectedBrandId = mapping.get(accountId);
      if (!expectedBrandId || clean(row.brand_id) === expectedBrandId) continue;
      row.brand_reconciled_from = clean(row.brand_id) || null;
      row.brand_id = expectedBrandId;
      row.brand_reconciliation_source = "meta_account_brand_map";
      count += 1;
      migrated += 1;
    }
    byCollection[collection] = count;
  }
  // A corrected account owner must also invalidate cached totals. Otherwise a
  // previous NextGen snapshot can keep displaying AylaMed spend until NextGen
  // happens to sync again. Retain the old snapshot for audit, not live reporting.
  const invalidSnapshot = (snapshot, brandId) => snapshot && [
    ...snapshot.accounts || [], ...snapshot.campaigns || [], ...snapshot.ads || [],
  ].some((row) => {
    const owner = mapping.get(cleanId(row?.meta_account_id || row?.account_id));
    return owner && owner !== clean(brandId || snapshot.brand_id);
  });
  const archived = new Set();
  const archiveSnapshot = (snapshot, brandId) => {
    const key = `${brandId}:${snapshot.synced_at || ""}`;
    if (archived.has(key)) return;
    archived.add(key);
    if (!Array.isArray(db.meta_ads_brand_reconciliation_archive)) db.meta_ads_brand_reconciliation_archive = [];
    db.meta_ads_brand_reconciliation_archive.push({
      reason: "account_brand_mapping_corrected", brand_id: brandId, snapshot,
    });
  };
  for (const [brandId, snapshot] of Object.entries(db.meta_ads_performance_by_brand || {})) {
    if (!invalidSnapshot(snapshot, brandId)) continue;
    archiveSnapshot(snapshot, brandId);
    db.meta_ads_performance_by_brand[brandId] = null;
    if (db.meta_ads_last_sync_by_brand) db.meta_ads_last_sync_by_brand[brandId] = null;
  }
  if (invalidSnapshot(db.meta_ads_performance, db.meta_ads_performance?.brand_id)) {
    archiveSnapshot(db.meta_ads_performance, db.meta_ads_performance.brand_id);
    db.meta_ads_performance = null;
    db.meta_ads_last_sync = null;
  }
  return { migrated, by_collection: byCollection };
}

export function claimLegacyUnbrandedMetaLeads(db = {}, { syncedAt = "" } = {}) {
  const creatives = (Array.isArray(db.ad_creatives) ? db.ad_creatives : [])
    .filter((row) => clean(row?.source).toLowerCase() === "meta_live" && clean(row?.brand_id));
  const campaigns = Array.isArray(db.ad_campaigns) ? db.ad_campaigns : [];
  let claimed = 0;
  let skippedAmbiguous = 0;

  for (const lead of Array.isArray(db.leads) ? db.leads : []) {
    if (lead?.brand_routing_review_required === true) continue;
    const metaAdId = clean(lead?.meta_ad_id);
    if (!metaAdId) continue;
    const matches = creatives.filter((row) => clean(row.meta_ad_id || row.provider_ad_id) === metaAdId);
    const brands = [...new Set(matches.map((row) => clean(row.brand_id)).filter(Boolean))];
    if (lead.brand_id) {
      if (!brands.includes(clean(lead.brand_id))) continue;
    } else if (brands.length === 1) {
      lead.brand_id = brands[0];
      lead.brand_resolution_source = "unique_meta_ad_creative_upgrade";
      lead.brand_routing_review_required = false;
      claimed += 1;
    } else {
      if (brands.length > 1) skippedAmbiguous += 1;
      continue;
    }

    const creative = matches.find((row) => clean(row.brand_id) === clean(lead.brand_id));
    if (!creative) continue;
    const campaign = campaigns.find((row) => clean(row.brand_id) === clean(lead.brand_id) && (
      clean(row.id) === clean(creative.ad_campaign_id || creative.campaign_id)
      || clean(row.meta_campaign_id || row.provider_campaign_id) === clean(creative.meta_campaign_id)
    ));
    lead.meta_ad_name = creative.name || creative.ad_name || lead.meta_ad_name || "";
    lead.meta_campaign_id = campaign?.meta_campaign_id || creative.meta_campaign_id || lead.meta_campaign_id || null;
    lead.campaign_id = campaign?.id || creative.ad_campaign_id || creative.campaign_id || lead.campaign_id || null;
    lead.campaign_name = campaign?.name || campaign?.campaign_name || lead.campaign_name || "";
    lead.meta_attribution_synced_at = syncedAt || lead.meta_attribution_synced_at || null;
    lead.updated_at = syncedAt || lead.updated_at || null;
  }
  return { claimed, skipped_ambiguous: skippedAmbiguous };
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
  if (normalizePlatform(integration.platform) !== "whatsapp") return false;
  return integration.shared === true
    || integration.shared_number === true
    || integration.shared_number_test === true
    || integrationBrandIds(integration).length > 1;
}

export function integrationSupportsBrand(integration = {}, brandId = "") {
  const requestedBrandId = clean(brandId);
  if (!requestedBrandId) return false;
  const ownerBrandId = clean(integration.brand_id);
  if (ownerBrandId === requestedBrandId) return true;
  if (!ownerBrandId && requestedBrandId === NEXTGEN_BRAND_ID) return true;
  return integrationIsShared(integration) && integrationBrandIds(integration).includes(requestedBrandId);
}

export function providerEnvFallbackAllowed(integration = null, brandId = "") {
  const effectiveBrandId = clean(brandId || integration?.brand_id);
  return !effectiveBrandId
    || effectiveBrandId === NEXTGEN_BRAND_ID
    || integrationIsShared(integration || {});
}

export function inboundBrandRequiresManualReview(reason = "") {
  return [
    "cross_brand_identity_ambiguous",
    "shared_integration_ambiguous",
    "missing_recipient_asset",
    "unknown_recipient_asset",
    "ambiguous_recipient_asset",
    "conflicting_recipient_assets",
    "legacy_global_asset_conflict",
    "explicit_integration_not_found",
    "explicit_integration_platform_mismatch",
    "explicit_integration_asset_mismatch",
  ].includes(clean(reason));
}

export function aylaOutboundContentSafety({ brandId = "", text = "", subject = "", template = null, providerTemplateName = "" } = {}) {
  if (clean(brandId) !== AYLAMED_BRAND_ID) return { safe: true, reason: "not_aylamed" };
  if (template && clean(template.brand_id) !== AYLAMED_BRAND_ID) {
    return { safe: false, reason: "aylamed_template_brand_mismatch" };
  }
  if (clean(providerTemplateName) && (!template || clean(template.brand_id) !== AYLAMED_BRAND_ID)) {
    return { safe: false, reason: "aylamed_provider_template_not_brand_scoped" };
  }
  const combined = [text, subject, providerTemplateName, template?.body, template?.message, template?.name, template?.key]
    .map(clean)
    .filter(Boolean)
    .join("\n");
  if (/next\s*gen|nextgenusmle\.live|\busmle\b|\buworld\b|dr\.?\s*ahmad/i.test(combined)) {
    return { safe: false, reason: "aylamed_outbound_contains_nextgen_copy" };
  }
  return { safe: true, reason: "aylamed_content_safe" };
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

export function resolveInboundIntegrationSelection({
  integrations = [],
  platform = "",
  identity = {},
  explicitIntegration = null,
  explicitIntegrationId = "",
  legacyPhoneNumberId = "",
  legacyAccountId = "",
  legacyPhoneNumberIds = [],
  legacyAccountIds = [],
  requireRecipientAsset = true,
} = {}) {
  const cleanPlatform = normalizePlatform(platform);
  const all = Array.isArray(integrations) ? integrations : [];
  const requestedId = clean(explicitIntegrationId || explicitIntegration?.id);
  const target = requestedId ? all.find((item) => clean(item?.id) === requestedId) : null;
  const phoneNumberId = cleanId(identity.phone_number_id);
  const accountId = cleanId(identity.account_id);
  const payloadAssetId = phoneNumberId || accountId;
  const legacyAssetIds = new Set([
    ...(phoneNumberId ? list(legacyPhoneNumberIds) : list(legacyAccountIds)),
    phoneNumberId ? legacyPhoneNumberId : legacyAccountId,
  ].map(cleanId).filter(Boolean));

  if (identity.asset_conflict === true) {
    return { integration: null, quarantine: true, reason: "conflicting_recipient_assets" };
  }

  if (requestedId) {
    if (!target) return { integration: null, quarantine: true, reason: "explicit_integration_not_found" };
    if (normalizePlatform(target.platform) !== cleanPlatform) {
      return { integration: null, quarantine: true, reason: "explicit_integration_platform_mismatch" };
    }
    if (requireRecipientAsset && ["whatsapp", "facebook", "instagram"].includes(cleanPlatform) && !payloadAssetId) {
      return { integration: null, quarantine: true, reason: "missing_recipient_asset" };
    }
    if (payloadAssetId) {
      const targetAssets = phoneNumberId ? integrationPhoneNumberIds(target) : integrationAccountIds(target);
      if (!targetAssets.includes(payloadAssetId)) {
        return { integration: null, quarantine: true, reason: "explicit_integration_asset_mismatch" };
      }
    }
    return { integration: target, quarantine: false, reason: "explicit_integration_match" };
  }

  if (payloadAssetId) {
    const platformIntegrations = all.filter((item) => normalizePlatform(item?.platform) === cleanPlatform);
    const exactMatches = platformIntegrations.filter((item) => (
      phoneNumberId ? integrationPhoneNumberIds(item) : integrationAccountIds(item)
    ).includes(payloadAssetId));
    if (exactMatches.length === 1) {
      const exact = exactMatches[0];
      if (
        legacyAssetIds.has(payloadAssetId)
        && clean(exact.brand_id) !== NEXTGEN_BRAND_ID
        && !(integrationIsShared(exact) && integrationBrandIds(exact).includes(NEXTGEN_BRAND_ID))
      ) {
        return { integration: null, quarantine: true, reason: "legacy_global_asset_conflict" };
      }
      return { integration: exact, quarantine: false, reason: "configured_recipient_asset" };
    }
    if (exactMatches.length > 1) return { integration: null, quarantine: true, reason: "ambiguous_recipient_asset" };
    if (legacyAssetIds.has(payloadAssetId)) {
      const legacyCandidates = platformIntegrations.filter((item) => (
        clean(item.brand_id) === NEXTGEN_BRAND_ID
        || (!clean(item.brand_id) && !integrationBrandIds(item).length)
        || (integrationIsShared(item) && integrationBrandIds(item).includes(NEXTGEN_BRAND_ID))
      ));
      if (legacyCandidates.length > 1) {
        return { integration: null, quarantine: true, reason: "ambiguous_recipient_asset" };
      }
      return {
        integration: legacyCandidates[0] || null,
        quarantine: false,
        reason: "configured_legacy_global_asset",
        forced_brand_id: NEXTGEN_BRAND_ID,
      };
    }
    return { integration: null, quarantine: true, reason: "unknown_recipient_asset" };
  }

  if (requireRecipientAsset && ["whatsapp", "facebook", "instagram"].includes(cleanPlatform)) {
    return { integration: null, quarantine: true, reason: "missing_recipient_asset" };
  }
  return {
    integration: selectBrandIntegration(all, cleanPlatform),
    quarantine: false,
    reason: "platform_fallback_without_asset",
  };
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
    const shared = candidates.find((item) => integrationIsShared(item) && integrationBrandIds(item).includes(brandId));
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
    const phoneIds = [...new Set([
      value?.metadata?.phone_number_id,
      payload?.phone_number_id,
    ].map(cleanId).filter(Boolean))];
    return {
      phone_number_id: phoneIds[0] || "",
      display_phone_number: clean(value?.metadata?.display_phone_number || payload?.display_phone_number),
      ...(phoneIds.length > 1 ? { asset_conflict: true } : {}),
    };
  }
  if (cleanPlatform === "facebook" || cleanPlatform === "instagram") {
    const entry = payload?.entry?.[0] || {};
    const messaging = entry?.messaging?.[0] || {};
    const value = entry?.changes?.[0]?.value || {};
    const accountIds = [...new Set([
      messaging?.recipient?.id,
      value?.recipient?.id,
      entry?.id,
      payload?.recipient_id,
    ].map(cleanId).filter(Boolean))];
    return {
      account_id: accountIds[0] || "",
      ...(accountIds.length > 1 ? { asset_conflict: true } : {}),
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
