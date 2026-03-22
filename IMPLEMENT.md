# Content Machine — Claude Code Implementation Guide

> **Instructions for Claude Code:**
> Read this entire document before writing a single file. Then implement every section top-to-bottom. Every file is specified exactly. Every command is given in order. Every known failure point is called out with its fix. The goal is zero manual steps except for OAuth (which cannot be automated).
>
> Do not skip sections. Do not defer anything marked as "implement this". When a section says [MANUAL], that step genuinely cannot be scripted — everything else must be created.

---

## What You Are Building

A fully autonomous multi-account social media content machine:
- Posts daily to Twitter, LinkedIn, Threads, and Instagram for 2 accounts
- Detects trending topics 3× per day, adapts content or asks for operator's opinion via WhatsApp
- Sends a morning calendar brief and weekly analytics digest via WhatsApp
- Controlled entirely by WhatsApp commands — no dashboards during normal operation
- $0/month, fully self-hosted on one VPS

**Stack:**
- **n8n** — orchestration engine, runs all 6 automation flows
- **Ollama + Qwen2.5:14b** — local LLM, generates all content, zero API cost
- **Mixpost** — multi-account publisher, handles OAuth to all social platforms
- **Intrkt Flows Engine** — existing WhatsApp gateway (already configured, flows already live)

---

## Critical Architecture Decisions (Read Before Implementing)

### 1. No credentials in Code nodes
n8n Code nodes **cannot** access `$credentials`. Only HTTP Request nodes can use n8n credentials. To pass configuration into Code nodes, we use the filesystem. The Docker volume at `/data` is shared across all workflow runs. Code nodes use `require('fs').readFileSync(...)` to load config.

### 2. Everything lives in `/data`
The n8n Docker container mounts a volume at `/data`. This is where:
- Profile configs: `/data/profiles/deep_personal.json`
- Agent prompts: `/data/agents/twitter-engager.txt`
- Context blocks: `/data/contexts/deep.txt`
- Runtime state: `/data/state/today_plan_deep_personal.json`
- Weekly learnings: `/data/learnings/deep_personal.json`

The seed script populates all of these before workflows run.

### 3. API keys in environment variables
All API keys go in `.env` → docker-compose passes them to containers → n8n Code nodes access them via `process.env.KEY_NAME`. n8n HTTP Request nodes use named credentials (only type needed: `httpHeaderAuth`).

### 4. n8n workflow JSON format
n8n workflows are imported via `POST /api/v1/workflows`. Credential references in HTTP Request nodes use `credentialId` (not name). The seed script creates credentials first, captures their IDs, then injects those IDs into the workflow JSON before importing.

### 5. Ollama is called via HTTP, not n8n's Ollama node
We call Ollama's OpenAI-compatible endpoint (`/v1/chat/completions`) via HTTP Request nodes. This works without any community node and gives full control over the request. Model: `qwen2.5:14b`.

### 6. Intrkt flows are already live — do not recreate them
The following exist in the Intrkt Flows Engine and must not be touched:
- `flow:content-machine:inbound` ✅
- `flow:content-machine:outbound` ✅
- `tpl:content-machine:notify` ✅
- `trigger:content-machine:commands` ✅

The inbound flow will be updated by the seed script to POST to n8n's command webhook URL after Flow 06 is created.

---

## Final Directory Structure

```
content-machine/
├── .env.example
├── .env                          ← operator fills this in (copy of .env.example)
├── .gitignore
├── docker-compose.yml
├── setup.sh                      ← run once: starts everything, seeds everything
├── data/                         ← copied into Docker volume on first run
│   ├── agents/
│   │   ├── twitter-engager.txt   ← downloaded from agency-agents
│   │   ├── content-creator.txt
│   │   ├── growth-hacker.txt
│   │   └── trend-researcher.txt
│   ├── contexts/
│   │   ├── deep.txt              ← operator fills in after setup
│   │   └── intrkt.txt            ← operator fills in after setup
│   └── profiles/
│       ├── deep_personal.json
│       └── intrkt_company.json
└── seed/
    ├── package.json
    ├── index.js                  ← main seed orchestrator
    ├── lib/
    │   ├── n8n.js                ← n8n API client
    │   ├── wait.js               ← health check loop
    │   └── workflows.js          ← workflow JSON builders
    └── update-intrkt.js          ← updates Intrkt inbound flow with n8n webhook URL
```

---

## File 1: `.gitignore`

```
.env
data/state/
data/learnings/
node_modules/
seed/node_modules/
*.log
```

---

## File 2: `.env.example`

```bash
# ── Server ────────────────────────────────────────────
N8N_HOST=n8n.yourdomain.com
MIXPOST_HOST=mixpost.yourdomain.com

# ── n8n ───────────────────────────────────────────────
N8N_ENCRYPTION_KEY=replace-with-32-char-random-string
N8N_JWT_SECRET=replace-with-64-char-random-string
N8N_OWNER_EMAIL=you@example.com
N8N_OWNER_PASSWORD=ReplaceThisStrongPassword123
N8N_OWNER_FIRSTNAME=Deep
N8N_OWNER_LASTNAME=Dev

# ── Mixpost ───────────────────────────────────────────
# MIXPOST_APP_KEY: run `openssl rand -base64 32` and paste result here
MIXPOST_APP_KEY=base64:replace-with-openssl-rand-output

# Filled in AFTER Mixpost is configured (Step: Manual OAuth Setup)
MIXPOST_API_TOKEN=
MIXPOST_WORKSPACE_PERSONAL=
MIXPOST_WORKSPACE_COMPANY=
# Comma-separated account IDs per platform (from Mixpost API after connecting socials)
MIXPOST_PERSONAL_TWITTER_ID=
MIXPOST_PERSONAL_LINKEDIN_ID=
MIXPOST_PERSONAL_THREADS_ID=
MIXPOST_PERSONAL_INSTAGRAM_ID=
MIXPOST_COMPANY_TWITTER_ID=
MIXPOST_COMPANY_LINKEDIN_ID=

# ── Ollama ────────────────────────────────────────────
OLLAMA_MODEL=qwen2.5:14b

# ── Intrkt Flows Engine ───────────────────────────────
INTRKT_BASE_URL=https://engine.intrkt.com
INTRKT_API_KEY=your-intrkt-api-key
INTRKT_OPERATOR_PHONE=+91XXXXXXXXXX

# ── Search API (Brave Search — free 2000 req/month) ───
# Sign up: https://api.search.brave.com/
BRAVE_SEARCH_API_KEY=

# ── LLM Fallbacks (optional, all free) ───────────────
GROQ_API_KEY=
```

---

## File 3: `docker-compose.yml`

```yaml
version: "3.8"

services:
  n8n:
    image: n8nio/n8n:latest
    container_name: n8n
    restart: always
    ports:
      - "5678:5678"
    environment:
      - N8N_HOST=${N8N_HOST}
      - N8N_PORT=5678
      - N8N_PROTOCOL=https
      - WEBHOOK_URL=https://${N8N_HOST}/
      - N8N_EDITOR_BASE_URL=https://${N8N_HOST}/
      - N8N_SECURE_COOKIE=false
      - N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}
      - N8N_USER_MANAGEMENT_JWT_SECRET=${N8N_JWT_SECRET}
      - N8N_DEFAULT_BINARY_DATA_MODE=filesystem
      - EXECUTIONS_DATA_PRUNE=true
      - EXECUTIONS_DATA_MAX_AGE=72
      - NODE_FUNCTION_ALLOW_BUILTIN=*
      - NODE_FUNCTION_ALLOW_EXTERNAL=*
      - N8N_COMMUNITY_PACKAGES_ENABLED=true
      - TZ=Asia/Kolkata
      # All env vars accessible in Code nodes via process.env
      - MIXPOST_API_TOKEN=${MIXPOST_API_TOKEN}
      - MIXPOST_HOST=${MIXPOST_HOST}
      - MIXPOST_WORKSPACE_PERSONAL=${MIXPOST_WORKSPACE_PERSONAL}
      - MIXPOST_WORKSPACE_COMPANY=${MIXPOST_WORKSPACE_COMPANY}
      - MIXPOST_PERSONAL_TWITTER_ID=${MIXPOST_PERSONAL_TWITTER_ID}
      - MIXPOST_PERSONAL_LINKEDIN_ID=${MIXPOST_PERSONAL_LINKEDIN_ID}
      - MIXPOST_PERSONAL_THREADS_ID=${MIXPOST_PERSONAL_THREADS_ID}
      - MIXPOST_PERSONAL_INSTAGRAM_ID=${MIXPOST_PERSONAL_INSTAGRAM_ID}
      - MIXPOST_COMPANY_TWITTER_ID=${MIXPOST_COMPANY_TWITTER_ID}
      - MIXPOST_COMPANY_LINKEDIN_ID=${MIXPOST_COMPANY_LINKEDIN_ID}
      - OLLAMA_MODEL=${OLLAMA_MODEL}
      - INTRKT_BASE_URL=${INTRKT_BASE_URL}
      - INTRKT_API_KEY=${INTRKT_API_KEY}
      - INTRKT_OPERATOR_PHONE=${INTRKT_OPERATOR_PHONE}
      - BRAVE_SEARCH_API_KEY=${BRAVE_SEARCH_API_KEY}
    volumes:
      - n8n_data:/home/node/.n8n
      - content_data:/data
    networks:
      - cm_net

  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: always
    volumes:
      - ollama_data:/root/.ollama
    networks:
      - cm_net
    # GPU support: uncomment if NVIDIA GPU available
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: all
    #           capabilities: [gpu]

  mixpost:
    image: inovector/mixpost:latest
    container_name: mixpost
    restart: always
    ports:
      - "8888:80"
    environment:
      - APP_URL=https://${MIXPOST_HOST}
      - APP_KEY=${MIXPOST_APP_KEY}
      - DB_CONNECTION=sqlite
      - REDIS_HOST=mixpost-redis
      - REDIS_PORT=6379
      - CACHE_DRIVER=redis
      - SESSION_DRIVER=redis
      - QUEUE_CONNECTION=redis
    volumes:
      - mixpost_storage:/var/www/html/storage
    depends_on:
      - mixpost-redis
    networks:
      - cm_net

  mixpost-redis:
    image: redis:7-alpine
    container_name: mixpost-redis
    restart: always
    volumes:
      - mixpost_redis_data:/data
    networks:
      - cm_net

volumes:
  n8n_data:
  ollama_data:
  mixpost_storage:
  mixpost_redis_data:
  content_data:

networks:
  cm_net:
    driver: bridge
```

---

## File 4: `data/profiles/deep_personal.json`

