-- ============================================================
-- Migration: 20260929000000_add_complaint_tracking_to_team_member_tool_roles_check
-- Created:   2026-09-29
--
-- Catch-up fix: 20260910000000_complaint_tracking_schema.sql already
-- contained this exact ALTER TABLE (its own "SECTION D"), but live
-- testing today confirmed it was never actually applied — granting
-- tool='complaint_tracking' to a team member fails with:
--   new row for relation "team_member_tool_roles" violates check
--   constraint "team_member_tool_roles_tool_check"
-- even though the complaints/complaint_tracking_config tables from that
-- same migration DO exist live (confirmed directly). Rather than asking
-- Peter to re-run that entire 700+ line file — which also contains a
-- config-row insert that a second run could conflict with, since
-- complaint_tracking_config's one active row was already set up
-- separately (its own `notes` column says so: "Carried forward
-- unchanged from the never-applied 20260910000000_...") — this migration
-- pulls out just the one missing, safe, additive piece.
--
-- FIRST ATTEMPT AT THIS FILE WAS WRONG — worth recording why. It copied
-- 20260910000000's own "LIVE STATE CHECK" comment's claimed 10-value
-- list verbatim, trusting that comment instead of the real, current
-- constraint. Running it failed: "check constraint ... is violated by
-- some row" — Postgres correctly refused, because three tools actively
-- in use today (archive_search, scorecard, rental_analysis) were never
-- in that comment's list at all, while three tools the comment claimed
-- were live (leadsimple_application_screening, leadsimple_operations,
-- approval_briefing) turned out not to be. This is the exact failure
-- mode 20260818000000_fix_role_check_regression.sql already has a name
-- for — a DROP/ADD against a stale assumption instead of the real
-- definition — recurring here despite that file's own warning. Caught
-- before anything broke only because Peter ran this by hand and it
-- errored; fixed by having him run
-- `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname =
-- 'team_member_tool_roles_tool_check'` directly and reading back the
-- real, current 10 values, cross-checked independently against every
-- distinct tool value actually present in team_member_tool_roles today
-- (both methods agree exactly). The list below is that confirmed-live
-- list, not a reconstruction from migration-file history.
--
-- Same DROP-then-ADD pattern already used for this exact constraint 10+
-- times before. Widens the list by exactly one value, 'complaint_tracking'
-- — nothing else changes, no existing row is touched, no data loss
-- possible.
-- ============================================================

ALTER TABLE team_member_tool_roles
  DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;

ALTER TABLE team_member_tool_roles
  ADD CONSTRAINT team_member_tool_roles_tool_check
  CHECK (tool IN (
    'archive_search',
    'call_stats',
    'content_engine',
    'insurance_compliance',
    'leadsimple_delinquency',
    'maintenance_history',
    'owner_tenant_notes',
    'scorecard',
    'security_deposit',
    'rental_analysis',
    'complaint_tracking'
  ));

-- ============================================================
-- ROLLBACK (run to undo — drops 'complaint_tracking' back out of the
-- allowed list; only safe if no team_member_tool_roles row currently
-- uses tool='complaint_tracking')
-- ============================================================
--
-- ALTER TABLE team_member_tool_roles
--   DROP CONSTRAINT IF EXISTS team_member_tool_roles_tool_check;
-- ALTER TABLE team_member_tool_roles
--   ADD CONSTRAINT team_member_tool_roles_tool_check
--   CHECK (tool IN (
--     'archive_search', 'call_stats', 'content_engine',
--     'insurance_compliance', 'leadsimple_delinquency',
--     'maintenance_history', 'owner_tenant_notes', 'scorecard',
--     'security_deposit', 'rental_analysis'
--   ));
--
-- ============================================================
