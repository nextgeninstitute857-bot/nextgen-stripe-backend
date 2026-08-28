import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  experienceWaitHours, experienceDeliveryAccepted, experienceResourcesFromDelivery,
  recordExperienceShares, experienceMemory, experienceResponseViolations,
  recordExperienceResponse, acknowledgeExperienceConversation, experienceFollowupEligibility,
  buildExperienceCheckinPrompt, validateExperienceCheckin,
} from "../lib/crm-experience-followup.js";
import { runExperienceCheckin } from "../lib/crm-experience-scheduler.js";
import { NEXTGEN_WHATSAPP_TEMPLATE_PACK } from "../lib/crm-whatsapp-template-pack.js";
import { mutateJsonCopyOnWrite } from "../lib/json-copy-on-write.js";
import { createAylaConversationState, normalizeAylaConversationDecision, evaluateAylaConversationDecision, buildAylaConversationPrompt, aylaExplicitHumanHandoffRequest, aylaConversationTextFormat, AYLA_CONVERSATION_DECISION_SCHEMA } from "../lib/crm-ayla-conversation-engine.js";

const shared = "2026-08-27T14:00:00Z";
const now = Date.parse("2026-08-27T20:00:00Z");
const incoming = { id: "synthetic-in-1", created_at: "2026-08-27T13:59:00Z", text: "Please send the recording" };
const outgoing = { id: "synthetic-out-1", created_at: shared };
const resource = { kind: "recording", id: "cns-day2", title: "Central Nervous System — Day 2", url: "https://nextgenusmle.live/recording/cns-day2", channel: "whatsapp" };
const accepted = (text, extra = {}) => ({ channel: "whatsapp", status: "sent", log: { id: "log-1", text, sent_at: shared, provider_message_id: "synthetic-provider-id" }, ...extra });
function freshLead(resources = [resource]) {
  const lead = { id: "synthetic-lead", name: "Test Student", ai_mode: "auto", status: "new_lead", payment_status: "unpaid", enrollment_status: "not_enrolled" };
  recordExperienceShares({ lead, resources, inbound: incoming, now: shared });
  return lead;
}
const eligible = (lead, extra = {}) => experienceFollowupEligibility({ lead, latestInbound: incoming, latestOutbound: outgoing, now, ...extra });
const response = (item, outcome = "used", evidence = "I watched it and liked it", feedback = "positive") => ({ item_id: item.id, outcome, feedback, evidence, requested_time: null });

test("only actual accepted link delivery creates experience resources, never an unsent draft or picture", () => {
  const snapshot = { latest_recording: resource, demo_url: "https://nextgenusmle.live/demo" };
  assert.equal(experienceResourcesFromDelivery({ snapshot, results: [accepted(resource.url)] })[0].title, resource.title);
  for (const result of [{ success: true }, accepted(resource.url, { queued: true }), accepted(resource.url, { status: "failed" }), accepted(resource.url, { skipped: true }), accepted("Here is a picture of the recording library.")]) {
    assert.deepEqual(experienceResourcesFromDelivery({ snapshot, results: [result] }), []);
  }
  assert.equal(experienceResourcesFromDelivery({ snapshot, results: [accepted(`${snapshot.demo_url} ${resource.url}`)] }).length, 2);
  assert.equal(experienceResourcesFromDelivery({ snapshot, results: [accepted(`${resource.url}-different-resource`)] }).length, 0);
  assert.equal(experienceDeliveryAccepted({ success: true, status: "sent", log: {} }), false);
  const template = accepted(resource.url);
  template.log.metadata = { whatsapp_template_name: "nextgen_recording_notes_ready", components: [] };
  assert.equal(experienceResourcesFromDelivery({ snapshot, results: [template] }).length, 0);
  template.log.metadata.components = [{ type: "body", parameters: [{ type: "text", text: resource.url }] }];
  assert.equal(experienceResourcesFromDelivery({ snapshot, results: [template] }).length, 1);
});