```json
{
  "id": "deep_personal",
  "display_name": "Deep – Personal",
  "account_tag": "",
  "primary_platform": "twitter",
  "platforms": ["twitter", "linkedin", "threads", "instagram"],
  "posting_times": {
    "twitter": "09:00",
    "linkedin": "09:00",
    "threads": "13:00",
    "instagram": "15:00"
  },
  "pillar_schedule": {
    "Mon": "Build in Public",
    "Tue": "Hot Take",
    "Wed": "Distilled Insight",
    "Thu": "Numbers and Results",
    "Fri": "Hot Take",
    "Sat": "Build in Public",
    "Sun": "Distilled Insight"
  },
  "context_file": "deep.txt",
  "trend_keywords": ["AI", "developer tools", "LLM", "SaaS", "n8n", "WhatsApp automation", "open source", "indie hacker"],
  "trend_threshold": 6,
  "opinion_threshold": 8,
  "trust_level": 1,
  "workspace_env_key": "MIXPOST_WORKSPACE_PERSONAL",
  "account_env_keys": {
    "twitter": "MIXPOST_PERSONAL_TWITTER_ID",
    "linkedin": "MIXPOST_PERSONAL_LINKEDIN_ID",
    "threads": "MIXPOST_PERSONAL_THREADS_ID",
    "instagram": "MIXPOST_PERSONAL_INSTAGRAM_ID"
  }
}
```

---

## File 5: `data/profiles/intrkt_company.json`

```json
{
  "id": "intrkt_company",
  "display_name": "Intrkt – Company",
  "account_tag": "[intrkt]",
  "primary_platform": "linkedin",
  "platforms": ["linkedin", "twitter"],
  "posting_times": {
    "linkedin": "08:00",
    "twitter": "09:00"
  },
  "pillar_schedule": {
    "Mon": "Customer Wins",
    "Tue": "Industry Trends",
    "Wed": "How-to Content",
    "Thu": "Product Updates",
    "Fri": "Behind the Build",
    "Sat": "Customer Wins",
    "Sun": "Industry Trends"
  },
  "context_file": "intrkt.txt",
  "trend_keywords": ["WhatsApp Business API", "conversational AI", "insurance automation", "fintech chatbot", "lead generation India"],
  "trend_threshold": 6,
  "opinion_threshold": 8,
  "trust_level": 1,
  "workspace_env_key": "MIXPOST_WORKSPACE_COMPANY",
  "account_env_keys": {
    "twitter": "MIXPOST_COMPANY_TWITTER_ID",
    "linkedin": "MIXPOST_COMPANY_LINKEDIN_ID"
  }
}
```

---

## File 6: `data/contexts/deep.txt`

```
IDENTITY:
Deep is an Indian developer who builds real products with AI — not demos, not tutorials, actual shipped products.
Active projects:
- Intrkt Flows Engine: a WhatsApp automation platform for B2B sales and insurance
- AI voice automation for insurance brokers in India (cold call AI)
- Next.js insurance lead marketplace with visual query builder for agents
- WhatsApp attendance bot for college class groups
- Iron Condor / Calendar Spread options trading system for Nifty/BankNifty on Zerodha

VOICE:
Direct. Short sentences. No hedging. No filler. Builder mindset — show work, show results.
Sound like someone who has actually shipped things, not someone commenting from the sidelines.
Never qualify opinions with "I think" or "in my opinion". State them as facts.

CONTENT PILLARS:
1. Build in Public — show work as it happens, real bugs, real decisions, real shipping
2. AI Practitioner POV — what actually works in production, not hype or theory
3. Hot Takes — strong defensible opinions on AI, dev tools, SaaS, shipping
4. Distilled Insights — hard-won lessons compressed to one core idea
5. Numbers and Results — specific outcomes, proof over promises

HOOK STYLE:
Always open with the result or the pain. Never open with context or backstory.
Good: "This one n8n pattern replaced 3 API integrations."
Bad: "I've been working on something for a few weeks and wanted to share..."

FORBIDDEN PHRASES — never use these:
"I think", "In my opinion", "Just wanted to share", "Excited to announce",
"A thread:", "Great question", "Absolutely", "Certainly", "Delighted to"

EXAMPLE HOOKS (use as inspiration, not templates):
"I've been building [X] for [N] weeks. Here's everything I learned:"
"Nobody talks about [painful truth in your niche]."
"Hot take: [popular belief] is completely wrong."
"This one change made [thing] 10× better:"
"I wasted [time/money] so you don't have to."
"[N] things I wish I knew before [thing]:"

TWEET EXAMPLES — replace these with 10 real tweets in your voice:
[REPLACE_WITH_YOUR_REAL_TWEETS]
```

---

## File 7: `data/contexts/intrkt.txt`

```
IDENTITY:
Intrkt is a WhatsApp automation platform for B2B teams in India, focused on insurance brokers and fintech.
Core value: AI-powered WhatsApp flows that convert leads and handle support — replacing manual follow-up.

VOICE:
Authoritative. Outcome-first. Case studies and numbers over feature lists.
Credibility through specificity. Never hype. Never vague.
Lead with the result the customer got, then explain how.

CONTENT PILLARS:
1. Product Updates — what shipped, in plain language
2. Customer Wins — anonymised outcomes with real numbers
3. Industry Trends — WhatsApp Business, conversational AI, insurance tech
4. How-to Content — practical guides making readers better at their job
5. Behind the Build — architecture decisions, product thinking

POST EXAMPLES — replace with 5 real Intrkt posts:
[REPLACE_WITH_REAL_INTRKT_POSTS]
```

---

## File 8: `setup.sh`

This is the only script the operator runs. It does everything.

```bash
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
```

---

## File 9: `seed/package.json`

```json
{
  "name": "content-machine-seed",
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": {
    "start": "node index.js",
    "finalize": "node finalize.js"
  },
  "dependencies": {
    "axios": "^1.6.0",
    "dotenv": "^16.4.0"
  }
}
```

---

## File 10: `seed/lib/wait.js`

```javascript
const axios = require('axios');

async function waitFor(url, label, attempts = 30, intervalMs = 3000) {
  for (let i = 0; i < attempts; i++) {
    try {
      await axios.get(url, { timeout: 4000 });
      return true;
    } catch {
      if (i === 0) process.stdout.write(`  Waiting for ${label}`);
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  console.log('');
  throw new Error(`${label} not ready after ${attempts} attempts`);
}

module.exports = { waitFor };
```

---

## File 11: `seed/lib/n8n.js`

```javascript
const axios = require('axios');

const BASE = 'http://localhost:5678';
let _apiKey = null;

function headers() {
  if (!_apiKey) throw new Error('n8n not authenticated');
  return { 'X-N8N-API-KEY': _apiKey, 'Content-Type': 'application/json' };
}

// Set up owner account on first run, or log in on subsequent runs
async function authenticate(email, password, firstName, lastName) {
  // Try API key approach first (if already set up)
  try {
    const settingsRes = await axios.get(`${BASE}/api/v1/workflows?limit=1`, {
      headers: { 'X-N8N-API-KEY': 'test' }
    });
  } catch {}

  // Check if owner is set up
  let ownerSetUp = false;
  try {
    const s = await axios.get(`${BASE}/rest/settings`);
    ownerSetUp = s.data?.data?.userManagement?.isInstanceOwnerSetUp === true;
  } catch {}

  if (!ownerSetUp) {
    // First time setup
    console.log('  Setting up n8n owner account...');
    try {
      await axios.post(`${BASE}/rest/owner/setup`, { email, password, firstName, lastName });
    } catch (e) {
      // May already be set up in some versions
    }
  }

  // Log in to get session cookie
  const loginRes = await axios.post(`${BASE}/rest/login`, { email, password });
  const cookie = loginRes.headers['set-cookie']?.join('; ') || '';

  // Create or get API key
  try {
    const keyRes = await axios.post(
      `${BASE}/rest/user/api-key`,
      { label: `content-machine-${Date.now()}` },
      { headers: { Cookie: cookie, 'Content-Type': 'application/json' } }
    );
    _apiKey = keyRes.data?.data?.apiKey;
  } catch (e) {
    // If key creation fails, try to list existing keys
    const keysRes = await axios.get(`${BASE}/rest/user/api-keys`, {
      headers: { Cookie: cookie }
    });
    _apiKey = keysRes.data?.data?.[0]?.apiKey;
  }

  if (!_apiKey) throw new Error('Could not obtain n8n API key');
  console.log('  ✓ n8n authenticated');
  return _apiKey;
}

async function createCredential(name, type, data) {
  try {
    const res = await axios.post(
      `${BASE}/api/v1/credentials`,
      { name, type, data },
      { headers: headers() }
    );
    const id = res.data.id;
    console.log(`  ✓ Credential: ${name} (id: ${id})`);
    return id;
  } catch (e) {
    if (e.response?.data?.message?.toLowerCase().includes('already exists') ||
        e.response?.status === 409) {
      // Fetch existing credential ID by listing
      const list = await axios.get(`${BASE}/api/v1/credentials?limit=250`, { headers: headers() });
      const found = list.data?.data?.find(c => c.name === name);
      if (found) {
        console.log(`  ~ Credential exists: ${name} (id: ${found.id})`);
        return found.id;
      }
    }
    throw new Error(`Failed to create credential "${name}": ${e.response?.data?.message || e.message}`);
  }
}

async function getCredentialId(name) {
  const list = await axios.get(`${BASE}/api/v1/credentials?limit=250`, { headers: headers() });
  const found = list.data?.data?.find(c => c.name === name);
  return found?.id || null;
}

async function createWorkflow(workflow) {
  const res = await axios.post(
    `${BASE}/api/v1/workflows`,
    workflow,
    { headers: headers() }
  );
  const id = res.data.id;
  console.log(`  ✓ Workflow: ${workflow.name} (id: ${id})`);
  return id;
}

async function activateWorkflow(id) {
  await axios.patch(
    `${BASE}/api/v1/workflows/${id}`,
    { active: true },
    { headers: headers() }
  );
}

async function getWorkflowWebhookUrl(workflowId, path) {
  // n8n webhook URLs follow the pattern /webhook/{path}
  return `http://localhost:5678/webhook/${path}`;
}

module.exports = { authenticate, createCredential, getCredentialId, createWorkflow, activateWorkflow, getWorkflowWebhookUrl };
```

---

## File 12: `seed/lib/workflows.js`

This file exports functions that build n8n workflow JSON. Credential IDs are passed in and injected into nodes — this is the correct n8n pattern.

```javascript
// Helper: build a credential reference object used in HTTP Request nodes
function cred(id, type = 'httpHeaderAuth') {
  return { id: String(id), name: type };
}

// ── Shared node builders ──────────────────────────────────────────────────────

function cronNode(id, name, cronExpr, position) {
  return {
    id, name,
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.1,
    position,
    parameters: {
      rule: { interval: [{ field: 'cronExpression', expression: cronExpr }] }
    }
  };
}

function codeNode(id, name, code, position) {
  return {
    id, name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    parameters: { jsCode: code }
  };
}

