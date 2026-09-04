# AylaMed Meta and CRM production wiring

This release separates AylaMed/MCCQE records from existing NextGen/USMLE records. It does not contain access tokens and does not create Meta assets. Complete the provider-side assignments below before deployment.

## Confirmed assets

| Asset | ID / value | CRM owner |
| --- | --- | --- |
| AylaMed Meta ad account | `1594776822351544` | `brand_aylamed` |
| Existing NextGen Meta ad account | `1575781874561019` | `brand_nextgen_usmle` |
| AylaMed business portfolio | `1687983715599420` | Provider permission container only |
| AylaMed Facebook Page | `1330926136765528` | `brand_aylamed` |
| Shared Canadian WhatsApp test number | `+1 825-425-5646` | Shared NextGen + AylaMed test integration |

`+1 647-345-0891` is a legacy number in old content. Do not select it for this MCCQE test unless Meta Business Manager proves that it is the actual connected Cloud API asset.

## Required production environment

Use either the two named account variables:

```text
NEXTGEN_META_AD_ACCOUNT_ID=1575781874561019
AYLAMED_META_AD_ACCOUNT_ID=1594776822351544
META_ADS_ACCESS_TOKEN=<secret token with ads_read access to both accounts>
```

or the generic plural form:

```text
META_AD_ACCOUNT_IDS=1575781874561019,1594776822351544
META_AD_ACCOUNT_BRAND_MAP={"1575781874561019":"brand_nextgen_usmle","1594776822351544":"brand_aylamed"}
META_ADS_ACCESS_TOKEN=<secret token with ads_read access to both accounts>
```

The sync now fails closed if a configured account is missing from the token or has no brand mapping. Do not set only `META_AD_ACCOUNT_ID=1594776822351544` on an older build: that older build labels every fetched record as NextGen.

The portfolio ID `1687983715599420` is not an application environment variable. In Meta Business Settings, grant the system user/token access to ad account `1594776822351544`, Page `1330926136765528`, the WhatsApp account and the phone-number asset.

Keep the existing `META_PAGE_ACCESS_TOKEN` and `FACEBOOK_PAGE_ID` values as legacy NextGen defaults; do not repoint those global values at the AylaMed Page. AylaMed Page credentials belong in the brand-scoped CRM integration record below. AylaMed routes fail closed when that record is absent or incomplete.

The shared WhatsApp test number may continue using the existing global fallback only after Meta Business Manager confirms that these values belong to `+1 825-425-5646`. The brand-scoped shared integration record remains the preferred source:

```text
WHATSAPP_ACCESS_TOKEN=<secret Cloud API token for the shared test number>
WHATSAPP_PHONE_NUMBER_ID=<numeric Meta phone-number asset ID; not +18254255646>
WHATSAPP_BUSINESS_ACCOUNT_ID=<numeric WABA ID>
WHATSAPP_BUSINESS_NUMBER=+18254255646
```

## Required CRM integration records

Create these through the admin integration API/UI so credentials remain in the existing protected integration store. Values shown as placeholders must never be committed.

Facebook Page:

```json
{
  "brand_id": "brand_aylamed",
  "platform": "facebook",
  "account_name": "AylaMed",
  "account_id": "1330926136765528",
  "access_token": "<AylaMed Page access token>",
  "status": "connected"
}
```

Shared Canadian WhatsApp test number:

```json
{
  "brand_id": "brand_nextgen_usmle",
  "platform": "whatsapp",
  "account_name": "AylaMed / NextGen shared Canadian test",
  "account_id": "<same value as phone_number_id>",
  "phone_number_id": "<numeric Meta phone-number asset ID>",
  "whatsapp_business_account_id": "<numeric WABA ID>",
  "shared_number_test": true,
  "shared_brand_ids": ["brand_nextgen_usmle", "brand_aylamed"],
  "default_inbound_brand_id": "brand_nextgen_usmle",
  "access_token": "<Cloud API token>",
  "status": "connected"
}
```

The shared-number default preserves existing NextGen handling for a generic direct message. An MCCQE/AylaMed Click-to-WhatsApp referral or an AylaMed ad creative overrides that default and creates/updates an AylaMed lead in `exam:mccqe`. Phone or email identity matching is brand-scoped, so the same person can have separate NextGen and AylaMed records without one overwriting the other.

When a separate AylaMed number is purchased, create a second WhatsApp integration owned by `brand_aylamed` with its own `phone_number_id` and WABA/token. Remove AylaMed from the old record's `shared_brand_ids`; no code change is needed.

## WhatsApp profile and automatic replies

The business profile endpoint can publish the logo, about, description, email, website, address and category. The display name is the verified identity returned by Meta and must be requested/approved separately in WhatsApp Manager.

For the test profile, use:

- Display-name request: `AylaMed`
- Category: `Education`
- Email: `support@aylamedapp.com`
- Website: `https://mccqe.aylamedapp.com`
- Remove the old NextGen website/address from the submitted profile

A WhatsApp profile belongs to the phone number, not to an individual CRM brand. Publishing AylaMed details to the shared Canadian number immediately changes the public profile seen by existing NextGen chats on that number.

Automatic AylaMed replies are fail-closed by default because the current conversation engine still contains NextGen/USMLE copy and `nextgenusmle.live` links. Keep AylaMed messages in manual review until a brand-specific prompt, templates, links and product facts are installed. Only then set:

```text
AYLAMED_AI_AUTO_SEND_ENABLED=true
```

## Still unresolved outside this repository

Before production activation, verify in Meta Business Manager:

1. The numeric `WHATSAPP_PHONE_NUMBER_ID` attached to `+1 825-425-5646`.
2. The WABA ID that owns that phone-number asset.
3. That the chosen Cloud API token can send from that exact phone-number ID.
4. That the ads token can read both ad accounts, especially `1594776822351544`.
5. That the Page token belongs to Page `1330926136765528`.
6. The approval status of the requested `AylaMed` WhatsApp display name.

These values cannot be derived safely from the repository. A telephone number is not interchangeable with Meta's phone-number asset ID.
