> **Applying Migration 1 now changes nothing you or staff see. No new Rental Analysis code is deployed until Jarvis confirms the check passed.**
>
> **ORDER RULES (please read):**
> 1. **Migration 1 must be applied BEFORE any new rental-tool code goes live.** If the new code went live first, every rent analysis would fail. Applying Migration 1 first is completely safe.
> 2. **Migration 2: any time except around 2 a.m. Pacific**, when the nightly AppFolio sync runs (creating the table briefly locks the `units` and `properties` tables that the sync writes).
> 3. **Apply either file when no analysis is running.** An analysis takes a few minutes; if you are not sure, ask Jarvis.

# Applying the two Rental Analysis database changes (October 2026)

Written by Neo. Nothing here has been applied. You (Peter) apply each file yourself in the Supabase SQL Editor; Neo and Jarvis cannot run SQL against your database (there is no database login in this project, only the REST service key, which can read and write rows but cannot change the structure).

This guide covers two files that Jarvis sends you:

| # | File | In two sentences | Apply when |
|---|------|------------------|------------|
| 1 | `20261018000000_rental_cma_quality.sql` | Adds 25 new empty slots to the two tables that save rent analyses (14 on the analysis, 11 on each comparable home) so the new recommended range, suggested price, stretch price, confidence label, size band and MLS details have somewhere to be saved. Also loosens one existing safety rule so a report with too few comparable homes can be saved as finished instead of failing (details below). Changes nothing you see today and deletes nothing. | **Before** any Phase B (or later) code is deployed. Applying it early is harmless. |
| 2 | `20261018010000_unit_vacancy_snapshots.sql` | Creates one new, empty table that will keep a nightly record of each vacant unit's asking rent, scheduled rent and days vacant, so that history stops being overwritten. Holds no tenant names, phones, emails or any other personal data. | Any time **except around 2 a.m. Pacific** (nightly sync). It must exist **before** the small nightly-job change that fills it is deployed. |

The two files do not depend on each other. Apply them one at a time, in one sitting if you like; each one is a separate paste and a separate Run.

---

## Migration 1: `20261018000000_rental_cma_quality.sql`

### (a) What it does
It adds 14 new columns to `rental_analyses` and 11 new columns to `rental_comps`, plus 25 safety rules (for example "a saved recommended range is always exactly $200 wide"). Every new column starts empty (or at a harmless default), so existing reports and the tool as it runs today are unaffected.

It also loosens one existing rule, on purpose. Today the database refuses to save a finished report that has no recommended-rent numbers, so an address whose nearby homes are all the wrong type or size (for example 3490 Union Pacific Avenue, a duplex, on 2026-09-21) ends as "failed" even though 14 comparable-looking homes were found and saved. After this change, a finished report may have no numbers only when the code has recorded that it counted fewer than 4 comparable homes (and therefore shows no range and no prices). The tool as it runs today never records that, so today the old strict rule still applies; the looser rule only switches on when Q's new code starts sending the count.

### (b) Steps to apply
**Step 0 (optional, recommended, about 30 seconds): look at the rule that will be replaced.** Before applying, paste this into a SQL Editor tab and run it. It only reads; it changes nothing. The answer should say, in effect, "status is not complete, OR the three recommended_rent numbers are all present", and should **not** mention `counted_comp_count`. If it reads differently, tell Jarvis before going further, because the undo steps restore exactly that original text.

```sql
SELECT pg_get_constraintdef(oid) AS rule
FROM pg_constraint
WHERE conrelid = 'public.rental_analyses'::regclass
  AND conname = 'chk_complete_requires_rent_range';
```

Then apply:

1. Open Supabase and choose the project **rincon-management**.
2. In the left menu click **SQL Editor**, then **New query**. Always use a **fresh** "New query" tab for each file; do not paste into an old tab that still has something in it.
3. Open the file Jarvis sent you (`20261018000000_rental_cma_quality.sql`) in any text editor, select everything (Cmd+A), copy (Cmd+C).
4. Paste into the empty editor. **Paste the whole file and do not select any part of it afterwards**: if any text is highlighted when you press Run, Supabase runs **only the highlighted part**. (Click once inside the editor after pasting so nothing is highlighted.)
5. Click **Run** (or Cmd+Enter).
6. **Supabase may show a yellow "destructive query" prompt.** That is expected for these exact files: they contain `DROP ... IF EXISTS` steps that replace one existing rule (and, in Migration 2, re-create a trigger on the brand-new table). Choose to run it. If the prompt ever lists a `DROP` of anything other than a rule/constraint named `chk_complete_requires_rent_range`, stop and ask Jarvis.
7. You should see **Success. No rows returned.** Nothing else will change on screen.
8. If you see a red error instead: copy the whole message and send it to Jarvis. Do not edit the file. A pasted script like this normally runs as one all-or-nothing unit, so a failure should keep none of it (Neo has not been able to confirm that on your project), and every step is written to be safe to run again.
9. Tell Jarvis "applied". Jarvis (or TARS) runs the check below before anyone deploys code. After the check passes, run the self-test at the end of this guide once (see "Self-tests").

