# Missive Connection Plan — How the Shared-Inbox Pull Actually Talks to Missive

**Status:** Research/spec only. Nothing gets built from this document. This resolves `projects/hub/email-intake/SPEC.md`'s own Open Item #1 ("Missive connection mechanism — deferred entirely... needs its own Sentinel/Scotty pass") at the research level, and is itself gated behind that Sentinel/Scotty pass, and behind whatever future review gates `owner-tenant-operational-notes-SPEC.md` Section 8's AI-extraction feature. No credential exists yet. No code in this repo calls Missive.
**Written by:** Oracle
**Date:** 2026-09-05
**Origin:** `owner-tenant-operational-notes-SPEC.md` Section 8 names the exact technical gap this closes: the note-extraction feature's required architecture (per `compliance/owner-tenant-notes-outside-counsel-opinion.md` Section 5) depends on Rincon actually having its own stored copy of shared-inbox correspondence before any AI processor touches it, and nobody had yet checked what Missive's real API actually allows. This document is that check.

**Built from, read in full:**
- `compliance/owner-tenant-notes-outside-counsel-opinion.md` Section 5 — the controlling architecture requirement: *"Tenant sends communication → Rincon receives it → it resides in Rincon's system → Rincon subsequently causes a contracted processor to analyze Rincon's stored copy."* Every design choice below is measured against this sequence, specifically against never letting anything skip step 3.
- `owner-tenant-operational-notes-SPEC.md` Section 8 — confirms this exact gap by name and states the one guardrail to hold any real connection to: *"a scheduled pull against the mailbox's own stored copy, never a live SMTP-relay/BCC-forward/webhook-fires-before-storage design."*
- `projects/hub/email-intake/SPEC.md`, full document — the already-drafted (not built) pipeline this plan feeds. Its "Ingestion Approach" section sketches the shape (`internalRouter`, `CRON_SECRET`, "lists new/updated threads") without resolving the actual Missive mechanics — that gap is Open Item #1 there, and is what this document exists to close.
- `projects/hub/email-intake/lib/index.js`, `privilege-filter.js`, `fair-housing-filter.js` — read in full. These define the exact input shape this plan's output must match: `processThread({ threadId, legalHoldTag, messages: [{ messageId, from, to, cc, bcc, subject, body, date }] })`. `body` is scanned as plain text (keyword regex against `subject + "\n" + body`) — this matters directly below, because Missive's API does not return plain text.
- `projects/hub/maintenance-history/lib/latchel-connector.js` — the real precedent for a single-purpose external connector module: one file, GET-only where the credential allows more, its own pagination-following helper, explicit handling of the provider's actual (not assumed) rate-limit and pagination quirks.
- `projects/hub/maintenance-history/router.js` (`internalRouter`, `checkCronSecret`, `maintenanceHistoryIngestRunning`) — the real, live precedent for how a scheduled pull is actually wired into this Hub: a shared-secret-protected route, no login, triggered by an OS-level cron job on the Hub's own server ("Sally"), with an in-process overlap guard because the Hub runs as a single pm2 fork instance.
- `projects/hub/deploy-to-sally.sh` — confirms the real deployment shape: the Hub runs under pm2 on a server called Sally; scheduled jobs are wired via hand-written `cron-*.sh` wrapper scripts that live on Sally itself (not checked into this repo — `maintenance-history-ingest` is the named precedent), which `curl` an `internal/` endpoint on a timer.
- `.env.example` — the real credential-documentation convention every external connector in this codebase follows (what the key can do, what plan/tier it requires, who has to obtain it and how, and any "this is not self-serve" flag). This plan's credential section follows that same format.
- `projects/hub/property-360/owner-tenant-operational-notes-SPEC.md` Section 3, 4 — for the `team_member_tool_roles` and RLS conventions any new table in this area should match, referenced for consistency, not re-decided here.
- `CLAUDE.md` — confirms Missive is Rincon's shared pod-inbox tool, explicitly separate from individual Gmail accounts.
- Missive's own current, live developer documentation (fetched directly today, 2026-09-05 — see Sources at the end). **Not** fetched from training-data memory; every specific claim below is sourced to a specific page fetched today, and every place I could not get a docs page to answer a question is marked as such rather than guessed.

---

## What This Document Is (and Is Not)

**Is:** A concrete answer to "how would Rincon's Hub technically pull shared-inbox content out of Missive and into Rincon's own storage, on a schedule, before anything else touches it" — grounded in Missive's actual, current public API documentation, with every unverifiable claim marked as such.

**Is not:**
- Not a decision to build anything. No code, no credential, no migration ships from this document.
- Not a design of the AI note-extraction step itself (`owner-tenant-operational-notes-SPEC.md` Section 8, gated behind its own future review). This plan stops at "the content is now sitting in Rincon's own database, in the shape the existing filter expects." What happens after that — the filter's existing Stage 1 output, and any future AI extraction reading the stored copy — is out of scope here by the task's own instruction.
- Not a Sentinel security review or a Scotty infrastructure build-out. This is the research that a Sentinel/Scotty pass would start from, per `email-intake/SPEC.md`'s own stated need — it is not that pass.
- Not confirmation that this is legally clear to activate. Counsel's Section 5 opinion requires a specific technical architecture (below); it does not pre-clear a specific vendor contract with Anthropic, a specific Missive plan, or a specific credential-handling practice — those remain open items for Peter, same as `owner-tenant-operational-notes-SPEC.md` Section 8 already flagged.

---

## Plain-English Summary

Missive has a real, working way for Rincon's own systems to log in and ask "what's new in this shared inbox" on a timer — the same basic pattern the Hub already uses to pull data from Latchel, AppFolio, and LeadSimple every 15–30 minutes. That satisfies the lawyer's core requirement: Rincon reads its own already-received mail off Missive's servers on Rincon's own schedule, copies it into Rincon's own database, and only after that could any AI ever look at it. Nothing about this is a live wiretap or an automatic forward — it is Rincon's own scheduled homework-check against a mailbox Rincon already owns.

Two real wrinkles, not fatal, but worth knowing before this is built: (1) Missive's login tokens belong to a specific person's account, not to "Rincon" as a company — so whoever's login is used determines exactly which shared inboxes are visible, and using someone's everyday personal login would let this tool see far more than the pod inboxes it needs; the fix is a dedicated, narrowly-added user just for this integration. (2) Missive doesn't hand over a message's actual text in the same call that lists what's new — getting the readable content takes one extra request per message, and that content comes back as web-page-style formatting (HTML) that has to be cleaned up before Rincon's existing content filter can read it as plain text. Neither of these blocks the plan; they just make the job slightly more involved than "one simple weekly check-in," and I've designed around both below.

---

## 1. Missive's Real API — What I Verified

Everything in this section is sourced to a specific Missive documentation page fetched live today (2026-09-05); URLs are listed under Sources. Where documentation was ambiguous or unavailable, that is stated explicitly rather than filled in with a guess.

### 1.1 Authentication

- **Method:** Bearer token in the `Authorization` header (`Authorization: Bearer missive_pat-...`). **No OAuth flow** is documented for the REST API.
- **Plan requirement:** API token generation requires an organization on Missive's **Productive plan** ($24/user/month per Missive's public pricing) or higher. The **Starter plan** ($14/user/month) explicitly does **not** include API access.
- **Token creation:** Self-serve, inside Missive itself — Preferences → API tab → "Create a new token." Not a support-ticket process, unlike several of Rincon's other integrations (Latchel's webhook secret, LeadSimple's key).
- **Critical scoping fact, verified directly:** a Missive API token is **personal, not organization-scoped**. It is created under one specific Missive user account and inherits exactly what that person can see in Missive — "all accounts that user can access in Missive, including shared accounts." There is no separate "service account" or "integration" credential type documented. This has real consequences — see Section 3.4.

### 1.2 Rate Limits

