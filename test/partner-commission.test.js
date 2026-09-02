import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculatePartnerPayoutBreakdown,
  estimateStripeProcessingFeeCents,
} from '../lib/partner-commission.js';

test('a $350 payment pays commission only after Stripe processing and instant-payout fees', () => {
  const stripeFee = estimateStripeProcessingFeeCents(35000);
  const result = calculatePartnerPayoutBreakdown({
    grossPaymentCents: 35000,
    stripeProcessingFeeCents: stripeFee,
    commissionRatePercent: 20,
    instantPayoutFeePercent: 1.5,
  });

  assert.deepEqual(result, {
    gross_payment_cents: 35000,
    stripe_processing_fee_cents: 1045,
    commissionable_net_revenue_cents: 33955,
    commission_rate_percent: 20,
    gross_commission_cents: 6791,
    instant_payout_fee_percent: 1.5,
    instant_payout_fee_cents: 102,
    partner_net_payout_cents: 6689,
  });
});

test('a $100 installment applies the same transparent order', () => {
  const result = calculatePartnerPayoutBreakdown({
    grossPaymentCents: 10000,
    stripeProcessingFeeCents: estimateStripeProcessingFeeCents(10000),
    commissionRatePercent: 20,
    instantPayoutFeePercent: 1.5,
  });

  assert.equal(result.stripe_processing_fee_cents, 320);
  assert.equal(result.commissionable_net_revenue_cents, 9680);
  assert.equal(result.gross_commission_cents, 1936);
  assert.equal(result.instant_payout_fee_cents, 29);
  assert.equal(result.partner_net_payout_cents, 1907);
});

test('fees can never make the partner payout negative', () => {
  const result = calculatePartnerPayoutBreakdown({
    grossPaymentCents: 30,
    stripeProcessingFeeCents: 30,
    commissionRatePercent: 20,
    instantPayoutFeePercent: 1.5,
  });
  assert.equal(result.partner_net_payout_cents, 0);
});
