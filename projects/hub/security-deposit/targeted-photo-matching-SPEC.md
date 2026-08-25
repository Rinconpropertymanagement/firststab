# Targeted Photo Matching — Security Deposit Build Spec Addendum

**Status:** Approved — governance-cleared by Asimov and Mason. Ready for Neo to confirm the schema and Q to build.
**Written by:** Oracle
**Date:** 2026-08-20
**Governance history:** Cleared by Asimov (7 conditions, all written into this spec below) and Mason (1 condition — pure retrieval only, no evaluative output — also below). Nothing in this feature was built before this clearance; this is the spec those reviews were conditioned on.

**Built from:**
- `projects/hub/security-deposit/SPEC.md` — the v1 build spec this addendum extends. Same tool, same login, same conventions. Read in full before writing this.
- `projects/hub/security-deposit/router.js`, `lib/folder-parser.js`, `lib/b2-client.js`, `dashboard/index.html` — the live code this feature plugs into.
- `supabase/migrations/20260813000003_b2_photo_folders.sql` — the existing folder-matching confidence-threshold table (`b2_match_confidence_config`), which this addendum's confidence gate reuses the exact pattern of.
- `projects/hub/maintenance-history/property-overview-SPEC.md` — the precedent in this codebase for how a follow-on feature to an already-built tool gets its own addendum file rather than being folded into the original spec.

**Where this lives:** Inside `projects/hub/security-deposit/` — new routes on the existing router, a new tab of UI on the existing dashboard, one new library file, two new database tables. Not a new tool, not a new login, not a new project folder.

**Scope note, worth stating up front:** this addendum specs two related but distinct pieces. The first, and the one that carries the governance conditions below, is AI photo matching: a coordinator manually picks a move-out photo, the system finds its move-in counterpart, a pod lead sees both. The second, added after Peter's review of the first draft, is general photo browsing: both the full move-in folder and the full move-out folder, freely scrollable on the case screen from the moment it opens, with click-to-enlarge — no AI involved, no judgment made, just serving photos a pod lead is already authorized to see. It does **not** spec, and must not be read as scoping, an AI reviewing every photo in a case unprompted and flagging which ones look different. That is a separate, larger feature, blocked pending outside legal counsel's Fair Housing review (disability-accommodation disparate-impact concerns), and is out of scope here — deferred, pending separate legal review, nothing more said about it in this document.

---

## What This Does

Today, this tool already finds the right move-in and move-out photo *folders* for a case — matched by property, unit, and date, using AI that only ever reads the folder's name, never opens a photo. This addendum adds three things on top of that. First: once a case's folders are matched, both the full move-in folder and the full move-out folder are right there on the case screen, freely scrollable, click-to-enlarge, from the moment the case opens — "at their fingertips," Peter's words, so a pod lead never has to leave the tool to dig through Backblaze directly. Second, layered on top of that same view: the inspection coordinator can pick out one or more move-out photos that might show damage, and the tool finds the move-in photo of that same spot so the pod lead can compare before-and-after side by side, instead of having to search the move-in folder by hand for the matching shot. Third: because the folder names this whole system matches against were typed by hand and are often inconsistent (the base tool's own spec says so directly), sometimes the automatic match misses or gets it wrong — so anyone looking at the case can type an address right there on the case screen and search for the right folder directly, instead of the only fallback being a separate admin screen. Only the matching piece involves AI, and it's the first time this tool asks an AI to actually look at a photo rather than just a filename — so it comes with tighter rules than anything built so far: the AI's only job is to find the matching photo and say how confident it is. It never describes what's in either photo, and it never says anything about damage — that judgment stays entirely with the pod lead, exactly like every other decision this tool has never made for anyone. Browsing and the address search are both AI-free — one shows photos a pod lead is already authorized to see, faster; the other is a plain text-matching search over data this tool already indexes.

## How It Works

1. **Starting point: a case already has matched move-in and move-out folders**, exactly as the base tool builds today (`findBestPhotoMatch` in `router.js`). Everything below only activates once both folders exist and are confirmed (not sitting in the low-confidence manual-review queue).
2. **The moment the case screen opens, both folders are already browsable.** No button to click first, nothing gated behind a selection — a pod lead (or coordinator) can scroll the full move-in gallery and the full move-out gallery side by side right away, and click any photo to see it full-size. This loads progressively, not all at once (see "What Could Go Wrong" and the Tron/Q sections below) — a folder with hundreds of photos still feels immediate, not like a wait.
3. **The move-out photo-matching picker sits on top of this same view, not apart from it.** The coordinator browsing the move-out gallery clicks on one or more photos that look like they might show damage — the same click that opens a photo full-size doubles as (or sits alongside) the "find its move-in match" action, so there's no separate mode to switch into.
4. **For each photo picked for matching, the system fetches that photo's actual image bytes from Backblaze B2** (the byte-fetching this addendum introduces is shared by both the browsing view and the matching feature — see the Q section below) **and sends them, along with the move-in folder's photos, to Claude with one narrow instruction: find the move-in photo of the same room or area, and say how confident you are. Nothing else.** The AI is not allowed to describe either photo, note anything about its condition, or say whether anything looks different — its entire output is limited to "this one" and a confidence number.
5. **If the AI is confident enough** (checked against a stored, adjustable confidence number — never a number buried in code, see Neo section below), **the matched move-in photo is highlighted**, side by side with the move-out photo that was picked.
6. **If the AI isn't confident enough**, the pair is shown to the pod lead as "not confidently matched, confirm or correct it yourself" instead of being silently presented as if it were certain — the same idea already used for the folder-level matches today. Either way, the full move-in gallery is still right there to browse and pick from by hand.
7. **If the move-in gallery is empty, or clearly the wrong one, that's exactly when the address search earns its keep.** Right there on the case screen — not a separate admin page — anyone viewing the case can type the property's address and get back a ranked list of candidate B2 folders, scored the same way the automatic matcher already scores candidates, just without the automatic matcher's stricter cutoff. A pod lead or admin can pick the right one from that list and confirm it on the spot; the case then finds it automatically on every future load, exactly like an automatically-matched folder does.
8. **Nothing about what's actually in either photo is ever stored or logged** — only which photo matched which, how confident the AI was, which model did it, and when. The photos themselves stay exactly where they already live, in Backblaze B2; nothing in this addendum, browsing, matching, or address search, ever copies or saves a copy of them anywhere else.

## What You'll See

- **On an already-open case, both full photo galleries — move-in and move-out — right there, scrollable, from the moment the case loads.** Not gated behind a click, not a summary or a folder icon standing in for the real thing: the actual photos, as thumbnails, in a grid, for both folders side by side.
- **Click any thumbnail, in either gallery, to see it full-size** — a simple enlarge/lightbox view, close it to go back to browsing. Works the same way for both galleries.
- **Scrolling feels immediate even on a folder with hundreds of photos** — more photos load in as you scroll rather than the whole folder loading (or stalling) up front. No spinner-then-wait for the whole gallery before anything shows.
- **The move-out gallery doubles as the matching picker.** A coordinator can select one or more move-out photos as possible-damage candidates right from the same grid they're already browsing — no separate screen, no separate mode.
- Selecting a move-out photo for matching shows a short "finding the match…" loading state, then either:
  - **The matched move-in photo, highlighted, side by side with the move-out photo** — with the AI's confidence percentage visible next to it (not hidden), the same way the folder-level match confidence is already shown today.
  - **"No confident match found — a pod lead should confirm or correct this manually,"** with the move-in gallery already right there to pick the correct photo from by hand.
