import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  AYLAMED_BRAND_ID,
  AYLAMED_META_AD_ACCOUNT_ID,
  NEXTGEN_BRAND_ID,
  aylaOutboundContentSafety,
  claimLegacyUnbrandedMetaLeads,
  chooseBrandSafeIdentityMatch,
  configuredMetaAdAccountBrandMap,
  configuredMetaAdAccountIds,
  extractInboundIntegrationIdentity,
  inboundBrandRequiresManualReview,
  integrationIsShared,
  integrationSupportsBrand,
  partitionMetaAdsSnapshotByBrand,
  providerEnvFallbackAllowed,
  reconcileMetaLiveBrandRecords,
  resolveInboundBrandContext,
  resolveInboundIntegrationSelection,
  selectBrandIntegration,
} from "../lib/crm-brand-routing.js";

const NEXTGEN_ACCOUNT_ID = "1575781874561019";

test("configured Meta account IDs resolve to distinct CRM brands", () => {
  const env = {
    META_AD_ACCOUNT_IDS: `${NEXTGEN_ACCOUNT_ID},act_${AYLAMED_META_AD_ACCOUNT_ID}`,
  };
  const mapping = configuredMetaAdAccountBrandMap(env);

  assert.equal(mapping.get(NEXTGEN_ACCOUNT_ID), NEXTGEN_BRAND_ID);
  assert.equal(mapping.get(AYLAMED_META_AD_ACCOUNT_ID), AYLAMED_BRAND_ID);
  assert.deepEqual(configuredMetaAdAccountIds(env), [NEXTGEN_ACCOUNT_ID, AYLAMED_META_AD_ACCOUNT_ID]);
});

test("mixed Meta snapshots are partitioned without relabelling either brand", () => {
  const rows = (prefix) => [
    { [`meta_${prefix}_id`]: `ng-${prefix}`, meta_account_id: NEXTGEN_ACCOUNT_ID },
    { [`meta_${prefix}_id`]: `ayla-${prefix}`, meta_account_id: AYLAMED_META_AD_ACCOUNT_ID },
  ];
  const snapshot = {
    accounts: [
      { meta_account_id: NEXTGEN_ACCOUNT_ID },
      { meta_account_id: AYLAMED_META_AD_ACCOUNT_ID },
    ],
    campaigns: rows("campaign"),
    ad_sets: rows("ad_set"),
    creatives: rows("ad"),
    insights: rows("campaign"),
    ad_insights: rows("ad"),
    daily_insights: rows("campaign"),
    windows: [
      { meta_account_id: NEXTGEN_ACCOUNT_ID, since: "2026-09-01", until: "2026-09-04" },
      { meta_account_id: AYLAMED_META_AD_ACCOUNT_ID, since: "2026-09-01", until: "2026-09-04" },
    ],
    synced_at: "2026-09-04T00:00:00.000Z",
  };
  const groups = partitionMetaAdsSnapshotByBrand(snapshot, {
    META_AD_ACCOUNT_IDS: `${NEXTGEN_ACCOUNT_ID},${AYLAMED_META_AD_ACCOUNT_ID}`,
  });

  assert.equal(groups.length, 2);
  const nextgen = groups.find((group) => group.brand_id === NEXTGEN_BRAND_ID);
  const ayla = groups.find((group) => group.brand_id === AYLAMED_BRAND_ID);
  assert.deepEqual(nextgen.snapshot.accounts.map((row) => row.meta_account_id), [NEXTGEN_ACCOUNT_ID]);
  assert.deepEqual(ayla.snapshot.accounts.map((row) => row.meta_account_id), [AYLAMED_META_AD_ACCOUNT_ID]);
  assert.equal(nextgen.snapshot.creatives[0].meta_ad_id, "ng-ad");
  assert.equal(ayla.snapshot.creatives[0].meta_ad_id, "ayla-ad");
});

