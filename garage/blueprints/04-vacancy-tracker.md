# Blueprint 04 — Vacancy Tracker

**What it does:** Tracks your vacant units, how long they've been empty,
showings you've done, and applicants in your pipeline.

**Problem it solves:** Every day a unit sits vacant is money you're not making.
You need to know exactly how long each unit has been empty, who you've shown it to,
and where each applicant is in the process — without digging through texts and emails.

**What you'll need before starting:**
- Your current vacant units (address, unit number, bed/bath, asking rent)
- Any showings you've already done (rough dates and notes are fine)
- How you currently handle applications (portal? paper? email?)

---

## Hand This to Jarvis

Copy and paste everything below into Claude Code:

---

> I want to build a vacancy tracker.
>
> Every vacant unit is costing me money every day. Right now I track showings
> and applicants in my head and in scattered texts. I want one place to see:
>
> 1. All my currently vacant units — address, unit, bed/bath, asking rent,
>    and how many days it's been vacant
> 2. Every showing I've done for each unit — date, prospect name, and a note
>    about how it went
> 3. Applicant status for each unit — something like:
>    Shown / Applied / Under Review / Approved / Denied / Moved In
>
> I want to be able to see at a glance which units have been vacant the longest
> and which have the most active applicant pipeline.
>
> Keep it simple for now — I don't need it to connect to my PM software.
> I just need a clear picture in one place.
>
> Please follow the normal plan → approve → build process. Tell me what
> you're going to build before you write any code.

---

## What You'll Get

By the end of this build:
- A live list of vacant units sorted by days on market (oldest first)
- A showing log for each unit — who came, when, and what happened
- Applicant pipeline tracking per unit
- A quick way to see which units are close to being filled and which are stuck