- Nothing on this screen ever shows a caption, a description, or any comment about what either photo depicts — just the images, the file names, and (for a matched pair) the confidence score.
- A pod lead can confirm a low-confidence match (accept it as correct) or correct it (pick the actual move-in photo), the same "human resolves what the AI wasn't sure about" pattern already used for the folder-level matches on the Photo Match Review tab.
- **A "Search by address" box on both galleries, always available — not just when something's already gone wrong.** It's most obviously useful, and shown most prominently, right where a gallery is empty or a match came back low-confidence: instead of just "no move-in photos found," there's a way to type an address and go find them. But it's not hidden the rest of the time either — anyone browsing either gallery can use it if they'd simply rather search than scroll.
- Typing an address shows a ranked list of candidate B2 folders as you type — folder path, its parsed address/unit/date, and a status badge (the same `Auto-matched` / `Needs Review` / `Confirmed` / `Corrected` badges already used on the Photo Match Review tab), best match first.
- A pod lead or admin can pick a result and confirm it as this case's move-in (or move-out) folder with one click — the case immediately shows that folder's photos from then on, the same as if the automatic matcher had found it in the first place. An inspection coordinator can search and see the same ranked list, but the confirm action itself is a pod-lead/admin step, same separation of duties as the rest of this addendum.

## What Could Go Wrong

- **A folder can hold a lot of photos — this affects both the AI matching call and plain browsing, in different ways.** For matching, sending too many photos to Claude in one request may hit size or count limits, or simply get slow and expensive — Q needs to design for a bounded candidate batch per match call (see Q section). For browsing, loading a folder with hundreds of full-resolution photos naively (all at once, full size) would directly contradict Peter's "no waiting" requirement — Q needs paginated, lazy-loaded gallery loading (see Tron/Q sections), not a folder dump. Both are real constraints to design for during the build, not edge cases to discover in production.
- **A wrongly "confident" match is worse than an honest "not sure."** The same risk the folder-matching feature already carries — an AI that's wrong but sounds sure is more dangerous than one that says "not sure, ask a human." The confidence threshold (Neo section below) is the only thing standing between "shown automatically" and "a pod lead double-checks it," so it needs the same seriousness as the existing folder-matching threshold: versioned, adjustable, never silently changed.
- **This only works as well as the base folder-matching feature it depends on.** If the move-out or move-in folder wasn't matched correctly in the first place (a real, acknowledged limitation of the base tool — see its own "What Could Go Wrong"), this feature inherits that error. It doesn't introduce a new failure mode here so much as build on top of an existing, already-flagged one. **The address search below is the direct mitigation for exactly this risk** — instead of a wrong or missing automatic match being a dead end on the case screen, there's now an in-context way to fix it. (This risk and its mitigation both apply to the matching feature specifically — general browsing has no dependency on the match being correct, since it just shows both folders as-is.)
- **A hasty search-and-confirm can point a case at the wrong folder just as easily as it can fix a wrong one.** Confirming a search result corrects that folder's stored address/unit/date to this case's own — a real, deliberate action, not a guess the system makes on its own. This is the same "a human can be wrong" risk the existing manual-review queue already carries today, not a new category of risk this addendum introduces — worth a pod lead double-checking the folder's actual photos (right there in the same gallery) before confirming, same as they'd sanity-check anything else this tool surfaces rather than decides.

## Known Limitation — Extending the Existing CCPA Note

The base tool's spec already discloses that a CCPA deletion request can't reach the actual photos in Backblaze B2 — only this tool's own index of them (folder names, parsed fields) can be deleted or anonymized. **This feature adds one more thing to that same disclosed gap, not a new one:** the match records this feature creates (which move-out photo paired with which move-in photo, confidence score, who selected it, who confirmed it) live in Supabase, in this tool's own database, and *are* covered by the same deletion/export handling as everything else this tool stores — but like everything else in this tool, deleting a match record does not and cannot delete the underlying photos in B2. Nothing new is left undisclosed; this is the same limitation, explicitly extended to cover the new table.

## What Q Needs to Build This

- **A new, narrowly-scoped read from Backblaze B2 — downloading actual photo bytes, not just listing file names.** Today's B2 credential (`B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY`) was set up read-only, scoped to one bucket, for *listing* files only. Downloading a file's actual bytes is a different B2 capability (`readFiles`, not just `listFiles`) — **Scotty needs to confirm whether the existing key already has `readFiles`, and if not, add it to the existing key (not issue a broader one)** — still fully read-only, still scoped to the one bucket, just one capability wider than it needed to be for v1. Flagged explicitly for Sentinel's review at PR time, same as the original B2 credential was (see Governance Path below). **This one capability covers both the AI matching call and general photo browsing below — browsing needs no additional B2 capability of its own** (see Q section for why the browsing photo-viewer reuses the same byte-download function rather than a separate signed-URL mechanism).
- **One new library file** for the matching AI call (`lib/photo-matcher.js`, mirroring `lib/folder-parser.js`'s shape and its "data, not instructions" delimiter discipline) — see the Q section below for its exact output contract.
- **Two new functions in `lib/b2-client.js`:** one to list the individual photo files inside an already-matched folder, *paginated* (today's client only knows whether a folder *has* files, not what they're named, and browsing hundreds of photos can't fetch the whole list at once — see below), and one to download a single file's bytes. Both new, neither modifies the existing `listPhotoFolders` function.
- **General photo browsing — the full move-in and move-out galleries, freely scrollable on the case screen, with click-to-enlarge, added at Peter's direction after review of the matching feature above.** This is UX/infrastructure, not a new AI or compliance surface — no AI involvement, nothing new stored — but it reuses the same B2 read path and needs to be built with real pagination/lazy-loading given folders can run into the hundreds of photos. See the Tron and Q sections below for the concrete performance approach.
- **An in-context address search over the already-indexed B2 folders, added at Peter's direction, reusing the exact scoring logic `findBestPhotoMatch` already uses rather than a new matching system.** Available on both galleries (move-in and move-out — see the Q section below for why this should be symmetric even though Peter's ask was framed around finding move-in/"before" photos). No AI involvement, no new table — see the Q section for the route and why confirming a result reuses the existing photo-review-queue resolve endpoint unchanged.
- **Neo's schema** (below) — one new table for the photo-level match records, and (recommended, Neo's call) a second small table mirroring `b2_match_confidence_config`'s exact shape for this feature's own confidence threshold. **No schema is needed for general browsing** — it's a pure read-through to B2, nothing persisted.
- **Dedicated audit log entries for every AI photo match, every coordinator selection, and every pod-lead confirmation/correction** — same discipline as the rest of this tool, exact fields below.
- **`inspection_coordinator` wired into this tool specifically.** The role value already exists at the database level (see Neo section below) and is already used by two other Hub tools — nothing to migrate. What's missing is local to this tool: add it to `router.js`'s `VALID_ROLES` and to the new photo-selection routes' permission checks, add it to the Users-tab role dropdown, and keep it explicitly out of every existing pod-lead-only route (approval actions stay pod-lead/admin only — see the separation-of-duties note in the Q section below).