test("an unknown Meta account fails closed instead of becoming NextGen", () => {
  assert.throws(
    () => partitionMetaAdsSnapshotByBrand({ accounts: [{ meta_account_id: "999" }] }, {
      META_AD_ACCOUNT_IDS: "999",
    }),
    /no configured CRM brand mapping/,
  );
});

test("conflicting or swapped Meta account mappings fail closed", () => {
  assert.throws(() => configuredMetaAdAccountBrandMap({
    META_AD_ACCOUNT_BRAND_MAP: `${AYLAMED_META_AD_ACCOUNT_ID}=${NEXTGEN_BRAND_ID}`,
  }), /must map to brand_aylamed/);
  assert.throws(() => configuredMetaAdAccountBrandMap({
    NEXTGEN_META_AD_ACCOUNT_ID: "999",
    META_AD_ACCOUNT_BRAND_MAP: "999=brand_aylamed",
  }), /conflicting CRM brand mappings/);
  assert.throws(() => configuredMetaAdAccountBrandMap({
    META_AD_ACCOUNT_BRAND_MAP: "999=brand_aylamed,999=brand_nextgen_usmle",
  }), /conflicting CRM brand mappings/);
  assert.throws(() => configuredMetaAdAccountBrandMap({
    NEXTGEN_META_AD_ACCOUNT_ID: AYLAMED_META_AD_ACCOUNT_ID,
  }), /must map to brand_aylamed/);
});

test("stale wrong-brand meta_live rows migrate by authoritative account mapping", () => {
  const stale = (id) => ({ id, source: "meta_live", meta_account_id: AYLAMED_META_AD_ACCOUNT_ID, brand_id: NEXTGEN_BRAND_ID });
  const db = {
    ad_accounts: [{ ...stale("account"), account_id: AYLAMED_META_AD_ACCOUNT_ID }],
    ad_campaigns: [stale("campaign")],
    ad_sets: [stale("adset")],
    ad_creatives: [stale("creative")],
    ad_performance_logs: [stale("performance"), { ...stale("manual"), source: "manual" }],
  };
  const result = reconcileMetaLiveBrandRecords(db, new Map([[AYLAMED_META_AD_ACCOUNT_ID, AYLAMED_BRAND_ID]]));
  assert.equal(result.migrated, 5);
  for (const collection of ["ad_accounts", "ad_campaigns", "ad_sets", "ad_creatives"]) {
    assert.equal(db[collection][0].brand_id, AYLAMED_BRAND_ID);
    assert.equal(db[collection][0].brand_reconciled_from, NEXTGEN_BRAND_ID);
  }
  assert.equal(db.ad_performance_logs[0].brand_id, AYLAMED_BRAND_ID);
  assert.equal(db.ad_performance_logs[1].brand_id, NEXTGEN_BRAND_ID, "manual rows are never migrated");
});

test("legacy unbranded leads are claimed only by one unique live creative brand", () => {
  const db = {
    ad_creatives: [
      { id: "ayla-ad", source: "meta_live", brand_id: AYLAMED_BRAND_ID, meta_ad_id: "unique", name: "Ayla ad", meta_campaign_id: "ayla-c" },
      { id: "ayla-shared", source: "meta_live", brand_id: AYLAMED_BRAND_ID, meta_ad_id: "ambiguous" },
      { id: "ng-shared", source: "meta_live", brand_id: NEXTGEN_BRAND_ID, meta_ad_id: "ambiguous" },
    ],
    ad_campaigns: [{ id: "ayla-c", source: "meta_live", brand_id: AYLAMED_BRAND_ID, meta_campaign_id: "ayla-c", name: "MCCQE" }],
    leads: [
      { id: "legacy", meta_ad_id: "unique" },
      { id: "explicit-other", brand_id: NEXTGEN_BRAND_ID, meta_ad_id: "unique" },
      { id: "ambiguous", meta_ad_id: "ambiguous" },
      { id: "quarantine", meta_ad_id: "unique", brand_routing_review_required: true },
    ],
  };
  const result = claimLegacyUnbrandedMetaLeads(db, { syncedAt: "2026-09-04T00:00:00Z" });
  assert.equal(result.claimed, 1);
  assert.equal(db.leads[0].brand_id, AYLAMED_BRAND_ID);
  assert.equal(db.leads[0].campaign_name, "MCCQE");
  assert.equal(db.leads[1].brand_id, NEXTGEN_BRAND_ID, "an explicit different brand is never rewritten");
  assert.equal(db.leads[2].brand_id, undefined);
  assert.equal(db.leads[3].brand_id, undefined, "routing quarantine survives later Meta syncs");
});

