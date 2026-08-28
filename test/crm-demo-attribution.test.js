import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import express from 'express';
import { ensureDemoInvitation, demoInvitationUrl, trackDemoLinks, recordDemoInvitationSent, findDemoInvitation, recordDemoInvitationOpened, recordDemoActivation, demoTrackingSummary, demoAttributionForEnrollment } from '../lib/crm-demo-attribution.js';
import { updateDemoAccess } from '../lib/demo-admin.js';
import { experienceResourcesFromDelivery, recordExperienceShares } from '../lib/crm-experience-followup.js';
import { buildLeadRevenueJourney } from '../lib/crm-revenue-os.js';
import { assertWebsiteProductRequest } from '../lib/product-boundaries.js';

const now = '2026-08-28T16:00:00.000Z';
function fixture({ sent = true, ...extra } = {}) {
  const lead = { id: 'synthetic-lead', email: 'student@example.com', phone: '15550000001', meta_ad_id: 'ad-1', meta_ad_name: 'CNS tutor', meta_campaign_id: 'campaign-1', campaign_name: 'US pilot', meta_ctwa_clid: 'click-1', ...extra };
  const invite = ensureDemoInvitation(lead, now);
  const url = demoInvitationUrl(invite);
  if (sent) recordDemoInvitationSent({ lead, invite, text: `Please explore your demo: ${url}`, channel: 'whatsapp', providerMessageId: 'synthetic-message', sentBy: 'ayla', now });
  return { lead, invite, url, db: { leads: [lead] } };
}
const user = { id: 'student-1', email: 'student@example.com', role: 'student' };
const enrollments = [1, 2].map((i) => ({ id: `demo-${i}`, user_id: user.id, is_demo: true, access_granted: true, status: 'demo_active', created: true }));

