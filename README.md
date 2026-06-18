# Wolf's Garage — Property Manager AI Dev Kit

You're not getting a finished car. You're getting a fully equipped garage,
a professional workbench, and a shelf of blueprints.

What you build is yours.

---

## What's in the Garage

**The Garage** — Your own private server (VPS) running in the cloud.
Claude Code lives here. Your tools run here. Nobody else has access.

**The Workbench** — A complete AI harness: Jarvis (your orchestrator) plus
14 specialist agents who handle research, building, testing, security, legal,
and more. You don't write code. You describe what you want. They build it.

**The Blueprint Shelf** — 5 ready-to-build PM projects. Each one is a prompt
you hand to Jarvis. It walks you through the build step by step.

---

## The 3 Steps

### Step 1 — Set Up Your Garage
Follow the class setup guide: [`setup/class-checklist.md`](setup/class-checklist.md)

This installs your server, connects Claude Code, and clones this repo.
Takes about 45 minutes. You only do this once.

### Step 2 — Personalize Your Workbench
Run the personalization prompt: [`setup/personalize.md`](setup/personalize.md)

This tells Claude your name, your company, your properties, and all the
tools you use. Claude reads this file at the start of every session.
The more it knows, the better it works. Takes about 10 minutes.

### Step 3 — Pick a Blueprint and Start Building
Browse the blueprint shelf: [`garage/blueprints/`](garage/)

Pick the problem that's costing you the most time or money. Hand the
blueprint to Jarvis. Your first real tool will be running by end of day.

---

## What You'll Need

| Requirement | Cost | Where to Get It |
|-------------|------|-----------------|
| Hostinger VPS | ~$5/month | hostinger.com |
| Anthropic API key | ~$5–15/month | console.anthropic.com |
| GitHub account | Free | github.com |
| Claude Code Desktop | Free | claude.ai/download |

**Total: roughly $10–20/month.** Less than a tank of gas.

---

## What's Inside

```
wolf-pack/
├── CLAUDE.md                    ← Claude's instruction manual — personalized for you
├── garage/
│   ├── blueprints/              ← 5 ready-to-build PM projects
│   │   ├── 01-lease-renewal-reminder.md
│   │   ├── 02-late-rent-tracker.md
│   │   ├── 03-maintenance-request-log.md
│   │   ├── 04-vacancy-tracker.md
│   │   └── 05-monthly-owner-report.md
├── projects/                    ← Your built tools go here
├── .claude/agents/              ← Your 14-agent dev team
│   ├── oracle.md  neo.md  q.md  tars.md  judge.md
│   ├── sentinel.md  scotty.md  tron.md  asimov.md
│   ├── hermes.md  ralph.md  viper.md  atlas.md  mason.md
└── setup/
    ├── class-checklist.md       ← Full setup walkthrough (start here)
    ├── personalize.md           ← Fill in your info (do this second)
    ├── first-session.md         ← Starter prompts once you're running
    └── vps-setup.sh             ← Automated server installer (runs once)
```

---

## The Mindset

You are not learning to code. You are learning to direct an AI that can code.

The skill is knowing what you want, describing it clearly, and recognizing a
good result when you see one. You've been doing that your whole career.
You just had different tools.

Welcome to the garage.
