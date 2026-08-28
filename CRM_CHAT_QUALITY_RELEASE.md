# Ayla request-first conversation correction

## Scope

NextGen CRM/WhatsApp admissions conversation quality only. No student/enrollment deletion, no ad edits/budget changes, no AylaMed or Library UI changes. Existing community posting and live/recording schedules are preserved. Recording delivery now records an experience invitation only after provider acceptance; failed/queued daily messages no longer set sent flags.

## Reproduced baseline (live no-send rehearsal, 2026-08-28)

Synthetic student, no phone recipient, no student record saved:

1. “Hi, I am Daniel. Can I get information about your programme?” → Ayla asked the name again.
2. “USMLE” → Ayla asked about preparation challenges without confirming the step.
3. “How long is the programme and what are the payment options?” → Ayla assumed Step 1, described 120 days, began a feature tour and omitted the payment options.

Live health identifies this baseline as `v304-sales-final-proof`.

## Changes

- Give the model an explicit turn goal. A direct question, accepted previous offer, requested link or support need takes priority over a feature tour. Keep all five separate feature cards for an appropriate overview turn.
- Remember self-introductions in the first message. Do not require name collection before answering a real question or sending a requested demo link.
- Treat consecutive student fragments as one turn. Canonical country and region/city are separate; a bare USMLE message cannot establish Step 1.
- Allow requested demo/recording/live links to be resent; retain protection against unsolicited repeats.
- Require evidence of the student's explicit payment commitment for the 4–5-hour payment follow-up. General interest and pricing questions do not qualify. Preserve later-date requests for the existing dated-reminder workflow. Send at most once per qualifying commitment, and do not substitute an old demo template.
- Serialize overlapping AI replies for the same lead/channel, briefly collect fragments, recheck the latest message before automatic delivery, and do not mark a newer message answered by an older reply.
- Preserve explicit human/manual takeover on inbound messages.
- Add a separate programme-experience check-in after an actually shared demo, recording or class link. Default delay: **6 hours**, as requested, configurable with `experience_followup_wait_hours` / `NEXTGEN_EXPERIENCE_FOLLOWUP_WAIT_HOURS` (6–72 hours). This is NOT the 4–5-hour payment reminder.
- Keep exact resource title/URL, accepted share time, pending check-in, provider receipt and evidence-backed student replies. Managed template buttons are read from the managed definition and actual parameters, not the ignored free-form body. No historical bulk backfill or false watched/activated/enrolled flags.
- Interpret used/partly-used/not-used, positive/mixed/negative feedback, declined and requested-later states. Store responses as **student self-report**, not playback telemetry. A later date is preserved and sent to the admin review queue for confirmation; an ambiguous date is never advertised as booked.
- Answer feedback naturally: if used, ask how it went; if positive, offer an enrollment step or optional mentor call; if negative, address the concern first; if not used, gently encourage the exact resource or offer a current, verified live session with its actual date/time/timezone. Never use yesterday's stored session as today's class.
- A clear natural acceptance of a single mentor-call offer can begin qualification. A yes to two choices or a recording-like question cannot. Explicitly declining a call does not request one.
- Limit to one check-in per experience batch, with a 48-hour gap between check-ins. No automatic chase after the student responds; a newly shared resource can start a later opportunity. Payment commitments, dated reminders, enrollment, opt-out, human takeover, active mentor appointments, new unanswered messages and recent outgoing messages block it.
- Generate the short check-in outside database transactions. Recheck current state, durably reserve the send, then use the existing atomic database mutation path. A crash or uncertain send is held for review rather than retried blindly. Add read-only `GET /admin/crm/automation/experience-followups` and actionable CRM review entries.

## Verification

142 isolated tests passed across conversation handling, experience follow-ups, templates, admin alerts, attribution, future reminders, product boundaries, calling/profile helpers and LMS recording/teaching guards. These include behavioral scheduler execution with the production copy-on-write mutation helper, concurrent changes, durable reservations, template boundaries, and no duplicate sends. Syntax check and diff whitespace check pass.

These tests do not prove generated prose quality or actual WhatsApp receipt. No live lead was messaged. The current live no-send baseline was inspected separately.

The development workspace has no configured OpenAI API key, so the new experience branches have not been run against the live model yet. The existing production no-send rehearsal will exercise them after deployment. Do not represent fixture-based regression tests as a live-model or real WhatsApp delivery pass.

## Release gates