test("corrected account ownership archives wrong-brand cached totals until a fresh sync", () => {
  const old = { brand_id: NEXTGEN_BRAND_ID, synced_at: "2026-09-03T00:00:00Z", accounts: [{ meta_account_id: AYLAMED_META_AD_ACCOUNT_ID }] };
  const db = { meta_ads_performance: old, meta_ads_performance_by_brand: { [NEXTGEN_BRAND_ID]: old }, meta_ads_last_sync: { status: "success" }, meta_ads_last_sync_by_brand: { [NEXTGEN_BRAND_ID]: { status: "success" } } };
  const mapping = new Map([[AYLAMED_META_AD_ACCOUNT_ID, AYLAMED_BRAND_ID]]);
  reconcileMetaLiveBrandRecords(db, mapping);
  assert.equal(db.meta_ads_performance, null);
  assert.equal(db.meta_ads_performance_by_brand[NEXTGEN_BRAND_ID], null);
  assert.equal(db.meta_ads_last_sync, null);
  assert.equal(db.meta_ads_last_sync_by_brand[NEXTGEN_BRAND_ID], null);
  assert.equal(db.meta_ads_brand_reconciliation_archive.length, 1);
  assert.deepEqual(db.meta_ads_brand_reconciliation_archive[0].snapshot, old);
  reconcileMetaLiveBrandRecords(db, mapping);
  assert.equal(db.meta_ads_brand_reconciliation_archive.length, 1);
});

test("Facebook Page and WhatsApp integrations can coexist per brand and provider asset", () => {
  const integrations = [
    { id: "fb-nextgen", platform: "facebook", brand_id: NEXTGEN_BRAND_ID, account_id: "111" },
    { id: "fb-ayla", platform: "facebook", brand_id: AYLAMED_BRAND_ID, account_id: "1330926136765528" },
    { id: "wa-shared", platform: "whatsapp", brand_id: NEXTGEN_BRAND_ID, phone_number_id: "pn-ca", shared_brand_ids: [NEXTGEN_BRAND_ID, AYLAMED_BRAND_ID] },
  ];

  assert.equal(selectBrandIntegration(integrations, "facebook", { brandId: AYLAMED_BRAND_ID }).id, "fb-ayla");
  assert.equal(selectBrandIntegration(integrations, "facebook", { accountId: "1330926136765528" }).id, "fb-ayla");
  assert.equal(selectBrandIntegration(integrations, "whatsapp", { brandId: AYLAMED_BRAND_ID }).id, "wa-shared");
  assert.equal(selectBrandIntegration(integrations, "facebook", { brandId: "brand_unknown" }), null);
});

test("recipient asset IDs are extracted from Meta webhook envelopes", () => {
  assert.deepEqual(extractInboundIntegrationIdentity("whatsapp", {
    entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn-ca", display_phone_number: "+1 825-425-5646" } } }] }],
  }), { phone_number_id: "pn-ca", display_phone_number: "+1 825-425-5646" });
  assert.deepEqual(extractInboundIntegrationIdentity("facebook", {
    entry: [{ id: "1330926136765528", messaging: [{ recipient: { id: "1330926136765528" } }] }],
  }), { account_id: "1330926136765528" });
  assert.equal(extractInboundIntegrationIdentity("facebook", {
    entry: [{ id: "page-a", messaging: [{ recipient: { id: "page-b" } }] }],
  }).asset_conflict, true);
});

