import assert from "node:assert/strict";
import test from "node:test";

import {
  AYLA_WHATSAPP_VOICE_AGENT_NAME,
  AYLA_WHATSAPP_VOICE_INSTRUCTIONS,
  createAylaWhatsAppVoiceAgent,
} from "./ayla-whatsapp-voice-agent.js";

test("Ayla WhatsApp voice worker uses the dispatch name expected by the backend", () => {
  assert.equal(AYLA_WHATSAPP_VOICE_AGENT_NAME, "ayla-whatsapp-voice-agent");
  assert.ok(createAylaWhatsAppVoiceAgent());
});

test("Ayla voice policy is natural, privacy-safe and conversion-aware", () => {
  assert.match(AYLA_WHATSAPP_VOICE_INSTRUCTIONS, /warm, confident, enthusiastic, and human/i);
  assert.match(AYLA_WHATSAPP_VOICE_INSTRUCTIONS, /seven-day demo/i);
  assert.match(AYLA_WHATSAPP_VOICE_INSTRUCTIONS, /Audio recording is disabled/i);
  assert.match(AYLA_WHATSAPP_VOICE_INSTRUCTIONS, /Never ask for a password/i);
  assert.doesNotMatch(AYLA_WHATSAPP_VOICE_INSTRUCTIONS, /sk-|LIVEKIT_API_SECRET|WHATSAPP_ACCESS_TOKEN/);
});
