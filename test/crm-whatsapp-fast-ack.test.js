import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("WhatsApp webhook ignores Meta status callbacks before creating CRM leads", () => {
  const handler = server.slice(
    server.indexOf("async function handleUniversalWebhook"),
    server.indexOf('app.get("/webhooks/social/:platform/:integrationId?"'),
  );

  assert.match(server, /const CRM_AYLA_REPLY_BUILD = "v290-interested-lead-feature-tour"/);
  assert.match(handler, /if \(!inboundMessages\.length\)/);
  assert.match(handler, /event: "message_status"/);
  assert.match(handler, /event: "ignored_non_message"/);
  assert.ok(
    handler.indexOf("if (!inboundMessages.length)") < handler.indexOf("upsertSocialLead"),
    "status-only callbacks must be returned before lead creation",
  );
  assert.ok(
    handler.indexOf('event: "ignored_non_message"') < handler.indexOf("readCrmDb"),
    "empty WhatsApp callbacks must be acknowledged before loading CRM state",
  );
});

test("bare WhatsApp greetings stay conversational before the sales sequence", () => {
  const signals = server.slice(
    server.indexOf("function ngAylaLatestMessageSignals"),
    server.indexOf("function ngBuildAylaBackendSalesBrain"),
  );
  const salesBrain = server.slice(
    server.indexOf("function ngBuildAylaBackendSalesBrain"),
    server.indexOf("function ngBuildAylaCommandContext"),
  );
  const replyPrompt = server.slice(
    server.indexOf("async function ngGenerateStudentAutoReply"),
    server.indexOf('app.post("/admin/crm/conversations/:leadId/ai-auto-send"'),
  );

  assert.match(signals, /bareGreeting/);
  assert.match(signals, /bare_greeting: bareGreeting/);
  assert.match(signals, /short_reply: shortReply/);
  assert.match(salesBrain, /BARE GREETING TURN/);
  assert.match(salesBrain, /Do not pitch the LMS, demo, live session, recording, UWorld library, Google Meet, pricing/);
  assert.match(replyPrompt, /Do not begin the sales sequence/);
  assert.match(replyPrompt, /Do not say "Thank you, Doctor" in response to a bare hello/);
  assert.match(replyPrompt, /const hasPriorAylaReply = cleanMessages\.some/);
  assert.match(replyPrompt, /if \(latestSignals\.bare_greeting\)/);
  assert.match(replyPrompt, /If an existing student says hello again/);
  assert.match(replyPrompt, /intent: "natural_bare_greeting"/);
  assert.match(replyPrompt, /Do not mention or pitch any programme, LMS, demo, live session, recording, UWorld, Google Meet, price, feature, or offer/);
  assert.ok(
    replyPrompt.indexOf("if (latestSignals.bare_greeting)") < replyPrompt.indexOf("const backendSalesBrain"),
    "the greeting-only AI turn must run before the sales brain is constructed",
  );
});

test("greetings and ordinary acknowledgements cannot trigger LMS media without an interested-lead checkpoint", () => {
  const signals = server.slice(
    server.indexOf("function ngAylaLatestMessageSignals"),
    server.indexOf("function ngBuildAylaBackendSalesBrain"),
  );
  const mediaScore = server.slice(
    server.indexOf("function ngMediaTextMatchScore"),
    server.indexOf("function ngAylaRecentMediaUsageBlocked"),
  );
  const picker = server.slice(
    server.indexOf("function ngPickAylaMediaAssetsForReply"),
    server.indexOf("function ngPickAylaMediaAssetForReply"),
  );

  assert.match(signals, /replace\(\/\[\\u200B-\\u200D\\uFEFF\]\/g, ""\)/);
  assert.match(signals, /thanks\|thank\\s\*you\|great\|perfect\|noted/);
  assert.match(mediaScore, /let score = 0/);
  assert.doesNotMatch(mediaScore, /let score = Number\(asset\.priority/);
  assert.match(picker, /if \(signals\.greeting_or_short_reply\) return \[\]/);
  assert.match(picker, /forceFeatureTour \|\| ngAylaIsFullFeatureOverviewRequest/);
  assert.match(picker, /const text = latestInboundText/);
  assert.doesNotMatch(picker, /messages\)\.slice\(-6\)/);
  assert.ok(
    picker.indexOf("ngAylaIsFullFeatureOverviewRequest") < picker.indexOf("signals.greeting_or_short_reply"),
    "an explicit full feature request remains eligible for its requested feature tour",
  );
});