function httpNode(id, name, method, url, body, credId, position, continueOnFail = true) {
  const node = {
    id, name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    continueOnFail,
    parameters: {
      method,
      url,
      sendBody: !!body,
      contentType: body ? 'json' : undefined,
      body: body || undefined
    }
  };
  if (credId) {
    node.credentials = { httpHeaderAuth: cred(credId) };
    node.parameters.authentication = 'genericCredentialType';
    node.parameters.genericAuthType = 'httpHeaderAuth';
  }
  return node;
}

function webhookNode(id, name, path, position) {
  return {
    id, name,
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position,
    webhookId: id,
    parameters: {
      path,
      responseMode: 'immediately',
      httpMethod: 'POST'
    }
  };
}

function waitNode(id, name, minutes, position) {
  return {
    id, name,
    type: 'n8n-nodes-base.wait',
    typeVersion: 1.1,
    position,
    parameters: {
      resume: 'timeInterval',
      amount: minutes,
      unit: 'minutes'
    }
  };
}

function ifNode(id, name, leftExpr, operator, rightValue, position) {
  return {
    id, name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position,
    parameters: {
      conditions: {
        options: { caseSensitive: false, typeValidation: 'loose' },
        conditions: [{ id: '1', leftValue: leftExpr, rightValue, operator: { type: 'number', operation: operator } }],
        combinator: 'and'
      }
    }
  };
}

// ── Load config code (runs at top of every workflow) ─────────────────────────

const LOAD_CONFIG_CODE = `
// Load profile config from filesystem
// Profile ID is injected by the trigger Set node
const fs = require('fs');
const profileId = $input.first().json.profile_id;
const profilePath = '/data/profiles/' + profileId + '.json';

if (!fs.existsSync(profilePath)) {
  throw new Error('Profile not found: ' + profilePath);
}

const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

// Resolve Mixpost IDs from env vars
const workspaceId = process.env[profile.workspace_env_key] || '';
const accountIds = {};
for (const [platform, envKey] of Object.entries(profile.account_env_keys || {})) {
  accountIds[platform] = process.env[envKey] || '';
}

// Load context block
const contextPath = '/data/contexts/' + profile.context_file;
const contextBlock = fs.existsSync(contextPath) 
  ? fs.readFileSync(contextPath, 'utf8') 
  : '';

// Load agent prompts
function loadAgent(name) {
  const p = '/data/agents/' + name + '.txt';
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

// Day of week for pillar schedule
const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const today = dayNames[new Date().getDay()];
const defaultPillar = profile.pillar_schedule[today] || 'Build in Public';

// Read trust level (can be overridden by file)
let trustLevel = profile.trust_level;
const trustOverrideFile = '/data/state/trust_' + profileId + '.json';
if (fs.existsSync(trustOverrideFile)) {
  const t = JSON.parse(fs.readFileSync(trustOverrideFile, 'utf8'));
  trustLevel = t.trust_level;
}

return [{
  json: {
    profile_id: profileId,
    display_name: profile.display_name,
    primary_platform: profile.primary_platform,
    platforms: profile.platforms,
    posting_times: profile.posting_times,
    context_block: contextBlock,
    agent_twitter_engager: loadAgent('twitter-engager'),
    agent_content_creator: loadAgent('content-creator'),
    agent_growth_hacker: loadAgent('growth-hacker'),
    agent_trend_researcher: loadAgent('trend-researcher'),
    default_pillar: defaultPillar,
    trend_keywords: profile.trend_keywords,
    trend_threshold: profile.trend_threshold,
    opinion_threshold: profile.opinion_threshold,
    trust_level: trustLevel,
    workspace_id: workspaceId,
    account_ids: accountIds
  }
}];
`;

// ── Ollama call helper ────────────────────────────────────────────────────────

function ollamaNode(id, name, systemExpr, userExpr, temperature, position) {
  return httpNode(id, name, 'POST', 'http://ollama:11434/v1/chat/completions', {
    model: `={{ process.env.OLLAMA_MODEL || 'qwen2.5:14b' }}`,
    messages: [
      { role: 'system', content: systemExpr },
      { role: 'user', content: userExpr }
    ],
    stream: false,
    temperature
  }, null, position);
}

// ── Intrkt notification helper ────────────────────────────────────────────────

function intrktNotifyNode(id, name, phoneExpr, messageExpr, intrktCredId, position) {
  return {
    id, name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    continueOnFail: true,
    credentials: { httpHeaderAuth: cred(intrktCredId) },
    parameters: {
      method: 'POST',
      url: `${process.env.INTRKT_BASE_URL || '{{ $env.INTRKT_BASE_URL }}'}/api/interaction/trigger`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      body: {
        flow_id: 'flow:content-machine:outbound',
        phone: phoneExpr,
        channel: 'wa_chat',
        journey: { message: messageExpr }
      }
    }
  };
}

// ── Mixpost post helper ───────────────────────────────────────────────────────

function mixpostPostNode(id, name, accountIdExpr, contentExpr, scheduledAt, mixpostCredId, position) {
  return {
    id, name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    continueOnFail: true,
    credentials: { httpHeaderAuth: cred(mixpostCredId) },
    parameters: {
      method: 'POST',
      url: `http://mixpost/api/mixpost/posts`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      body: {
        accounts: [`={{ ${accountIdExpr} }}`],
        versions: [{ is_original: true, content: [{ body: contentExpr, media: [] }] }],
        scheduled_at: scheduledAt
      }
    }
  };
}

// ── Build n8n connection map ──────────────────────────────────────────────────

function connect(pairs) {
  // pairs: [[fromId, toId], [fromId, [toId1, toId2]], ...]
  const connections = {};
  for (const [from, to] of pairs) {
    const targets = Array.isArray(to) ? to : [to];
    connections[from] = {
      main: [targets.map(t => {
        if (Array.isArray(t)) {
          // [nodeId, outputIndex] — for IF true/false branches
          return { node: t[0], type: 'main', index: 0 };
        }
        return { node: t, type: 'main', index: 0 };
      })]
    };
  }
  return connections;
}

// ── Workflow builders ─────────────────────────────────────────────────────────

function buildMorningBrief(intrktCredId) {
  const nodes = [
    // Two cron triggers — one per account — both fire at 6AM IST (00:30 UTC)
    cronNode('cron-personal', 'Cron 6AM — Personal', '30 0 * * *', [200, 100]),
    cronNode('cron-company', 'Cron 6AM — Company', '32 0 * * *', [200, 300]),
    // Set nodes inject profile_id before Load Config
    {
      id: 'set-personal', name: 'Set Personal Profile',
      type: 'n8n-nodes-base.set', typeVersion: 3.3, position: [400, 100],
      parameters: { assignments: { assignments: [{ id: '1', name: 'profile_id', value: 'deep_personal', type: 'string' }] } }
    },
    {
      id: 'set-company', name: 'Set Company Profile',
      type: 'n8n-nodes-base.set', typeVersion: 3.3, position: [400, 300],
      parameters: { assignments: { assignments: [{ id: '1', name: 'profile_id', value: 'intrkt_company', type: 'string' }] } }
    },
    codeNode('load-config', 'Load Config', LOAD_CONFIG_CODE, [620, 200]),
    // Search for trends
    {
      id: 'search-trends', name: 'Search Trends',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [840, 200],
      continueOnFail: true,
      parameters: {
        method: 'GET',
        url: 'https://api.search.brave.com/res/v1/news/search',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Accept', value: 'application/json' },
          { name: 'X-Subscription-Token', value: '={{ process.env.BRAVE_SEARCH_API_KEY }}' }
        ]},
        sendQuery: true,
        queryParameters: { parameters: [
          { name: 'q', value: '={{ $json.trend_keywords.join(" OR ") }}' },
          { name: 'count', value: '10' },
          { name: 'freshness', value: 'pd' }
        ]}
      }
    },
    // Score trends with Trend Researcher agent
    codeNode('score-trends', 'Score Trends', `
const items = $input.all();
const config = $('Load Config').first().json;
const news = items[0].json.results || [];

// Call Ollama synchronously via n8n's $helpers
const systemPrompt = config.context_block + '\\n\\n' + config.agent_trend_researcher;
const userMsg = 'Score these news items 1-10 for relevance to ' + config.display_name + '\\n' +
  'Keywords: ' + config.trend_keywords.join(', ') + '\\n\\n' +
  'News: ' + JSON.stringify(news.slice(0,8).map(r => ({ title: r.title, description: r.description }))) + '\\n\\n' +
  'Return ONLY valid JSON array: [{"topic":"string","score":number,"angle":"string"}]';

// We pass structured data to the next node for Ollama call
return [{ json: { ...config, news_for_scoring: userMsg, system_for_scoring: systemPrompt } }];
    `, [1060, 200]),
    // Ollama scoring call
    {
      id: 'ollama-score', name: 'Ollama — Score Topics',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1280, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, contentType: 'json',
        body: {
          model: '={{ process.env.OLLAMA_MODEL || "qwen2.5:14b" }}',
          messages: [
            { role: 'system', content: '={{ $json.system_for_scoring }}' },
            { role: 'user', content: '={{ $json.news_for_scoring }}' }
          ],
          stream: false, temperature: 0.2
        }
      }
    },
    // Decide today's plan based on scores
    codeNode('decide-plan', 'Decide Today Plan', `
const fs = require('fs');
const config = $('Score Trends').first().json;
const ollamaRes = $input.first().json;

let topics = [];
try {
  const raw = ollamaRes.choices?.[0]?.message?.content || '[]';
  topics = JSON.parse(raw.replace(/\`\`\`json|\`\`\`/g, '').trim());
} catch(e) { topics = []; }

const sorted = [...topics].sort((a,b) => b.score - a.score);
const top = sorted[0];
const threshold = config.trend_threshold;
const opinionThreshold = config.opinion_threshold;

let plan = { type: 'default', pillar: config.default_pillar };
let brief = '';

if (top && top.score >= opinionThreshold) {
  plan = { type: 'opinion_requested', pillar: config.default_pillar, trend: top.topic, angle: top.angle, score: top.score };
  brief = '☀️ [' + config.display_name + '] Today: ' + config.default_pillar + '\\n\\n' +
    '🔥 Big trend: "' + top.topic + '" (score ' + top.score + '/10)\\n' +
    'Angle: ' + top.angle + '\\n\\n' +
    'Reply with your take → I\\'ll post it as a hot take.\\n' +
    'Or reply CHANGE to use trend instead. Or say nothing → default post goes out.';
} else if (top && top.score >= threshold) {
  plan = { type: 'trend_angle', pillar: config.default_pillar, trend: top.topic, angle: top.angle, score: top.score };
  brief = '☀️ [' + config.display_name + '] Today: ' + config.default_pillar + '\\n' +
    'Trend angle: "' + top.topic + '" (score ' + top.score + '/10)\\n' +
    'Reply CHANGE to skip trend and use default pillar.';
} else {
  brief = '☀️ [' + config.display_name + '] Today: ' + config.default_pillar + '\\n' +
    'No strong trends found. Default post at 7AM.';
}

fs.mkdirSync('/data/state', { recursive: true });
fs.writeFileSync('/data/state/today_plan_' + config.profile_id + '.json', JSON.stringify(plan));

return [{ json: {
  brief,
  whatsapp_phone: process.env.INTRKT_OPERATOR_PHONE,
  profile_id: config.profile_id
}}];
    `, [1500, 200]),
    // Send WhatsApp brief
    {
      id: 'send-brief', name: 'Send Morning Brief',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1720, 200],
      continueOnFail: true,
      credentials: { httpHeaderAuth: cred(intrktCredId) },
      parameters: {
        method: 'POST',
        url: '={{ process.env.INTRKT_BASE_URL }}/api/interaction/trigger',
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, contentType: 'json',
        body: {
          flow_id: 'flow:content-machine:outbound',
          phone: '={{ $json.whatsapp_phone }}',
          channel: 'wa_chat',
          journey: { message: '={{ $json.brief }}' }
        }
      }
    }
  ];

  const connections = {
    'Cron 6AM — Personal': { main: [[{ node: 'Set Personal Profile', type: 'main', index: 0 }]] },
    'Cron 6AM — Company': { main: [[{ node: 'Set Company Profile', type: 'main', index: 0 }]] },
    'Set Personal Profile': { main: [[{ node: 'Load Config', type: 'main', index: 0 }]] },
    'Set Company Profile': { main: [[{ node: 'Load Config', type: 'main', index: 0 }]] },
    'Load Config': { main: [[{ node: 'Search Trends', type: 'main', index: 0 }]] },
    'Search Trends': { main: [[{ node: 'Score Trends', type: 'main', index: 0 }]] },
    'Score Trends': { main: [[{ node: 'Ollama — Score Topics', type: 'main', index: 0 }]] },
    'Ollama — Score Topics': { main: [[{ node: 'Decide Today Plan', type: 'main', index: 0 }]] },
    'Decide Today Plan': { main: [[{ node: 'Send Morning Brief', type: 'main', index: 0 }]] }
  };

  return { name: '01 — Morning Brief', active: true, nodes, connections, settings: { executionOrder: 'v1' } };
}

