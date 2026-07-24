import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DEFAULT_AYLA_MARKETING_SETTINGS,
  aylaAttributionWindowOpen,
  aylaCampaignIsActive,
  aylaMarketingMetrics,
  aylaReferralSelfCheck,
  aylaRewardDefinitionsForMilestone,
  aylaRewardReadyAt,
  aylaRewardReleaseEligible,
  buildAylaPublicReadinessSnapshot,
  buildAylaReadinessShareCopy,
  normalizeAylaCampaign,
  normalizeAylaMarketingSettings,
  normalizeAylaReferralCode,
  publicAylaMarketingSettings,
  renderAylaReadinessCardSvg,
} from "../lib/aylamed-marketing-referrals.js";

const verifiedReport = {
  studentId: "private-student-id",
  generatedAt: "2026-07-24T12:00:00.000Z",
  exam: { id: "usmle_step_1", label: "USMLE Step 1", curriculumVersion: "private-version" },
  evidence: { kind: "server_verified_diagnostic", label: "Verified diagnostic", confidence: "verified" },
  readiness: { score: 58, level: "Medium Risk", phase: "System Mastery", passPrediction: false },
  weakAreas: [
    { system: "Cardiovascular", topic: "Private granular topic", correct: 1, total: 4 },
    { system: "Renal", topic: "Private second topic", correct: 2, total: 4 },
  ],
  tutorBriefing: { primaryFocus: "Cardiovascular", reason: "Private long tutor reasoning" },
  nextAction: { description: "Begin with Cardiovascular and validate the plan through real work.", route: "/dashboard/private" },
  routes: { roadmap: "/dashboard/private-roadmap" },
  privateEmail: "private@example.com",
  rawAnswers: [{ correctAnswer: "secret" }],
};

test("marketing settings merge nested admin values and reject unknown plan IDs", () => {
  const settings = normalizeAylaMarketingSettings({
    sharing: { expiry_days: 45, public_site_url: "https://aylamed.example/share/" },
    attribution: {
      eligible_plan_ids: ["monthly"],
      first_touch_only: false,
      block_self_referrals: false,
      require_verified_diagnostic: false,
    },
    rewards: {
      paid: {
        enabled: true,
        refund_hold_days: 21,
        minimum_amount_cents: 500,
        referrer: { label: "One month credit", value: 30, unit: "bonus_days" },
      },
    },
  }, { validPlanIds: ["monthly", "demo"] });
  assert.equal(settings.sharing.expiry_days, 45);
  assert.equal(settings.sharing.public_site_url, "https://aylamed.example/share");
  assert.equal(settings.rewards.paid.hold_days, 21);
  assert.equal(settings.rewards.paid.referrer.unit, "bonus_days");
  assert.equal(settings.rewards.fulfillment_mode, "manual");
  assert.equal(settings.attribution.first_touch_only, true);
  assert.equal(settings.attribution.block_self_referrals, true);
  assert.equal(settings.attribution.require_verified_diagnostic, true);
  const minimumPaidHold = normalizeAylaMarketingSettings({
    rewards: { paid: { enabled: true, hold_days: 0 } },
  });
  assert.equal(minimumPaidHold.rewards.paid.hold_days, 1);
  const legacyPaidHold = normalizeAylaMarketingSettings({}, {
    current: {
      ...DEFAULT_AYLA_MARKETING_SETTINGS,
      rewards: {
        ...DEFAULT_AYLA_MARKETING_SETTINGS.rewards,
        paid: { ...DEFAULT_AYLA_MARKETING_SETTINGS.rewards.paid, hold_days: 0 },
      },
    },
  });
  assert.equal(legacyPaidHold.rewards.paid.hold_days, 1);
  assert.throws(
    () => normalizeAylaMarketingSettings(
      { attribution: { eligible_plan_ids: ["invented"] } },
      { validPlanIds: ["monthly"] },
    ),
    (error) => error.code === "UNKNOWN_MARKETING_PLAN",
  );
});

test("public marketing settings omit operational reward and attribution rules", () => {
  const publicSettings = publicAylaMarketingSettings({
    rewards: { paid: { enabled: true, minimum_amount_cents: 999_999 } },
    attribution: { eligible_plan_ids: ["private-plan-id"], window_days: 179 },
  });
  assert.equal(publicSettings.program.sharing_enabled, true);
  assert.equal(publicSettings.attribution.allow_demo_signup, true);
  assert.equal("rewards" in publicSettings, false);
  assert.equal("eligible_plan_ids" in publicSettings.attribution, false);
  assert.doesNotMatch(JSON.stringify(publicSettings), /private-plan-id|999999|179/);
});

