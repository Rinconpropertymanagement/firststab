-- Activates the CRMLS comp source for the rental analysis tool
-- (projects/rental-analysis), now that real Recore/CRMLS API access is
-- confirmed live (see projects/rental-analysis/CRMLS-INTEGRATION-SPEC.md
-- and lib/crmls.js).
--
-- Renames the existing inactive 'FlexMLS' placeholder row rather than
-- inserting a new one: that row was always a placeholder for exactly this
-- source (see the original seed comment in
-- 20260812010000_rental_analysis_schema.sql — "Flip to true (single
-- UPDATE, no migration needed) once access is confirmed"). Renaming keeps
-- one row instead of leaving an orphaned inactive FlexMLS row sitting next
-- to a new CRMLS one — rental_comp_sources.name has a UNIQUE index, and
-- lib/sources.js's SOURCE_HANDLERS map is keyed on this exact name, so the
-- name here ('CRMLS') must match the SOURCE_HANDLERS key exactly.
--
-- Not idempotent by design (matches this table's WHERE name = ... update
-- pattern, not an INSERT ... ON CONFLICT): safe to re-run — the second run
-- simply matches zero rows, since the name is no longer 'FlexMLS' after
-- the first run.

UPDATE rental_comp_sources
SET
  name = 'CRMLS',
  description = 'CRMLS (California Regional MLS), accessed via Recore (api.marketplace.recore.net) — a licensed data platform, not a direct MLS connection. Live as of 2026-09-18. See CRMLS-INTEGRATION-SPEC.md and lib/crmls.js.',
  is_active = TRUE
WHERE name = 'FlexMLS';