test("Ayla uses natural discovery and then confidently presents the connected programme", () => {
  const salesBrain = server.slice(
    server.indexOf("function ngBuildAylaBackendSalesBrain"),
    server.indexOf("function ngBuildAylaCommandContext"),
  );
  const generator = server.slice(
    server.indexOf("async function ngGenerateStudentAutoReply"),
    server.indexOf('app.post("/admin/crm/conversations/:leadId/ai-auto-send"'),
  );

  assert.match(salesBrain, /Consultative discovery/);
  assert.match(salesBrain, /Ask at most one useful question in a turn/);
  assert.match(salesBrain, /Listen-before-pitch rule/);
  assert.match(salesBrain, /stop asking permission and give the connected programme tour immediately/);
  assert.match(salesBrain, /Progressive value rule/);
  assert.match(salesBrain, /listening must not make the chat dry or passive/);
  assert.match(salesBrain, /Conversion checkpoint/);
  assert.match(salesBrain, /Do not let an engaged prospect leave the conversation without understanding why NextGen is different/);
  assert.match(salesBrain, /Interested-lead programme-tour rule/);
  assert.match(salesBrain, /Do not ask 'Would you like to know more\?' again/);
  assert.match(salesBrain, /baseline diagnostic plus visible weak areas/);
  assert.match(salesBrain, /Support boundary/);
  assert.doesNotMatch(salesBrain, /Early value sequence/);
  assert.match(generator, /normally 1-3 short sentences/);
  assert.match(generator, /Use consultative discovery before the programme-tour checkpoint/);
  assert.match(generator, /Messaging this admissions number is already evidence of interest/);
  assert.match(generator, /Never keep asking “Would you like to learn more\?”/);
  assert.match(generator, /Consultative does not mean passive/);
  assert.match(generator, /separate feature pictures and captions/);
  assert.match(generator, /PROGRAMME-TOUR CHECKPOINT FOR THIS TURN/);
  assert.match(generator, /feature_tour_requested: featureTourRequested/);
  assert.match(generator, /acknowledge briefly without sending a new asset/);
  assert.match(generator, /process\.env\.AYLA_MODEL \|\| process\.env\.AI_MODEL \|\| "gpt-4o-mini"/);
});

test("a positive interested reply triggers the tour only after context is known", () => {
  const helper = server.slice(
    server.indexOf("function ngAylaShouldPresentInterestedLeadTour"),
    server.indexOf("function ngPickAylaMediaAssetsForReply"),
  );

  assert.match(helper, /signals\.bare_greeting \|\| signals\.asks_price/);
  assert.match(helper, /stop\|unsubscribe\|do not message/);
  assert.match(helper, /ngAylaLeadGoogleMeetState\(lead\)/);
  assert.match(helper, /lead\.ayla_program_tour_sent_at/);
  assert.match(helper, /const confirmsInterest/);
  assert.match(helper, /tell me more/);
  assert.match(helper, /const examKnown/);
  assert.match(helper, /const needKnown/);
  assert.match(helper, /positiveAnswerToSpecificOffer/);
  assert.match(helper, /return examKnown && needKnown && !positiveAnswerToSpecificOffer/);
});

