# Blueprint 03 — Maintenance Request Log

**What it does:** Logs every maintenance request in one place, tracks its status,
and keeps a record of what was done and what it cost.

**Problem it solves:** Requests come in by text, email, and voicemail. You forget
one. A tenant follows up angry. You can't remember if the plumber came or not.
An owner asks how much you spent on their property and you have to go digging.

**What you'll need before starting:**
- A list of your current open maintenance requests (even rough notes are fine)
- Your main vendors (plumber, electrician, handyman — names and contact info)
- How detailed you want the cost tracking to be

---

## Hand This to Jarvis

Copy and paste everything below into Claude Code:

---

> I want to build a maintenance request log.
>
> Right now requests come in from multiple places — text, email, sometimes
> a tenant just calls. I lose track of them and I can never quickly tell
> an owner what's been done on their property.
>
> I want a simple log where I can:
>
> 1. Add a new request with: tenant name, unit, description of the problem,
>    date received, and which vendor I assigned it to
> 2. Update the status: Open / In Progress / Completed
> 3. Add a completion note and the final cost when the work is done
> 4. Filter by property to see all maintenance history for one unit or building
>
> I want to be able to add entries quickly — ideally in under 30 seconds.
>
> Later I might want to pull a report for an owner showing everything that
> happened on their property this month, but don't build that yet — just
> the log first.
>
> Please follow the normal plan → approve → build process. Tell me what
> you're going to build before you write any code.

---

## What You'll Get

By the end of this build:
- A running log of all maintenance requests
- Quick entry — add a new request in under 30 seconds
- Status tracking (Open / In Progress / Completed)
- Cost tracking per request
- The ability to pull everything for one property — useful for owner reports
