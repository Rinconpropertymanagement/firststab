# Missive intake: do not copy the Hub's own "Work Order Alert" emails

**Status:** PREPARED ONLY. Not merged, not deployed, not switched on. Peter has not decided; Jarvis is asking him. It lives on its own branch, `feature/email-intake-exclude-work-order-alerts`, cut from the same base as the description feature, and is deliberately not part of that feature's commits.

**Why.** The Hub's alert email can now carry the Latchel job's title and description (`projects/hub/work-order-notes-alert-SPEC.md` Section 6A). The Missive intake copies every message from the two pod inboxes into `missive_message_intake` (and from there into the searchable archive), so each alert would put tenant-written text into tables that every Archive Search user can search and that the archive passes send to Anthropic. That contradicts Peter's decision that nothing from the job text goes to Anthropic. Asimov ruled that switching the description block ON is blocked until this exclusion is deployed and verified. Governance record: `compliance/work-order-note-alerts-description-governance-review.md` Section 8. Asimov pre-approved this design if built exactly as described, so it needs no further Asimov round; it is a Standard change that still needs Peter's explicit yes before deploy. It narrows collection (no new mailbox, no new field), so it does not widen the connector's scope lock.

**What it does.** `storeMessage` (`lib/shared.js`) is the single place both the 30-minute sync and the historical backfill write a message. At its top it now asks `isWorkOrderAlertMessage(message)`. For an alert it writes nothing to `missive_message_intake` (no row, no stub, no body_text), writes one counts-only audit event, and returns `null`. Both callers (`router.js` and `backfill-missive-history.js`) count a `null` as **excluded**, not stored, and report `messages_excluded` next to `messages_stored`.

**Matching: both parts are required, never the subject alone.**
1. The sender (trimmed, case-insensitive) is the Hub notification address `noreply@rinconmanagement.com` (the address `lib/notify.js` sends from; a test asserts they are equal) AND the subject, after stripping any leading `Re:`, `Fw:`, `Fwd:`, begins with "Work Order Alert" (case-insensitive) → reason `sender_and_subject`.
2. **Reply guard:** any other `@rinconmanagement.com` sender whose normalised subject begins the same way (a staff reply can quote the alert body) → reason `internal_reply`.
3. An outside sender who uses that subject is stored normally (otherwise an outsider could copy the subject and hide a message from complaint tracking). Look-alike senders (`noreply@rinconmanagement.com.evil.test`, a different domain, a subdomain) are stored.

**Visibility, not silence.** One audit event per skip: `email_intake.work_order_alert_excluded`, with the message id, conversation id, mailbox key and the reason code. Never the subject, an address or the body.

**Known limits.**
- The message is still fetched from Missive and then discarded in memory. Skipping before the fetch would save an API call but only if the list metadata is proven to carry sender and subject; not assumed.
- A conversation that gets new activity may be re-fetched on a later run (the skipped message is not in `missive_message_intake`, so it is not remembered as "already stored"). Acceptable.
- The match trusts the From header Missive reports. A forged From of the Hub address would be skipped; protection against forgery is mail authentication on the domain, not this code.
- It does nothing about the 153 alerts already copied (they predate the description and hold none). Deleting them is Peter's separate, explicit decision and must respect the table's retention rules; `missive_message_intake.pipeline_status` allows only `pending` and `processed`, so no "excluded" status or stub row is possible without a schema change, and none is made.

**Tests.** `test/work-order-alert-exclusion-tests.js` (16 cases): exact match; `Re:`/`Fw:`/`Fwd:` forms; em dash, hyphen and bare subjects; sender case and whitespace; near-miss senders (stored); outside sender with the subject (stored); internal reply (skipped); other subjects from the Hub sender (stored); missing fields; an ordinary message stored exactly as before; audit failure still does not store; the sender constant equals `lib/notify.js`; and both callers' counters (the sync and the backfill, real and dry-run). Run: `node projects/hub/email-intake/test/work-order-alert-exclusion-tests.js`. The existing `test/run-tests.js` (13 cases) is unchanged.

**Verification after deploy (read-only, counts only).** Let `T` be the deploy time.
```sql
-- must be 0
select count(*) from missive_message_intake
where lower(btrim(from_address)) = 'noreply@rinconmanagement.com' and created_at > :T;

-- must be greater than 0 once a real alert has gone out after T
select count(*) from audit_log
where action = 'email_intake.work_order_alert_excluded' and created_at > :T;
```

**Sequence (Asimov's ruling).** (1) Peter says yes or no to the exclusion. (2) Deploy the exclusion alone. (3) Wait for at least one real, natural alert and confirm it was skipped. (4) Only then set `WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED=yes` (Jarvis or Scotty). (5) Only then, with Peter's separate yes, switch `WORK_ORDER_ALERT_DESCRIPTION_MODE` to `on`.