test("sharing stores exact resource and pending timer, not watched/activated/enrolled", () => {
  const lead = freshLead();
  const item = lead.ayla_experience_followups[0];
  assert.equal(item.status, "pending");
  assert.equal(item.outcome, "unknown");
  assert.equal(item.due_at, new Date(now).toISOString());
  assert.equal(item.title, resource.title);
  assert.equal(item.url, resource.url);
  assert.equal(lead.enrolled, undefined);
  assert.equal(eligible(lead).ok, true, "unpaid/not_enrolled must not be mistaken for paid/enrolled");
  assert.equal(eligible(lead, { now: now - 1 }).reason, "not_due");
  assert.equal(experienceWaitHours(undefined), 6);
  assert.equal(experienceWaitHours(4.5), 6);
  assert.equal(experienceWaitHours(24), 24);
});

test("managed static template buttons track the actual demo/library URL and exact sent session name", () => {
  const result = accepted("Ignored planned message with a different URL");
  result.log.metadata = { whatsapp_template_name: "nextgen_recording_notes_ready", components: [{ type: "body", parameters: [{ type: "text", text: "Test Student" }, { type: "text", text: resource.title }] }] };
  const shared = experienceResourcesFromDelivery({ results: [result], templateDefinitions: NEXTGEN_WHATSAPP_TEMPLATE_PACK });
  assert.equal(shared[0].title, resource.title);
  assert.equal(shared[0].url, "https://nextgenusmle.live/student/recordings");
  result.log.metadata = { whatsapp_template_name: "nextgen_warm_welcome", components: [] };
  assert.equal(experienceResourcesFromDelivery({ results: [result], templateDefinitions: NEXTGEN_WHATSAPP_TEMPLATE_PACK })[0].kind, "demo");
  result.log.metadata.whatsapp_template_name = "unrecognized_template";
  assert.deepEqual(experienceResourcesFromDelivery({ results: [result], templateDefinitions: NEXTGEN_WHATSAPP_TEMPLATE_PACK }), []);
});

test("repeated links do not restart the timer and a newer recording supersedes only the old pending item", () => {
  const lead = freshLead();
  assert.equal(recordExperienceShares({ lead, resources: [resource], now: new Date(now).toISOString() }).length, 0);
  assert.equal(recordExperienceShares({ lead, resources: [{ ...resource, id: null }], now: new Date(now).toISOString() }).length, 0);
  assert.equal(lead.ayla_experience_followups[0].shared_at, shared);
  recordExperienceShares({ lead, resources: [{ ...resource, id: "day3", title: "CNS — Day 3" }], now: new Date(now).toISOString() });
  assert.equal(lead.ayla_experience_followups[0].status, "superseded");
  assert.equal(lead.ayla_experience_followups[1].status, "pending");
});

test("class follow-up cannot run before the session; an unknown schedule is held", () => {
  const lead = freshLead([{ ...resource, kind: "live_session", starts_at: "2026-08-29T14:00:00Z" }]);
  assert.equal(lead.ayla_experience_followups[0].due_at, "2026-08-29T16:00:00.000Z");
  assert.equal(eligible(lead).reason, "not_due");
  const unknown = freshLead([{ ...resource, kind: "live_session" }]);
  assert.equal(unknown.ayla_experience_followups[0].status, "schedule_unverified");
  assert.equal(eligible(unknown).ok, false);
});

test("all experience outcomes require the student's words and a real shared item", () => {
  for (const [outcome, words, feedback] of [
    ["used", "I watched it and liked it", "positive"],
    ["used", "I tried it but the pace was too fast", "negative"],
    ["used", "I watched it", "unknown"],
    ["partly_used", "I watched half during my break", "unknown"],
    ["not_used", "Not yet, my shift ran late", "unknown"],
    ["declined", "I don't want that recording", "unknown"],
  ]) {
    const lead = freshLead();
    const item = lead.ayla_experience_followups[0];
    const inbound = { id: "response-2", created_at: new Date(now).toISOString(), text: words };
    assert.equal(recordExperienceResponse({ lead, response: response(item, outcome, words, feedback), inbound, studentText: words, now: new Date(now).toISOString() }), true);
    assert.equal(item.outcome, outcome);
    assert.equal(item.evidence_source, "student_self_report");
    assert.equal(item.feedback, feedback);
    assert.equal(eligible(lead).ok, false);
    assert.equal(lead.is_enrolled, undefined);
  }
  const lead = freshLead();
  assert.ok(experienceResponseViolations({ response: response({ id: "never-shared" }), items: lead.ayla_experience_followups, studentText: "I watched it and liked it" }).includes("experience_resource_not_shared"));
  assert.ok(experienceResponseViolations({ response: response(lead.ayla_experience_followups[0]), items: lead.ayla_experience_followups, studentText: "Not yet" }).includes("experience_missing_student_evidence"));
});