The file is safe to run twice: a second run only prints "already exists, skipping" notices.

### (c) How to check it worked (Jarvis or TARS)
Run from the repo folder. This reads the two values it needs from `.env` with `grep`, without printing them. (Do not use `. ./.env` to load that file: two other lines in it have values with spaces, so loading it prints "command not found" errors and runs a stray word as a command.)

```bash
cd /Users/petermckenzie/CODE/firststab
export SUPABASE_URL="$(grep -E '^SUPABASE_URL=' .env | head -1 | cut -d= -f2-)"
export SUPABASE_SERVICE_ROLE_KEY="$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' .env | head -1 | cut -d= -f2-)"
get() { curl -s -w "\nHTTP %{http_code}\n" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" "$SUPABASE_URL/rest/v1/$1"; }
get "rental_comps?select=mls_flags,condition_rating&limit=1"
get "rental_comps?select=age_restricted,condition_tags,year_built&limit=1"
get "rental_analyses?select=headline_range_low,stretch_price,owner_goal,subject_age_restricted&limit=1"
```

Expected after applying:

| Request | HTTP | Body |
|---------|------|------|
| `rental_comps?select=mls_flags,condition_rating&limit=1` | 200 | `[{"mls_flags":[],"condition_rating":null}]` |
| `rental_comps?select=age_restricted,condition_tags,year_built&limit=1` | 200 | `[{"age_restricted":null,"condition_tags":[],"year_built":null}]` |
| `rental_analyses?select=headline_range_low,stretch_price,owner_goal,subject_age_restricted&limit=1` | 200 | `[{"headline_range_low":null,"stretch_price":null,"owner_goal":null,"subject_age_restricted":false}]` |

Before applying, the first request returns HTTP 400 with `"column rental_comps.mls_flags does not exist"` (checked on 2026-10-17). If it still says a column is missing right after applying, wait ten seconds and retry (Supabase refreshes its column list on its own); if it persists, run `NOTIFY pgrst, 'reload schema';` in the SQL Editor.

Also confirm nothing was lost: `rental_comps` still has 1,342 rows and `rental_analyses` 71 (plus any analyses run since 2026-10-17). And confirm nothing already saved was disturbed by the loosened rule; this should return `[]`:

```bash
get "rental_analyses?select=id&status=eq.complete&recommended_rent_low=is.null"
```

The replaced rule cannot be seen through the REST service key. Run the **same query as Step 0** again in the SQL Editor (read-only); this time the answer must contain `counted_comp_count < 4`:

```sql
SELECT pg_get_constraintdef(oid) AS rule
FROM pg_constraint
WHERE conrelid = 'public.rental_analyses'::regclass
  AND conname = 'chk_complete_requires_rent_range';
```

Its behaviour is proven by the self-test below (9 cases on this rule). The real proof comes after Q's code ships: one TARS run of 3490 Union Pacific Avenue (duplex, 700 sq ft) must end as a finished report with no range, not as "failed". That run uses one RentCast request and up to a few Anthropic calls, so TARS should do it once.

Optional read-only structure checks. **Run each of the next two blocks on its own** (paste one, Run, read the answer; then a fresh tab or cleared editor for the next one). The SQL Editor shows only the result of the last query in a run, so two together would hide the first answer. Neither changes anything.

**Check 1: new columns.** Expected: two rows, `rental_analyses` = **14** and `rental_comps` = **11**.

```sql
SELECT table_name, count(*) AS new_columns
FROM information_schema.columns
WHERE table_schema = 'public'
  AND ( (table_name = 'rental_analyses' AND column_name IN (
          'subject_condition','subject_age_restricted','subject_subdivision','size_band_pct',
          'headline_range_low','headline_range_high','suggested_list_price','stretch_price',
          'owner_goal','confidence_label','confidence_spread','counted_comp_count',
          'counted_leased_count','method_version'))
     OR (table_name = 'rental_comps' AND column_name IN (
          'mls_listing_id','year_built','subdivision_name','furnished_status','lease_term_class',
          'age_restricted','mls_condition','mls_flags','condition_rating','condition_basis',
          'condition_tags')) )
GROUP BY table_name;
```

**Check 2: new rules.** Expected: two rows, `rental_analyses` = **14** and `rental_comps` = **11**.

```sql
SELECT conrelid::regclass AS table_name, count(*) AS new_rules
FROM pg_constraint
WHERE conrelid IN ('public.rental_analyses'::regclass, 'public.rental_comps'::regclass)
  AND (conname = 'chk_headline_range'
       OR conname LIKE 'chk\_rental\_analyses\_%'
       OR conname LIKE 'chk\_rental\_comps\_%')
GROUP BY 1;
```

Optional extra look, only useful before Migration 2: this lists every current CHECK on the three tables so `units_status_check` (the allowed unit statuses) can be confirmed. It is one query on its own:

```sql
SELECT conrelid::regclass AS table_name, conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid IN ('public.rental_analyses'::regclass, 'public.rental_comps'::regclass, 'public.units'::regclass)
  AND contype = 'c'
ORDER BY 1, 2;
```

### (d) How to undo
Only if Jarvis tells you to, and only after the Phase B+ code has been rolled back (otherwise every analysis fails). This **deletes** whatever has been saved in the new columns, so use it before real reports exist in the new format or after exporting them. Run these in the SQL Editor (they are also at the bottom of the SQL file).

**Do Step 1 first and do not reorder.** The loosened safety rule reads one of the new columns, and the database silently removes any rule that uses a column you delete. If the columns were deleted first, the table would end up with no "finished reports need numbers" rule at all. So the original rule goes back first.

Step 1a (read-only): count finished reports saved without numbers.

```sql
SELECT count(*) FROM rental_analyses
WHERE status = 'complete'
  AND (recommended_rent_low IS NULL OR recommended_rent_mid IS NULL OR recommended_rent_high IS NULL);
```

Step 1b, if the count is **0**: put the original rule back.

```sql
ALTER TABLE rental_analyses
  DROP CONSTRAINT IF EXISTS chk_complete_requires_rent_range,
  ADD CONSTRAINT chk_complete_requires_rent_range CHECK (
    status <> 'complete'
    OR (recommended_rent_low IS NOT NULL
        AND recommended_rent_mid IS NOT NULL
        AND recommended_rent_high IS NOT NULL)
  );
```

Step 1b, if the count is **more than 0** (some thin reports were saved as finished): the original rule cannot be checked against those rows, and this rollback will not change or delete them. Put it back as "not validated", which protects every new row and leaves the existing thin ones alone (a later edit of one of those rows would be refused until Neo looks at it):

```sql
ALTER TABLE rental_analyses
  DROP CONSTRAINT IF EXISTS chk_complete_requires_rent_range,
  ADD CONSTRAINT chk_complete_requires_rent_range CHECK (
    status <> 'complete'
    OR (recommended_rent_low IS NOT NULL
        AND recommended_rent_mid IS NOT NULL
        AND recommended_rent_high IS NOT NULL)
  ) NOT VALID;
```

Step 2: now remove the new columns and rules.

```sql
ALTER TABLE rental_analyses DROP CONSTRAINT IF EXISTS chk_headline_range;
ALTER TABLE rental_comps    DROP CONSTRAINT IF EXISTS chk_rental_comps_rating_requires_listing_text;

ALTER TABLE rental_comps
  DROP COLUMN IF EXISTS condition_tags,
  DROP COLUMN IF EXISTS condition_basis,
  DROP COLUMN IF EXISTS condition_rating,
  DROP COLUMN IF EXISTS mls_flags,
  DROP COLUMN IF EXISTS mls_condition,
  DROP COLUMN IF EXISTS age_restricted,
  DROP COLUMN IF EXISTS lease_term_class,
  DROP COLUMN IF EXISTS furnished_status,
  DROP COLUMN IF EXISTS subdivision_name,
  DROP COLUMN IF EXISTS year_built,
  DROP COLUMN IF EXISTS mls_listing_id;

ALTER TABLE rental_analyses
  DROP COLUMN IF EXISTS method_version,
  DROP COLUMN IF EXISTS counted_leased_count,
  DROP COLUMN IF EXISTS counted_comp_count,
  DROP COLUMN IF EXISTS confidence_spread,
  DROP COLUMN IF EXISTS confidence_label,
  DROP COLUMN IF EXISTS owner_goal,
  DROP COLUMN IF EXISTS stretch_price,
  DROP COLUMN IF EXISTS suggested_list_price,
  DROP COLUMN IF EXISTS headline_range_high,
  DROP COLUMN IF EXISTS headline_range_low,
  DROP COLUMN IF EXISTS size_band_pct,
  DROP COLUMN IF EXISTS subject_subdivision,
  DROP COLUMN IF EXISTS subject_age_restricted,
  DROP COLUMN IF EXISTS subject_condition;

COMMENT ON COLUMN rental_analyses.recommended_rent_low  IS NULL;
COMMENT ON COLUMN rental_analyses.recommended_rent_mid  IS NULL;
COMMENT ON COLUMN rental_analyses.recommended_rent_high IS NULL;
COMMENT ON COLUMN rental_analyses.raw_comp_rent_low     IS NULL;
COMMENT ON COLUMN rental_analyses.raw_comp_rent_high    IS NULL;
```

The Supabase editor may show a yellow "destructive operation" warning for these; that is expected, and the reason to run them only when told to.

