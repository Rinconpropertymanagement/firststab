# Fold Rental Analysis Into the Hub — Build Spec

Status: Draft — this is Step 2 (PLAN) of the CLAUDE.md Build Pipeline. Needs
Peter's approval (Step 3) before Neo/Q/Tron/Scotty build anything. Light
7-step CLAUDE.md pipeline — see "Compliance Scope" below for why this
doesn't cross into GOVERNANCE.md's deeper pipeline, including a direct check
of whether adding real login *changes* that answer (it doesn't, and if
anything it removes a small piece of exposure that existed today).

Every fact below marked "confirmed live" was checked directly against the
real Hub codebase and the real Sally server this session — not assumed from
file names or from how the other two rental-analysis specs described things.

## Why This Is Happening Now

Rental analysis was deployed standalone to Sally this session
(`https://srv1784739.hstgr.cloud/rental-analysis/`) with no login of any
kind — anyone with the link can run analyses and see Rincon's own comp data.
Flagged as a real gap at deploy time. Peter chose to fold it into the Hub
(`https://review.househackmanagement.com`) rather than give it its own
separate login.

## What This Does

Right now, using rental analysis means going to a separate, unprotected web
address. This build moves it inside the Hub — the same one login Peter's
team already uses for Insurance Compliance, Security Deposit, Call Stats,
Content, and the Scoreboard. Once this ships, rental analysis becomes just
another tile on the Hub's home page: log in once with your Hub email and
password, click into Rental Analysis, and it works exactly like it does
today — same address box, same "Run Analysis" button, same map, same
recommended-rent results. The only real difference is that it now requires
logging in, and only people Peter has specifically granted access to
(his sales/ops team) can reach it — nobody else, and not the whole internet.

**What changes for Peter's team:** a new web address
(`https://review.househackmanagement.com/rental-analysis`) and a login
screen where there wasn't one before. The old address keeps working during
a short transition window (see "Cutover Sequencing" below), so nobody is
locked out mid-switch — but Peter will need to tell his sales/ops team the
new address once it's live, and Neo/Peter will need to actually grant each
of them access before their first login attempt succeeds (see "Who Gets
Access" below) — this doesn't happen automatically just because the code
ships.

## How It Works — the Real, Verified Mechanism

**Confirmed by reading `projects/hub/server.js`, `projects/hub/lib/middleware.js`, `projects/hub/insurance/router.js`, `projects/hub/security-deposit/router.js`, and live SSH into Sally — not assumed:**

1. **The Hub is one Node process, not a proxy in front of separate apps.**
   `projects/hub/server.js` is a single Express app. Every tool
   (Insurance, Security Deposit, Property 360, Call Stats, Content, the
   Scoreboard...) is a separate router file (`insurance/router.js`,
   `security-deposit/router.js`, etc.) that gets `require()`'d directly
   into `server.js` and mounted with `app.use(...)`. There is no
   network hop between the Hub and its tools — folding rental analysis in
   means its routes become part of this same process, not a proxy target.
2. **Login is real Supabase Auth**, not a cookie that just says "logged
   in." `POST /login` (`server.js`) checks email + password against
   Supabase Auth and stores the resulting access/refresh tokens in an
   Express session (cookie name `hub.sid`, 8-hour expiry, `httpOnly`,
   `secure` in production). `lib/middleware.js`'s `requireLogin` — which
   runs on every request below it in `server.js` — re-verifies that token
   against Supabase Auth on every single request (not just at login), and
   silently refreshes it once if it's expired before forcing a re-login.
   This is the exact same login every other Hub tool already uses; Peter
   and his team use the same email/password they already use for
   content-review.
3. **Login alone is not enough to reach a tool's real data — and this is
   the mechanism that actually restricts rental analysis to sales/ops.**
   `requireLogin` only answers "is this a valid, currently-logged-in
   Supabase Auth user" — it does **not** check who they are or what
   they're allowed to see (confirmed directly in `lib/middleware.js`,
   which says so explicitly in its own comments). Supabase Auth in this
   project is **not domain-restricted** (confirmed: no
   `@rinconmanagement.com` check anywhere in `lib/auth.js`, unlike
   Insurance Compliance's old standalone Google OAuth, which was) and
   there's no public self-serve sign-up route in the Hub — accounts have
   to already exist in Supabase Auth. So today, "who can log into the Hub
   at all" is gated only by "who already has a Supabase Auth account,"
   which is broader than "sales/ops." **Every existing tool closes that
   gap the same way, and rental analysis needs to do the same:** a
   per-tool role table, `team_member_tool_roles` (`supabase/migrations/
   20260812020000_shared_team_members.sql`), keyed by `tool` (a
   Postgres CHECK-constrained column — currently allows
   `insurance_compliance`, `maintenance_history`, `security_deposit`, and
   others added since). Each tool's router does its own lookup
   (`attachInsuranceRole` / `requireInsuranceAccess` in
   `insurance/router.js` is the reference example) and returns 403 to
   anyone with no row for that tool — **fail-closed**: a person with zero
   rows in that table for a given tool is treated as having no access,
   not as an error. Rental analysis needs the same: a new
   `tool='rental_analysis'` value, and Neo/Peter granting a role row to
   each specific sales/ops person who should have access — nobody gets in
   just because the code shipped.
4. **A tool's dashboard page is served through its own router, with one
   small addition, not restyled to match a shared Hub shell.** Confirmed
   directly in `insurance/router.js`: `GET /insurance` just reads that
   tool's own `dashboard/index.html` file and serves it as-is — same
   styling, same layout, no shared Hub nav/header wrapped around it. The
   *only* injected addition is the Hub's global "search properties" box
   (`lib/global-search-widget.js`), spliced in with a plain string
   `.replace('<body>', '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML)` right
   after the page loads. There is no "Hub shell" to restyle into —
   rental-analysis's dashboard keeps its own current look almost
   entirely unchanged.
5. **`review.househackmanagement.com` is a single, whole-domain reverse
   proxy straight to the Hub's port — confirmed live on Sally**
   (`/etc/nginx/sites-available/content-review`, the file that actually
   answers that domain): every request to that domain, regardless of
   path, is proxied to `http://localhost:3500` (`HUB_PORT`). This means
   **no nginx change is needed on the Hub side of this build at all** —
   mounting a new router inside `server.js` is immediately reachable at
   `review.househackmanagement.com/<whatever path the router registers>`
   with zero infra config. This is a materially simpler mechanism than
   the standalone deployment's per-tool nginx `location` blocks (used on
   the *other* domain, `srv1784739.hstgr.cloud` — see Cutover Sequencing).