test("inbound Meta assets resolve exactly or quarantine without a NextGen fallback", () => {
  const integrations = [
    { id: "ng-wa", platform: "whatsapp", brand_id: NEXTGEN_BRAND_ID, phone_number_id: "pn-ng" },
    { id: "ayla-fb", platform: "facebook", brand_id: AYLAMED_BRAND_ID, account_id: "page-ayla" },
  ];
  assert.equal(resolveInboundIntegrationSelection({ integrations, platform: "whatsapp", identity: { phone_number_id: "pn-ng" } }).integration.id, "ng-wa");
  assert.deepEqual(resolveInboundIntegrationSelection({ integrations, platform: "whatsapp", identity: { phone_number_id: "unknown" } }), {
    integration: null, quarantine: true, reason: "unknown_recipient_asset",
  });
  assert.equal(resolveInboundIntegrationSelection({ integrations, platform: "facebook", identity: {} }).reason, "missing_recipient_asset");
  assert.equal(resolveInboundIntegrationSelection({
    integrations,
    platform: "facebook",
    identity: { account_id: "page-ayla" },
    explicitIntegrationId: "ng-wa",
  }).reason, "explicit_integration_platform_mismatch");
  assert.equal(resolveInboundIntegrationSelection({
    integrations,
    platform: "facebook",
    identity: { account_id: "different-page" },
    explicitIntegrationId: "ayla-fb",
  }).reason, "explicit_integration_asset_mismatch");
  assert.equal(resolveInboundIntegrationSelection({
    integrations,
    platform: "facebook",
    identity: {},
    explicitIntegrationId: "ayla-fb",
  }).reason, "missing_recipient_asset");
  assert.equal(resolveInboundIntegrationSelection({
    integrations,
    platform: "facebook",
    identity: {},
    explicitIntegrationId: "ayla-fb",
    requireRecipientAsset: false,
  }).integration.id, "ayla-fb", "authenticated manual capture may use its selected integration");
});

test("legacy and conflicting inbound asset configuration stays fail closed", () => {
  const legacy = resolveInboundIntegrationSelection({
    integrations: [],
    platform: "facebook",
    identity: { account_id: "legacy-page" },
    legacyAccountIds: ["legacy-page"],
  });
  assert.equal(legacy.forced_brand_id, NEXTGEN_BRAND_ID);
  assert.equal(legacy.quarantine, false);

  const dedicatedConflict = resolveInboundIntegrationSelection({
    integrations: [{ id: "ayla", platform: "facebook", brand_id: AYLAMED_BRAND_ID, account_id: "legacy-page" }],
    platform: "facebook",
    identity: { account_id: "legacy-page" },
    legacyAccountIds: ["legacy-page"],
  });
  assert.equal(dedicatedConflict.reason, "legacy_global_asset_conflict");
  assert.equal(dedicatedConflict.quarantine, true);

  const duplicate = resolveInboundIntegrationSelection({
    integrations: [
      { id: "one", platform: "whatsapp", brand_id: NEXTGEN_BRAND_ID, phone_number_id: "same" },
      { id: "two", platform: "whatsapp", brand_id: NEXTGEN_BRAND_ID, phone_number_id: "same" },
    ],
    platform: "whatsapp",
    identity: { phone_number_id: "same" },
  });
  assert.equal(duplicate.reason, "ambiguous_recipient_asset");
  assert.equal(resolveInboundIntegrationSelection({
    integrations: [], platform: "whatsapp", identity: { phone_number_id: "a", asset_conflict: true },
  }).reason, "conflicting_recipient_assets");
});