---

## Technical Appendix — For Neo, Scotty, Q, Tron, TARS

*(Peter — you don't need to read past this line. Everything below is implementation detail for the people building it.)*

### Neo — schema changes needed

Table and column names below are illustrative, not mandates — Neo makes the final call on shape, same as every other schema section in the base spec.

**1. Photo match records (new)**

One row per move-out photo the coordinator selected and the system attempted to match — e.g. `security_deposit_photo_matches`:
- `case_id` — `NOT NULL REFERENCES security_deposit_cases(id) ON DELETE CASCADE`
- `move_out_photo_path` — the B2 file path of the photo the coordinator selected (`NOT NULL`)
- `move_in_photo_path` — the B2 file path of the matched move-in photo, nullable (null means no confident match was found)
- `confidence_score` — `NUMERIC(4,3)`, same shape as `b2_photo_folders.confidence_score`
- `confidence_config_id` — references whichever confidence-config row's threshold decided auto-show vs. needs-confirmation for this match (see item 2 below) — same "every decision references the version in effect" discipline `b2_photo_folders.confidence_config_id` already follows
- `model_version` — text, same pattern as `b2_photo_folders.model_version`
- `match_status` — e.g. `CHECK IN ('auto_shown', 'needs_confirmation', 'manually_confirmed', 'manually_corrected', 'no_match_found')`, mirroring `b2_photo_folders.review_status`'s existing four-state shape plus one more state for "the AI found nothing at all"
- `selected_by`, `selected_at` — who (email) picked the move-out photo and when
- `resolved_by`, `resolved_at` — set only when a pod lead confirms or corrects a `needs_confirmation` row, same pattern as `b2_photo_folders.resolved_by`/`resolved_at`
- `created_at`, `updated_at` (with the same `set_updated_at` trigger already used throughout this schema)

**What this table deliberately does not contain, per Asimov's hard requirement (condition 1 below):** no caption, no description, no free-text field of any kind about what either photo shows. Only file paths, a number, a model name, and who/when. This isn't just a convention to follow when writing code against this table — the table itself should have no column that a caption could even go into, the same defense-in-depth `b2_photo_folders` already applies by having no such column either.

**2. Photo-match confidence config (new, recommended as its own table — Neo's call)**

Recommend a table with the identical shape and discipline as `b2_match_confidence_config` (`supabase/migrations/20260813000003_b2_photo_folders.sql`) — versioned, one active row at a time via a partial unique index, `set_by`/`set_at`/`notes`, never update an existing row's threshold, always insert a new version. E.g. `photo_match_confidence_config`: `id`, `version`, `auto_show_threshold NUMERIC(4,3) CHECK (BETWEEN 0 AND 1)`, `is_active`, `set_by`, `set_at`, `notes`, `created_at`, `updated_at`.

**Why a second table rather than a second column on the existing one:** the existing `b2_match_confidence_config.auto_index_threshold` governs a different decision (does an AI *folder-name* parse get auto-indexed or routed to manual review) from this feature's decision (does an AI *photo content* match get shown automatically or routed to a pod lead to confirm). They're conceptually distinct judgment calls that could reasonably need to move independently of each other — folding them into one table risks someone changing one threshold and not realizing it also touched the other. This is a recommendation, not a decision — flagged as an Open Item below for Neo to confirm, same as every other schema call in this codebase's specs.

Seed with a placeholder threshold, flagged as unconfirmed in its own `notes` column, exactly the way `b2_match_confidence_config`'s version-1 row already does — Peter should confirm or adjust the number before it governs a real case, same open item the folder-matching threshold already carries.

**3. Data inventory and RLS (Asimov, GOVERNANCE.md Rule 4)**

`security_deposit_photo_matches` stores personal data (photo paths tied to a specific tenancy, and who selected/resolved each match) — needs the same header-comment data inventory (`pii_fields`, `agents_with_access`, `privacy_category`, `retention_policy`, `ccpa_exportable`, `ccpa_deletable`) that `b2_photo_folders`' own migration already documents, using that migration as the template. `photo_match_confidence_config` is a config table of threshold numbers, not personal data — same treatment `b2_match_confidence_config` already got (Rule 4's inventory doesn't apply to it). Both tables need `ENABLE ROW LEVEL SECURITY` with no permissive policies, same as every table in this schema.

**4. General photo browsing needs no schema at all.** Confirmed explicitly since it's easy to assume otherwise given everything else in this addendum: browsing the full move-in/move-out galleries is a pure pass-through read from B2, nothing is persisted, so there's no fifth table or column to design here. Nothing for Neo to build for this part.

**4a. The address search also needs no new schema.** It searches the existing `b2_photo_folders` table (already there, already indexed by the base tool), and confirming a result reuses the existing `resolve` mechanism that already writes to that same table's existing columns (`parsed_address`, `parsed_unit`, `parsed_date`, `parsed_inspection_type`, `review_status`, `resolved_by`, `resolved_at`). Nothing new for Neo here either.

**5. Granting the role — a data task, not a migration.** No new migration is needed to make `inspection_coordinator` usable for this tool — the value is already legal in the shared `role` CHECK. What's still needed is an actual `team_member_tool_roles` row: `tool='security_deposit'`, `role='inspection_coordinator'`, granted to whoever at Rincon actually holds that job. That's a data/admin action for Peter to take (via the tool's own Users tab, once Q adds the option there — see Tron section below), not something Neo builds.

### Scotty

- Confirm whether the existing B2 application key already has the `readFiles` capability. If not, add it to the existing key rather than issuing a second one — this feature still only ever needs read access, on the same single bucket, just one capability wider than v1 needed.
- No new environment variables — this feature reuses `B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME` exactly as they exist today.

### Q — build instructions

**`lib/b2-client.js` — two new functions, neither touching the existing ones:**
```
listFilesInFolder(folderPath, { startFileName, maxFileCount })
                                 // returns { files: [{ fileName, filePath }, ...], nextFileName }
                                 // for the actual photo files directly inside a given B2
                                 // folder — not the folder-level listing listPhotoFolders()
                                 // already does. IMPORTANT: unlike listOneLevel() (which
                                 // internally drains every page in a do/while loop before
                                 // returning, because the indexing job wants everything),
                                 // this returns ONE page at a time and hands the caller
                                 // B2's own nextFileName cursor to ask for more. Draining
                                 // it all up front is exactly what general photo browsing
                                 // (below) must NOT do — a folder with hundreds of photos
                                 // would make the case screen wait on the whole folder's
                                 // file list before showing anything. The AI-matching call
                                 // (which does want a bounded batch, not literally
                                 // everything) asks for one or two pages, not the whole
                                 // folder either — see "Candidate set, bounded" below.
downloadFileBytes(filePath)     // fetches one file's actual bytes via B2's
                                 // b2_download_file_by_name, returns a Buffer +
                                 // content-type. Two callers, same function: (1) the AI
                                 // matching call, which sends the bytes to Claude and
                                 // discards them; (2) the new photo-file route below,
                                 // which streams the bytes straight through to the
                                 // browser as the response and discards them server-side
                                 // — neither caller writes them to disk or to Supabase
                                 // storage.
```
Both call B2's native REST API the same way `listOneLevel`/`authorize` already do — no new dependency, no new auth flow. Reusing `downloadFileBytes` for browsing (rather than adding a second B2 mechanism, like a shared/signed download URL, which would need its own separate `shareFiles` capability on the B2 key) is a deliberate choice — it keeps this addendum's entire B2 footprint to the one already-flagged `readFiles` capability, nothing wider, satisfying condition 6 below for both use cases with one credential change instead of two.

**`lib/photo-matcher.js` (new file) — the matching AI call.** Mirrors `lib/folder-parser.js`'s shape and its delimiter/"data not instructions" discipline, but sends image content blocks instead of a text string. The system prompt must state, explicitly and prominently — this is Mason's one condition for clearing this feature (condition 7 below) and Asimov's hard output restriction (condition 1 below), and both need to be load-bearing in the actual prompt text, not just this spec:

> Your only task is to find which one of the candidate move-in photos shows the same room or area as the move-out photo. You are doing pure retrieval — finding a match — never evaluation. You must never describe what is in any photo, never comment on its condition, never say whether anything looks different, damaged, or changed between the two photos, and never generate any text beyond which photo matches and how confident you are. If no candidate photo is a plausible match, say so — do not guess.

**Output contract — enforced by the same "no field to put it in" defense-in-depth already used for `security_deposit_photo_matches`' table shape:**
```json
{ "matched_index": 2, "confidence": 0.91 }
```
(or `matched_index: null` / `confidence: 0.0` for "no plausible match found") — an index into the array of candidate move-in photos sent in the request, resolved by Q's code back to a file path before storage. No `description`, `caption`, `notes`, or free-text field anywhere in the schema — there is deliberately nowhere for the model to put one even if the system prompt were somehow ignored.

**Candidate set, bounded (addresses the "a folder can hold a lot of photos" risk above):** send the move-out photo plus a bounded batch of move-in candidates from the matched move-in folder (Q's call on the exact number, sized to stay well within Claude's per-request image-count and payload-size limits) rather than an entire folder unconditionally. If a move-in folder is larger than one batch can hold, Q's call on whether to batch across multiple calls (keeping only the single highest-confidence result across batches) or cap at the first batch with a "large folder — match limited to first N photos" note surfaced to the pod lead. This needs a real decision during the build, not a hand-wave — flagged again in Open Items.

**Routes — plugs into the existing case-detail assembly in `router.js`, doesn't modify it. Roles noted explicitly below because this is where the separation-of-duties boundary (see below) actually gets enforced:**

**Revision note:** the first draft of this addendum speced a single-purpose `GET .../move-out-photos` route. Generalized below into one `GET .../photos` route with a `folder` parameter, covering both galleries — this fits the codebase's existing convention better than two near-duplicate routes (the base tool already treats move-in/move-out as a parameter, not a fork in the code, e.g. `inspection-form`'s `kind` body field and the `photos: { move_in, move_out }` shape `GET /cases/:id` already returns).
```
GET   /api/security-deposit/cases/:id/photos                 admin, pod_lead, inspection_coordinator
      ?folder=move_in|move_out&cursor=&limit=                 ONE page of individual photo
                                                                files in the case's matched
                                                                move_in or move_out folder
                                                                (uses listFilesInFolder).
                                                                `cursor` is B2's own
                                                                nextFileName token, passed
                                                                straight through — this
                                                                route never loads a whole
                                                                folder's file list in one
                                                                call. Powers BOTH general
                                                                browsing (both folder
                                                                values) and the move-out
                                                                matching picker (folder=
                                                                move_out only) — one route,
                                                                not two UIs each with their
                                                                own listing logic.
GET   /api/security-deposit/cases/:id/photo-file              admin, pod_lead, inspection_coordinator
      ?path=<b2 file path>                                     Streams one photo's actual
                                                                bytes (via downloadFileBytes)
                                                                for both thumbnail display
                                                                and the click-to-enlarge
                                                                full view — same endpoint,
                                                                same bytes, no separate
                                                                "thumbnail" backend (B2
                                                                doesn't store a resized
                                                                copy — see the performance
                                                                note below). HARD
                                                                REQUIREMENT: before serving
                                                                anything, verify `path`
                                                                actually falls under this
                                                                case's own matched
                                                                move_in_photos or
                                                                move_out_photos folder path
                                                                — never trust the query
                                                                param as-is. Without this
                                                                check, an authenticated user
                                                                could swap in an arbitrary
                                                                B2 path and read a different
                                                                tenant's photos through this
                                                                case's own login gate. Flag
                                                                this check for Viper/
                                                                Sentinel review explicitly
                                                                (see Governance Path below).
                                                                Response includes real
                                                                caching headers (ETag/
                                                                Cache-Control from B2's own
                                                                file metadata) so a browser
                                                                that's already loaded a
                                                                photo doesn't re-fetch it on
                                                                scroll-back — this is part
                                                                of what makes "no waiting"
                                                                actually hold at scale, not
                                                                an optional nicety.
POST  /api/security-deposit/cases/:id/photo-matches           admin, pod_lead, inspection_coordinator
                                                                body: { move_out_photo_path }
                                                                runs the byte-fetch + AI
                                                                match, stores the result,
                                                                returns it — THIS is the
                                                                photo-selection/submission
                                                                endpoint the coordinator
                                                                actually uses
GET   /api/security-deposit/cases/:id/photo-matches           admin, pod_lead, inspection_coordinator
                                                                lists already-computed
                                                                matches for this case, so
                                                                re-opening a case doesn't
                                                                re-spend an AI call
POST  /api/security-deposit/photo-matches/:id/resolve         admin, pod_lead ONLY —
                                                                pod lead confirms or
                                                                corrects a needs_confirmation
                                                                match — same shape as the
                                                                existing
                                                                photo-review-queue/:id/resolve.
                                                                inspection_coordinator does
                                                                NOT get this route — see
                                                                separation of duties below.
```
None of these routes change `GET /api/security-deposit/cases/:id`'s existing response shape — this feature is additive UI/data on the same case screen, reached by its own endpoints, not a rewrite of the existing photo-matching assembly.

**Separation of duties — `inspection_coordinator` submits and browses, it doesn't decide.** This mirrors how `inspection_coordinator` already works in `insurance_compliance` on this exact codebase (`supabase/migrations/20260812020000_shared_team_members.sql`'s own description of that tool's role: "upload policies; cannot approve, reject, or manage other users' access"). Applied here the same way:
- **Can reach:** every route above marked `inspection_coordinator` — browsing both photo galleries (`photos`, both `folder` values), viewing a photo full-size (`photo-file`, both folders), submitting a move-out photo as a match candidate, and viewing match results. All read/submit actions, nothing approval-shaped.
- **Cannot reach:** `POST .../photo-matches/:id/resolve` (the approval-type action this feature adds) or any of the base tool's existing pod-lead-only routes — `checklist`, `review`, `prepaid-rent`, `escalate`, `escalate-confirm`, `inspection-form`. None of those change. Do not broaden any of them to include `inspection_coordinator` — only the browsing and photo-submission paths get the added role.
- **Why the coordinator gets move-in browsing too, not just move-out:** they're the one physically doing the inspection and picking candidates — being able to glance at the move-in gallery themselves before submitting a photo is normal part of that job, not a step toward approving anything. It's still read-only, still exactly the same photos a pod lead already sees, and grants no new power over the case record itself. See Open Items below if Peter wants this narrower.

**Also required — updating this tool's existing code, not just adding new routes:** `router.js`'s `VALID_ROLES` constant (currently `['admin', 'pod_lead', 'director_of_operations']`, used by the admin user-management endpoints — `POST/PATCH /api/security-deposit/users`) needs `'inspection_coordinator'` added, or an admin has no way to actually grant the role through this tool's own Users tab even though the database already allows it. One-line change to an existing constant — easy to miss since nothing else in this addendum touches that part of the file.

**Address search — reuses `findBestPhotoMatch`'s own scoring, and its existing resolve endpoint, rather than inventing a parallel matching or confirmation system.**

The problem this solves: `findBestPhotoMatch` already scores every indexed B2 folder against a case's known property address using `normalizeAddress`/`addressWordScore`, but only ever surfaces its single best guess, and only above a 0.6 hard cutoff — anything below that, or any case where the automatic guess was simply wrong, has no in-context recovery today; the only fallback is the separate admin Photo Match Review tab. This addendum's address search is a second, deliberately different way of calling the *same* scoring primitives against the *same* data, built for a human to browse ranked results rather than to silently auto-pick one.

```
GET   /api/security-deposit/cases/:id/photo-folder-search    admin, pod_lead, inspection_coordinator
      ?q=<free-text address>&inspection_type=move_in|move_out
                                                                Returns the top N candidate
                                                                B2 folders (Q's call on N,
                                                                e.g. 15), ranked by
                                                                addressWordScore(normalize
                                                                Address(q), normalizeAddress
                                                                (folder.parsed_address)) —
                                                                the exact same two functions
                                                                findBestPhotoMatch already
                                                                uses, just scoring against
                                                                the user's typed text
                                                                instead of the property's
                                                                own recorded address.
                                                                Filtered by
                                                                parsed_inspection_type
                                                                matching the requested
                                                                folder type (or 'other'),
                                                                same rule findBestPhotoMatch
                                                                already applies. Unlike
                                                                findBestPhotoMatch, this
                                                                does NOT apply the 0.6
                                                                cutoff and does NOT exclude
                                                                needs_review folders — the
                                                                entire point is to surface
                                                                candidates the automatic
                                                                matcher rejected or never
                                                                found, for a human to look
                                                                at and judge. Each result
                                                                includes its review_status
                                                                so the UI can badge it
                                                                accordingly (see Tron
                                                                section).
```

**Candidate pool and performance:** load the same portfolio-wide candidate set `GET /api/security-deposit/cases/:id` already loads for automatic matching (the paginated `fetchAllRows` query over `b2_photo_folders` filtered to `.not('parsed_address', 'is', null)`) — worth factoring into one small shared helper both call, rather than duplicating the query, but that's Q's call on exact shape. Score entirely in JS on that already-proven-safe (pagination-bug-fixed) result set, no new SQL filtering needed — at Rincon's actual portfolio scale (150-500 units, and the base spec's own B2 discovery notes suggest folder counts in the same rough order of magnitude, not millions), this is no more expensive than what the case-detail page already does on every open, and keeps the same address-scoring logic in exactly one place rather than a second, SQL-approximated version that could disagree with it on edge cases (e.g. word order) for the sake of an optimization this tool doesn't need yet. Require a minimum query length before actually calling the endpoint (Q's call, e.g. 3 characters) and debounce on the client (see Tron) so this isn't fired on every keystroke — that's the real performance lever here, not a database-level prefilter.