test("readiness snapshots are anonymous and only publish server-verified scores", () => {
  const snapshot = buildAylaPublicReadinessSnapshot(verifiedReport, DEFAULT_AYLA_MARKETING_SETTINGS);
  assert.equal(snapshot.readiness.score, 58);
  assert.equal(snapshot.evidence.verified, true);
  assert.deepEqual(snapshot.weak_areas, ["Cardiovascular", "Renal"]);
  assert.equal(snapshot.readiness.pass_prediction, false);
  assert.equal(snapshot.privacy.anonymous, true);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private-student-id|private@example.com|correctAnswer|Private granular topic|private-roadmap/i,
  );

  const provisional = buildAylaPublicReadinessSnapshot({
    ...verifiedReport,
    evidence: { kind: "provisional_self_report", label: "Provisional self-assessment" },
    readiness: { ...verifiedReport.readiness, score: 99 },
  }, DEFAULT_AYLA_MARKETING_SETTINGS);
  assert.equal(provisional.readiness.score, null);
  assert.equal(provisional.evidence.provisional, true);
});

test("share copy and SVG are generated from admin templates without exposing private fields", () => {
  const settings = normalizeAylaMarketingSettings({
    sharing: {
      card_title: "{{exam}} · {{readiness}}",
      whatsapp_message: "{{challenge}} — {{focus}} — {{share_url}}",
    },
  });
  const snapshot = buildAylaPublicReadinessSnapshot(verifiedReport, settings);
  const copy = buildAylaReadinessShareCopy(snapshot, settings, "https://aylamed.example/readiness/token");
  assert.equal(copy.title, "USMLE Step 1 · 58% verified baseline");
  assert.match(copy.whatsapp_message, /Challenge your study partner/);
  assert.match(copy.whatsapp_message, /https:\/\/aylamed\.example\/readiness\/token/);
  const svg = renderAylaReadinessCardSvg(snapshot, settings);
  assert.match(svg, /^<\?xml/);
  assert.match(svg, /58% verified baseline/);
  assert.match(svg, /Anonymous snapshot/);
  assert.doesNotMatch(svg, /private@example|private-student-id|correctAnswer/i);
});

test("campaign and attribution windows are time governed", () => {
  const campaign = normalizeAylaCampaign({
    name: "Step 1 launch",
    status: "active",
    starts_at: "2026-07-01T00:00:00.000Z",
    ends_at: "2026-08-01T00:00:00.000Z",
    channels: ["WhatsApp"],
  });
  assert.equal(aylaCampaignIsActive(campaign, new Date("2026-07-24T00:00:00.000Z")), true);
  assert.equal(aylaCampaignIsActive(campaign, new Date("2026-08-01T00:00:00.000Z")), false);
  assert.equal(
    aylaAttributionWindowOpen(
      { attributed_at: "2026-07-01T00:00:00.000Z" },
      { attribution: { window_days: 30 } },
      new Date("2026-07-30T23:59:59.000Z"),
    ),
    true,
  );
  assert.equal(
    aylaAttributionWindowOpen(
      { attributed_at: "2026-07-01T00:00:00.000Z" },
      { attribution: { window_days: 30 } },
      new Date("2026-08-01T00:00:01.000Z"),
    ),
    false,
  );
  assert.throws(
    () => normalizeAylaCampaign({ name: "Unsupported", channels: ["invented-channel"] }),
    (error) => error.code === "INVALID_MARKETING_CHANNEL",
  );
});

test("referral identity and codes prevent obvious self-attribution", () => {
  assert.equal(normalizeAylaReferralCode(" ayla-ab 12 !! "), "AYLAAB12");
  assert.equal(aylaReferralSelfCheck({ referrerUserId: "one", referredUserId: "one" }), true);
  assert.equal(aylaReferralSelfCheck({ referrerEmail: "Doctor@Example.com", referredEmail: "doctor@example.com" }), true);
  assert.equal(aylaReferralSelfCheck({ referrerUserId: "one", referredUserId: "two", referrerEmail: "a@example.com", referredEmail: "b@example.com" }), false);
});

test("rewards are two-sided, held, and released only after validation", () => {
  const settings = normalizeAylaMarketingSettings({
    rewards: {
      diagnostic: {
        enabled: true,
        hold_days: 0,
        referrer: { label: "Referrer bonus", value: 1, unit: "points" },
        referred: { label: "Student bonus", value: 1, unit: "points" },
      },
      paid: {
        enabled: true,
        refund_hold_days: 14,
        minimum_amount_cents: 100,
        referrer: { label: "Referrer credit", value: 10, unit: "account_credit" },
        referred: { label: "Student credit", value: 5, unit: "account_credit" },
      },
    },
  });
  const diagnostic = aylaRewardDefinitionsForMilestone(settings, "verified_diagnostic_completed");
  const paid = aylaRewardDefinitionsForMilestone(settings, "paid_conversion");
  assert.deepEqual(diagnostic.map((row) => row.beneficiary_role), ["referrer", "referred"]);
  assert.equal(paid[0].hold_days, 14);
  const readyAt = aylaRewardReadyAt("2026-07-24T00:00:00.000Z", 14);
  assert.equal(readyAt, "2026-08-07T00:00:00.000Z");
  const reward = {
    status: "pending_hold",
    attribution_id: "attr-1",
    payment_id: "payment-1",
    ready_at: readyAt,
  };
  assert.equal(aylaRewardReleaseEligible(reward, { now: new Date("2026-08-06T23:59:59.000Z") }), false);
  assert.equal(aylaRewardReleaseEligible(reward, { now: new Date("2026-08-07T00:00:00.000Z") }), true);
  assert.equal(aylaRewardReleaseEligible(reward, { now: new Date("2026-08-08"), invalidPaymentIds: ["payment-1"] }), false);
  assert.equal(aylaRewardReleaseEligible(reward, { now: new Date("2026-08-08"), blockedAttributionIds: ["attr-1"] }), false);
});

