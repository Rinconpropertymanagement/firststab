# Blueprint 02 — Late Rent Tracker

**What it does:** Tracks who owes rent, how many days late they are,
and drafts a late payment notice ready to send.

**Problem it solves:** You're chasing rent manually — texting one tenant,
calling another, losing track of who paid and who didn't. By the time you
send a formal notice you've already lost two weeks.

**What you'll need before starting:**
- Your rent due date (1st? 5th? day of grace period?)
- Your late fee policy (flat fee? percentage? when it kicks in?)
- Whether you want the notice to be firm or more conversational in tone

---

## Hand This to Jarvis

Copy and paste everything below into Claude Code:

---

> I want to build a late rent tracker.
>
> Here's the problem: every month I have to manually track who paid rent
> and who didn't. By the time I realize someone is late I've already
> lost days. I want a simple tool that helps me:
>
> 1. Mark each tenant as paid or unpaid for the month
> 2. See at a glance who is late and how many days
> 3. Generate a late payment notice for any tenant who is past due —
>    something professional I can send by email or text
>
> My rent is due on the [1st / 5th — you'll fill this in] of each month.
> I have a [X]-day grace period before I charge a late fee.
>
> Keep it simple — I don't need it to connect to any payment system right now.
> I just want a log I can update and a notice I can send.
>
> Please follow the normal plan → approve → build process. Tell me what
> you're going to build before you write any code.

---

## What You'll Get

By the end of this build:
- A monthly tracking log for rent payments
- A color-coded view of who is current vs. late vs. very late
- A late payment notice template that fills in the tenant's name,
  amount owed, and days past due automatically
- A record of when you sent notices (so you can prove it if you ever need to)
