/**
 * lib/duplicate-check.js
 * Duplicate detection at complaint creation (technical spec Design
 * Decision 10, Ingestion Pipeline step 6). Runs for every non-held
 * complaint — email_ai or manual_staff alike (Neo's schema review fix 2:
 * every non-held row must reference a complaint_tracking_config version
 * because this check always runs against duplicate_window_days).
 *
 * ============================================================
 * OPEN ITEM 4 — THE "CLOSE MATCH" ALGORITHM: Q'S OWN JUDGMENT CALL
 * ============================================================
 * The technical spec names this explicitly as a real, not-yet-specified
 * choice for Q's application code (Open Item 4; the migration's own
 * comment on possible_duplicate_of_id says the same). What's implemented
 * here, and why:
 *
 *   Exact-subject-match is REQUIRED (spec's own floor, not negotiable):
 *   same property_id, same subject_type, same subject_id.
 *   PLUS: the existing complaint is still open (not 'resolved', not
 *   'held' — a held placeholder is deliberately excluded from ever being
 *   proposed as a duplicate target: it carries no content to compare
 *   against and merging into it would attach a non-privileged complaint's
 *   real content to a record this schema keeps intentionally bare), not
 *   already merged away, and was created within duplicate_window_days.
 *   PLUS: no description-similarity scoring beyond that. The most recent
 *   qualifying match is returned.
 *
 * Why stop there, deliberately, rather than add text-similarity scoring:
 * this never auto-merges — a human (the DO) always confirms or dismisses
 * (spec: "a close match never auto-merges"). A looser match than this
 * costs, at most, one extra human glance at a "suggested" badge that gets
 * dismissed; a tighter match than this risks silently missing a real
 * duplicate the whole feature exists to catch. Given that asymmetry, and
 * CLAUDE.md's own "build the simplest thing that works" instruction, exact
 * subject + a time window is the whole algorithm for v1 — a text-
 * similarity pass is a real, addressable future improvement, not a gap
 * this build is pretending doesn't exist.
 */

/**
 * @param {object} supabase
 * @param {object} params
 * @param {string|null} params.property_id
 * @param {'owner'|'tenant'|'team_member'|'property'} params.subject_type
 * @param {string} params.subject_id
 * @param {number} params.windowDays
 * @returns {Promise<{id: string, created_at: string}|null>}
 */
async function findPossibleDuplicate(supabase, { property_id, subject_type, subject_id, windowDays }) {
  // No real subject match, no duplicate check — comparing an orphan
  // ('needs_matching') complaint against other orphans by subject would be
  // comparing null to null, a meaningless match. Same "never guess" floor
  // as the rest of this schema.
  if (!subject_type || !subject_id) return null;

  const cutoffIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from('complaints')
    .select('id, created_at')
    .eq('subject_type', subject_type)
    .eq('subject_id', subject_id)
    .neq('status', 'resolved')
    .neq('status', 'held')
    .is('merged_into_id', null)
    .gte('created_at', cutoffIso)
    .order('created_at', { ascending: false })
    .limit(1);

  query = property_id ? query.eq('property_id', property_id) : query.is('property_id', null);

  const { data, error } = await query;
  if (error) throw error;
  return (data && data[0]) || null;
}

module.exports = { findPossibleDuplicate };
