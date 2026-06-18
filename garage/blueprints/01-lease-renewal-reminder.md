# Blueprint 01 — Lease Renewal Reminder

**What it does:** Shows you which leases are expiring in the next 60 and 30 days,
and drafts renewal reminder emails ready to send.

**Problem it solves:** You find out a lease is expiring two weeks out and have to
scramble. A tenant doesn't renew. Unit sits vacant. You lose a month of rent.

**What you'll need before starting:**
- A list of your tenants, their unit numbers, and their lease end dates
- Your preferred email tone (formal / friendly / somewhere in between)

---

## Hand This to Jarvis

Copy and paste everything below into Claude Code:

---

> I want to build a lease renewal reminder tool.
>
> Here's the problem: I manage multiple units and I keep getting caught off
> guard when leases expire. I want a simple way to:
>
> 1. Enter or import my tenant names, unit numbers, and lease end dates
> 2. See a list of which leases expire in the next 60 days, sorted soonest first
> 3. For each expiring lease, have a draft renewal reminder email ready to send —
>    one for the 60-day notice and one for the 30-day notice
>
> Keep it simple. I don't need it to send emails automatically — I just need
> the draft ready so I can copy it and send it myself.
>
> Please follow the normal plan → approve → build process. Tell me what
> you're going to build before you write any code.

---

## What You'll Get

By the end of this build:
- A simple tool to enter or update your lease data
- A sorted list showing which leases are expiring soonest
- Draft reminder emails for each tenant, ready to copy and send
- Something you can run in under a minute at the start of each week
