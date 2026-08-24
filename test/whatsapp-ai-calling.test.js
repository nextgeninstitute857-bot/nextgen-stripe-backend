import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extractWhatsAppCallEvents,
  mergeWhatsAppCallLog,
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
    OPENAI_API_KEY: "configured",
  });

  assert.equal(readiness.messaging_configured, true);
  assert.equal(readiness.inbound_user_initiated_supported, true);
  assert.equal(readiness.outbound_business_initiated_supported, false);
  assert.equal(readiness.inbound_ready, false);
  assert.ok(readiness.blockers.includes("Meta calls webhook subscription has not been confirmed."));
  assert.ok(readiness.blockers.includes("A SIP target or WebRTC media bridge is not configured."));
  assert.ok(readiness.blockers.includes("Live AI answering remains safely disabled until the controlled test."));
});

test("inbound readiness requires every external control", () => {
  const readiness = whatsappAiCallingReadiness({
    WHATSAPP_ACCESS_TOKEN: "configured",
    WHATSAPP_PHONE_NUMBER_ID: "pn-1",
    WHATSAPP_BUSINESS_NUMBER: "+18254255646",
    WHATSAPP_CALLING_WEBHOOK_ENABLED: "true",
    WHATSAPP_CALLING_SIP_URI: "sip:proj_test@sip.api.openai.com;transport=tls",
    WHATSAPP_AI_CALLING_ENABLED: "true",
    OPENAI_API_KEY: "configured",
    OPENAI_REALTIME_MODEL: "gpt-realtime-2.1-mini",
  });

  assert.equal(readiness.inbound_ready, true);
  assert.equal(readiness.media_mode, "sip");
  assert.deepEqual(readiness.blockers, []);
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
  assert.match(server, /recording_enabled = false/);
});
