import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  AYLAMED_BRAND_ID,
  AYLAMED_META_AD_ACCOUNT_ID,
  NEXTGEN_BRAND_ID,
  chooseBrandSafeIdentityMatch,
  configuredMetaAdAccountBrandMap,
  configuredMetaAdAccountIds,
  extractInboundIntegrationIdentity,
  inboundBrandRequiresManualReview,
  partitionMetaAdsSnapshotByBrand,
  providerEnvFallbackAllowed,
  resolveInboundBrandContext,
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
    brand_id: NEXTGEN_BRAND_ID,
    shared_brand_ids: [NEXTGEN_BRAND_ID, AYLAMED_BRAND_ID],
  }, AYLAMED_BRAND_ID), true);
});

test("ambiguous shared-number routing requires manual review", () => {
  assert.equal(inboundBrandRequiresManualReview("cross_brand_identity_ambiguous"), true);
  assert.equal(inboundBrandRequiresManualReview("shared_integration_ambiguous"), true);
  assert.equal(inboundBrandRequiresManualReview("existing_contact_brand"), false);
  assert.equal(inboundBrandRequiresManualReview("meta_ad_creative"), false);
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

  assert.match(metaSync, /partitionMetaAdsSnapshotByBrand\(snapshot, process\.env\)/);
  assert.doesNotMatch(metaSync, /domain === "nextgenusmle\.live"/);
  assert.match(metaSync, /item\.brand_id/);
  assert.match(socialMatching, /chooseBrandSafeIdentityMatch\([\s\S]*matchingSocialLeads\(db, platform, payload\),[\s\S]*payload\.brand_id/);
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
  assert.doesNotMatch(
    server.slice(server.indexOf("function getMetaTokenForPlatform"), server.indexOf("function ngReadStateMessageTimeMs")),
    /getIntegrationCredential\(integration, "api_key", "META_PAGE_ACCESS_TOKEN"\)/,
  );
});