test('invitation links are opaque, reusable and expire; drafts do not count as sent', () => {
  const { db, lead, invite, url } = fixture({ sent: false });
  assert.match(invite.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(ensureDemoInvitation(lead, now), invite);
  assert.equal(findDemoInvitation(db, invite.token, now), null);
  assert.equal(demoTrackingSummary(lead).sent_at, null);
  assert.doesNotMatch(url, / /);
  for (const value of [lead.email, lead.phone, lead.id, lead.meta_ctwa_clid]) assert.ok(!url.includes(value));
  const later = ensureDemoInvitation(lead, '2026-10-01T00:00:00Z');
  assert.notEqual(later.token, invite.token);
});

test('only exact NextGen demo URLs are personalised; context, words and other products are preserved', () => {
  const { invite, url } = fixture();
  assert.equal(trackDemoLinks('Try https://nextgenusmle.live/demo.', invite), `Try ${url}.`);
  const contextual = trackDemoLinks('https://nextgenusmle.live/try-demo?redirect=live&session_id=123#start', invite);
  const parsed = new URL(contextual);
  assert.equal(parsed.searchParams.get('session_id'), '123');
  assert.equal(parsed.searchParams.get('ayla_invite'), invite.token);
  assert.equal(parsed.hash, '#start');
  for (const other of ['https://aylamedapp.com/demo', 'https://lectureslibrary.online/demo', 'https://nextgenusmle.live/demo/other', 'https://nextgenusmle.live.evil.com/demo', 'https://nextgenusmle.live/demolition', 'https://evil.com/?next=https://nextgenusmle.live/demo']) assert.equal(trackDemoLinks(other, invite), other);
});

test('page opens are separate, idempotent and cannot create activation', () => {
  const { db, lead, invite } = fixture();
  assert.equal(recordDemoInvitationOpened(db, invite.token, now), true);
  assert.equal(recordDemoInvitationOpened(db, invite.token, now), false);
  assert.equal(recordDemoInvitationOpened(db, 'x'.repeat(32), now), false);
  assert.equal(recordDemoInvitationOpened(db, invite.token, '2027-01-01'), false);
  assert.equal(lead.demo_started_at, undefined);
  assert.equal(demoTrackingSummary(lead).activations.length, 0);
});

test('actual activation retains ad attribution and counts a person once across courses/retries', () => {
  const { db, lead, invite } = fixture();
  const result = recordDemoActivation({ db, token: invite.token, user, enrollments, now });
  assert.equal(result.status, 'recorded');
  assert.equal(result.activation.kind, 'new_demo');
  assert.equal(result.activation.identity_status, 'matched');
  assert.equal(result.activation.enrollment_ids.length, 2);
  assert.equal(recordDemoActivation({ db, token: invite.token, user, enrollments, now }).status, 'already_recorded');
  assert.equal(demoTrackingSummary(lead).new_demo_count, 1);
  assert.equal(demoTrackingSummary(lead).activations[0].source.meta_ad_id, 'ad-1');
  assert.equal(demoAttributionForEnrollment(db, 'demo-1').lead_id, lead.id);
  assert.equal(lead.enrolled, undefined);
  assert.equal(lead.payment_status, undefined);
  assert.equal(lead.demo_started_at, now);
});

test('forwarded/unmatched links remain link-attributed without claiming the lead experienced or paid', () => {
  for (const [email, expected] of [['different@example.com', 'different_account'], ['', 'unconfirmed']]) {
    const { db, lead, invite } = fixture({ email });
    const result = recordDemoActivation({ db, token: invite.token, user, enrollments, now });
    assert.equal(result.activation.identity_status, expected);
    assert.equal(lead.demo_started_at, undefined);
    const journey = buildLeadRevenueJourney({ lead });
    assert.equal(journey.steps.find((step) => step.key === 'proof').complete, false);
    assert.equal(journey.steps.find((step) => step.key === 'enrolled').complete, false);
  }
});

test('existing/renewed demos are not new signups; paid records and admin visits are not demo conversions', () => {
  const one = fixture();
  assert.equal(recordDemoActivation({ db: one.db, token: one.invite.token, user, enrollments: enrollments.map((row) => ({ ...row, created: false })), now }).activation.kind, 'existing_demo');
  const two = fixture();
  assert.equal(recordDemoActivation({ db: two.db, token: two.invite.token, user, enrollments, hadDemoBefore: true, now }).activation.kind, 'renewed_demo');
  const three = fixture();
  for (const overrides of [{ user: { ...user, role: 'admin' } }, { enrollments: [{ is_demo: false, status: 'paid' }] }, { token: 'forged' }]) {
    const result = recordDemoActivation({ db: three.db, token: three.invite.token, user, enrollments, now, ...overrides });
    assert.ok(['unattributed', 'no_demo_activation'].includes(result.status));
  }
  assert.equal(demoTrackingSummary(three.lead).new_demo_count, 0);
});

test('personalised URLs still schedule six-hour experience followups using accepted delivery only', () => {
  const { url, lead } = fixture();
  const result = { channel: 'whatsapp', status: 'sent', log: { text: `Take a look ${url}`, provider_message_id: 'synthetic', sent_at: now } };
  const resources = experienceResourcesFromDelivery({ snapshot: { demo_url: 'https://nextgenusmle.live/demo' }, results: [result] });
  assert.equal(resources[0].url, url);
  recordExperienceShares({ lead, resources, now });
  assert.equal(lead.ayla_experience_followups[0].due_at, '2026-08-28T22:00:00.000Z');
  assert.equal(lead.ayla_experience_followups[0].outcome, 'unknown');
});

test('demo extension and revocation preserve paid access and history', () => {
  const demo = { id: 'demo', is_demo: true, access_granted: false, demo_expiry: '2026-08-01', progress_percentage: 31, plan_id: null };
  updateDemoAccess(demo, { action: 'extend' }, new Date(now));
  assert.equal(demo.demo_expiry, '2026-08-30T16:00:00.000Z');
  assert.equal(demo.is_demo, true);
  assert.equal(demo.progress_percentage, 31);
  updateDemoAccess(demo, { action: 'revoke' }, new Date(now));
  assert.equal(demo.access_granted, false);
  assert.equal(demo.progress_percentage, 31);
  const paid = { id: 'paid', is_demo: false, access_granted: true };
  const original = JSON.stringify(paid);
  assert.throws(() => updateDemoAccess(paid, { action: 'extend' }), /only available for demo/);
  assert.throws(() => updateDemoAccess(paid, { action: 'revoke' }), /only available for demo/);
  assert.equal(JSON.stringify(paid), original);
  assert.throws(() => updateDemoAccess(demo, { action: 'paid' }), /Choose extend or revoke/);
});

test('real demo administration routes serve canonical records and require admin access', async () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const routeCode = source.slice(source.indexOf('app.get("/admin/demo-enrollments"'), source.indexOf('app.get("/admin/enrollments",'));
  const liveDb = { enrollments: { demo: { id: 'demo', is_demo: true, access_granted: true }, paid: { id: 'paid', is_demo: false, access_granted: true } } };
  let saves = 0;
  const app = express(); app.use(express.json());
  vm.runInNewContext(routeCode, { app, requireAdmin: async (req) => { if (req.get('x-test-admin') !== 'yes') throw Object.assign(new Error('Admin required'), { statusCode: 403 }); }, readLiveDb: async () => liveDb, readCrmDbSnapshotOnly: async () => ({ leads: [] }), sanitizeAdminEnrollment: (row) => ({ ...row }), sortNewestFirst: () => 0, findEnrollmentById: (db, id) => db.enrollments[id], writeLiveDb: async () => { saves += 1; }, updateDemoAccess, demoAttributionForEnrollment });
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/admin/demo-enrollments`)).status, 403);
    const res = await fetch(`${base}/admin/demo-enrollments`, { headers: { 'x-test-admin': 'yes' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).count, 1);
    const patch = (id, action) => fetch(`${base}/admin/demo-enrollments/${id}`, { method: 'PATCH', headers: { 'x-test-admin': 'yes', 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    assert.equal((await patch('paid', 'revoke')).status, 409);
    assert.equal(saves, 0);
    assert.equal((await patch('demo', 'extend')).status, 200);
    assert.equal((await patch('demo', 'revoke')).status, 200);
    assert.equal(liveDb.enrollments.paid.access_granted, true);
    assert.equal(saves, 2);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('server wiring records only after saving real access and rejects other products', () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const route = source.slice(source.indexOf('app.post("/demo/start"'), source.indexOf('app.get("/student/demo-status"'));
  assert.ok(route.indexOf('await writeLiveDb(db)') < route.indexOf('recordDemoActivation({'));
  assert.match(route, /attribution_status: demoAttribution.status/);
  assert.match(route, /assertWebsiteProductRequest/);
  assert.throws(() => assertWebsiteProductRequest({ origin: 'https://aylamedapp.com', product: 'lms' }), /boundary/);
  assert.throws(() => assertWebsiteProductRequest({ origin: 'https://lectureslibrary.online', product: 'lms' }), /boundary/);
});

test('real demo activation HTTP flow attributes saved access, is idempotent, and survives a CRM failure', async () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const routeCode = source.slice(source.indexOf('app.post("/demo/start"'), source.indexOf('app.get("/student/demo-status"'));
  const { lead, invite, db: crmDb } = fixture();
  const key = (course, student, type) => `${course}:${student}:${type}`;
  const paid = { id: key('paid-course', user.id, 'paid'), user_id: user.id, course_id: 'paid-course', is_demo: false, access_granted: true };
  const liveDb = { demoSettings: { enabled: true, duration_days: 7 }, courses: { one: { id: 'one', name: 'Step 1' }, two: { id: 'two', name: 'Step 2' }, paid: { id: 'paid-course', name: 'Paid course' } }, enrollments: { [paid.id]: paid } };
  const savedPaid = JSON.stringify(paid);
  let failCrm = false;
  let failLive = false;
  const app = express(); app.use(express.json());
  vm.runInNewContext(routeCode, {
    app, console: { warn: () => {} }, assertWebsiteProductRequest,
    getAuthenticatedUser: async (req) => { if (req.get('x-test-user') !== 'yes') throw Object.assign(new Error('Sign in'), { statusCode: 401 }); return { user }; },
    readLiveDb: async () => liveDb, DEFAULT_DEMO_SETTINGS: {},
    getDemoCourseCandidates: (db) => Object.values(db.courses), normalizeIdList: (v) => v || [],
    dateOnly: (d) => d.toISOString().slice(0, 10), addDays: (d, n) => new Date(d.getTime() + n * 86400000), backendEnrollmentKey: key,
    isDemoEnrollmentActive: (row) => row.access_granted === true,
    enrichDemoEnrollment: (row) => { row.demo_started_at ||= now; },
    createBackendEnrollment: (db, { userId, userName, courseId, isDemo, accessGranted, demoExpiry }) => {
      const id = key(courseId, userId, 'demo');
      return db.enrollments[id] = { id, user_id: userId, user_name: userName, course_id: courseId, is_demo: isDemo, access_granted: accessGranted, demo_expiry: demoExpiry };
    },
    ngSendConfiguredEmailSafe: async () => ({ attempted: false, skipped: true, reason: 'isolated-test-no-email' }),
    ngEmailBaseVariables: () => ({}), ngEmailCoursePhrase: () => '',
    writeLiveDb: async () => { if (failLive) throw new Error('Simulated LMS save failure'); },
    buildStudentDemoStatus: () => ({ demo_expiry: '2026-09-04' }),
    mutateCrmDb: async (mutator) => { if (failCrm) throw new Error('Simulated CRM failure'); return mutator(crmDb); },
    recordDemoActivation: (args) => recordDemoActivation({ ...args, now }),
  });
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const start = (headers = {}) => fetch(`${base}/demo/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': 'yes', ...headers }, body: JSON.stringify({ all_courses: true, ayla_invite: invite.token }) });
  try {
    assert.equal((await start({ 'x-test-user': 'no' })).status, 401);
    assert.equal((await start({ origin: 'https://aylamedapp.com' })).status, 403);
    const first = await (await start()).json();
    assert.equal(first.success, true);
    assert.equal(first.new_demo_student, true);
    assert.equal(first.created_count, 2);
    assert.equal(first.already_paid_count, 1);
    assert.equal(first.attribution_status, 'recorded');
    assert.equal(lead.demo_tracking.new_demo_count, 1);
    assert.equal(JSON.stringify(liveDb.enrollments[paid.id]), savedPaid);
    assert.ok(!JSON.stringify(first).includes('synthetic-lead'), 'student response never exposes CRM identity');
    const repeat = await (await start()).json();
    assert.equal(repeat.new_demo_student, false);
    assert.equal(repeat.attribution_status, 'already_recorded');
    assert.equal(lead.demo_tracking.new_demo_count, 1);
    failCrm = true;
    const outage = await (await start()).json();
    assert.equal(outage.success, true);
    assert.equal(outage.attribution_status, 'unavailable');
    assert.equal(JSON.stringify(liveDb.enrollments[paid.id]), savedPaid);
    failLive = true;
    assert.equal((await start()).status, 500);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('real sender personalises accepted free-form text/captions, never templates or failed sends', async () => {
  const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const sender = source.slice(source.indexOf('async function sendCrmMessage({'), source.indexOf('function normalizeAutomationEnrollment(', source.indexOf('async function sendCrmMessage({')));
  let fail = false;
  let payload;
  const context = vm.createContext({
    console, ensureDemoInvitation: (lead) => ensureDemoInvitation(lead, now), trackDemoLinks, recordDemoInvitationSent,
    getMessageTemplateByKey: () => ({}), getLeadByAnyId: (db, id) => db.leads.find((row) => row.id === id),
    ngAylaOutboundCommandMetadata: () => ({}), resolveCrmChannel: ({ requestedChannel }) => requestedChannel,
    renderTemplateString: (v) => v, getBestRecipientForChannel: ({ to }) => to,
    getIntegrationByPlatform: () => ({}), getWhatsAppTemplateName: ({ metadata }) => metadata.template_name || '', getWhatsAppLanguageCode: () => 'en_US',
    buildWhatsAppTemplateComponents: () => [], normalizeCrmString: (v) => String(v || ''), normalizeCrmLower: (v) => String(v || '').toLowerCase(),
    ngWhatsAppProviderBlockStatus: () => ({ blocked: false }), ngFindRecentDuplicateDelivery: () => null,
    ngStartDeliveryLock: () => ({}), ngFinishDeliveryLock: () => {},
    sendWhatsAppCloudMessage: async (input) => { payload = input; if (fail) throw new Error('Test provider failure'); return { messages: [{ id: 'synthetic-provider-receipt' }] }; },
    createMessageLog: (db, log) => ({ id: 'synthetic-log', ...log }), appendSocialConversation: () => {}, nowIso: () => now,
    ngUpdateLeadWhatsAppSendStatus: () => {}, ngAylaRecordExperienceDelivery: () => {}, ngLatestInbound: () => ({}), ngLeadConversationMessages: () => [],
    extractProviderError: (e) => e.message, classifyWhatsAppProviderFailure: () => ({ category: 'test', retryable: false }),
  });
  vm.runInContext(sender, context);
  const send = (lead, options = {}) => context.sendCrmMessage({ db: { leads: [lead] }, leadId: lead.id, channel: 'whatsapp', to: '15550000001', text: 'Please try https://nextgenusmle.live/demo', metadata: { ai_auto: true }, ...options });
  const first = { id: 'test-1' };
  assert.equal((await send(first)).success, true);
  assert.match(payload.text, /ayla_invite=/);
  assert.equal(first.demo_tracking.sent_at, now);
  assert.equal(first.demo_invitations[0].sent_by, 'ayla');
  const media = { id: 'test-2' };
  await send(media, { mediaUrl: 'https://nextgenusmle.live/test.jpg', caption: 'Please try https://nextgenusmle.live/demo' });
  assert.match(payload.caption, /ayla_invite=/);
  assert.equal(media.demo_tracking.sent_at, now);
  const templated = { id: 'test-3' };
  await send(templated, { metadata: { template_name: 'nextgen_warm_welcome' } });
  assert.equal(templated.demo_invitations, undefined);
  assert.doesNotMatch(payload.text, /ayla_invite=/);
  fail = true;
  const failed = { id: 'test-4' };
  assert.equal((await send(failed)).success, false);
  assert.equal(failed.demo_tracking, undefined);
  assert.equal(failed.demo_invitations[0].sent_at, null);
});
