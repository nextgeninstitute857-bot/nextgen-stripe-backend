import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  acceptInboundWhatsAppCall,
  extractWhatsAppCallEvents,
  extractWhatsAppCallOffers,
  mergeWhatsAppCallLog,
  redactWhatsAppCallMediaPayload,
  whatsappAiCallingReadiness,
} from "../lib/whatsapp-ai-calling.js";

test("extracts inbound WhatsApp call connect without retaining SDP", () => {
  const events = extractWhatsAppCallEvents({
    entry: [{
      changes: [{
        field: "calls",
        value: {
          metadata: { phone_number_id: "pn-1", display_phone_number: "+18254255646" },
          calls: [{
            id: "wacid.test-1",
            from: "12025550123",
            event: "connect",
            timestamp: "1787558400",
            session: { sdp_type: "offer", sdp: "private-session-description" },
          }],
        },
      }],
    }],
  });

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    provider_call_id: "wacid.test-1",
    event: "connect",
    status: "ringing",
    direction: "inbound",
    from: "12025550123",
    to: "+18254255646",
    phone_number_id: "pn-1",
    timestamp: "2026-08-24T08:00:00.000Z",
    sdp_type: "offer",
    has_sdp: true,
    duration_seconds: 0,
    terminal: false,
    error_codes: [],
  });
  assert.doesNotMatch(JSON.stringify(events[0]), /private-session-description/);
});

test("merges terminate event into one durable call log", () => {
  const started = mergeWhatsAppCallLog({}, {
    provider_call_id: "call-1",
    event: "connect",
    status: "ringing",
    direction: "inbound",
    from: "12025550123",
    timestamp: "2026-08-24T00:00:00.000Z",
    has_sdp: true,
    sdp_type: "offer",
    terminal: false,
  });
  const completed = mergeWhatsAppCallLog(started, {
    provider_call_id: "call-1",
    event: "terminate",
    status: "completed",
    timestamp: "2026-08-24T00:02:00.000Z",
    duration_seconds: 120,
    terminal: true,
  });

  assert.equal(completed.provider_call_id, "call-1");
  assert.equal(completed.status, "completed");
  assert.equal(completed.outcome, "completed");
  assert.equal(completed.duration_seconds, 120);
  assert.equal(completed.has_sdp_offer, true);
});

test("Canadian WhatsApp number reports inbound-only and stays disabled by default", () => {
  const readiness = whatsappAiCallingReadiness({
    WHATSAPP_ACCESS_TOKEN: "configured",
    WHATSAPP_PHONE_NUMBER_ID: "pn-1",
    WHATSAPP_BUSINESS_NUMBER: "+18254255646",
  });

  assert.equal(readiness.messaging_configured, true);
  assert.equal(readiness.inbound_user_initiated_supported, true);
  assert.equal(readiness.outbound_business_initiated_supported, false);
  assert.equal(readiness.inbound_ready, false);
  assert.ok(readiness.blockers.includes("Meta calls webhook subscription has not been confirmed."));
  assert.ok(readiness.blockers.includes("OpenAI Realtime credentials are missing."));
  assert.ok(readiness.blockers.includes("LiveKit WhatsApp connector credentials are missing."));
  assert.ok(readiness.blockers.includes("The Ayla LiveKit voice worker has not been deployed and verified."));
  assert.ok(readiness.blockers.includes("Live AI answering remains safely disabled until the controlled test."));
});

test("inbound readiness requires every external control", () => {
  const readiness = whatsappAiCallingReadiness({
    WHATSAPP_ACCESS_TOKEN: "configured",
    WHATSAPP_PHONE_NUMBER_ID: "pn-1",
    WHATSAPP_BUSINESS_NUMBER: "+18254255646",
    WHATSAPP_CALLING_WEBHOOK_ENABLED: "true",
    WHATSAPP_AI_CALLING_ENABLED: "true",
    OPENAI_API_KEY: "configured",
    LIVEKIT_URL: "https://ayla-whatsapp-voice.livekit.cloud",
    LIVEKIT_API_KEY: "configured",
    LIVEKIT_API_SECRET: "configured",
    LIVEKIT_WHATSAPP_AGENT_NAME: "ayla-whatsapp-voice-agent",
    LIVEKIT_WHATSAPP_AGENT_DEPLOYED: "true",
  });

  assert.equal(readiness.inbound_ready, true);
  assert.equal(readiness.media_mode, "livekit_whatsapp_connector");
  assert.deepEqual(readiness.blockers, []);
});