## Cutover Sequencing — What Happens to the Standalone Deployment

Confirmed live via SSH into Sally: the standalone deployment
(`https://srv1784739.hstgr.cloud/rental-analysis/`) and the Hub
(`https://review.househackmanagement.com`) are two **completely separate
nginx sites on two different domains**, proxying to two separate pm2
processes (`rental-analysis`, port 3457, and `hub`, port 3500 — both
confirmed `online` right now). They do not share a port, a process, or a
URL. That means:

- The Hub-mounted version can go live and be fully tested at
  `review.househackmanagement.com/rental-analysis` **without touching or
  risking the standalone deployment at all** — they can run side by side.
- Nothing about this build requires an immediate cutover. The old link
  keeps working exactly as it does today until Scotty deliberately tears
  it down as a **separate, final, explicit step** — not an automatic
  side effect of merging this build.
- The honest tradeoff: the standalone link's real gap (no login, reachable
  by anyone with the URL) stays open the entire time both versions run
  side by side. This build does not close that gap the moment it ships —
  only the final decommission step does. Worth Peter knowing plainly, not
  glossed over: budget for a real teardown step, not just "build the new
  one and forget the old one."
- Recommended order: (1) Q/Tron/Neo build and TARS verifies the
  Hub-mounted version end-to-end, (2) Peter tells his sales/ops team the
  new address and Neo/Peter grants each of them a role, (3) a short
  overlap period where both work, (4) Scotty decommissions the standalone
  pm2 process and its two nginx `location` blocks on the
  `calendar-assistant` site, confirmed only after Peter confirms the team
  has moved over.

## What You'll See

