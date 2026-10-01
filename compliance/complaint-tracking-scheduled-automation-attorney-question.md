# Complaint Tracking — Quick Question: Moving From a Manually-Triggered Scan to a Scheduled One

**Prepared for:** Peter McKenzie, Rincon Management, to forward to outside counsel
**Date:** 2026-09-29
**Purpose:** one specific new question — not a re-review of the AI engine itself, which Asimov and Mason already cleared.

---

Complaint Tracking has an AI read mail from Rincon's shared Missive inboxes, decide whether a conversation is complaint-worthy, and — if so — create a record in Rincon's own database with a category, an AI-written summary, and sometimes a draft note. That mechanism — the reading, categorizing, and drafting — is already cleared (Asimov: CLEARED; Mason: CLEARED WITH CONDITIONS, since met). What isn't cleared yet is narrower: today a person manually starts each scan, and this project's own internal rule requires a real monitored stretch of that first — at least 14 days, every run read by Peter and the Director of Operations — before it can move to a timer instead. That period just started and hasn't finished; Rincon wants to move to the timer sooner, on the strength of your opinion rather than finishing it out.

**The relevant fact:** we checked the code directly — nothing in this pipeline ever sends anything to a tenant, owner, or vendor, and nothing in it makes a final decision about anyone. It only ever creates an internal record that a human reviews and acts on afterward, the same as it does today. Moving to a timer changes only when the scan runs and whether someone is watching the moment it happens — it doesn't touch the human review that happens before any action is taken on what the scan finds.

**The question:** given that, does removing the "a human watches every run" requirement change your risk assessment — knowing that no communication or decision is ever automated, only the read-and-categorize step is? We're asking because the requirement we'd be skipping is our own internal safeguard, not something the law requires, and we want to know whether that distinction actually holds up.
