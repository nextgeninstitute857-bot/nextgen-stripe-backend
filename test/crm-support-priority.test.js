import assert from 'node:assert/strict';
import test from 'node:test';
import { createAylaConversationState, normalizeAylaConversationDecision, evaluateAylaConversationDecision, buildAylaConversationRepairPrompt } from '../lib/crm-ayla-conversation-engine.js';

const state = createAylaConversationState({lead: {name: 'Sarah', exam: 'USMLE Step 1'}});
const support = { turn_goal: 'support', stage: 'enrolled_support', action: 'support_handoff', ask_field: 'none', reply: 'I can help route the login problem to support. What email is registered on your account?', memory_patch: {student_type: 'enrolled'} };
const check = (text, proposed = support) => {
  const messages = [{role:'student', text}];
  const decision = normalizeAylaConversationDecision(proposed, state, {messages, latestMessage:text});
  return {decision, violations: evaluateAylaConversationDecision({decision, state, messages})};
};

test('login and access complaints never force a demo link or marketing action', () => {
  for (const text of [
    'I am Sarah, an enrolled Step 1 student in the US. The login page says Failed to fetch and I cannot access my recordings. I need support, not another demo.',
    'I cannot access the LMS. Please help with my login.',
    'My dashboard will not open; I already paid.',
    'I need account access, not a trial.',
  ]) {
    const result = check(text);
    assert.deepEqual(result.violations, [], text);
    assert.equal(result.decision.action, 'support_handoff');
    assert.doesNotMatch(result.decision.reply, /\/demo/);
  }
});

test('support validation rejects a sales link even if the AI proposes it', () => {
  const bad = check('I am enrolled and need login support, not another demo.', {...support, action: 'send_demo', reply: 'Try the demo: https://nextgenusmle.live/demo'});
  assert.ok(bad.violations.includes('support_interrupted_by_promotion'));
  const repair = buildAylaConversationRepairPrompt({violations:bad.violations});
  assert.match(repair, /support/i);
  assert.doesNotMatch(repair, /student explicitly accepted\/requested the demo/);
});

test('genuine direct preview requests still receive the link, including after a declined call', () => {
  for (const text of ['Please send the demo link', 'Can I see the LMS?', "I do not want a call. Please send the demo instead.", "No time for a call, but please send the demo link again."]) {
    const messages = [{role:'student', text}];
    const decision = normalizeAylaConversationDecision({turn_goal:'resource_request', stage:'demo_experience', action:'send_demo', reply:'Here is your preview.', ask_field:'none'}, state, {messages, latestMessage:text});
    assert.match(decision.reply, /https:\/\/nextgenusmle.live\/demo/);
    assert.deepEqual(evaluateAylaConversationDecision({decision, state, messages}), [], text);
  }
});

test('a genuine demo request is not allowed to become a mistaken support detour', () => {
  const result = check('I am Sarah preparing for Step 1 in the US. Please send the seven-day demo link now so I can try the LMS.');
  assert.ok(result.violations.includes('explicit_demo_acceptance_misclassified_as_support'));
  assert.ok(result.violations.includes('explicit_demo_acceptance_missing_link'));
});