Nothing changes about how an analysis itself runs — same address box, same
autocomplete, same pre-fill, same map, same recommended-rent output. The
only visible differences: a login screen the first time (same email/
password as every other Hub tool), a new web address
(`review.househackmanagement.com/rental-analysis` instead of
`srv1784739.hstgr.cloud/rental-analysis`), and — for anyone Peter hasn't
explicitly granted access to — a friendly "you don't have access to this
tool" message instead of the form, the same message Insurance Compliance
already shows people without a role there.

## Who Gets Access

Rental analysis has **no internal permission tiers today** — nothing in
its own code distinguishes an admin from a regular user; anyone who could
reach the old link could do everything the tool does. That's simpler than
Insurance Compliance's four-role system, and Neo should size the new role
list to match reality rather than invent tiers nothing in the tool actually
uses. The nearest real precedent is Security Deposit's minimal two-role set
(`admin`, `pod_lead`) — Neo to decide the exact name(s), but a single
"can use this tool" role plus reusing the existing shared `admin` value is
probably enough for v1. **Peter needs to name, specifically, which
sales/ops people get that role** — this spec doesn't and shouldn't guess
who's on that list.

For v1, granting access is a one-time SQL insert into
`team_member_tool_roles` (same "Peter/Neo runs a plain SQL statement in
Supabase's SQL Editor, no code deploy" pattern this project already uses
for flipping a comp source on) — not a self-serve "manage access" screen
like Insurance Compliance's. Building that screen is real, separate Q+Tron
work this spec deliberately does not include; worth doing later only once
it's clear more than a handful of people need it.

## What Could Go Wrong

- **The dashboard's map will break under the Hub's security headers if
  nobody fixes it — confirmed live, not a guess.** Rental analysis's
  dashboard loads Leaflet (the radius-search map from this session's CRMLS
  work) from an external CDN (`unpkg.com`) via a `<script src="https://
  unpkg.com/...">` tag and an external stylesheet `<link>`. The standalone
  server has no security headers today, so this works. The Hub's
  `server.js`, however, runs `helmet()` with a Content-Security-Policy that
  only widens `script-src` to allow inline scripts (`'self'`,
  `'unsafe-inline'`) — it does **not** allow `unpkg.com`, and `style-src`
  is untouched from helmet's default (`'self'` only). Moved in unchanged,
  the map would silently fail to load under the Hub's CSP. Q needs to
  either widen the Hub's CSP (`script-src`/`style-src`/likely `img-src`,
  for Leaflet's marker icons) to allow `unpkg.com`, or self-host the
  Leaflet files instead — Q/Sentinel's call which is safer, but it must be
  decided, not skipped.
- **Nobody — including Peter — can use the moved tool until someone
  explicitly grants access.** `team_member_tool_roles` starts with zero
  rows for `tool='rental_analysis'`, same fail-closed start every other
  Hub tool had. Easy to ship the code, verify it "works," and then have
  the very next real user hit a 403 because the grant step got skipped.
- **The six rental-analysis-specific credentials must be added to the
  Hub's own `.env`, not just left in rental-analysis's old one.** Confirmed
  live on Sally: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
  `ANTHROPIC_API_KEY` are already byte-for-byte identical between
  `/var/www/hub/.env` and `/var/www/rental-analysis/.env` (same Supabase
  project, same Anthropic account) — nothing to reconcile there. But
  `RENTCAST_API_KEY`, `LOCATIONIQ_API_KEY`, `RECORE_CLIENT_ID`,
  `RECORE_CLIENT_SECRET`, `RECORE_SERVER_TOKEN`, and
  `RECORE_BROWSER_TOKEN` exist only in rental-analysis's own `.env` today.
  Each is checked per-request inside its own `lib/*.js` file, not at
  process startup — so if Scotty forgets one, the Hub won't crash, that one
  comp source will just quietly stop returning comps, the same "access
  lapses quietly" risk the CRMLS and LeadSimple specs already flagged for
  their own sources. Same requirement applies twice: once in the local
  dev shared root `.env`, and once in Sally's real `/var/www/hub/.env` —
  missing it in only one place means local testing passes and production
  silently doesn't (or vice versa).
- **This session's CRMLS/LeadSimple/radius work must survive the move
  unchanged.** Nothing about mounting the routes differently should touch
  `lib/weighting.js`, `lib/sources.js`, `lib/crmls.js`,
  `lib/leadsimple.js`, or the comp-scoring math at all — those files move
  as-is. The real risk is in the plumbing around them (route paths, static
  file serving, CORS) — see "What Q Needs to Build," which calls out
  exactly what needs to change and, just as importantly, what must not.
