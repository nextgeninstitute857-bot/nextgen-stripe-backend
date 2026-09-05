# Private MCCQE CRM demo pilot

This extends the existing administrator invitation, WhatsApp inbound controller and experience-follow-up paths; it is not a replacement CRM. Deployment and activation must be verified separately: the historical checkpoints below are test evidence, not current production status.

## Feature boundary

- `AYLAMED_MCCQE_DEMO_FLOW_ENABLED=true` is required for this pilot; absent/false means disabled.
- General `AYLAMED_AI_AUTO_SEND_ENABLED` remains disabled. A single-use, process-local capability permits only a reserved and freshly verified private-demo check-in through the existing central sender.
- Existing administrator authentication protects `POST /admin/mobile/invitations`.
- Explicit invitation fields: `product: "aylamed"`, `crm_demo: true`, `crm_lead_id`, `brand_id: "brand_aylamed"`, confirmed matching `email`, `exam_track_id: "mccqe"`, and a stable `idempotency_key` of 8–160 characters.
- The lead must have a student conversation and must not be stopped, filtered, paid or awaiting brand review. The assigned exam and email must match; country and phone digits are not sufficient identity.
- The server fixes access to exactly five hours from persisted issuance. Replays do not restart the clock, reset an existing password, or send another email.
- New accounts use the existing credential invitation helper. Existing accounts retain their current password and authentication version. No credentials are returned by this mode.
- The private enrollment uses `source: "crm_mccqe_demo"`, the MCCQE website and the existing starting-choice setup. It does not create a public signup/demo offer.

## Optional exact-lead restriction

The local pilot-restriction patch adds `AYLAMED_MCCQE_DEMO_PILOT_LEAD_ID`. It has no default target and does not enable any feature. Set it only to the actual CRM lead ID identified from the authorized tester's genuine inbound conversation; do not create a synthetic lead or substitute an email, phone number or guessed ID.

- **Absent:** preserves the existing behavior for all otherwise eligible demo leads. Removing this variable while the demo flag is ON therefore broadens eligibility again.
- **Present:** trims only the configured value, then requires an exact, case-sensitive lead ID. Lists, wildcards, embedded whitespace, empty/whitespace-only values and malformed values fail closed. A malformed present value does not mean unrestricted.
- Existing demo, intake, identity, entitlement, stop, takeover, delivery and provider requirements still apply. A matching ID alone is never authorization.
- The restriction applies before invitation reservation, immediately before email delivery, to signed intake, all-lead expiry candidate scans, authoritative send checks, and single-use capability issuance/consumption. Email and WhatsApp providers check again after awaited configuration, immediately before the provider action.
- Reconciliation does not restore or dispatch non-pilot follow-ups while restricted. Existing non-pilot accounts, access, issuance records and queued follow-ups are retained, not deleted or cancelled solely for being outside the pilot. They remain subject to the original safeguards if the scope later changes.
- If scope changes after reservation, the reserved account and original five-hour window remain intact; a blocked/cancelled or uncertain delivery is not automatically resent and replay never restarts access. It needs administrator review, not a new key or ordinary-invitation fallback.
- Public health reports only `crm_mccqe_demo_pilot_restricted: true|false`, never the configured lead ID. The boolean also stays true for malformed configuration, so it does not prove that a valid target is ready.

For an **administrator-controlled single-lead test**, keep both `AYLAMED_MCCQE_WHATSAPP_INTAKE_ENABLED` and `AYLAMED_AI_AUTO_SEND_ENABLED` OFF, configure the exact verified lead restriction, and enable the existing demo-flow flag only after readiness review. This is **not an email-only switch**: the same target's accepted issuance may subsequently receive its eligible five-hour expiry WhatsApp check-in through the existing narrow capability. Other leads cannot issue or send a private demo while restricted. The Meta signing secret is needed for signed automatic intake, not for the authenticated administrator action. No flags, secrets, pilot IDs or live recipients are configured by the local tests.

## Signed WhatsApp qualification (local, disabled)

The existing WhatsApp generator now has a bounded deterministic private-demo controller, before any model call. A narrow pre-AI filter ignores explicit job/service/SEO/partnership offers and non-medical enquiries without spending model credits. Mixed or ambiguous wording is conservatively held; this is not a claim that every irrelevant enquiry can be recognized.

Three independent controls remain OFF by default:

- `AYLAMED_MCCQE_DEMO_FLOW_ENABLED`: the existing invitation/follow-up pilot.
- `AYLAMED_MCCQE_WHATSAPP_INTAKE_ENABLED`: the new student-request-to-email action; requires the demo flag too.
- `AYLAMED_AI_AUTO_SEND_ENABLED`: automatic WhatsApp replies. The intake action does not bypass the central sender's general flag. The prior single-use expiry-check-in capability remains unchanged.

`AYLAMED_META_APP_SECRET` must be configured from the Meta app that actually signs the receiving number's webhooks. No existing Meta app-secret configuration was found to reuse. Its absence is a launch blocker for this intake; never substitute an access token or subscription verify token. The application captures raw bytes only on WhatsApp webhook routes and persists a valid SHA-256 HMAC proof with the conversation. It verifies that proof again when qualifying and reserving access. No secret is stored with the proof. Existing webhook acceptance is unchanged for other/legacy flows; historical unsigned messages do not become trusted merely because they have a provider ID.

For an automatic **new-account invitation**, all of these must match:

1. One recent signed text message, provider message ID, WhatsApp sender/contact ID, configured receiving phone-number asset, integration and explicit AylaMed lead. The intended recipient is rechecked at the central WhatsApp sender, including after the prospect becomes an account.
2. Student-written medical-role and MCCQE confirmation, an explicit request for a demo, one intended delivery email and a second distinct student message confirming that address. A vague “yes,” ad inference, assistant promise, model memory or quoted third-party request cannot grant access. Repeating an email confirms intended delivery only; it **does not verify email ownership**.
3. Authoritative storage confirms there is no existing/ambiguous AylaMed account, prior invitation or orphaned access/payment record for that address, unless replaying this exact previously bound invitation. Existing account collisions receive the same generic review wording, without revealing account existence, linking the account, resetting a password or changing its access.
4. No opt-out, human takeover, global pause, suppressed contact, payment self-report, conflicting exam/address, stale message or changed ownership. Eligibility is rechecked inside the existing durable reservation and again immediately before email delivery.

Credentials/access remain solely in the intended inbox. WhatsApp only receives a truthful email-send acknowledgement after provider acceptance, never a password. Requests awaiting uncertain email delivery are not automatically resent. Per-account/exam ledger and stable request keys prevent duplicate/concurrent trials and clock restarts. Signed request lineage is stored on the existing issuance, not in a new CRM.

Verified prospect context means only the authenticated WhatsApp sender/receiving asset is known. Payment remains `null` (unknown), demo status remains `unknown`, and email ownership remains unverified. Account or expiry claims require the independently verified existing account/issuance context. Account collisions and missing proof remain review-only. The initial parser deliberately accepts only a single text message/contact per signed envelope, within 24 hours; attachments, batches, conflicting exams, multilingual/unrecognized qualification phrasing and older histories require review rather than guessed authorization.

## Delivery and purchase safeguards

The durable AylaMed issuance ledger reserves email delivery before the external provider call. Only provider acceptance creates the CRM resource and expiry timer. Acceptance is not proof of inbox delivery. Rejected/uncertain outcomes require review and are not automatically resent. A server restart can repair CRM linkage from this ledger without sending again.

The check-in is due at the persisted expiry, subject to normal conversation, opt-out, cooldown, human-takeover and session-window rules. Verified purchase/access is rechecked before generation, reservation, sending, and at the central provider boundary. A purchase cancels sales follow-ups for the exact AylaMed account/exam. Generic day-based renewal/expiry/reactivation emails do not also run for this private trial source.

Late authorization failures get a durable cooldown and retry budget; provider uncertainty stays in review. Outside the WhatsApp reply window, an AylaMed-specific approved template is required. The old NextGen template is never substituted.

## Work still required before activation

1. Verify the signed-in administrator CRM, the actual Canadian WhatsApp asset ownership, isolated provider readiness and AylaMed display-name status. Historical unverified asset IDs must not be used.
2. Verify the Meta app secret and signed webhook intake on the actual Canadian receiving asset. The local qualification-to-invitation action and verified prospect-context contract are connected and covered by a signed-webhook/local-SMTP test; they are not deployed or enabled. Completely unverified automatic sends still fail closed. Broad automatic conversations must remain disabled until controlled recipient tests, provider readiness and the public name are verified.
3. Exercise a controlled recipient end-to-end: received email, correct MCCQE starting choices, exact access expiry, one WhatsApp check-in, and purchase suppression. Do not use real prospects for smoke tests.
4. Create/review the campaign in the AylaMed account, not the old NextGen draft, and obtain an explicit budget/duration before publication.

## Verification checkpoint

On 4 September 2026, 188 targeted regression tests passed in one combined run, with no skipped tests. Coverage includes isolated HTTP + local SMTP, concurrent/replayed invitations, existing passwords, paid access, restart recovery, uncertain delivery, forged sender capabilities, purchase races, exam domains, brand routing, existing NextGen conversations and experience follow-ups. Added coverage confirms independently verified payment survives unknown/legacy/malformed demo records, unknown is distinct from not-issued, payment during generation forces repair, and a final central sender guard blocks stale sales/demo claims. Server syntax and whitespace checks also passed. No production recipients were contacted by these tests.

The subsequent signed-intake checkpoint passed **156 targeted tests** in one combined run, with no skips, including the previous safety fixes and new qualification, ownership, concurrency and recipient-binding cases. Its HTTP test first posts signed WhatsApp webhooks and waits for journal processing, then explicitly invokes the existing authenticated `/admin/crm/conversations/:leadId/ai-auto-send` controller. That controller reaches the existing invitation ledger and a local-only SMTP test server. Repeating the action produces no second email. The broad WhatsApp automatic-send flag remains OFF, so this test **does not establish unattended trigger scheduling, an actual WhatsApp reply, real inbox receipt or live end-to-end automation**. Those remain controlled-recipient activation checks.

New health markers (only after a future deployment): `crm_mccqe_demo_build: "v1-private-five-hour-lifecycle"` and boolean `crm_mccqe_demo_enabled`. The marker does not establish that the automatic inbound action path is complete.

The local intake adds `crm_mccqe_whatsapp_intake_build: "v1-signed-prospect-private-demo"`, boolean `crm_mccqe_whatsapp_intake_enabled` and boolean `crm_mccqe_inbound_signature_configured`. These non-secret markers do not establish live sender permission, display-name approval, inbox delivery or campaign readiness.