Confirmed exact and current:
- **5 concurrent requests** at any time
- **300 requests/minute** (≈5/sec)
- **900 requests per 15 minutes** (≈1/sec sustained)
- Over limit → `429 Too Many Requests`, with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` headers.

For a handful of low-volume pod inboxes polled every 15–30 minutes, this is not a binding constraint — flagged only because `latchel-connector.js` shows this codebase's convention of respecting rate-limit headers explicitly rather than assuming generous limits, and the same discipline should carry over here.

### 1.3 Listing Conversations — `GET /v1/conversations`

- Requires **at least one mailbox filter** — documented error if none is passed: `"You need to paginate at least one mailbox"`.
- Relevant filters: `inbox`, `all`, `assigned`, `closed`, `snoozed`, `flagged`, `trashed`, `junked`, `drafts` (boolean, personal-mailbox scoped to the token's own view); `shared_label` (a shared label ID); **`team_inbox` / `team_closed` / `team_all` (a team ID — this is Missive's mechanism for a shared/pooled inbox multiple people read and act on together, its "Team Inbox" concept)**; `organization` (scopes to one Missive organization, but is documented as having "no use" when combined with `shared_label` or any `team_` filter).
- `limit`: default 25, **max 50**.
- **Sort order: newest-to-oldest by `last_activity_at`, always.** There is no ascending option and no `since`/`start` parameter. Pagination is exclusively backward: pass `until` = the `last_activity_at` of the oldest conversation in the page you already have, to get the next (older) page.
- Response includes, per conversation: `id`, `created_at`, `subject`/`latest_message_subject`, `organization`, `team`, `assignees`/`users`, `shared_labels`, `messages_count`/`attachments_count`, `last_activity_at`, `web_url`/`app_url`. **No message body at this level.**

### 1.4 Listing a Conversation's Messages — `GET /v1/conversations/:id/messages`

- `limit`: default 10, **hard max 10** (much smaller than the conversations list's max of 50).
- Same pagination shape: newest-to-oldest by `delivered_at`, `until` param to page backward.
- Returns `id`, `type`, `subject`, `preview` (a short excerpt), `from_field`/`to_fields`/`cc_fields`/`bcc_fields`/`reply_to_fields` (each `{name, address}`), `attachments` (metadata + a `url`, not content), `email_message_id`, `references`/`in_reply_to`.
- **Does not include the full message body.** Documentation states this explicitly: `body` is only returned by the single-message endpoint.

### 1.5 Getting Full Message Content — `GET /v1/messages/:id`

- Returns everything the list endpoint does, **plus `body` — described as the HTML body of the message.**
- **No plain-text body field is documented anywhere.** Only HTML.
- **One real ambiguity I could not resolve from documentation:** the docs reference a shape shared by "List conversation messages, List conversation drafts, **List messages**, and Get a Message," implying a top-level `GET /v1/messages` list endpoint exists — but no standalone path, parameters, or filter behavior for it are documented anywhere I could fetch. I am not assuming it exists as a usable "list all new messages across mailboxes" shortcut. Treat it as unconfirmed until checked against a real trial token (see Section 5).

### 1.6 Webhooks (exist, but see Section 3.3 for why this plan does not use them)

- Created via the Missive UI (**Settings → Rules → new rule → Webhook action**), not via a documented API call to provision one programmatically.
- Event types include `incoming_email` and others; payload includes conversation metadata and a `latest_message` object (subject, preview, participants) — documentation does not confirm the full HTML body is included in the webhook payload itself (only a preview is explicitly named).
- Signed via `X-Hook-Signature` (HMAC-SHA256, `sha256=<hexdigest>`) against a shared secret set on the rule.
- Retries up to 5 times over 8 minutes on failure/timeout; **a rule is auto-disabled after 50 consecutive failures** — meaning a webhook integration silently going dark is a real, documented failure mode requiring its own monitoring.
- Requires the receiving endpoint to respond within 15 seconds — any real processing has to be deferred to a background step, not done inline in the webhook handler.

### 1.7 Team Inboxes vs. Shared Regular Inboxes — the underlying Missive concept

Missive has two distinct ways to share a mailbox, confirmed from Missive's own product documentation:
- **Team Inbox:** incoming messages land in a shared queue; any team member's action (assign/archive/close) removes it from the queue for everyone — a triage model. Reached via the API's `team_inbox`/`team_closed`/`team_all` params against a **team ID**.
- **Shared regular Inbox:** incoming messages land in each member's own personal Inbox — reached via the plain `inbox`/`all` params, scoped to whichever user's token is calling.

**Which model Rincon's pod inboxes actually use is not something I can determine from outside Missive — this is a real open item** (Section 4). It changes which query parameter the pull job uses and what ID it needs (a team ID vs. nothing beyond the token owner's own membership).

---

## 2. The Pull Mechanism — Concrete Design

This section is the direct answer to "what does the actual pull job look like."

### 2.1 Why a scheduled pull, and explicitly not a webhook

Counsel's Section 5 architecture requires storage to happen before any processor analyzes content; it does not, on its own words, forbid an event-driven trigger as long as the sequence (receive → store → then analyze) holds. So a Missive webhook *could* theoretically be argued compliant if the handler did nothing but write to Rincon's own table. I am recommending against it anyway, for reasons specific to this codebase and this vendor, not just "polling is safer in the abstract":

1. **`owner-tenant-operational-notes-SPEC.md` Section 8 already commits, in writing, to "a scheduled pull... never a live SMTP-relay/BCC-forward/webhook-fires-before-storage design"** as the one concrete guardrail for whoever builds this connection. A webhook-triggered design would need its own fresh argument for why it doesn't violate that guardrail's spirit, even if it could be made to satisfy the letter — not a foundation to build the first version on.
2. **A webhook is a new inbound attack surface this Hub does not otherwise have.** Every other external integration in this codebase (Latchel, AppFolio, LeadSimple, Aircall, B2) is outbound-only: the Hub calls out, on its own schedule, with its own credential. `approval-briefing` is the one exception, and it already needed its own dedicated webhook-secret-in-two-places verification scheme (`LATCHEL_WEBHOOK_SECRET`) precisely because Latchel's webhooks have no IP allowlist — the same class of problem would recur here (Missive's `X-Hook-Signature` is the mitigation, but it's still a new public, unauthenticated-until-verified endpoint Sentinel has to review, where a poll-based design needs no new public endpoint at all).
3. **A poll reuses proven, already-understood infrastructure exactly** — `internalRouter` + `CRON_SECRET` + a Sally crontab entry is a pattern this codebase has now shipped four times (`insuranceInternalRouter`, `securityDepositInternalRouter`, `maintenanceHistoryInternalRouter`, LeadSimple's phase-2 connector). A fifth instance is a known quantity for Scotty and Sentinel; a webhook receiver is not.
4. **Missive's own documented webhook reliability model (auto-disable after 50 consecutive failures) is a real, silent-failure risk** for a compliance-sensitive pipeline — a poll job that fails loudly (a cron log, a missed run) is easier to build monitoring around than a webhook rule that goes quiet inside Missive's own settings until someone happens to check.

**Recommendation: scheduled pull only, no webhook, at least for v1.** If shadow-mode experience later shows polling latency is a real operational problem (e.g., staff need same-minute visibility), that is a deliberate, later decision with its own review — not a default.

### 2.2 The cron schedule and endpoint

Mirrors `maintenance-history`'s own real, live precedent exactly:

- New route: `internalRouter.post('/api/email-intake/internal/sync-missive')` inside `projects/hub/email-intake/router.js` (not yet built), guarded by `checkCronSecret()` (the same `x-cron-secret` header pattern, same `CRON_SECRET` env var — no new secret needed for this check).
- Triggered by a new hand-written wrapper script on Sally, `cron-missive-sync.sh` (same category as the existing `maintenance-history-ingest`, `send-reminders`, etc. — written directly on the server, not checked into this repo, per `deploy-to-sally.sh`'s own documented convention and its explicit warning not to let a deploy delete these).
- **Suggested cadence: every 15 minutes**, matching `maintenance-history`'s current (as of this codebase) ingest cadence. Rincon's shared pod inboxes are almost certainly far lower volume than Latchel's job stream, so this is conservative, not aggressive — actual cadence is Scotty's call, informed by real message volume Peter can pull from Missive's own UI before this is sized for real.
- **In-process overlap guard**, identical reasoning to `maintenanceHistoryIngestRunning`: since the Hub runs as a single pm2 fork instance, a module-level boolean flag (`missiveSyncRunning`) set at the start of the route and cleared in a `finally` block is sufficient — no distributed lock needed.

### 2.3 What one run of the job actually does

For each configured shared pod inbox (see Section 4 for how many, and how they're identified):

1. **List conversations for this mailbox**, `GET /v1/conversations?team_inbox=<id>&limit=50` (or `inbox=true` if the mailbox turns out not to be a Team Inbox — see Section 3.2), newest-first.
2. **Compare against the stored watermark** for this mailbox (Section 2.4): walk the returned page in order; for each conversation, if its `id` + `last_activity_at` combination is already recorded as fully synced, stop paging for this mailbox this run (everything remaining is older and already known). If not yet seen, or `last_activity_at` is newer than what's on record for a conversation already partially known (i.e., new messages landed in an existing thread), queue it for message-level sync.
3. **If the first page (50 conversations) is entirely new** (a cold start, or an unusually high-volume gap since the last run), page backward with `until` until reaching the previous watermark or a sane backstop (e.g., 500 conversations), rather than looping forever — same bounded-pagination discipline as `latchel-connector.js`'s `getAllPages({ maxPages })`.
4. **For each conversation needing a sync**, `GET /v1/conversations/:id/messages?limit=10` (paging backward with `until` on `delivered_at` if the thread has more than 10 messages), to get the list of message IDs/metadata. Compare each message ID against what's already stored for this conversation; only genuinely new messages proceed to step 5.
5. **For each new message, `GET /v1/messages/:id`** to fetch the full HTML `body`.
6. **Write Rincon's own copy immediately, before anything else touches the content** — one row per message into a new raw-intake table (Section 2.5), storing the HTML body as fetched, untouched. **This write is the step that actually satisfies counsel's "Rincon receives, Rincon stores" requirement** — everything before this step is Missive's data; everything from this step onward is Rincon's own.
7. **Only after that row is committed**, convert the stored HTML to plain text (a new, small, deterministic parsing step — no AI, no external call — see Section 3.5) and assemble the thread into the exact shape `lib/index.js`'s `processThread()` expects (`{ threadId, legalHoldTag, messages: [{ messageId, from, to, cc, bcc, subject, body, date }] }`), then hand it to the existing, already-built, already-legally-cleared filter exactly as `email-intake/SPEC.md`'s Stage 0/1/2 pipeline already describes. This plan does not change or re-decide that pipeline — it just finally gives it real input.
8. **Update the watermark** for this mailbox/conversation (Section 2.4) only after the row(s) are successfully committed — so a crash mid-run re-processes the last batch rather than silently skipping it (an `INSERT ... ON CONFLICT DO NOTHING`/upsert on the raw table's unique key makes re-processing safe, not just tolerable).
9. **Log the run**: one `audit_log` row summarizing the run (`action: 'email_intake.missive_sync_run'`, `actor_type: 'system'`, `details: { mailboxes_checked, conversations_seen, messages_stored, errors }` — never message content), following the same Rule 1 discipline every other scheduled job in this codebase already uses.

### 2.4 Tracking "already processed" — the watermark

No Missive endpoint offers a clean "give me everything since timestamp X" filter (Section 1.3) — this is the real mechanical consequence of the API's backward-only pagination, and it's more involved than `email-intake/SPEC.md`'s original loose phrasing ("lists new/updated threads") assumed. The concrete fix is a small state table, not a single `.env` timestamp:

```
missive_sync_state
  id                         UUID PK
  mailbox_key                TEXT NOT NULL UNIQUE  -- e.g. 'team:<team_id>' or 'shared_inbox:<account_email>'
  last_synced_conversation_id       TEXT           -- newest conversation id fully processed
  last_synced_activity_at           TIMESTAMPTZ    -- its last_activity_at, the actual paging stop condition
  last_run_at                       TIMESTAMPTZ
  last_run_status                   TEXT           -- 'ok' | 'error' | 'partial'
  last_error                        TEXT
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Per-conversation "how far have we synced this thread's messages" is tracked implicitly by the raw intake table itself (Section 2.5) — the highest `delivered_at`/message id already stored for a given `thread_id` is the per-thread watermark, no separate column needed, same "don't build a second bookkeeping table when the data table already answers the question" discipline `maintenance_email_context` used for its own unique-`thread_id` upsert.