test("interested-lead tour routing behaves correctly for real message sequences", () => {
  const signalsSource = server.slice(
    server.indexOf("function ngAylaLatestMessageSignals"),
    server.indexOf("function ngAylaOfficialExamGuidancePrompt"),
  );
  const overviewSource = server.slice(
    server.indexOf("function ngAylaIsFullFeatureOverviewRequest"),
    server.indexOf("function ngAylaShouldPresentInterestedLeadTour"),
  );
  const helperSource = server.slice(
    server.indexOf("function ngAylaShouldPresentInterestedLeadTour"),
    server.indexOf("function ngPickAylaMediaAssetsForReply"),
  );
  const build = new Function(
    "safeArray",
    "ngMessageText",
    "ngLatestOutbound",
    "ngAylaLeadGoogleMeetState",
    `${signalsSource}\n${overviewSource}\n${helperSource}\nreturn ngAylaShouldPresentInterestedLeadTour;`,
  );
  const messageText = (message = {}) => String(message.text || "");
  const shouldTour = build(
    (value) => Array.isArray(value) ? value : [],
    messageText,
    (messages) => [...messages].reverse().find((message) => message.direction === "outbound" && messageText(message)),
    (lead) => Boolean(lead.google_meet_booking_state),
  );
  const engagedConversation = [
    { direction: "inbound", text: "I am preparing for Step 1" },
    { direction: "outbound", text: "How are you preparing right now?" },
    { direction: "inbound", text: "I am self studying and need structure" },
    { direction: "outbound", text: "NextGen can organise that. Would you like to learn more?" },
    { direction: "inbound", text: "Yes" },
  ];

  assert.equal(shouldTour({ messages: engagedConversation, latestInboundText: "Yes" }), true);
  assert.equal(shouldTour({ messages: [{ direction: "inbound", text: "Hello" }], latestInboundText: "Hello" }), false);
  assert.equal(shouldTour({ messages: engagedConversation, latestInboundText: "I cannot log in" }), false);
  assert.equal(shouldTour({ lead: { ayla_program_tour_sent_at: "2026-08-22T10:00:00Z" }, messages: engagedConversation, latestInboundText: "Yes" }), false);
  assert.equal(shouldTour({
    messages: [
      ...engagedConversation.slice(0, -2),
      { direction: "outbound", text: "Would you like me to send the 7-day demo link?" },
      { direction: "inbound", text: "Yes" },
    ],
    latestInboundText: "Yes",
  }), false);
});

test("official exam eligibility and passing guidance is grounded and only appears on demand", () => {
  const guidance = server.slice(
    server.indexOf("function ngAylaOfficialExamGuidancePrompt"),
    server.indexOf("function ngBuildAylaBackendSalesBrain"),
  );
  const salesBrain = server.slice(
    server.indexOf("function ngBuildAylaBackendSalesBrain"),
    server.indexOf("function ngBuildAylaCommandContext"),
  );

  assert.match(guidance, /if \(!asksGuidance\) return ""/);
  assert.match(guidance, /Step 2 CK is 218/);
  assert.match(guidance, /Step 3 is 200/);
  assert.match(guidance, /ECFMG Sponsor Note/);
  assert.match(guidance, /PLAB 1 does not have one permanent numeric pass mark/);
  assert.match(guidance, /250 described as the pass mark/);
  assert.match(guidance, /pass score of 439/);
  assert.match(guidance, /0\.00 logits for NCLEX-RN/);
  assert.match(guidance, /-0\.18 logits for NCLEX-PN/);
  assert.match(guidance, /Distinguish where an exam can be taken from the country\/jurisdiction/);
  assert.match(guidance, /Do not make a final legal\/regulatory eligibility determination/);
  assert.match(guidance, /Share at most one most-relevant official source link/);
  assert.match(salesBrain, /const officialExamGuidance = ngAylaOfficialExamGuidancePrompt/);
  assert.match(salesBrain, /officialExamGuidance/);
});

test("AI generation keeps one long-lived lock per inbound message", () => {
  const guard = server.slice(
    server.indexOf("const NG_AI_AUTO_COOLDOWN_SECONDS"),
    server.indexOf("function ngNormalizeLeadAiMode"),
  );

  assert.match(guard, /const NG_AI_AUTO_LOCK_TTL_SECONDS = Number\(process\.env\.AI_AUTO_LOCK_TTL_SECONDS \|\| 180\)/);
  assert.match(guard, /ttlSeconds: options\.lockTtlSeconds \|\| NG_AI_AUTO_LOCK_TTL_SECONDS/);
});