### (e) Risks
- **Order (the big one).** If the new code is deployed before this file is applied, every analysis fails (the first save to `rental_comps` hits an unknown column). Applying this first is safe: the current tool does not mention the new columns and keeps working unchanged.
- **Size and locking: negligible.** `rental_comps` has 1,342 rows and `rental_analyses` 71 (read on 2026-10-17). Each change takes a brief lock and finishes in milliseconds. If an analysis is mid-run at that instant it waits a moment. Best done when no analysis is running (a few minutes each; ask Jarvis if unsure).
- **The new rules are strict on purpose.** The new code must send only the allowed words: `owner_goal` is `lease_quickly`, `balanced` or `maximize_rent` (not `maximize`); `confidence_label` is lower-case `high`, `medium` or `low`; condition grades are `A+`, `A`, `B`, `C`, `D`, `F`; the flag and tag lists are closed. A word outside a list makes the whole save fail, so Q's code must filter values first (the spec already requires this).
- **One existing safety rule is made weaker (on purpose).** `chk_complete_requires_rent_range` used to guarantee every finished report has recommended-rent numbers. It now also allows a finished report with no numbers, but only if the code has written `counted_comp_count` (0 to 3) in the same save and left every headline range and price empty. A code bug that wrote a too-small count could therefore store a finished report with no numbers; it could not store a range-less report with a count of 4 or more, nor any report where the count is missing (which is everything today's code saves). The numbers that are saved today (1 to 3 counted comps still get numbers) are unaffected.
- **Q's code must change before this does anything useful.** Until the code sends `counted_comp_count` in the same save that marks the report finished, an address with zero counted comps still fails exactly as it does today (HTTP 500, report marked failed, its comps left attached). Nothing gets worse; nothing improves early.
- **The range rule is in the database.** A saved recommended range must be exactly $200 wide with round-hundred ends, the suggested price inside it, and the stretch price (if stored) exactly the range high plus $200. If you ever change those numbers, the rule changes in the same release.
- **Not tested on a copy.** There is no staging copy of your database and no local database on Neo's machine, so this has not been executed anywhere. It was checked by reading, against the live column list, and by running the rule text through a logic simulator: 58 cases on the 25 new column rules plus 15 on the loosened finished-report rule, 73 in all (the SQL file's own header still quotes the earlier figure of 58, written before the loosened rule was added). Judge, the QA reviewer, separately ran the rules' text in SQLite across 2,646 combinations with no mismatches. None of that is a run in Postgres itself, which is why the self-test below is recommended: it exercises the real installed rules without touching any real row.
- **Rolling back deletes data** in the new columns (see (d)).

---

## Migration 2: `20261018010000_unit_vacancy_snapshots.sql`

### (a) What it does
It creates one new empty table, `unit_vacancy_snapshots`, with room for one row per vacant unit per night: the date, which unit and property, the asking rent, the scheduled rent and the days vacant. It contains no tenant or lease information of any kind, and it does nothing until the nightly job change (a later Q/Scotty step) starts filling it.

### (b) Steps to apply
Same as Migration 1, steps 1 to 8: SQL Editor, a **fresh** New query tab, paste the **whole** file Jarvis sends you (`20261018010000_unit_vacancy_snapshots.sql`) with nothing highlighted, Run, and expect **Success. No rows returned.** Supabase may show the same yellow "destructive query" prompt, because the file re-creates a trigger with `DROP TRIGGER IF EXISTS` on the brand-new table; that is expected for this exact file, so choose to run it. If you see a red error, send it to Jarvis unchanged. Safe to run twice. **Do not run it around 2 a.m. Pacific** (the nightly AppFolio sync): creating the table briefly locks `units` and `properties`, which the sync writes. Any other time is fine.

### (c) How to check it worked (Jarvis or TARS)

```bash
cd /Users/petermckenzie/CODE/firststab
export SUPABASE_URL="$(grep -E '^SUPABASE_URL=' .env | head -1 | cut -d= -f2-)"
export SUPABASE_SERVICE_ROLE_KEY="$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' .env | head -1 | cut -d= -f2-)"
get() { curl -s -w "\nHTTP %{http_code}\n" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" "$SUPABASE_URL/rest/v1/$1"; }
get "unit_vacancy_snapshots?select=id,snapshot_date,unit_id,asking_rent,scheduled_rent,days_vacant&limit=1"
```

Expected after applying: `HTTP 200` and `[]` (empty, because the nightly job has not run). Before applying it returns HTTP 404 with `PGRST205 Could not find the table 'public.unit_vacancy_snapshots'` (checked on 2026-10-17). If it still says not found right after applying, wait ten seconds, or run `NOTIFY pgrst, 'reload schema';`.

Optional read-only check that row-level security is on (SQL Editor): 

```sql
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.unit_vacancy_snapshots'::regclass;  -- expect: t
```

### (d) How to undo
This deletes the table and anything in it. Stop the nightly snapshot job first (once it exists), or it will fail every night.

```sql
DROP TRIGGER IF EXISTS trg_unit_vacancy_snapshots_updated_at ON unit_vacancy_snapshots;
DROP INDEX IF EXISTS idx_unit_vacancy_snapshots_property_date;
DROP INDEX IF EXISTS idx_unit_vacancy_snapshots_snapshot_date;
DROP TABLE IF EXISTS unit_vacancy_snapshots;
```