test("extracts the SDP offer only for the transient connector handoff", () => {
  const offers = extractWhatsAppCallOffers({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "pn-1" },
      calls: [{
        id: "wacid.test-1",
        from: "12025550123",
        event: "connect",
        session: { sdp_type: "offer", sdp: "private-session-description" },
      }],
    } }] }],
  });

  assert.equal(offers.length, 1);
  assert.equal(offers[0].provider_call_id, "wacid.test-1");
  assert.equal(offers[0].phone_number_id, "pn-1");
  assert.equal(offers[0].sdp, "private-session-description");
});

test("removes SDP before a WhatsApp call webhook is journaled", () => {
  const safe = redactWhatsAppCallMediaPayload({
    entry: [{ changes: [{ value: {
      calls: [{ id: "call-1", session: { sdp_type: "offer", sdp: "private-session-description" } }],
    } }] }],
  });

  assert.doesNotMatch(JSON.stringify(safe), /private-session-description/);
  assert.equal(safe.entry[0].changes[0].value.calls[0].session.sdp_present, true);
  assert.equal(extractWhatsAppCallEvents(safe)[0].has_sdp, true);
});

test("accepts an inbound WhatsApp call into a private random LiveKit room", async () => {
  const accepted = [];
  const connector = {
    acceptWhatsAppCall: async (options) => {
      accepted.push(options);
      return { roomName: options.roomName };
    },
  };

  const result = await acceptInboundWhatsAppCall({
    payload: {
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "pn-1" },
        calls: [{
          id: "wacid.secret-call-id",
          from: "12025550123",
          event: "connect",
          session: { sdp_type: "offer", sdp: "private-session-description" },
        }],
      } }] }],
    },
    env: {
      WHATSAPP_ACCESS_TOKEN: "meta-token",
      WHATSAPP_PHONE_NUMBER_ID: "pn-1",
      WHATSAPP_CALLING_WEBHOOK_ENABLED: "true",
      WHATSAPP_AI_CALLING_ENABLED: "true",
      OPENAI_API_KEY: "configured",
      LIVEKIT_URL: "https://ayla-whatsapp-voice.livekit.cloud",
      LIVEKIT_API_KEY: "livekit-key",
      LIVEKIT_API_SECRET: "livekit-secret",
      LIVEKIT_WHATSAPP_AGENT_NAME: "ayla-whatsapp-voice-agent",
      LIVEKIT_WHATSAPP_AGENT_DEPLOYED: "true",
    },
    connector,
    SessionDescriptionClass: class SessionDescription {
      constructor(input) { Object.assign(this, input); }
    },
    randomId: () => "random-room-token",
  });

  assert.equal(result.accepted.length, 1);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].roomName, "whatsapp-inbound-random-room-token");
  assert.equal(accepted[0].participantIdentity, "whatsapp-caller-random-room-token");
  assert.deepEqual(accepted[0].agents, [{ agentName: "ayla-whatsapp-voice-agent" }]);
  assert.equal(accepted[0].waitUntilAnswered, false);
  assert.equal(accepted[0].sdp.type, "offer");
  assert.equal(accepted[0].sdp.sdp, "private-session-description");
  assert.doesNotMatch(`${accepted[0].roomName} ${accepted[0].participantIdentity} ${accepted[0].participantMetadata}`, /12025550123|secret-call-id/);
  assert.match(accepted[0].participantMetadata, /"recording":"disabled"/);
});

test("the live WhatsApp webhook journals calls before the non-message exit", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const handlerStart = server.indexOf("async function handleUniversalWebhook");
  const callBranch = server.indexOf('event: "call_event"', handlerStart);
  const ignoredBranch = server.indexOf('event: "ignored_non_message"', handlerStart);
  assert.ok(handlerStart > -1);
  assert.ok(callBranch > handlerStart);
  assert.ok(ignoredBranch > callBranch);
  assert.match(server.slice(handlerStart, ignoredBranch), /kind: "call"/);
  assert.match(server.slice(handlerStart, ignoredBranch), /acceptInboundWhatsAppCall/);
  assert.match(server, /recording_enabled = false/);
});
