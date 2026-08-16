-- ============================================================
-- Migration: 20260812020000_shared_team_members
-- Created:   2026-08-12
-- Author:    Neo (database specialist)
--
-- WHY THIS MIGRATION EXISTS
-- Rincon Management's internal tools (insurance-compliance today; more
-- will follow as they move into the shared "hub") each grew their own
-- front door — their own login page, their own idea of "who's allowed
-- in." This migration creates the one shared answer to that question:
-- a single place that says "is this person a real Rincon team member,
-- and what are they allowed to do in each tool" — so the hub (Scotty's
-- server plumbing, Tron's UI) has one thing to check instead of one
-- thing per tool.
--
-- WHAT ALREADY EXISTS — READ BEFORE CHANGING ANYTHING
--   - content-review already logs people in through Supabase Auth
--     (email + password) — see projects/content-review/lib/auth.js.
--     Its users already have a row in Supabase's own auth.users table.
--   - insurance-compliance does NOT currently use Supabase Auth. It
--     signs people in with their Google account directly (googleapis
--     OAuth, restricted to @rinconmanagement.com), then checks their
--     email against insurance_user_roles (20260803000003) to decide
--     their role. That table has no connection to Supabase Auth at
--     all today — it's a separate, email-keyed identity system, and
--     the session itself is a plain Express cookie, not a Supabase
--     Auth session.
--   In short: "reuse the identity backend that already exists" is
--   already true for content-review, but not yet true in practice for
--   insurance-compliance — its real front door today is Google OAuth +
--   an Express session. Moving insurance-compliance's login itself onto
--   Supabase Auth (e.g. via Supabase Auth's own Google provider) is an
--   application change, not a schema change — flagged in the handoff
--   report for Scotty/Q, not done in this file. This migration builds
--   the shared table that login work will write into once that happens.
--
-- WHAT THIS MIGRATION ADDS — 2 new tables, nothing existing is touched
--   1. team_members            One row per real Rincon team member,
--                               anchored to their Supabase Auth account.
--                               The "are you even allowed in the
--                               building" check.
--   2. team_member_tool_roles  One row per (person, tool) saying what
--                               they can do in that specific tool.
--                               insurance-compliance's 4 existing roles
--                               (admin, director_of_operations,
--                               property_manager, inspection_coordinator)
--                               are preserved here exactly as they are
--                               today — same names, same meaning.
--
-- WHY TWO TABLES INSTEAD OF ONE
--   A person's Rincon identity doesn't change tool to tool, but their
--   role can (admin in one tool, no access to another). Folding role
--   directly into team_members would mean a new nullable column every
--   time another tool joins the hub. A separate per-tool-role table
--   means onboarding a new tool later is just new rows, not a schema
--   change. Still a small, additive set of tables, per the brief.
--
-- WHY NOT THE EXISTING `users` TABLE (20260720000003_foundation.sql)
--   That table is a roster used by the internal workflow system (who a
--   task is assigned to, who completed it, pod membership) — it has no
--   concept of login, no connection to Supabase Auth, and is already
--   depended on by 6+ other tables (tasks, workflow_instances,
--   communications_log, audit_log, documents, property_insurance). It
--   answers "who is this person on the org chart," not "can this
--   person log into the hub." Reusing it here would mean bolting a
--   login identity onto a table many unrelated systems already depend
--   on, for a purpose it was never designed for. Kept separate on
--   purpose — called out in the handoff report as worth a second look,
--   not baked in silently.
--
-- ROLE-CHANGE HISTORY
--   insurance_user_roles today has a companion insurance_role_changes
--   table that logs every role edit. This migration does not create an
--   equivalent for team_member_tool_roles — the generic audit_log table
--   (20260720000003_foundation.sql) already exists for exactly this
--   kind of event (action='team_member.role_changed', entity_type=
--   'team_member', entity_id=team_member's id, details jsonb =
--   {tool, old_role, new_role, changed_by}). Whoever builds the hub's
--   user-management screen should write there instead of a new table.
--
-- DOMAIN RESTRICTION — DELIBERATELY NOT ENFORCED HERE
--   insurance-compliance's Google OAuth callback currently rejects any
--   email that isn't @rinconmanagement.com, in application code. That
--   restriction is NOT repeated as a database CHECK on this table —
--   it's a login-flow decision (who's allowed to sign in at all), not a
--   data-shape rule, and belongs with whoever owns the hub's login flow
--   (Scotty). Encoding it here would force a migration every time that
--   policy needs to flex (e.g. an outside bookkeeper or contractor).
--
-- RLS
--   Enabled on both tables, no permissive policies — the same "locked
--   down until a tool explicitly asks for access" default used
--   everywhere else in this schema (see 20260626000000_initial_schema
--   and 20260720000003_foundation, which both state this explicitly).
--   Every tool that touches Supabase today (content-review, insurance-
--   compliance) reads and writes through its own backend using the
--   service role key, which always bypasses RLS — so these tables work
--   correctly today with zero policies, exactly like every other core
--   table in this schema. If the hub ever needs the browser to read
--   these tables directly under a user's own session (instead of
--   through a backend), that's a new, narrowly-scoped policy added in
--   its own migration then — not a guess made here about an
--   architecture that isn't built yet.
--
-- EXISTING DATA — NOT TOUCHED
--   This migration creates two empty tables. It does not copy or move
--   any row out of insurance_user_roles. See the handoff report for
--   exactly what's in that table right now and the exact statement
--   needed to carry it forward — left as a separate, explicit step
--   rather than bundled into a schema change.
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: team_members
-- What it stores: one row per real Rincon team member allowed to log
-- into the shared hub, anchored to their Supabase Auth account
-- (auth.users — the same login system content-review already uses).
-- is_active is the master on/off switch: set to false to shut off a
-- person's access everywhere at once without deleting their history.
-- No password or any login secret is stored here — Supabase Auth owns
-- that entirely; this table only carries who they are and whether
-- they're still allowed in.
-- RLS: enabled, locked by default (see note at top of file).
-- ============================================================

