#!/bin/bash
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}▸${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC}  $1"; }
fail() { echo -e "${RED}✗${NC}  $1"; exit 1; }

echo ""
echo "══════════════════════════════════════════"
echo "  Content Machine — Setup"
echo "══════════════════════════════════════════"
echo ""

# ── Preflight checks ──────────────────────────────────

[ -f .env ] || fail ".env not found. Copy .env.example to .env and fill in values."
source .env

[ -z "${N8N_HOST:-}" ] && fail "N8N_HOST not set in .env"
[ -z "${MIXPOST_HOST:-}" ] && fail "MIXPOST_HOST not set in .env"
[ -z "${N8N_ENCRYPTION_KEY:-}" ] && fail "N8N_ENCRYPTION_KEY not set in .env"
[ -z "${INTRKT_API_KEY:-}" ] && fail "INTRKT_API_KEY not set in .env"

command -v docker >/dev/null 2>&1 || fail "Docker not installed"
command -v node >/dev/null 2>&1 || fail "Node.js not installed (need v18+)"

# ── Start containers ──────────────────────────────────

log "Starting Docker services..."
docker compose up -d

# ── Download agent prompts ────────────────────────────

log "Downloading agency-agents prompts..."
if command -v git >/dev/null 2>&1; then
  TMPDIR_AGENTS=$(mktemp -d)
  git clone --depth 1 https://github.com/msitarzewski/agency-agents "$TMPDIR_AGENTS" 2>/dev/null || {
    warn "Could not clone agency-agents. Will create placeholder prompts."
    TMPDIR_AGENTS=""
  }
  if [ -n "$TMPDIR_AGENTS" ]; then
    mkdir -p data/agents
    cp "$TMPDIR_AGENTS/marketing/marketing-twitter-engager.md" data/agents/twitter-engager.txt 2>/dev/null || true
    cp "$TMPDIR_AGENTS/marketing/marketing-content-creator.md" data/agents/content-creator.txt 2>/dev/null || true
    cp "$TMPDIR_AGENTS/marketing/marketing-growth-hacker.md" data/agents/growth-hacker.txt 2>/dev/null || true
    cp "$TMPDIR_AGENTS/product/product-trend-researcher.md" data/agents/trend-researcher.txt 2>/dev/null || true
    rm -rf "$TMPDIR_AGENTS"
    log "Agent prompts downloaded."
  fi
fi

# Create placeholder files if download failed
mkdir -p data/agents
for agent in twitter-engager content-creator growth-hacker trend-researcher; do
  [ -f "data/agents/$agent.txt" ] || echo "# $agent agent prompt - populate from agency-agents repo" > "data/agents/$agent.txt"
done

# ── Wait for services ─────────────────────────────────

log "Waiting for Ollama..."
for i in $(seq 1 40); do
  curl -sf http://localhost:11434/api/tags >/dev/null 2>&1 && break
  sleep 3
  [ $i -eq 40 ] && fail "Ollama did not start in time"
done
log "Ollama ready."

log "Pulling ${OLLAMA_MODEL}..."
docker exec ollama ollama pull "${OLLAMA_MODEL}"
log "Model ready."

log "Waiting for n8n..."
for i in $(seq 1 40); do
  curl -sf http://localhost:5678/healthz >/dev/null 2>&1 && break
  sleep 3
  [ $i -eq 40 ] && fail "n8n did not start in time"
done
log "n8n ready."

log "Waiting for Mixpost..."
for i in $(seq 1 40); do
  curl -sf http://localhost:8888 >/dev/null 2>&1 && break
  sleep 3
  [ $i -eq 40 ] && fail "Mixpost did not start in time"
done
log "Mixpost ready."

# ── Copy data files into Docker volume ────────────────

log "Copying config files to Docker volume..."
docker cp data/. n8n:/data/ 2>/dev/null || {
  # Alternative: use volume mount
  docker run --rm -v content-machine_content_data:/data -v "$(pwd)/data":/src alpine cp -r /src/. /data/
}
docker exec n8n mkdir -p /data/state /data/learnings /data/state
log "Config files ready."

# ── Run seed script ───────────────────────────────────

log "Seeding n8n..."
cd seed
npm install --silent
node index.js
cd ..

echo ""
echo "══════════════════════════════════════════"
echo ""
echo -e "${GREEN}Setup complete!${NC}"
echo ""
echo "  n8n:      https://${N8N_HOST}"
echo "  Mixpost:  https://${MIXPOST_HOST}"
echo ""
echo -e "${YELLOW}REQUIRED: Manual OAuth setup (cannot be automated)${NC}"
echo "  See MANUAL_STEPS.md for the 4 steps to connect social accounts."
echo ""
echo "  After OAuth setup, run: node seed/finalize.js"
echo "══════════════════════════════════════════"