test("CTWA creative and MCCQE context route to AylaMed over a shared number", () => {
  const shared = {
    platform: "whatsapp",
    brand_id: NEXTGEN_BRAND_ID,
    shared_brand_ids: [NEXTGEN_BRAND_ID, AYLAMED_BRAND_ID],
  };

  assert.deepEqual(resolveInboundBrandContext({
    platform: "whatsapp",
    integration: shared,
    creativeBrandId: AYLAMED_BRAND_ID,
    examTrack: "usmle_step1",
    defaultBrandId: NEXTGEN_BRAND_ID,
  }), { brand_id: AYLAMED_BRAND_ID, reason: "meta_ad_creative" });
  assert.deepEqual(resolveInboundBrandContext({
    platform: "whatsapp",
    integration: shared,
    examTrack: "mccqe",
    defaultBrandId: NEXTGEN_BRAND_ID,
  }), { brand_id: AYLAMED_BRAND_ID, reason: "exam_intent" });
  assert.deepEqual(resolveInboundBrandContext({
    platform: "whatsapp",
    integration: shared,
    defaultBrandId: NEXTGEN_BRAND_ID,
  }), { brand_id: "", reason: "shared_integration_ambiguous" });
});

test("a dedicated provider asset owns the inbound even when message text names another exam", () => {
  assert.deepEqual(resolveInboundBrandContext({
    platform: "facebook",
    integration: { platform: "facebook", brand_id: NEXTGEN_BRAND_ID, account_id: "111" },
    creativeBrandId: AYLAMED_BRAND_ID,
    examTrack: "mccqe",
    defaultBrandId: NEXTGEN_BRAND_ID,
  }), { brand_id: NEXTGEN_BRAND_ID, reason: "facebook_integration" });

  assert.deepEqual(resolveInboundBrandContext({
    platform: "whatsapp",
    integration: { platform: "whatsapp", brand_id: AYLAMED_BRAND_ID, phone_number_id: "ayla-phone" },
    examTrack: "usmle_step1",
    defaultBrandId: NEXTGEN_BRAND_ID,
  }), { brand_id: AYLAMED_BRAND_ID, reason: "whatsapp_integration" });
});

test("identity matching never merges an AylaMed inbound into a NextGen lead", () => {
  const nextgen = { id: "ng", brand_id: NEXTGEN_BRAND_ID, updated_at: "2026-09-04T00:00:00Z" };
  const ayla = { id: "ayla", brand_id: AYLAMED_BRAND_ID, updated_at: "2026-09-03T00:00:00Z" };
  const quarantine = { id: "unbranded", brand_id: "", updated_at: "2026-09-05T00:00:00Z" };
  assert.equal(chooseBrandSafeIdentityMatch([nextgen], AYLAMED_BRAND_ID), null);
  assert.equal(chooseBrandSafeIdentityMatch([nextgen, ayla], AYLAMED_BRAND_ID), ayla);
  assert.equal(chooseBrandSafeIdentityMatch([nextgen, ayla]), null, "ambiguous cross-brand identity stays unmerged");
  assert.equal(
    chooseBrandSafeIdentityMatch([nextgen, ayla, quarantine]),
    quarantine,
    "an existing unbranded quarantine contact receives later ambiguous messages",
  );
});

test("dedicated AylaMed integrations cannot borrow legacy NextGen environment credentials", () => {
  assert.equal(providerEnvFallbackAllowed({ brand_id: AYLAMED_BRAND_ID }), false);
  assert.equal(providerEnvFallbackAllowed({ brand_id: NEXTGEN_BRAND_ID }), true);
  assert.equal(providerEnvFallbackAllowed({
    platform: "whatsapp",
    brand_id: NEXTGEN_BRAND_ID,
    shared_brand_ids: [NEXTGEN_BRAND_ID, AYLAMED_BRAND_ID],
  }, AYLAMED_BRAND_ID), true);
  const accidentalSharedPage = {
    platform: "facebook",
    brand_id: NEXTGEN_BRAND_ID,
    shared_brand_ids: [NEXTGEN_BRAND_ID, AYLAMED_BRAND_ID],
  };
  assert.equal(integrationIsShared(accidentalSharedPage), false);
  assert.equal(providerEnvFallbackAllowed(accidentalSharedPage, AYLAMED_BRAND_ID), false);
  assert.deepEqual(resolveInboundBrandContext({
    platform: "facebook",
    integration: accidentalSharedPage,
    creativeBrandId: AYLAMED_BRAND_ID,
    examTrack: "mccqe",
  }), { brand_id: NEXTGEN_BRAND_ID, reason: "facebook_integration" });
});