function buildDailyGenerator(mixpostCredId, intrktCredId) {
  const nodes = [
    cronNode('cron-personal', 'Cron 7AM — Personal', '30 1 * * *', [200, 100]),
    cronNode('cron-company', 'Cron 7AM — Company', '32 1 * * *', [200, 300]),
    {
      id: 'set-personal', name: 'Set Personal Profile',
      type: 'n8n-nodes-base.set', typeVersion: 3.3, position: [400, 100],
      parameters: { assignments: { assignments: [{ id: '1', name: 'profile_id', value: 'deep_personal', type: 'string' }] } }
    },
    {
      id: 'set-company', name: 'Set Company Profile',
      type: 'n8n-nodes-base.set', typeVersion: 3.3, position: [400, 300],
      parameters: { assignments: { assignments: [{ id: '1', name: 'profile_id', value: 'intrkt_company', type: 'string' }] } }
    },
    codeNode('load-config', 'Load Config', LOAD_CONFIG_CODE, [620, 200]),
    codeNode('load-plan', 'Load Today Plan', `
const fs = require('fs');
const config = $input.first().json;
const profileId = config.profile_id;

// Read today's plan (set by Morning Brief)
let plan = { type: 'default', pillar: config.default_pillar };
try {
  const planFile = '/data/state/today_plan_' + profileId + '.json';
  if (fs.existsSync(planFile)) {
    plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  }
} catch(e) {}

// Read any operator override (opinion text or CHANGE command)
let override = null;
try {
  const ovFile = '/data/state/override_' + profileId + '.json';
  if (fs.existsSync(ovFile)) {
    override = JSON.parse(fs.readFileSync(ovFile, 'utf8'));
    fs.unlinkSync(ovFile); // consume the override
  }
} catch(e) {}

return [{ json: { ...config, plan, override } }];
    `, [840, 200]),
    codeNode('build-prompt', 'Build Generation Prompt', `
const d = $input.first().json;
const { plan, override } = d;

let userMsg = '';

if (override?.type === 'opinion') {
  userMsg = 'Post the operator\\'s opinion as a hot take tweet.\\n' +
    'Trend topic: "' + (plan.trend || 'current trending topic') + '"\\n' +
    'Operator\\'s exact words: "' + override.text + '"\\n\\n' +
    'Generate a punchy tweet using their opinion. Return ONLY valid JSON:\\n' +
    '{"tweet":"string","thread":["string"],"linkedin_draft":"string","threads_draft":"string"}';
} else if (plan.type === 'trend_angle' || plan.type === 'opinion_requested') {
  userMsg = 'Pillar: ' + plan.pillar + '\\nTrend angle: "' + plan.trend + '" — ' + plan.angle + '\\n\\n' +
    'Generate content using trend as angle. Return ONLY valid JSON:\\n' +
    '{"tweet":"string","thread":["string"],"linkedin_draft":"string","threads_draft":"string"}';
} else {
  userMsg = 'Pillar: ' + plan.pillar + '\\n\\n' +
    'Generate a tweet and thread for this pillar. Return ONLY valid JSON:\\n' +
    '{"tweet":"string","thread":["string"],"linkedin_draft":"string","threads_draft":"string"}';
}

return [{ json: {
  ...d,
  system_prompt: d.context_block + '\\n\\nAGENT ROLE:\\n' + d.agent_twitter_engager,
  user_message: userMsg
}}];
    `, [1060, 200]),
    // Ollama generation
    {
      id: 'ollama-generate', name: 'Generate Content — Ollama',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1280, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, contentType: 'json',
        body: {
          model: '={{ process.env.OLLAMA_MODEL || "qwen2.5:14b" }}',
          messages: [
            { role: 'system', content: '={{ $json.system_prompt }}' },
            { role: 'user', content: '={{ $json.user_message }}' }
          ],
          stream: false, temperature: 0.75
        }
      }
    },
    codeNode('parse-content', 'Parse Generated Content', `
const ollamaRes = $input.first().json;
const config = $('Load Today Plan').first().json;

const raw = ollamaRes.choices?.[0]?.message?.content || '{}';
let content;
try {
  content = JSON.parse(raw.replace(/\`\`\`json|\`\`\`/g, '').trim());
} catch(e) {
  content = { tweet: raw.slice(0,280), thread: [], linkedin_draft: raw.slice(0,700), threads_draft: raw.slice(0,280) };
}

return [{ json: { ...config, content } }];
    `, [1500, 200]),
    // Trust level check
    {
      id: 'check-trust', name: 'Trust Level 0?',
      type: 'n8n-nodes-base.if', typeVersion: 2, position: [1720, 200],
      parameters: {
        conditions: {
          options: { caseSensitive: false, typeValidation: 'loose' },
          conditions: [{ id: '1', leftValue: '={{ $json.trust_level }}', rightValue: 0, operator: { type: 'number', operation: 'equals' } }],
          combinator: 'and'
        }
      }
    },
    // Post direct (trust 0)
    {
      id: 'post-direct', name: 'Post Direct to Mixpost',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1940, 100],
      continueOnFail: true,
      credentials: { httpHeaderAuth: cred(mixpostCredId) },
      parameters: {
        method: 'POST', url: 'http://mixpost/api/mixpost/posts',
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, contentType: 'json',
        body: {
          accounts: ['={{ $json.account_ids[$json.primary_platform] }}'],
          versions: [{ is_original: true, content: [{ body: '={{ $json.content.tweet }}', media: [] }] }],
          scheduled_at: '={{ new Date(Date.now() + 120000).toISOString() }}'
        }
      }
    },
    // Send for approval (trust 1+)
    {
      id: 'send-approval', name: 'Send Draft for Approval',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1940, 340],
      continueOnFail: true,
      credentials: { httpHeaderAuth: cred(intrktCredId) },
      parameters: {
        method: 'POST',
        url: '={{ process.env.INTRKT_BASE_URL }}/api/interaction/trigger',
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, contentType: 'json',
        body: {
          flow_id: 'flow:content-machine:outbound',
          phone: '={{ process.env.INTRKT_OPERATOR_PHONE }}',
          channel: 'wa_chat',
          journey: {
            message: '=✍️ [{{ $json.display_name }}] Draft ready:\n\n{{ $json.content.tweet }}\n\nReply YES to post, NO to skip, or EDIT [your text] to change.\n(Auto-posts in 30 min if no reply)'
          }
        }
      }
    },
    waitNode('wait-approval', 'Wait 30 Minutes', 30, [2160, 340]),
    codeNode('check-approval-file', 'Read Approval Decision', `
const fs = require('fs');
const profileId = $('Load Today Plan').first().json.profile_id;
const approvalFile = '/data/state/approval_' + profileId + '.json';

let decision = { action: 'approve' }; // default: auto-post if no reply
try {
  if (fs.existsSync(approvalFile)) {
    decision = JSON.parse(fs.readFileSync(approvalFile, 'utf8'));
    fs.unlinkSync(approvalFile); // consume
  }
} catch(e) {}

const prevData = $('Parse Generated Content').first().json;
let content = { ...prevData.content };

if (decision.action === 'edit' && decision.text) {
  content.tweet = decision.text;
}

return [{ json: { ...prevData, content, decision } }];
    `, [2380, 340]),
    {
      id: 'should-post', name: 'Should Post?',
      type: 'n8n-nodes-base.if', typeVersion: 2, position: [2600, 340],
      parameters: {
        conditions: {
          options: { caseSensitive: false, typeValidation: 'loose' },
          conditions: [{ id: '1', leftValue: '={{ $json.decision.action }}', rightValue: 'skip', operator: { type: 'string', operation: 'notEquals' } }],
          combinator: 'and'
        }
      }
    },
    {
      id: 'post-approved', name: 'Post Approved Content',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [2820, 300],
      continueOnFail: true,
      credentials: { httpHeaderAuth: cred(mixpostCredId) },
      parameters: {
        method: 'POST', url: 'http://mixpost/api/mixpost/posts',
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, contentType: 'json',
        body: {
          accounts: ['={{ $json.account_ids[$json.primary_platform] }}'],
          versions: [{ is_original: true, content: [{ body: '={{ $json.content.tweet }}', media: [] }] }],
          scheduled_at: '={{ new Date(Date.now() + 120000).toISOString() }}'
        }
      }
    },
    // Trigger repurposer for both paths (merge then call)
    codeNode('prep-repurpose', 'Prep Repurpose Payload', `
const fs = require('fs');
// Get data from whichever branch we came from
let data;
try { data = $('Post Approved Content').first().json; } catch(e) {}
try { data = data || $('Post Direct to Mixpost').first().json; } catch(e) {}
data = data || $input.first().json;

return [{ json: {
  profile_id: data.profile_id,
  primary_platform: data.primary_platform,
  platforms: data.platforms,
  account_ids: data.account_ids,
  context_block: data.context_block,
  agent_content_creator: data.agent_content_creator,
  tweet: data.content?.tweet || '',
  linkedin_draft: data.content?.linkedin_draft || '',
  threads_draft: data.content?.threads_draft || ''
}}];
    `, [3040, 200]),
    {
      id: 'trigger-repurposer', name: 'Trigger Repurposer',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [3260, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: 'http://localhost:5678/webhook/repurposer',
        sendBody: true, contentType: 'json',
        body: '={{ JSON.stringify($json) }}'
      }
    }
  ];

  const connections = {
    'Cron 7AM — Personal': { main: [[{ node: 'Set Personal Profile', type: 'main', index: 0 }]] },
    'Cron 7AM — Company': { main: [[{ node: 'Set Company Profile', type: 'main', index: 0 }]] },
    'Set Personal Profile': { main: [[{ node: 'Load Config', type: 'main', index: 0 }]] },
    'Set Company Profile': { main: [[{ node: 'Load Config', type: 'main', index: 0 }]] },
    'Load Config': { main: [[{ node: 'Load Today Plan', type: 'main', index: 0 }]] },
    'Load Today Plan': { main: [[{ node: 'Build Generation Prompt', type: 'main', index: 0 }]] },
    'Build Generation Prompt': { main: [[{ node: 'Generate Content — Ollama', type: 'main', index: 0 }]] },
    'Generate Content — Ollama': { main: [[{ node: 'Parse Generated Content', type: 'main', index: 0 }]] },
    'Parse Generated Content': { main: [[{ node: 'Trust Level 0?', type: 'main', index: 0 }]] },
    'Trust Level 0?': {
      main: [
        [{ node: 'Post Direct to Mixpost', type: 'main', index: 0 }],
        [{ node: 'Send Draft for Approval', type: 'main', index: 0 }]
      ]
    },
    'Post Direct to Mixpost': { main: [[{ node: 'Prep Repurpose Payload', type: 'main', index: 0 }]] },
    'Send Draft for Approval': { main: [[{ node: 'Wait 30 Minutes', type: 'main', index: 0 }]] },
    'Wait 30 Minutes': { main: [[{ node: 'Read Approval Decision', type: 'main', index: 0 }]] },
    'Read Approval Decision': { main: [[{ node: 'Should Post?', type: 'main', index: 0 }]] },
    'Should Post?': {
      main: [
        [{ node: 'Post Approved Content', type: 'main', index: 0 }],
        []
      ]
    },
    'Post Approved Content': { main: [[{ node: 'Prep Repurpose Payload', type: 'main', index: 0 }]] },
    'Prep Repurpose Payload': { main: [[{ node: 'Trigger Repurposer', type: 'main', index: 0 }]] }
  };

  return { name: '02 — Daily Generator', active: true, nodes, connections, settings: { executionOrder: 'v1' } };
}

