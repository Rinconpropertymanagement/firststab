# Blueprint 06 — Cut Your AI Costs With a Free Local Model

**The problem:** The tools you build ask an AI model questions all day — "is this
urgent?", "summarize this", "score this 1–10." Each question costs a sliver of a
penny. By themselves they're nothing; thousands a month is a real bill. And most
of those questions are *easy* — you're paying premium cloud prices for work a
free model could do.

**What this builds:** A "traffic cop" that sits between your tools and the AI. It
sends the easy questions to a **free** model running on your own garage server,
and only pays for the smart cloud AI (Claude) when the job actually needs it. If
the free model is ever down, it automatically falls back to the cloud so nothing
breaks. The router code is already in your garage — this blueprint installs the
free model and switches it on.

**Time to build:** 1–2 hours (mostly the server waiting to download the model)

**What to have ready:**
- Your garage server should have at least **8 GB of RAM free** (the free model
  needs room to run). If you're not sure, that's fine — Jarvis will check.
- It's worth doing this *after* you've built a tool or two, so you have something
  real to point at the router.

---

## Hand This to Jarvis

*Open Claude Code. Copy everything below the line. Paste it. Hit enter.*

---

I want to cut what I spend on AI by routing the easy questions to a free model
running on my own garage server. The router code already exists in my garage at
`garage/tools/llm-router/` — I just need it installed and switched on.

Here's what I want, in plain steps. Walk me through it and **stop to explain
before anything that changes my server.** One thing at a time.

1. **Check my server can handle it.** Confirm my garage server has enough free
   memory to run a small local AI model (roughly 8 GB free). If it doesn't, tell
   me my options before doing anything — don't push ahead.

2. **Install the free local model.** Set up Ollama (the free local-AI program) on
   my garage server and download two small models: a tiny fast one for quick
   yes/no work, and a slightly bigger one for short summaries. Explain what each
   is for in plain language.

3. **Start the router.** Get the router tool in `garage/tools/llm-router/`
   running. Use my existing AI keys if I have them (so the paid "backup" lanes
   work too), but it should still save me money even with no cloud keys at all.

4. **Prove it works.** Send one easy test question through the router and show me
   the answer came back from the **free local model** at **$0 cost**. Then send
   one hard question and show it correctly used the smart cloud model.

5. **Point ONE of my existing tools at it.** Pick the simplest tool I've built
   that asks an AI something, and switch it to ask the router instead. Don't
   change all my tools at once — just one, so we can confirm it still works
   exactly the same before doing more.

Important guardrails — please follow these:

- **Anything private stays home.** If a tool handles a tenant's personal details,
  use the router's "keep it local" setting so that request never leaves my
  server. Tell me which of my tools that applies to.
- **Don't downgrade the important stuff.** Real writing to owners or tenants, and
  anything that has to be exactly right, should still go to the smart cloud model.
  The free model is for the easy, high-volume jobs only.
- Tell me, in plain English, roughly how much this is likely to save me each
  month based on the tools I have so far.

When you're done, give me a short summary: what's installed, which tool now uses
the router, and what to watch to confirm it's saving money.

---

## After it's running

Check the router's running total anytime — it tracks what each lane cost and how
many questions the free model handled for free. Ask Jarvis: *"show me the AI
router stats"* and it'll read the `/stats` page for you.

Once you trust it on one tool, hand Jarvis this same blueprint again and say
*"now point my other tools at the router too."* One at a time.