- **`API_BASE` does not need another fix this time, but only if Q keeps
  the exact route paths.** Q already had to fix `API_BASE` once this
  session when this tool was first deployed to its own domain. This move
  doesn't repeat that problem **as long as** the new router keeps the
  exact same `/api/rental-analysis/*` prefix (matching how Insurance
  Compliance's own migration deliberately kept its API paths unchanged,
  specifically so its dashboard's existing `fetch()` calls needed zero
  changes). `dashboard/index.html`'s `API_BASE = ''` already resolves
  correctly against any origin/path combination for absolute-path fetches
  like `/api/rental-analysis/run` — confirmed by reading the fetch calls
  directly — so this is a real risk only if Q renames the API prefix,
  which there's no reason to do.

## What Neo Needs to Build

- One small migration extending `team_member_tool_roles`'s `tool` CHECK
  constraint to add `'rental_analysis'` — same DROP-then-ADD CONSTRAINT
  pattern already used in `supabase/migrations/
  20260813000004_security_deposit_team_roles.sql`. **Before writing it,
  query the live database for `SELECT DISTINCT tool FROM
  team_member_tool_roles`** and include every real current value in the
  new CHECK, not the list this spec happens to name above — that exact
  migration's own history records a real failed first attempt from
  assuming a stale list instead of checking live.
- Decide (with Peter, per "Who Gets Access" above) whether rental analysis
  needs a new `role` value at all, or can reuse the shared `admin` value
  as-is — rental analysis's own code has no internal tiers today, so the
  simplest defensible answer is "just `admin`," but Neo owns this call.
- No new tables — rental analysis's existing Supabase tables
  (`rental_analyses`, `rental_comps`, `rental_comp_sources`, and
  `leadsimple_new_leases` if that source has shipped) are untouched. They
  already live in the same Supabase project the Hub already connects to.

## What Q Needs to Build

- **New folder `projects/hub/rental-analysis/`**, following the exact
  shape `projects/hub/insurance/` and `projects/hub/security-deposit/`
  already use: a `router.js` exporting `{ router }` (no `internalRouter`
  is needed — confirmed by reading `rental-analysis/server.js` in full:
  it has no cron/webhook endpoint today, unlike every tool that does
  export one), plus a `dashboard/` folder holding the current
  `dashboard/index.html` moved over unchanged, plus a `lib/` folder holding
  rental-analysis's existing `lib/*.js` files moved over **unchanged**
  (`constants.js`, `crmls.js`, `leadsimple.js`, `locationiq.js`,
  `market-data.js`, `narrative.js`, `property-matching.js`, `rentcast.js`,
  `sources.js`, `supabase.js`, `weighting.js`) — none of this session's
  comp-scoring logic should be touched by this build.
- Port the three real routes from `rental-analysis/server.js`
  (`GET /api/rental-analysis/property-lookup`, `GET /api/rental-analysis/
  address-suggest`, `POST /api/rental-analysis/run`, plus
  `GET /api/rental-analysis/users`) into the new router, **keeping the
  exact same paths** (see "What Could Go Wrong" above on why).
- Add `GET /rental-analysis` — reads and serves `dashboard/index.html`,
  same pattern as `insurance/router.js`'s `GET /insurance` (string-replace
  in the global search widget after `<body>`; no server-side access gate
  on this route itself, same reasoning insurance uses — it's a static
  shell, the API routes underneath are what's actually gated).
- Add role gating: an `attachRentalAnalysisRole` middleware (`router.use()`
  at the top of the file) and a `requireRentalAnalysisAccess` guard applied
  to every real data route (`property-lookup`, `address-suggest`, `run`,
  `users`) — same shape as `attachInsuranceRole`/`requireInsuranceAccess`.
