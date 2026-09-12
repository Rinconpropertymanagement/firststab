/**
 * scorecard/lib/crm-completeness-config.js
 * Metric 11 — CRM data completeness, built strictly from Rincon's own
 * written SOP for the two custom contact fields (`import_type`,
 * `owner_persona`) and the one native field (`hs_lead_status`), plus the
 * SOP's one deal-side line ("After a Lead Is Finished: Set the Deal as Lost
 * or Won, Add clear notes").
 *
 * Approved by Peter 2026-09-12, built from the SOP rather than from his
 * self-reported hand-tracked number. Two Scoreboard rows, not one blended
 * score — `crm_contact_completeness` and `crm_deal_completeness` measure
 * different objects (contacts vs. deals) with different population sizes,
 * and blending them would hide which side is actually weak.
 *
 * Same shape as sales-classification-config.js and line-ownership-history.js
 * on purpose: dated, reasoned, one place to extend. This file holds only the
 * facts that are Rincon's own definitions (deprecated dropdown values, the
 * population start date) — it does NOT redeclare the prospect-lifecycle
 * stage list. That list already lives in
 * call-stats/lib/sales-classification-config.js's PROSPECT_LIFECYCLE_STAGES
 * and is imported directly wherever this metric needs it. Redeclaring it
 * here would be the fourth duplicated list today risking drift from its
 * original — see that file's own header for why a call is SALES only when a
 * human did something deliberate with the number, which is exactly the same
 * test for "is this a real contact" here.
 */

const { zonedMidnightToUtcMs } = require('../../call-stats/lib/timezone');

// ============================================================
// POPULATION START — 2026-04-01
// ============================================================
// Kristen Rau started in her current Business Development Coordinator role
// in Mar/Apr 2026. Before that, Rincon's Office Line was answered by an
// office phone tree, not her — line-ownership-history.js's Office Line entry
// independently confirms the same cutoff from raw Aircall data (365 unnamed
// calls Mar-Apr, then zero). This SOP did not exist and was not being
// followed before she took the role, so a population that reaches earlier
// would score data-entry work against a standard that did not yet apply and
// against a person who was not yet doing it.
//
// Stored as a Pacific calendar date and converted to a UTC instant the same
// way every week boundary in this codebase is (week.js's weekBoundsIso uses
// the identical zonedMidnightToUtcMs primitive) — never a fixed-offset
// guess, so this stays correct across a DST change.
const CRM_COMPLETENESS_POPULATION_START = '2026-04-01';
const CRM_COMPLETENESS_POPULATION_START_ISO = new Date(
  zonedMidnightToUtcMs(CRM_COMPLETENESS_POPULATION_START)
).toISOString();

// ============================================================
// CONTACT METRIC — deprecated values, verbatim from the SOP
// ============================================================
// Both `import_type` and `owner_persona` are "set once, never edited again"
// fields per the SOP. Their dropdowns still carry deprecated options from
// before the SOP existed; a contact carrying one of these is NOT evidence
// the field was filled in correctly under today's rule, so these values do
// not count as valid even though the field is technically non-empty.
//
// `hs_lead_status` (HubSpot native, "updated as activity occurs") carries no
// deprecated values in this portal as of 2026-09-12 — it only needs to be
// non-empty.
const IMPORT_TYPE_DEPRECATED_VALUES = [
  'high intent competitor',
  'high intent website visitor',
  'cold email reply',
];

const OWNER_PERSONA_DEPRECATED_VALUES = [
  'Accidental Move',
  'Accidental Inherited',
  'N/A',
  'Switch PM Company',
];

// ============================================================
// CHANGE LOG — every edit above gets a dated line here, same convention as
// sales-classification-config.js. A change does not rewrite history: a
// value added or removed here only affects weeks computed after the edit.
// ============================================================
// 2026-09-12  Q  Initial build. Population start and both deprecated-value
//                lists taken verbatim from Rincon's written CRM SOP,
//                confirmed live against the portal's actual dropdown options
//                the same day. Peter approved building metric 11 as two
//                separate rows rather than one blended score.

module.exports = {
  CRM_COMPLETENESS_POPULATION_START,
  CRM_COMPLETENESS_POPULATION_START_ISO,
  IMPORT_TYPE_DEPRECATED_VALUES,
  OWNER_PERSONA_DEPRECATED_VALUES,
};
