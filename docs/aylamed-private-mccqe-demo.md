# Private MCCQE CRM demo pilot

Status: local implementation, not deployed or enabled. This extends the existing administrator invitation and experience-follow-up paths; it is not a replacement CRM or an automatic sales dispatcher.

## Feature boundary

- `AYLAMED_MCCQE_DEMO_FLOW_ENABLED=true` is required for this pilot; absent/false means disabled.
- General `AYLAMED_AI_AUTO_SEND_ENABLED` remains disabled. A single-use, process-local capability permits only a reserved and freshly verified private-demo check-in through the existing central sender.
- Existing administrator authentication protects `POST /admin/mobile/invitations`.
- Explicit invitation fields: `product: "aylamed"`, `crm_demo: true`, `crm_lead_id`, `brand_id: "brand_aylamed"`, confirmed matching `email`, `exam_track_id: "mccqe"`, and a stable `idempotency_key` of 8–160 characters.
- The lead must have a student conversation and must not be stopped, filtered, paid or awaiting brand review. The assigned exam and email must match; country and phone digits are not sufficient identity.
- The server fixes access to exactly five hours from persisted issuance. Replays do not restart the clock, reset an existing password, or send another email.
- New accounts use the existing credential invitation helper. Existing accounts retain their current password and authentication version. No credentials are returned by this mode.
- The private enrollment uses `source: "crm_mccqe_demo"`, the MCCQE website and the existing starting-choice setup. It does not create a public signup/demo offer.

## Delivery and purchase safeguards

The durable AylaMed issuance ledger reserves email delivery before the external provider call. Only provider acceptance creates the CRM resource and expiry timer. Acceptance is not proof of inbox delivery. Rejected/uncertain outcomes require review and are not automatically resent. A server restart can repair CRM linkage from this ledger without sending again.

The check-in is due at the persisted expiry, subject to normal conversation, opt-out, cooldown, human-takeover and session-window rules. Verified purchase/access is rechecked before generation, reservation, sending, and at the central provider boundary. A purchase cancels sales follow-ups for the exact AylaMed account/exam. Generic day-based renewal/expiry/reactivation emails do not also run for this private trial source.

Late authorization failures get a durable cooldown and retry budget; provider uncertainty stays in review. Outside the WhatsApp reply window, an AylaMed-specific approved template is required. The old NextGen template is never substituted.

## Work still required before activation

1. Verify the signed-in administrator CRM, the actual Canadian WhatsApp asset ownership, isolated provider readiness and AylaMed display-name status. Historical unverified asset IDs must not be used.
2. Connect server orchestration to the new brand-specific protected operational context and the deliberate inbound qualification-to-invitation action. The prompt module is prepared, but this automatic action path is not wired. The current pilot is administrator-triggered only.
3. Exercise a controlled recipient end-to-end: received email, correct MCCQE starting choices, exact access expiry, one WhatsApp check-in, and purchase suppression. Do not use real prospects for smoke tests.
4. Create/review the campaign in the AylaMed account, not the old NextGen draft, and obtain an explicit budget/duration before publication.

## Verification checkpoint

On 4 September 2026, 174 targeted regression tests passed in one combined run, with no skipped tests. Coverage includes isolated HTTP + local SMTP, concurrent/replayed invitations, existing passwords, paid access, restart recovery, uncertain delivery, forged sender capabilities, purchase races, exam domains, brand routing, existing NextGen conversations and experience follow-ups. Server syntax and whitespace checks also passed. No production recipients were contacted by these tests.

New health markers (only after a future deployment): `crm_mccqe_demo_build: "v1-private-five-hour-lifecycle"` and boolean `crm_mccqe_demo_enabled`. The marker does not establish that the automatic inbound action path is complete.