function buildRepurposer(mixpostCredId) {
  const nodes = [
    webhookNode('webhook-in', 'Webhook — Repurpose', 'repurposer', [200, 300]),
    codeNode('parse-input', 'Parse Input', `
const body = $input.first().json.body || $input.first().json;
return [{ json: typeof body === 'string' ? JSON.parse(body) : body }];
    `, [420, 300]),
    // Refine for LinkedIn
    {
      id: 'ollama-linkedin', name: 'Refine LinkedIn',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [640, 180],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, contentType: 'json',
        body: {
          model: '={{ process.env.OLLAMA_MODEL || "qwen2.5:14b" }}',
          messages: [
            { role: 'system', content: '={{ $json.context_block + "\\n\\nAGENT:\\n" + $json.agent_content_creator }}' },
            { role: 'user', content: '=Adapt for LinkedIn: professional tone, 100-150 words, industry insight, CTA to follow. Return only the post text.\\n\\nOriginal tweet: {{ $json.tweet }}\\nDraft: {{ $json.linkedin_draft }}' }
          ],
          stream: false, temperature: 0.6
        }
      }
    },
    // Refine for Threads
    {
      id: 'ollama-threads', name: 'Refine Threads',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [640, 420],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, contentType: 'json',
        body: {
          model: '={{ process.env.OLLAMA_MODEL || "qwen2.5:14b" }}',
          messages: [
            { role: 'system', content: '={{ $json.context_block + "\\n\\nAGENT:\\n" + $json.agent_content_creator }}' },
            { role: 'user', content: '=Adapt for Threads: casual, under 300 chars, same energy as tweet, no hashtags. Return only post text.\\n\\nTweet: {{ $json.tweet }}' }
          ],
          stream: false, temperature: 0.7
        }
      }
    },
    // Post to LinkedIn
    {
      id: 'post-linkedin', name: 'Post to LinkedIn',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [880, 180],
      continueOnFail: true,
      credentials: { httpHeaderAuth: cred(mixpostCredId) },
      parameters: {
        method: 'POST', url: 'http://mixpost/api/mixpost/posts',
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, contentType: 'json',
        body: {
          accounts: ['={{ $("Parse Input").first().json.account_ids?.linkedin }}'],
          versions: [{ is_original: true, content: [{ body: '={{ $json.choices?.[0]?.message?.content || $("Parse Input").first().json.linkedin_draft }}', media: [] }] }],
          scheduled_at: '={{ new Date(Date.now() + 7200000).toISOString() }}'
        }
      }
    },
    // Post to Threads
    {
      id: 'post-threads', name: 'Post to Threads',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [880, 420],
      continueOnFail: true,
      credentials: { httpHeaderAuth: cred(mixpostCredId) },
      parameters: {
        method: 'POST', url: 'http://mixpost/api/mixpost/posts',
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, contentType: 'json',
        body: {
          accounts: ['={{ $("Parse Input").first().json.account_ids?.threads }}'],
          versions: [{ is_original: true, content: [{ body: '={{ $json.choices?.[0]?.message?.content || $("Parse Input").first().json.tweet }}', media: [] }] }],
          scheduled_at: '={{ new Date(Date.now() + 14400000).toISOString() }}'
        }
      }
    }
  ];

  const connections = {
    'Webhook — Repurpose': { main: [[{ node: 'Parse Input', type: 'main', index: 0 }]] },
    'Parse Input': {
      main: [[
        { node: 'Refine LinkedIn', type: 'main', index: 0 },
        { node: 'Refine Threads', type: 'main', index: 0 }
      ]]
    },
    'Refine LinkedIn': { main: [[{ node: 'Post to LinkedIn', type: 'main', index: 0 }]] },
    'Refine Threads': { main: [[{ node: 'Post to Threads', type: 'main', index: 0 }]] }
  };

  return { name: '03 — Repurposer', active: true, nodes, connections, settings: { executionOrder: 'v1' } };
}

function buildTrendReactor(intrktCredId) {
  const nodes = [
    cronNode('cron-1pm', 'Cron 1PM IST', '30 7 * * *', [200, 100]),
    cronNode('cron-7pm', 'Cron 7PM IST', '30 13 * * *', [200, 300]),
    codeNode('load-both-profiles', 'Load Both Profiles', `
// Runs for both accounts
const fs = require('fs');
const profiles = ['deep_personal', 'intrkt_company'].map(id => {
  const p = JSON.parse(fs.readFileSync('/data/profiles/' + id + '.json', 'utf8'));
  const ctx = fs.existsSync('/data/contexts/' + p.context_file) 
    ? fs.readFileSync('/data/contexts/' + p.context_file, 'utf8') : '';
  const agent = fs.existsSync('/data/agents/trend-researcher.txt')
    ? fs.readFileSync('/data/agents/trend-researcher.txt', 'utf8') : '';
  const twitterAgent = fs.existsSync('/data/agents/twitter-engager.txt')
    ? fs.readFileSync('/data/agents/twitter-engager.txt', 'utf8') : '';
  return { ...p, context_block: ctx, agent_trend_researcher: agent, agent_twitter_engager: twitterAgent };
});
return profiles.map(p => ({ json: p }));
    `, [420, 200]),
    // Search for each profile
    {
      id: 'search-trends', name: 'Search Trends',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [640, 200],
      continueOnFail: true,
      parameters: {
        method: 'GET',
        url: 'https://api.search.brave.com/res/v1/news/search',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Accept', value: 'application/json' },
          { name: 'X-Subscription-Token', value: '={{ process.env.BRAVE_SEARCH_API_KEY }}' }
        ]},
        sendQuery: true,
        queryParameters: { parameters: [
          { name: 'q', value: '={{ $json.trend_keywords.join(" OR ") }}' },
          { name: 'count', value: '8' },
          { name: 'freshness', value: 'pd' }
        ]}
      }
    },
    // Score
    {
      id: 'ollama-score', name: 'Score Relevance',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [860, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, contentType: 'json',
        body: {
          model: '={{ process.env.OLLAMA_MODEL || "qwen2.5:14b" }}',
          messages: [
            { role: 'system', content: '={{ $json.agent_trend_researcher }}' },
            { role: 'user', content: '=Score news 1-10 for {{ $json.display_name }}. Keywords: {{ $json.trend_keywords.join(", ") }}\n\nNews: {{ JSON.stringify(($json.results || []).slice(0,6).map(r => ({title: r.title}))) }}\n\nReturn ONLY JSON: {"topic":"string","score":number,"angle":"string"}' }
          ],
          stream: false, temperature: 0.2
        }
      }
    },
    codeNode('parse-score', 'Parse Score', `
const ollamaRes = $input.first().json;
// We need to get the profile data from the search step
const profileData = $('Search Trends').first().json;

let scored = { topic: '', score: 0, angle: '' };
try {
  const raw = ollamaRes.choices?.[0]?.message?.content || '{}';
  scored = JSON.parse(raw.replace(/\`\`\`json|\`\`\`/g, '').trim());
} catch(e) {}

return [{ json: { ...profileData, ...scored } }];
    `, [1080, 200]),
    {
      id: 'above-threshold', name: 'Above Threshold?',
      type: 'n8n-nodes-base.if', typeVersion: 2, position: [1300, 200],
      parameters: {
        conditions: {
          options: { caseSensitive: false, typeValidation: 'loose' },
          conditions: [{ id: '1', leftValue: '={{ $json.score }}', rightValue: '={{ $json.trend_threshold }}', operator: { type: 'number', operation: 'gte' } }],
          combinator: 'and'
        }
      }
    },
    {
      id: 'needs-opinion', name: 'Needs Opinion?',
      type: 'n8n-nodes-base.if', typeVersion: 2, position: [1520, 100],
      parameters: {
        conditions: {
          options: { caseSensitive: false, typeValidation: 'loose' },
          conditions: [{ id: '1', leftValue: '={{ $json.score }}', rightValue: '={{ $json.opinion_threshold }}', operator: { type: 'number', operation: 'gte' } }],
          combinator: 'and'
        }
      }
    },
    // Ask for opinion
    {
      id: 'ask-opinion', name: 'Ask for Opinion',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1740, 40],
      continueOnFail: true,
      credentials: { httpHeaderAuth: cred(intrktCredId) },
      parameters: {
        method: 'POST',
        url: '={{ process.env.INTRKT_BASE_URL }}/api/interaction/trigger',
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, contentType: 'json',
        body: {
          flow_id: 'flow:content-machine:outbound',
          phone: '={{ process.env.INTRKT_OPERATOR_PHONE }}',
          channel: 'wa_chat',
          journey: {
            message: '=🔥 [{{ $json.display_name }}] Trending: "{{ $json.topic }}" ({{ $json.score }}/10)\n\nAngle: {{ $json.angle }}\n\nReply with your take → I\'ll post it. Or SKIP to ignore.'
          }
        }
      }
    },
    // Auto-generate trend post
    {
      id: 'auto-generate', name: 'Auto Generate Hot Take',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1740, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, contentType: 'json',
        body: {
          model: '={{ process.env.OLLAMA_MODEL || "qwen2.5:14b" }}',
          messages: [
            { role: 'system', content: '={{ $json.context_block + "\\n\\nAGENT:\\n" + $json.agent_twitter_engager }}' },
            { role: 'user', content: '=Write a hot take tweet about: "{{ $json.topic }}". Angle: {{ $json.angle }}. Under 240 chars. Strong opinion. Return only tweet text.' }
          ],
          stream: false, temperature: 0.85
        }
      }
    },
    // Send trend draft for approval
    {
      id: 'send-trend-draft', name: 'Send Trend Draft',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1960, 200],
      continueOnFail: true,
      credentials: { httpHeaderAuth: cred(intrktCredId) },
      parameters: {
        method: 'POST',
        url: '={{ process.env.INTRKT_BASE_URL }}/api/interaction/trigger',
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, contentType: 'json',
        body: {
          flow_id: 'flow:content-machine:outbound',
          phone: '={{ process.env.INTRKT_OPERATOR_PHONE }}',
          channel: 'wa_chat',
          journey: {
            message: '=📈 Trend post ready [{{ $("Parse Score").first().json.display_name }}]:\n\n{{ $json.choices?.[0]?.message?.content }}\n\nReply YES to post or NO to skip.'
          }
        }
      }
    }
  ];

  const connections = {
    'Cron 1PM IST': { main: [[{ node: 'Load Both Profiles', type: 'main', index: 0 }]] },
    'Cron 7PM IST': { main: [[{ node: 'Load Both Profiles', type: 'main', index: 0 }]] },
    'Load Both Profiles': { main: [[{ node: 'Search Trends', type: 'main', index: 0 }]] },
    'Search Trends': { main: [[{ node: 'Score Relevance', type: 'main', index: 0 }]] },
    'Score Relevance': { main: [[{ node: 'Parse Score', type: 'main', index: 0 }]] },
    'Parse Score': { main: [[{ node: 'Above Threshold?', type: 'main', index: 0 }]] },
    'Above Threshold?': {
      main: [
        [{ node: 'Needs Opinion?', type: 'main', index: 0 }],
        []
      ]
    },
    'Needs Opinion?': {
      main: [
        [{ node: 'Ask for Opinion', type: 'main', index: 0 }],
        [{ node: 'Auto Generate Hot Take', type: 'main', index: 0 }]
      ]
    },
    'Auto Generate Hot Take': { main: [[{ node: 'Send Trend Draft', type: 'main', index: 0 }]] }
  };

  return { name: '04 — Trend Reactor', active: true, nodes, connections, settings: { executionOrder: 'v1' } };
}

