import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  applyAylaConversationDecision, aylaPendingStudentText, buildAylaConversationPrompt,
  canonicalAylaCountry, createAylaConversationState, evaluateAylaConversationDecision,
  normalizeAylaConversationDecision,
} from "../lib/crm-ayla-conversation-engine.js";
import { aylaPaymentFollowupEligibility, hasExplicitPaymentCommitment, recordAylaPaymentFollowup } from "../lib/crm-conversation-followup.js";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const state = () => ({ ...createAylaConversationState(), stage: "discovery", turn_count: 2,
  facts: { name: "Test Student", exam: "USMLE Step 1", main_need: "Work-study balance", student_type: "prospective" } });
const candidate = (overrides = {}, current = state(), messages = []) => normalizeAylaConversationDecision({
  stage: current.stage, turn_goal: "specific_answer", intent: "answer_current_question",
  reply: "The available options are listed on the current programme page.", action: "reply_only", ask_field: "none",
  memory_patch: {}, ...overrides,
}, current, { messages, latestMessage: aylaPendingStudentText(messages) });

test("the first message's self-introduction is remembered without asking the name again", () => {
  const current = createAylaConversationState({ messages: [{ role: "student", text: "Hi, I am Daniel. Can I get information about your programme?" }] });
  assert.equal(current.facts.name, "Daniel");
  assert.equal(current.fact_sources.name, "conversation_self_reported");
  for (const words of ["I am in US", "I'm interested", "I am preparing for Step 1", "I am a doctor", "I am busy"]) {
    assert.equal(createAylaConversationState({ messages: [{ role: "student", text: words }] }).facts.name, null, words);
  }
});

test("a direct answer is allowed before the tour, including a yes to the previous specific offer", () => {
  for (const latest of ["How long is the programme?", "How much does it cost?", "Yes"]) {
    const messages = [{ role: "assistant", text: "I can explain the programme options." }, { role: "student", text: latest }];
    const reply = candidate({}, state(), messages);
    assert.deepEqual(evaluateAylaConversationDecision({ decision: reply, state: state(), messages }), [], latest);
    const bad = candidate({ action: "send_feature_tour", follow_up: "Start here: https://nextgenusmle.live/demo" }, state(), messages);
    assert.ok(evaluateAylaConversationDecision({ decision: bad, state: state(), messages }).includes("tour_interrupts_student_request"));
  }
});

test("first-turn questions and requested demo links do not wait for name collection or a tour", () => {
  const fresh = createAylaConversationState();
  const messages = [{ role: "student", text: "Please send the demo link" }];
  const reply = candidate({ turn_goal: "resource_request", action: "send_demo", reply: "Explore the real LMS here." }, fresh, messages);
  assert.equal(reply.action, "send_demo");
  assert.match(reply.reply, /https:\/\/nextgenusmle.live\/demo/);
  assert.deepEqual(evaluateAylaConversationDecision({ decision: reply, state: fresh, messages }), []);
  const known = state();
  assert.equal(candidate({ action: "send_demo", turn_goal: "resource_request" }, known, messages).action, "send_demo");
});

test("bare USMLE is not converted to Step 1 by a model guess", () => {
  const fresh = createAylaConversationState({ lead: { name: "Test Student" } });
  const messages = [{ role: "student", text: "USMLE" }];
  const reply = candidate({ turn_goal: "programme_overview", action: "send_feature_tour", memory_patch: { exam: "USMLE Step 1" } }, fresh, messages);
  assert.equal(reply.memory_patch.exam, "unknown");
  assert.ok(evaluateAylaConversationDecision({ decision: reply, state: fresh, messages }).includes("feature_tour_exam_unconfirmed"));
  for (const [text, exam] of [["Step 1", "USMLE Step 1"], ["Step 2 CK", "USMLE Step 2 CK"], ["USMLE 3", "USMLE Step 3"]]) {
    assert.equal(candidate({ memory_patch: { exam } }, fresh, [{ role: "student", text }]).memory_patch.exam, exam);
  }
});

test("split country and state messages are one pending turn and preserve country separately", () => {
  const messages = [{ direction: "outbound", message_text: "Where are you based?" },
    { direction: "inbound", message_text: "In US" }, { direction: "inbound", message_text: "California" }];
  assert.equal(aylaPendingStudentText(messages), "In US\nCalifornia");
  const current = state();
  const reply = candidate({ memory_patch: { country: "US", region: "California" } }, current, messages);
  const next = applyAylaConversationDecision({ state: current, decision: reply });
  assert.equal(next.facts.country, "United States");
  assert.equal(next.facts.region, "California");
  const bad = candidate({ memory_patch: { country: "California" } }, next, messages);
  assert.equal(applyAylaConversationDecision({ state: next, decision: bad }).facts.country, "United States");
});