### (e) Risks
- **Almost none at apply time.** It adds a new table; it changes no existing table, row or setting, and nothing reads it yet. The table will grow by roughly 50 rows a night (about 18,000 a year, a few megabytes), so size is not a concern.
- **Deleting a unit or property that has vacancy history will be refused by the database.** That is deliberate (history should not vanish quietly, and you asked never to delete data without asking). The AppFolio sync never deletes units or properties, so only a manual clean-up could ever hit this; Neo would then help remove the snapshots first.
- **When the nightly job is built, it must read tonight's AppFolio vacancy report, not the "vacant" flag in the `units` table.** On 2026-10-17, 77 units are flagged vacant there but only 50 were refreshed by the latest sync; the other 27 look stale and at least 2 have an active lease on file. Reading the flag would record phantom vacancies every night.
- **Days vacant may stay empty.** No code in this repo has read a days-vacant field from AppFolio yet; Q must look at one raw vacancy-report row first. The column is optional for that reason.
- **Not tested on a copy**, same caveat as Migration 1. The optional self-test below checks it on a throw-away temporary table.

---

## Self-tests

**Recommendation:** run the **Migration 1 self-test once**, right after you have applied Migration 1 **and** Jarvis has confirmed the check passed. It is the only way to see the new safety rules actually working, because Neo could not run the SQL in Postgres. The **Migration 2 self-test is optional and can be skipped**: it checks only the table's own rules (one row per unit per night, no negative numbers, the upsert, the default date). It cannot check the links to `units` and `properties` or the `updated_at` trigger, because the temporary copy does not carry those.

These make **no permanent change and touch no real row**. Each builds a throw-away temporary copy of the table (rules included), tries good and bad values, and then stops on purpose with an error whose text lists the results.

**What a correct ending looks like:** a **red error** whose text includes `SELF-TEST FINISHED` and `Failures: 0` (Supabase may put something like `ERROR: P0001` in front of it). That red error is the normal, correct ending; it is how the test cleans up after itself, so nothing is kept. Below it is a list where every line should start with `PASS`. If the text says anything other than `Failures: 0`, or any line starts with `FAIL`, copy the whole text to Jarvis and do not change anything. A typo in the test itself is possible; the message names the line.

### Self-test for Migration 1 (recommended; run once after applying it and after the check passes)

