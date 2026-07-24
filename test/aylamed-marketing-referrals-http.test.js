import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Stripe from "stripe";

function passwordRecord(password, salt = "marketingreferral1234567890abcdef") {
  return {
    salt,
    password_hash: crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex"),
  };
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(baseUrl, child, output, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited (${child.exitCode})\n${output.join("")}`);
    }
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // The isolated smoke server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`Health timeout\n${output.join("")}`);
}

async function api(baseUrl, route, {
  method = "GET",
  token = "",
  adminToken = "",
  body = null,
} = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(adminToken ? { "x-ayla-admin-token": adminToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${route} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  return { response, payload };
}

async function stripeWebhook(baseUrl, event, secret) {
  const payload = JSON.stringify(event);
  const stripe = new Stripe("sk_test_v231");
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  const response = await fetch(`${baseUrl}/stripe/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    body: payload,
  });
  return { response, payload: await response.json() };
}

test("v231 keeps the readiness-share and referral lifecycle governed inside AylaMed", { timeout: 60_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aylamed-v231-http-"));
  const livePath = path.join(dataDir, "live-session-db.json");
  const crmPath = path.join(dataDir, "crm-db.json");
  const aylaPath = path.join(dataDir, "aylamed-db.json");
  const password = "MarketingReferral9!";
  const adminToken = "v231-isolated-admin";
  const now = new Date().toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  const future = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const accessExpiry = new Date(Date.now() + 365 * 86_400_000).toISOString();
  const liveSentinel = JSON.stringify({ sentinel: "lms-untouched-v231" }, null, 2);
  const crmSentinel = JSON.stringify({
    sentinel: "crm-untouched-v231",
    ai_training_documents: [],
    ai_training_items: [],
  }, null, 2);
  const aylaDb = {
    schema_version: 13,
    aylaSettings: {
      product: { monthly_only: true, product_name: "AylaMed" },
      marketing: {
        revision: 1,
        program: {
          enabled: true,
          sharing_enabled: true,
          whatsapp_enabled: true,
          referrals_enabled: true,
          program_name: "Test readiness loop",
        },
      },
    },
    aylaUsers: {
      "user-referrer": {
        id: "user-referrer",
        email: "referrer@example.com",
        name: "Private Referrer Name",
        role: "student",
        status: "active",
        studentId: "student-referrer",
        activeExamTrackId: "usmle_step_1",
        authVersion: 1,
        ...passwordRecord(password),
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaStudents: {
      "student-referrer": {
        id: "student-referrer",
        ayla_user_id: "user-referrer",
        user_id: "user-referrer",
        name: "Private Referrer Name",
        examTrackId: "usmle_step_1",
        exam: "USMLE Step 1",
        examDate: new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10),
        onboardingPath: "diagnostic_test",
        onboardingStatus: "complete",
        serverVerifiedBaseline: true,
        currentScore: 58,
        dailyHours: 4,
        weeklyStudyDays: 6,
        weakAreas: ["Cardiovascular"],
        systemBaselines: {
          Cardiovascular: {
            score: 25,
            correct: 1,
            total: 4,
            source: "verified_baseline_diagnostic",
          },
          Renal: {
            score: 75,
            correct: 3,
            total: 4,
            source: "verified_baseline_diagnostic",
          },
        },
        diagnosticCoverage: {
          questionCount: 40,
          mappedQuestionCount: 40,
          systemsCovered: 5,
          systemsExpected: 5,
          coveragePercent: 100,
        },
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaPlans: {
      monthly: {
        id: "monthly",
        name: "Current Monthly Plan",
        plan_type: "monthly",
        billing_type: "subscription_monthly",
        price_cents: 3000,
        currency: "usd",
        is_active: true,
        is_public: true,
        is_full_access: true,
        exam_tracks: ["usmle_step_1"],
        createdAt: now,
        updatedAt: now,
      },
      demo: {
        id: "demo",
        name: "Current Demo",
        plan_type: "demo",
        billing_type: "free",
        is_demo: true,
        is_active: true,
        is_public: true,
        exam_tracks: ["usmle_step_1"],
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaEnrollments: {
      "enrollment-referrer": {
        id: "enrollment-referrer",
        user_id: "user-referrer",
        student_id: "student-referrer",
        plan_id: "monthly",
        exam_track_id: "usmle_step_1",
        status: "active",
        access_granted: true,
        access_expires_at: accessExpiry,
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaRoadmapTasks: {
      "task-current": {
        id: "task-current",
        studentId: "student-referrer",
        scheduledDate: new Date().toISOString().slice(0, 10),
        status: "Pending",
        title: "Review cardiovascular foundations",
        category: "Concept Review",
        system: "Cardiovascular",
        durationMinutes: 60,
        createdAt: now,
        updatedAt: now,
      },
    },
    aylaReferralAttributions: {
      "attribution-seeded": {
        id: "attribution-seeded",
        referral_code_id: "seeded-code",
        referral_code: "SEEDCODE",
        referrer_user_id: "user-referrer",
        referred_user_id: "seeded-referred-user",
        status: "paid",
        attributed_at: past,
        createdAt: past,
        updatedAt: past,
      },
    },
    aylaPayments: {
      "payment-valid": {
        id: "payment-valid",
        stripe_payment_intent: "pi_v231_referral",
        plan_id: "monthly",
        status: "completed",
        payment_status: "paid",
        final_amount_cents: 3000,
        createdAt: past,
        updatedAt: past,
      },
      "payment-refunded": {
        id: "payment-refunded",
        stripe_payment_intent: "pi_v231_already_refunded",
        plan_id: "monthly",
        status: "refunded",
        payment_status: "refunded",
        final_amount_cents: 3000,
        createdAt: past,
        updatedAt: past,
      },
      "payment-pending-refund": {
        id: "payment-pending-refund",
        stripe_payment_intent: "pi_v231_pending_refund",
        plan_id: "monthly",
        status: "completed",
        payment_status: "paid",
        final_amount_cents: 3000,
        createdAt: past,
        updatedAt: past,
      },
    },
    aylaReferralMilestones: {
      "milestone-paid": {
        id: "milestone-paid",
        attribution_id: "attribution-seeded",
        type: "paid_conversion",
        payment_id: "payment-valid",
        plan_id: "monthly",
        amount_cents: 3000,
        status: "recorded",
        occurred_at: past,
        createdAt: past,
        updatedAt: past,
      },
    },
    aylaReferralRewards: {
      "reward-ready": {
        id: "reward-ready",
        attribution_id: "attribution-seeded",
        payment_id: "payment-valid",
        beneficiary_user_id: "user-referrer",
        beneficiary_role: "referrer",
        label: "Configured ready reward",
        value: 1,
        unit: "points",
        fulfillment_mode: "manual",
        status: "pending_hold",
        ready_at: past,
        createdAt: past,
        updatedAt: past,
      },
      "reward-held": {
        id: "reward-held",
        attribution_id: "attribution-seeded",
        payment_id: "payment-valid",
        beneficiary_user_id: "user-referrer",
        beneficiary_role: "referrer",
        label: "Configured held reward",
        value: 1,
        unit: "points",
        fulfillment_mode: "manual",
        status: "pending_hold",
        ready_at: future,
        createdAt: now,
        updatedAt: now,
      },
      "reward-refunded": {
        id: "reward-refunded",
        attribution_id: "attribution-seeded",
        payment_id: "payment-refunded",
        beneficiary_user_id: "user-referrer",
        beneficiary_role: "referrer",
        label: "Refunded conversion reward",
        value: 1,
        unit: "points",
        fulfillment_mode: "manual",
        status: "pending_hold",
        ready_at: past,
        createdAt: past,
        updatedAt: past,
      },
      "reward-pending-refund": {
        id: "reward-pending-refund",
        attribution_id: "attribution-seeded",
        payment_id: "payment-pending-refund",
        beneficiary_user_id: "user-referrer",
        beneficiary_role: "referrer",
        label: "Pending refund conversion reward",
        value: 1,
        unit: "points",
        fulfillment_mode: "manual",
        status: "pending_hold",
        ready_at: past,
        createdAt: past,
        updatedAt: past,
      },
    },
  };

  await fs.writeFile(livePath, liveSentinel);
  await fs.writeFile(crmPath, crmSentinel);
  await fs.writeFile(aylaPath, JSON.stringify(aylaDb));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      AYLA_ADMIN_TOKEN: adminToken,
      AYLA_AUTH_JWT_SECRET: "v231-ayla-secret",
      AUTH_JWT_SECRET: "v231-lms-secret",
      STRIPE_WEBHOOK_SECRET: "whsec_v231_test",
      NEXTGEN_AUTO_ZOOM_PREP_ENABLED: "false",
      ZOOM_RECORDING_RECOVERY_ENABLED: "false",
      NEXTGEN_BILLING_EXPIRY_RUNNER_ENABLED: "false",
      DATABASE_URL: "",
      OPENAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForHealth(baseUrl, child, output);

    const unauthorized = await api(baseUrl, "/api/ayla/admin/marketing");
    assert.equal(unauthorized.response.status, 401, JSON.stringify(unauthorized.payload));

    const adminOverview = await api(baseUrl, "/api/ayla/admin/marketing", { adminToken });
    assert.equal(adminOverview.response.status, 200, JSON.stringify(adminOverview.payload));
    assert.equal(adminOverview.payload.marketing_build, "v231-readiness-sharing-referrals");
    const planOptionIds = adminOverview.payload.marketing.plan_options.map((plan) => plan.id);
    assert.equal(planOptionIds.includes("demo"), true);
    assert.equal(planOptionIds.includes("monthly"), true);
    assert.equal(
      adminOverview.payload.marketing.plan_options
        .find((plan) => plan.id === "monthly").marketing_eligible,
      true,
    );
    assert.equal(adminOverview.payload.marketing.controls.frontend_values_are_authoritative, false);
    assert.equal(adminOverview.payload.marketing.controls.writes_to_lms, false);
    assert.equal(adminOverview.payload.marketing.controls.writes_to_crm, false);
    assert.equal(
      adminOverview.payload.marketing.options.channels.some((row) => row.id === "whatsapp"),
      true,
    );
    assert.equal(
      adminOverview.payload.marketing.options.reward_units.some((row) => row.id === "account_credit"),
      true,
    );
    assert.deepEqual(
      adminOverview.payload.marketing.rewards
        .find((row) => row.id === "reward-refunded").admin_actions,
      ["cancel"],
    );

    const unknownPlan = await api(baseUrl, "/api/ayla/admin/marketing/settings", {
      method: "PUT",
      adminToken,
      body: {
        expected_revision: 1,
        settings: { attribution: { eligible_plan_ids: ["hardcoded-invented-plan"] } },
      },
    });
    assert.equal(unknownPlan.response.status, 400, JSON.stringify(unknownPlan.payload));
    assert.equal(unknownPlan.payload.details.code, "UNKNOWN_MARKETING_PLAN");

    const configured = await api(baseUrl, "/api/ayla/admin/marketing/settings", {
      method: "PUT",
      adminToken,
      body: {
        expected_revision: 1,
        settings: {
          program: {
            enabled: true,
            sharing_enabled: true,
            whatsapp_enabled: true,
            referrals_enabled: true,
            program_name: "Admin-configured readiness challenge",
          },
          sharing: {
            public_site_url: "https://aylamed.example",
            card_title: "{{exam}} · {{readiness}}",
            whatsapp_message: "{{challenge}} — {{focus}} — {{share_url}}",
          },
          attribution: {
            eligible_plan_ids: ["monthly"],
            window_days: 30,
            first_touch_only: true,
            block_self_referrals: true,
            require_verified_diagnostic: true,
          },
          rewards: {
            diagnostic: {
              enabled: true,
              hold_days: 0,
              referrer: { label: "Configured diagnostic referrer reward", value: 1, unit: "points" },
              referred: { label: "Configured diagnostic student reward", value: 1, unit: "points" },
            },
            paid: {
              enabled: true,
              hold_days: 14,
              minimum_amount_cents: 100,
              referrer: { label: "Configured paid referrer reward", value: 10, unit: "account_credit" },
              referred: { label: "Configured paid student reward", value: 5, unit: "account_credit" },
            },
          },
        },
      },
    });
    assert.equal(configured.response.status, 200, JSON.stringify(configured.payload));
    assert.equal(configured.payload.settings.revision, 2);
    assert.deepEqual(configured.payload.settings.attribution.eligible_plan_ids, ["monthly"]);

    const stale = await api(baseUrl, "/api/ayla/admin/marketing/settings", {
      method: "PUT",
      adminToken,
      body: {
        expected_revision: 1,
        settings: { sharing: { expiry_days: 99 } },
      },
    });
    assert.equal(stale.response.status, 409, JSON.stringify(stale.payload));
    assert.equal(stale.payload.details.code, "STALE_MARKETING_SETTINGS");

    const campaignCreated = await api(baseUrl, "/api/ayla/admin/marketing/campaigns", {
      method: "POST",
      adminToken,
      body: {
        name: "Step 1 readiness partners",
        status: "active",
        channels: ["readiness_card", "whatsapp", "referral_link"],
        exam_track_ids: ["usmle_step_1"],
        eligible_plan_ids: ["monthly"],
        cta_label: "Build my Step 1 readiness plan",
        whatsapp_message: "Campaign invite: {{share_url}}",
        notes: "Internal campaign note",
      },
    });
    assert.equal(campaignCreated.response.status, 201, JSON.stringify(campaignCreated.payload));
    const campaignId = campaignCreated.payload.campaign.id;
    assert.deepEqual(campaignCreated.payload.campaign.eligible_plan_ids, ["monthly"]);

    const login = await api(baseUrl, "/api/ayla/auth/login", {
      method: "POST",
      body: { email: "referrer@example.com", password },
    });
    assert.equal(login.response.status, 200, JSON.stringify(login.payload));
    const token = login.payload.token;

    const initialCenter = await api(
      baseUrl,
      "/api/ayla/students/student-referrer/referral-center",
      { token },
    );
    assert.equal(initialCenter.response.status, 200, JSON.stringify(initialCenter.payload));
    assert.equal(initialCenter.payload.can_activate, true);
    assert.equal(initialCenter.payload.referral, null);

    const activated = await api(
      baseUrl,
      "/api/ayla/students/student-referrer/referral-center/activate",
      { method: "POST", token, body: {} },
    );
    assert.equal(activated.response.status, 201, JSON.stringify(activated.payload));
    const referralCode = activated.payload.referral.code;
    assert.match(referralCode, /^AYLA[A-Z0-9]+$/);
    const activeCenter = await api(
      baseUrl,
      "/api/ayla/students/student-referrer/referral-center",
      { token },
    );
    assert.equal(activeCenter.response.status, 200, JSON.stringify(activeCenter.payload));
    assert.equal(
      activeCenter.payload.referral.referral_url,
      `https://aylamed.example/?ref=${referralCode}&campaign=${campaignId}&register=1`,
    );
    assert.equal(activeCenter.payload.campaign.id, campaignId);

    const publicReferral = await api(baseUrl, `/api/ayla/referrals/${referralCode}`);
    assert.equal(publicReferral.response.status, 200, JSON.stringify(publicReferral.payload));
    assert.equal(publicReferral.payload.referral.code, referralCode);
    assert.equal(publicReferral.payload.owner_identity_exposed, false);
    assert.doesNotMatch(JSON.stringify(publicReferral.payload), /Private Referrer Name|referrer@example\.com/);

    const shareCreated = await api(
      baseUrl,
      "/api/ayla/students/student-referrer/readiness-shares",
      { method: "POST", token, body: {} },
    );
    assert.equal(shareCreated.response.status, 201, JSON.stringify(shareCreated.payload));
    assert.equal(shareCreated.payload.share.snapshot.readiness.score, 58);
    assert.equal(shareCreated.payload.share.snapshot.evidence.verified, true);
    assert.equal(shareCreated.payload.share.snapshot.privacy.anonymous, true);
    assert.equal(shareCreated.payload.share.campaign_id, campaignId);
    assert.match(shareCreated.payload.share.copy.whatsapp_message, /^Campaign invite:/);
    assert.match(shareCreated.payload.share.share_url, /^https:\/\/aylamed\.example\/readiness\//);
    const shareToken = shareCreated.payload.share.share_url.split("/").at(-1);

    const publicShare = await api(baseUrl, `/api/ayla/readiness-shares/${shareToken}`);
    assert.equal(publicShare.response.status, 200, JSON.stringify(publicShare.payload));
    assert.equal(publicShare.payload.share.snapshot.readiness.score, 58);
    assert.equal(publicShare.payload.share.referral_code, referralCode);
    assert.match(publicShare.response.headers.get("cache-control") || "", /no-store/);
    assert.equal(publicShare.payload.share.snapshot.cta_label, "Build my Step 1 readiness plan");
    assert.equal(publicShare.payload.share.privacy.anonymous, true);
    assert.match(publicShare.payload.share.cta_url, new RegExp(`ref=${referralCode}`));
    assert.match(publicShare.payload.share.cta_url, new RegExp(`campaign=${campaignId}`));
    assert.match(publicShare.payload.share.cta_url, /register=1/);
    assert.doesNotMatch(
      JSON.stringify(publicShare.payload),
      /Private Referrer Name|referrer@example\.com|student-referrer|user-referrer|correctAnswer|rawAnswers/i,
    );

    const malformedToken = await api(
      baseUrl,
      `/api/ayla/readiness-shares/${encodeURIComponent(`${shareToken}           suffix`)}`,
    );
    assert.equal(malformedToken.response.status, 404, JSON.stringify(malformedToken.payload));

    const card = await fetch(`${baseUrl}/api/ayla/readiness-shares/${shareToken}/card.svg`);
    const svg = await card.text();
    assert.equal(card.status, 200, svg.slice(0, 500));
    assert.match(card.headers.get("content-type") || "", /image\/svg\+xml/);
    assert.match(card.headers.get("cache-control") || "", /no-store/);
    assert.match(svg, /58% verified baseline/);
    assert.match(svg, /Anonymous snapshot/);
    assert.doesNotMatch(svg, /Private Referrer Name|referrer@example\.com|student-referrer|user-referrer/);

    const viewId = "stable-public-view-id-123";
    const firstView = await api(baseUrl, `/api/ayla/readiness-shares/${shareToken}/events`, {
      method: "POST",
      body: { type: "share_view", event_id: viewId },
    });
    assert.equal(firstView.response.status, 201, JSON.stringify(firstView.payload));
    assert.equal(firstView.payload.duplicate, false);
    const replayedView = await api(baseUrl, `/api/ayla/readiness-shares/${shareToken}/events`, {
      method: "POST",
      body: { type: "share_view", event_id: viewId },
    });
    assert.equal(replayedView.response.status, 200, JSON.stringify(replayedView.payload));
    assert.equal(replayedView.payload.duplicate, true);

    const whatsappEvent = await api(
      baseUrl,
      `/api/ayla/students/student-referrer/readiness-shares/${shareCreated.payload.share.id}/events`,
      { method: "POST", token, body: { type: "whatsapp_share" } },
    );
    assert.equal(whatsappEvent.response.status, 201, JSON.stringify(whatsappEvent.payload));

    const registration = await api(baseUrl, "/api/ayla/auth/register", {
      method: "POST",
      body: {
        email: "referred@example.com",
        password: "ReferredStudent9!",
        name: "Private Referred Name",
        referralCode,
      },
    });
    assert.equal(registration.response.status, 201, JSON.stringify(registration.payload));
    assert.equal(registration.payload.referral.attached, true);
    assert.ok(registration.payload.referral.attribution_id);

    const codeRevoked = await api(
      baseUrl,
      `/api/ayla/admin/marketing/referral-codes/${activated.payload.referral.id}`,
      { method: "PATCH", adminToken, body: { action: "revoke" } },
    );
    assert.equal(codeRevoked.response.status, 200, JSON.stringify(codeRevoked.payload));
    assert.equal(codeRevoked.payload.referral_code.status, "revoked");
    const shareAfterCodeRevoke = await api(baseUrl, `/api/ayla/readiness-shares/${shareToken}`);
    assert.equal(shareAfterCodeRevoke.response.status, 200, JSON.stringify(shareAfterCodeRevoke.payload));
    assert.equal(shareAfterCodeRevoke.payload.share.referral_code, null);
    assert.doesNotMatch(shareAfterCodeRevoke.payload.share.cta_url, /[?&]ref=/);
    assert.match(shareAfterCodeRevoke.payload.share.cta_url, /[?&]register=1/);
    const invitationAfterCodeRevoke = await api(baseUrl, `/api/ayla/referrals/${referralCode}`);
    assert.equal(invitationAfterCodeRevoke.response.status, 404, JSON.stringify(invitationAfterCodeRevoke.payload));

    const codeReactivated = await api(
      baseUrl,
      `/api/ayla/admin/marketing/referral-codes/${activated.payload.referral.id}`,
      { method: "PATCH", adminToken, body: { action: "reactivate" } },
    );
    assert.equal(codeReactivated.response.status, 200, JSON.stringify(codeReactivated.payload));
    assert.equal(codeReactivated.payload.referral_code.status, "active");
    const shareAfterCodeReactivate = await api(baseUrl, `/api/ayla/readiness-shares/${shareToken}`);
    assert.equal(shareAfterCodeReactivate.response.status, 200, JSON.stringify(shareAfterCodeReactivate.payload));
    assert.equal(shareAfterCodeReactivate.payload.share.referral_code, referralCode);

    const campaignPaused = await api(
      baseUrl,
      `/api/ayla/admin/marketing/campaigns/${campaignId}`,
      {
        method: "PATCH",
        adminToken,
        body: { expected_revision: 1, status: "paused" },
      },
    );
    assert.equal(campaignPaused.response.status, 200, JSON.stringify(campaignPaused.payload));
    const staleCampaignCenter = await api(
      baseUrl,
      "/api/ayla/students/student-referrer/referral-center",
      { token },
    );
    assert.equal(staleCampaignCenter.response.status, 200, JSON.stringify(staleCampaignCenter.payload));
    assert.equal(staleCampaignCenter.payload.can_refresh, true);
    assert.equal(staleCampaignCenter.payload.referral.needs_campaign_refresh, true);
    const refreshedCampaignCode = await api(
      baseUrl,
      "/api/ayla/students/student-referrer/referral-center/activate",
      { method: "POST", token, body: {} },
    );
    assert.equal(refreshedCampaignCode.response.status, 200, JSON.stringify(refreshedCampaignCode.payload));
    assert.equal(refreshedCampaignCode.payload.created, false);
    assert.equal(refreshedCampaignCode.payload.referral.code, referralCode);
    assert.equal(refreshedCampaignCode.payload.referral.campaign_id, null);
    const refreshedCampaignCenter = await api(
      baseUrl,
      "/api/ayla/students/student-referrer/referral-center",
      { token },
    );
    assert.equal(refreshedCampaignCenter.response.status, 200, JSON.stringify(refreshedCampaignCenter.payload));
    assert.equal(refreshedCampaignCenter.payload.can_refresh, false);
    assert.equal(
      refreshedCampaignCenter.payload.referral.referral_url,
      `https://aylamed.example/?ref=${referralCode}&register=1`,
    );

    const afterReferral = await api(
      baseUrl,
      "/api/ayla/students/student-referrer/referral-center",
      { token },
    );
    assert.equal(afterReferral.response.status, 200, JSON.stringify(afterReferral.payload));
    assert.equal(afterReferral.payload.stats.referred_signups, 2);
    assert.doesNotMatch(
      JSON.stringify(afterReferral.payload),
      /referred@example\.com|Private Referred Name|seeded-referred-user/,
    );

    const pendingRefund = await stripeWebhook(baseUrl, {
      id: "evt_v231_pending_refund",
      type: "refund.created",
      data: {
        object: {
          id: "re_v231_pending",
          object: "refund",
          payment_intent: "pi_v231_pending_refund",
          amount: 3000,
          currency: "usd",
          status: "pending",
          metadata: {},
        },
      },
    }, "whsec_v231_test");
    assert.equal(pendingRefund.response.status, 200, JSON.stringify(pendingRefund.payload));
    assert.equal(pendingRefund.payload.result.action, "aylamed_pending_refund_observed");
    assert.equal(pendingRefund.payload.result.enrollment_access_changed, false);
    const pendingRefundOverview = await api(baseUrl, "/api/ayla/admin/marketing", { adminToken });
    assert.equal(pendingRefundOverview.response.status, 200, JSON.stringify(pendingRefundOverview.payload));
    assert.deepEqual(
      pendingRefundOverview.payload.marketing.rewards
        .find((row) => row.id === "reward-pending-refund").admin_actions,
      ["cancel"],
    );
    const pendingRefundState = JSON.parse(await fs.readFile(aylaPath, "utf8"));
    assert.equal(
      pendingRefundState.aylaPayments["payment-pending-refund"].referral_reward_review_status,
      "refund_pending",
    );
    assert.equal(
      pendingRefundState.aylaReferralRewards["reward-pending-refund"].status,
      "pending_hold",
    );

    const released = await api(baseUrl, "/api/ayla/admin/marketing/rewards/release-eligible", {
      method: "POST",
      adminToken,
      body: {},
    });
    assert.equal(released.response.status, 200, JSON.stringify(released.payload));
    assert.equal(released.payload.released_count, 1);
    assert.equal(released.payload.rewards[0].id, "reward-ready");
    assert.equal(released.payload.auto_fulfilled, false);

    const earlyFulfill = await api(baseUrl, "/api/ayla/admin/marketing/rewards/reward-held", {
      method: "PATCH",
      adminToken,
      body: { action: "fulfill" },
    });
    assert.equal(earlyFulfill.response.status, 409, JSON.stringify(earlyFulfill.payload));
    assert.equal(earlyFulfill.payload.details.code, "REWARD_NOT_RELEASED");

    const refundedApprove = await api(baseUrl, "/api/ayla/admin/marketing/rewards/reward-refunded", {
      method: "PATCH",
      adminToken,
      body: { action: "approve" },
    });
    assert.equal(refundedApprove.response.status, 409, JSON.stringify(refundedApprove.payload));
    assert.equal(refundedApprove.payload.details.code, "REWARD_PAYMENT_INVALID");

    const pendingRefundApprove = await api(
      baseUrl,
      "/api/ayla/admin/marketing/rewards/reward-pending-refund",
      { method: "PATCH", adminToken, body: { action: "approve" } },
    );
    assert.equal(pendingRefundApprove.response.status, 409, JSON.stringify(pendingRefundApprove.payload));
    assert.equal(pendingRefundApprove.payload.details.code, "REWARD_PAYMENT_INVALID");

    const fulfilled = await api(baseUrl, "/api/ayla/admin/marketing/rewards/reward-ready", {
      method: "PATCH",
      adminToken,
      body: { action: "fulfill", note: "Manual test fulfilment" },
    });
    assert.equal(fulfilled.response.status, 200, JSON.stringify(fulfilled.payload));
    assert.equal(fulfilled.payload.reward.status, "fulfilled");
    assert.equal(fulfilled.payload.automatic_payment_or_access_change, false);

    const finalOverview = await api(baseUrl, "/api/ayla/admin/marketing", { adminToken });
    assert.equal(finalOverview.response.status, 200, JSON.stringify(finalOverview.payload));
    assert.equal(finalOverview.payload.marketing.metrics.share_views, 1);
    assert.equal(finalOverview.payload.marketing.metrics.whatsapp_shares, 1);
    assert.equal(finalOverview.payload.marketing.metrics.referred_signups, 2);
    assert.equal(finalOverview.payload.marketing.metrics.paid_conversions, 1);
    assert.equal(finalOverview.payload.marketing.metrics.attributed_revenue_cents, 3000);
    assert.equal(finalOverview.payload.marketing.metrics.rewards_fulfilled, 1);

    const refund = await stripeWebhook(baseUrl, {
      id: "evt_v231_refund",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_v231_refund",
          object: "charge",
          payment_intent: "pi_v231_referral",
          amount_refunded: 3000,
          currency: "usd",
          refunded: true,
          status: "succeeded",
          metadata: {},
        },
      },
    }, "whsec_v231_test");
    assert.equal(refund.response.status, 200, JSON.stringify(refund.payload));
    assert.equal(refund.payload.result.action, "aylamed_refund_recorded");
    assert.equal(refund.payload.result.matched, true);
    assert.equal(refund.payload.result.rewards_cancelled, 1);
    assert.equal(refund.payload.result.fulfilled_rewards_flagged, 1);
    assert.equal(refund.payload.result.milestones_reversed, 1);
    assert.equal(refund.payload.result.enrollment_access_changed, false);
    const afterRefundOverview = await api(baseUrl, "/api/ayla/admin/marketing", { adminToken });
    assert.equal(afterRefundOverview.response.status, 200, JSON.stringify(afterRefundOverview.payload));
    assert.equal(afterRefundOverview.payload.marketing.metrics.paid_conversions, 0);
    assert.equal(afterRefundOverview.payload.marketing.metrics.attributed_revenue_cents, 0);
    assert.equal(afterRefundOverview.payload.marketing.metrics.rewards_refund_review, 1);

    const blockedAfterRefund = await api(
      baseUrl,
      "/api/ayla/admin/marketing/referrals/attribution-seeded",
      { method: "PATCH", adminToken, body: { action: "block" } },
    );
    assert.equal(blockedAfterRefund.response.status, 200, JSON.stringify(blockedAfterRefund.payload));
    assert.equal(blockedAfterRefund.payload.attribution.status, "blocked");
    const restoredAfterRefund = await api(
      baseUrl,
      "/api/ayla/admin/marketing/referrals/attribution-seeded",
      { method: "PATCH", adminToken, body: { action: "restore" } },
    );
    assert.equal(restoredAfterRefund.response.status, 200, JSON.stringify(restoredAfterRefund.payload));
    assert.equal(restoredAfterRefund.payload.attribution.status, "attributed");

    const referralsPaused = await api(baseUrl, "/api/ayla/admin/marketing/settings", {
      method: "PUT",
      adminToken,
      body: {
        expected_revision: 2,
        settings: { program: { referrals_enabled: false } },
      },
    });
    assert.equal(referralsPaused.response.status, 200, JSON.stringify(referralsPaused.payload));
    const shareWithoutReferral = await api(
      baseUrl,
      "/api/ayla/students/student-referrer/readiness-shares",
      { method: "POST", token, body: { force_new: true } },
    );
    assert.equal(shareWithoutReferral.response.status, 201, JSON.stringify(shareWithoutReferral.payload));
    assert.equal(shareWithoutReferral.payload.share.referral_code, null);
    const noReferralToken = shareWithoutReferral.payload.share.share_url.split("/").at(-1);
    const publicWithoutReferral = await api(baseUrl, `/api/ayla/readiness-shares/${noReferralToken}`);
    assert.equal(publicWithoutReferral.response.status, 200, JSON.stringify(publicWithoutReferral.payload));
    assert.doesNotMatch(publicWithoutReferral.payload.share.cta_url, /[?&]ref=/);
    assert.match(publicWithoutReferral.payload.share.cta_url, /[?&]register=1/);

    const sharingPaused = await api(baseUrl, "/api/ayla/admin/marketing/settings", {
      method: "PUT",
      adminToken,
      body: {
        expected_revision: 3,
        settings: { program: { sharing_enabled: false } },
      },
    });
    assert.equal(sharingPaused.response.status, 200, JSON.stringify(sharingPaused.payload));
    const pausedPublic = await api(baseUrl, `/api/ayla/readiness-shares/${noReferralToken}`);
    assert.equal(pausedPublic.response.status, 410, JSON.stringify(pausedPublic.payload));
    const pausedCard = await api(baseUrl, `/api/ayla/readiness-shares/${noReferralToken}/card.svg`);
    assert.equal(pausedCard.response.status, 410, JSON.stringify(pausedCard.payload));
    const pausedOwnerEvent = await api(
      baseUrl,
      `/api/ayla/students/student-referrer/readiness-shares/${shareWithoutReferral.payload.share.id}/events`,
      { method: "POST", token, body: { type: "whatsapp_share" } },
    );
    assert.equal(pausedOwnerEvent.response.status, 410, JSON.stringify(pausedOwnerEvent.payload));
    const pausedCenter = await api(
      baseUrl,
      "/api/ayla/students/student-referrer/referral-center",
      { token },
    );
    assert.equal(pausedCenter.response.status, 200, JSON.stringify(pausedCenter.payload));
    assert.equal(
      pausedCenter.payload.shares
        .find((row) => row.id === shareWithoutReferral.payload.share.id)
        .copy.whatsapp_message,
      "",
    );

    const sharingResumed = await api(baseUrl, "/api/ayla/admin/marketing/settings", {
      method: "PUT",
      adminToken,
      body: {
        expected_revision: 4,
        settings: { program: { sharing_enabled: true } },
      },
    });
    assert.equal(sharingResumed.response.status, 200, JSON.stringify(sharingResumed.payload));
    const resumedPublic = await api(baseUrl, `/api/ayla/readiness-shares/${noReferralToken}`);
    assert.equal(resumedPublic.response.status, 200, JSON.stringify(resumedPublic.payload));

    const whatsappPaused = await api(baseUrl, "/api/ayla/admin/marketing/settings", {
      method: "PUT",
      adminToken,
      body: {
        expected_revision: 5,
        settings: { program: { whatsapp_enabled: false } },
      },
    });
    assert.equal(whatsappPaused.response.status, 200, JSON.stringify(whatsappPaused.payload));
    const publicWithWhatsappPaused = await api(baseUrl, `/api/ayla/readiness-shares/${noReferralToken}`);
    assert.equal(publicWithWhatsappPaused.response.status, 200, JSON.stringify(publicWithWhatsappPaused.payload));
    assert.equal(publicWithWhatsappPaused.payload.share.copy.whatsapp_message, "");
    const whatsappPausedEvent = await api(
      baseUrl,
      `/api/ayla/students/student-referrer/readiness-shares/${shareWithoutReferral.payload.share.id}/events`,
      { method: "POST", token, body: { type: "whatsapp_share" } },
    );
    assert.equal(whatsappPausedEvent.response.status, 403, JSON.stringify(whatsappPausedEvent.payload));
    assert.equal(whatsappPausedEvent.payload.details.code, "WHATSAPP_SHARING_DISABLED");

    const stored = JSON.parse(await fs.readFile(aylaPath, "utf8"));
    const referredUser = Object.values(stored.aylaUsers).find((row) => row.email === "referred@example.com");
    assert.ok(referredUser);
    assert.equal(referredUser.source_referral_code, referralCode);
    assert.equal(
      Object.values(stored.aylaReferralAttributions)
        .filter((row) => row.referred_user_id === referredUser.id).length,
      1,
    );
    const storedAttribution = Object.values(stored.aylaReferralAttributions)
      .find((row) => row.referred_user_id === referredUser.id);
    assert.equal(storedAttribution.campaign_id, campaignId);
    assert.deepEqual(storedAttribution.campaign_eligible_plan_ids, ["monthly"]);
    assert.equal(stored.aylaReferralRewards["reward-ready"].status, "fulfilled");
    assert.equal(stored.aylaReferralRewards["reward-ready"].refund_after_fulfillment, true);
    assert.equal(stored.aylaReferralRewards["reward-held"].status, "cancelled");
    assert.equal(stored.aylaPayments["payment-valid"].status, "refunded");
    assert.equal(
      stored.aylaPayments["payment-pending-refund"].referral_reward_review_status,
      "refund_pending",
    );
    assert.equal(stored.aylaReferralRewards["reward-pending-refund"].status, "cancelled");
    assert.equal(stored.aylaReferralMilestones["milestone-paid"].status, "reversed");
    assert.equal(stored.aylaReferralAttributions["attribution-seeded"].status, "attributed");
    assert.equal(await fs.readFile(livePath, "utf8"), liveSentinel);
    assert.equal(await fs.readFile(crmPath, "utf8"), crmSentinel);

    const accountDeleted = await api(baseUrl, "/api/ayla/users/user-referrer", {
      method: "DELETE",
      adminToken,
    });
    assert.equal(accountDeleted.response.status, 200, JSON.stringify(accountDeleted.payload));
    const oldPublicShare = await api(baseUrl, `/api/ayla/readiness-shares/${shareToken}`);
    assert.equal(oldPublicShare.response.status, 404, JSON.stringify(oldPublicShare.payload));
    const afterDeletion = JSON.parse(await fs.readFile(aylaPath, "utf8"));
    assert.equal(afterDeletion.aylaUsers["user-referrer"], undefined);
    assert.equal(afterDeletion.aylaReadinessShares[shareCreated.payload.share.id].status, "revoked");
    assert.equal(afterDeletion.aylaReadinessShares[shareCreated.payload.share.id].owner_user_id, null);
    assert.equal(afterDeletion.aylaReadinessShares[shareCreated.payload.share.id].owner_student_id, null);
    assert.notEqual(afterDeletion.aylaReadinessShares[shareCreated.payload.share.id].token, shareToken);
    const deletedReferralCode = Object.values(afterDeletion.aylaReferralCodes)
      .find((row) => row.code === referralCode);
    assert.equal(deletedReferralCode.status, "revoked");
    assert.equal(deletedReferralCode.owner_user_id, null);
    assert.equal(afterDeletion.aylaReferralAttributions["attribution-seeded"].status, "cancelled");
    assert.equal(afterDeletion.aylaReferralAttributions["attribution-seeded"].referrer_user_id, null);
    assert.equal(await fs.readFile(livePath, "utf8"), liveSentinel);
    assert.equal(await fs.readFile(crmPath, "utf8"), crmSentinel);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