test("a first recording request cannot create feedback or abort an otherwise valid reply", () => {
  const text = "Hi, I'm Sarah, preparing for USMLE Step 1 in the United States. I work nights and would like to watch a recording.";
  const messages = [{ role: "student", text }];
  const state = createAylaConversationState({ lead: {}, messages });
  for (const outcome of ["not_used", "used", "partly_used", "remind_later"]) {
    const decision = normalizeAylaConversationDecision({
      turn_goal: "resource_request", action: "send_recording", reply: `Here is ${resource.title}: ${resource.url}`,
      experience_response: { item_id: "invented-live-catalogue-id", outcome, feedback: "positive", evidence: null, requested_time: "tomorrow" },
    }, state, { messages });
    assert.deepEqual(decision.experience_response, { item_id: null, outcome: "none", feedback: "unknown", evidence: null, requested_time: null });
    assert.ok(!evaluateAylaConversationDecision({ state, decision, messages }).some((v) => v.startsWith("experience_")));
    const lead = {};
    assert.equal(recordExperienceResponse({ lead, response: decision.experience_response, studentText: text, inbound: { id: "first-request" } }), false);
    assert.equal(lead.ayla_experience_followups, undefined);
  }
});

test("structured generation limits feedback to actual shared IDs without mutating the global schema", () => {
  const lead = freshLead();
  const item = lead.ayla_experience_followups[0];
  const schemaBefore = JSON.stringify(AYLA_CONVERSATION_DECISION_SCHEMA);
  const first = aylaConversationTextFormat().schema.properties.experience_response.properties;
  assert.deepEqual(first.item_id.enum, [null]);
  assert.deepEqual(first.outcome.enum, ["none"]);
  assert.deepEqual(first.evidence.enum, [null]);
  const next = aylaConversationTextFormat({ experiences: [item] }).schema.properties.experience_response.properties;
  assert.deepEqual(next.item_id.enum, [null, item.id]);
  assert.ok(next.outcome.enum.includes("partly_used"));
  assert.equal(next.evidence.enum, undefined);
  assert.equal(JSON.stringify(AYLA_CONVERSATION_DECISION_SCHEMA), schemaBefore);
  const text = "Not yet, my shift ran late.";
  const state = createAylaConversationState({ lead });
  const good = normalizeAylaConversationDecision({ experience_response: response(item, "not_used", text, "unknown") }, state);
  assert.equal(good.experience_response.outcome, "not_used");
  assert.deepEqual(experienceResponseViolations({ response: good.experience_response, items: [item], studentText: text }), []);
  const bad = normalizeAylaConversationDecision({ experience_response: response({ id: "invented" }, "used", "I watched it", "positive") }, state);
  assert.ok(experienceResponseViolations({ response: bad.experience_response, items: [item], studentText: text }).includes("experience_resource_not_shared"));
  assert.ok(experienceResponseViolations({ response: bad.experience_response, items: [item], studentText: text }).includes("experience_missing_student_evidence"));
});

test("an answered thanks is not use and does not silently cancel the timer; an unanswered new message blocks it", () => {
  const lead = freshLead();
  const thanks = { id: "thanks-2", created_at: "2026-08-27T14:02:00Z", text: "Thanks" };
  assert.equal(eligible(lead, { latestInbound: thanks }).reason, "student_replied_since_share");
  acknowledgeExperienceConversation({ lead, inbound: thanks });
  assert.equal(lead.ayla_experience_followups[0].outcome, "unknown");
  assert.equal(eligible(lead, { latestInbound: thanks, latestOutbound: { id: "out-2", created_at: "2026-08-27T14:03:00Z" } }).ok, true);
  assert.equal(eligible(lead, { latestInbound: thanks, latestOutbound: outgoing }).reason, "student_waiting_for_reply");
});