```sql
DO $test$
DECLARE
  tc       RECORD;
  ok       BOOLEAN;
  n_fail   INTEGER := 0;
  report   TEXT := '';
  stmt     TEXT;
BEGIN
  -- Throw-away copies that carry the REAL installed rules. Dropped automatically.
  CREATE TEMP TABLE t_analyses (LIKE rental_analyses INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP;
  CREATE TEMP TABLE t_comps    (LIKE rental_comps    INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP;

  FOR tc IN
    SELECT * FROM (VALUES
      -- tbl, test name, should it be accepted?, columns, values
      ('a', 'row with nothing new filled in',            true,  'method_version',                                                          'NULL'),
      ('a', 'range 4200-4400, list 4350, stretch 4600',  true,  'headline_range_low, headline_range_high, suggested_list_price, stretch_price', '4200, 4400, 4350, 4600'),
      ('a', 'same, stretch left empty',                  true,  'headline_range_low, headline_range_high, suggested_list_price, stretch_price', '4200, 4400, 4350, NULL'),
      ('a', 'range 300 wide',                            false, 'headline_range_low, headline_range_high, suggested_list_price, stretch_price', '4200, 4500, 4350, 4700'),
      ('a', 'list price outside the range',              false, 'headline_range_low, headline_range_high, suggested_list_price, stretch_price', '4200, 4400, 4500, 4600'),
      ('a', 'stretch is not range high + 200',           false, 'headline_range_low, headline_range_high, suggested_list_price, stretch_price', '4200, 4400, 4350, 4650'),
      ('a', 'range ends not round hundreds',             false, 'headline_range_low, headline_range_high, suggested_list_price, stretch_price', '4250, 4450, 4350, 4650'),
      ('a', 'only the low end filled in',                false, 'headline_range_low',                                                      '4200'),
      ('a', 'owner_goal maximize_rent',                  true,  'owner_goal',                                                              $v$'maximize_rent'$v$),
      ('a', 'owner_goal maximize (wrong word)',          false, 'owner_goal',                                                              $v$'maximize'$v$),
      ('a', 'confidence_label medium',                   true,  'confidence_label',                                                        $v$'medium'$v$),
      ('a', 'confidence_label High (capital H)',         false, 'confidence_label',                                                        $v$'High'$v$),
      ('a', 'subject_condition A+',                      true,  'subject_condition',                                                       $v$'A+'$v$),
      ('a', 'subject_condition E',                       false, 'subject_condition',                                                       $v$'E'$v$),
      ('a', 'size_band_pct 25',                          true,  'size_band_pct',                                                           '25'),
      ('a', 'size_band_pct 0',                           false, 'size_band_pct',                                                           '0'),
      -- The loosened chk_complete_requires_rent_range (finished reports with too few comps):
      ('a', 'finished, all three numbers present',            true,  'status, recommended_rent_low, recommended_rent_mid, recommended_rent_high', $v$'complete', 4000, 4200, 4400$v$),
      ('a', 'finished, no numbers, count NOT recorded',       false, 'status',                                                                  $v$'complete'$v$),
      ('a', 'finished, no numbers, counted 0 comps',          true,  'status, counted_comp_count',                                              $v$'complete', 0$v$),
      ('a', 'finished, no numbers, counted 3 comps',          true,  'status, counted_comp_count',                                              $v$'complete', 3$v$),
      ('a', 'finished, no numbers, counted 4 comps',          false, 'status, counted_comp_count',                                              $v$'complete', 4$v$),
      ('a', 'finished, no numbers, counted 2, range saved',   false, 'status, counted_comp_count, headline_range_low, headline_range_high, suggested_list_price, stretch_price', $v$'complete', 2, 4200, 4400, 4350, 4600$v$),
      ('a', 'finished, numbers present, counted 2',           true,  'status, counted_comp_count, recommended_rent_low, recommended_rent_mid, recommended_rent_high', $v$'complete', 2, 4000, 4200, 4400$v$),
      ('a', 'finished, only mid+high numbers, counted 2',     false, 'status, counted_comp_count, recommended_rent_mid, recommended_rent_high', $v$'complete', 2, 4200, 4400$v$),
      ('a', 'failed report with no numbers',                  true,  'status',                                                                  $v$'failed'$v$),
      ('c', 'comp with nothing new filled in',           true,  'mls_listing_id',                                                          'NULL'),
      ('c', 'flags hoa + private_pool',                  true,  'mls_flags',                                                               $v$ARRAY['hoa','private_pool']::text[]$v$),
      ('c', 'flags include an unknown word',             false, 'mls_flags',                                                               $v$ARRAY['hoa','bogus']::text[]$v$),
      ('c', 'rating A with basis listing_text',          true,  'condition_rating, condition_basis',                                       $v$'A', 'listing_text'$v$),
      ('c', 'rating A with NO basis',                    false, 'condition_rating, condition_basis',                                       $v$'A', NULL$v$),
      ('c', 'rating A with basis unclear',               false, 'condition_rating, condition_basis',                                       $v$'A', 'unclear'$v$),
      ('c', 'basis unclear, no rating',                  true,  'condition_basis',                                                         $v$'unclear'$v$),
      ('c', 'furnished_status furnished',                true,  'furnished_status',                                                        $v$'furnished'$v$),
      ('c', 'furnished_status Furnished (capital F)',    false, 'furnished_status',                                                        $v$'Furnished'$v$),
      ('c', 'unknown condition tag',                     false, 'condition_tags',                                                          $v$ARRAY['luxurious']::text[]$v$),
      ('c', 'year_built 1799',                           false, 'year_built',                                                              '1799'),
      ('c', 'year_built 2026',                           true,  'year_built',                                                              '2026')
    ) AS v(tbl, test_name, should_pass, cols, vals)
  LOOP
    IF tc.tbl = 'a' THEN
      stmt := format($f$INSERT INTO t_analyses (subject_address, subject_bedrooms, subject_bathrooms, subject_sqft,
                         subject_property_type, lease_term_months, run_by, %s)
                       VALUES ('1 Test St', 3, 2, 1500, 'single_family', 12, gen_random_uuid(), %s)$f$, tc.cols, tc.vals);
    ELSE
      stmt := format($f$INSERT INTO t_comps (analysis_id, source_id, address, monthly_rent, listing_status, %s)
                       VALUES (gen_random_uuid(), gen_random_uuid(), '2 Test St', 3000, 'leased', %s)$f$, tc.cols, tc.vals);
    END IF;

    BEGIN
      EXECUTE stmt;
      ok := tc.should_pass;        -- it was accepted: good only if acceptance was expected
    EXCEPTION WHEN check_violation THEN
      ok := NOT tc.should_pass;    -- it was rejected by a rule: good only if rejection was expected
    END;

    IF NOT ok THEN n_fail := n_fail + 1; END IF;
    report := report || CASE WHEN ok THEN 'PASS  ' ELSE 'FAIL  ' END || tc.test_name || E'\n';
  END LOOP;

  -- Always stop with an error so everything above is rolled back.
  RAISE EXCEPTION E'SELF-TEST FINISHED - nothing was saved (this error is how the test cleans up). Failures: %\n%', n_fail, report;
END
$test$;
```

Expected: the red error text includes `SELF-TEST FINISHED` and `Failures: 0`, followed by 37 lines starting `PASS` (28 on the new columns and rules, 9 on the loosened finished-report rule).

### Self-test for Migration 2 (optional; safe to skip)

