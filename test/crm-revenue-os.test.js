import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLeadRevenueJourney,
  buildRevenueOsSnapshot,
  normalizeRevenueCountry,
} from "../lib/crm-revenue-os.js";

test("country values cannot be populated from greeting text", () => {
  assert.equal(normalizeRevenueCountry("Hi"), "Country not known");
  assert.equal(normalizeRevenueCountry("hello"), "Country not known");
  assert.equal(normalizeRevenueCountry("nigeria"), "Nigeria");
  assert.equal(normalizeRevenueCountry("rwanda"), "Rwanda");
  assert.equal(normalizeRevenueCountry("papua new guinea"), "Papua New Guinea");
  assert.equal(normalizeRevenueCountry("United Kingdom"), "United Kingdom");
});

test("a price question remains discovery and never fakes a payment step", () => {
  const journey = buildLeadRevenueJourney({
    lead: { id: "lead-price", name: "Doctor Lin", exam_type: "PLAB" },
    messages: [{ lead_id: "lead-price", direction: "inbound", text: "What is the price?", created_at: "2026-08-24T10:00:00Z" }],
    now: new Date("2026-08-24T10:01:00Z"),
  });
  assert.notEqual(journey.stage, "payment_ready");
  assert.equal(journey.stage, "new");
});

test("revenue journey advances from discovery to experience and payment", () => {
  const lead = { id: "lead-1", name: "Doctor Ada", exam_type: "USMLE Step 1", primary_concern: "weak areas", demo_started_at: "2026-08-24T10:00:00Z" };
  const messages = [
    { lead_id: "lead-1", direction: "inbound", text: "I need help with weak areas", created_at: "2026-08-24T09:00:00Z" },
    { lead_id: "lead-1", direction: "outbound", text: "Your roadmap and weak-area flashcards keep your work organised. Start the demo: https://nextgenusmle.live/demo", created_at: "2026-08-24T09:01:00Z" },
  ];
  const journey = buildLeadRevenueJourney({ lead, messages, now: new Date("2026-08-24T11:00:00Z") });
  assert.equal(journey.stage, "experienced");
  assert.ok(journey.progress_percent >= 75);
  assert.match(journey.next_action, /feedback/i);
});

test("snapshot exposes smart views, attribution, SLA, recurring revenue and honest AI/calling state", () => {
  const snapshot = buildRevenueOsSnapshot({
    now: new Date("2026-08-24T10:10:00Z"),
    leads: [
      { id: "lead-1", name: "Ada", exam_type: "Step 1", country: "Nigeria", source_platform: "meta", campaign_name: "Nigeria Step 1", email: "ada@example.com" },
      { id: "lead-2", name: "Bob", exam_type: "NCLEX", country: "Hi" },
    ],
    messages: [
      { id: "m1", lead_id: "lead-1", direction: "inbound", text: "How much is it?", created_at: "2026-08-24T10:00:00Z" },
    ],
    payments: [
      { id: "p1", customer_email: "ada@example.com", payment_status: "failed", amount_cents: 9900 },
    ],
    adPerformance: [{ platform: "meta", campaign_name: "Nigeria Step 1", country: "Nigeria", spend_usd: 20 }],
    recurring: { recurring_subscribers: 4, monthly_recurring_revenue_cents: 40000, estimated_remaining_recurring_commitment_cents: 120000 },
    aiLearning: [{ id: "gap-1", status: "needs_review", title: "Unanswered eligibility question" }],
    callProvider: { configured: false },
  });

  assert.equal(snapshot.summary.total_leads, 2);
  assert.equal(snapshot.summary.sla_overdue, 1);
  assert.equal(snapshot.summary.payment_rescue, 1);
  assert.equal(snapshot.summary.recurring_subscribers, 4);
  assert.equal(snapshot.ai.open_knowledge_gaps, 1);
  assert.equal(snapshot.calling.configured, false);
  assert.equal(snapshot.smart_views.find((view) => view.key === "country_unknown").count, 1);
  assert.equal(snapshot.smart_views.find((view) => view.key === "payment_rescue").count, 1);
  assert.equal(snapshot.attribution[0].source, "meta");
});