**Search is portfolio-wide by necessity, not by choice, and this is symmetric for both move-in and move-out — a deliberate design call, not an oversight of Peter's specific ask.** Two reasons: first, there's no such thing as "this property's own folders" until a folder's address has actually been matched — the automatic matcher itself already searches the whole indexed portfolio for every case, so a search assist scoped to "just this property" would be circular (it would only ever find what the automatic matcher already tried and rejected). Second, the base tool's own spec describes the hand-typed-folder-name noise problem as a property of the B2 archive as a whole, not something specific to move-in folders — nothing about it is move-out-proof. Peter's framing was about finding move-in ("before") photos specifically, but the identical dead end (a wrong or missing automatic match, only fixable from a separate admin screen) exists for move-out folders too, and this addendum already builds both galleries symmetrically for the same reason. Building the search box on only one gallery would be an arbitrary asymmetry with no grounding in the actual problem, so both galleries get it, using the same route with `inspection_type` as the only difference — no separate code path.

**Confirming a result reuses the existing `POST /api/security-deposit/photo-review-queue/:id/resolve` route, completely unchanged — no new confirm/write endpoint.** When a pod lead or admin picks a search result, the case screen calls that existing route (already built by the base tool, already role-gated to `admin`/`pod_lead`) with `confirmed: false` and the corrected fields set to *this case's own known property address/unit and the relevant date* (move-in date for a move_in search, move-out date for a move_out search) — values the case screen already has, not anything retyped by the user. This is deliberate: writing the case's actual canonical address (not the raw text the user searched with, which might be an abbreviation or a typo) guarantees `findBestPhotoMatch`'s own `addressWordScore` will find this folder automatically on the case's next load, the same way any other automatically-matched folder is found — no new "this folder belongs to this case" concept needs to exist anywhere. The existing route's own audit-log entry (`security_deposit.photo_match_resolved`, `entity_type: 'b2_photo_folder'`) already covers this action exactly as it covers every other manual resolution — nothing new to log. The search itself (typing, seeing ranked results) is read-only and not logged, consistent with this tool's existing practice of not logging reads.

