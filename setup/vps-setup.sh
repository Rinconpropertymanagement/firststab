#!/bin/bash
# ============================================================
#  The Wolf Pack — VPS Setup Script
#  Run this once on a fresh Ubuntu 22.04 or 24.04 server
#  Usage:  bash vps-setup.sh
# ============================================================

# Colors for friendly output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

ok()   { echo -e "  ${GREEN}✓${NC}  $1"; }
info() { echo -e "  ${BLUE}→${NC}  $1"; }
warn() { echo -e "  ${YELLOW}!${NC}  $1"; }
fail() { echo -e "  ${RED}✗${NC}  $1"; exit 1; }

echo ""
echo -e "${BOLD}============================================${NC}"
echo -e "${BOLD}       The Wolf Pack — Server Setup        ${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""
echo "This will take about 3-5 minutes."
echo "Just follow the prompts — you only do this once."
echo ""

# ── Step 1: System update ──────────────────────────────────
echo -e "${BOLD}Step 1 of 5 — Updating your server...${NC}"
apt-get update -qq && apt-get upgrade -y -qq
ok "Server is up to date"
echo ""

# ── Step 2: Install essentials ─────────────────────────────
echo -e "${BOLD}Step 2 of 5 — Installing tools...${NC}"
apt-get install -y -qq git curl wget unzip build-essential
ok "Git and curl installed"
echo ""

# ── Step 3: Install Node.js ────────────────────────────────
echo -e "${BOLD}Step 3 of 5 — Installing Node.js...${NC}"
if command -v node &> /dev/null; then
  ok "Node.js already installed ($(node --version))"
else
  curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs
  ok "Node.js $(node --version) installed"
fi
echo ""

# ── Step 4: Install Claude Code ───────────────────────────
echo -e "${BOLD}Step 4 of 5 — Installing Claude Code AI...${NC}"
npm install -g @anthropic-ai/claude-code > /dev/null 2>&1
ok "Claude Code installed"
echo ""

# ── Step 5: API Key setup ──────────────────────────────────
echo -e "${BOLD}Step 5 of 5 — Connect your Anthropic account${NC}"
echo ""
echo "  You need a personal API key from Anthropic."
echo "  If you don't have one yet:"
echo ""
echo -e "  ${BLUE}1.${NC} Open a browser and go to:  console.anthropic.com"
echo -e "  ${BLUE}2.${NC} Sign in or create a free account"
echo -e "  ${BLUE}3.${NC} Click 'API Keys' in the left menu"
echo -e "  ${BLUE}4.${NC} Click 'Create Key' and copy it"
echo ""
echo "  Your key looks like:  sk-ant-api03-..."
echo ""

while true; do
  read -p "  Paste your API key here and press Enter: " APIKEY
  echo ""

  if [[ -z "$APIKEY" ]]; then
    warn "No key entered. Try again."
    continue
  fi

  if [[ ! "$APIKEY" == sk-ant-* ]]; then
    warn "That doesn't look like an Anthropic key (should start with sk-ant-)."
    read -p "  Use it anyway? (y/n): " CONFIRM
    [[ "$CONFIRM" != "y" ]] && continue
  fi

  # Test the key with a quick API call
  info "Testing your API key..."
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "x-api-key: $APIKEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d '{"model":"claude-haiku-4-5-20251001","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}' \
    https://api.anthropic.com/v1/messages)

  if [[ "$HTTP_STATUS" == "200" ]]; then
    ok "API key works!"
    break
  elif [[ "$HTTP_STATUS" == "401" ]]; then
    warn "That key was rejected (incorrect or expired). Please double-check and try again."
  elif [[ "$HTTP_STATUS" == "429" ]]; then
    warn "Key looks valid but has hit a rate limit — that's fine, saving it anyway."
    break
  else
    warn "Could not verify key (network issue?). Saving it anyway."
    break
  fi
done

# Save to shell profile
grep -v "ANTHROPIC_API_KEY" ~/.bashrc > /tmp/.bashrc_tmp && mv /tmp/.bashrc_tmp ~/.bashrc
echo "" >> ~/.bashrc
echo "# Claude Code — Anthropic API Key" >> ~/.bashrc
echo "export ANTHROPIC_API_KEY=\"$APIKEY\"" >> ~/.bashrc
export ANTHROPIC_API_KEY="$APIKEY"

ok "API key saved"
echo ""

# ── Done ───────────────────────────────────────────────────
echo -e "${BOLD}============================================${NC}"
echo -e "${GREEN}${BOLD}   You're in the pack. Server is ready.${NC}"
echo -e "${BOLD}============================================${NC}"
echo ""
echo "  Run this command to activate your API key:"
echo ""
echo -e "  ${BOLD}source ~/.bashrc${NC}"
echo ""
echo "  Then clone your Wolf Pack repo and start Claude:"
echo ""
echo -e "  ${BOLD}cd /root && git clone YOUR_GITHUB_REPO_URL wolf-pack${NC}"
echo -e "  ${BOLD}cd wolf-pack && claude${NC}"
echo ""