```sql
DO $test$
DECLARE
  tc      RECORD;
  ok      BOOLEAN;
  n_fail  INTEGER := 0;
  report  TEXT := '';
  v_unit  UUID := gen_random_uuid();
  v_unit2 UUID := gen_random_uuid();
  v_cnt   INTEGER;
  v_rent  NUMERIC;
  v_date  DATE;
BEGIN
  CREATE TEMP TABLE t_snap (LIKE unit_vacancy_snapshots INCLUDING ALL) ON COMMIT DROP;

  -- Two good rows, then a duplicate of the first (same unit, same night).
  INSERT INTO t_snap (unit_id, snapshot_date, asking_rent) VALUES (v_unit, DATE '2026-10-17', 3000);
  INSERT INTO t_snap (unit_id, snapshot_date, asking_rent) VALUES (v_unit, DATE '2026-10-18', 3000);

  FOR tc IN
    SELECT * FROM (VALUES
      ('same unit, same night twice',        false, format('INSERT INTO t_snap (unit_id, snapshot_date) VALUES (%L, DATE ''2026-10-17'')', v_unit)),
      ('same unit, a different night',       true,  format('INSERT INTO t_snap (unit_id, snapshot_date) VALUES (%L, DATE ''2026-10-19'')', v_unit)),
      ('negative asking rent',               false, format('INSERT INTO t_snap (unit_id, asking_rent) VALUES (%L, -1)', gen_random_uuid())),
      ('negative scheduled rent',            false, format('INSERT INTO t_snap (unit_id, scheduled_rent) VALUES (%L, -1)', gen_random_uuid())),
      ('negative days vacant',               false, format('INSERT INTO t_snap (unit_id, days_vacant) VALUES (%L, -1)', gen_random_uuid())),
      ('unit_status not in the list',        false, format('INSERT INTO t_snap (unit_id, unit_status) VALUES (%L, ''for rent'')', gen_random_uuid())),
      ('rents and days all empty',           true,  format('INSERT INTO t_snap (unit_id) VALUES (%L)', gen_random_uuid()))
    ) AS v(test_name, should_pass, stmt)
  LOOP
    BEGIN
      EXECUTE tc.stmt;
      ok := tc.should_pass;
    EXCEPTION WHEN check_violation OR unique_violation THEN
      ok := NOT tc.should_pass;
    END;
    IF NOT ok THEN n_fail := n_fail + 1; END IF;
    report := report || CASE WHEN ok THEN 'PASS  ' ELSE 'FAIL  ' END || tc.test_name || E'\n';
  END LOOP;

  -- Re-running the nightly job: the upsert must update the night's row, not add a second one.
  INSERT INTO t_snap (unit_id, snapshot_date, asking_rent) VALUES (v_unit, DATE '2026-10-17', 3100)
    ON CONFLICT (unit_id, snapshot_date) DO UPDATE SET asking_rent = EXCLUDED.asking_rent;
  SELECT count(*), max(asking_rent) INTO v_cnt, v_rent
    FROM t_snap WHERE unit_id = v_unit AND snapshot_date = DATE '2026-10-17';
  ok := (v_cnt = 1 AND v_rent = 3100);
  IF NOT ok THEN n_fail := n_fail + 1; END IF;
  report := report || CASE WHEN ok THEN 'PASS  ' ELSE 'FAIL  ' END || 'same-night re-run updates in place (1 row, rent 3100)' || E'\n';

  -- snapshot_date left out = today in Pacific time.
  INSERT INTO t_snap (unit_id) VALUES (v_unit2);
  SELECT snapshot_date INTO v_date FROM t_snap WHERE unit_id = v_unit2;
  ok := (v_date = (NOW() AT TIME ZONE 'America/Los_Angeles')::DATE);
  IF NOT ok THEN n_fail := n_fail + 1; END IF;
  report := report || CASE WHEN ok THEN 'PASS  ' ELSE 'FAIL  ' END || 'snapshot_date defaults to today in Pacific time' || E'\n';

  RAISE EXCEPTION E'SELF-TEST FINISHED - nothing was saved (this error is how the test cleans up). Failures: %\n%', n_fail, report;
END
$test$;
```

Expected: the red error text includes `SELF-TEST FINISHED` and `Failures: 0`, followed by 9 lines starting `PASS`.

Note: the temporary copy has no links to the real `units` and `properties` tables (the test cannot check those links); the links are plain `REFERENCES ... ON DELETE RESTRICT` in the file.

---

# Notes for the engineer who wires the code later (Q, Scotty)

This appendix is for developers. Peter does not need to read it or do anything with it. It lists the traps in these two migrations that a reviewer (Judge) found or confirmed. All of them make an insert or save fail, or quietly store the wrong thing, if missed.

