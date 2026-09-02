import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = fs.readFileSync(path.join(here, '..', 'server.js'), 'utf8');

test('partner outreach and channel readiness have persistent CRM collections', () => {
  assert.match(server, /partner_outreach: \[\]/);
  assert.match(server, /partner_channel_setup: \[\]/);
  assert.match(server, /route: "\/admin\/crm\/partner-outreach", collection: "partner_outreach"/);
  assert.match(server, /route: "\/admin\/crm\/partner-channel-setup", collection: "partner_channel_setup"/);
});

test('team members need community permissions and the partner module', () => {
  assert.match(server, /partner_outreach: \["community_intelligence", "manage_community_intelligence", "view_leads", "view_assigned_leads"\]/);
  assert.match(server, /partner_outreach: \["partner_outreach", "community_intelligence", "communities"\]/);
});

test('partner commission is transparent, net-of-Stripe, and deducts every instant payout fee', () => {
  assert.match(server, /upfront_rate_percent: 20/);
  assert.match(server, /commission_basis: "net_after_stripe_processing_fee"/);
  assert.match(server, /instant_payout_fee_percent: 1\.5/);
  assert.match(server, /commissionableNetRevenueCents = Math\.max\(0, grossPaymentCents - stripeProcessingFeeCents\)/);
  assert.match(server, /partnerNetPayoutCents = Math\.max\(0, calc\.commission_cents - instantPayoutFeeCents\)/);
  assert.match(server, /stripe\.paymentIntents\.retrieve\(id, \{ expand: \["latest_charge\.balance_transaction"\] \}\)/);
  assert.match(server, /payout_reference/);
});

test('affiliate portal has a self-service code route and privacy-safe dashboard data', () => {
  assert.match(server, /app\.post\("\/affiliate\/referral-code"/);
  assert.match(server, /Your master code is fixed after the first tracked referral/);
  assert.match(server, /maskEmail/);
  assert.match(server, /program_terms/);
  assert.match(server, /\/plans\?ref=/);
});
