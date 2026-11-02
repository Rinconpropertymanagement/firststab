# Brief for Firstab: HubSpot "Lead Source" property

Scope: exactly what's below. Do not create, edit, or delete any other HubSpot property, pipeline, stage, workflow, or record. Dry run before every write.

## 1. Create one deal property

* Object: Deals. Internal name `lead_source`, label "Lead Source", single-select dropdown, group "Deal information".
* Options in this order: Inbound web · Google Ads · Meta Ads · Yelp · APM · Geek Leads · Referral partner · Existing client · Cold outreach · Sign call · Phone (unknown source) · Other
* Description: "Marketing channel that produced this deal. Set on create. Required for monthly pipeline report."
* First confirm no `lead_source` property already exists on Deals or Contacts. If one does, stop and report.

## 2. Add `lead_source` to the hub's HubSpot deal sync mapping so it lands in Supabase. Same commit.

## 3. Backfill — dry run first.

Print every proposed change (deal id, name, current value, proposed value). Write only after Peter approves the list. Never overwrite a non-empty value. Rules in order:

* a. Yelp (known): deal 326812009180 "1220 Nautical Way" → Yelp; deal 247930462968 "325 Harbor Breeze" → Yelp.
* b. Any deal where `geek_lead` is true → Geek Leads.
* c. APM: first list distinct `hs_object_source_label` / `hs_object_source_detail_1` values with counts for deals created since 2025-01-01 and report them. Peter confirms which value is All Property Management before anything is tagged. (Aircall's detail is "Aircall : AI-powered calling and SMS"; do not tag those.)
* d. Associated contact `hs_analytics_source` in ORGANIC_SEARCH / DIRECT_TRAFFIC / REFERRALS and `hs_object_source_label` = FORM → Inbound web.
* e. Contact `hs_analytics_source` PAID_SEARCH → Google Ads; PAID_SOCIAL → Meta Ads; OTHER_CAMPAIGNS with drill-down containing "yelp" → Yelp.
* f. Everything else: leave blank. Do not guess.

## 4. Ongoing (optional, after 1–3 approved)

When a new deal arrives in the hub with empty `lead_source`, apply rules b–e and write back to HubSpot. Log every write.

## Out of scope (Peter/Dio in HubSpot UI)

Making the field required on deal create; adding it to the monthly pipeline report; retiring the `geek_lead` flag later.

## Reference

Portal 9021603, main sales pipeline. Lost stage id 5144166; stage 13517903 appears to be won/signed — verify before relying on it. Yelp contacts with no deal yet: Stephen Lee (474286782180), Brian R. (577753349838 — when Dio creates his deal, Lead Source = Yelp).

---

## Build log

**2026-11-02 — Thin version adopted.** Peter adopted the trimmed brief from his Claude chat: one dropdown on deals, Dio fills it on create, backfill only the two Yelp deals plus clean contact import-type mappings, no traffic-source inference, no hub automation, no Supabase sync (the hub stores no deals — the scorecard reads them live). Peter also asked to split "Website (organic)" into three.

**2026-11-02 — Step 1 done.** Deal property `lead_source` ("Lead Source") created via the HubSpot connector, group Deal information, 13 options in this order: APM · Geek Leads · Yelp · Google Ads · Meta Ads · Website form · Rental analysis · Live chat / meeting link · Phone · Referral partner · Existing client · Networking/Events · Other. Settings: https://app-na2.hubspot.com/property-settings/9021603/properties?type=0-3&action=edit&property=lead_source

Pre-checks before creating: no `lead_source` existed on deals or contacts; `geek_lead` on deals is free text with zero values (the real Yes/No flag is on contacts); every deal since 2025 but one was created by hand (CRM_UI), so deal record source cannot identify APM; stage 13517903 confirmed as the won stage.

**Approved mapping for the backfill (contact import type → deal Lead Source):**

| Contact import type | Lead Source |
|---|---|
| APM Lead | APM |
| Geek Lead | Geek Leads |
| Yelp | Yelp |
| PPC Campaign | Google Ads |
| Contact Form | Website form |
| Rental Analysis | Rental analysis |
| Live Chat, Meeting Link | Live chat / meeting link |
| Direct Phone Call, PMW - Inbound Call | Phone |
| Owner Referral, Realtor Referral, Other Referral | Referral partner |
| Sales Networking, Events | Networking/Events |
| Purchased Lists, cold email reply, high intent competitor, high intent website visitor, N/A, blank | leave blank |

Plus the two known Yelp deals (326812009180, 247930462968). Never overwrite a non-empty value. Dry run → Peter approves list → write in batches of 10 → log every write.

**Still on Peter/Dio in the HubSpot screen:** make the field required on deal create; build the monthly report (deals created / won / doors by Lead Source).

**2026-11-02 — Required on create done.** Peter ticked "Required" on the deal-create form in HubSpot's UI (asterisk confirmed showing). The connector cannot set this.

**2026-11-02 — Dry run reviewed.** `projects/hubspot/lead-source/dry-run.js` (read-only) reviewed 345 deals: 333 proposed writes, 12 skips (3 two-contact conflicts, 9 unmapped import types). Peter's decisions: approve all 333; 325 Harbor Breeze → Yelp (its contact was tagged differently); the 3 conflicts stay blank; any deal with "Geek" in the title → Geek Leads (added 170 N H St, which the dry run had skipped). Files: `dry-run-2026-11-02.csv`, `dry-run-2026-11-02-review.csv`.

**2026-11-02 — Backfill WRITTEN and verified.** The hub's private-app token lacks the deals-write permission (`crm.objects.deals.write`), so `apply.js` could not write (403, nothing changed). The 335 approved values were written through the HubSpot connector instead, 34 calls of ≤10 deals each, 21:11–21:14 UTC, 0 failures. Read-back via `node projects/hubspot/lead-source/apply.js --dry` shows all 335 already hold the approved value. Log: `projects/hubspot/lead-source/write-log-2026-11-02.csv`. Final counts: Phone 85 · Website form 67 · Networking/Events 62 · APM 41 · Geek Leads 30 · Rental analysis 21 · Referral partner 20 · Live chat / meeting link 4 · Yelp 3 · Google Ads 2. The 3 conflict deals (2462 Aztec Ave, 2408 Ocean Dr, 2154 El Rancho Dr) remain blank by Peter's call.

**Still on Peter/Dio:** tell Dio the field is now required on every new deal; build the monthly report in HubSpot (deals created / won / doors by Lead Source). If the optional ongoing hub automation (step 4) is ever wanted, the hub token needs the deals-write scope added first.