- Candidate health identifier: `v305-request-first-conversation`.
- After deployment, rerun the same three synthetic turns using Ayla & Calls → Run no-send rehearsal. Require name retention, step clarification and a direct current-facts answer to payment/duration.
- Also rehearse explicit demo re-request, country then region, a busy student, and support. Do not send to real leads for this check.
- Rehearse share recording → not yet → current live-session offer; share demo → used/liked → enrollment options; partly watched → useful continuation; negative feedback → concern first; single mentor-call offer → natural acceptance; later-date request → preserved review item. Verify exact labels and no invented viewing or enrollment.
- This release defaults the **new proactive experience check-ins off** for the authorized no-send rehearsal. Explicit `experience_followup_enabled: true` or `NEXTGEN_EXPERIENCE_FOLLOWUP_ENABLED=true` is required to enable them after verification; either explicit false setting still blocks sends. Existing inbound replies and live/recording reminders are unchanged. The read-only queue reports the effective enabled state and wait hours. Scheduler work runs after the older heartbeat snapshot has been saved, so it is not overwritten by that snapshot.
- Verify root/login/demo and CRM still load; no student data migrations are part of this change.
- Do not claim a recording was watched, a demo activated, payment received or an enrollment completed from a link/message being sent.

## Still separate work

End-to-end invite → link open → demo activation → real recording watch tracking remains separate. This change does not create player analytics. Historical country/stage labels are not bulk-rewritten. Actual post-release conversion/quality outcomes still need observation.

Outside the student's 24-hour WhatsApp window, the new check-in is held in the CRM review queue. No welcome, payment, or recording-ready template is substituted. A purpose-matched **Marketing** template must be approved and wired before that path can send. No new Meta template was submitted by this change. Proposed wording for review:

> Hi {{1}} 👋 Just checking in about {{2}}—have you had a chance to try it? If you've been busy, I can help you catch a recording or the next live session.

The existing six-template pack and live/recording reminders remain separate. Use opt-in and opt-out rules for any re-engagement; template approval does not grant contact permission. Official policy: https://whatsappbusiness.com/policy/ .

## Method

Used official OpenAI guidance on clear instruction priority, structured memory and task-specific evaluations with historical failure cases: https://developers.openai.com/api/docs/guides/prompt-engineering , https://developers.openai.com/api/docs/guides/structured-outputs and https://developers.openai.com/api/docs/guides/evaluation-best-practices . No model/provider switch is included.

## Post-deployment recording-request correction (28 August 2026)

PR #279 was verified live as `v305-request-first-conversation`. The four-turn Daniel rehearsal retained the name, clarified the USMLE step, answered programme/payment questions and introduced the feature tour. A separate first-turn Sarah recording request was rejected by the new experience metadata guard (`experience_resource_not_shared`, `experience_missing_student_evidence`) before any resource had been shared. No WhatsApp message was sent.

The follow-up candidate `v306-experience-feedback-guard` restricts structured feedback IDs to the resources actually shared with the lead. With no prior delivery, the only allowed tracking outcome is `none`. Normalization also discards impossible first-request feedback; existing-resource feedback still requires an exact current-student quote and valid item ID. This does not disable the content/conversation quality gate or record a false viewing outcome. The prompt distinguishes a first request from feedback. The five-card tour, six-hour timing and disabled-by-default proactive sender are unchanged.

144 isolated regression tests pass, including the reproduced first-request defect and checks that genuine feedback still requires evidence. Syntax and whitespace checks pass. Live-model retesting of the correction remains a separate release gate; unit tests are not delivery or prose-quality proof.

## Live-model findings and final handoff correction

The v306 no-send rehearsal completed the four-turn recording/not-yet/partial/negative conversation and the feature-tour/demo-resend/positive-feedback sequence. It also exposed an explicit polite mentor request being missed: “Could I have a call with a mentor before deciding?” produced a false capability denial. The existing handoff matcher only covered “can I have,” and the decision guard prevented premature handoff but did not require a requested handoff.

Candidate `v307-experience-handoff-quality` accepts polite can/could/may requests, requires the existing handoff action for explicit consent, and permits a combined price-and-mentor request without conflicting with the no-forced-price-handoff rule. Refusals and “later/not now” remain protected. It also catches the observed vague endings and unsolicited repeated recording URLs, while preserving explicit resends. The AI prompt now guides partial-view feedback and practical help for recording pace. No fixed sales reply script or new booking system is introduced.

147 targeted regressions pass. No live messages, bookings, payments or student records were created by these rehearsals. The final deployed build still needs its live-model replay before any new proactive sending is enabled.
