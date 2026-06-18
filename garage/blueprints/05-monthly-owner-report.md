# Blueprint 05 — Monthly Owner Report Generator

**What it does:** Takes the numbers you already have and formats them into a
clean, professional monthly report you can email to your property owners.

**Problem it solves:** You spend an hour every month copy-pasting numbers into
a Word doc and making it look professional. The report is important — it builds
trust with your owners — but creating it is tedious busywork.

**What you'll need before starting:**
- A sample of your current owner report (even a rough one) so Claude can match your format
- The data you normally include: rent collected, expenses, maintenance costs, vacancy
- Your preferred tone — formal? conversational? somewhere in between?

---

## Hand This to Jarvis

Copy and paste everything below into Claude Code:

---

> I want to build a monthly owner report generator.
>
> Every month I need to send each property owner a report on their property.
> Right now it takes me way too long — I'm copying numbers into a template
> manually and formatting it to look professional.
>
> I want a tool where I can:
>
> 1. Enter the key numbers for the month:
>    - Rent collected (and from which tenants)
>    - Expenses paid (maintenance, repairs, fees)
>    - Current vacancy status
>    - Any issues or notes the owner needs to know about
>    - Anything that needs owner approval
>
> 2. Hit a button (or run a command) and get a formatted, professional report
>    I can copy into an email or PDF and send directly to the owner
>
> The report should look like it came from a real property management company —
> clean, professional, and easy for a non-technical owner to read.
>
> Start with a template I can fill in manually. Later I might want it to pull
> data automatically, but don't build that yet.
>
> Please follow the normal plan → approve → build process. Tell me what
> you're going to build before you write any code.

---

## What You'll Get

By the end of this build:
- A simple form to enter monthly numbers for each property
- A professional-looking report generated automatically from those numbers
- Something you can send in under 10 minutes instead of an hour
- A consistent format owners will come to recognize and trust