CREATE TABLE IF NOT EXISTS team_members (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  UUID        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email         TEXT        NOT NULL UNIQUE CHECK (email = lower(email)),
  full_name     TEXT,                    -- nullable — not every identity provider hands us a name
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_team_members_updated_at ON team_members;
CREATE TRIGGER trg_team_members_updated_at
  BEFORE UPDATE ON team_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: team_member_tool_roles
-- What it stores: one row per (team member, tool) — what that person
-- is allowed to do in one specific tool. A person can hold a different
-- role in every tool, or no row at all for a tool they can't access.
--
-- tool='insurance_compliance' is the only value allowed today, carrying
-- forward the exact 4 roles insurance-compliance already uses via
-- insurance_user_roles (20260803000003) — same names, same meaning,
-- nothing renamed:
--   admin                    full control, including managing who has
--                             access (mirrors requireRole('admin') on
--                             /api/insurance/users in server.js)
--   director_of_operations   everything property_manager can do, plus
--                             final confirmation on non-compliant
--                             policies (escalate-confirm)
--   property_manager         review and approve/reject uploaded
--                             policies
--   inspection_coordinator   upload policies; cannot approve, reject,
--                             or manage other users' access
--
-- When a second tool joins the hub with its own roles, extend the
-- `tool` CHECK below in a NEW migration — never edit this one.
-- RLS: enabled, locked by default (see note at top of file).
-- ============================================================

CREATE TABLE IF NOT EXISTS team_member_tool_roles (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id  UUID        NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  tool            TEXT        NOT NULL CHECK (tool IN (
                     'insurance_compliance'
                   )),
  role            TEXT        NOT NULL CHECK (role IN (
                     'admin',
                     'director_of_operations',
                     'property_manager',
                     'inspection_coordinator'
                   )),
  granted_by      TEXT,                    -- email of whoever set this role; nullable — 'system' is used for seed rows, same convention as insurance_user_roles.assigned_by
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One role per person per tool — matches today's rule (insurance_user_roles
  -- has exactly one role per email, enforced by its own UNIQUE(email)).
  UNIQUE (team_member_id, tool)
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE team_member_tool_roles ENABLE ROW LEVEL SECURITY;

-- Primary lookup pattern this supports: "list everyone with a role in
-- tool X" — exactly what GET /api/insurance/users needs today.
-- (team_member_id lookups are already covered by the UNIQUE index above,
-- since it's the leading column of that composite index.)
CREATE INDEX IF NOT EXISTS idx_team_member_tool_roles_tool ON team_member_tool_roles(tool);

DROP TRIGGER IF EXISTS trg_team_member_tool_roles_updated_at ON team_member_tool_roles;
CREATE TRIGGER trg_team_member_tool_roles_updated_at
  BEFORE UPDATE ON team_member_tool_roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_team_member_tool_roles_updated_at ON team_member_tool_roles;
-- DROP TRIGGER IF EXISTS trg_team_members_updated_at           ON team_members;
--
-- DROP INDEX IF EXISTS idx_team_member_tool_roles_tool;
--
-- DROP TABLE IF EXISTS team_member_tool_roles;
-- DROP TABLE IF EXISTS team_members;
--
-- ============================================================
