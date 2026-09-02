// Inbox-only presentation state. Do not use admin read state to decide whether
// Ayla owes a reply: viewing and answering are different events.
const inbound = message => ["inbound", "received", "incoming", "lead", "student"].includes(String(message.direction || message.message_direction || "").toLowerCase()) || message.inbound === true;
const outbound = message => ["outbound", "sent", "outgoing", "agent", "assistant"].includes(String(message.direction || message.message_direction || "").toLowerCase()) || message.outbound === true;
const time = value => Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : 0;
const messageTime = message => time(message.created_at || message.received_at || message.sent_at || message.timestamp || 0);
const providerId = message => message.provider_message_id || message.platform_message_id || message.whatsapp_message_id || message.raw_payload?.platform_message_id || message.raw_payload?.provider_response?.messages?.[0]?.id;

export function hasInboxContent(message = {}) {
  const payload = message.raw_payload || message.payload || {};
  return Boolean(message.message_text || message.text || message.body || message.message || message.content ||
    message.media_id || message.media_url || message.metadata?.media_id || message.metadata?.media_url ||
    ["image", "video", "audio", "document", "sticker"].some(type => payload[type]?.id || payload[type]?.link || message[type]?.id));
}

export function uniqueInboxMessages(messages = []) {
  const seen = new Set();
  return messages.filter(message => {
    if (!hasInboxContent(message)) return false;
    const key = providerId(message) || message.message_log_id || message.raw_payload?.message_log_id || message.id || message;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => messageTime(a) - messageTime(b));
}

export function inboxActivityCounts(lead = {}, messages = []) {
  const unique = uniqueInboxMessages(messages);
  const lastRead = Math.max(0, ...[lead.last_admin_read_at, lead.inbox_last_read_at, lead.last_read_at, lead.conversation_read_at, lead.admin_read_at].map(value => value ? time(value) : 0));
  const lastReply = unique.reduce((latest, message) => {
    const status = String(message.delivery_status || message.provider_status || message.status || "").toLowerCase();
    return outbound(message) && ["sent", "delivered", "read", "success"].includes(status) ? Math.max(latest, messageTime(message)) : latest;
  }, 0);
  const incoming = unique.filter(inbound);
  return {
    admin_unread_count: incoming.filter(message => messageTime(message) > lastRead &&
      !message.admin_read_at && !message.read_by_admin_at && !message.inbox_read_at).length,
    pending_reply_count: incoming.filter(message => messageTime(message) > lastReply).length,
  };
}

// Provider events can arrive out of order. A delayed "sent" cannot erase a
// confirmed "read", and a failed event must not be painted as delivered.
export function applyWhatsAppReceipt(log, event, now = new Date().toISOString()) {
  if (!log || !event?.id || String(providerId(log) || "") !== String(event.id)) return false;
  const next = String(event.status || "").toLowerCase();
  if (!["sent", "delivered", "read", "failed"].includes(next)) return false;
  const previous = String(log.provider_status || log.status || "").toLowerCase();
  const rank = { sent: 1, delivered: 2, read: 3 };
  if (next !== "failed" && ((previous === "failed" && next === "sent") || (rank[previous] || 0) > rank[next])) return false;
  const stampMs = Number(event.timestamp) * 1000;
  const stamp = Number.isFinite(stampMs) && stampMs > 0 ? new Date(stampMs).toISOString() : now;
  log.status = next;
  log.provider_status = next;
  log.provider_response = event;
  if (next === "delivered" && !log.delivered_at) log.delivered_at = stamp;
  if (next === "read" && !log.read_at) log.read_at = stamp;
  if (next === "failed") {
    const failure = event.errors?.[0] || {};
    log.provider_error = failure.message || failure.title || failure.error_data?.details || "WhatsApp could not deliver this message";
    log.provider_error_code = failure.code || null;
    log.provider_error_details = failure.error_data?.details || null;
  }
  if (["delivered", "read"].includes(next)) log.provider_error = null;
  log.updated_at = now;
  return true;
}