- Add `GET /api/rental-analysis/auth/me` (email/role, same shape as every
  other tool's `auth/me`) — **new work, not already present**: rental
  analysis's dashboard currently has no client-side access check of any
  kind (it never needed one, standalone). Tron needs this endpoint to
  build the "no access" message (see Tron's list below).
- Drop the dead CORS-allowlist middleware from the old `server.js` — it
  only mattered for a truly standalone, separately-hosted app; once
  mounted in-process there's no cross-origin request to guard against.
  Not copying it over is a cleanup, not a functional change.
- Fix the CSP gap flagged above (widen the Hub's helmet config, or
  self-host Leaflet — Q's call, flag it to Sentinel either way since it's
  a security-header change).
- Wire the new router into `projects/hub/server.js`: one `require(...)`
  line, one `app.use(rentalAnalysisRouter)` after `requireLogin` (same
  mounting order as every existing tool), and update the `--help` text
  block at the top of `server.js` to list the new route, same as every
  prior tool addition did.
- No new npm dependency: rental-analysis only needs `@anthropic-ai/sdk`,
  `dotenv`, and `express` — confirmed directly against
  `projects/hub/package.json`, all three already present.

## What Tron Needs to Build

- A client-side "check access first" pattern on `dashboard/index.html`,
  matching the one every other Hub tool's dashboard already uses: call
  `GET /api/rental-analysis/auth/me` on page load; on a 403, replace the
  form with a plain "you don't have access to this tool — ask Peter to
  grant it" message instead of showing a broken/silently-failing form.
  This is genuinely new work — nothing like it exists in the tool today,
  since it never had a login to check against.
- No restructuring of the dashboard's own layout, styling, or the map —
  confirmed above that folded-in tools keep their own look; the only
  required visual addition is the Hub's global search widget, which
  Tron should confirm renders sanely above rental analysis's own header
  (same check every prior tool migration already did).

## What Scotty Needs to Do

- Add the six rental-analysis credentials
  (`RENTCAST_API_KEY`, `LOCATIONIQ_API_KEY`, `RECORE_CLIENT_ID`,
  `RECORE_CLIENT_SECRET`, `RECORE_SERVER_TOKEN`, `RECORE_BROWSER_TOKEN`)
  to the Hub's `.env` in **both** places: the local shared root `.env`
  and Sally's real `/var/www/hub/.env`. `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, and `ANTHROPIC_API_KEY` need no changes —
  confirmed already identical between the two apps' `.env` files.
- No nginx change needed for the Hub side of this build — confirmed live
  that `review.househackmanagement.com` already proxies everything to the
  Hub's port with no path-specific `location` blocks to add.
- No pm2 change for a new process — this is not a new server, it's new
  routes inside the existing `hub` pm2 process. A normal `hub` restart/
  deploy picks it up.
- **The actual decommission, as its own later step, not bundled into this
  build:** once Peter confirms the team has moved to the new address,
  stop the `rental-analysis` pm2 process and remove its two `location`
  blocks from `/etc/nginx/sites-available/calendar-assistant` (currently
  live, confirmed). Do this only after explicit confirmation from Peter —
  not automatically on merge.

## Verification Target — What TARS Should Confirm Before This Is Called Done

1. A real Supabase Auth account with **no** `tool='rental_analysis'` role:
   `GET /rental-analysis` loads the page shell, but
   `GET /api/rental-analysis/auth/me` and every other API call returns
   403 — and the dashboard shows the friendly "no access" message, not a
   broken form.
2. That same account, after being granted the role: a full real analysis
   run at `https://review.househackmanagement.com/rental-analysis` —
   address autocomplete (LocationIQ), property pre-fill (RentCast), and a
   completed analysis pulling comps from RentCast + CRMLS (+ LeadSimple,
   if that source is active) with the recommended range matching what the
   same address produces on the still-live standalone tool.
3. The Leaflet radius map actually renders under the Hub's CSP — the
   concrete regression risk this spec identified, not assumed fixed.
4. A logged-out request to `/rental-analysis` and directly to
   `/api/rental-analysis/run` both get turned away (redirect / 401-403),
   not served.
5. The old standalone URL still works, unaffected, confirming the two
   deployments really are independent during the overlap window.
6. `GET /api/rental-analysis/property-lookup`, `/address-suggest`, and
   `/run` all resolve at the same paths the dashboard's existing
   `fetch()` calls already use — no `API_BASE` change needed, confirmed
   rather than assumed.

## Compliance Scope

Per GOVERNANCE.md's own scope line, the deeper pipeline applies when a
build "sends messages to tenants/owners, makes or influences a housing
decision, or stores personal data." This build sends no messages, makes no
decision about any applicant or tenant, and stores no new data of any
kind — it only changes *how the tool is reached and who's allowed to reach
it*. The underlying data (property/listing-level comps: address, beds/
baths/sqft, rent, dates) is unchanged from what CRMLS's own spec already
assessed as out of compliance-build scope.

Worth reasoning through directly, since the brief specifically asked
whether adding real authentication changes this picture: **it doesn't
raise the bar, and if anything it lowers the tool's actual risk.** Today,
the standalone deployment has zero access control — anyone with the link
can run analyses and see Rincon's internal comp data, including comps
against Rincon's own managed properties. This build's entire purpose is to
close that gap, not widen it. It doesn't add any new data collection,
doesn't touch `rental_analyses`/`rental_comps`' existing columns, and
doesn't change who's authorized to make any decision — nobody's housing
outcome is decided or influenced by who can log into this tool. On that
basis, this build does not meet the compliance-build bar and the standard
CLAUDE.md pipeline applies: this spec, Neo's small migration, Q builds,
Tron adds the access-check UI, Scotty handles the credentials/nginx/
decommission steps, TARS verifies with a real logged-in run, Judge signs
off.

## Technical Appendix — Verified Live, 2026-09-20

Everything below was confirmed by direct reads of the real code and a
real, read-only SSH session into Sally this session — not inferred from
file or variable names.

- **Sally pm2 processes, confirmed `online`:** `hub` (port 3500,
  `/var/www/hub`), `rental-analysis` (port 3457, `/var/www/rental-analysis`),
  `insurance-server` (legacy standalone insurance-compliance, still
  running independently). `content-review` pm2 process is `stopped`.
- **`review.househackmanagement.com` → `/etc/nginx/sites-available/
  content-review`** (the file's `server_name`, not its filename, is what
  matters — it's the file that answers this domain): a single
  `proxy_pass http://localhost:3500;` for `location /`, no other location
  blocks. Confirms the Hub receives every request to this domain,
  whatever the path.
- **`srv1784739.hstgr.cloud` → `/etc/nginx/sites-available/
  calendar-assistant`**: per-tool `location` blocks, including the two
  added for rental-analysis 2026-09-19 (`/rental-analysis/` →
  static alias; `/api/rental-analysis/` → `proxy_pass
  http://127.0.0.1:3457/api/rental-analysis/`) — confirmed still present
  and live.
- **`.env` diff, `/var/www/hub/.env` vs `/var/www/rental-analysis/.env`
  on Sally:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
  `ANTHROPIC_API_KEY` are byte-for-byte identical in both files.
  `RENTCAST_API_KEY`, `LOCATIONIQ_API_KEY`, `RECORE_CLIENT_ID`,
  `RECORE_CLIENT_SECRET`, `RECORE_SERVER_TOKEN`, `RECORE_BROWSER_TOKEN`
  exist only in rental-analysis's `.env`. `RENTAL_ANALYSIS_PORT` becomes
  irrelevant once mounted in-process (nothing listens on a separate port).
- **`package.json` diff:** rental-analysis depends on `@anthropic-ai/sdk`,
  `dotenv`, `express` — all three already present in
  `projects/hub/package.json`. No new dependency required.
- **CSP finding:** `projects/hub/server.js`'s `helmet()` config widens
  only `script-src` (to add `'unsafe-inline'`); `style-src` is untouched
  from helmet's default (`'self'`). `rental-analysis/dashboard/
  index.html` loads `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css`
  and `.../leaflet.js` — both currently unrestricted (the standalone
  server runs no `helmet()` at all) and both would be blocked by the
  Hub's current CSP if moved in unchanged.
- **`team_member_tool_roles.tool` CHECK constraint** is a plain Postgres
  inline CHECK, widened in past migrations via `DROP CONSTRAINT
  team_member_tool_roles_tool_check` + `ADD CONSTRAINT ... CHECK (tool IN
  (...))` — confirmed in `supabase/migrations/
  20260813000004_security_deposit_team_roles.sql`, which also documents a
  real prior failure from assuming a stale value list instead of querying
  live.