**Role gating mirrors the rest of this addendum exactly:** searching (`GET .../photo-folder-search`) is available to `admin`, `pod_lead`, and `inspection_coordinator` — read-only, no decision made. Confirming a result is NOT a new permission to add anywhere — it's the existing `photo-review-queue/:id/resolve` route, already `admin`/`pod_lead` only, unchanged. A coordinator can search and see exactly what a pod lead would see, but the "confirm this as the match" action simply isn't exposed to them, same separation-of-duties boundary already established for the rest of this addendum.

**Audit logging (Asimov, condition 2 below) — every AI photo match gets its own `audit_log` entry, same discipline as the existing `security_deposit.b2_folder_parsed` entries:**
```
action: 'security_deposit.photo_matched'
details: {
  move_out_photo_path,
  move_in_photo_path,     // null if no match found
  confidence_score,
  model_version,
  case_id,
}
```
Plus entries for the coordinator's selection (`security_deposit.photo_match_selected`) and the pod lead's confirm/correct action on a `security_deposit_photo_matches` row (`security_deposit.case_photo_match_resolved`). **Naming correction from this addendum's own earlier draft:** that action was originally written as `security_deposit.photo_match_resolved` — the same string the existing folder-level review queue already uses for a different table (`b2_photo_folders`, see the search feature below, which reuses that existing route and its existing action name unchanged). Renamed here to keep the two conceptually different resolutions distinguishable by action name, not just by `entity_type`. None of these detail payloads ever contain a description of photo content — same restriction as the table itself.

