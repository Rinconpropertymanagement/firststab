-- ============================================================
-- Migration: 20260918050000_notification_recipients_schema
-- Created:   2026-09-18
-- Author:    Neo (database specialist)
--
-- WHY THIS MIGRATION EXISTS
-- Peter approved a general-purpose notification-recipient system for
-- the Hub (projects/hub/ and projects/insurance-compliance/): any tool
-- that needs to email someone should be able to reliably resolve —
--   1. A specific named person, by their current email.
--   2. Whoever currently holds a given role for a given tool (e.g. "the
--      pod_lead for security_deposit"), optionally narrowed to one pod.
--   3. A shared/team inbox (a pod team address, or a role-style address
--      like a Director of Operations inbox) as a first-class recipient
--      in its own right — not a string typed into each tool's code.
--
-- #1 and #2 are already real and working today — team_members and
-- team_member_tool_roles (20260812020000_shared_team_members.sql).
-- security-deposit/router.js's pod_lead lookup and insurance/router.js's
-- inspection_coordinator lookup both already join
-- team_member_tool_roles -> team_members(email, is_active) to get real
-- addresses. What's actually missing:
--   - team_member_tool_roles has no idea what pod a person belongs to,
--     so "the pod_lead in Solimar specifically" can't be asked yet —
--     only "every pod_lead, tool-wide" (security-deposit's own,
--     previously-accepted v1 limitation).
--   - #3 does not exist as data anywhere. fariateam@rinconmanagement.com
--     and solimarteam@rinconmanagement.com (insurance/router.js) and the
--     DO_EMAIL / PETER_EMAIL env vars (server.js, security-deposit,
--     insurance, archive-search) are real, live, already-used addresses
--     — but every one is a literal string or an env var baked into one
--     tool's own code, not a row in a table any tool could look up.
--
-- This migration adds exactly the two things needed to close both gaps,
-- and nothing else. No application code, no router changes, and no
-- seed/data rows ship from this file — schema only, same standing
-- convention as every other migration touching this part of the schema.
--
--
-- ============================================================
-- RECONCILING `users` AND `team_members` — WHAT THIS DOES, AND
-- DELIBERATELY DOES NOT DO
-- ============================================================
-- Two roster-shaped tables already exist, kept apart on purpose since
-- 20260812020000 ("kept separate on purpose — called out in the handoff
-- report as worth a second look, not baked in silently"). This is that
-- second look.
--
--   users           Org-chart roster (name, email, role = job title,
--                    pod, department, is_active). NOT tied to login.
--   team_members     Hub login roster, anchored to Supabase Auth via
--                    auth_user_id. Already the table 13 of the Hub's 15
--                    tools grant per-tool permissions against, via its
--                    companion team_member_tool_roles.
--
-- REAL, LIVE DEPENDENCIES ON `users` — checked directly in this repo
-- before deciding anything, not assumed from an earlier summary:
--   - Foreign keys into users(id) exist in THREE separate migrations,
--     across 8 columns total: workflow_instances.created_by,
--     tasks.assigned_to, tasks.completed_by, communications_log.sent_by,
--     audit_log.performed_by, documents.uploaded_by
--     (20260720000003_foundation.sql); property_insurance.verified_by
--     (20260720000004_insurance_compliance.sql); and a NOT NULL
--     rental_analyses.run_by (20260812010000_rental_analysis_schema.sql).
--     Dropping or renaming `users`, or repointing all of these at a
--     different table's id, is a real, multi-table data migration in
--     its own right — not a one-line schema change.
--   - Application code reads `users` directly in at least 6 hub tools
--     today, not just the 3 named in this task's background research:
--     complaint-tracking, archive-search, maintenance-history, and
--     owner-tenant-notes read it for email -> id attribution, and
--     call-stats and scorecard also read it. Two of those reads matter
--     a lot for this decision: call-stats/router.js reads users.pod
--     directly ("Pod (Solimar/Faria) is looked up here, at query time...
--     Only the four 'pod role' users have a non-null pod") to group real
--     call activity by pod, and scorecard/router.js reads
--     users.email/name the same way. users.pod is real, live,
--     load-bearing data today — not a stale or unused column.
--
-- DECISION: this migration does not touch `users` at all — no rename,
-- no column drop, no data copied out of it. Folding it into
-- team_members and deprecating it, one option this task's brief offered,
-- would mean repointing 8 existing foreign keys and updating 6+ tools'
-- queries — a real multi-table code-and-data migration that nothing in
-- this build actually requires. Rushing that inside a notification-
-- recipient migration is exactly the kind of avoidable risk the "does
-- this break any existing data" check exists to catch. Extending
-- `team_members` instead uses the table already proven out for this
-- purpose — 13 tools already query it for permissions, and the
-- pod_lead / inspection_coordinator lookups above are the direct
-- precedent this migration builds on.
--
-- WHAT team_members GAINS: one column, `pod`. That's the one org-chart
-- fact requirement #2 actually needs, to filter a role-for-tool lookup
-- down to one pod. `users` also has `role` (job title) and `department`
-- — deliberately NOT copied onto team_members here, because nothing in
-- this build resolves a recipient by job title or department, and
-- Peter's own standing rule is to start with fewer columns. A trivial
-- one-line follow-up later if a tool genuinely needs either.
--
-- NAMING NOTE: the new column is `team_members.pod`, not `role`.
-- team_member_tool_roles.role already means "this person's permission in
-- this one tool" (admin, pod_lead, reviewer...), and that table is
-- joined to team_members in every query shown above. Naming an
-- org-chart field "role" right next to that join would be confusing in
-- exactly the spot most likely to be misread. (users.role and
-- team_member_tool_roles.role already coexist today only because they
-- live on two tables that are never joined together in the same query —
-- see 20260902020000's own note on that. team_members and
-- team_member_tool_roles ARE joined together constantly, so the same
-- name clash would actually bite here.)
--
--
-- ============================================================
-- KNOWN DATA-CONFLICT RISK — READ BEFORE POPULATING team_members.pod
-- ============================================================
-- This migration copies no data — team_members.pod lands NULL on every
-- existing row. But once it IS populated (by Peter, or by whoever builds
-- an admin screen for this later), the same real person's pod will exist
-- in two places (users.pod and team_members.pod) with nothing in the
-- database keeping them in sync. If someone changes pods, both need
-- updating, or the two tables will quietly disagree.
--
-- I have no database access from this environment and have not compared
-- the two tables' actual rows. Before this is relied on for anything
-- real, run this in the SQL Editor:
--
--   SELECT u.email,
--          u.name          AS users_name,
--          tm.full_name    AS team_members_name,
--          u.pod           AS users_pod,
--          tm.pod          AS team_members_pod,
--          u.is_active     AS users_is_active,
--          tm.is_active    AS team_members_is_active
--   FROM users u
--   FULL OUTER JOIN team_members tm ON tm.email = u.email
--   WHERE u.pod IS DISTINCT FROM tm.pod
--      OR u.id IS NULL
--      OR tm.id IS NULL
--   ORDER BY COALESCE(u.email, tm.email);
--
-- Right after this migration, every row with a pod in `users` will show
-- up here simply because team_members.pod is still NULL — that's
-- expected, not a conflict. What's actually worth a manual look: any row
-- where BOTH pods are set and different, any users row with no matching
-- team_members row (someone who can't log into the Hub, or whose email
-- differs between the two tables), and any team_members row with no
-- matching users row (someone the Hub knows who never made it onto the
-- org-chart roster). Ask if you'd like this turned into a one-time
-- backfill (copying users.pod into team_members.pod for matching,
-- non-conflicting emails) once you've eyeballed the results — that's a
-- data operation, kept deliberately separate from this schema change.
--
-- I considered a database trigger to keep the two pod columns in sync
-- automatically and deliberately did not build one. Pod reassignment is
-- a rare, deliberate event, not a high-frequency one — a sync trigger is
-- exactly the kind of hidden, "clever" machinery Peter's own standing
-- instruction (simple over clever) asks to avoid. Two small fields kept
-- in sync by whoever changes them is simpler, and more visible when it
-- drifts, than a trigger silently doing it.
--
--
-- ============================================================
-- WHY NOT ONE MORE ABSTRACTION LAYER
-- ============================================================
-- I considered a single polymorphic "notification_recipients" table (a
-- recipient_type + recipient_ref pointing at a person, a role/tool/pod
-- combination, or a shared inbox) so every tool would query one place.
-- Rejected: each of the three recipient types below already has one
-- natural, direct table to query. A hub tool doing three kinds of simple
-- lookups isn't a problem that needs solving, and a polymorphic table
-- would just be indirection between a tool and the same three queries it
-- can already run directly. Simple over clever.
--
--
-- ============================================================
-- CHANGE 1 — team_members.pod
-- ============================================================
-- Same two values and the same meaning as users.pod: Solimar or Faria;
-- NULL for anyone not on a pod (Executive, Operations, Business
-- Development roles — per foundation.sql's own note on users.pod).
-- Nullable, additive — no existing row is touched beyond getting NULL.
--
-- Lookup pattern this enables (requirement #2, pod-filtered):
--   SELECT team_members.email
--   FROM team_member_tool_roles
--   JOIN team_members ON team_members.id = team_member_tool_roles.team_member_id
--   WHERE team_member_tool_roles.tool = 'security_deposit'
--     AND team_member_tool_roles.role = 'pod_lead'
--     AND team_members.pod = 'Solimar'
--     AND team_members.is_active = true;
-- Drop the "team_members.pod = 'Solimar'" line and it's the exact query
-- security-deposit/router.js already runs today (tool-wide, no pod
-- filter) — this is additive to that pattern, not a replacement of it.
-- ============================================================

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS pod TEXT
    CHECK (pod IN ('Solimar', 'Faria'));

COMMENT ON COLUMN team_members.pod IS
  'Which pod (Solimar or Faria) this team member belongs to, for pod-filtered recipient lookups such as the pod_lead for security_deposit in Solimar specifically. NULL for anyone not on a pod. Same two values and meaning as users.pod (20260720000003_foundation.sql) -- deliberately not kept in sync with it automatically; see the KNOWN DATA-CONFLICT RISK note in this migration file before populating.';


-- ============================================================
-- CHANGE 2 — new table: shared_inboxes
-- What it stores: shared/team addresses a hub tool can notify as a
-- first-class recipient, instead of a literal string in its own code —
-- the pod team addresses (fariateam@, solimarteam@ — hardcoded in
-- insurance/router.js today) and role-style inboxes like the Director of
-- Operations address (today: the DO_EMAIL env var, read directly by
-- insurance/router.js, security-deposit/router.js, and
-- archive-search/router.js).
--
-- `key` is the stable handle a tool's code looks up by (e.g.
-- 'director_of_operations', 'faria_pod_team') — lowercase-enforced, same
-- guard already used on team_members.email, so a differently-cased
-- lookup can't silently miss. `pod` is set only for a pod-specific
-- inbox, using the exact same two values as team_members.pod above, so
-- "the shared inbox for pod X" is one filter, not a hardcoded key name
-- per pod.
--
-- Deliberately NOT scoped by `tool` — every example that exists today
-- (the pod team addresses, the DO inbox) is shared across whichever
-- tools need it, not specific to one. A tool-specific shared inbox would
-- be a one-line ADD COLUMN later if that's ever actually needed — not
-- built ahead of a real use.
--
-- No seed rows in this migration — same standing convention already
-- used everywhere this schema touches team_member_tool_roles ("no
-- seed/grant row... ships from this file — schema only"). Which
-- addresses go in, and their real values, is Peter's call, not a guess
-- made here. Two of them (the pod team addresses) are already confirmed,
-- live, literal values in insurance/router.js today; DO_EMAIL and
-- PETER_EMAIL are env-var secrets not readable from this environment —
-- their real values are Peter's to enter. Ready-to-run INSERT statements
-- for all of these are in the handoff notes, not in this file.
--
-- RLS: enabled, locked down by default — same standing pattern as every
-- other table in this schema (20260812020000's note applies here too:
-- every tool today reads/writes through its backend using the service
-- role key, which bypasses RLS, so zero policies is correct until a tool
-- needs the browser to read this table directly under a user's own
-- session).
-- ============================================================

CREATE TABLE IF NOT EXISTS shared_inboxes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT        NOT NULL UNIQUE CHECK (key = lower(key)),
  label       TEXT        NOT NULL,
  email       TEXT        NOT NULL,
  pod         TEXT        CHECK (pod IN ('Solimar', 'Faria')),  -- null = not pod-specific
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE shared_inboxes ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_shared_inboxes_updated_at ON shared_inboxes;
CREATE TRIGGER trg_shared_inboxes_updated_at
  BEFORE UPDATE ON shared_inboxes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE shared_inboxes IS
  'Shared or team email addresses a hub tool can notify as a first-class recipient -- a pod team inbox, or a role-style inbox like Director of Operations -- instead of a literal string or env var baked directly into one tool''s code. Small table by design, expected to hold a handful of rows total (two pods plus a few role inboxes), not one row per person -- a specific person is resolved through team_members instead.';

COMMENT ON COLUMN shared_inboxes.key IS
  'Stable lookup handle a tool''s code queries by, for example director_of_operations or faria_pod_team. Lowercase-enforced so a differently-cased lookup cannot silently miss.';

COMMENT ON COLUMN shared_inboxes.pod IS
  'Set only when this inbox is specific to one pod (Solimar or Faria) -- for example the pod team addresses. NULL for an inbox that applies hub-wide, like Director of Operations. Same two values as team_members.pod.';


-- ============================================================
-- MIGRATION GATE (Neo's standard checklist)
-- ============================================================
--   [x] Rollback exists — see bottom of this file.
--   [x] Does this break any existing data? No. team_members.pod is a new
--       nullable column with no default — every existing row gets NULL;
--       nothing existing is read, moved, or changed. shared_inboxes is a
--       brand-new, empty table.
--   [x] Does this touch a table other code depends on? team_members —
--       yes, but only by adding one nullable column nothing existing
--       selects, inserts, or filters on today; every existing query
--       against team_members (13 tools' worth) keeps working unchanged.
--       shared_inboxes is new — nothing depends on it yet.
--   [x] Additive or destructive? Purely additive — one nullable column,
--       one new table, neither touching a single existing row.
--   [ ] Tested on a copy of the data first? Not yet — standard practice
--       before applying to the real database, same as every migration in
--       this repo; no staging copy exists in this project. Run the KNOWN
--       DATA-CONFLICT RISK query above against a copy first if one
--       becomes available.
--   [x] users left untouched — no rename, no column change, no data
--       moved out of it; its 8 existing foreign-key dependents and 6+
--       tool-level readers are unaffected.
-- ============================================================


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
-- Safe to roll back only if no tool has started writing to
-- shared_inboxes, or reading team_members.pod, yet.
--
-- DROP TRIGGER IF EXISTS trg_shared_inboxes_updated_at ON shared_inboxes;
-- DROP TABLE IF EXISTS shared_inboxes;
--
-- ALTER TABLE team_members DROP COLUMN IF EXISTS pod;
--
-- ============================================================
