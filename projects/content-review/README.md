# Rincon Content Review

A simple, password-protected web page for reviewing drafts from the content
engine (`projects/content-engine`). Approve, request changes, or reject
drafts — and for politically-sensitive civic content, edit specific
paragraphs directly.

**This page never posts, publishes, or sends anything anywhere.** Every
button only changes a status field in the database. Getting approved
content live (posting to Facebook, publishing to the website, etc.) is
something Peter does manually, outside this app.

## First-time setup (one time only)

1. Make sure `.env` in the repo root has `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   and `SUPABASE_SERVICE_ROLE_KEY` filled in (they already are).
2. From this folder, install dependencies:
   ```
   npm install
   ```
3. Create Peter's login:
   ```
   node scripts/create-first-user.js
   ```
   This creates the account `peter@rinconmanagement.com` and triggers a
   password-reset email from Supabase. **Peter must check that inbox and
   click the reset link to set his own password before logging in.** If the
   email doesn't arrive (some Supabase projects don't have outbound email
   turned on yet), go to the Supabase dashboard → Authentication → Users →
   find `peter@rinconmanagement.com` → "Send password recovery" to trigger
   it manually, or set a password directly from that same screen.

## Running it

```
npm start
```

Then open **http://localhost:3300** in a browser and log in with
`peter@rinconmanagement.com` and the password Peter set.

To stop it, press Ctrl+C in the terminal it's running in.

## What's on the page

- **Draft queue** (`/`) — every content item, filterable by status. Badges
  show status, content type, whether it's flagged politically sensitive,
  and whether any cited legal claim needs human review.
- **Draft detail** (`/items/:id`) — full draft text with any
  `[NEEDS HUMAN REVIEW: ...]` flags highlighted in yellow, the legal claims
  it's based on (click to expand and see the source), and three actions:
  Approve, Request Changes (comment required), Reject.
  - For politically-sensitive items only: an extra box to edit one
    paragraph/section at a time, with a reason, logged separately.
  - A general edit box for the whole title/body/meta description, logged
    to the edit history.
- **Topic Suggestions** (`/topics`) — candidate topics from discovery feeds,
  approve/reject. Empty for now since nothing feeds it yet — that's a
  future build.
- **Social Captions** (`/items/:id/captions`) — once a blog post is
  approved, review its Facebook/LinkedIn/Instagram captions and
  approve/reject each independently.

## Notes for whoever deploys this later (Scotty)

- Runs on port 3300 by default (`CONTENT_REVIEW_PORT` env var to change it).
- Uses `express-session` with an in-memory session store — fine for one
  person on localhost; if this moves to a real server with multiple users,
  swap in a persistent session store (e.g. Redis) rather than the default.
- Set a real `SESSION_SECRET` env var in production — a random one is used
  as a fallback for local dev only.