test("AI delivery dedupe scopes each reply to its inbound message instead of the reusable worker attempt", () => {
  const deliveryPurpose = server.slice(
    server.indexOf("function ngBuildDeliveryPurpose"),
    server.indexOf("function ngBuildDeliveryDedupeKey"),
  );

  assert.match(deliveryPurpose, /metadata\.ai_auto === true && metadata\.inbound_message_id/);
  assert.match(deliveryPurpose, /`ai_auto_reply:\$\{metadata\.inbound_message_id\}`/);
  assert.ok(
    deliveryPurpose.indexOf("aiInboundPurpose") < deliveryPurpose.indexOf("metadata.source"),
    "the unique inbound fingerprint must take precedence over the repeated attempt source",
  );
});

test("WhatsApp inbound messages are journaled and acknowledged before CRM or AI work", () => {
  const handler = server.slice(
    server.indexOf("async function handleUniversalWebhook"),
    server.indexOf('app.get("/webhooks/social/:platform/:integrationId?"'),
  );

  assert.match(handler, /ngJournalWhatsAppWebhook/);
  assert.match(handler, /event: "inbound_queued"/);
  assert.match(handler, /source: "whatsapp_durable_journal"/);
  assert.ok(
    handler.indexOf("ngJournalWhatsAppWebhook") < handler.indexOf("readCrmDb"),
    "WhatsApp must be journaled before the large CRM database is read",
  );
  assert.ok(
    handler.indexOf('event: "inbound_queued"') < handler.indexOf("readCrmDb"),
    "WhatsApp must return before CRM or AI processing",
  );
});

test("WhatsApp journal recovery deduplicates provider message IDs and wakes Ayla after persistence", () => {
  const journal = server.slice(
    server.indexOf("let ngWhatsAppWebhookJournalWriteQueue"),
    server.indexOf("async function verifyMetaWebhook"),
  );

  assert.match(journal, /WHATSAPP_WEBHOOK_JOURNAL_PATH/);
  assert.match(journal, /record_type: "queued"/);
  assert.match(journal, /record_type === "processed" \|\| record\.record_type === "duplicate"/);
  assert.match(journal, /ngFindWhatsAppInboundConversationByProviderId/);
  assert.match(journal, /source: "whatsapp_durable_journal_wakeup"/);
  assert.ok(
    journal.indexOf("await writeCrmDb(db)") < journal.indexOf("source: \"whatsapp_durable_journal_wakeup\""),
    "Ayla must only wake after the inbound CRM record is durable",
  );
});

