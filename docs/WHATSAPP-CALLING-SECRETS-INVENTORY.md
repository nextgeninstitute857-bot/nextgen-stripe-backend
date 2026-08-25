# WhatsApp AI calling secret inventory

This file records where credentials belong. It deliberately contains no secret values.

| Secret or setting | Stored in | Purpose | Safe state |
| --- | --- | --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | Render backend environment | Meta WhatsApp Cloud API messaging and calling | Never commit or display |
| `WHATSAPP_PHONE_NUMBER_ID` | Render backend environment | Registered business number identifier | Never commit |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Render backend environment and matching Meta webhook setting | Webhook verification | Rotate if exposed |
| `OPENAI_API_KEY` | LiveKit agent deployment secret and/or Render environment | Ayla Realtime voice model | Never commit or display |
| `LIVEKIT_URL` | Render backend and voice-agent deployment | LiveKit project endpoint | Configuration, not a password |
| `LIVEKIT_API_KEY` | Render backend and voice-agent deployment secret | LiveKit authentication | Never commit or display |
| `LIVEKIT_API_SECRET` | Render backend and voice-agent deployment secret | LiveKit authentication | Never commit or display |
| `LIVEKIT_WHATSAPP_AGENT_NAME` | Render backend | Must equal `ayla-whatsapp-voice-agent` | Non-secret |
| `LIVEKIT_WHATSAPP_AGENT_DEPLOYED` | Render backend | Becomes `true` only after a healthy worker is verified | Keep `false` until verified |
| `WHATSAPP_CALLING_WEBHOOK_ENABLED` | Render backend | Becomes `true` only after Meta `calls` webhook subscription is verified | Keep `false` until verified |
| `WHATSAPP_AI_CALLING_ENABLED` | Render backend | Final inbound-answering switch | Keep `false` until controlled test passes |

The source repository must contain only the names above, never their values. Audio recording remains disabled. A call log may store status, duration and a future text summary, but never SDP or audio.
