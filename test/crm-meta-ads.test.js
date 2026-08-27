import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  extractClickToWhatsAppAttribution,
  metaAdsReadiness,
  normalizeMetaAdAccount,
  normalizeMetaAdCreative,
  normalizeMetaAdSet,
  normalizeMetaCampaign,
  normalizeMetaCampaignInsight,
} from "../lib/crm-meta-ads.js";

test("Click-to-WhatsApp referral data becomes durable, useful lead attribution", () => {
  const attribution = extractClickToWhatsAppAttribution({
    object: "whatsapp_business_account",
    entry: [{
      changes: [{
        value: {
          messages: [{
            from: "15551234567",
            id: "wamid.123",
            referral: {
              ctwa_clid: "ARAZA-click-id",
              source_type: "ad",
              source_id: "120210000000001",
              source_url: "https://fb.me/ad-preview",
              headline: "Start your 7-day USMLE demo",
              body: "Live classes, recordings, QBank and adaptive support.",
              media_type: "image",
              image_url: "https://lookaside.fbsbx.com/example.jpg",
            },
          }],
        },
      }],
    }],
  });

  assert.deepEqual(attribution, {
    meta_ctwa_clid: "ARAZA-click-id",
    meta_source_type: "ad",
    meta_source_id: "120210000000001",
    meta_ad_id: "120210000000001",
    meta_source_url: "https://fb.me/ad-preview",
    meta_ad_headline: "Start your 7-day USMLE demo",
    meta_ad_body: "Live classes, recordings, QBank and adaptive support.",
    meta_media_type: "image",
    meta_media_url: "https://lookaside.fbsbx.com/example.jpg",
    lead_origin: "click_to_whatsapp_ad",
    lead_source: "click_to_whatsapp_ad",
    source_channel: "click_to_whatsapp_ad",
    source_detail: "Start your 7-day USMLE demo",
    opt_in_status: "click_to_whatsapp_inbound",
  });
});

test("ordinary WhatsApp messages do not pretend to have paid-ad attribution", () => {
  assert.deepEqual(extractClickToWhatsAppAttribution({
    entry: [{ changes: [{ value: { messages: [{ text: { body: "Hello" } }] } }] }],
  }), {});
});

test("Meta Ads readiness fails closed and never returns credentials", () => {
  assert.deepEqual(metaAdsReadiness({}), {
    configured: false,
    access_token_configured: false,
    preferred_account_configured: false,
    graph_api_version: "v26.0",
  });

  const ready = metaAdsReadiness({
    META_ADS_ACCESS_TOKEN: "private-token",
    META_AD_ACCOUNT_ID: "act_123",
    META_GRAPH_API_VERSION: "v25.0",
  });
  assert.deepEqual(ready, {
    configured: true,
    access_token_configured: true,
    preferred_account_configured: true,
    graph_api_version: "v25.0",
  });
  assert.doesNotMatch(JSON.stringify(ready), /private-token/);
});

test("Meta account, campaign and insight records keep currency honest", () => {
  const account = normalizeMetaAdAccount({
    id: "act_123",
    account_id: "123",
    name: "NextGen USMLE",
    account_status: 1,
    currency: "CAD",
    timezone_name: "America/Toronto",
  });
  assert.equal(account.meta_account_id, "123");
  assert.equal(account.status, "active");
  assert.equal(account.currency, "cad");

  const campaign = normalizeMetaCampaign({
    id: "456",
    name: "Nigeria Step 1 WhatsApp",
    status: "ACTIVE",
    objective: "OUTCOME_ENGAGEMENT",
    daily_budget: "2500",
  }, account);
  assert.equal(campaign.meta_campaign_id, "456");
  assert.equal(campaign.daily_budget_amount, 25);
  assert.equal(campaign.daily_budget_usd, 0, "non-USD budgets must not be labelled as USD");

  const insight = normalizeMetaCampaignInsight({
    campaign_id: "456",
    campaign_name: "Nigeria Step 1 WhatsApp",
    spend: "19.50",
    impressions: "1000",
    clicks: "44",
    reach: "850",
    actions: [
      { action_type: "onsite_conversion.messaging_conversation_started_7d", value: "12" },
      { action_type: "lead", value: "5" },
    ],
    date_start: "2026-08-01",
    date_stop: "2026-08-24",
  }, account);
  assert.equal(insight.messaging_conversations, 12);
  assert.equal(insight.leads, 5);
  assert.equal(insight.spend_amount, 19.5);
  assert.equal(insight.spend_usd, 0);

  const adSet = normalizeMetaAdSet({
    id: "789",
    campaign_id: "456",
    name: "Nigeria IMGs",
    status: "ACTIVE",
    targeting: { geo_locations: { countries: ["NG"] } },
  }, account);
  assert.equal(adSet.meta_ad_set_id, "789");
  assert.deepEqual(adSet.target_countries, ["NG"]);

  const creative = normalizeMetaAdCreative({
    id: "999",
    campaign_id: "456",
    adset_id: "789",
    name: "7-day demo video",
    status: "ACTIVE",
    creative: {
      id: "1000",
      name: "NextGen demo",
      title: "Experience NextGen",
      body: "Take the 7-day demo.",
      thumbnail_url: "https://example.com/thumb.jpg",
    },
  }, account);
  assert.equal(creative.meta_ad_id, "999");
  assert.equal(creative.meta_creative_id, "1000");
  assert.equal(creative.headline, "Experience NextGen");
});

test("CRM routes ingest CTWA attribution and expose admin-only live Meta sync", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const parser = server.slice(
    server.indexOf("function parseInboundSocialPayload"),
    server.indexOf("function findExistingSocialLead"),
  );
  const syncRoute = server.slice(
    server.indexOf('app.get("/admin/crm/meta-ads/readiness"'),
    server.indexOf('registerCrmCrudRoutes({ route: "/admin/crm/ad-accounts"'),
  );
  const syncImplementation = server.slice(
    server.indexOf("function ngUpsertMetaAdsSnapshot"),
    server.indexOf('app.get("/admin/crm/meta-ads/readiness"'),
  );

  assert.match(parser, /extractClickToWhatsAppAttribution\(body\)/);
  assert.match(parser, /\.\.\.paidAttribution/);
  const whatsappWebhook = server.slice(
    server.indexOf('app.get("/webhooks/whatsapp"'),
    server.indexOf("// Live Session Conversion Settings and Events"),
  );
  assert.match(whatsappWebhook, /ngApplyClickToWhatsAppAttribution/);
  assert.match(whatsappWebhook, /extractClickToWhatsAppAttribution\(\{ message \}\)/);
  assert.match(whatsappWebhook, /meta_attributed_at/);
  assert.match(server, /click_to_whatsapp_ad/);
  assert.match(syncRoute, /await requireCrmAdmin\(req\)/);
  assert.match(syncRoute, /fetchMetaAdsSnapshot/);
  assert.match(syncRoute, /ngUpsertMetaAdsSnapshot/);
  assert.match(syncImplementation, /meta_attribution_synced_at/);
  assert.doesNotMatch(syncRoute, /access_token\s*:/);
});