test("later promises, payment-ready reminders, mentor handoff, and every stop condition block check-ins", () => {
  const cases = [
    [{ opted_out: true }, "contact_stopped"], [{ do_not_contact: true }, "contact_stopped"],
    [{ status: "not_interested" }, "contact_stopped"], [{ ai_mode: "manual" }, "human_takeover"],
    [{ automation_mode: "draft" }, "human_takeover"], [{ ai_enabled: false }, "human_takeover"],
    [{ status: "paid_enrolled" }, "already_enrolled"], [{ enrolled: true }, "already_enrolled"],
    [{ has_active_enrollment: true }, "already_enrolled"], [{ google_meet_requested: true }, "mentor_handoff_active"],
    [{ ayla_payment_followup: { status: "pending" } }, "payment_followup_has_priority"],
    [{ next_follow_up_at: "2026-12-01T09:00:00Z" }, "respect_requested_followup_time"],
  ];
  for (const [patch, reason] of cases) assert.equal(eligible({ ...freshLead(), ...patch }).reason, reason);
  const lead = freshLead();
  const words = "Remind me in December when I finish my rotation";
  const item = lead.ayla_experience_followups[0];
  assert.equal(recordExperienceResponse({ lead, response: { ...response(item, "remind_later", words, "unknown"), requested_time: "in December when I finish my rotation" }, inbound: { id: "later" }, studentText: words }), true);
  assert.equal(item.status, "deferred");
  assert.equal(item.requested_time, "in December when I finish my rotation");
  assert.equal(eligible(lead).ok, false);
});

test("24-hour boundary never uses a welcome/payment template or treats a link click as a new student message", () => {
  const lead = freshLead();
  const boundary = Date.parse(incoming.created_at) + 24 * 3600000;
  assert.equal(eligible(lead, { now: boundary - 1 }).ok, true);
  assert.equal(eligible(lead, { now: boundary }).reason, "experience_template_required");
  lead.demo_clicked_at = new Date(boundary).toISOString();
  assert.equal(eligible(lead, { now: boundary }).reason, "experience_template_required");
  assert.equal(eligible(lead, { latestInbound: {} }).reason, "no_student_conversation");
});

test("prompt receives exact experience memory and branches on meaning without forcing a pitch or a mentor booking", () => {
  const lead = freshLead();
  const state = createAylaConversationState({ lead });
  assert.equal(state.experiences[0].id, lead.ayla_experience_followups[0].id);
  const prompt = buildAylaConversationPrompt({ lead, state });
  for (const text of ["I watched half during my break", "never verified player analytics", "ask naturally how they found", "Never book or begin handoff", "answer that concern first", "Never reuse the old stored session as today's class", "more than one shared item", "not the entire sales pitch"]) assert.ok(prompt.includes(text), text);
  assert.equal(experienceMemory(lead)[0].outcome, "unknown");
  const messages = [{ role: "student", text: "I watched it and liked it" }];
  const decision = normalizeAylaConversationDecision({ turn_goal: "specific_answer", action: "reply_only", reply: "Great to hear. Would you like to discuss the enrollment options?", experience_response: response(state.experiences[0]) }, state, { messages });
  assert.ok(!evaluateAylaConversationDecision({ state, decision, messages }).some((v) => v.startsWith("experience_")));
  decision.experience_response.item_id = "invented";
  assert.ok(evaluateAylaConversationDecision({ state, decision, messages }).includes("experience_resource_not_shared"));
});

test("check-in copy asks about the exact resource and does not send extra links", () => {
  const item = freshLead().ayla_experience_followups[0];
  const text = `Hi! Have you had a chance to watch ${item.title}?`;
  assert.equal(validateExperienceCheckin(text, item), true);
  for (const bad of ["Have you watched it?", `${text} https://nextgenusmle.live/demo`, `${text} Did you like it?`, `You watched ${item.title}, shall I book you?`]) assert.equal(validateExperienceCheckin(bad, item), false, bad);
  assert.match(buildExperienceCheckinPrompt({ item }), /no claim they watched\/enrolled/);
});

