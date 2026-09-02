import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { applyWhatsAppReceipt, inboxActivityCounts } from '../lib/crm-inbox-indicators.js';

const incoming = (id, minute) => ({ id, provider_message_id: id, direction: 'inbound', text: 'Hello', created_at: '2026-08-28T12:' + minute + ':00Z' });
test('Ayla replying does not mark messages read by a human', () => {
  const messages = [incoming('a', '01'), incoming('b', '02'), { id: 'c', direction: 'outbound', status: 'sent', text: 'Hi', created_at: '2026-08-28T12:03:00Z' }];
  assert.deepEqual(inboxActivityCounts({}, messages), { admin_unread_count: 2, pending_reply_count: 0 });
  assert.deepEqual(inboxActivityCounts({ last_admin_read_at: '2026-08-28T12:02:00Z' }, messages), { admin_unread_count: 0, pending_reply_count: 0 });
});

test('reading a message does not answer it; failed or queued messages do not count as replies', () => {
  for (const status of ['failed', 'queued', 'pending']) {
    const messages = [incoming('a', '01'), { id: 'out', direction: 'outbound', status, text: 'Hi', created_at: '2026-08-28T12:02:00Z' }];
    assert.deepEqual(inboxActivityCounts({ last_admin_read_at: '2026-08-28T12:03:00Z' }, messages), { admin_unread_count: 0, pending_reply_count: 1 });
  }
});

test('attachment-only inbound counts once across duplicate provider records', () => {
  const message = { ...incoming('a', '01'), text: '', raw_payload: { audio: { id: 'media-1' } } };
  assert.deepEqual(inboxActivityCounts({}, [message, { ...message, id: 'copy' }]), { admin_unread_count: 1, pending_reply_count: 1 });
  assert.equal(inboxActivityCounts({}, [{ ...message, admin_read_at: '2026-08-28T12:02:00Z' }]).admin_unread_count, 0);
});

test('delayed sent/delivered events cannot remove a blue read receipt', () => {
  const log = { provider_message_id: 'm1', status: 'sent' };
  assert.equal(applyWhatsAppReceipt(log, { id: 'm1', status: 'read', timestamp: '1787918400' }), true);
  assert.equal(log.provider_status, 'read');
  assert.ok(log.read_at);
  assert.equal(applyWhatsAppReceipt(log, { id: 'm1', status: 'sent' }), false);
  assert.equal(applyWhatsAppReceipt(log, { id: 'm1', status: 'delivered' }), false);
  assert.equal(log.status, 'read');
  assert.equal(applyWhatsAppReceipt(log, { id: 'another', status: 'failed' }), false);
});

test('failure is explicit and cannot be undone by a late sent event', () => {
  const log = { provider_message_id: 'm1', status: 'sent' };
  applyWhatsAppReceipt(log, { id: 'm1', status: 'failed', errors: [{ message: 'Recipient unavailable' }] });
  assert.equal(log.provider_error, 'Recipient unavailable');
  assert.equal(applyWhatsAppReceipt(log, { id: 'm1', status: 'sent' }), false);
  applyWhatsAppReceipt(log, { id: 'm1', status: 'delivered' });
  assert.equal(log.provider_error, null);
  assert.equal(log.status, 'delivered');
});

test('failure receipts retain Meta error code and details for diagnosis', () => {
  const log = { provider_message_id: 'm2', status: 'sent' };
  applyWhatsAppReceipt(log, {
    id: 'm2',
    status: 'failed',
    errors: [{ code: 131049, message: 'This message was not delivered to maintain healthy ecosystem engagement.', error_data: { details: 'Meta delivery protection' } }],
  });
  assert.equal(log.provider_error_code, 131049);
  assert.equal(log.provider_error_details, 'Meta delivery protection');
  assert.match(log.provider_error, /healthy ecosystem engagement/);
});

test('both WhatsApp webhook paths use the same receipt handling; inbox adds separate counts', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.equal((server.match(/applyWhatsAppReceipt\(log, status\)/g) || []).length, 2);
  assert.match(server, /const activityCounts = inboxActivityCounts\(lead, inboxMessages\)/);
  assert.match(server, /admin_unread_count \?\? item.unread_count/);
});
