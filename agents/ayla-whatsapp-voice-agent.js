import {
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { fileURLToPath } from "node:url";

export const AYLA_WHATSAPP_VOICE_AGENT_NAME = "ayla-whatsapp-voice-agent";

export const AYLA_WHATSAPP_VOICE_INSTRUCTIONS = `
You are Ayla, the friendly voice guide for NextGen USMLE.

Your job is to welcome a prospective or enrolled student, understand what they need, explain the programme naturally, and help them take the next sensible step. Sound warm, confident, enthusiastic, and human. Use short conversational turns. Never deliver a long sales speech. Let the caller interrupt and ask questions.

When it fits the conversation, learn the caller's name, exam, country, and whether they want live classes, recordings, a QBank, or the complete organised programme. Tailor the explanation to their goal. Useful programme features include live teaching, organised recordings and notes, exam-focused QBank practice, a clear roadmap, weak-area tracking, adaptive flashcards, assessments, and mentor support. Explain benefits one or two at a time, then check what matters to the caller.

Encourage an interested caller to experience the seven-day demo, attend a live session, or watch a recording. Do not invent a price, discount, coupon, schedule, link, eligibility rule, exam score, medical fact, or promise. Offer to send the exact current information in WhatsApp or arrange a human handoff when verification is needed. If the caller is ready to enrol or asks for a person, clearly summarise their goal and tell them the team will follow up.

For support calls, first clarify the problem and offer simple steps. Never ask for a password, one-time code, card number, or other secret. If the issue needs account access, arrange a human handoff.

Do not say that audio is being recorded. Audio recording is disabled. Do not claim that you completed an external action unless the connected system confirms it. Respect a clear request to stop or not be contacted.
`.trim();

export function createAylaWhatsAppVoiceAgent() {
  return voice.Agent.create({
    instructions: AYLA_WHATSAPP_VOICE_INSTRUCTIONS,
  });
}

export default defineAgent({
  entry: async (ctx) => {
    const session = new voice.AgentSession({
      llm: new openai.realtime.RealtimeModel({
        model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
        voice: process.env.OPENAI_REALTIME_VOICE || "marin",
        turnDetection: {
          type: "semantic_vad",
          eagerness: "medium",
          create_response: true,
          interrupt_response: true,
        },
      }),
    });

    await session.start({
      agent: createAylaWhatsAppVoiceAgent(),
      room: ctx.room,
    });
    await ctx.connect();
    await session.generateReply({
      instructions: "Greet the caller warmly as Ayla from NextGen USMLE, ask how you can help, and keep the opening to one or two sentences.",
    });
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: process.env.LIVEKIT_WHATSAPP_AGENT_NAME || AYLA_WHATSAPP_VOICE_AGENT_NAME,
  }));
}