test("polite mentor requests start the supported handoff instead of denying it", () => {
  const state = createAylaConversationState({ lead: freshLead() });
  for (const text of [
    "Could I have a call with a mentor before deciding?",
    "May I please get a consultation with your mentor?",
    "Can I have a call with a mentor?",
    "What is the price, and could I have a call with a mentor?",
  ]) {
    assert.equal(aylaExplicitHumanHandoffRequest(text), true, text);
    const messages = [{ role: "student", text }];
    const denied = normalizeAylaConversationDecision({ turn_goal: "specific_answer", action: "reply_only", reply: "I cannot arrange a call directly at this moment." }, state, { messages });
    assert.ok(evaluateAylaConversationDecision({ state, decision: denied, messages }).includes("requested_mentor_handoff_not_started"));
    const handoff = normalizeAylaConversationDecision({ turn_goal: "human_handoff", action: "begin_human_handoff", ask_field: "email", intent: "pricing_question", reply: "What email should we use for your mentor request?" }, state, { messages });
    const violations = evaluateAylaConversationDecision({ state, decision: handoff, messages });
    assert.ok(!violations.includes("requested_mentor_handoff_not_started"));
    assert.ok(!violations.includes("premature_handoff_without_explicit_request"));
    assert.ok(!violations.includes("pricing_question_forced_handoff"));
  }
  for (const text of ["I don't want a mentor call", "No call please", "I watched the mentor's video", "I might want a call later, not now"]) {
    assert.equal(aylaExplicitHumanHandoffRequest(text), false, text);
  }
});

test("not-yet feedback does not resend a long recording URL, but explicit resend still works", () => {
  const state = createAylaConversationState({ lead: freshLead() });
  for (const [text, repeats] of [["Not yet, my shift ran late.", true], ["Please send the recording link again.", false]]) {
    const messages = [{ role: "student", text }];
    const decision = normalizeAylaConversationDecision({ turn_goal: "specific_answer", action: "reply_only", reply: `Here is ${resource.title}: ${resource.url}` }, state, { messages });
    assert.equal(evaluateAylaConversationDecision({ state, decision, messages }).includes("unsolicited_recording_link_repeat"), repeats);
  }
});

test("the live rehearsal's vague resource/help endings cannot pass as a useful next step", () => {
  const state = createAylaConversationState({ lead: freshLead() });
  for (const reply of [
    "Let me know if you need more resources or assistance!",
    "Let me know if you want another recording or have any questions about your preparation!",
    "Let me know how I can assist you further!",
  ]) {
    const decision = normalizeAylaConversationDecision({ turn_goal: "specific_answer", action: "reply_only", reply }, state);
    assert.ok(evaluateAylaConversationDecision({ state, decision, messages: [{ role: "student", text: "Not yet" }] }).includes("vague_handback_ending"));
  }
  const prompt = buildAylaConversationPrompt({ state });
  assert.match(prompt, /used or partly used/);
  assert.match(prompt, /pause\/replay/);
  assert.match(prompt, /collects a request, not a confirmed appointment/);
});

test("a natural acceptance of one mentor-call offer works, but liking a recording or declining does not book a handoff", () => {
  const state = createAylaConversationState({ lead: { name: "Test Student", exam: "USMLE Step 1" } });
  const offer = "Would you like a call with our mentor?";
  for (const words of ["Yes please", "That would help"]) {
    const messages = [{ role: "assistant", text: offer }, { role: "student", text: words }];
    const decision = normalizeAylaConversationDecision({ turn_goal: "handoff", action: "begin_human_handoff", reply: "What time would suit you?", handoff_consent: { accepted_offer: true, evidence: words, offer } }, state, { messages });
    assert.ok(!evaluateAylaConversationDecision({ state, decision, messages }).includes("premature_handoff_without_explicit_request"));
  }
  for (const [previous, words, claimedOffer] of [["Did you like the recording?", "Yes", offer], ["Would you like to enroll or have a mentor call?", "Yes", "Would you like to enroll or have a mentor call?"], [offer, "No thanks", offer]]) {
    const messages = [{ role: "assistant", text: previous }, { role: "student", text: words }];
    const decision = normalizeAylaConversationDecision({ turn_goal: "handoff", action: "begin_human_handoff", reply: "What time would suit you?", handoff_consent: { accepted_offer: true, evidence: words, offer: claimedOffer } }, state, { messages });
    assert.ok(evaluateAylaConversationDecision({ state, decision, messages }).includes("premature_handoff_without_explicit_request"));
  }
  for (const words of ["I don't want a mentor call", "No mentor call please", "Can we have the call later, not now?"]) assert.equal(aylaExplicitHumanHandoffRequest(words), false);
});