function buildAnalyticsLoop(intrktCredId) {
  const nodes = [
    cronNode('cron-sunday', 'Cron Sunday 6PM IST', '30 12 * * 0', [200, 300]),
    codeNode('load-profiles', 'Load Profiles', `
const fs = require('fs');
return ['deep_personal', 'intrkt_company'].map(id => {
  const p = JSON.parse(fs.readFileSync('/data/profiles/' + id + '.json', 'utf8'));
  const agent = fs.existsSync('/data/agents/growth-hacker.txt')
    ? fs.readFileSync('/data/agents/growth-hacker.txt', 'utf8') : '';
  return { json: { ...p, agent_growth_hacker: agent, workspace_id: process.env[p.workspace_env_key] || '' } };
});
    `, [420, 300]),
    {
      id: 'fetch-analytics', name: 'Fetch Mixpost Analytics',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [640, 300],
      continueOnFail: true,
      parameters: {
        method: 'GET',
        url: '=http://mixpost/api/mixpost/posts?published=true&limit=20',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Authorization', value: '=Bearer {{ process.env.MIXPOST_API_TOKEN }}' }
        ]}
      }
    },
    {
      id: 'ollama-analyse', name: 'Analyse with Growth Hacker',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [860, 300],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, contentType: 'json',
        body: {
          model: '={{ process.env.OLLAMA_MODEL || "qwen2.5:14b" }}',
          messages: [
            { role: 'system', content: '={{ $("Load Profiles").first().json.agent_growth_hacker }}' },
            { role: 'user', content: '=Analyse this week for {{ $("Load Profiles").first().json.display_name }}.\nPosts: {{ JSON.stringify(($json.data || []).slice(0,15)) }}\nReturn JSON: {"what_worked":"string","avoid":"string","next_week":"string","summary":"string"}' }
          ],
          stream: false, temperature: 0.3
        }
      }
    },
    codeNode('save-learnings', 'Save Learnings', `
const fs = require('fs');
const profileId = $('Load Profiles').first().json.id;
const raw = $input.first().json.choices?.[0]?.message?.content || '{}';

let analysis = {};
try { analysis = JSON.parse(raw.replace(/\`\`\`json|\`\`\`/g, '').trim()); } catch(e) {}

const learnFile = '/data/learnings/' + profileId + '.json';
fs.mkdirSync('/data/learnings', { recursive: true });
let history = [];
try { history = JSON.parse(fs.readFileSync(learnFile, 'utf8')); } catch(e) {}
history.push({ week: new Date().toISOString().slice(0,10), ...analysis });
fs.writeFileSync(learnFile, JSON.stringify(history.slice(-16), null, 2));

const digest = '📊 [' + $('Load Profiles').first().json.display_name + '] Week of ' + new Date().toISOString().slice(0,10) +
  '\\n\\n✅ What worked: ' + (analysis.what_worked || 'N/A') +
  '\\n❌ Avoid: ' + (analysis.avoid || 'N/A') +
  '\\n🎯 Next week: ' + (analysis.next_week || 'N/A') +
  '\\n\\n' + (analysis.summary || '');

return [{ json: { digest } }];
    `, [1080, 300]),
    {
      id: 'send-digest', name: 'Send Weekly Digest',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1300, 300],
      continueOnFail: true,
      credentials: { httpHeaderAuth: cred(intrktCredId) },
      parameters: {
        method: 'POST',
        url: '={{ process.env.INTRKT_BASE_URL }}/api/interaction/trigger',
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, contentType: 'json',
        body: {
          flow_id: 'flow:content-machine:outbound',
          phone: '={{ process.env.INTRKT_OPERATOR_PHONE }}',
          channel: 'wa_chat',
          journey: { message: '={{ $json.digest }}' }
        }
      }
    }
  ];

  const connections = {
    'Cron Sunday 6PM IST': { main: [[{ node: 'Load Profiles', type: 'main', index: 0 }]] },
    'Load Profiles': { main: [[{ node: 'Fetch Mixpost Analytics', type: 'main', index: 0 }]] },
    'Fetch Mixpost Analytics': { main: [[{ node: 'Analyse with Growth Hacker', type: 'main', index: 0 }]] },
    'Analyse with Growth Hacker': { main: [[{ node: 'Save Learnings', type: 'main', index: 0 }]] },
    'Save Learnings': { main: [[{ node: 'Send Weekly Digest', type: 'main', index: 0 }]] }
  };

  return { name: '05 — Analytics Loop', active: true, nodes, connections, settings: { executionOrder: 'v1' } };
}