test("admin marketing metrics separate shares, conversions, revenue, and reward states", () => {
  const metrics = aylaMarketingMetrics({
    campaigns: [{ status: "active" }, { status: "paused" }],
    shares: [{ status: "active" }, { status: "revoked" }],
    events: [{ type: "share_view" }, { type: "share_view" }, { type: "whatsapp_share" }],
    attributions: [{ status: "attributed" }, { status: "blocked" }],
    milestones: [
      { type: "verified_diagnostic_completed" },
      { type: "paid_conversion", payment_id: "pay-1" },
      { type: "paid_conversion", payment_id: "pay-refunded" },
      { type: "paid_conversion", payment_id: "pay-refund-pending" },
      { type: "paid_conversion", payment_id: "pay-processing" },
    ],
    payments: [
      { id: "pay-1", final_amount_cents: 3000, status: "completed" },
      { id: "pay-refunded", final_amount_cents: 9000, status: "refunded" },
      { id: "pay-refund-pending", final_amount_cents: 4000, status: "completed", referral_reward_review_status: "refund_pending" },
      { id: "pay-processing", final_amount_cents: 5000, status: "processing" },
    ],
    rewards: [
      { status: "pending_hold" },
      { status: "ready_for_fulfillment" },
      { status: "fulfilled" },
    ],
  });
  assert.equal(metrics.active_campaigns, 1);
  assert.equal(metrics.share_views, 2);
  assert.equal(metrics.whatsapp_shares, 1);
  assert.equal(metrics.referred_signups, 1);
  assert.equal(metrics.paid_conversions, 1);
  assert.equal(metrics.attributed_revenue_cents, 3000);
  assert.equal(metrics.rewards_ready, 1);
  assert.equal(metrics.rewards_refund_review, 0);
});

test("server marketing routes remain AylaMed-only and admin gated", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /const AYLA_MARKETING_BUILD = "v231-readiness-sharing-referrals"/);
  assert.match(server, /app\.get\("\/api\/ayla\/admin\/marketing"/);
  assert.match(server, /app\.put\("\/api\/ayla\/admin\/marketing\/settings"/);
  assert.match(server, /app\.post\("\/api\/ayla\/students\/:studentId\/readiness-shares"/);
  assert.match(server, /app\.get\("\/api\/ayla\/readiness-shares\/:token"/);
  assert.match(server, /app\.get\("\/api\/ayla\/readiness-shares\/:token\/card\.svg"/);
  assert.match(server, /app\.post\("\/api\/ayla\/admin\/marketing\/rewards\/release-eligible"/);
  assert.match(server, /app\.patch\("\/api\/ayla\/admin\/marketing\/referral-codes\/:codeId"/);
  assert.match(server, /aylaMarketingTakePublicEventRate\(req, req\.params\.token\)/);
  const marketingRoutes = server.slice(
    server.indexOf('app.get("/api/ayla/admin/marketing"'),
    server.indexOf("// AYLAMED V231 MARKETING END"),
  );
  assert.match(marketingRoutes, /await aylaRequireAdmin\(req\)/);
  assert.doesNotMatch(marketingRoutes, /writeLiveDb\s*\(|writeCrmDb\s*\(/);
  assert.match(server, /aylaRecordReferralMilestone\(db,[\s\S]*?"verified_diagnostic_completed"/);
  assert.match(server, /aylaRecordReferralMilestone\(db,[\s\S]*?"paid_conversion"/);
  assert.match(server, /async function aylaHandleStripeRefund/);
  assert.match(server, /paid_conversion_reversed/);
  assert.match(server, /enrollment_access_changed: false/);
  assert.match(server, /campaign_eligible_plan_ids/);
  assert.match(server, /existingMonthlyRewardedReferrals >= cap/);
  assert.match(server, /"Cache-Control", "no-store, max-age=0"/);
  assert.match(server, /owner_account_removed/);
  assert.match(server, /privacy_erased_at/);
});
