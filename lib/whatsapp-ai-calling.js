import { randomUUID } from "node:crypto";

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();

const TERMINAL_EVENTS = new Set([
  "terminate",
  "terminated",
  "completed",
  "ended",
  "failed",
  "rejected",
  "no_answer",
  "busy",
]);

function eventStatus(value) {
  const token = lower(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["connect", "incoming", "ringing", "ring"].includes(token)) return "ringing";
  if (["accept", "accepted", "connected", "answer", "answered", "pre_accept"].includes(token)) return "connected";
  if (["terminate", "terminated", "complete", "completed", "ended", "hangup", "hung_up"].includes(token)) return "completed";
  if (["reject", "rejected", "decline", "declined"].includes(token)) return "rejected";
  if (["no_answer", "unanswered", "missed"].includes(token)) return "no_answer";
  if (token === "busy") return "busy";
  if (["fail", "failed", "error"].includes(token)) return "failed";
  return token || "received";
}

function callDirection(call = {}) {
  const direction = lower(call.direction || call.call_direction);
  if (["outbound", "business_initiated", "business-initiated"].includes(direction)) return "outbound";
  return "inbound";
}

function valueBlocks(payload = {}) {
  const blocks = [];
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.value && typeof change.value === "object") blocks.push(change.value);
    }
  }
  if (!blocks.length && payload?.value && typeof payload.value === "object") blocks.push(payload.value);
  if (!blocks.length && payload && typeof payload === "object") blocks.push(payload);
  return blocks;
}

export function extractWhatsAppCallEvents(payload = {}) {
  const events = [];
  for (const value of valueBlocks(payload)) {
    const metadata = value.metadata || {};
    for (const call of Array.isArray(value.calls) ? value.calls : []) {
      const providerCallId = clean(call.id || call.call_id || call.callId);
      if (!providerCallId) continue;
      const rawEvent = clean(call.event || call.status || call.type || "received");
      const session = call.session && typeof call.session === "object" ? call.session : {};
      const timestamp = clean(call.timestamp || value.timestamp);
      events.push({
        provider_call_id: providerCallId,
        event: rawEvent || "received",
        status: eventStatus(rawEvent),
        direction: callDirection(call),
        from: clean(call.from || call.caller || call.wa_id),
        to: clean(call.to || metadata.display_phone_number || metadata.phone_number_id),
        phone_number_id: clean(metadata.phone_number_id || call.phone_number_id),
        timestamp: timestamp && /^\d+$/.test(timestamp)
          ? new Date(Number(timestamp) * 1000).toISOString()
          : timestamp || null,
        sdp_type: clean(session.sdp_type || session.type) || null,
        has_sdp: Boolean(clean(session.sdp) || session.sdp_present === true),
        duration_seconds: Number(call.duration || call.duration_seconds || 0) || 0,
        terminal: TERMINAL_EVENTS.has(lower(rawEvent)) || ["completed", "failed", "rejected", "no_answer", "busy"].includes(eventStatus(rawEvent)),
        error_codes: (Array.isArray(call.errors) ? call.errors : [])
          .map((error) => clean(error?.code || error?.error_code || error))
          .filter(Boolean),
      });
    }
  }
  return events;
}

export function extractWhatsAppCallOffers(payload = {}) {
  const offers = [];
  for (const value of valueBlocks(payload)) {
    const metadata = value.metadata || {};
    for (const call of Array.isArray(value.calls) ? value.calls : []) {
      const session = call.session && typeof call.session === "object" ? call.session : {};
      const providerCallId = clean(call.id || call.call_id || call.callId);
      const sdp = clean(session.sdp);
      const sdpType = lower(session.sdp_type || session.type);
      const status = eventStatus(call.event || call.status || call.type || "received");
      if (!providerCallId || !sdp || sdpType !== "offer" || status !== "ringing") continue;
      offers.push({
        provider_call_id: providerCallId,
        phone_number_id: clean(metadata.phone_number_id || call.phone_number_id),
        sdp_type: "offer",
        sdp,
      });
    }
  }
  return offers;
}

export function redactWhatsAppCallMediaPayload(payload = {}) {
  const clone = JSON.parse(JSON.stringify(payload || {}));
  for (const value of valueBlocks(clone)) {
    for (const call of Array.isArray(value.calls) ? value.calls : []) {
      if (!call?.session || typeof call.session !== "object") continue;
      if (clean(call.session.sdp)) call.session.sdp_present = true;
      delete call.session.sdp;
    }
  }
  return clone;
}

export function mergeWhatsAppCallLog(existing = {}, event = {}, now = new Date()) {
  const at = event.timestamp || now.toISOString();
  const startedAt = existing.started_at || (event.status === "ringing" ? at : null);
  const connectedAt = existing.connected_at || (event.status === "connected" ? at : null);
  const endedAt = event.terminal ? at : existing.ended_at || null;
  let duration = Number(event.duration_seconds || existing.duration_seconds || 0) || 0;
  if (!duration && connectedAt && endedAt) {
    const difference = new Date(endedAt).getTime() - new Date(connectedAt).getTime();
    if (Number.isFinite(difference) && difference > 0) duration = Math.round(difference / 1000);
  }
  return {
    ...existing,
    provider: "whatsapp_cloud_api",
    channel: "whatsapp_call",
    provider_call_id: event.provider_call_id || existing.provider_call_id,
    direction: event.direction || existing.direction || "inbound",
    from: event.from || existing.from || "",
    to: event.to || existing.to || "",
    phone_number_id: event.phone_number_id || existing.phone_number_id || "",
    status: event.status || existing.status || "received",
    outcome: event.terminal ? (event.status || "completed") : existing.outcome || null,
    started_at: startedAt,
    connected_at: connectedAt,
    ended_at: endedAt,
    duration_seconds: duration,
    has_sdp_offer: existing.has_sdp_offer || (event.has_sdp && event.sdp_type === "offer"),
    last_event: event.event || existing.last_event || null,
    error_codes: [...new Set([...(existing.error_codes || []), ...(event.error_codes || [])])],
    updated_at: at,
    created_at: existing.created_at || at,
  };
}

