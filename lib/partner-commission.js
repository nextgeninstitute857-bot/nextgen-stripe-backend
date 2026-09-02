export function toMoneyCents(value = 0) {
  return Math.max(0, Math.round(Number(value || 0)));
}

export function estimateStripeProcessingFeeCents(grossPaymentCents = 0) {
  const gross = toMoneyCents(grossPaymentCents);
  return gross > 0 ? toMoneyCents(Math.round(gross * 0.029) + 30) : 0;
}

export function calculatePartnerPayoutBreakdown({
  grossPaymentCents = 0,
  stripeProcessingFeeCents = 0,
  commissionRatePercent = 20,
  instantPayoutFeePercent = 1.5,
} = {}) {
  const grossPayment = toMoneyCents(grossPaymentCents);
  const stripeProcessingFee = Math.min(grossPayment, toMoneyCents(stripeProcessingFeeCents));
  const commissionableNetRevenue = Math.max(0, grossPayment - stripeProcessingFee);
  const commissionRate = Math.max(0, Math.min(100, Number(commissionRatePercent || 0)));
  const payoutFeeRate = Math.max(0, Math.min(100, Number(instantPayoutFeePercent || 0)));
  const grossCommission = toMoneyCents(commissionableNetRevenue * (commissionRate / 100));
  const instantPayoutFee = toMoneyCents(grossCommission * (payoutFeeRate / 100));

  return {
    gross_payment_cents: grossPayment,
    stripe_processing_fee_cents: stripeProcessingFee,
    commissionable_net_revenue_cents: commissionableNetRevenue,
    commission_rate_percent: commissionRate,
    gross_commission_cents: grossCommission,
    instant_payout_fee_percent: payoutFeeRate,
    instant_payout_fee_cents: instantPayoutFee,
    partner_net_payout_cents: Math.max(0, grossCommission - instantPayoutFee),
  };
}
