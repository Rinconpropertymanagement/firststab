-- ============================================================
-- Migration: 20260812010000_rental_analysis_schema
-- Created:   2026-08-12
-- Author:    Neo (database specialist)
--
-- Establishes the 3 tables behind the Rental Analysis Tool: a shared,
-- auditable source of truth for rent-comp analyses, replacing the current
-- state where sales and operations each pull comps independently and land
-- on different numbers for the same property.
--
-- Revised same-day, before this migration was ever applied anywhere (edited
-- in place rather than layered — see revision note below for why that's
-- safe here). This revision is based on a real reference report Peter's
-- team produces manually today (1895 Dorrit St, Newbury Park) plus the
-- prompt used to generate it, which surfaced real structure the first pass
-- missed: property type on comps, year built, lease term + furnished as
-- explicit inputs, a 4-state comp lifecycle instead of active/leased,
-- price-cut history, top-line stats separate from the final recommendation,
-- and a place to keep the generated narrative text itself.
--
-- Table creation order (dependency order):
--   1. rental_comp_sources  (no dependencies — lookup table)
--   2. rental_analyses      (depends on: properties, users — both pre-existing)
--   3. rental_comps         (depends on: rental_analyses, rental_comp_sources)
--
-- Design decisions:
--
--   - property_id on rental_analyses is NULLABLE ON PURPOSE and is the
--     central design constraint of this migration. This tool is also used
--     by sales to pitch prospective owners on properties Rincon does not
--     yet manage, so an analysis can never require a row in `properties`
--     to exist. Every field needed to understand an analysis on its own
--     (subject_address, subject_bedrooms, subject_bathrooms, subject_sqft,
--     subject_property_type, subject_year_built) is captured directly on
--     the row — property_id is an optional cross-reference, set only when
--     the address happens to match a property Rincon already manages. How
--     that match is made (e.g. an address typeahead against `properties`,
--     the same UX pattern already used in insurance-compliance's property
--     search) is Q's job, not enforced here.
--
--   - property_id uses ON DELETE SET NULL, not RESTRICT. This is a
--     deliberate departure from property_insurance.property_id (RESTRICT,
--     20260720000004), which protects tightly-coupled current-state data.
--     rental_analyses rows are historical audit records that are explicitly
--     designed to stand on their own — blocking a legitimate `properties`
--     cleanup (e.g. a duplicate row from AppFolio sync) just because an old
--     analysis once matched it would be a surprising dead end for Peter.
--     SET NULL detaches the cross-reference and keeps the analysis intact.
--     rental_comps.comp_property_id (see below) uses the same reasoning.
--
--   - No hard FK exists from rental_analyses to `units`. Beds/baths/sqft
--     are captured as plain columns on the analysis itself (subject_*),
--     not resolved against a specific unit — a prospective property has no
--     unit row at all, and even for an existing property the tool is
--     comparing the property in the abstract, not one specific unit.
--
--   - subject_address and rental_comps.address are single free-text fields,
--     NOT decomposed into street/city/state/zip like `properties` is. The
--     task this table serves is entering or receiving one formatted address
--     string (typed by a team member, or returned by Zillow/RentCast) and
--     matching it against `properties` via typeahead/search — not running
--     structured mail-merge or portfolio reporting by city. Decomposing
--     would add parsing work with no current use. Can be revisited later
--     if reporting by city/market area becomes a real need.
--
--   - subject_year_built is on rental_analyses only, not on rental_comps.
--     The reference report shows a build year for the subject property but
--     not for any of its 5 comps — matches what's actually produced today.
--     Nullable: not always cleanly known for a prospective property.
--
--   - lease_term_months and furnished are NOT NULL on rental_analyses.
--     Unlike subject_bedrooms/bathrooms/sqft/property_type (facts *about*
--     the property), these are parameters *of the analysis run* — the
--     reference prompt sets them explicitly every time ("Run a rental
--     analysis for [address]. 12 Month Lease."), so they are always known
--     at the moment an analysis starts, same as the property's own basic
--     details. lease_term_months is a plain positive integer, not a fixed
--     list of common terms (6/12/24) — real lease terms vary and a rigid
--     enum would block legitimate values with no benefit. No support for
--     month-to-month yet (no evidence it's needed) — if that comes up,
--     it's an additive change, e.g. allowing NULL to mean "month-to-month."
--
--   - run_by (who ran the analysis) is NOT NULL, unlike the nullable
--     created_by/sent_by/performed_by/uploaded_by columns elsewhere in this
--     schema (null = system-initiated on those). There is no automated
--     trigger for this tool — every analysis starts with a team member
--     entering an address — so "who ran it" is always known and always
--     required, matching the spec's framing of this as required audit data.
--
--   - status exists so the UI has something to poll/render while comps are
--     being pulled from three external sources ("in minutes," per spec —
--     not instant). Mirrors workflow_instances.status in shape, but lives
--     directly on this table rather than routing through workflow_instances:
--     workflow_instances exists for system-triggered processes that attach
--     to an already-existing entity (e.g. a lease nearing expiration); here
--     the analysis IS the entity, so a plain status column matches how
--     property_insurance owns its own status directly.
--
--   - recommended_rent_low/mid/high are nullable (not known until the
--     pipeline finishes) but a CHECK constraint (chk_complete_requires_rent_range,
--     below) blocks status from ever being set to 'complete' without all
--     three populated — an analysis cannot be marked done with no output,
--     which would silently break the "auditable source of truth" premise
--     this tool exists for. The additional top-line stats added in this
--     revision (subject_estimated_rent, raw_comp_rent_low/high) are
--     deliberately NOT included in that constraint — they're supporting
--     context that may genuinely be unavailable (no Zestimate for a given
--     address) and should never block an otherwise-complete analysis.
--
--   - raw_comp_rent_low/high vs. recommended_rent_low/mid/high: the
--     reference report prints these as two distinct numbers ("Comp rent
--     range: $4,650–$5,000" vs. "RECOMMENDED ASKING RENT: $4,100–$4,600") —
--     the recommended range reflects judgment applied on top of the raw
--     comp spread (e.g. pricing below the raw range because the subject
--     "has no confirmed recent updates" relative to a remodeled comp). Two
--     separate pairs of columns preserve that distinction rather than
--     collapsing it into one range. raw_comp_rent range has no "mid" value —
--     the reference report only ever shows it as a low/high spread.
--
--   - subject_estimated_rent is named generically, not "zestimate" or
--     "subject_zillow_estimate," even though Zillow's Rent Zestimate® is
--     the only source that populates it today. Same reasoning as
--     rental_comp_sources existing as a lookup table instead of hardcoded
--     per-source columns: an automated rent estimate for the subject
--     property is a concept, not a Zillow-specific one, and RentCast also
--     offers estimate-style figures. Kept as one plain nullable number for
--     now (no source attribution column) since only one such estimate has
--     ever been evidenced in practice — adding multi-source tracking here
--     would be building ahead of a real need. Revisit if/when a second
--     concurrent estimate source is actually used.
--
--   - area_vacancy_rate (the reference report's 4th top-line stat) was
--     considered and deliberately left out of v1, not missed. Oracle
--     researched available sources: Census is ~2 years stale, HUD is a
--     rough proxy rather than true rental vacancy, the one vendor with the
--     right stat doesn't cover Ventura County, and CoStar/Yardi are
--     enterprise-only. No source is both reliable and automatable yet, and
--     a column that would sit permanently NULL isn't worth carrying. Add it
--     later, as a new migration, if a real source turns up.
--
--   - rationale (on rental_analyses) and narrative (on rental_comps) store
--     the actual generated write-up text — the "why this range" explanation
--     and each comp's blurb — as plain TEXT, not a structured breakdown.
--     Today's process is literally an AI generating this text from a
--     prompt; storing the real generated text (rather than assuming it can
--     always be regenerated identically later) is what makes the record a
--     true audit trail of what was actually said, not just the numbers
--     behind it. Kept deliberately simple, per spec. Distinct from the
--     pre-existing `notes` field on rental_analyses, which is free-text
--     commentary a staff member might add — rationale is system-generated
--     output and part of the record itself; notes is optional human
--     annotation. Both nullable: generation could fail even when the
--     underlying numbers succeed, and that shouldn't block saving them.
--
--   - rental_comp_sources is a lookup table specifically so a 4th source
--     (Blanket Homes, access unconfirmed as of this migration) can be added
--     later as a single INSERT — no schema change, no new column, no new
--     migration. is_active lets the application filter to sources currently
--     wired up without a code deploy when that changes (e.g. FlexMLS flips
--     to true the day CRMLS/Trestle access is confirmed).
--
--   - rental_comps.property_type mirrors subject_property_type's exact same
--     CHECK list (added this revision, per Peter's confirmation) so comps
--     and the subject are directly comparable on type, e.g. filtering out a
--     studio apartment as a weak comp for a house. Nullable, unlike the
--     subject's version — comps come from three external APIs that don't
--     always classify type cleanly, and a comp missing this one attribute
--     is still useful. The two CHECK lists are maintained as separate,
--     duplicated inline constraints, matching how every enum-like field in
--     this schema is done (no shared type/domain exists anywhere in this
--     codebase) — if the allowed values ever change, update both.
--
--   - rental_comps.monthly_rent stays NOT NULL even after adding the
--     off_market status: the reference report's two off-market comps still
--     carry a number (Zillow's automated estimate), just flagged as such
--     via is_estimated_price below. A comp with no price at all — real or
--     estimated — still can't inform a rent range, so there's nothing
--     useful to store.
--
--   - listing_status widens from ('active','leased') to
--     ('active','leased','off_market') — the reference report's comps
--     genuinely occupy 3 lifecycle states: currently listed, confirmed
--     leased (a real signed transaction), or neither (delisted, no known
--     recent transaction). 'off_market' is the "neither" case.
--
--   - is_estimated_price is a SEPARATE column from listing_status, not a
--     4th status value, even though in every example seen so far
--     off_market implies an estimated price and active/leased imply a real
--     one. Kept orthogonal on purpose: the report itself discloses this as
--     its own explicit fact ("*Price shown is Zillow's automated estimate,
--     not a real asking rent") distinct from the OFF MARKET label, and
--     collapsing "how sure are we this number is real" into the lifecycle
--     status would make that fact implicit and harder to query directly
--     (e.g. "give me only real-price comps") and would rule out a
--     legitimate future case: a manually-entered off_market comp where
--     Peter personally knows the real number. No CHECK constraint couples
--     the two columns, for that same reason.
--
--   - is_rincon_managed + comp_property_id are a third, independent fact —
--     not a variant of off_market either. The reference report's 5th comp
--     is off-market AND happens to be one of Rincon's own managed
--     properties, called out separately ("not outside competition...
--     internal reference only"). But a Rincon-managed property could just
--     as easily show up as an ACTIVE or JUST-LEASED comp against a
--     different property Rincon manages — there's no logical reason those
--     three facts (lifecycle status, price reliability, "is this ours")
--     always travel together, so each gets its own column. comp_property_id
--     is an optional bonus link to the actual `properties` row (nullable,
--     ON DELETE SET NULL, same reasoning as rental_analyses.property_id
--     above) so the interface can show "this comp = your unit at X"
--     directly rather than just a flag. is_rincon_managed stays independent
--     of whether that link resolves — Peter may know a comp is his own
--     property by other means even when an automatic address match fails,
--     and that fact matters for weighting/competition analysis regardless.
--
--   - original_price and had_price_cut are two separate columns, not one.
--     The reference report cites a price cut for 2 of 5 comps, but only
--     gives an exact before/after number for one of them ("$5,200 →
--     $5,000"); the other is described narratively with no clean figure
--     ("needed a price cut last year"). A single derived signal (e.g.
--     "cut happened if original_price is set") would silently lose the
--     narrative-only case. had_price_cut is the explicit, always-answerable
--     flag; original_price is the number when a source actually provides
--     one. No constraint requires them together.
--
--   - days_on_market is not restricted to active listings by a CHECK, even
--     though the reference report visually pairs it with "ACTIVE" status.
--     Days-on-market-before-transacting is cited as meaningful evidence for
--     a leased comp too (comp #1's "62 days on the market" before it
--     leased). Left as a general nullable fact populated whenever a source
--     provides it, regardless of status.
--
--   - source_id on rental_comps has no ON DELETE clause (defaults to
--     RESTRICT-like NO ACTION): a source lookup row must never be deletable
--     once real comps were pulled from it, or historical analyses would
--     lose the ability to show "which source produced this comp."
--
-- Why this migration was edited in place instead of adding a second one:
--   Neo's own standing rule is "never modify existing migrations — always
--   create new ones," but that rule exists to protect migrations that have
--   already been applied to a real database, where editing history out from
--   under a live schema would desync it. This migration has not been
--   applied anywhere — dev, staging, or production — so there is no live
--   state to protect, and editing in place avoids a confusing on-paper
--   history of "create this table, then immediately alter it" for a table
--   that was never actually live in its first form. Once this migration is
--   ever applied to any real database, this exception no longer applies —
--   all changes after that point must be new migrations.
--
-- RLS: enabled on all 3 tables, locked down by default — matching every
-- other table in this schema. No permissive policies are defined here.
-- This data is not tenant PII and contains no protected-class fields, but
-- the same rule applies anyway: nothing reads or writes these tables until
-- Q adds a policy scoped to authenticated users (or the tool reaches them
-- via the service role key from the server, bypassing RLS, the same way
-- content-review and the AppFolio sync already do).
--
-- Rollback: see the DROP section at the bottom of this file.
-- ============================================================


-- ============================================================
-- TABLE: rental_comp_sources
-- What it stores: the lookup list of places rent comps come from. Exists so
-- a new source can be added with one INSERT, never a schema change.
-- RLS: enabled, locked by default. Access policies added per-tool.
-- ============================================================

CREATE TABLE rental_comp_sources (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,           -- e.g. "FlexMLS", "Zillow", "RentCast"
  description  TEXT,                    -- nullable — access path / status notes
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,  -- whether the tool currently pulls from this source
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE rental_comp_sources ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX idx_rental_comp_sources_name ON rental_comp_sources(name);

CREATE TRIGGER trg_rental_comp_sources_updated_at
  BEFORE UPDATE ON rental_comp_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed the 3 confirmed sources. Idempotent — safe to re-run.
-- FlexMLS is seeded is_active = false: access via CRMLS/Trestle is requested
-- but not live as of this migration. Flip to true (single UPDATE, no
-- migration needed) once access is confirmed. Peter's team accesses it at
-- https://crf.flexmls.com/ (their CRMLS-hosted Flexmls portal).
-- Zillow is seeded is_active = false too, but for a different reason than
-- FlexMLS: this isn't a pending-access situation, it's confirmed dead.
-- Zillow's old public API was retired in 2021; its current replacement
-- (the Zestimates API) is a gated business product that only returns a
-- single valuation number, not comp listings — there's nothing to pull
-- comps from, and no handler was built (see projects/rental-analysis/lib/
-- sources.js). Row is kept, not deleted, in case a future Zillow product
-- changes this — same extensibility reasoning as the lookup table itself.
INSERT INTO rental_comp_sources (name, description, is_active) VALUES
  ('FlexMLS', 'Accessed via CRMLS/Trestle (California Regional MLS) at crf.flexmls.com. Access request pending as of 2026-08-12 — not yet live.', FALSE),
  ('Zillow',   'No usable API for comp data — old public API retired 2021, current Zestimates API is gated and valuation-only (single number, not listings). Kept inactive; see migration comments.', FALSE),
  ('RentCast', 'RentCast (rentcast.io).', TRUE)
ON CONFLICT (name) DO NOTHING;

-- To add the 4th source later, once Blanket Homes access is confirmed:
--   INSERT INTO rental_comp_sources (name, description, is_active)
--   VALUES ('Blanket Homes', '<fill in access details>', TRUE);


-- ============================================================
-- TABLE: rental_analyses
-- What it stores: one row per rent-comp analysis run. The subject property
-- is captured directly on this row (address, beds/baths/sqft, type, year
-- built, lease terms) so the record stands on its own — property_id is an
-- optional cross-reference to an existing Rincon-managed property, set only
-- when the address matches.
-- RLS: enabled, locked by default. Access policies added per-tool.
-- ============================================================

CREATE TABLE rental_analyses (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Subject property, entered by the team member running the analysis.
  -- Always present, regardless of whether property_id below is ever set.
  subject_address           TEXT NOT NULL,
  subject_bedrooms          INTEGER NOT NULL CHECK (subject_bedrooms >= 0),
  subject_bathrooms         NUMERIC(3,1) NOT NULL CHECK (subject_bathrooms >= 0),
  subject_sqft              INTEGER NOT NULL CHECK (subject_sqft > 0),
  subject_property_type     TEXT NOT NULL CHECK (subject_property_type IN (
                               'single_family',
                               'condo',
                               'townhouse',
                               'duplex',
                               'triplex',
                               'fourplex',
                               'apartment',
                               'manufactured',
                               'other'
                             )),
  subject_year_built        INTEGER CHECK (subject_year_built IS NULL
                               OR (subject_year_built >= 1800 AND subject_year_built <= 2100)),

  -- Parameters of this analysis run, not facts about the property — always
  -- provided up front (e.g. "12 Month Lease" in the prompt that kicks off
  -- an analysis today). See design notes above.
  lease_term_months         INTEGER NOT NULL CHECK (lease_term_months > 0),
  furnished                 BOOLEAN NOT NULL DEFAULT FALSE,

  -- Optional cross-reference to an existing Rincon-managed property. NULL is
  -- expected and normal for prospective (not-yet-managed) properties. See
  -- design notes at the top of this file for why this is SET NULL, not
  -- RESTRICT, on delete.
  property_id               UUID REFERENCES properties(id) ON DELETE SET NULL,

  -- Who ran it and when. Always a real person — see design notes above.
  run_by                    UUID NOT NULL REFERENCES users(id),

  -- Pipeline status. Comps are pulled from 3 external sources "in minutes,"
  -- not instantly, so the UI needs somewhere to reflect that.
  status                    TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'running', 'complete', 'failed')),

  -- Output: the final recommended rent range, populated once status =
  -- 'complete'. This is judgment applied on top of the raw comp spread
  -- below (e.g. priced under the raw range because the subject has no
  -- confirmed recent updates) — see design notes above.
  recommended_rent_low      NUMERIC(10,2) CHECK (recommended_rent_low >= 0),
  recommended_rent_mid      NUMERIC(10,2) CHECK (recommended_rent_mid >= 0),
  recommended_rent_high     NUMERIC(10,2) CHECK (recommended_rent_high >= 0),

  -- Output: supporting top-line stats shown alongside the recommendation,
  -- distinct from it. Neither gates status = 'complete' — both may
  -- legitimately be unavailable for a given address. See design notes
  -- above (subject_estimated_rent's source-neutral naming). No area vacancy
  -- rate column — considered and deliberately dropped, see design notes.
  subject_estimated_rent    NUMERIC(10,2) CHECK (subject_estimated_rent IS NULL OR subject_estimated_rent >= 0),
  raw_comp_rent_low         NUMERIC(10,2) CHECK (raw_comp_rent_low IS NULL OR raw_comp_rent_low >= 0),
  raw_comp_rent_high        NUMERIC(10,2) CHECK (raw_comp_rent_high IS NULL OR raw_comp_rent_high >= 0),

  -- Output: the generated "why this range" narrative, stored as actual text
  -- rather than assumed re-derivable. See design notes above.
  rationale                 TEXT,

  notes                     TEXT,   -- nullable — optional free-text staff commentary (distinct from rationale above)

  -- Reserved for future recommended-vs-actual tracking. Not populated or
  -- read by any feature as of this migration — see design notes above.
  actual_rent               NUMERIC(10,2) CHECK (actual_rent IS NULL OR actual_rent >= 0),
  actual_rent_recorded_at   TIMESTAMPTZ,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- An analysis can never be marked 'complete' without an actual rent range
  -- to show for it — protects the "auditable source of truth" premise this
  -- tool exists for.
  CONSTRAINT chk_complete_requires_rent_range CHECK (
    status <> 'complete'
    OR (recommended_rent_low IS NOT NULL
        AND recommended_rent_mid IS NOT NULL
        AND recommended_rent_high IS NOT NULL)
  )
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE rental_analyses ENABLE ROW LEVEL SECURITY;

-- "Every analysis ever run on this property" — accuracy tracking, owner
-- conversations ("why this number"), avoiding duplicate re-runs.
CREATE INDEX idx_rental_analyses_property_id ON rental_analyses(property_id)
  WHERE property_id IS NOT NULL;

-- "Every analysis run by this team member."
CREATE INDEX idx_rental_analyses_run_by ON rental_analyses(run_by);

-- "Show me analyses still running / that failed."
CREATE INDEX idx_rental_analyses_status ON rental_analyses(status);

-- Recency listing — dashboard / "recent analyses" view.
CREATE INDEX idx_rental_analyses_created_at ON rental_analyses(created_at);

CREATE TRIGGER trg_rental_analyses_updated_at
  BEFORE UPDATE ON rental_analyses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- TABLE: rental_comps
-- What it stores: one row per comparable rental pulled into a given
-- analysis. This is the detail that makes the tool auditable — anyone can
-- see exactly which comps produced a given recommendation, not just the
-- final number. Rows are a point-in-time snapshot and are not expected to
-- be edited after insert (no feature updates them today).
-- RLS: enabled, locked by default. Access policies added per-tool.
-- ============================================================

CREATE TABLE rental_comps (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  analysis_id         UUID NOT NULL REFERENCES rental_analyses(id) ON DELETE CASCADE,
  source_id           UUID NOT NULL REFERENCES rental_comp_sources(id),

  address             TEXT NOT NULL,
  -- Mirrors subject_property_type's exact list — see design notes above.
  property_type       TEXT CHECK (property_type IS NULL OR property_type IN (
                         'single_family',
                         'condo',
                         'townhouse',
                         'duplex',
                         'triplex',
                         'fourplex',
                         'apartment',
                         'manufactured',
                         'other'
                       )),
  bedrooms            INTEGER CHECK (bedrooms IS NULL OR bedrooms >= 0),
  bathrooms           NUMERIC(3,1) CHECK (bathrooms IS NULL OR bathrooms >= 0),
  sqft                INTEGER CHECK (sqft IS NULL OR sqft > 0),

  distance_miles      NUMERIC(6,2) CHECK (distance_miles IS NULL OR distance_miles >= 0),

  -- Price and how much to trust it. See design notes above for why
  -- is_estimated_price, original_price, and had_price_cut are all
  -- independent of each other and of listing_status.
  monthly_rent        NUMERIC(10,2) NOT NULL CHECK (monthly_rent >= 0),
  is_estimated_price  BOOLEAN NOT NULL DEFAULT FALSE,   -- true = algorithmic estimate (e.g. a Zestimate), not a real asking/leased price
  original_price      NUMERIC(10,2) CHECK (original_price IS NULL OR original_price >= 0),  -- nullable — price before a cut, when a source gives an exact figure
  had_price_cut       BOOLEAN NOT NULL DEFAULT FALSE,   -- explicit flag — true even when no exact original_price is known

  -- Central to the analysis: leased comps must be weighted more heavily
  -- than active (asking-price) comps. 'off_market' = delisted with no
  -- confirmed recent transaction (price, if any, will be an estimate —
  -- see is_estimated_price). If a source ever needs a 4th raw status, map
  -- it to one of these three at ingestion, or widen this CHECK later.
  listing_status      TEXT NOT NULL CHECK (listing_status IN ('active', 'leased', 'off_market')),
  days_on_market      INTEGER CHECK (days_on_market IS NULL OR days_on_market >= 0),

  listed_date         DATE,   -- nullable — when the comp went on market
  leased_date         DATE,   -- nullable — when the comp went off market / lease began

  -- Independent fact: is this comp actually one of Rincon's own managed
  -- properties (and therefore not outside competition)? See design notes
  -- above for why this is separate from listing_status and is_estimated_price.
  is_rincon_managed   BOOLEAN NOT NULL DEFAULT FALSE,
  comp_property_id    UUID REFERENCES properties(id) ON DELETE SET NULL,  -- nullable optional link to the actual property row

  -- The generated per-comp blurb, stored as actual text. See design notes above.
  narrative           TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: enabled, no permissive policies — all access denied until a tool
-- explicitly grants it via a policy scoped to authenticated users.
ALTER TABLE rental_comps ENABLE ROW LEVEL SECURITY;

-- Primary lookup: "every comp behind this analysis." Always used.
CREATE INDEX idx_rental_comps_analysis_id ON rental_comps(analysis_id);

-- "Every comp ever pulled from this source" — evaluating source reliability.
CREATE INDEX idx_rental_comps_source_id ON rental_comps(source_id);

-- Supports the active/leased/off_market weighting query.
CREATE INDEX idx_rental_comps_listing_status ON rental_comps(listing_status);

-- "Every comp appearance of this specific Rincon-managed property" —
-- mirrors idx_rental_analyses_property_id above.
CREATE INDEX idx_rental_comps_comp_property_id ON rental_comps(comp_property_id)
  WHERE comp_property_id IS NOT NULL;

CREATE TRIGGER trg_rental_comps_updated_at
  BEFORE UPDATE ON rental_comps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================
-- ROLLBACK (run these statements in order to undo this migration)
-- ============================================================
--
-- DROP TRIGGER IF EXISTS trg_rental_comps_updated_at        ON rental_comps;
-- DROP TRIGGER IF EXISTS trg_rental_analyses_updated_at     ON rental_analyses;
-- DROP TRIGGER IF EXISTS trg_rental_comp_sources_updated_at ON rental_comp_sources;
--
-- DROP INDEX IF EXISTS idx_rental_comps_comp_property_id;
-- DROP INDEX IF EXISTS idx_rental_comps_listing_status;
-- DROP INDEX IF EXISTS idx_rental_comps_source_id;
-- DROP INDEX IF EXISTS idx_rental_comps_analysis_id;
--
-- DROP INDEX IF EXISTS idx_rental_analyses_created_at;
-- DROP INDEX IF EXISTS idx_rental_analyses_status;
-- DROP INDEX IF EXISTS idx_rental_analyses_run_by;
-- DROP INDEX IF EXISTS idx_rental_analyses_property_id;
--
-- DROP INDEX IF EXISTS idx_rental_comp_sources_name;
--
-- DROP TABLE IF EXISTS rental_comps;
-- DROP TABLE IF EXISTS rental_analyses;
-- DROP TABLE IF EXISTS rental_comp_sources;
--
-- ============================================================
