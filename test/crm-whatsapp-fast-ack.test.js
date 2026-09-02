import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  applyAylaConversationDecision,
  createAylaConversationState,
} from "../lib/crm-ayla-conversation-engine.js";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const conversationEngine = fs.readFileSync(new URL("../lib/crm-ayla-conversation-engine.js", import.meta.url), "utf8");

test("WhatsApp webhook ignores Meta status callbacks before creating CRM leads", () => {
  const handler = server.slice(
    server.indexOf("async function handleUniversalWebhook"),
    server.indexOf('app.get("/webhooks/social/:platform/:integrationId?"'),
  );

  assert.match(server, /const CRM_AYLA_REPLY_BUILD = "v310-crm-session-retry-guard"/);
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
  const greetingGuard = server.slice(
    server.indexOf("function ngAylaApplyGreetingOnce"),
    server.indexOf("function ngAylaClarifyPreviousMessageReply"),
  );
  const replyPrompt = server.slice(
    server.indexOf("async function ngGenerateStudentAutoReply"),
    server.indexOf('app.post("/admin/crm/conversations/:leadId/ai-auto-send"'),
  );

  assert.match(replyPrompt, /createAylaConversationState/);
  assert.match(replyPrompt, /buildAylaConversationPrompt/);
  assert.match(replyPrompt, /normalizeAylaConversationDecision/);
  assert.match(replyPrompt, /evaluateAylaConversationDecision/);
  assert.match(greetingGuard, /\(\?:\\s\+there\)\?/);
  assert.doesNotMatch(replyPrompt, /if \(latestSignals\.bare_greeting\)/);
  assert.doesNotMatch(replyPrompt, /const confirmsInterest/);
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
  const generator = server.slice(
    server.indexOf("async function ngGenerateStudentAutoReply"),
    server.indexOf('app.post("/admin/crm/conversations/:leadId/ai-auto-send"'),
  );

  assert.match(generator, /textFormat: aylaConversationTextFormat\(promptState\)/);
  assert.match(generator, /const decision = normalizeAylaConversationDecision/);
  assert.match(generator, /evaluateAylaConversationDecision/);
  assert.match(generator, /buildAylaConversationRepairPrompt/);
  assert.match(generator, /decision\.action === "send_feature_tour"/);
  assert.match(generator, /lead\.ayla_conversation_state = nextState/);
  assert.match(generator, /media_asset_keys: decision\.media_keys/);
  assert.match(generator, /process\.env\.AYLA_MODEL \|\| process\.env\.AI_MODEL \|\| "gpt-4o-mini"/);
  assert.match(generator, /safeJsonParseFromAI\(result\.text \|\| "\{\}"\)/);
  assert.doesNotMatch(generator, /parseAIJson/);
  assert.match(generator, /decision\.action === "send_feature_tour"/);
  assert.match(generator, /decision\.follow_up = ngAylaFeatureOverviewClosingText/);
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
  assert.match(replyPrompt, /let liveSnapshot = await ngAylaLiveLmsSalesGrounding\(\{ structured: true, crmDb: db, lead, messages: cleanMessages \}\)/);
  assert.match(replyPrompt, /liveFacts: liveSnapshot\.context/);
  assert.match(replyPrompt, /officialExamGuidance/);
  assert.match(replyPrompt, /approvedKnowledge/);
  assert.match(replyPrompt, /mediaGuidance/);
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
  assert.match(media, /function ngAylaSafeWhatsAppMediaCaption/);
  assert.match(media, /function ngBuildAylaMediaDeliveryCopy/);
  assert.match(media, /cleanReply \|\| approvedFeatureCaption/);
  assert.match(media, /await ngAylaSleep\(3000\)/);
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
  assert.match(server, /ngBuildAylaMediaDeliveryCopy\(\{/);
  assert.match(server, /liveSnapshot: ai\.live_lms_sales_snapshot \|\| \{\}/);
  assert.match(server, /ayla_program_tour_sent_at = nowIso\(\)/);
  assert.match(server, /feature_tour_closing/);
});

test("human handoff follows programme value and sends admins a qualified meeting summary", () => {
  const handoff = server.slice(
    server.indexOf("function ngAylaHandoffExamLabel"),
    server.indexOf("function ngAylaPostRecordingInterestQuestion"),
  );
  const router = server.slice(
    server.indexOf("function ngAylaHardSalesRouter"),
    server.indexOf("function ngAylaNormalizeReplyForRepeat"),
  );
  const alerts = server.slice(
    server.indexOf("function ngAylaAdminAlertNumbers"),
    server.indexOf('app.get("/admin/crm/ai-command/admin-alerts/settings"'),
  );
  const generator = server.slice(
    server.indexOf("async function ngGenerateStudentAutoReply"),
    server.indexOf('app.post("/admin/crm/conversations/:leadId/ai-auto-send"'),
  );

  assert.match(server, /Human-handoff sequence/);
  assert.match(server, /do not proactively offer a Google Meet before Ayla has explained the programme/);
  assert.match(server, /A direct student request for a human is always respected/);
  assert.match(handoff, /function ngAylaHumanHandoffContext/);
  assert.match(handoff, /programme and roadmap/);
  assert.match(handoff, /7-day demo/);
  assert.match(handoff, /labelled recording/);
  assert.match(handoff, /diagnostic and weak-area adaptation/);
  assert.match(handoff, /function ngAylaNextHandoffQualificationField/);
  assert.match(handoff, /collect_google_meet_\$\{field\}/);
  assert.match(handoff, /Which email address should I use for your meeting confirmation/);
  assert.match(handoff, /Which country or city are you joining from/);
  assert.match(handoff, /main concern you want the mentor to help you solve/);
  assert.match(server, /What date and time work best for you, and which time zone should I use/);
  assert.match(server, /function ngAylaMeetingTimezoneFromText/);
  assert.match(server, /google_meet_time_missing_timezone/);
  assert.match(server, /timezone_label: preference\.timezone_label/);
  assert.match(server, /student_country: handoffContext\.country/);
  assert.match(server, /programme_coverage: handoffContext\.coverage/);
  assert.match(server, /qualified_meeting_booked_waiting_link/);
  assert.match(router, /ngAylaCaptureHandoffQualificationReply/);
  assert.match(router, /ngAylaCreateGoogleMeetAppointmentFromPreference\(db, lead, timePreference, latestText, cleanMessages\)/);
  assert.match(generator, /collectingMeetingQualification/);
  assert.match(generator, /decision\.action === "begin_human_handoff"/);
  assert.match(generator, /ngAylaNextHandoffQualificationField/);
  assert.match(generator, /protectedActionContext/);
  assert.match(alerts, /Meeting ready — NextGen lead/);
  assert.match(alerts, /Student wants a NextGen resource/);
  assert.match(alerts, /Interested in:/);
  assert.match(alerts, /Ayla has already explained/);
  assert.match(alerts, /Continue personally from here without asking the student to repeat/);
  assert.doesNotMatch(alerts, /AI intent:/);
  assert.doesNotMatch(alerts, /Status:\\n/);
  assert.doesNotMatch(alerts, /No\/unknown/);
  assert.match(alerts, /for \(const to of numbers\)/);
});

test("Ayla treats QBank, lecture and live-class enquiries as product leads with controlled country offers", () => {
  const grounding = server.slice(
    server.indexOf("function ngAylaSalesFeatureLabel"),
    server.indexOf("function ngAylaPricingDraftIsGrounded"),
  );
  const alerts = server.slice(
    server.indexOf("function ngAylaProductInterestLabels"),
    server.indexOf('app.get("/admin/crm/ai-command/admin-alerts/settings"'),
  );

  assert.match(alerts, /Question bank/);
  assert.match(alerts, /Recorded lectures/);
  assert.match(alerts, /Live classes/);
  assert.match(alerts, /return "product_interest"/);
  assert.match(grounding, /plan\.is_public !== false/);
  assert.match(grounding, /\["inactive", "archived", "closed"\]/);
  assert.match(grounding, /ngAylaApprovedCountryOfferForSales/);
  assert.match(grounding, /ngAylaConfirmedCountryForSales/);
  assert.match(grounding, /phone calling code only suggests/);
  assert.match(grounding, /Never invent a coupon/);
  assert.match(conversationEngine, /Treat a request for only QBank access, recorded lectures, or live classes as genuine product interest/);
});

test("country discounts require confirmation and generated codes are private, expiring and one-use", () => {
  const countryOffers = server.slice(
    server.indexOf("function ngAylaCountrySourceIsConfirmed"),
    server.indexOf("async function ngAylaLiveLmsSalesGrounding"),
  );
  const generator = server.slice(
    server.indexOf("async function ngGenerateStudentAutoReply"),
    server.indexOf("// Admin-only, no-send conversation evaluation"),
  );

  assert.match(countryOffers, /phone_calling_code_hint/);
  assert.match(countryOffers, /rule\.auto_issue_one_time !== true/);
  assert.match(countryOffers, /max_uses: 1/);
  assert.match(countryOffers, /assigned_email/);
  assert.match(countryOffers, /country_offer_issuances/);
  assert.match(countryOffers, /status = "redeemed"/);
  assert.match(countryOffers, /if \(dryRun\)/);
  assert.match(countryOffers, /-REHEARSAL/);
  assert.match(countryOffers, /redeemable: false/);
  assert.match(countryOffers, /ayla_no_send_simulation === true/);
  assert.match(countryOffers, /lead\.country_offer_shared_at && !ngAylaLatestInboundRequestsCountryOffer\(messages\)/);
  const dryRunStart = countryOffers.indexOf("if (dryRun)");
  const liveReadStart = countryOffers.indexOf("const liveDb = await readLiveDb()", dryRunStart);
  assert.ok(dryRunStart > 0 && liveReadStart > dryRunStart);
  const dryRunBranch = countryOffers.slice(dryRunStart, liveReadStart);
  assert.doesNotMatch(dryRunBranch, /readLiveDb\s*\(/);
  assert.doesNotMatch(dryRunBranch, /writeLiveDb\s*\(/);
  assert.doesNotMatch(dryRunBranch, /writeCrmDb\s*\(/);
  assert.match(generator, /allowOperationalActions = false/);
  assert.match(generator, /ngAylaEnsureOneTimeCountryOffer/);
  assert.match(generator, /approved_country_coupon_not_shared/);
  assert.match(generator, /approved_country_discount_not_stated/);
  assert.match(generator, /approved_country_offer_not_marked_one_time/);
  assert.match(generator, /approved_country_offer_expiry_not_stated/);
  assert.match(generator, /live_class_preview_missing_current_session/);
  assert.match(generator, /live_class_link_status_not_explained/);
  assert.match(generator, /const provisionalState = applyAylaConversationDecision/);
  assert.match(generator, /The student has now confirmed their country and the live facts contain their exact private offer/);
  assert.match(conversationEngine, /A phone calling code is only a location hint, never proof of country/);
  assert.match(conversationEngine, /nextFactSources\.country = "conversation_self_reported"/);
  assert.match(conversationEngine, /Current live LMS facts contain this student's approved private one-time country coupon/);
});

test("phone-derived countries stay unconfirmed until a student or admin confirms them", () => {
  const inferred = createAylaConversationState({
    lead: { country: "Pakistan", phone: "+923001234567" },
    messages: [{ role: "student", text: "Can I get a regional discount?" }],
  });
  assert.equal(inferred.facts.country, null);

  const manuallyConfirmed = createAylaConversationState({
    lead: { country: "Pakistan", country_confirmed: true, country_source: "admin" },
    messages: [],
  });
  assert.equal(manuallyConfirmed.facts.country, "Pakistan");

  const learned = applyAylaConversationDecision({
    state: inferred,
    decision: {
      stage: "discovery",
      intent: "country_answer",
      action: "reply_only",
      ask_field: "none",
      media_keys: [],
      memory_patch: { country: "Nigeria", exam: "unknown", student_type: "unknown" },
    },
  });
  assert.equal(learned.facts.country, "Nigeria");
  assert.equal(learned.fact_sources.country, "conversation_self_reported");
});

test("campaign country is used only as a friendly confirmation hint", () => {
  const countryGrounding = server.slice(
    server.indexOf("function ngAylaCountrySourceIsConfirmed"),
    server.indexOf("function ngAylaPricingDraftIsGrounded"),
  );

  assert.match(countryGrounding, /function ngAylaCampaignCountryHintForSales/);
  assert.match(countryGrounding, /campaign_country_hint/);
  assert.match(countryGrounding, /looks like you came through our .* campaign/i);
  assert.match(countryGrounding, /is that where you're currently based/i);
  assert.match(countryGrounding, /do not treat that as proof/i);
  assert.doesNotMatch(
    countryGrounding.slice(
      countryGrounding.indexOf("function ngAylaCountrySourceIsConfirmed"),
      countryGrounding.indexOf("function ngAylaCountryHintForSales"),
    ),
    /campaign_country_hint/,
  );
});

test("daily live and recording follow-ups hard-stop for enrolled, opted-out and not-interested leads", () => {
  const eligibility = server.slice(
    server.indexOf("function ngDailyLiveSessionEligibleLead"),
    server.indexOf("function ngDailyLiveSessionAttemptMatches"),
  );
  const scheduler = server.slice(
    server.indexOf("function ngDailyLiveSessionActionNow"),
    server.indexOf("function ngGoogleMeetAppointmentDateTime"),
  );

  assert.match(eligibility, /\["paid", "paid_enrolled", "enrolled", "converted"\]/);
  assert.match(eligibility, /\["not_interested", "lost", "unsubscribed"\]/);
  assert.doesNotMatch(eligibility, /daily_session_exclude_not_interested !== false/);
  assert.doesNotMatch(eligibility, /programmeValueShown/);
  assert.doesNotMatch(eligibility, /completed_actions\)\.includes\("send_feature_tour"\)/);
  assert.match(scheduler, /daily_session_invite/);
  assert.match(scheduler, /five_minute_reminder/);
  assert.match(scheduler, /session_link/);
  assert.match(scheduler, /post_session_recording/);
});

test("every reachable future lead enters the daily live-session sequence", () => {
  const source = server.slice(
    server.indexOf("function ngLeadIsPaidOrGroupAddedForLiveSession"),
    server.indexOf("function ngDailyLiveSessionAttemptMatches"),
  );
  const eligible = new Function(
    "normalizeCrmLeadStageValue",
    "ngAylaLeadGoogleMeetState",
    "ngAylaFindActiveGoogleMeetAppointment",
    "ng41IsSuppressed",
    "ng41LeadPhone",
    `${source}; return ngDailyLiveSessionEligibleLead;`,
  )(
    (value, fallback) => value || fallback,
    (lead) => Boolean(lead.google_meet_active),
    () => null,
    () => false,
    (lead) => lead.phone || "",
  );

  const settings = {
    daily_session_send_to_new_leads: true,
    daily_session_send_to_interested: true,
    daily_session_send_to_no_reply: true,
    daily_session_exclude_active_google_meet: true,
  };
  assert.equal(eligible({}, { id: "future", stage: "new_lead", phone: "+15550000001" }, settings), true);
  assert.equal(eligible({}, { id: "paid", stage: "paid", phone: "+15550000002" }, settings), false);
  assert.equal(eligible({}, { id: "opted-out", stage: "unsubscribed", phone: "+15550000003" }, settings), false);
  assert.equal(eligible({}, { id: "meet", stage: "new_lead", phone: "+15550000004", google_meet_active: true }, settings), false);
});

test("mentor booking notifies the student and admins without recording false sends", () => {
  const meetingFlow = server.slice(
    server.indexOf("function ngGoogleMeetAppointmentDateTime"),
    server.indexOf("function ngUpsertTodayLiveSessionOverride"),
  );
  const adminAlerts = server.slice(
    server.indexOf("function ngAylaAdminAlertTemplateLabel"),
    server.indexOf("async function ngSendAdminWhatsAppAlert"),
  );

  assert.match(meetingFlow, /getSessionStartUtc\(date, time, timezone\)/);
  assert.match(meetingFlow, /student_confirmation: studentConfirmation/);
  assert.match(meetingFlow, /ngGoogleMeetAppointmentAlreadySent\(db, item, "confirmation"\)/);
  assert.match(meetingFlow, /if \(studentConfirmation\.sent\) item\.google_meet_confirmation_sent_at/);
  assert.match(meetingFlow, /if \(!dryRun && sent\.sent\)/);
  assert.match(meetingFlow, /const sent = experienceDeliveryAccepted\(result\)/);
  assert.match(meetingFlow, /\["sent", "delivered", "read"\]\.includes/);
  assert.match(meetingFlow, /google_meet_booked_confirmation_failed/);
  assert.match(adminAlerts, /google_meet_booked.*Mentor call booked/);
  assert.match(adminAlerts, /google_meet_booked_confirmation_failed.*student confirmation needs attention/);
  assert.match(adminAlerts, /google_meet_booked.*The meeting is confirmed/);
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
  assert.match(server, /alreadyGreeted[\s\S]*?\(hi\|hello\|hey\)\(\?:\\s\+there\)\?/);
});

test("Ayla retrieves compact relevant approved training without duplicating the sales brain", () => {
  const training = server.slice(
    server.indexOf("function ngTrainingContextForFullAiAuto"),
    server.indexOf("function ngLeadConversationMessages"),
  );
  const generator = server.slice(
    server.indexOf("async function ngGenerateStudentAutoReply"),
    server.indexOf("const mediaGuidance", server.indexOf("async function ngGenerateStudentAutoReply")),
  );

  assert.match(training, /ngTrainingItemAllowedForAiUse/);
  assert.match(training, /b\.score - a\.score/);
  assert.match(training, /\.slice\(0, 12\)/);
  assert.match(training, /content\.slice\(0, 1600\)/);
  assert.match(training, /\.slice\(0, 18000\)/);
  assert.match(training, /REFERENCE FACTS/);
  assert.match(generator, /ngTrainingContextForFullAiAuto\(db, `\$\{latestInboundText\}/);
  assert.match(generator, /Training Center material is reference knowledge only/);
  assert.doesNotMatch(generator, /ngBuildAylaBackendSalesBrain/);
  assert.doesNotMatch(generator, /ngBuildAylaCommandContext/);
});

test("WhatsApp sales replies retain bounded output, short pacing and a contextual next step", () => {
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
  // The decision now includes evidence-backed payment and experience memory.
  // Bound structured output separately from the short student-facing reply.
  const structuredBudget = Number(generator.match(/maxOutputTokens: (\d+)/)?.[1]);
  assert.ok(structuredBudget > 0 && structuredBudget <= 1500);
  assert.match(conversationEngine, /reply: String\(raw.reply \?\? ""\).trim\(\).slice\(0, 1200\)/);
  assert.match(generator, /textFormat: aylaConversationTextFormat\(promptState\)/);
  assert.match(generator, /if \(violations\.length\)/);
  assert.match(generator, /AYLA_CONVERSATION_QUALITY_REJECTED/);
  assert.match(generator, /follow_up: decision\.follow_up/);
});

test("only an explicit payment commitment qualifies for the four-to-five-hour follow-up", () => {
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
  assert.match(nurture, /aylaPaymentFollowupEligibility/);
  assert.match(nurture, /if \(!permission.ok\) return permission/);
  assert.doesNotMatch(nurture, /free 7-day demo|baseline diagnostic/);
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

test("admin Ayla simulation uses the real conversation engine without sending or persisting", () => {
  const start = server.indexOf('app.post("/admin/crm/ayla-conversation/simulate"');
  const end = server.indexOf('app.post("/admin/crm/conversations/:leadId/ai-auto-send"', start);
  assert.ok(start > 0 && end > start);
  const route = server.slice(start, end);
  assert.match(route, /await ngGenerateStudentAutoReply/);
  assert.match(route, /no_send: true/);
  assert.match(route, /persisted: false/);
  assert.match(route, /country_offer_issuances: \[\]/);
  assert.match(route, /allowOperationalActions: true/);
  assert.match(route, /dryRunOperationalActions: true/);
  assert.match(route, /ayla_no_send_simulation: true/);
  assert.match(route, /shared_in_no_send_rehearsal/);
  assert.doesNotMatch(route, /sendCrmMessage\s*\(/);
  assert.doesNotMatch(route, /writeCrmDb\s*\(/);
});

test("Ayla deterministically repairs exact recording labels and unreleased live-link status", () => {
  const helperStart = server.indexOf("function ngAylaRepairLiveResourceGrounding");
  const helperEnd = server.indexOf("function ngAylaPricingDraftIsGrounded", helperStart);
  assert.ok(helperStart > 0 && helperEnd > helperStart);
  const helper = server.slice(helperStart, helperEnd);
  assert.match(helper, /recordingTitle/);
  assert.match(helper, /replace\(recordingUrl, labelledUrl\)/);
  assert.match(helper, /The direct join link is not available yet and will appear once it is published/);
  assert.match(helper, /The next session is/);

  const endingRepairStart = server.indexOf("function ngAylaRemoveVagueHandback");
  const endingRepairEnd = server.indexOf("function ngAylaPricingDraftIsGrounded", endingRepairStart);
  assert.ok(endingRepairStart > helperStart && endingRepairEnd > endingRepairStart);
  const endingRepair = server.slice(endingRepairStart, endingRepairEnd);
  assert.match(endingRepair, /vagueHandback/);
  assert.match(endingRepair, /follow_up: cleanPart/);

  const generatorStart = server.indexOf("async function ngGenerateStudentAutoReply");
  const generatorEnd = server.indexOf('app.post("/admin/crm/ayla-conversation/simulate"', generatorStart);
  const generator = server.slice(generatorStart, generatorEnd);
  assert.match(generator, /violations\.every/);
  assert.match(generator, /"vague_handback_ending"/);
  assert.match(generator, /ngAylaRemoveVagueHandback\(decision\)/);
  assert.match(generator, /ngAylaRepairLiveResourceGrounding\(decision, liveSnapshot, latestInboundText\)/);
  assert.ok(
    generator.indexOf("ngAylaRepairLiveResourceGrounding(decision, liveSnapshot, latestInboundText)")
      < generator.indexOf("AYLA_CONVERSATION_QUALITY_REJECTED"),
    "the grounded fallback must run before a student-facing reply is rejected",
  );
});

test("feature-tour delivery never stalls on a permission question", () => {
  const generatorStart = server.indexOf("async function ngGenerateStudentAutoReply");
  const generatorEnd = server.indexOf('app.post("/admin/crm/ayla-conversation/simulate"', generatorStart);
  const generator = server.slice(generatorStart, generatorEnd);
  assert.match(generator, /decision\.action === "send_feature_tour" && \/\[\?？\]\//);
  assert.match(generator, /I’ll show you how NextGen keeps/);
  assert.match(generator, /The five parts below work together/);
  assert.match(generator, /const examLabel = normalizeCrmString/);
  assert.match(generator, /const studentName = normalizeCrmString/);
  assert.doesNotMatch(generator, /const (?:examLabel|studentName) = cleanText/);
});

test("human handoff reuses conversation memory and a student-stated email before asking again", () => {
  const contextStart = server.indexOf("function ngAylaHumanHandoffContext");
  const contextEnd = server.indexOf("function ngAylaNextHandoffQualificationField", contextStart);
  const context = server.slice(contextStart, contextEnd);
  assert.match(context, /lead\.ayla_conversation_state/);
  assert.match(context, /rememberedFacts\.name/);
  assert.match(context, /rememberedFacts\.country/);
  assert.match(context, /rememberedFacts\.exam/);
  assert.match(context, /filter\(\(message\) => !ngIsOutboundMessage\(message\)\)/);
  assert.ok(context.includes("conversationEmail"));

  const requestStart = server.indexOf("function ngAylaCreateGoogleMeetRequest");
  const requestEnd = server.indexOf("function ngAylaGoogleMeetBookingReply", requestStart);
  const request = server.slice(requestStart, requestEnd);
  assert.match(request, /lead\.google_meet_email = context\.email/);
  assert.match(request, /lead\.google_meet_country = context\.country/);
  assert.match(request, /lead\.google_meet_concern = context\.concern/);
});

test("an explicit mentor booking captures a supplied date, time and timezone before asking again", () => {
  const routerStart = server.indexOf("function ngAylaHardSalesRouter");
  const routerEnd = server.indexOf("function ngAylaNormalizeReplyForRepeat", routerStart);
  const router = server.slice(routerStart, routerEnd);
  assert.match(router, /const directTimePreference = !missingQualification && ngAylaLooksLikeTimePreference\(latestText\)/);
  assert.match(router, /ngAylaCreateGoogleMeetAppointmentFromPreference\(db, lead, directTimePreference/);
  assert.match(router, /google_meet_time_collected_missing_link/);
  assert.match(router, /google_meet_pending_preference = directTimePreference/);
});

test("Ayla conversation memory commits only after every dispatched part is accepted", () => {
  const helper = server.slice(
    server.indexOf("function ngAylaCommitConversationTurnAfterDelivery"),
    server.indexOf("// Admin-only, no-send conversation evaluation"),
  );
  assert.match(helper, /results\.every\(\(result\) => ngAylaDeliveryActuallySent\(result\)\)/);
  assert.match(helper, /if \(!delivered \|\| !ai\.conversation_state\) return false/);
  assert.match(helper, /lead\.ayla_conversation_state = nextState/);
  assert.match(server, /conversationSendResults\.push\(\.\.\.extraMediaResults/);
  assert.match(server, /conversationSendResults\.push\(closingResult\)/);
  assert.match(server, /ngAylaCommitConversationTurnAfterDelivery\(\{ db, lead, ai, sendResults: conversationSendResults \}\)/);
});