function harness(patch = {}) {
  let db = { leads: [freshLead()], incoming: structuredClone(incoming), outgoing: structuredClone(outgoing), reviews: [], sent: [] };
  const context = (db, id) => ({ db, lead: db.leads.find((row) => row.id === id) || {}, latestInbound: db.incoming, latestOutbound: db.outgoing, channel: "whatsapp", futureFollowups: [] });
  let generated = 0;
  const deps = { leadId: "synthetic-lead", read: async () => structuredClone(db), context,
    mutate: async (fn) => { const mutation = await mutateJsonCopyOnWrite(db, fn); db = mutation.value; return mutation.result; },
    generate: async (_, item) => { generated++; return `Hi! Have you had a chance to watch ${item.title}?`; },
    send: async ({ db, reply }) => { db.sent.push(reply); db.outgoing = { id: "checkin-1", created_at: new Date(now).toISOString() }; return accepted(reply); },
    review: (db, lead, item, reason) => { item.review_reason = reason; db.reviews.push({ id: item.id, reason }); },
    lock: () => ({ locked: true, key: "test-lock" }), unlock: () => {}, now: () => now, ...patch,
  };
  return { deps, get db() { return db; }, get generated() { return generated; }, run: () => runExperienceCheckin(deps) };
}

test("full scheduler sends once, persists provider receipt and leaves enrollment/student data alone", async () => {
  const h = harness();
  h.db.leads[0].learning_progress = { revision: 14 };
  assert.equal((await h.run()).sent, true);
  assert.equal(h.db.sent.length, 1);
  assert.equal(h.db.leads[0].ayla_experience_followups[0].status, "checkin_sent");
  assert.equal(h.db.leads[0].ayla_experience_followups[0].outcome, "unknown");
  assert.equal(h.db.leads[0].ayla_experience_followups[0].provider_message_id, "synthetic-provider-id");
  assert.deepEqual(h.db.leads[0].learning_progress, { revision: 14 });
  assert.equal((await h.run()).sent, false);
  assert.equal(h.db.sent.length, 1);
});

test("one batch of demo and recording gets one check-in, not one per link", async () => {
  const h = harness();
  recordExperienceShares({ lead: h.db.leads[0], resources: [{ kind: "demo", title: "7-day demo", url: "https://nextgenusmle.live/demo" }], inbound: incoming, now: shared });
  assert.equal((await h.run()).sent, true);
  assert.deepEqual(h.db.leads[0].ayla_experience_followups.map((r) => r.status), ["checkin_sent", "superseded"]);
  assert.equal((await h.run()).sent, false);
});

test("a new student reply, human takeover or outbound during AI generation cancels the check-in", async () => {
  for (const change of [
    (h) => { h.db.incoming = { id: "new-student-message", created_at: new Date(now).toISOString() }; },
    (h) => { h.db.leads[0].ai_mode = "manual"; },
    (h) => { h.db.leads[0].enrolled = true; },
    (h) => { h.db.outgoing = { id: "daily-invite", created_at: new Date(now).toISOString() }; },
  ]) {
    const h = harness();
    h.deps.generate = async (_, item) => { change(h); return `Have you had a chance to watch ${item.title}?`; };
    assert.equal((await h.run()).reason, "conversation_changed_before_checkin");
    assert.equal(h.db.sent.length, 0);
  }
});

test("outside the window creates a single review task and never invokes AI or provider", async () => {
  const h = harness({ now: () => Date.parse(incoming.created_at) + 24 * 3600000 });
  for (let i = 0; i < 3; i++) assert.equal((await h.run()).reason, "experience_template_required");
  assert.equal(h.db.reviews.length, 1);
  assert.equal(h.generated, 0);
  assert.equal(h.db.sent.length, 0);
});

test("invalid generated copy and provider uncertainty cannot claim success or cause repeat deliveries", async () => {
  const bad = harness({ generate: async () => "Have you watched it?" });
  assert.equal((await bad.run()).reason, "experience_draft_needs_review");
  assert.equal(bad.db.sent.length, 0);
  assert.equal((await bad.run()).reason, "attempt_cooldown");
  const failed = harness({ send: async () => { throw new Error("connection lost after send"); } });
  assert.equal((await failed.run()).sent, false);
  assert.equal(failed.db.leads[0].ayla_experience_followups[0].status, "needs_delivery_review");
  assert.equal(failed.db.leads[0].ayla_experience_followups[0].checkin_sent_at, null);
  assert.equal((await failed.run()).sent, false);
  assert.equal(failed.db.reviews.length, 1);
});