test("only explicitly shared WhatsApp integrations can serve both brands", () => {
  const sharedWhatsApp = {
    platform: "whatsapp",
    brand_id: NEXTGEN_BRAND_ID,
    shared_brand_ids: [NEXTGEN_BRAND_ID, AYLAMED_BRAND_ID],
  };
  assert.equal(integrationSupportsBrand(sharedWhatsApp, NEXTGEN_BRAND_ID), true);
  assert.equal(integrationSupportsBrand(sharedWhatsApp, AYLAMED_BRAND_ID), true);
  assert.equal(integrationSupportsBrand({ ...sharedWhatsApp, platform: "facebook" }, AYLAMED_BRAND_ID), false);
  assert.equal(integrationSupportsBrand({ platform: "whatsapp", brand_id: NEXTGEN_BRAND_ID }, AYLAMED_BRAND_ID), false);
});

test("ambiguous shared-number routing requires manual review", () => {
  assert.equal(inboundBrandRequiresManualReview("cross_brand_identity_ambiguous"), true);
  assert.equal(inboundBrandRequiresManualReview("shared_integration_ambiguous"), true);
  assert.equal(inboundBrandRequiresManualReview("existing_contact_brand"), false);
  assert.equal(inboundBrandRequiresManualReview("meta_ad_creative"), false);
});

test("AylaMed outbound safety rejects NextGen copy and non-Ayla templates", () => {
  assert.equal(aylaOutboundContentSafety({ brandId: AYLAMED_BRAND_ID, text: "Explore your MCCQE roadmap at https://mccqe.aylamedapp.com" }).safe, true);
  assert.equal(aylaOutboundContentSafety({ brandId: AYLAMED_BRAND_ID, text: "Visit nextgenusmle.live" }).safe, false);
  assert.equal(aylaOutboundContentSafety({ brandId: AYLAMED_BRAND_ID, text: "USMLE demo" }).safe, false);
  assert.equal(aylaOutboundContentSafety({
    brandId: AYLAMED_BRAND_ID,
    text: "MCCQE",
    template: { brand_id: NEXTGEN_BRAND_ID, body: "NextGen" },
  }).reason, "aylamed_template_brand_mismatch");
  assert.equal(aylaOutboundContentSafety({
    brandId: AYLAMED_BRAND_ID,
    text: "MCCQE",
    providerTemplateName: "unscoped_template",
  }).reason, "aylamed_provider_template_not_brand_scoped");
});