test("heartbeat scans recent pending leads instead of slicing the first stored leads", () => {
  const runner = server.slice(
    server.indexOf("async function ngAylaRunPendingFullAiAuto"),
    server.indexOf("function ngScheduleAylaAutoReplyAfterInbound"),
  );

  assert.match(runner, /\.sort\(\(a, b\) =>/);
  assert.match(runner, /if \(results\.length >= maxResults\) break/);
  assert.doesNotMatch(runner, /\.slice\(0,/);
});

test("AI conversation history never borrows explicitly owned messages from a duplicate phone lead", () => {
  const history = server.slice(
    server.indexOf("function ngLeadConversationMessages"),
    server.indexOf("function ngMessageText"),
  );

  assert.match(history, /const explicitLeadIds = \[/);
  assert.match(history, /if \(explicitLeadIds\.length\) return explicitLeadIds\.includes\(id\)/);
  assert.ok(
    history.indexOf("if (explicitLeadIds.length) return explicitLeadIds.includes(id)") < history.indexOf("if (!leadPhones.length) return false"),
    "an explicit lead owner must be decided before the legacy phone-number fallback",
  );
  assert.ok(
    history.indexOf("item.crm_lead_id") < history.indexOf("if (explicitLeadIds.length)"),
    "all known explicit CRM ownership fields must be considered",
  );
});

test("Ayla grounds current cohort and pricing answers in the live LMS", () => {
  const grounding = server.slice(
    server.indexOf("async function ngAylaLiveLmsSalesGrounding"),
    server.indexOf("function ngAylaRecordingTitle"),
  );
  const salesBrain = server.slice(
    server.indexOf("function ngBuildAylaBackendSalesBrain"),
    server.indexOf("function ngBuildAylaCommandContext"),
  );
  const replyPrompt = server.slice(
    server.indexOf("async function ngGenerateStudentAutoReply"),
    server.indexOf('app.post("/admin/crm/conversations/:leadId/ai-auto-send"'),
  );

  assert.match(grounding, /await readLiveDb\(\)/);
  assert.match(grounding, /Approved public prices/);
  assert.match(grounding, /already underway/);
  assert.match(grounding, /Never say.*July 1.*upcoming/);
  assert.match(grounding, /Official pricing\/enrollment page: https:\/\/nextgenusmle\.live\/pricing/);
  assert.match(grounding, /Do not invent Basic, Standard, Premium/);
  assert.match(grounding, /latestPublishedRecording/);
  assert.match(grounding, /Latest published recording/);
  assert.match(grounding, /When sharing it, always state this exact title before the link/);
  assert.match(grounding, /live_session:/);
  assert.match(grounding, /latest_recording:/);
  assert.match(salesBrain, /give the exact active public plan names and USD prices/);
  assert.match(replyPrompt, /const liveLmsSalesSnapshot = await ngAylaLiveLmsSalesGrounding\(\{ structured: true \}\)/);
  assert.match(replyPrompt, /Never invent packages or hide public prices behind a Google Meet/);
  assert.match(replyPrompt, /Never send a raw or generic recording link/);
  assert.match(replyPrompt, /Never send a raw or generic live-session link/);
  assert.match(replyPrompt, /Do not omit Dermatology/);
  assert.match(replyPrompt, /Do not invent a different system count/);
  assert.match(replyPrompt, /\$\{liveLmsSalesGrounding\}/);
});

test("Ayla explains weak-area adaptation and sends only safe public LMS previews", () => {
  const salesBrain = server.slice(
    server.indexOf("function ngBuildAylaBackendSalesBrain"),
    server.indexOf("function ngBuildAylaCommandContext"),
  );
  const media = server.slice(
    server.indexOf("const NG_AYLA_MEDIA_USAGE_DEFINITIONS"),
    server.indexOf("function ngFindCrmMediaAssetForRules"),
  );

  assert.match(salesBrain, /first ask the student to take the baseline diagnostic/);
  assert.match(salesBrain, /visibly show weak areas/);
  assert.match(salesBrain, /targeted flashcards, revision, roadmap tasks, and mentor guidance/);
  assert.match(salesBrain, /weekly\/weekend when published and after each system\/block/);
  assert.match(media, /function ngAylaIsSafePublicLmsPreview/);
  assert.match(media, /\["homepage_course_preview", "demo_lms_preview", "demo_lms", "course_card"\]/);
  assert.match(media, /asset\.homepage_visible === true/);
  assert.match(media, /blockedPreview/);
  assert.match(media, /nextgen-lms-adaptive-preview-v2\.png/);
  assert.match(media, /nextgen-lms-dashboard-real-preview\.png/);
  assert.match(media, /nextgen-lms-recordings-real-preview\.png/);
  assert.match(media, /nextgen-lms-session-notes-real-preview\.png/);
  assert.match(media, /nextgen-lms-flashcards-real-preview\.png/);
  assert.match(media, /nextgen-lms-assessments-real-preview\.png/);
  assert.match(media, /function ngAylaIsFullFeatureOverviewRequest/);
  assert.match(media, /function ngPickAylaMediaAssetsForReply/);
  assert.match(media, /function ngSendAylaAdditionalMediaAssets/);
  assert.match(media, /Adaptive Flashcards/);
  assert.match(media, /Baseline Diagnostic & Mentor-Led Assessments/);
  assert.match(media, /Weak areas are shown to you/);
  assert.match(media, /Mentor-Led Assessments/);
  assert.match(media, /function ngAylaFeatureOverviewClosingText/);
  assert.match(media, /function ngSendAylaFeatureOverviewClosingMessage/);
  assert.match(media, /delivery_purpose: `\$\{source\}_feature_media_\$\{inboundMessageId/);
  assert.match(media, /delivery_purpose: `\$\{source\}_feature_tour_closing_\$\{inboundMessageId/);
  assert.match(media, /6 \* 60 \* 60 \* 1000/);
});

test("an interested lead receives separate feature cards before the demo conversion", () => {
  assert.match(server, /Full feature-overview rule/);
  assert.match(server, /one short professional line per feature/);
  assert.match(server, /do not place the demo invitation before the explanation/);
  assert.match(server, /https:\/\/nextgenusmle\.live\/demo/);
  assert.match(server, /Attend live whenever you can/);
  assert.match(server, /matching labelled recording/);
  assert.match(server, /maxOutputTokens: featureTourRequested \? 220 : 140/);
  assert.match(server, /forceFeatureTour: featureTourRequested/);
  assert.match(server, /featureTourRequested && aylaMediaAsset \? firstMediaCaption : ai\.reply/);
  assert.match(server, /liveSnapshot: ai\.live_lms_sales_snapshot \|\| \{\}/);
  assert.match(server, /ayla_program_tour_sent_at = nowIso\(\)/);
  assert.match(server, /feature_tour_closing/);
});

test("a public price question does not create or lock a Google Meet handoff", () => {
  const router = server.slice(
    server.indexOf("function ngAylaHardSalesRouter"),
    server.indexOf("function ngAylaNormalizeReplyForRepeat"),
  );
  const generator = server.slice(
    server.indexOf("async function ngGenerateStudentAutoReply"),
    server.indexOf("const trainingContext"),
  );

  assert.match(router, /Pricing is public information/);
  assert.doesNotMatch(generator, /ngAylaIsPriceQuestion\(latestInboundTextForRouting\)/);
  assert.match(server, /const priceOnlyHandoff =/);
  assert.match(server, /if \(priceOnlyHandoff\) return false/);
  assert.match(server, /function ngAylaPricingDraftIsGrounded/);
  assert.match(server, /async function ngAylaGenerateGroundedPricingReply/);
  assert.match(server, /if \(!ngAylaPricingDraftIsGrounded\(reply, snapshot\)\)/);
  assert.match(server, /intent: "live_lms_grounded_pricing"/);
  assert.match(server, /WhatsApp already linkifies plain URLs/);
  assert.match(server, /cleanLabel === cleanUrl \? cleanUrl/);
  assert.match(server, /This is an ongoing conversation, so do not greet again/);
  assert.match(server, /alreadyGreeted[\s\S]*?\(hi\|hello\|hey\)\[,!\.، \]\+/);
});

test("Ayla retrieves compact relevant approved training without duplicating the sales brain", () => {
  const training = server.slice(
    server.indexOf("function ngTrainingContextForFullAiAuto"),
    server.indexOf("function ngLeadConversationMessages"),
  );
  const generator = server.slice(
    server.indexOf("async function ngGenerateStudentAutoReply"),
    server.indexOf("const latestSignals"),
  );

  assert.match(training, /b\.score - a\.score/);
  assert.match(training, /\.slice\(0, 12\)/);
  assert.match(training, /content\.slice\(0, 1600\)/);
  assert.match(training, /\.slice\(0, 18000\)/);
  assert.match(generator, /ngTrainingContextForFullAiAuto\(db, `\$\{latestInboundTextForRouting\}/);
  assert.match(generator, /includeBackendSalesBrain: false/);
  assert.match(server, /includeBackendSalesBrain \? ngBuildAylaBackendSalesBrain/);
});

test("WhatsApp sales replies stay fast and end with a concrete contextual next step", () => {
  const pacing = server.slice(
    server.indexOf("function ngAylaAutoReplyDelayMs"),
    server.indexOf("async function ngGenerateStudentAutoReply"),
  );
  const generator = server.slice(
    server.indexOf("async function ngGenerateStudentAutoReply"),
    server.indexOf('app.post("/admin/crm/conversations/:leadId/ai-auto-send"'),
  );

  assert.match(pacing, /normalizeSocialPlatform\(channel\) === "whatsapp"/);
  assert.match(pacing, /Math\.min\(configuredMs, 1200\)/);
  assert.match(generator, /When a student hesitates after opening the demo or choosing a plan/);
  assert.match(generator, /one concrete next action that matches the conversation/);
  assert.match(generator, /Do not restart discovery, resend the demo/);
  assert.match(generator, /never invent testimonials/);
  assert.match(generator, /maxOutputTokens: featureTourRequested \? 220 : 140/);
});

test("quiet sales conversations receive one short follow-up after four to five hours", () => {
  const nurture = server.slice(
    server.indexOf("// v116: Backend-first Ayla heartbeat and no-reply nurture."),
    server.indexOf("async function ngV116RunNoReplyLmsNurture"),
  );

  assert.match(nurture, /4-5 hour wait/);
  assert.match(nurture, /Math\.max\(4, Math\.min\(5/);
  assert.match(nurture, /NEXTGEN_NO_REPLY_NURTURE_WAIT_HOURS \|\| 4\.5/);
  assert.match(nurture, /const latestInbound = ngLatestInbound\(messages\)/);
  assert.match(nurture, /const latestOutbound = ngLatestOutbound\(messages\)/);
  assert.match(nurture, /latestInboundAt >= latestOutboundAt/);
  assert.match(nurture, /waiting_4_to_5_hours/);
  assert.match(nurture, /free 7-day demo/);
  assert.match(nurture, /baseline diagnostic/);
});

test("WhatsApp provider authorization failures open a shared circuit breaker", () => {
  assert.match(server, /const NG_WHATSAPP_PROVIDER_BLOCK =/);
  assert.match(server, /function ngWhatsAppProviderBlockStatus\(\)/);
  assert.match(server, /function ngBlockWhatsAppProvider\(/);
  assert.match(server, /text\.includes\("api access blocked"\)/);
  assert.match(server, /provider_configuration_blocked: true/);
  assert.match(server, /if \(!dryRun && ngWhatsAppProviderBlockStatus\(\)\.blocked\) return \[\]/);
  assert.match(server, /whatsapp_provider_block: ngWhatsAppProviderBlockStatus\(\)/);
});

test("WhatsApp webhook verification accepts the masked CRM integration secret", () => {
  const verifier = server.slice(
    server.indexOf("async function getMetaWebhookVerifyTokens"),
    server.indexOf("function verifyTelegramSecretHeader"),
  );

  assert.match(verifier, /readCrmDb\(\)/);
  assert.match(verifier, /ensureCrmArray\(db, "integrations"\)/);
  assert.match(verifier, /integration\.api_secret/);
  assert.match(verifier, /expectedTokens\.has\(String\(token\)\)/);
  assert.match(verifier, /process\.env\.WHATSAPP_WEBHOOK_VERIFY_TOKEN/);
});

test("integration edits preserve stored credentials when the UI submits blanks", () => {
  const updateRoute = server.slice(
    server.indexOf('app.put("/admin/crm/integrations/:id"'),
    server.indexOf('app.delete("/admin/crm/integrations/:id"'),
  );

  assert.match(updateRoute, /\["api_key", "api_secret", "access_token"\]/);
  assert.match(updateRoute, /if \(!value \|\| value\.includes\("\*\*\*"\)\) delete payload\[key\]/);
  assert.match(updateRoute, /normalizeCrmCollectionPayload\("integrations", payload,/);
});

test("WhatsApp runtime sends prefer the saved CRM integration credentials", () => {
  const resolver = server.slice(
    server.indexOf("async function resolveWhatsAppCloudConfig"),
    server.indexOf("async function sendWhatsAppCloudMessage"),
  );
  const sender = server.slice(
    server.indexOf("async function sendWhatsAppCloudMessage"),
    server.indexOf("async function sendTelegramMessage"),
  );

  assert.match(resolver, /getIntegrationByPlatform\(crmDb, "whatsapp"\)/);
  assert.match(resolver, /selectedIntegration\?\.api_key/);
  assert.match(resolver, /selectedIntegration\?\.access_token/);
  assert.ok(
    resolver.indexOf("selectedIntegration?.api_key") < resolver.indexOf("process.env.WHATSAPP_ACCESS_TOKEN"),
    "the stored CRM token must be preferred over the legacy environment fallback",
  );
  assert.match(sender, /resolveWhatsAppCloudConfig\(\{ db, integration \}\)/);
  assert.match(sender, /ngClearWhatsAppProviderBlock\(\)/);
  assert.match(server, /caption: resolvedCaption,[\s\S]*?db,[\s\S]*?integration,/);
});