### 2.5 Where pulled messages land — a new raw-intake table, not a reuse of `maintenance_email_context`

**This needs to be a new table, upstream of `maintenance_email_context`, not a reuse of it.** `maintenance_email_context` (already designed in `email-intake/SPEC.md`) stores the *output* of Stage 0→1→2 — filter-cleared, matched-to-a-property, ready-for-staff-to-browse content. It deliberately never stores a HELD (Tier 2 privilege) thread at all, and never stores a NOT_RELEVANT thread. That is exactly correct for its purpose, but it means it **cannot** be the place counsel's "Rincon receives and stores" step happens — by the time a row would land there, filtering has already occurred, and a privileged thread would never be stored anywhere, which is fine for the *filtered view* but means `maintenance_email_context` cannot also serve as the raw system-of-record copy the legal architecture requires to exist first.

Sketch (Neo's call at actual build time — shown here only to make the design concrete, same convention every draft spec in this codebase already uses for not-yet-built tables):

```
missive_message_intake
  id                     UUID PK
  mailbox_key            TEXT NOT NULL            -- matches missive_sync_state.mailbox_key
  missive_conversation_id TEXT NOT NULL
  missive_message_id      TEXT NOT NULL
  email_message_id         TEXT                   -- the Message-ID header, when present
  subject                   TEXT
  from_address                TEXT
  to_addresses                 JSONB
  cc_addresses                  JSONB
  bcc_addresses                   JSONB
  delivered_at                     TIMESTAMPTZ
  body_html                         TEXT           -- verbatim, as Missive returned it — untouched
  body_text                          TEXT           -- derived (Section 3.5), never the only copy kept
  fetched_at                          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  pipeline_status                       TEXT NOT NULL DEFAULT 'pending'
                                         -- 'pending' | 'processed' — has Stage 0/1/2 run against this yet
  created_at                              TIMESTAMPTZ NOT NULL DEFAULT NOW()

  UNIQUE (missive_message_id)   -- idempotent re-fetch/upsert, same convention as maintenance_email_context's
                                  -- unique thread_id
```

This table **is** "Rincon's own system" holding "its own copy" in counsel's exact words — every message lands here, verbatim, the moment it's pulled, before the existing filter, before any future AI extraction, before anything decides whether it's relevant or privileged. `maintenance_email_context` continues to exist exactly as `email-intake/SPEC.md` already designed it, fed by this new table instead of by nothing.

**RLS, data-inventory, and retention for this new table are real, undone work** — flagged here, not resolved: this table is, if anything, *more* sensitive than `maintenance_email_context` (it contains privileged/held content that table explicitly refuses to store), so its default access should be **at least as narrow** (reviewer/admin only, arguably narrower — a case could be made that even the reviewer role that sees `maintenance_email_context`'s Fair-Housing-flagged rows shouldn't see this table's HELD/privileged rows, which is a genuinely new access question `email-intake/SPEC.md` never had to answer because HELD threads never reached its table at all). **This is exactly the kind of open question Sentinel and Mason need to resolve before this ships, not something this plan decides.**

---

## 3. Missive-Specific Constraints — Flagged as Real Problems, Not Glossed Over

### 3.1 No "since" filter — pagination is backward-only

Already covered mechanically in Section 2.4. The real-world consequence: the pull job is inherently a little more complex and a little more request-hungry than a clean "give me updates since X" call would be, and every page fetched (even ones containing nothing new) counts against the rate limit. Not a blocker at Rincon's likely volume, but it means `email-intake/SPEC.md`'s original one-line description of the ingestion approach undersold the actual mechanism needed.

### 3.2 Team Inbox vs. shared regular Inbox — genuinely unknown from outside Missive

Section 1.7. If Rincon's pod inboxes are Team Inboxes, the pull job needs each team's ID and uses `team_inbox`. If they're shared regular inboxes without a formal Team, the job instead needs the dedicated integration user (Section 4) to be a member of each shared account and uses the plain `inbox`/`all` filters scoped to that user's own view — which also means that user's Missive membership footprint *is* the access boundary, so it must be added to exactly the pod inboxes this feature needs and nothing else. **This determines which query parameter and which IDs the connector code needs — it must be confirmed against Rincon's real Missive configuration before Q writes a single line of connector code, not assumed either way.**

### 3.3 Webhooks exist and are lower-latency, but are deliberately not the default here

Covered in depth in Section 2.1. Restated briefly because it's the single most likely place a future engineer (or a future me, in a different session) might look at Missive's docs, see a real-time push option, and reach for it as "the modern choice" without re-deriving why this plan didn't. It is not a Missive limitation — Missive supports it fine — it is a deliberate fit choice against this codebase's existing architecture and counsel's specific guardrail language.

### 3.4 Personal, not organization-scoped, tokens — a real least-access problem if handled carelessly

Restated from Section 1.1 because it is a genuine Fair-Housing/data-minimization-adjacent concern, not just an API footnote: if this integration's token were generated under Peter's own everyday Missive login, the resulting credential would be able to read **every** mailbox, shared account, and conversation Peter personally has access to in Missive — almost certainly far broader than the specific pod inbox(es) this feature is scoped to, and quite possibly including HR-adjacent or personal correspondence Peter himself is copied on. That directly cuts against the same "least access necessary" discipline `email-intake/SPEC.md`'s own Stage 0 relevance filter and this codebase's RLS conventions already take seriously elsewhere. **Recommendation: a dedicated Missive user/seat, added only to the specific shared pod inbox(es) this feature reads, with the API token generated from that seat — never from an individual staff member's own login.** This is a real, additional Missive seat, which is a real recurring cost (Section 4), not a free configuration toggle — flagged plainly so it isn't discovered as a surprise later.

### 3.5 No plain-text body — a new, small parsing dependency

The existing filter's keyword-scanning code (`privilege-keywords.js`, `protected-class-terms.js` via `fair-housing-filter.js`) operates on plain text. Missive only returns HTML (Section 1.5). This means Q's build needs a small, new HTML-to-plain-text conversion step somewhere in the pipeline before content reaches `processThread()` — not a large addition (the `content-engine` project already depends on `cheerio` for a different purpose, so a similar small, well-established library is a reasonable, low-risk choice), but it is genuinely new code and a genuinely new dependency decision, not something that already exists in this Hub today. Worth a specific Sentinel look for one reason beyond the ordinary: a naive tag-stripper could be tricked by malformed or adversarial HTML into concatenating text in a way that defeats a keyword match (e.g., a keyword split across nested tags) — the same "defense in depth, don't trust one layer alone" reasoning `content-check.js`'s own header comment already documents should apply to this conversion step too.

### 3.6 What I could not verify, and am not guessing at

- Whether the `GET /v1/messages` (top-level, unscoped-to-a-conversation) endpoint referenced obliquely in the docs actually exists, and if so what it lists/filters on (Section 1.5). If it does exist and supports a useful filter, it could simplify Section 2.3's design — but I am not designing around it until confirmed against a real token.
- Whether a webhook payload's `latest_message` object includes the full HTML body or only the `preview` excerpt (Section 1.6) — moot for this plan's recommended poll-only design, but relevant if that recommendation is ever revisited.
- Rincon's actual current Missive plan tier, actual pod-inbox message volume, and whether pod inboxes are Team Inboxes or shared regular inboxes (Section 3.2) — none of these are things documentation can answer; they require looking at Rincon's real Missive account.

---

## 4. What Peter Needs to Obtain

1. **Confirm Rincon's current Missive plan.** API tokens require Productive ($24/user/month) or higher. If Rincon is currently on Starter, this is a plan-upgrade decision with a real recurring cost, to make before any build starts.
2. **A dedicated Missive user/seat for this integration** — not Peter's own login, not any individual staff member's (Section 3.4). This is an additional seat, at whatever the applicable per-seat rate is on Rincon's plan. Add this seat only to the specific shared pod inbox(es) this feature needs to read.
3. **Generate the API token from that dedicated seat** (Preferences → API tab → Create a new token, once that seat exists and is added to the right inbox(es)). This becomes a new `.env` value (suggested name: `MISSIVE_API_TOKEN`), documented in `.env.example` the same way every other credential in this codebase already is — including this same "who has to obtain it and how" narrative, and an explicit note (matching the Latchel-key precedent) that this token's real-world access is broader than "read-only for this tool" unless the dedicated-seat scoping above is actually followed, since Missive itself enforces no finer-grained read-only credential type.
4. **Confirm which Missive sharing model the pod inboxes use** (Section 3.2) — Team Inbox (get the team ID(s)) or shared regular Inbox (confirm the dedicated seat is added as a member). This is a five-minute look at Missive's own Team settings, not a technical unknown Peter needs help resolving — just needs to happen before Q builds the connector.
5. **A rough sense of real message volume** in the shared pod inbox(es) (even "a dozen or so a day" is enough) — used to sanity-check the suggested 15-minute cadence and confirm the rate limits in Section 1.2 are nowhere close to binding. Not a blocker, just cheap to confirm up front rather than assumed.

---

## 5. What This Plan Deliberately Does Not Do

Per the task's own scope: this plan stops at "Missive content is now sitting in Rincon's own database (`missive_message_intake`), in the shape the existing filter expects, on a schedule, with nothing having touched it in transit." It does not:
- Design or modify the relevance classifier, the privilege/Fair-Housing filter, or `maintenance_email_context` — all already specified in `email-intake/SPEC.md` and untouched here.
- Design the AI note-extraction step from `owner-tenant-operational-notes-SPEC.md` Section 8 — that remains its own future build, behind its own future review, reading from whatever this pipeline eventually stores.
- Resolve the AI-vendor contractual question (Anthropic terms) `owner-tenant-operational-notes-SPEC.md` Section 8 already flagged as Peter's to confirm directly — unrelated to Missive and not re-litigated here.
- Decide RLS policies, retention, or exact role access for the new `missive_message_intake`/`missive_sync_state` tables — sketched structurally above, left to Neo/Sentinel at actual build time, per this codebase's standing convention for every not-yet-built table.

---

## 6. Organization-Wide Access — Individual Mailboxes, Not Just Shared Pods

**Amendment added:** 2026-09-05, same day as the original document above, in response to a new fact from Peter.
**Written by:** Oracle
**Trigger:** Peter confirmed the eventual email-reading feature needs to cover **individual company email accounts for every staff member (roughly 6–15 people)**, not just the two shared pod inboxes — because tenant/owner correspondence regularly happens through individual staff members' own company addresses. All of this lives in the same Missive system already documented above (not a separate Gmail question). Peter also confirmed Stephen (Director of Operations) currently holds some elevated Missive seat/role that lets him see all of Rincon's Missive accounts, and asked whether that role changes what a token can pull via the API, and whether a new dedicated seat could hold the same role.

**Scope discipline, per the task that produced this amendment:** this section answers what Missive's real product and API allow — nothing more. It does not redesign the connector architecture in Section 2, does not touch the AI-extraction question (Section 8 of `owner-tenant-operational-notes-SPEC.md`, still out of scope), and does not evaluate whether reading individual staff members' company mailboxes is fine from a privacy/compliance standpoint — Peter's task explicitly routes that question elsewhere. Sections 1–5 above remain fully accurate and buildable as-is for the shared-pod-only scope; nothing below invalidates them.

Everything below is sourced to Missive's own documentation, fetched live today (2026-09-05) — see 6.8 for the specific pages. Where a claim showed up only in general web search and I could not confirm it against a Missive documentation page I could directly fetch, it is marked as unconfirmed rather than treated as fact — same discipline as the original document.

### 6.0 Plain-English summary

Missive does have a real Owner/Admin/Basic-Member structure beyond "member of a shared inbox" — that part of Stephen's elevated access is real and documented. But it doesn't do the one thing that would matter here: nowhere in Missive's documentation does the Admin (or even Owner) role grant automatic visibility into another person's private individual mailbox. Missive's own docs are consistent and repeated on this point — personal mail is private unless the account's own sharing settings are explicitly changed to add someone. And separately, and more importantly for anything Rincon would build: **the API doesn't care about UI roles at all.** A token is scoped to whatever specific mailboxes the token-owner's account is already a member of, full stop — an Admin badge doesn't widen that. So there is no shortcut here: reading 6–15 individual inboxes means getting each one individually, explicitly shared to one dedicated credential, the exact same action already planned for the 2 pods, just repeated 6–15 more times — and the API doesn't even hand back a clean tag saying which person's mailbox a given message came from once that's done, the way it does for Team Inboxes. None of this is a blocker. It is a real, larger, and slightly different-shaped piece of setup and connector work than the 2-pod design assumed, and Peter should see that plainly before anyone sizes the individual-mailbox version of this feature.

### 6.1 Does Missive have an Organization Admin role, and what does it grant in the UI?

Yes, confirmed directly from Missive's Roles documentation. Three levels, verbatim:

- **Owner** — exactly one per organization ("There can only be one Owner per organization"). Only the Owner can "manage billing and subscriptions, transfer ownership," or delete the organization.
- **Admin** — any number of people can hold this role; an Owner promotes someone to Admin via **Settings → Users**, no documented cap on how many Admins an org can have. Admin grants: "control shared labels, manage email-sharing settings, and promote or remove members," plus the same day-to-day management capability as Owner for "adding users, managing settings, creating rules." Admin explicitly **cannot** delete the org, transfer ownership, or manage billing.
- **Basic Member** — the default for anyone newly added; can access shared inboxes/accounts they've been added to, participate in chats and tasks.

**What Admin does not appear to grant, per every page I could fetch (Roles, Roles FAQ, Organization Settings, Connected Accounts FAQ, Security FAQ):** any default visibility into another member's private personal inbox. The Connected Accounts documentation states this plainly and repeatedly — personal accounts are "private accounts that only you can access. Conversations go to your Inbox unless you explicitly share them," and admins' account-level power is limited to "manag[ing] and updat[ing] the sharing settings of a shared account" (i.e., an account that's already been made shared) — not converting someone else's still-private personal account into something the admin can read. Missive's Security documentation, separately, only discusses SOC 2 Type II, encryption, and infrastructure — nothing about admin-level content access.

**This means Stephen's apparent "sees everything" access is not explained by the Admin/Owner role definitions as Missive documents them.** The much more likely explanation, consistent with the docs above, is that Stephen's account has simply been individually added as a member/collaborator to every shared account and pod inbox Rincon has set up over time — which would actually be a reassuring, non-magical answer (it confirms the "explicit per-account sharing" model this whole design already depends on), but it's a real, unresolved gap between what Peter described and what the documentation supports. **Recommend Peter (or Stephen) check directly inside Missive's own Settings → Users, and Stephen's own Preferences → Accounts list, what Stephen's role actually is and which accounts he's actually a member of** — five minutes inside the real account, not something documentation from outside can resolve.

### 6.2 Does that elevated role change what's exposed via the API? (the critical question)

**No — confirmed directly against Missive's own REST API documentation page, fetched and quoted verbatim, unchanged from Section 1.1's original finding:**

> "All API tokens are personal. There is no organization-level or shared-account-specific token."

And from the Endpoints documentation, describing `GET /v1/conversations`:

> "List conversations visible to the user who owns the API token."

Neither statement carves out an exception for Owner or Admin. There is no documented "admin scope," header, or parameter that widens a token's visible mailbox set beyond the accounts its own owning user is a member of. A token generated from Stephen's account — Admin role or not — would see exactly what Stephen's account is a member of in Missive, nothing more, nothing automatically broader because of his role. **This directly answers the task's central question: the product-level "admin can see more in the UI" capability (to the extent it's even real per 6.1) does not carry through to the API. The API's access model is exactly what Section 1.1 already described for the 2-pod case, and role has no bearing on it.**

One weaker, secondary claim surfaced repeatedly in general web search — that generating a token for viewing "shared conversations" requires the token-holder to be an admin of the organization that owns the conversation — could not be traced to a specific Missive documentation page I could fetch directly, and reads most plausibly as describing a narrow, different scenario (conversations shared *across separate Missive organizations*, e.g. an agency/accounting-firm multi-client setup, via the `shared_label`/`organization` filters) rather than "an admin token sees every individual member's inbox." Flagged as unconfirmed and likely not applicable to Rincon's single-organization setup — not something to design around.

### 6.3 Can this role go to a new, dedicated seat instead of Stephen's own account?

**Mechanically, yes — Admin is not tied to one fixed account the way Owner is.** Any Basic Member can be promoted to Admin by the Owner via Settings → Users, and there's no documented limit on the number of Admins. So a brand-new seat, created solely for this integration, could be granted Admin.

**But per 6.2, doing so buys that seat nothing extra in terms of API reach.** Admin changes what a seat can *configure* (shared labels, sharing settings on accounts already shared with it, promoting/demoting other members) — not which mailboxes its own token can *read*. So:

- The Sentinel-flagged goal — decouple this integration's credential from a specific person's employment/password/2FA lifecycle, and keep forensic attribution clean — is achievable exactly as Section 3.4/4.2 already recommended for the 2-pod design: a dedicated seat, added only to the specific mailboxes this feature needs.
- Whether that dedicated seat needs Admin at all turns only on whether Admin is required just to *generate* a token in the first place. The primary documentation page, fetched and quoted directly, states the requirement as "part of an organization subscribed to the Productive plan" — **no Owner/Admin restriction is stated.** A secondary web-search-only claim asserted a token-holder "must be logged in as an Account Owner or Admin," which I could not confirm on any Missive page I fetched directly and which contradicts the primary source's own wording. **This is a genuine, cheap thing to verify empirically** — try generating a token from a plain Basic Member trial seat — before assuming either way (same "verify against a real token" discipline Section 3.6 already flagged).
- What actually determines the dedicated seat's mailbox coverage — Admin role or not — is the same mechanism as the existing 2-pod plan: **the seat must be explicitly added as a member/collaborator to every mailbox it needs to read.** For the 2 shared pods, that's the mechanism Section 3.4/4.2 already describes. For 6–15 individual inboxes, see 6.4 — it is the same mechanism, just a materially bigger and repeated task, not a different or shortcut-able one.

**If the actual goal is simply "one dedicated, non-personal credential, cleanly attributable, not tied to Stephen" — that is achievable regardless of whether Missive's Admin role is involved at all.** Admin is not the lever that grants broader mailbox access; per-account sharing is.

### 6.4 What's the real mechanism for reading individual inboxes — and does it require per-member iteration?

**No genuine "everything" call exists.** Confirmed directly from the Endpoints documentation:

- There is **no organization-members-list endpoint** documented anywhere — no way to programmatically enumerate "who works here" and then loop over the results.
- `GET /v1/conversations` has **no parameter that targets one specific individual's connected account.** The full, confirmed parameter set is: `inbox`/`all` (boolean — the *calling token's own* view), `assigned`/`closed`/`snoozed`/`flagged`/`trashed`/`junked`/`drafts` (also boolean, same scoping), `shared_label` (a label ID), `team_inbox`/`team_closed`/`team_all` (a Team ID), and `organization` (documented as having "no use" combined with the others). Nothing in this list says "show me `stephen@rinconmanagement.com`'s inbox" or similar.

**The realistic mechanism, based on Missive's documented account-sharing model, is per-account, per-person, manual setup — not a single toggle or a single API call:**

1. Each staff member's individual company email account is, by Missive's own default, a private personal account visible only to them.
2. To make any of it visible to one dedicated integration seat, **each staff member's account has to be individually reconfigured/shared** to add that dedicated seat as a collaborator — the exact same one-mailbox-at-a-time action Section 3.4/4.2 already describes for the 2 pods, just repeated 6–15 more times now, and again for every future new hire, with no bulk/org-wide equivalent documented anywhere.
3. Once shared, there is a **second, genuinely new problem beyond setup effort**: neither the conversation object nor the message object has a documented field identifying which individual's account a given item came from. The only source-identifying field returned is `team` (populated for Team Inbox items). Calling `inbox=true`/`all=true` from the dedicated seat's own token would return **one merged stream** of everything that seat can see — its own inbox plus every account it's been added to — with no API-level tag distinguishing "this one is Maria's mailbox, this one is Steve's." The only available workaround is inferring the owning mailbox after the fact by matching the actual `to_fields`/`cc_fields`/`from_field` addresses on each message against each staff member's known company email address — a heuristic, not a guarantee, and one that breaks down for any message addressed to more than one staff member at once (a common case for internal CCs on tenant/owner threads). **This is a real, unsolved design problem for whoever eventually builds the individual-inbox connector — flagged here, deliberately not solved, per this task's own scope.**

**Net answer:** yes, per-member iteration is required in two separate places — once during setup (each account shared individually, no bulk action) and again inside the pull job itself, which would need either 6–15 separate polling passes against a merged, self-tagged stream (with the attribution problem above), or, more cleanly, 6–15 *separate* API tokens (one generated per staff member's own account, each naturally scoped to just that person's own inbox with no ambiguity) — a materially different and heavier credential-management shape than the "one dedicated seat" design that works fine for 2 shared pods. Deciding between those two shapes is exactly the kind of question this task told me not to resolve yet ("don't redesign the whole connector architecture") — flagged as the key open fork for that future pass, not decided here.

### 6.5 Does pricing/plan tier gate this separately from base API access?

**No separate gate found.** Missive's pricing page, fetched directly today, confirms API access is a **Productive-plan-and-higher** feature — identical requirement to what Section 1.1 already found, listed the same way for both Productive ($24/user/month) and Business ($36/user/month) tiers. Business tier's additional features are SAML SSO, IP restriction, advanced analytics/reporting, and unlimited users — **nothing named or described as expanded API scope, "organization-wide API visibility," or an org-admin-specific API capability.**

Also checked and not found anywhere in Missive's public documentation: an Enterprise-style compliance/eDiscovery/bulk-export API tier of the kind Slack, Microsoft 365, and similar tools offer specifically for "read everything for compliance/legal-hold purposes." Missive's Security documentation covers SOC 2 Type II certification, encryption in transit/at rest, and infrastructure (AWS, Crunchy Bridge) — nothing about a compliance-export capability. **If such a capability exists, it is not documented anywhere I could reach, and this plan does not assume it exists.**

### 6.6 Rate-limit sanity check at 15–17 mailboxes

Using the exact per-mailbox request pattern Section 2.3 already designed (1 conversations-list call, plus 1 messages-list call per active conversation, plus 1 message-fetch call per genuinely new message), against the confirmed limits from Section 1.2 (300 req/min, 900 req/15 min, 5 concurrent):

**Assumptions, explicitly labeled as assumptions** — real volume is still an open item (Section 3.6/4.5), unchanged by this amendment. Using a deliberately busy-case estimate per mailbox per 15-minute run: 1 list call + 8 active-conversation message-list calls + 15 new-message fetches = **~24 requests/mailbox/run.**

- **At 2 mailboxes** (original plan): ~48 requests/15-min run — far below the 900 budget, never worth worrying about.
- **At 17 mailboxes** (2 pods + up to 15 individuals): ~24 × 17 = **~408 requests/15-min run — still comfortably under the 900/15-min budget (about 45% of it)**, but roughly 8.5× the 2-mailbox load, proportional to the mailbox-count increase. Steady-state, this is not a blocker under any plausible volume for a 150–500 unit portfolio's internal staff correspondence.
- **The real, newly-material risk is the per-minute burst cap (300/min), not the 15-minute cumulative one.** If the job loops through 17 mailboxes back-to-back with no deliberate pacing, ~408 requests completing quickly (sub-2-minute wall clock is plausible for fast API responses) could bunch up and approach or exceed 300 requests within a single 60-second window, even though the 15-minute total is fine. At 2 mailboxes this was never a realistic concern; at 17 it plausibly is. **This means the connector's already-recommended "respect `Retry-After`/`X-RateLimit-Remaining` and back off" behavior (Section 1.2) moves from good hygiene to something the job actually needs — a small deliberate delay between mailboxes, not just error-path handling.**
- **Cold-start / backfill is the bigger number.** Section 2.3's own bounded-pagination backstop (up to 500 conversations per mailbox on a cold start) applied across 17 simultaneous mailboxes — e.g., the first-ever deployment day, or recovery after an extended outage — is up to 500 × 17 = 8,500 conversations to page through, ~10 list-calls/mailbox × 17 = **170 requests just for conversation listing**, before any per-conversation message-listing or per-message body-fetching even starts (which would add far more on top, potentially into the thousands total). **This would clearly exceed the 900/15-min budget if attempted in one uninterrupted burst.** At 2-mailbox scale this backstop would essentially never be exercised hard enough to matter; at 17-mailbox scale, a full cold start is a real, multi-cycle event. **Recommend telling Scotty explicitly: size the first backfill run (and any long-downtime recovery run) as its own self-throttled process that may span multiple cron cycles or hours, not something expected to finish inside one 15-minute tick, once individual mailboxes are in scope.**

**Bottom line:** steady-state 15-minute polling stays safely within Missive's documented limits even at 17 mailboxes under any plausible volume. The two things that actually change in kind, not just degree, are (1) per-minute pacing between mailboxes goes from optional to needed, and (2) the first backfill (or any major recovery) needs to be designed as a deliberately throttled, possibly multi-cycle process rather than assumed to complete in one run.

### 6.7 What this amendment does not resolve

- Whether Stephen's actual current access is role-based or just the accumulated result of being individually added to many accounts over time (6.1) — a five-minute check inside Rincon's real Missive account, not answerable from documentation.
- Whether a Basic Member (non-Admin) can generate their own API token — the primary docs suggest yes, one secondary web-search claim suggests no; genuinely worth a two-minute empirical test with a real trial seat before the credential design is finalized (6.3).
- The connector-architecture fork this creates — one dedicated seat polling a merged, self-tagged stream (with the attribution-by-address-matching problem in 6.4) versus 6–15 separate per-person tokens — deliberately left open, per this task's instruction not to redesign the connector yet.
- Real message volume for individual staff mailboxes (needed to replace 6.6's assumed placeholder numbers with actual ones) — same category of open item as Section 3.6/4.5 already flagged for the 2 pods, just not yet asked for the individual-mailbox case.
- Anything about whether reading individual staff members' company mailboxes is an appropriate thing to do from a privacy/employment/compliance standpoint — explicitly out of scope for this amendment, per the task that produced it; that question is already being routed elsewhere.

### 6.8 Sources for this section

Missive documentation fetched live on 2026-09-05, in addition to the pages already listed in this document's original Sources section:
- [Roles | Missive Docs](https://missiveapp.com/docs/administration/roles)
- [Roles FAQ | Missive Docs](https://missiveapp.com/docs/administration/roles/faq)
- [Organization settings | Missive Docs](https://missiveapp.com/docs/administration/organization-settings)
- [Billing and plans | Missive Docs](https://missiveapp.com/docs/administration/billing-and-plans)
- [Billing FAQ | Missive Docs](https://missiveapp.com/docs/administration/billing-and-plans/faq)
- [Security | Missive Docs](https://missiveapp.com/docs/administration/security)
- [Security FAQ | Missive Docs](https://missiveapp.com/docs/administration/security/faq)
- [Connected accounts | Missive Docs](https://missiveapp.com/docs/core-features/connected-accounts)
- [Connected Accounts FAQ | Missive Docs](https://missiveapp.com/docs/core-features/connected-accounts/faq)
- [Sharing options | Missive Docs](https://missiveapp.com/docs/core-features/connected-accounts/sharing-options)
- [REST API | Developers | Missive Docs](https://missiveapp.com/docs/developers/rest-api) — re-fetched and re-quoted directly for this amendment's role-scoping questions
- [Endpoints | Developers | Missive Docs](https://missiveapp.com/docs/developers/rest-api/endpoints) — re-fetched and re-quoted directly for parameter and response-field detail not needed by the original document
- [Missive Pricing](https://missiveapp.com/pricing) — re-fetched for full plan-by-plan feature lists

Where a claim came from general web search rather than a Missive documentation page I could fetch and quote directly, it is marked unconfirmed above (6.2, 6.3) rather than stated as fact.

---

## 7. The Observer Role — Does It Restrict API Access?

**Amendment added:** 2026-09-05, same day as the original document and Section 6's amendment above.
**Written by:** Oracle
**Trigger:** A specific follow-up question: Missive has a real "Observer" membership type for Team Inbox members (view-only-flavored, no notifications) that looks like a conceptually better fit for this integration's dedicated seat than a regular "Active member." The question this section resolves: does that restriction actually reach the API — so a token generated from an Observer's seat would be more limited than a Member's token — or is Observer purely a notification/UI-surface distinction with zero effect on what an API token can do?

**Scope discipline, consistent with Section 6's amendment:** this section answers the Observer/API question only. It does not redesign the connector, does not resolve Section 3.2's still-open "Team Inbox vs. shared regular Inbox" question, and does not touch the AI-extraction question. Sections 1–6 remain accurate and unchanged; nothing below invalidates them.

Everything below is sourced to Missive documentation pages fetched live today, quoted verbatim from the actual page text (not summarized secondhand) — see 7.7 for the full list and exact fetch method.

### 7.0 Plain-English summary

**The short answer: Missive's own documentation says Observer is a notifications-and-one-specific-view distinction, not a read/write restriction — and one important part of the premise behind this question turns out to be wrong.** The idea that an Observer "cannot manage/delete things for the team" is contradicted by Missive's own FAQ: Observers can trash conversations, and doing so from inside the team inbox removes it for everyone, exactly like a full member. The single most on-point sentence I found, sitting directly in Missive's **developer** documentation (not just the general product FAQ), says Observers "do not get notified for new messages in the team inbox and do not see conversations in the unified Team Inboxes view, **but they can open and manage the team inbox as needed. Both** [active members and observers] **get access to contacts, responses, calendars and integrations shared with the team.**" That is about as close to a direct answer as the documentation gets, and it points toward "no meaningful restriction" — but no page anywhere explicitly says the words "an Observer's personal API token returns the same data as a Member's token." That specific sentence does not exist in Missive's docs. So: strong, multi-source circumstantial evidence pointing one direction, and an honest gap where a flat confirmation would be. Given that, and given what the trash-behavior finding does to the "safer" assumption, I would not build the credential design around Observer being a real access restriction without a five-minute empirical check first (7.6).

### 7.1 Is Observer a per-team-inbox membership type, distinct from the org-level Owner/Admin/Basic Member roles? — Confirmed yes

Confirmed directly from Missive's Team Inboxes FAQ, quoted verbatim: **"When creating a team, you can define two types of users: Active members and Observers."** This is a property of team (= Team Inbox) membership specifically, set per team, and is a completely separate axis from the org-level Owner/Admin/Basic Member roles Section 6.1 already documented. A person's org role and their team-membership type are independent: someone can be an org Basic Member while being an Active member of one team and an Observer of another, simultaneously.

**How someone actually becomes an Observer**, per the same FAQ page, quoted verbatim: *"To edit the active members and observers of a team: 1. Go to Settings > Teams. 2. Click Edit next to the team. 3. Select active members and observers from the dropdown. 4. Then click Save at the bottom."* This is one screen with (functionally) two membership lists — there is no documented requirement to add someone as a regular member first and separately "convert" them; the same Edit screen is used both to add someone straight into the Observers list from day one, and to move someone already on the team between the two lists later. So for Peter's practical purposes: a brand-new dedicated integration seat could be added directly as an Observer of the two pod team inboxes, with no intermediate step.

**Note on Section 3.2's still-open question:** this mechanism (`Settings > Teams > Edit`, active-members/observers dropdown) only exists for Missive's **Team Inbox** model. If Rincon's pod inboxes turn out to be the other model — a shared regular Inbox, not a formal Team (Section 1.7/3.2, still unconfirmed) — Observer as a concept may not apply at all; Observer is specifically a Team Inbox construct. This is an added reason Section 3.2's open item needs resolving before any Observer-based credential design is finalized, not a new blocker on its own.

### 7.2 What Missive's documentation says Observer actually restricts — and, importantly, what it does not

Two confirmed, narrow restrictions, both about visibility/notification surface, not data access:
1. **No notifications.** Confirmed identically on three separate pages (Team Inboxes FAQ, Connected Accounts sharing-options page, and the REST API Endpoints page's own team-object field reference): Observers "do not receive notifications."
2. **Not shown in the "Team Inboxes" unified mailbox.** Team Inboxes FAQ, quoted verbatim: *"It does not include conversations of team inboxes in which you are an Observer."* Observers still see the team's conversations, just only inside that specific team inbox's own view, not folded into the cross-team "Team Inboxes" summary mailbox a person uses when they're an active member of several teams.

**What is explicitly, directly contradicted by Missive's own documentation:** the premise that an Observer "cannot manage/delete things for the team." From the Team Inboxes FAQ, quoted verbatim, under "Can I trash conversations as an Observer or delegated user?": *"Observers have similar behavior [to delegated users] - they can trash, but from non-team locations it only affects their own access."* And the general trash-behavior rule stated just above it on the same page: trashing **from a team inbox** — which is exactly where an Observer's normal view of these conversations lives — *"Trashes the conversation for everyone... Removes the conversation from the team inbox for everyone... Moves to trash for everyone with access."* Put together: an Observer trashing a conversation from inside the team inbox removes it for the whole team, same as anyone else. The one softened case ("from non-team locations, only affects their own access") describes trashing from some other mailbox view entirely — it is not a special Observer-only carve-out; the FAQ says "delegated users" get that same softened behavior too. **This is worth flagging plainly: the "Observer = can't manage or delete" assumption in the original question does not hold up against Missive's own FAQ.** Observer is a notifications-and-one-view restriction, not a permissions ceiling on actions.

The single most direct statement, and the one I'd weight most heavily, comes from the **developer** documentation itself — the REST API Endpoints page, in the field reference for the `active_members`/`observers` attributes of the `Create team(s)` (`POST /v1/teams`) and `Update team(s)` (`PATCH /v1/teams/:id`) request body — quoted verbatim, in full:

> "**active_members, observers** — Active members get notified for new messages in the team inbox and also see conversations in the unified Team Inboxes view. Observers do not get notified for new messages in the team inbox and do not see conversations in the unified Team Inboxes view, **but they can open and manage the team inbox as needed. Both get access to contacts, responses, calendars and integrations shared with the team.**"

This is Missive's own developers' description of what the `observers` field controls, sitting on the exact `rest-api/endpoints` page the original question named as the most likely place to find something. It says, in Missive's own words, that Observers "can open and manage the team inbox as needed" and that "both" membership types "get access to" the same contacts/responses/calendars/integrations. Nothing here scopes this statement to "UI only" or excludes API tokens — but nothing states "and this is also true of API tokens" in so many words either. It is the strongest signal available, not a proof.

### 7.3 Does this carry through to a personal API token specifically? — Best available evidence, explicitly marked as inference, not a confirmed guarantee

No page states in so many words "an Observer's API token behaves identically to a Member's API token." What I can confirm and chain together:

- **The general access rule, unchanged from Section 1.1/6.2:** *"All API tokens are personal... Your personal token has access to any account you can access in Missive, including shared accounts."* Access follows the account, not a separate API-specific permission grant. Since Observers can (per 7.2) "open and manage the team inbox as needed" inside Missive itself, the general rule implies their token inherits that same access.
- **Documentation names exactly two, specific mechanisms that reduce what an API call returns based on the token-owner's relationship to content — and Observer is not one of them.** Quoted verbatim from the Endpoints page: (1) *"Conversations where the API token user is a guest will be returned with limited data, containing only the `id` and `last_activity_at` fields"* — but **"guest" is a distinct, separate Missive feature** (Section 7.4 below), not the Team Inbox Observer role; and (2) *"When the API token user is not related to the message (not the author, recipient, or watcher), sensitive fields such as `body`, `preview`, and recipient lists may be redacted."* Team membership (active or observer) is never named as a category checked against here. If ordinary team membership didn't count as "related" for this purpose, the entire premise of Sections 1.3–1.5 of this document — that a Missive personal token can read its own team's message bodies via `GET /v1/messages/:id` at all — would already be broken for every team member, Active or Observer alike, and nothing in the original research (Section 1) flagged that as a problem. So it's a reasonable inference, not a documented certainty, that being on the team (Active or Observer) satisfies whatever "related" means here.
- **Net reading:** the weight of evidence — the developer-docs quote in 7.2, the general access-follows-account rule, and the absence of Observer from either of the two documented redaction mechanisms — points toward **no practical difference in what `GET /v1/conversations`, `GET /v1/conversations/:id/messages`, and `GET /v1/messages/:id` return for an Observer's token versus an Active member's token, for conversations in a team inbox that account belongs to.** I am stating this as the most likely answer, not as a confirmed fact, because the one sentence that would remove all doubt does not exist in any page I could fetch.

### 7.4 Guest is a different Missive feature entirely — not to be confused with Observer

Worth stating plainly since "guest" is the one API-documented status that does restrict returned data (7.3): **Guest and Observer are unrelated Missive concepts.** Confirmed from Missive's Guests FAQ page: a Guest is someone invited to **specific individual conversations** by email invitation (*"They receive an email invitation"* and *"click the link and log in with their existing Missive account"* to join just that conversation) — an external-collaborator feature, unconnected to Team Inbox membership. A Guest can view the conversations they were specifically invited to and participate in internal chat, but explicitly cannot reply to the actual email/SMS, be assigned conversations, or manage labels. Guest is documented as its own advanced feature (`Advanced features > Guests` in Missive's docs, separate from `Core features > Team inboxes`). **Nothing in Missive's documentation equates "Observer of a team inbox" with "guest," and the API's guest-specific data restriction (limited to `id`/`last_activity_at`) has no documented connection to the Observer role.** This distinction matters here only because it's the one place the API docs use restrictive, role-like language at all — and it isn't about Observer.

### 7.5 So — would adding Peter's account as an Observer actually be a *safer*, more restricted setup than the "add as regular Member" plan already in Section 3.4/4.2?

**Practically, for what this specific integration's connector code actually does: little to no difference, and not for the reason originally hoped.** Two separate reasons:

1. **The connector, as designed in Section 2, never calls a write/delete endpoint regardless of role** — every step in Section 2.3 is a `GET`. So whether Observer status would theoretically permit or block a write call is moot for the code Q would actually ship; both an Observer's and a Member's token would be equally sufficient for the read-only job.
2. **As a defense-in-depth property (the more interesting question — "if this token leaked or a bug called the wrong endpoint, would Observer status contain the damage?") — the evidence in 7.2 suggests no.** Missive's own developer docs say Observers "can open and manage the team inbox as needed," and its product FAQ confirms Observers can trash conversations with the same team-wide effect as any member. If that holds for the API too (7.3's inference), an Observer's token is not a hard read-only ceiling — it is not meaningfully narrower than a Member's token in terms of what it could technically be used to do, only in what the account owner sees and gets notified about inside the Missive app itself.

**What Observer status still gets Rincon, and it is genuinely worth doing regardless of the API question:** a dedicated integration seat added as an Observer is quieter (no notification noise for an account nobody is watching) and self-documenting — anyone looking at Missive's Team settings later sees this seat listed as "Observer," a clear signal that it's a passive, monitoring-style presence rather than an active human user, which is a real, if soft, benefit for anyone auditing Missive's membership list later. That is a legitimate reason to prefer Observer over Member for the dedicated seat. **It should not be sold to Peter as "this makes the integration's API access read-only" — that specific claim is not supported by what Missive documents, and the trash-behavior finding suggests the opposite premise (Observer = can't manage/delete) is actually wrong.** The one access-narrowing lever Missive actually documents remains what Section 3.4/4.2 already recommended: which specific mailboxes/teams the dedicated seat is added to at all — that, not Observer vs. Member, is the real boundary.

**Does an Observer's token still successfully read message content — the one thing this integration needs?** Very likely yes, with high but not absolute confidence, for the same reasons in 7.3: Observers can read team inbox conversations in the product itself (that's the entire point of the role — "monitor the work being done"), the general API access rule ties token access to account access, and Observer is not named in either documented data-restriction mechanism. This is the single most important practical fact for Peter's purposes, and it is also exactly the fact that should not be assumed without the check in 7.6.

### 7.6 What documentation does not resolve, and the concrete way to actually find out

Stated plainly, per the task's own instruction: **documentation does not contain an explicit statement that an Observer's personal API token returns the same data as a Member's token for team inbox endpoints.** Everything in 7.3–7.5 above is a well-sourced inference built from adjacent, directly-quoted statements — not a single sentence that settles it outright. This is exactly the kind of thing that needs an empirical test before Q builds a credential design around it, not an assumption picked because it's the more convenient answer.

**The concrete, cheap way to resolve it, in order of preference:**

1. **Empirical test with a real trial seat (recommended first step, ~15 minutes, no support ticket needed):** Add a test account to one pod's Team Inbox as an **Observer**, generate a personal API token from that account (requires the org to already be on the Productive plan or higher per Section 4.1), and call `GET /v1/conversations?team_inbox=<pod_team_id>&limit=5` followed by `GET /v1/messages/:id` on one of the returned messages. If it returns full conversation/message data (including `body`) identical in shape to what a Member's token would return, the question is settled empirically, cheaply, and specifically for Rincon's own Missive configuration — better evidence than any documentation page could give, and consistent with the "verify against a real token" discipline Sections 3.6 and 6.3 already established for this same document's other unresolved items. This can be done with the same trial-seat effort Section 6.3 already recommended for the separate "can a Basic Member generate a token" question — worth doing both checks in the same sitting.
2. **If a direct answer is still wanted beyond the empirical test, contact Missive support directly** with a specific, narrow, yes/no-answerable question — drafted here so it can be sent as-is:

   > "For the REST API, does a personal API token generated from an account that is an **Observer** (not an Active member) of a Team Inbox return the same conversation and message data via `GET /v1/conversations` (with the `team_inbox` filter) and `GET /v1/messages/:id` as a token generated from an Active member of that same team? Specifically: does Observer status ever cause conversations or messages in that team inbox to come back with reduced fields (similar to how a 'guest in the conversation' returns only `id` and `last_activity_at`), or is Observer purely a notification/UI-view distinction with no effect on API responses?"

   This question is deliberately narrow and closed-ended (built to get a yes/no from a support rep, the same discipline this document already uses elsewhere for the AppFolio-attachments precedent noted in project memory) rather than open-ended, since a vague question risks the same kind of confidently-wrong answer already seen once from a different vendor's support rep on a different integration.
3. **No changelog or blog post confirms this either way.** I found the existence of a `missiveapp.com/blog/guest-access` announcement post via search (about the unrelated Guest feature, 7.4) but did not fetch it, since it's about a different feature; I found no blog or changelog post specifically about the Observer role's API behavior. Not a dead end worth spending more time on — the trial-account test in option 1 is strictly faster and more conclusive than continuing to search for a blog post that may not exist.

### 7.7 Sources for this section

Missive documentation fetched and quoted verbatim, live, today (2026-09-05):
- [Team Inboxes FAQ | Missive Docs](https://missiveapp.com/docs/core-features/team-inboxes/faq) — fetched as raw page text (not just AI-summarized) specifically to get exact verbatim quotes on Observer definition, the active-members/observers Settings > Teams edit flow, and the trash-behavior rules in 7.2.
- [Team inboxes | Missive Docs](https://missiveapp.com/docs/core-features/team-inboxes) — checked, does not mention Observer.
- [Roles | Missive Docs](https://missiveapp.com/docs/administration/roles) — re-checked specifically for "Observer"; confirmed absent (only Owner/Admin/Basic Member documented at the org level).
- [Roles FAQ | Missive Docs](https://missiveapp.com/docs/administration/roles/faq) — re-checked specifically for "Observer"; confirmed absent.
- [Endpoints | Developers | Missive Docs](https://missiveapp.com/docs/developers/rest-api/endpoints) — fetched as raw page text specifically to locate and quote every occurrence of "guest," "observer," "watcher," "role," "member," and "permission" verbatim, including the `active_members`/`observers` field description under `Create team(s)` / `Update team(s)`, the guest-conversation data-limiting rule, and the watcher/message-relation redaction rule.
- [REST API | Developers | Missive Docs](https://missiveapp.com/docs/developers/rest-api) — re-checked specifically for "Observer"; confirmed absent.
- [Sharing options | Missive Docs](https://missiveapp.com/docs/core-features/connected-accounts/sharing-options) — confirms the same Active member/Observer notification distinction in the account-sharing context.
- [Guests FAQ | Missive Docs](https://missiveapp.com/docs/advanced-features/guest-access/faq) — confirms Guest is a distinct, conversation-level, external-collaborator feature, unrelated to Team Inbox Observer status (7.4).

Where general web search surfaced a claim I could not trace to a specific Missive documentation page fetched directly (e.g., secondary summaries phrasing Observer's product behavior slightly differently), it is not relied on above — every quoted sentence in this section came from a page fetched and read directly, using the same discipline as the rest of this document.

---

## What Sentinel/Scotty Need Before Any Build

- **Sentinel:** the dedicated-seat/least-access design (Section 3.4) is a real recommendation, not yet enforced by anything — confirm it's actually followed at credential-creation time, not just documented; review the RLS/access-tier question for `missive_message_intake` flagged in Section 2.5 (arguably narrower than `maintenance_email_context`, a genuinely new question); review the HTML-to-text conversion step (Section 3.5) for the keyword-evasion concern noted there; confirm `X-Hook-Signature`-class webhook risk is moot given the poll-only recommendation, and revisit only if that recommendation is ever reversed.
- **Scotty:** provision `MISSIVE_API_TOKEN` in `.env`/`.env.example` once Peter has it; write and install the `cron-missive-sync.sh` wrapper on Sally (same pattern as the existing four `cron-*.sh` scripts); confirm the suggested 15-minute cadence against real pod-inbox volume (Section 4.5) before finalizing; confirm the module-level overlap guard (Section 2.2) is sufficient given the Hub's confirmed single-pm2-fork-instance deployment, same reasoning already validated for `maintenance-history`'s own ingest job.

---

## Open Items — Needs Confirming Before Any Build

1. **Team Inbox vs. shared regular Inbox** for Rincon's actual pod inboxes (Section 3.2) — determines the query parameter and ID the connector code needs. Blocking for connector design, not for this plan.
2. **Rincon's current Missive plan tier** — determines whether an upgrade is needed before a token can even be generated (Section 4.1).
3. **Real pod-inbox message volume** — sizes the cron cadence and confirms rate limits are a non-issue in practice, not just in theory (Section 4.5).
4. **Whether a top-level `GET /v1/messages` endpoint actually exists and is useful** (Section 1.5, 3.6) — worth a quick live check once a trial token exists, since it could simplify Section 2.3's per-conversation message-listing step if it supports a mailbox-wide filter.
5. **RLS/access-tier design for `missive_message_intake`** (Section 2.5) — genuinely harder than `maintenance_email_context`'s (that table never stores privileged content at all; this one, by design, has to). Needs a real Neo/Sentinel/Mason pass, not a default.
6. **The dedicated-seat cost** — one more paid Missive seat, ongoing — small, but a real recurring line item Peter should see named plainly rather than discover later.

---

## Sources

Missive documentation fetched live on 2026-09-05:
- [Overview | Developer Documentation](https://missiveapp.com/help/api-documentation/overview)
- [REST API | Developers | Missive Docs](https://missiveapp.com/docs/developers/rest-api)
- [Endpoints | Developers | Missive Docs](https://missiveapp.com/docs/developers/rest-api/endpoints)
- [Rate Limits | Developers | Missive Docs](https://missiveapp.com/docs/developers/rest-api/rate-limits)
- [Webhooks | Developers | Missive Docs](https://missiveapp.com/docs/developers/webhooks)
- [Missive Pricing](https://missiveapp.com/pricing)
- [Team Inboxes FAQ | Missive Docs](https://missiveapp.com/docs/core-features/team-inboxes/faq)
- Missive's own product explainer on Inbox vs. Team Inbox sharing (via `learn.missiveapp.com`), located via web search, same content confirmed above

No claim in this document about Missive's API is sourced to anything other than the pages above, fetched today. Where a page returned only introductory/marketing content instead of the technical detail requested (this happened twice on first attempt against `missiveapp.com/help/...` URLs, which redirect to marketing pages rather than the GitBook technical docs), I re-fetched the actual `missiveapp.com/docs/developers/...` GitBook URLs instead and note that redirect behavior here so it isn't mistaken for a dead end if someone re-verifies this later.