test("the server applies the brand resolver at Meta sync and inbound integration boundaries", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const metaSync = server.slice(
    server.indexOf("function ngUpsertMetaAdsSnapshot"),
    server.indexOf("function ngStartMetaReporting"),
  );
  const socialMatching = server.slice(
    server.indexOf("function findExistingSocialLead"),
    server.indexOf("function appendSocialConversation"),
  );
  const durableWhatsApp = server.slice(
    server.indexOf("async function ngProcessWhatsAppInboundJournalEntry"),
    server.indexOf("async function ngProcessWhatsAppCallJournalEntry"),
  );
  const directWhatsApp = server.slice(
    server.indexOf('app.post("/webhooks/whatsapp"'),
    server.indexOf("// Live Session Conversion Settings and Events"),
  );
  const profileRoutes = server.slice(
    server.indexOf("function crmSavedWhatsAppProfile"),
    server.indexOf('registerCrmCrudRoutes({ route: "/admin/crm/whatsapp-business-profiles"'),
  );
  const directIntegrationSend = server.slice(
    server.indexOf('app.post("/admin/crm/integrations/:id/send"'),
    server.indexOf('app.get("/admin/crm/integrations/:id/status"'),
  );
  const inboxRoute = server.slice(
    server.indexOf('app.get("/admin/crm/conversation-inbox"'),
    server.indexOf('app.post("/admin/crm/conversations/:leadId/send"'),
  );
  const autoFirst = server.slice(
    server.indexOf("async function ngSendAutoFirstMessageForLead"),
    server.indexOf("const ngPostImportFirstMessageJobKeys"),
  );
  const dailyScheduler = server.slice(
    server.indexOf("async function ngRunDailyLiveSessionScheduler"),
    server.indexOf("function ngGoogleMeetAppointmentDateTime"),
  );

  assert.match(metaSync, /partitionMetaAdsSnapshotByBrand\(snapshot, process\.env\)/);
  assert.doesNotMatch(metaSync, /domain === "nextgenusmle\.live"/);
  assert.match(metaSync, /item\.brand_id/);
  assert.match(socialMatching, /const matches = matchingSocialLeads\(db, platform, payload\)/);
  assert.match(socialMatching, /chooseBrandSafeIdentityMatch\([\s\S]*matches,[\s\S]*payload\.brand_id/);
  assert.match(durableWhatsApp, /ngApplyInboundBrandContext/);
  assert.match(directWhatsApp, /brandId: routedBrandId/);
  assert.match(server, /const brandKey = normalizeCrmString\(lead\.brand_id \|\| "unassigned"\)/);
  assert.match(server, /AYLAMED_AI_AUTO_SEND_ENABLED/);
  assert.match(server, /aylamed_brand_assets_not_enabled/);
  assert.match(profileRoutes, /resolveWhatsAppCloudConfig\(\{ db, brandId \}\)/);
  assert.match(server, /getIntegrationByPlatform\(db, cleanChannel, \{ brandId: effectiveBrandId \}\)/);
  assert.match(server, /cross_brand_identity_ambiguous/);
  assert.match(server, /brand_routing_requires_manual_review/);
  assert.match(server, /providerEnvFallbackAllowed\(selectedIntegration, brandId\)/);
  assert.match(server, /crm_brand_routing_build: CRM_BRAND_ROUTING_BUILD/);
  assert.match(directIntegrationSend, /integrationSupportsBrand\(integration, effectiveBrandId\)/);
  assert.match(directIntegrationSend, /sendCrmMessage\(\{/);
  assert.match(directIntegrationSend, /brand_id: effectiveBrandId/);
  assert.match(directIntegrationSend, /brand_id: lead\.brand_id \|\| requestedBrandId/);
  assert.match(inboxRoute, /explicitBrandId/);
  assert.match(inboxRoute, /const inboxBrandId = explicitBrandId \|\| NEXTGEN_BRAND_ID/);
  assert.match(inboxRoute, /inboxBrandId\.toLowerCase\(\) !== "all" \|\| !ctx\.crm_admin/);
  assert.match(inboxRoute, /String\(item\.brand_id \|\| ""\) === scopedBrandId/);
  assert.match(autoFirst, /reason: "brand_assets_not_configured"/);
  assert.match(autoFirst, /String\(lead\.brand_id \|\| NEXTGEN_BRAND_ID\) === NEXTGEN_BRAND_ID/);
  assert.match(dailyScheduler, /brand_assets_not_configured/);
  assert.match(dailyScheduler, /brandId = NEXTGEN_BRAND_ID/);
  assert.match(server, /transport: effectiveBrandId === AYLAMED_BRAND_ID \? "aylamed" : "default"/);
  assert.match(server, /function sanitizeIntegrationSecrets/);
  assert.match(server, /AylaMed WhatsApp profiles require an explicit reviewed phone number ID/);
  assert.doesNotMatch(
    server.slice(server.indexOf("function getMetaTokenForPlatform"), server.indexOf("function ngReadStateMessageTimeMs")),
    /getIntegrationCredential\(integration, "api_key", "META_PAGE_ACCESS_TOKEN"\)/,
  );
});