test("country names are canonical and city/region/phone/ad hints are not confirmation", () => {
  for (const [input, expected] of [["USA", "United States"], ["U.S.", "United States"], ["United States of America", "United States"], ["UK", "United Kingdom"], ["UAE", "United Arab Emirates"], ["Yemen", "Yemen"]]) assert.equal(canonicalAylaCountry(input), expected);
  for (const input of ["California", "Aden", "Hello", "+1", "America", "unknown"]) assert.equal(canonicalAylaCountry(input), null);
  assert.equal(createAylaConversationState({ lead: { country: "California", country_confirmed: true } }).facts.country, null);
  assert.equal(createAylaConversationState({ lead: { country: "United States", country_source: "campaign" } }).facts.country, null);
});

test("explicitly requested recording/live links may be resent without allowing unsolicited repeats", () => {
  for (const [action, request] of [["send_recording", "Send the recording link again"], ["send_live_session", "Where is the live session link?"]]) {
    const current = { ...state(), stage: "demo_experience", completed_actions: ["send_feature_tour", action] };
    const messages = [{ role: "assistant", text: "CNS Day 2: https://nextgenusmle.live/student/recordings" }, { role: "student", text: request }];
    const reply = candidate({ turn_goal: "resource_request", action, reply: messages[0].text }, current, messages);
    assert.equal(reply.action, action);
    assert.deepEqual(evaluateAylaConversationDecision({ decision: reply, state: current, messages }), []);
    assert.equal(candidate({ action }, current, [{ role: "student", text: "Thanks" }]).action, "reply_only");
  }
});

test("prompt has request-first priority, current-turn fragments and no false completion claims", () => {
  const prompt = buildAylaConversationPrompt({ state: state(), messages: [{ role: "student", text: "In US" }, { role: "student", text: "California" }] });
  for (const phrase of ["Choose turn_goal", "previous promise", "not another feature pitch", "one location answer", "full system/topic", "do not infer that someone watched or enrolled", "not for all silent leads", "In US\nCalifornia"]) assert.ok(prompt.includes(phrase), phrase);
});

const now = Date.parse("2026-08-28T14:00:00Z");
const inbound = { id: "synthetic-in-1", text: "I will pay now", created_at: "2026-08-28T08:00:00Z" };
const outbound = { created_at: "2026-08-28T08:01:00Z" };
function paymentLead() {
  const lead = { id: "synthetic-lead" };
  recordAylaPaymentFollowup({ lead, inbound, now: "2026-08-28T08:01:00Z", decision: { payment_followup: { disposition: "payment_ready", evidence: inbound.text } } });
  return lead;
}
const eligible = (lead, overrides = {}) => aylaPaymentFollowupEligibility({ lead, latestInbound: inbound, latestOutbound: outbound, now, ...overrides });

test("ordinary interest, price questions, conditional intent and assistant promises never qualify for payment follow-up", () => {
  for (const words of ["Hi", "Interested", "How much?", "Send the demo", "If it works I will pay", "I will not pay", "I can't pay", "I have paid", "Maybe I will pay"]) assert.equal(hasExplicitPaymentCommitment(words), false, words);
  assert.equal(eligible({ id: "synthetic-lead", pending_payment: true }).ok, false);
  assert.equal(recordAylaPaymentFollowup({ lead: {}, inbound, decision: { payment_followup: { disposition: "payment_ready", evidence: "Ready to buy" } } }), false);
});

test("explicit payment readiness gets one follow-up after the promised wait, never an unanswered turn", () => {
  const lead = paymentLead();
  assert.equal(eligible(lead).ok, true);
  assert.equal(eligible(lead, { now: Date.parse("2026-08-28T10:00:00Z") }).reason, "waiting_4_to_5_hours");
  assert.equal(eligible(lead, { latestOutbound: {} }).reason, "student_message_waiting_for_reply");
  assert.equal(eligible(lead, { latestInbound: { ...inbound, id: "new-turn", text: "I changed my mind" } }).reason, "payment_context_changed");
  lead.ayla_payment_followup.sent_at = new Date(now).toISOString();
  assert.equal(eligible(lead).reason, "payment_followup_already_sent");
});

