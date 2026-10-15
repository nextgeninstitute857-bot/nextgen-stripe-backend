import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWebsitePurchaseEvent,
  buildWhatsAppAdEvent,
  pendingWhatsAppAdReports,
  markWhatsAppAdReported,
} from "../lib/meta-capi-events.js";

test("a paid Stripe checkout becomes a Purchase with value and hashed email", () => {
  const event = buildWebsitePurchaseEvent({
    id: "cs_test_1", payment_status: "paid", amount_total: 45000, currency: "usd",
    customer_details: { email: " Student@Example.com ", phone: "+1 (555) 010-0000" },
    metadata: { courseId: "course-1", planName: "Premium Live Batch" },
  }, { now: 1_700_000_000_000 });
  assert.equal(event.event_name, "Purchase");
  assert.equal(event.event_id, "nextgen-purchase-cs_test_1");
  assert.equal(event.action_source, "website");
  assert.deepEqual(event.custom_data.value, 450);
  assert.equal(event.custom_data.currency, "USD");
  assert.equal(event.user_data.em[0].length, 64);
  assert.notEqual(event.user_data.em[0], "student@example.com");
  assert.equal(event.event_time, 1_700_000_000);
});

test("unpaid, free or anonymous checkouts are not reported", () => {
  assert.equal(buildWebsitePurchaseEvent({ id: "cs_1", payment_status: "unpaid", amount_total: 100, customer_details: { email: "a@b.c" } }), null);
  assert.equal(buildWebsitePurchaseEvent({ id: "cs_2", payment_status: "paid", amount_total: 0, customer_details: { email: "a@b.c" } }), null);
  assert.equal(buildWebsitePurchaseEvent({ id: "cs_3", payment_status: "paid", amount_total: 100, customer_details: {} }), null);
});

test("a WhatsApp-ad lead is reported with its click id, once per stage", () => {
  const lead = { id: "lead-1", meta_ctwa_clid: "ARAkLk", stage: "paid_enrolled" };
  const pending = pendingWhatsAppAdReports([lead, { id: "lead-2", stage: "paid" }, { id: "lead-3", meta_ctwa_clid: "x", stage: "new_lead" }]);
  assert.deepEqual(pending.map((row) => [row.lead.id, row.eventName]), [["lead-1", "LeadSubmitted"], ["lead-1", "Purchase"]]);
  const event = buildWhatsAppAdEvent({ lead, eventName: "Purchase", wabaId: "916985444290332", value: 450 });
  assert.equal(event.action_source, "business_messaging");
  assert.equal(event.messaging_channel, "whatsapp");
  assert.deepEqual(event.user_data, { whatsapp_business_account_id: "916985444290332", ctwa_clid: "ARAkLk" });
  assert.equal(event.custom_data.value, 450);
  markWhatsAppAdReported(lead, "LeadSubmitted");
  markWhatsAppAdReported(lead, "Purchase");
  assert.equal(pendingWhatsAppAdReports([lead]).length, 0);
});

test("no WhatsApp event without a click id or business account", () => {
  assert.equal(buildWhatsAppAdEvent({ lead: { id: "a" }, eventName: "Purchase", wabaId: "1" }), null);
  assert.equal(buildWhatsAppAdEvent({ lead: { meta_ctwa_clid: "c" }, eventName: "Purchase", wabaId: "" }), null);
});