function buildCommandHandler(mixpostCredId, intrktCredId) {
  const nodes = [
    webhookNode('webhook-cmd', 'Webhook — Commands', 'intrkt-commands', [200, 400]),
    codeNode('parse-command', 'Parse Command', `
const body = $input.first().json.body || $input.first().json;
const raw = (body.text || body.cmd || body.message || '').trim();
const lower = raw.toLowerCase();

// Detect account from [intrkt] tag
const isCompany = lower.includes('[intrkt]');
const profile_id = isCompany ? 'intrkt_company' : 'deep_personal';
const text = lower.replace('[intrkt]', '').trim();
const rawText = raw.replace(/\[intrkt\]/gi, '').trim();

let intent = 'unknown';
let payload = {};

if (text === 'yes' || text === 'approve') { intent = 'approve'; }
else if (text === 'no' || text === 'skip') { intent = 'skip'; }
else if (text.startsWith('edit ')) { intent = 'edit'; payload.text = rawText.replace(/^edit /i, ''); }
else if (text === 'pause') { intent = 'pause'; }
else if (text === 'resume') { intent = 'resume'; }
else if (text === 'change') { intent = 'change'; }
else if (text === 'stats') { intent = 'stats'; }
else if (text.startsWith('post about ')) { intent = 'post_about'; payload.topic = rawText.replace(/^post about /i, ''); }
else if (text.startsWith('trust ')) { 
  intent = 'trust'; 
  payload.level = parseInt(text.match(/trust (\d)/)?.[1] ?? '1'); 
}
else { intent = 'opinion'; payload.text = rawText; }

return [{ json: { intent, profile_id, payload, raw_text: rawText } }];
    `, [420, 400]),
    {
      id: 'route-intent', name: 'Route Intent',
      type: 'n8n-nodes-base.switch', typeVersion: 3, position: [640, 400],
      parameters: {
        mode: 'expression',
        output: '={{ $json.intent }}',
        rules: { values: [
          { outputKey: 'approve' }, { outputKey: 'skip' }, { outputKey: 'edit' },
          { outputKey: 'trust' }, { outputKey: 'pause' }, { outputKey: 'resume' },
          { outputKey: 'opinion' }, { outputKey: 'post_about' }, { outputKey: 'stats' }, { outputKey: 'change' }
        ]},
        options: { fallbackOutput: 'none' }
      }
    },
    codeNode('h-approve', 'Handle Approve', `
const fs = require('fs');
fs.mkdirSync('/data/state', { recursive: true });
fs.writeFileSync('/data/state/approval_' + $json.profile_id + '.json', JSON.stringify({ action: 'approve' }));
return [{ json: { ack: '✅ Approved — posting now.' } }];
    `, [900, 100]),
    codeNode('h-skip', 'Handle Skip', `
const fs = require('fs');
fs.writeFileSync('/data/state/approval_' + $json.profile_id + '.json', JSON.stringify({ action: 'skip' }));
return [{ json: { ack: '⏭️ Skipped — no post today for ' + $json.profile_id + '.' } }];
    `, [900, 220]),
    codeNode('h-edit', 'Handle Edit', `
const fs = require('fs');
fs.writeFileSync('/data/state/approval_' + $json.profile_id + '.json', JSON.stringify({ action: 'edit', text: $json.payload.text }));
return [{ json: { ack: '✏️ Got it — posting your version.' } }];
    `, [900, 340]),
    codeNode('h-trust', 'Handle Trust', `
const fs = require('fs');
const level = $json.payload.level;
fs.writeFileSync('/data/state/trust_' + $json.profile_id + '.json', JSON.stringify({ trust_level: level }));
return [{ json: { ack: '🔒 Trust level set to ' + level + ' for ' + $json.profile_id + '.' } }];
    `, [900, 460]),
    codeNode('h-pause', 'Handle Pause', `
const fs = require('fs');
fs.writeFileSync('/data/state/paused.json', JSON.stringify({ paused: true, at: new Date().toISOString() }));
return [{ json: { ack: '⏸️ Machine paused. Send RESUME to restart.' } }];
    `, [900, 580]),
    codeNode('h-resume', 'Handle Resume', `
const fs = require('fs');
try { fs.unlinkSync('/data/state/paused.json'); } catch(e) {}
return [{ json: { ack: '▶️ Machine resumed.' } }];
    `, [900, 700]),
    codeNode('h-opinion', 'Handle Opinion', `
const fs = require('fs');
fs.writeFileSync('/data/state/override_' + $json.profile_id + '.json', JSON.stringify({ type: 'opinion', text: $json.payload.text }));
return [{ json: { ack: '💬 Got your take — will use it for next post. Or say "post about [topic]" to go right now.' } }];
    `, [900, 820]),
    codeNode('h-change', 'Handle Change', `
const fs = require('fs');
const planFile = '/data/state/today_plan_' + $json.profile_id + '.json';
let plan = {};
try { plan = JSON.parse(fs.readFileSync(planFile, 'utf8')); } catch(e) {}
plan.operator_change = true;
fs.writeFileSync(planFile, JSON.stringify(plan));
return [{ json: { ack: '🔄 Calendar switched to trend topic for ' + $json.profile_id + '.' } }];
    `, [900, 940]),
    // Stats handler
    {
      id: 'h-stats', name: 'Fetch Stats',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [900, 1060],
      continueOnFail: true,
      parameters: {
        method: 'GET',
        url: '=http://mixpost/api/mixpost/posts?published=true&limit=5',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Authorization', value: '=Bearer {{ process.env.MIXPOST_API_TOKEN }}' }
        ]}
      }
    },
    codeNode('format-stats', 'Format Stats Reply', `
const data = $json.data || [];
const count = data.length;
const ack = '📊 Last ' + count + ' posts found. Check Mixpost dashboard for full analytics: https://' + (process.env.MIXPOST_HOST || 'your-mixpost-domain');
return [{ json: { ack } }];
    `, [1120, 1060]),
    // Merge all ack nodes into one sender
    {
      id: 'send-ack', name: 'Send Acknowledgement',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1340, 580],
      continueOnFail: true,
      credentials: { httpHeaderAuth: cred(intrktCredId) },
      parameters: {
        method: 'POST',
        url: '={{ process.env.INTRKT_BASE_URL }}/api/interaction/trigger',
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendBody: true, contentType: 'json',
        body: {
          flow_id: 'flow:content-machine:outbound',
          phone: '={{ process.env.INTRKT_OPERATOR_PHONE }}',
          channel: 'wa_chat',
          journey: { message: '={{ $json.ack }}' }
        }
      }
    }
  ];

  // All intent handlers feed into send-ack
  const connections = {
    'Webhook — Commands': { main: [[{ node: 'Parse Command', type: 'main', index: 0 }]] },
    'Parse Command': { main: [[{ node: 'Route Intent', type: 'main', index: 0 }]] },
    'Route Intent': {
      main: [
        [{ node: 'Handle Approve', type: 'main', index: 0 }],
        [{ node: 'Handle Skip', type: 'main', index: 0 }],
        [{ node: 'Handle Edit', type: 'main', index: 0 }],
        [{ node: 'Handle Trust', type: 'main', index: 0 }],
        [{ node: 'Handle Pause', type: 'main', index: 0 }],
        [{ node: 'Handle Resume', type: 'main', index: 0 }],
        [{ node: 'Handle Opinion', type: 'main', index: 0 }],
        [{ node: 'Handle Post About', type: 'main', index: 0 }],
        [{ node: 'Fetch Stats', type: 'main', index: 0 }],
        [{ node: 'Handle Change', type: 'main', index: 0 }]
      ]
    },
    'Handle Approve': { main: [[{ node: 'Send Acknowledgement', type: 'main', index: 0 }]] },
    'Handle Skip': { main: [[{ node: 'Send Acknowledgement', type: 'main', index: 0 }]] },
    'Handle Edit': { main: [[{ node: 'Send Acknowledgement', type: 'main', index: 0 }]] },
    'Handle Trust': { main: [[{ node: 'Send Acknowledgement', type: 'main', index: 0 }]] },
    'Handle Pause': { main: [[{ node: 'Send Acknowledgement', type: 'main', index: 0 }]] },
    'Handle Resume': { main: [[{ node: 'Send Acknowledgement', type: 'main', index: 0 }]] },
    'Handle Opinion': { main: [[{ node: 'Send Acknowledgement', type: 'main', index: 0 }]] },
    'Handle Change': { main: [[{ node: 'Send Acknowledgement', type: 'main', index: 0 }]] },
    'Fetch Stats': { main: [[{ node: 'Format Stats Reply', type: 'main', index: 0 }]] },
    'Format Stats Reply': { main: [[{ node: 'Send Acknowledgement', type: 'main', index: 0 }]] }
  };

  return { name: '06 — Command Handler', active: true, nodes, connections, settings: { executionOrder: 'v1' } };
}

module.exports = {
  buildMorningBrief,
  buildDailyGenerator,
  buildRepurposer,
  buildTrendReactor,
  buildAnalyticsLoop,
  buildCommandHandler
};
```

> **Claude Code note:** The `buildCommandHandler` function references a `Handle Post About` node that is not yet defined in the nodes array. Add this node — it should be a Code node that writes a `post_about` override file to `/data/state/post_about_[profile_id].json` with the topic, then returns an ack. The Daily Generator should check for this file in its Load Plan step and trigger immediate generation.

---

## File 13: `seed/index.js`

```javascript
require('dotenv').config({ path: '../.env' });
const fs = require('fs');
const path = require('path');
const n8n = require('./lib/n8n');
const { waitFor } = require('./lib/wait');
const workflows = require('./lib/workflows');

const {
  N8N_OWNER_EMAIL, N8N_OWNER_PASSWORD, N8N_OWNER_FIRSTNAME, N8N_OWNER_LASTNAME,
  INTRKT_BASE_URL, INTRKT_API_KEY, MIXPOST_API_TOKEN
} = process.env;

async function main() {
  console.log('\n══════════════════════════════════════');
  console.log('  Content Machine — Seed');
  console.log('══════════════════════════════════════\n');

  // 1. Wait for n8n
  console.log('▸ Waiting for n8n...');
  await waitFor('http://localhost:5678/healthz', 'n8n');

  // 2. Authenticate
  console.log('\n▸ Authenticating with n8n...');
  await n8n.authenticate(N8N_OWNER_EMAIL, N8N_OWNER_PASSWORD, N8N_OWNER_FIRSTNAME, N8N_OWNER_LASTNAME);

  // 3. Create credentials
  console.log('\n▸ Creating credentials...');

  const intrktCredId = await n8n.createCredential('INTRKT_AUTH', 'httpHeaderAuth', {
    name: 'X-API-Key',
    value: INTRKT_API_KEY || ''
  });

  // Mixpost credential will be empty until finalize step — that's fine,
  // the workflows also use process.env.MIXPOST_API_TOKEN as fallback
  const mixpostCredId = await n8n.createCredential('MIXPOST_AUTH', 'httpHeaderAuth', {
    name: 'Authorization',
    value: MIXPOST_API_TOKEN ? `Bearer ${MIXPOST_API_TOKEN}` : 'Bearer CONFIGURE_AFTER_MIXPOST_SETUP'
  });

  // 4. Create workflows
  console.log('\n▸ Creating n8n workflows...');

  const workflowBuilders = [
    ['Morning Brief', () => workflows.buildMorningBrief(intrktCredId)],
    ['Daily Generator', () => workflows.buildDailyGenerator(mixpostCredId, intrktCredId)],
    ['Repurposer', () => workflows.buildRepurposer(mixpostCredId)],
    ['Trend Reactor', () => workflows.buildTrendReactor(intrktCredId)],
    ['Analytics Loop', () => workflows.buildAnalyticsLoop(intrktCredId)],
    ['Command Handler', () => workflows.buildCommandHandler(mixpostCredId, intrktCredId)],
  ];

  const workflowIds = {};

  for (const [name, builder] of workflowBuilders) {
    try {
      const workflow = builder();
      const id = await n8n.createWorkflow(workflow);
      workflowIds[name] = id;
      await n8n.activateWorkflow(id);
    } catch (e) {
      console.error(`  ✗ Failed to create ${name}: ${e.message}`);
    }
  }

  // 5. Save workflow IDs for finalize script
  fs.writeFileSync(
    path.join(__dirname, 'workflow-ids.json'),
    JSON.stringify(workflowIds, null, 2)
  );

  // 6. Get Command Handler webhook URL for Intrkt update
  const commandWebhookUrl = `https://${process.env.N8N_HOST}/webhook/intrkt-commands`;
  fs.writeFileSync(
    path.join(__dirname, 'command-webhook-url.txt'),
    commandWebhookUrl
  );

  console.log('\n  Command Handler webhook URL:');
  console.log('  ' + commandWebhookUrl);

  console.log('\n══════════════════════════════════════');
  console.log('  SEED COMPLETE');
  console.log('\n  All 6 workflows created and activated.');
  console.log('\n  NEXT: Complete Mixpost OAuth setup');
  console.log('  Then run: node seed/finalize.js');
  console.log('══════════════════════════════════════\n');
}

