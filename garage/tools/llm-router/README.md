# The Money-Saver — A Local-First AI Router

**What it does in one sentence:** When the tools you build need to ask an AI a
question, this sends the cheap, simple questions to a **free** model running on
your own garage server, and only pays for the expensive cloud AI when the job
actually needs it.

---

## Why you'd want this

Every time one of your tools asks an AI model something — "is this a maintenance
emergency, yes or no?", "summarize this message", "score this review 1–10" — it
costs a little money. One call is a fraction of a penny. Thousands of calls a
month add up.

But here's the thing: **most of those questions are easy.** A small AI model
running for free on your own garage server can answer them perfectly well. You
only need the expensive, brilliant cloud model (Claude) for the hard stuff —
real reasoning, important writing, anything sensitive.

This router is the traffic cop. Every AI request goes through it, and it decides:

- **Easy job?** → Send it to the free local model. **Costs $0.**
- **Medium job?** → Send it to a cheap cloud model.
- **Hard job?** → Send it to Claude, the smart one.
- **Local model down?** → Automatically fall back to a cloud model so nothing breaks.

You write your tools once, pointed at the router. The router quietly saves you
money on every call.

---

## The three lanes

| Lane | When to use it | Who answers | Cost |
|------|----------------|-------------|------|
| `cheap` | Yes/no checks, scoring, short summaries, sorting | **Local model** (free) → cloud backup | $0 |
| `balanced` | Translations, suggestions, medium writing | Cheap cloud model → Claude backup | ~tiny |
| `smart` | Real reasoning, important emails, anything that has to be right | **Claude** | normal |

There's also a **privacy switch**: set `keep_local: true` and the request will
*only* ever touch your own server — it never goes to a cloud company. Good for
anything with a tenant's personal details in it.

> ⚠️ One honest limit: the free local model is small. It's great for the `cheap`
> lane (sorting, scoring, yes/no). It is **not** good at writing polished copy or
> producing strict computer-readable formats — send those to `balanced` or
> `smart`. Quality matters more than saving a fraction of a cent.

---

## How you actually turn it on (hand this to Jarvis)

You don't have to set this up by hand. There's a blueprint for it:

→ [`garage/blueprints/06-cut-ai-costs.md`](../../blueprints/06-cut-ai-costs.md)

Open Claude Code, paste that blueprint, and Jarvis (with Scotty, your server
specialist) will install the free local model, start the router, and wire your
tools to it. The section below is just here so you — or a curious student — can
see what's under the hood.

---

## Under the hood (for the curious)

It's a small web service. Your tools send it a request like this:

```json
POST http://localhost:3001/route
{
  "task": "cheap",
  "messages": [
    { "role": "user", "content": "Is this a maintenance emergency? YES or NO: heater broken, 35°F outside." }
  ]
}
```

…and it sends back the answer plus which model handled it and what it cost:

```json
{
  "content": "YES",
  "provider": "local",
  "model": "qwen2.5:7b",
  "cost_usd": 0,
  "latency_ms": 740,
  "cache_hit": false
}
```

**The pieces** (each file is small and commented so you can read it):

- `src/adapters/` — one small file per AI provider (local, OpenAI, Claude). They
  all follow the same shape, so **adding a new provider is a copy-paste-and-tweak
  job.** That's the whole lesson: every AI is just "send messages, get text back."
- `src/router.ts` — the traffic cop. Picks the lane, handles the free-first /
  fall-back-to-paid logic, remembers recent answers so repeats are free.
- `src/server.ts` — the little web service your tools talk to.

**To run it yourself:**

```bash
cd garage/tools/llm-router
cp .env.example .env        # then put your keys in .env
npm install
npm run dev                 # starts on http://localhost:3001
```

You only strictly need the local model (free) to get value out of it. The cloud
keys are optional — add them when you want the paid lanes as backup.

---

## A great learning exercise

The local-model adapter (`src/adapters/local.ts`) is already written as the
reference answer. If you want to *learn* how this works, try writing one of the
other adapters yourself by copying the local one and changing two things: the
address it talks to, and the price. That's genuinely all an "AI provider" is.
