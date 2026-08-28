import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { uniqueInboxMessages } from '../lib/crm-inbox-indicators.js';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
function sourceBetween(start, end) {
  const from = server.indexOf(start);
  const to = server.indexOf(end, from);
  assert.ok(from >= 0 && to > from, start);
  return server.slice(from, to);
}
const crud = sourceBetween('function registerCrmCrudRoutes(', 'const NEXTGEN_IMPORT_PHONE_COUNTRY_RULES');
const thread = sourceBetween('async function ngSendCrmConversationThread(', 'app.post("/admin/crm/conversations/:leadId/mark-read"');

function fixture({ admin = true, denied = false } = {}) {
  const lead = { id: 'lead-1', name: 'Synthetic Student' };
  const original = { id: 'copy-1', lead_id: lead.id, message_text: 'Dashboard', status: 'sent', provider_message_id: 'wamid-1' };
  const delivered = { ...original, id: 'log-1', status: 'delivered', delivered_at: '2026-08-28T12:00:00Z', metadata: { media_url: 'https://nextgenusmle.live/media/dashboard.png' } };
  const db = { leads: [lead], conversations: [original], message_logs: [delivered] };
  const counters = { writes: 0, reads: 0, unified: 0 };
  const routes = [];
  const context = vm.createContext({
    app: { get: (path, handler) => routes.push({ path, handler }), post() {}, put() {}, delete() {} },
    requireCrmCollectionAccess: async (_req, collection, action) => {
      assert.equal(collection, 'conversations');
      assert.equal(action, 'read');
      if (denied) throw Object.assign(new Error('Access denied'), { statusCode: 403 });
      return { crm_admin: admin, user: { id: 'test-admin' }, team_member: { id: 'test-team' }, crmDb: db };
    },
    ensureCrmArray: (data, key) => data[key] || [],
    getLeadByAnyId: (data, key) => data.leads.find(item => item.id === key),
    ngMarkConversationRead: (_data, item) => { counters.reads++; assert.equal(item.id, lead.id); return { changed: true }; },
    writeCrmDb: async () => { counters.writes++; },
    ngLeadConversationMessages: (data, key) => { counters.unified++; return [...data.message_logs, ...data.conversations].filter(item => item.lead_id === key); },
    ngInboxMessagesForLead: (_data, _lead, messages) => uniqueInboxMessages(messages),
    applyTeamScopeToRecords: () => [],
    crmRecordVisibleToTeam: () => false,
  });
  vm.runInContext(crud + '\n' + thread + '\nregisterCrmCrudRoutes({ route: "/admin/crm/conversations", collection: "conversations" });', context);
  async function get(id = lead.id, query = {}) {
    // Dispatch the first matching parameter route, just as Express does. This
    // catches the route-shadowing bug that testing the later handler missed.
    const route = routes.find(item => item.path === '/admin/crm/conversations/:id');
    assert.ok(route);
    const response = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await route.handler({ params: { id }, query }, response);
    return response;
  }
  return { get, counters, delivered, original };
}

test('the first registered lead-thread route returns provider receipts and media, not the old sent-only copy', async () => {
  const f = fixture();
  const result = await f.get();
  assert.equal(result.code, 200);
  assert.equal(result.body.sources.unified_thread, true);
  assert.equal(result.body.conversations.length, 1);
  assert.equal(result.body.conversations[0].status, 'delivered');
  assert.equal(result.body.conversations[0].metadata.media_url, f.delivered.metadata.media_url);
  assert.equal(result.body.read_state.changed, true);
  assert.deepEqual(f.counters, { writes: 1, reads: 1, unified: 1 });
  assert.doesNotMatch(server, /app\.get\("\/admin\/crm\/conversations\/:leadId"/);
});

test('read-only polling does not mark the thread read or write the CRM', async () => {
  const f = fixture();
  const result = await f.get('lead-1', { mark_read: 'false' });
  assert.equal(result.body.read_state.changed, false);
  assert.deepEqual(f.counters, { writes: 0, reads: 0, unified: 1 });
});

test('conversation record-ID lookups keep their original CRUD response', async () => {
  const f = fixture();
  const result = await f.get('copy-1');
  assert.equal(result.body.record.id, f.original.id);
  assert.equal(result.body.record.status, 'sent');
  assert.deepEqual(f.counters, { writes: 0, reads: 0, unified: 0 });
});

test('unauthorized and team-scoped readers cannot reach the admin unified thread', async () => {
  const blocked = fixture({ denied: true });
  assert.equal((await blocked.get()).code, 403);
  assert.equal(blocked.counters.unified, 0);
  const team = fixture({ admin: false });
  const result = await team.get();
  assert.equal(result.body.scoped, true);
  assert.equal(result.body.conversations.length, 0);
  assert.deepEqual(team.counters, { writes: 0, reads: 0, unified: 0 });
});

test('an unknown lead returns no records and does not change read state', async () => {
  const f = fixture();
  const result = await f.get('unknown-lead');
  assert.equal(result.body.count, 0);
  assert.equal(result.body.lead, null);
  assert.equal(result.body.read_state.changed, false);
  assert.equal(f.counters.writes, 0);
});