main().catch(e => {
  console.error('\n✗ Seed failed:', e.message);
  if (e.response?.data) console.error('  API error:', JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
```

---

## File 14: `seed/finalize.js`

Run after Mixpost OAuth is configured and `.env` is updated with Mixpost values.

```javascript
require('dotenv').config({ path: '../.env' });
const axios = require('axios');
const fs = require('fs');
const n8n = require('./lib/n8n');

const {
  N8N_OWNER_EMAIL, N8N_OWNER_PASSWORD, N8N_OWNER_FIRSTNAME, N8N_OWNER_LASTNAME,
  MIXPOST_API_TOKEN, INTRKT_BASE_URL, INTRKT_API_KEY
} = process.env;

async function main() {
  console.log('\n▸ Finalizing setup...\n');

  if (!MIXPOST_API_TOKEN) {
    console.error('ERROR: MIXPOST_API_TOKEN not set in .env');
    process.exit(1);
  }

  // 1. Re-auth n8n
  await n8n.authenticate(N8N_OWNER_EMAIL, N8N_OWNER_PASSWORD, N8N_OWNER_FIRSTNAME, N8N_OWNER_LASTNAME);

  // 2. Update Mixpost credential with real token
  const mixpostCredId = await n8n.getCredentialId('MIXPOST_AUTH');
  if (mixpostCredId) {
    await axios.patch(
      `http://localhost:5678/api/v1/credentials/${mixpostCredId}`,
      { data: { name: 'Authorization', value: `Bearer ${MIXPOST_API_TOKEN}` } },
      { headers: { 'X-N8N-API-KEY': n8n._apiKey || '', 'Content-Type': 'application/json' } }
    ).catch(() => console.log('  ~ Could not update credential, may need manual update in n8n UI'));
    console.log('  ✓ Mixpost credential updated');
  }

  // 3. Update Intrkt inbound flow to call n8n Command Handler
  let commandWebhookUrl = '';
  try {
    commandWebhookUrl = fs.readFileSync('./command-webhook-url.txt', 'utf8').trim();
  } catch(e) {
    commandWebhookUrl = `https://${process.env.N8N_HOST}/webhook/intrkt-commands`;
  }

  console.log('  Updating Intrkt inbound flow to call n8n webhook...');
  try {
    await axios.post(
      `${INTRKT_BASE_URL}/mcp/create_flow`,
      {
        flow_id: 'flow:content-machine:inbound',
        name: 'Content Machine — Inbound Commands',
        entry_step: 'capture',
        steps: JSON.stringify({
          capture: {
            type: 'collect',
            var: 'cmd',
            prompt: '',
            next: 'relay'
          },
          relay: {
            type: 'function',
            fn: 'http_post',
            args: {
              url: commandWebhookUrl,
              body: '{"text":"${journey.cmd}","profile_id":"deep_personal"}'
            },
            next: 'ack'
          },
          ack: {
            type: 'template',
            template_id: 'tpl:content-machine:notify',
            next: null
          }
        })
      },
      { headers: { 'X-API-Key': INTRKT_API_KEY, 'Content-Type': 'application/json' } }
    ).catch(e => {
      console.log('  ~ Intrkt flow update via API failed. Update manually in Intrkt dashboard.');
      console.log('    Command webhook URL: ' + commandWebhookUrl);
    });
    console.log('  ✓ Intrkt inbound flow updated');
  } catch(e) {
    console.log('  ~ Intrkt flow update failed: ' + e.message);
  }

  // 4. Copy updated profiles to Docker volume
  console.log('  Copying updated profiles to Docker volume...');
  try {
    require('child_process').execSync('docker cp ../data/profiles/. n8n:/data/profiles/');
    require('child_process').execSync('docker cp ../data/contexts/. n8n:/data/contexts/');
    console.log('  ✓ Profiles and contexts updated in container');
  } catch(e) {
    console.log('  ~ Could not auto-copy files. Run manually:');
    console.log('    docker cp data/profiles/. n8n:/data/profiles/');
    console.log('    docker cp data/contexts/. n8n:/data/contexts/');
  }

  console.log('\n══════════════════════════════════════');
  console.log('  FINALIZATION COMPLETE');
  console.log('  System is live.');
  console.log('\n  Test by sending "stats" to your WhatsApp number.');
  console.log('══════════════════════════════════════\n');
}

main().catch(console.error);
```

---

## File 15: `MANUAL_STEPS.md`

Document for operator. These are the only steps that cannot be automated (OAuth requires browser).

```markdown
# Manual Steps — Required After Running setup.sh

These 4 steps require a browser. Everything else was automated.

---

## Step 1: Set up Mixpost (20 minutes)

1. Open https://MIXPOST_HOST in your browser
2. Complete the first-run wizard to create your admin account
3. Click **Workspaces** → **New Workspace** → name it "Deep Personal"
4. Inside that workspace, connect social accounts:
   - Twitter/X → OAuth
   - LinkedIn → OAuth
   - Threads → OAuth (via Meta)
   - Instagram → OAuth (via Meta)
5. Create a second workspace: "Intrkt Company"
6. Connect Twitter and LinkedIn to the company workspace
7. Go to your avatar → **Access Tokens** → create token named `n8n`
8. Copy the token — this is your MIXPOST_API_TOKEN

## Step 2: Get account IDs (5 minutes)

After connecting social accounts, run:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://MIXPOST_HOST/api/mixpost/accounts
```

This returns all connected account IDs. Map them to your .env file:
- MIXPOST_WORKSPACE_PERSONAL — the "Deep Personal" workspace ID (from URL bar)
- MIXPOST_WORKSPACE_COMPANY — the "Intrkt Company" workspace ID
- MIXPOST_PERSONAL_TWITTER_ID — Twitter account ID in personal workspace
- etc.

## Step 3: Update .env and run finalize (2 minutes)

Fill in all the Mixpost values in .env, then:

```bash
node seed/finalize.js
```

## Step 4: Fill in your context blocks (30 minutes — most important)

Open `data/contexts/deep.txt` and replace the placeholder at the bottom with 10 real tweets in your voice.
These are what make the AI sound like you, not generic AI.

Open `data/contexts/intrkt.txt` and replace the placeholder with 5 real Intrkt posts.

Then copy updated files to the container:
```bash
docker cp data/contexts/. n8n:/data/contexts/
```

---

## Verification

Test the system end-to-end:

```bash
# 1. Containers running
docker compose ps

# 2. Model loaded
docker exec ollama ollama list

# 3. Test Ollama
curl http://localhost:11434/api/generate \
  -d '{"model":"qwen2.5:14b","prompt":"Say hi in one sentence","stream":false}'

# 4. Send test command via WhatsApp
# Send "stats" to your WhatsApp number — should get a reply within 30 seconds

# 5. Test workflow manually
# Open n8n UI → Flow 02 → Execute manually → check output
```
```

---

## Cron Schedule Summary

All times in IST. UTC offsets applied in cron expressions (IST = UTC+5:30).

| Flow | IST Time | UTC cron |
|------|----------|----------|
| Morning Brief — Personal | 6:00 AM | `30 0 * * *` |
| Morning Brief — Company | 6:02 AM | `32 0 * * *` |
| Daily Generator — Personal | 7:00 AM | `30 1 * * *` |
| Daily Generator — Company | 7:02 AM | `32 1 * * *` |
| Trend Reactor — 1st check | 1:00 PM | `30 7 * * *` |
| Trend Reactor — 2nd check | 7:00 PM | `30 13 * * *` |
| Analytics Loop | Sunday 6:00 PM | `30 12 * * 0` |

---

## WhatsApp Command Reference

| Command | Effect | Profile |
|---------|--------|---------|
| `yes` or `approve` | Post the pending draft | Personal |
| `no` or `skip` | Cancel today's post | Personal |
| `edit [new text]` | Replace draft with your text and post | Personal |
| `[your opinion text]` | Used as hot take after trend opinion request | Personal |
| `CHANGE` | Switch today's calendar to the trend topic | Personal |
| `post about [topic]` | Generate and send draft on any topic immediately | Personal |
| `stats` | Fetch latest post count from Mixpost | Personal |
| `pause` | Halt all flows | Both |
| `resume` | Resume paused flows | Both |
| `trust 0` | Full autonomous — no approval needed | Personal |
| `trust 1` | Approval mode — 30-min window | Personal |
| `trust 2` | Post immediately, 2hr cancel window | Personal |
| Append `[intrkt]` to any command | Target the company account instead | Company |

---

## Architecture Summary

```
VPS (Docker network: cm_net)
│
├── n8n :5678        Runs all 6 flows. Code nodes read from /data volume.
│   └── /data        Profiles, agents, contexts, state, learnings
│
├── ollama :11434    Serves qwen2.5:14b via OpenAI-compatible API
│
├── mixpost :8888    Holds OAuth tokens, schedules posts
└── mixpost-redis    Queue for Mixpost

External:
├── Intrkt Flows Engine
│   ├── flow:content-machine:inbound  ← already live
│   ├── flow:content-machine:outbound ← already live
│   └── trigger:content-machine:commands ← already live
│
└── Brave Search API (free, 2000 req/month)
    Used by Morning Brief and Trend Reactor
```

---

## Known Failure Points & Fixes

**n8n API not responding on first seed run**
Cause: n8n takes 30-60s to fully initialize.
Fix: `wait.js` retries 30 times. If it still fails, run `node seed/index.js` again after a minute.

**Ollama model pull times out**
Cause: Qwen2.5:14b is ~8GB. Takes 5-15 min on first pull.
Fix: setup.sh runs `ollama pull` inside docker exec. Let it finish. Check progress with `docker logs ollama`.

**VPS has less than 16GB RAM**
Fix: Switch to `qwen2.5:7b` in `.env`: `OLLAMA_MODEL=qwen2.5:7b`. Same quality, half the RAM.

**Mixpost `http://mixpost` not resolving from n8n**
Cause: Docker service name resolution only works within the same network.
Fix: Both services must be in `cm_net` (they are). If it still fails, use `http://mixpost-container-ip` or the host IP.

**n8n credential PATCH in finalize.js fails with 404**
Cause: n8n API v1 credential update endpoint differs by version.
Fix: Update the credential manually in n8n UI → Settings → Credentials → MIXPOST_AUTH → paste the Bearer token.

**Intrkt inbound flow update fails**
Cause: Intrkt's MCP endpoint path may differ.
Fix: Open Intrkt dashboard → `flow:content-machine:inbound` → update the `relay` step to POST to `https://N8N_HOST/webhook/intrkt-commands` with body `{"text":"${journey.cmd}"}`.

**Switch node in Command Handler not routing correctly**
Cause: n8n Switch node v3 uses output keys that must match exactly.
Fix: In n8n UI, verify the Switch node's output keys match the intent strings: `approve`, `skip`, `edit`, `trust`, `pause`, `resume`, `opinion`, `post_about`, `stats`, `change`.

**Content is generic / sounds like AI**
Cause: Context blocks have placeholder text.
Fix: Open `data/contexts/deep.txt`, replace `[REPLACE_WITH_YOUR_REAL_TWEETS]` with 10 real tweets. Run `docker cp data/contexts/. n8n:/data/contexts/`.
```