### Tron

**General photo browsing — build this first; the matching picker layers on top of it, per Peter's direction:**
- On the case screen, wherever the matched move-in/move-out folders show today, replace the folder-only display with two real, scrollable photo grids — move-in and move-out, side by side (or stacked on narrow screens, matching the existing `.two-col` responsive breakpoint) — populated from the new `GET .../photos?folder=` route. Both galleries are visible and browsable the instant the case screen finishes loading — no button to click first, no gating.
- **Performance requirement, not an afterthought (Peter's explicit "no waiting"):** load photos progressively, not all at once.
  - Fetch the file *list* in pages using the route's `cursor`/`limit` — request the first page, request the next page as the user scrolls near the bottom (infinite scroll) or via an explicit "Load more" control (Tron's call on which feels better; either satisfies the requirement, a full unpaginated fetch does not).
  - For the images themselves, use the browser's native `loading="lazy"` on each `<img>` so a photo's actual bytes (via `GET .../photo-file`) aren't requested until it's about to scroll into view — this matters as much as list pagination does, since the file list alone is cheap but the image bytes behind hundreds of thumbnails are not.
  - Rely on the `photo-file` route's caching headers (see Q section) so scrolling back up doesn't re-fetch a photo the browser already has.
  - **Not required for v1, flagged rather than built:** true server-generated thumbnails (small resized copies instead of serving original photo bytes at grid size). Pagination + lazy-loading should make browsing feel immediate without it; if real folder/file sizes prove otherwise once this is live, that's the next lever — see Open Items.
- **Click-to-enlarge:** clicking any thumbnail in either gallery opens it full-size (a simple lightbox/overlay — close to return to the grid). Same behavior in both galleries, no separate code path for move-in vs. move-out.
- **The move-out gallery is also the matching picker — one view, not two.** Add the "find this photo's move-in match" action directly onto each move-out thumbnail (e.g. a small button on hover/tap, or a mode toggle within the same grid) rather than building a separate picker screen the coordinator has to switch into. Clicking a thumbnail to enlarge it and choosing to submit it for matching should both be reachable from the same grid.