function truthy(value) {
  return ["1", "true", "yes", "on", "enabled"].includes(lower(value));
}

function isCanadianNumber(number) {
  const digits = clean(number).replace(/\D/g, "");
  return digits.startsWith("1825");
}

export function whatsappAiCallingReadiness(env = process.env) {
  const businessNumber = clean(env.WHATSAPP_BUSINESS_NUMBER || env.WHATSAPP_DISPLAY_PHONE_NUMBER || "+18254255646");
  const messagingConfigured = Boolean(clean(env.WHATSAPP_ACCESS_TOKEN) && clean(env.WHATSAPP_PHONE_NUMBER_ID));
  const webhookEnabled = truthy(env.WHATSAPP_CALLING_WEBHOOK_ENABLED);
  const openAiConfigured = Boolean(clean(env.OPENAI_API_KEY));
  const liveKitConfigured = Boolean(
    clean(env.LIVEKIT_URL)
    && clean(env.LIVEKIT_API_KEY)
    && clean(env.LIVEKIT_API_SECRET)
    && clean(env.LIVEKIT_WHATSAPP_AGENT_NAME || "ayla-whatsapp-voice-agent")
  );
  const mediaMode = liveKitConfigured ? "livekit_whatsapp_connector" : "not_configured";
  const mediaConfigured = liveKitConfigured;
  const activationEnabled = truthy(env.WHATSAPP_AI_CALLING_ENABLED);
  const inboundReady = messagingConfigured && webhookEnabled && liveKitConfigured && activationEnabled;
  const canadian = isCanadianNumber(businessNumber);

  const blockers = [];
  if (!messagingConfigured) blockers.push("WhatsApp Cloud API credentials are missing.");
  if (!webhookEnabled) blockers.push("Meta calls webhook subscription has not been confirmed.");
  if (!liveKitConfigured) blockers.push("LiveKit WhatsApp connector credentials are missing.");
  if (!activationEnabled) blockers.push("Live AI answering remains safely disabled until the controlled test.");

  return {
    provider: "whatsapp_cloud_api",
    business_number: businessNumber,
    messaging_configured: messagingConfigured,
    calls_webhook_enabled: webhookEnabled,
    openai_realtime_configured: openAiConfigured,
    livekit_connector_configured: liveKitConfigured,
    media_mode: mediaMode,
    media_configured: mediaConfigured,
    activation_enabled: activationEnabled,
    inbound_user_initiated_supported: true,
    inbound_ready: inboundReady,
    outbound_business_initiated_supported: !canadian,
    outbound_note: canadian
      ? "This Canadian WhatsApp business number can receive user-initiated calls, but business-initiated WhatsApp calling is not available."
      : "Outbound availability must still be confirmed in Meta for the registered business number.",
    livekit_agent_name: clean(env.LIVEKIT_WHATSAPP_AGENT_NAME) || "ayla-whatsapp-voice-agent",
    blockers,
  };
}

export async function acceptInboundWhatsAppCall({
  payload = {},
  env = process.env,
  connector = null,
  SessionDescriptionClass = null,
  randomId = randomUUID,
} = {}) {
  const offers = extractWhatsAppCallOffers(payload);
  if (!offers.length) return { accepted: [] };

  const readiness = whatsappAiCallingReadiness(env);
  if (!readiness.inbound_ready) {
    const error = new Error(`WhatsApp AI calling is not ready: ${readiness.blockers.join(" ")}`);
    error.statusCode = 503;
    throw error;
  }

  let activeConnector = connector;
  let ActiveSessionDescription = SessionDescriptionClass;
  if (!activeConnector || !ActiveSessionDescription) {
    const livekit = await import("livekit-server-sdk");
    const api = new livekit.LiveKitAPI({
      host: clean(env.LIVEKIT_URL),
      apiKey: clean(env.LIVEKIT_API_KEY),
      secret: clean(env.LIVEKIT_API_SECRET),
      requestTimeout: 12,
    });
    activeConnector ||= api.connector;
    ActiveSessionDescription ||= livekit.SessionDescription;
  }

  const accepted = [];
  for (const offer of offers) {
    const token = String(randomId()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || randomUUID();
    const roomName = `whatsapp-inbound-${token}`;
    const response = await activeConnector.acceptWhatsAppCall({
      whatsappPhoneNumberId: offer.phone_number_id || clean(env.WHATSAPP_PHONE_NUMBER_ID),
      whatsappApiKey: clean(env.WHATSAPP_ACCESS_TOKEN),
      whatsappCloudApiVersion: clean(env.WHATSAPP_CLOUD_API_VERSION) || "25.0",
      whatsappCallId: offer.provider_call_id,
      sdp: new ActiveSessionDescription({ type: "offer", sdp: offer.sdp }),
      roomName,
      agents: [{ agentName: readiness.livekit_agent_name }],
      participantIdentity: `whatsapp-caller-${token}`,
      participantName: "WhatsApp caller",
      participantMetadata: JSON.stringify({
        source: "whatsapp",
        consent: "user_initiated",
        recording: "disabled",
      }),
      waitUntilAnswered: false,
      timeout: 12,
    });
    accepted.push({
      provider_call_id: offer.provider_call_id,
      room_name: clean(response?.roomName || response?.room_name || roomName),
    });
  }
  return { accepted };
}

export function safeWhatsAppCallEvent(event = {}) {
  const { sdp, session, ...safe } = event;
  return safe;
}