**(a) Arrays and the NOT NULL columns on `rental_comps`.**
`mls_flags` and `condition_tags` are `NOT NULL DEFAULT '{}'`, but PostgREST does **not** use the database default for a key that is missing from *some* rows of a bulk insert: it uses the union of all keys in the request and fills the gaps with NULL. `NOT NULL` then rejects the whole insert. The default only applies when **no** row in the request has that key. Because the comps from RentCast, CRMLS and LeadSimple are inserted together in one bulk `insert('rental_comps', compRows)`, **every comp row from every source must send `mls_flags: []` and `condition_tags: []` explicitly** (a shared row-mapper such as the spec's `lib/comp-rows.js` is the natural place). Alternative worth checking: send `Prefer: missing=default` on that insert so missing keys take the default; verify that it is supported by this project's PostgREST before relying on it. Same family: **never send `subject_age_restricted` as `null`** (it is `NOT NULL DEFAULT FALSE`); send `true`/`false`, or omit the key on a single-row insert.

**(b) `counted_comp_count` and `counted_leased_count` go in the same update that sets `status = 'complete'`.**
`chk_complete_requires_rent_range` is evaluated on that one update. With `counted_comp_count` missing or NULL the strict old rule applies: all three `recommended_rent_*` numbers are required, so a report with zero counted comps (all `recommended.*` null) still fails with HTTP 500 and is marked failed. Count = number of comps whose `exclusionReasons[i]` is `null`.

**(c) The headline fields.**
- `owner_goal` must be exactly `lease_quickly`, `balanced` or `maximize_rent` (not `maximize`).
- A range needs `headline_range_low`, `headline_range_high` and `suggested_list_price` all set. It is **exactly $200 wide** (`high - low = 200`), both ends multiples of 100, the suggested price a multiple of 50 inside the range. `stretch_price` is optional (NULL is allowed, for example on Low-confidence reports) but, when sent, must be exactly `headline_range_high + 200`.
- With **fewer than 4 counted comps, send NULL for all four** (`headline_range_low`, `headline_range_high`, `suggested_list_price`, `stretch_price`), or omit them; the loosened rule also requires that when `recommended_rent_*` are NULL.
- Do not send a stretch price (or any one of the four) on its own: partial fills are rejected.

**(d) Filter values to the closed lists before inserting.**
A value outside a list fails the whole save, and one bad comp fails the whole bulk insert. Allowed values:

| Column | Allowed |
|--------|---------|
| `mls_flags` (array) | furnished, partly_furnished, short_term, age_restricted, hoa, private_pool, utilities_included, water_trash_included, gardener_included, new_construction, adu_or_guest_house, view_property |
| `condition_tags` (array) | remodeled, new_build, stone_counters, new_flooring, new_cabinets, updated_kitchen, updated_baths, cosmetic_updates, original_finishes, needs_repair |
| `furnished_status` | furnished, unfurnished, partial, either (or NULL) |
| `lease_term_class` | long, short, six_month (or NULL) |
| `condition_rating` / `subject_condition` | A+, A, B, C, D, F (or NULL) |
| `condition_basis` | listing_text, unclear, not_available (or NULL); a `condition_rating` is allowed **only** with basis `listing_text` |
| `confidence_label` | high, medium, low (lower case) |
| `owner_goal` | lease_quickly, balanced, maximize_rent |
| Lengths | `mls_listing_id` and `method_version` at most 40 characters; `mls_condition` at most 80; `subdivision_name` and `subject_subdivision` at most 120. `year_built` 1800-2100. `size_band_pct` 1-100. Counts and `confidence_spread` at least 0. |

**(e) The nightly vacancy-snapshot job (`unit_vacancy_snapshots`).**
- Iterate the rows of **tonight's AppFolio `unit_vacancy` report**, not `units WHERE status = 'vacant'`. On 2026-10-17, 27 of the 77 units flagged vacant in `units` were not refreshed by the latest sync and look stale (at least 2 have an active lease on file); snapshotting the flag would record phantom vacancies every night.
- **De-duplicate `unit_id` within a batch before the upsert.** If one `INSERT ... ON CONFLICT DO UPDATE` request carries the same `(unit_id, snapshot_date)` twice, Postgres rejects the **whole batch** ("cannot affect row a second time"), and a lost night cannot be recreated afterwards.
- Send every column on every row (explicit null, not a missing key), omit `snapshot_date` so the database stamps the Pacific date, upsert with `?on_conflict=unit_id,snapshot_date` and `Prefer: resolution=merge-duplicates`, skip and log report rows whose unit is not in `units`, and log "N snapshot rows written".
- `days_vacant`: unverified which AppFolio field carries it; look at one raw `unit_vacancy` row first. Leave NULL if none.

**(f) The `4` in `counted_comp_count < 4` is hard-coded in the SQL.**
It mirrors `HEADLINE_MIN_COMPS` in the code. Raising the code constant later (for example to 5) is not covered by the database rule as written; if the code ever stores no `recommended_rent_*` for a report with a count at or above 4, the CHECK rejects it. Changing the threshold means a new migration that replaces `chk_complete_requires_rent_range` again (same one-statement DROP + ADD), deployed together with the code.

**(g) The spec's A.7 still says about 77 rows a night.**
Use about 50 (about 18,000 rows a year). Update the spec text when convenient.

**(h) Not changed by these migrations.**
If `runActiveSources` returns zero comps at all, the handlers still exit early with status `failed` (HTTP 500) and save nothing. Whether that case should also end as a finished "no comparable homes" report is an open product decision; the loosened CHECK would accept it (`counted_comp_count = 0`).