**AI-matching result display (unchanged from the first draft, now sitting inside the browsing view instead of standing alone):**
- Selecting a photo for matching shows a loading state, then the side-by-side result — reuse the existing `.two-col` / `.evidence-card` layout already built for the folder-level move-in/move-out display, don't invent a new visual pattern for what is conceptually the same "two photos side by side" idea.
- The confidence score must be visibly shown next to the matched pair, not just used internally to decide auto-show vs. confirm — the same requirement the base spec already places on the folder-level match (extend it here, don't relitigate it).
- A `needs_confirmation` or `no_match_found` result reuses the existing badge language/colors already built for `needs_review` / `manually_confirmed` / `manually_corrected` on the Photo Match Review tab, rather than inventing new badge states. Either way, the move-in gallery built above is already right there for browsing/picking by hand.
- **Nothing on this screen may ever render a caption, description, or any generated text about either photo's content** — this is a hard UI constraint mirroring the hard output-contract constraint on the AI itself (condition 1 and 7 below). The matched pair shows two images, two file names, and a number. Nothing else about the photos is ever generated or displayed. (General browsing already has no such content to begin with — it shows the photo and its file name, nothing generated.)

**Address search — on both galleries, most prominent exactly where it's most needed:**
- A "Search by address" input on both the move-in and move-out galleries — always available, not hidden behind another click.
- **Surface it most prominently in the states this is built to fix:** an empty gallery (no move-in or move-out folder matched at all) and a `needs_confirmation`/`no_match_found` result should show the search box front and center, not just "no photos found" with nothing else to do. It's still available the rest of the time too, just less insistent about it.
- Debounce keystrokes before calling `GET .../photo-folder-search` (Tron's call on exact timing, e.g. 300ms after typing stops) and respect the minimum-query-length Q sets — don't fire a request on every single keystroke.
- Results render as a simple ranked list/cards — folder path, parsed address/unit/date, and a status badge reusing the exact same `Auto-matched` / `Needs Review` / `Confirmed` / `Corrected` visual language already built for the Photo Match Review tab (don't invent new badge colors for what's the same four states).
- **The "confirm this as the match" action on a search result is gated by `canReview()` (admin/pod_lead only), not `canSelectPhotos()`.** This is the one place in this addendum's UI where the distinction between the two helpers (see below) actually matters visibly: an `inspection_coordinator` can type an address and see the exact same ranked results a pod lead sees, but the button that actually confirms one is simply not rendered for them — consistent with confirming being the existing pod-lead-only `photo-review-queue/:id/resolve` route underneath (see Q section).
- Confirming a result should give clear, immediate feedback (the matched gallery updates right away, no need to reload the case) — reuse whatever loading/success pattern the rest of this addendum's actions already use, don't invent a new one just for this.

**Roles and permissions:**
- **A new, separate visibility check — do not fold this into `canReview()`.** `dashboard/index.html`'s existing `canReview()` helper (`['admin', 'pod_lead'].includes(currentUser.role)`) gates the approval-type controls — checklist toggles, Mark Reviewed, Escalate, the Prepaid Rent save button. Adding `inspection_coordinator` to that function would hand the role every one of those approval actions, which is exactly the separation of duties the Q section above exists to prevent. Instead, add a distinct helper (e.g. `canSelectPhotos()`, `['admin', 'pod_lead', 'inspection_coordinator'].includes(currentUser.role)`) that gates both photo galleries (browsing and matching-picker), the submit action, and the address search box/results list. The `.../resolve`-backed confirm/correct controls — both the `needs_confirmation` match control and the new search-result "confirm this as the match" control — stay behind `canReview()` unchanged.
- **The Users tab's role dropdown** (`<select id="newUserRole">`, currently Pod Lead / Director of Operations / Admin) needs an `Inspection Coordinator` option added, and `formatRole()`'s role→label map needs the same entry — otherwise an admin has no way to actually grant the role from this tool's own UI even after Q adds it to `VALID_ROLES`.
- **Help tab:** add a short "Inspection Coordinator" role section (mirroring the existing Pod Lead / Director of Operations / Admin sections) covering what this role does here — browsing both galleries and selecting move-out photos for matching. It does not get a "resolving escalations" or "marking reviewed" section, since it can't do either.

### TARS

- Confirm the AI's output, end to end, never contains anything beyond a matched-photo reference and a confidence number — feed it a batch of real (or realistic test) photos and inspect the raw model response, not just what the UI renders, to make sure there's no description leaking through into a field the UI just happens not to display.
- Confirm a large move-out or move-in folder (well beyond whatever batch size Q lands on) doesn't error out or silently drop photos without the "large folder" note (if that's the path Q chooses) actually appearing.
- Confirm the B2 byte-download function never writes a file to disk or to Supabase storage anywhere in the code path — bytes fetched, sent to Claude, discarded.
- Confirm the confidence threshold is read from `photo_match_confidence_config` (or wherever Neo lands it) at call time, never hardcoded — same test discipline already applied to the folder-matching threshold.
- **Confirm the separation-of-duties boundary actually holds, not just in the route list on paper.** With a real (or test) `inspection_coordinator`-role account: confirm it can reach `photos`, `photo-file`, and `photo-matches` (GET and POST), and confirm it gets a 403 on `photo-matches/:id/resolve` and on every existing pod-lead-only route — `checklist`, `review`, `prepaid-rent`, `escalate`, `escalate-confirm`, `inspection-form`. This is the one place a copy-paste mistake in `requireSecurityDepositRole(...)` would silently hand a submission-only role approval power.
- **Confirm `GET .../photo-file` actually rejects a path outside the requesting case's own matched folders** — try a `path` value pointing at a different case's (or a made-up) B2 location and confirm it's refused, not silently served. This is the one place in this addendum where a missing check would leak photos across tenants/cases despite every other route being correctly scoped.
- **Confirm general browsing on a real large folder (hundreds of photos, if Peter can point to one) actually feels immediate** — the file list loads in pages, thumbnails lazy-load as scrolled to, and the case screen is interactive well before every photo in a big folder has loaded. This is the concrete test of Peter's "no waiting" requirement, not just a code-review check that pagination code exists.
- **Confirm the address search actually surfaces what the automatic matcher misses.** Take a real (or realistic test) case where `findBestPhotoMatch` returns no match or a wrong one, and confirm typing the correct address into search returns that folder in the ranked results — including when its `review_status` is `needs_review` (search must not silently apply the automatic matcher's exclusion filter). Then confirm picking it and confirming actually makes the case find it automatically on the next `GET /cases/:id` load, without any further manual step — that round-trip (search → confirm → automatically found from then on) is the entire point of this feature and the one thing to verify end to end, not just that the search box returns results.
- **Confirm `inspection_coordinator` can search but genuinely cannot confirm a result** — the UI control not rendering isn't sufficient on its own; call `POST /api/security-deposit/photo-review-queue/:id/resolve` directly as that role and confirm it's still a 403, same as every other pod-lead-only route.

---

## Compliance Grounding

This feature was reviewed and conditionally cleared by Asimov (governance) and Mason (legal) before this spec was written — the seven conditions below are the terms of that clearance, restated here as build requirements, not background. Q should treat every one of these as a checklist to satisfy before this feature is considered built, the same way the base spec's own governance conditions (its Neo section #5, #8, and Q's audit-logging section) were treated.

**On general photo browsing and the address search (both added after this clearance, on top of the AI-matching feature that carries the conditions below):** neither introduces a new AI-judgment or compliance surface. Browsing has no AI involvement and stores nothing. The address search has no AI involvement either — `addressWordScore` is a deterministic word-overlap function, the same one `findBestPhotoMatch` already runs today, not a model call — and it stores nothing new: confirming a result writes to the exact same `b2_photo_folders` columns the existing (already-cleared, already-built) admin review queue already writes to, through that same existing route. Neither gets a new numbered condition here. Both still need to follow two of the seven below by the same discipline, not a lesser one: condition 2 (nothing about photo content gets stored or logged — trivially true for both, since neither stores anything about what a photo depicts) and condition 6 (the B2 read stays narrowly scoped — browsing deliberately reuses the same `readFiles`-only byte-download function the matching feature already required, rather than adding a second, wider B2 mechanism, and the address search doesn't touch B2 at all — it only queries the already-indexed `b2_photo_folders` table — see the Q section's `downloadFileBytes` note and the address-search route description).

1. **The AI's only allowed output is match data — never a description, caption, or characterization of either photo (Asimov).** Enforced in this spec by the output contract in the Q section above (`matched_index` + `confidence`, no free-text field anywhere in the schema) and by the system prompt's explicit statement of this restriction.
2. **Nothing about photo content gets stored or logged anywhere — only match metadata, in the same shape as the existing folder-name-parse audit entries (Asimov).** Photo bytes are read transiently for the matching call and never persisted outside B2. Enforced by `security_deposit_photo_matches`' column list (Neo section #1) and the `audit_log` entry shape (Q section) — neither has anywhere to put photo-content text even if something tried to write it there.
3. **The confidence threshold deciding auto-show vs. route-to-confirmation must be a stored, versioned config value, never hardcoded (Asimov, GOVERNANCE.md Rule 5) — and changing it later is a Standard change requiring Peter's approval (Rule 6).** Enforced by reusing the exact `b2_match_confidence_config` pattern (Neo section #2) — versioned, singleton active row, `set_by`/`set_at`/`notes`, never overwritten in place.
4. **Any new table or column gets the same Rule 4 data-inventory documentation already used elsewhere in this tool's migrations (Asimov).** Applies to `security_deposit_photo_matches` (Neo section #3) — `photo_match_confidence_config` is a config table, not personal data, same treatment `b2_match_confidence_config` already received.
5. **The tool's existing disclosed CCPA limitation (it can delete its own index but not the underlying B2 photos) must explicitly extend to this feature's match-result data too (Asimov).** Done above under "Known Limitation — Extending the Existing CCPA Note" — no new, undisclosed gap.
6. **The new B2 code path that downloads actual photo bytes needs the same read-only, narrowest-possible-scope treatment the existing listing-only credential already got, and must be explicitly flagged for Sentinel's review at PR time (Asimov).** Called out in the Q/Scotty sections above (confirm/add the `readFiles` capability on the existing key, nothing broader) and restated in the Governance Path table below.
7. **The matching AI must be constrained to pure retrieval only — find the matching photo, nothing else. It must never generate a difference score, a "does this look like damage" assessment, or any evaluative output about what changed between the two photos (Mason — the one condition for clearing this feature).** This is the same restriction as condition 1 above, from a different reviewer for a different reason (Fair Housing/legal exposure from an AI making or implying an evaluative judgment about a tenant's unit, rather than a privacy exposure from reading photo content) — both land on the identical output contract and system-prompt language in the Q section above, deliberately, so there is exactly one place in the code that could get this wrong, not two different constraints to keep in sync.

## Governance Path for This Build

This feature stays inside the same lighter compliance-build treatment Asimov already confirmed for the base tool (GOVERNANCE.md Rule 7's full runtime-agent lifecycle doesn't apply — nothing here acts autonomously on a person; the AI finds a photo, a human looks at it). This feature does not change that classification — it adds a new *kind* of AI read (photo bytes, not just filenames) inside the same non-autonomous, human-reviews-everything design the whole tool already follows.

The full Mandatory PR Checklist Table (GOVERNANCE.md) still applies at PR time:

| Reviewer | What they check for this feature specifically |
|---|---|
| Neo | Schema matches Rule 4 data-inventory requirements; confidence-config table follows the exact versioned/singleton-active pattern |
| Q | Output contract has no free-text field; system prompt states the retrieval-only restriction; audit logging matches condition 2 |
| TARS | Output never leaks content description even in the raw model response; large-folder handling doesn't silently drop photos |
| Ralph | What happens under a huge folder, a slow B2 response, a malformed AI response |
| Viper | Whether a crafted file name or a crafted image could be used to manipulate the AI's output beyond its intended schema, the same class of finding Viper already made against `folder-parser.js`'s untrusted input handling; **and whether `GET .../photo-file`'s path-scope check can be bypassed** to read a photo outside the requesting case's own matched folders |
| Sentinel | **The expanded/new B2 credential capability specifically** — confirm it's still read-only, still single-bucket, and no wider than `readFiles` requires, and that the same capability (nothing broader) covers both the AI-matching download and general browsing |
| Mason | The system prompt and output contract actually enforce pure-retrieval-only, matching condition 7 above |
| Judge | Whether this spec's conditions were actually built, not just written down |
| Asimov | Final confirmation pass, same as the base tool's own build |

## Scope

**In scope for this addendum:** three pieces, built together. (1) General photo browsing — the full move-in and move-out galleries freely browsable on the case screen from the moment it opens, paginated/lazy-loaded so hundreds of photos don't mean a wait, with click-to-enlarge on any photo in either folder. (2) AI photo matching, layered on top of the same view — a coordinator selecting one or more move-out photos on an already-matched case, the system finding and showing the corresponding move-in photo with a visible confidence score, and a pod-lead confirm/correct flow for low-confidence matches. (3) An in-context address search on both galleries, reusing the base tool's existing address-scoring logic and existing resolve endpoint, so a wrong or missing automatic folder match can be fixed right on the case screen instead of only through the separate admin review queue. All three are built entirely on top of the base tool's existing folder-matching feature, not replacing it.

**Explicitly out of scope:** bulk automated diffing — an AI reviewing every photo in a case and flagging pairs that look different, unprompted. Deferred, pending separate legal review. Nothing else about that feature appears in this document.

## Open Items — Flagged for Jarvis and Peter

1. **RESOLVED — Peter confirmed `inspection_coordinator` is a real, distinct role at Rincon, not a stand-in for `pod_lead`.** They're the ones actually submitting/selecting move-out damage photos into this feature. The role value itself needs no schema change — `'inspection_coordinator'` is already one of the 6 legal values in the shared `team_member_tool_roles.role` CHECK constraint (`supabase/migrations/20260818000000_fix_role_check_regression.sql`), and it's already granted and used by two other tools today (`insurance_compliance` per `20260803000003_insurance_user_roles.sql`; `maintenance_history` per `20260815010000_maintenance_history_schema.sql`). What's missing is that the security-deposit tool's own code doesn't recognize it yet — see Neo and Q sections below for exactly what that requires and doesn't require.
2. **Candidate-batch size and large-folder handling is a real design decision, not yet made.** Q needs to pick a concrete bounded number of move-in candidate photos per AI call (sized to Claude's per-request image/payload limits) and decide what happens when a move-in folder exceeds it — batch across multiple calls keeping the best result, or cap and flag. Either is fine; it just needs to be a deliberate choice during the build, not discovered by accident against a real large folder.
3. **Whether `photo_match_confidence_config` should be its own table or a second column on the existing `b2_match_confidence_config`** — Neo section #2 above gives a recommendation (separate table, same pattern) and the reasoning; flagged for Neo to confirm before building, same as every other schema call in this tool's specs.
4. **The placeholder confidence threshold itself** (whatever number seeds the new config table) is not yet confirmed by Peter — same open item the original folder-matching threshold already carries, and likely resolved the same way: ship with an honestly-labeled placeholder, get real usage, then confirm or adjust.
5. **Whether the existing B2 application key already has the `readFiles` capability, or whether Scotty needs to add it,** is unverified as of this spec — flagged for Scotty to check first, before Q starts on the byte-download function, since the answer changes whether this is a "flip a setting" task or a "wait on a B2 console change" task.
6. **DECIDED, flagged in case Peter wants it narrower: `inspection_coordinator` gets read access to the move-in gallery, not just move-out.** Reasoning is in the Q section's separation-of-duties note above — they're the one doing the physical inspection, browsing move-in photos themselves before submitting a move-out candidate is a normal part of that job, and it's read-only with no approval power attached. If Peter would rather the coordinator only ever see move-out photos (forcing all move-in comparison through the AI match or a pod lead), that's a one-line change to the route's role list — flagging so it's a deliberate choice either way, not an assumption baked in silently.
7. **Server-side photo thumbnails are deliberately not in v1.** Pagination and lazy-loading (Tron/Q sections above) should be enough to make browsing feel immediate, but they're serving original photo bytes at grid size, not a resized copy. If real Rincon photo folders turn out to have unusually large files (e.g. high-resolution camera originals) and browsing still feels slow once this is live despite pagination, generating and caching real thumbnails is the next lever — not built now because it's meaningfully more infrastructure (an image-processing step, somewhere to cache the resized copies, cache invalidation) than what's been asked for, and shouldn't be built speculatively ahead of knowing it's actually needed.
8. **Whether the address search should also loosen its `inspection_type` filter is a real, deliberately deferred question.** Today's design filters search results to the requested type (move_in or move_out, or 'other') — the same rule `findBestPhotoMatch` already applies. But `parsed_inspection_type` is itself an AI guess from the same imperfect folder-name parse as everything else, so it's plausible a folder is address-correct but type-mismatched (parsed as move-out when it's really move-in, say). Left as a strict filter for v1 to keep the search behavior consistent with the automatic matcher's own rule rather than inventing a second, looser one; worth revisiting if real usage shows the type parse is often the thing that's actually wrong, not just the address.
9. **Minimum query length and debounce timing for the search box are Q's/Tron's call, not specified precisely here** — e.g. 3 characters and ~300ms were used as illustrative numbers above. Not blocking; just noting these are real tuning knobs, not implied to be exact.