test("a promised later time including months later never becomes a four-hour chase", () => {
  const lead = paymentLead();
  lead.payment_promise_date = "2026-12-01T09:00:00Z";
  assert.equal(eligible(lead).reason, "respect_requested_followup_time");
  assert.equal(eligible(paymentLead(), { futureFollowups: [{ lead_id: "synthetic-lead", status: "scheduled", due_at: "2026-12-01T09:00:00Z" }] }).reason, "respect_requested_followup_time");
  const laterInbound = { ...inbound, text: "Contact me in December" };
  recordAylaPaymentFollowup({ lead, inbound: laterInbound, decision: { payment_followup: { disposition: "requested_later", evidence: laterInbound.text, requested_time: "December" } } });
  assert.equal(lead.ayla_payment_followup.status, "deferred");
  assert.equal(eligible(lead).ok, false);
});

test("AI follow-up permission must cite current student words, never its own outgoing pitch", () => {
  const messages = [{ role: "assistant", text: "You can pay today" }, { role: "student", text: "How much?" }];
  const reply = candidate({ payment_followup: { disposition: "payment_ready", evidence: "You can pay today" } }, state(), messages);
  assert.ok(evaluateAylaConversationDecision({ decision: reply, state: state(), messages }).includes("payment_followup_missing_student_evidence"));
});

test("one student cannot have overlapping AI turns, but other leads can be handled concurrently", () => {
  const source = server.slice(server.indexOf("function ngTryLockAiAuto"), server.indexOf("function ngReleaseAiAutoLock"));
  const locks = new Map();
  const lock = new Function("ngAiAutoLocks", "ngAiAutoGuardKey", "ngAiAutoMessageFingerprint", "normalizeCrmSendChannel", "NG_AI_AUTO_COOLDOWN_SECONDS", "NG_AI_AUTO_LOCK_TTL_SECONDS", `${source}; return ngTryLockAiAuto;`)(locks, ({ lead, inbound, channel }) => `${lead.id}:${inbound.id}:${channel}`, (m) => m.id, (c) => c, 15, 180);
  const request = { lead: { id: "one" }, inbound: { id: "a" }, channel: "whatsapp", ttlSeconds: 180 };
  assert.equal(lock(request).locked, true);
  assert.equal(lock({ ...request, inbound: { id: "b" } }).reason, "ai_auto_previous_turn_processing");
  assert.equal(lock({ ...request, lead: { id: "two" } }).locked, true);
  locks.delete("one:a:whatsapp");
  assert.equal(lock({ ...request, inbound: { id: "b" } }).locked, true);
});

test("late replies and failed messages do not hide a newer unanswered student message", () => {
  const source = server.slice(server.indexOf("function ngHasOutboundAfterInbound"), server.indexOf("function ngWithinHours"));
  const answered = new Function("safeArray", "ngMessageTimeMs", "ngAiAutoMessageFingerprint", "ngIsOutboundMessage", "ngMessageText", `${source}; return ngHasOutboundAfterInbound;`)((a) => a, (m) => Date.parse(m.created_at), (m) => m.id, (m) => m.direction === "outbound", (m) => m.text);
  const incoming = { id: "b", created_at: "2026-08-28T08:00:01Z" };
  const late = { direction: "outbound", text: "Older answer", created_at: "2026-08-28T08:00:10Z", metadata: { latest_inbound_id: "a" } };
  assert.equal(answered([late], incoming), false);
  assert.equal(answered([{ ...late, metadata: { latest_inbound_id: "b" } }], incoming), true);
  assert.equal(answered([{ ...late, metadata: { latest_inbound_id: "b" }, status: "failed" }], incoming), false);
  assert.equal(answered([{ ...late, metadata: {} }], incoming), true);
});

test("automatic reply path rechecks the conversation before sending and respects human takeover", () => {
  const path = server.slice(server.indexOf("async function ngAylaProcessFullAiAutoForLead"), server.indexOf("async function ngAylaRunPendingFullAiAuto"));
  assert.ok(path.includes("collecting_student_message_fragments"));
  assert.ok(path.indexOf("conversation_changed_before_send") > path.indexOf("await ngGenerateStudentAutoReply"));
  assert.ok(path.indexOf("conversation_changed_before_send") < path.indexOf("await sendCrmMessage"));
  assert.doesNotMatch(path, /NEXTGEN_AYLA_FORCE_AUTO_ON_INBOUND|lead.ai_mode = "auto"/);
});