test("a crash after a durable reservation cannot send the same check-in on restart", async () => {
  const h = harness();
  const mutate = h.deps.mutate;
  let calls = 0;
  h.deps.mutate = async (fn) => { if (++calls === 2) throw new Error("simulated process crash"); return mutate(fn); };
  await assert.rejects(h.run(), /process crash/);
  assert.ok(h.db.leads[0].ayla_experience_followups[0].reservation_id);
  h.deps.mutate = mutate;
  assert.equal((await h.run()).reason, "delivery_reserved_needs_review");
  assert.equal(h.db.sent.length, 0);
  assert.equal(h.db.reviews.length, 1);
});

test("production wiring remains separate from payment flow, with a read-only admin queue and atomic delivery", () => {
  const source = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(source, /runExperienceCheckin\(\{[\s\S]*?mutate: mutateCrmDb/);
  assert.match(source, /app.get\("\/admin\/crm\/automation\/experience-followups"/);
  assert.match(source, /outside_window: "approved_experience_template_required"/);
  const activation = source.slice(source.indexOf("function ngExperienceFollowupsEnabled"), source.indexOf("let NG_EXPERIENCE_TEMPLATE_CACHE"));
  const enabled = new Function("settings", "process", `${activation}; return ngExperienceFollowupsEnabled(settings);`);
  for (const [settings, env, expected] of [
    [{}, {}, false],
    [{ experience_followup_enabled: true }, {}, true],
    [{}, { NEXTGEN_EXPERIENCE_FOLLOWUP_ENABLED: "true" }, true],
    [{ experience_followup_enabled: false }, { NEXTGEN_EXPERIENCE_FOLLOWUP_ENABLED: "true" }, false],
    [{ experience_followup_enabled: true }, { NEXTGEN_EXPERIENCE_FOLLOWUP_ENABLED: "false" }, false],
  ]) assert.equal(enabled(settings, { env }), expected);
  assert.match(source, /const experienceResults = runExperienceChecks \? await ngRunExperienceFollowups/);
  assert.match(source, /const templateKey = "nextgen_payment_ready_followup"/);
  const runner = source.slice(source.indexOf("async function ngRunExperienceFollowups"), source.indexOf('app.get("/admin/crm/automation/experience-followups"'));
  assert.match(runner, /templateId: null/);
  assert.doesNotMatch(runner, /nextgen_warm_welcome|nextgen_payment_ready_followup/);
});

test("outside-window scheduler uses the exact approved template, never an AI draft, and sends only once", async () => {
  const { EXPERIENCE_TEMPLATE } = await import("../lib/crm-experience-template.js");
  const later = Date.parse(incoming.created_at) + 24 * 3600000;
  const h = harness({ now: () => later });
  h.db.leads[0].phone = "+447700900123";
  h.db.leads[0].whatsapp_followup_consent = { status: "granted", scope: "programme_experience", source: "student_message", evidence: "Please check back about the demo", recorded_at: incoming.created_at };
  const originalContext = h.deps.context;
  h.deps.context = (db, id) => ({ ...originalContext(db, id), templatePolicy: { enabled: true, ownerApproved: true, checkedAt: new Date(later).toISOString(), template: { id: "test-meta-template", name: EXPERIENCE_TEMPLATE.name, language: "en_US", status: "APPROVED", category: "MARKETING", components: [{ type: "BODY", text: EXPERIENCE_TEMPLATE.body }] } } });
  const originalSend = h.deps.send;
  let template;
  h.deps.send = (args) => { template = args.template; return originalSend(args); };
  assert.equal((await h.run()).sent, true);
  assert.equal(h.generated, 0);
  assert.equal(template.templateName, EXPERIENCE_TEMPLATE.name);
  assert.match(h.db.sent[0], /Reply STOP/);
  assert.equal((await h.run()).sent, false);
  assert.equal(h.db.sent.length, 1);
});

test("a reply-window boundary crossed during generation cannot send free text outside 24 hours", async () => {
  let clock = Date.parse(incoming.created_at) + 24 * 3600000 - 1;
  const h = harness({ now: () => clock });
  h.deps.generate = async (_, item) => { clock += 10; return `Have you had a chance to watch ${item.title}?`; };
  assert.equal((await h.run()).sent, false);
  assert.equal(h.db.sent.length, 0);
});
