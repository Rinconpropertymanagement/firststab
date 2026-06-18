# The Wolf Pack — Class Day Setup Guide
### Property Manager AI Setup — From Zero to Running in 90 Minutes

---

## What You'll Have by the End

By the time we're done, you will have:
- Your own private cloud server (like a computer that lives on the internet)
- Claude Code installed on it — your AI coding assistant
- Your own harness (think of it as Claude's instruction manual, written by you)
- Your own GitHub account to save and version your work

**No coding experience needed.** We will type commands together, step by step.

---

## What This Will Cost

| Item | Cost | Notes |
|------|------|-------|
| Hostinger VPS | ~$5/month | Cancel anytime |
| Anthropic API key | ~$5–15/month | Pay only for what you use |
| GitHub account | Free | |
| Claude Code app | Free | |

**Estimated monthly cost: $10–20/month.** Less than a tank of gas.

---

## Why Anthropic? What About ChatGPT or Gemini?

You may already pay for ChatGPT Plus ($20/mo) or Google Gemini. Here's what you need to know:

**Claude Code only works with Anthropic.** It's Anthropic's product — the same way
Apple Maps only works on Apple devices. You cannot swap it for OpenAI or Google.

**ChatGPT Plus and Gemini Advanced are chat tools, not coding assistants.**
They're great for writing and research, but they don't have the ability to
actually build and run software on your server the way Claude Code does.

**The Anthropic API costs much less than you think.** For a property manager
doing light building — a few sessions a week — expect $5–15/month. Not $20.
You are only charged for what you actually use.

**Bottom line:** Keep ChatGPT or Gemini if you use them for other things.
Add Anthropic as a separate, small account just for your building work.
It's the right tool for this job.

---

## Before You Come to Class

Please do these 3 things the day before. Each takes about 5 minutes.

**1. Create a Hostinger account**
- Go to: hostinger.com
- Click "Sign Up" — use your business email
- Add a credit card (nothing is charged until you create a server)

**2. Create a GitHub account**
- Go to: github.com
- Click "Sign up" — use the same business email
- Choose the free plan

**3. Download Claude Code Desktop**
- Go to: claude.ai/download
- Download for Mac or Windows
- Install it (double-click the installer, follow the prompts)

That's it. Come to class with those three things done and you're ahead of the game.

---

## Part 1 — Get Your Anthropic API Key (10 min)

Do this first — before creating the server — because the server setup will ask for it.

This key is what connects your server to Claude's AI brain. Think of it like
a SIM card: you need one per device, and you pay a small monthly fee based on usage.

1. Open a browser → go to: **console.anthropic.com**
2. Click **Sign up** (create a new account — separate from any Claude.ai account)
3. Verify your email, then log in
4. In the left sidebar, click **API Keys**
5. Click **+ Create Key**
6. Name it something like "My Property Manager Server" → click **Create Key**
7. **Copy the key immediately and paste it somewhere safe** (a notes app, email draft, etc.)
   You can only see it once. It looks like: `sk-ant-api03-...`
8. Go to **Billing** in the left sidebar → add a credit card → add $10 of credit to start

> **Tip:** $10 of Anthropic credit will last most people 1–3 months of light use.

---

## Part 2 — Create Your Server (15 min)

A "server" is just a computer that lives in a data center instead of on your desk.
You rent it by the month and can cancel anytime. Think of it like cloud storage,
except instead of storing files, you're running software.

### Step 2.1 — Create a VPS on Hostinger

1. Log into hostinger.com
2. In the top menu, click **VPS** → click **VPS Hosting**
3. Choose the **KVM 1** plan (~$5/month) → click **Add to Cart**
4. At checkout, confirm your order
5. After purchase, go to your **hPanel** (Hostinger's control panel)
6. Click **VPS** in the left sidebar → click on your new server
7. Under **OS**, click **Change OS** → select **Ubuntu 24.04** → confirm

### Step 2.2 — Set a root password

Still on your VPS page in hPanel:
1. Click **Root Password** (or "Manage" → "Root Password")
2. Set a password you'll remember — write it down
3. Click **Save**

### Step 2.3 — Find your IP address

On the same VPS page, look for your **IP Address** — it looks like `167.99.45.123`.
Write it down next to your password.

> **You now have:** An IP address and a root password. Keep both handy.

---

## Part 3 — Connect to Your Server (10 min)

Now we connect your laptop to your server. This is called SSH —
it's like a phone call between your computer and your server.

### Step 3.1 — Open Claude Code Desktop

Open the Claude Code app you installed before class.

At the bottom of the screen, you'll see a dark terminal panel.
Click inside it to activate it.

### Step 3.2 — SSH into your server

Type the following (replace `YOUR_IP` with the IP address from Step 2.3):

```
ssh root@YOUR_IP
```

Press **Enter**.

- If asked **"Are you sure you want to continue connecting?"** → type `yes` → Enter
- Type your root password when prompted (nothing appears as you type — that's normal)

When you see `root@vps-...:~#` you're in. You are now controlling your server.

---

## Part 4 — Run the Setup Script (10 min)

A "script" is a list of commands that runs automatically so you don't have to
type 50 commands by hand. This one installs everything your server needs.

Copy and paste this entire line into your terminal, then press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/wolf-pack/main/setup/vps-setup.sh | bash
```

Watch the progress. When it asks for your **Anthropic API key**, paste in the key
you saved in Part 1.

The script will test your key automatically — if it says ✓ "API key works!" you're good.

Then run:
```bash
source ~/.bashrc
```

---

## Part 5 — Fork and Clone Your Repo (10 min)

"Forking" means making your own personal copy of a starter template on GitHub.
"Cloning" means downloading that copy onto your server.

### Step 5.1 — Fork the template

1. Log into github.com
2. Go to: **github.com/YOUR_INSTRUCTOR_GITHUB/wolf-pack**
3. Click the **Fork** button (top right of the page)
4. Click **Create Fork** — leave all settings as-is
5. You now have your own copy at `github.com/YOUR_GITHUB_USERNAME/daedalus-starter`

### Step 5.2 — Copy your repo URL

On your forked repo page:
1. Click the green **Code** button
2. Make sure **HTTPS** is selected (not SSH)
3. Click the copy icon — this copies a URL that looks like:
   `https://github.com/YOUR_USERNAME/daedalus-starter.git`

### Step 5.3 — Clone it onto your server

Back in your terminal:

```bash
cd /root
git clone YOUR_REPO_URL wolf-pack
cd wolf-pack
```

Replace `YOUR_REPO_URL` with what you copied in Step 5.2.

---

## Part 6 — Personalize Your Harness (10 min)

Open your `CLAUDE.md` — this is the instruction manual you're writing for Claude.
It tells Claude who you are, what your business is, and how to help you.

```bash
nano CLAUDE.md
```

This opens a simple text editor. Make these changes:
- Replace `[YOUR NAME]` with your name
- Replace `[YOUR COMPANY NAME]` with your company
- Replace `[NUMBER]` and `[CITY/AREA]` with your info
- Update the sample properties with a couple of your real ones

To save and exit: press **Ctrl+X** → then **Y** → then **Enter**.

---

## Part 7 — Start Claude (5 min)

```bash
claude
```

Claude Code will start. Type this first message to test it:

```
Who am I and what is this server for?
```

Claude will read your CLAUDE.md and answer. If it knows your name and
describes your business — you're fully set up.

---

## You Did It!

| What you have | Where it is |
|---|---|
| Your cloud server | Running at your IP on Hostinger |
| Claude Code + API connection | Installed on your server |
| Your personal harness | `/root/wolf-pack/CLAUDE.md` |
| Your GitHub backup | `github.com/YOUR_USERNAME/daedalus-starter` |

**Next:** Open [`first-session.md`](first-session.md) to see what to actually build first.

---

## Troubleshooting

**"Connection refused" or can't connect to server**
→ Wait 2 more minutes — the server may still be booting. Try again.
→ Double-check the IP address from Hostinger hPanel.

**"Permission denied" when logging in**
→ Your password might be wrong. Go to Hostinger hPanel → VPS → Root Password → reset it.

**Script fails partway through**
→ Run `bash /tmp/vps-setup.sh` to retry, or paste the curl command again.

**"API key not found" or Claude won't start**
→ Run `source ~/.bashrc` first, then try `claude` again.
→ Make sure your Anthropic account has billing credit (console.anthropic.com → Billing).

**Anything else**
→ Ask Wolf. That's literally what he's there for.
