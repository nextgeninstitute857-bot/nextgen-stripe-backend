# Ayla request-first conversation correction

## Scope

NextGen CRM/WhatsApp admissions conversation quality only. No student/enrollment deletion, no ad edits/budget changes, no AylaMed or Library UI changes. Existing community posting, live invitations and recording-update schedulers are unchanged.

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

## Verification

125 isolated tests passed across conversation handling, templates, admin alerts, attribution, future reminders, product boundaries, calling/profile helpers and LMS recording/teaching guards. Tests include behavioral execution of the reply-lock and answered-message helpers. Syntax check and diff whitespace check pass.

These tests do not prove generated prose quality or actual WhatsApp receipt. No live lead was messaged. The current live no-send baseline was inspected separately.

## Release gates

- Candidate health identifier: `v305-request-first-conversation`.
- After deployment, rerun the same three synthetic turns using Ayla & Calls → Run no-send rehearsal. Require name retention, step clarification and a direct current-facts answer to payment/duration.
- Also rehearse explicit demo re-request, country then region, a busy student, and support. Do not send to real leads for this check.
- Verify root/login/demo and CRM still load; no student data migrations are part of this change.
- Do not claim a recording was watched, a demo activated, payment received or an enrollment completed from a link/message being sent.

## Still separate work

End-to-end invite → link open → demo activation → real recording watch tracking remains separate. This change does not create that tracking. Historical country/stage labels are not bulk-rewritten. Actual post-release conversion/quality outcomes still need observation.

## Method

Used official OpenAI guidance on clear instruction priority and task-specific evaluations with historical failure cases: https://developers.openai.com/api/docs/guides/prompt-engineering and https://developers.openai.com/api/docs/guides/evaluation-best-practices . No model/provider switch is included.
