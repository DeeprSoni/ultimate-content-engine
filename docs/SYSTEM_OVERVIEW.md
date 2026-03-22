# Ultimate Content Engine — System Overview

Autonomous multi-platform content generation system. Generates bangers for Twitter, LinkedIn, and Instagram Reels — grounded in your worldview, voice, and real stories.

---

## Architecture

```
┌─────────────────┐     ┌──────────┐     ┌──────────┐
│   Content Hub    │────▶│  SearXNG  │     │  Ollama   │
│  (Express.js)    │     │ (search)  │     │  (local)  │
│  port 3030       │     └──────────┘     └──────────┘
├─────────────────┤     ┌──────────┐     ┌──────────┐
│  Dashboard UI    │────▶│  Groq    │     │ Piper TTS │
│  Multi-tenant    │     │  (LLM)   │     │ port 5500 │
│  Auth + Credits  │     └──────────┘     └──────────┘
├─────────────────┤     ┌──────────┐
│  Video Render    │────▶│  FFmpeg   │
│  /api/render-reel│     │ (in-container)│
└─────────────────┘     └──────────┘
```

**VPS:** 217.217.249.102 — 5 Docker containers on `cm_net` bridge network.

---

## What's Built

### Content Generation
- **Insight Engine** — One click generates tweet + thread + LinkedIn draft + Reels hook from a single insight
- **Article Scout** — 14 search queries via SearXNG, scores articles 1-10, generates 2 banger takes per article
- **On-Demand Generation** — 8 tweet styles (contrarian, hot take, observation, provocation, raw take, prediction, one-liner, question) + LinkedIn + Reels
- **Regeneration with Feedback** — "Make it shorter", "add India angle" — learns preferences across all future content

### Voice & Identity
- **Voice Context File** — Full identity, worldview, tone rules loaded into every LLM call
- **Story Bank** — 10 real experiences randomly sampled to ground each generation (no generic opinions)
- **10 Worldview Points** — Specific beliefs that shape every take
- **Empathy Module** — Prevents pure edgelord mode, adds nuance
- **Anti-Repeat System** — Last 20 approved posts loaded, blocks same angles
- **7 Banger Frameworks** — Hidden Winner, Contradiction, Builder Angle, Timeline Lie, India Angle, Money Trail, Real Threat

### Multi-Tenant System
- **JWT Auth** — Login/register, 30-day sessions, cookie-based
- **Tenant-Scoped Data** — All reads/writes isolated to `/data/tenants/{userId}/` (published, pending, articles, decisions, stories, contexts, reels)
- **Credit System** — 50 free credits per signup, 1 credit per generation, 2 for insights. Admin gets unlimited.
- **Admin Seed** — `deep@deepsoni.com` auto-created on first boot with existing data migrated
- **Background Jobs** — Scheduled post checker + smart reminders iterate all tenant directories
- **Public Pages** — `/`, `/post/:id`, `/rss.xml` aggregate content across all tenants

### Dashboard (5 tabs)
- **Feed** — Article feed + Generate Insight button
- **Tweets** — Generate with style buttons + Trending section with react-to-article
- **LinkedIn** — Generate LinkedIn posts
- **Reels** — Generate scripts + **Render Video** button (TTS + FFmpeg -> MP4)
- **All** — View all approved content

### Reels Video Pipeline
- **Piper TTS** — Self-hosted text-to-speech (en_US-lessac-medium voice, ~60MB model)
- **FFmpeg Assembly** — Animated gradient backgrounds (hue rotation + vignette) + styled text captions (shadow, box, fade-in) per beat
- **Pexels Stock Video** (optional) — Set `PEXELS_API_KEY` to auto-download portrait stock footage matching each beat's visual description
- **Output** — 1080x1920 MP4 (portrait, reel-ready), downloadable from dashboard

### Publishing Flow
- **One-click Approve & Tweet** — Opens Twitter intent with content pre-filled
- **One-click LinkedIn** — Copies to clipboard + opens LinkedIn composer
- **Scheduling** — Pick time slot (9AM/11AM/2PM/5PM/8PM IST), auto-approves at scheduled time
- **WhatsApp Commands** — LIST, SKIP, approve by number, APPROVE ALL via webhook
- **Smart Notifications** — ntfy.sh push at 11AM/2PM/6PM IST with pending counts
- **Feedback Loop** — Every approve/reject/regen logged to decisions/, format win rates tracked

---

## File Structure

```
ultimate-content-engine/
├── content-hub/
│   ├── Dockerfile          # Node 20 Alpine + FFmpeg + DejaVu fonts
│   ├── package.json        # Express.js only dependency
│   └── server.js           # ~2100 lines — full API + dashboard + render pipeline
├── tts/
│   ├── Dockerfile          # Python 3.11 + Piper TTS + Flask + voice model
│   └── server.py           # POST /synthesize -> WAV audio
├── searxng/                # SearXNG config (search engine)
├── seed/                   # n8n workflow seeding scripts
│   ├── index.js
│   ├── finalize.js
│   ├── package.json
│   └── lib/
│       ├── n8n.js          # n8n API client
│       ├── wait.js         # Health check utility
│       └── workflows.js    # 6 workflow JSON builders
├── data/
│   ├── contexts/           # Voice context files
│   ├── profiles/           # Account profile configs
│   └── stories/            # Story bank JSON
├── docker-compose.yml      # 5 services: n8n, ollama, searxng, content-hub, piper-tts
├── setup.sh                # VPS first-time setup script
├── SUMMARY.md              # Project summary
├── IMPLEMENT.md            # Original implementation plan
├── ONBOARDING_SOP.md       # 14-question voice interview for new users
└── MANUAL_STEPS.md         # Manual deployment steps
```

---

## API Endpoints

### Content Generation
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/insight` | Generate tweet + thread + LinkedIn + Reels from one insight |
| POST | `/api/generate` | Generate content for specific platform/style |
| POST | `/api/scout` | Scan news articles and generate takes |
| GET | `/api/articles` | List scouted articles |
| POST | `/api/article-react/:id` | Use a take or write custom |

### Workflow
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/pending` | List pending posts |
| GET | `/api/posts` | List approved posts |
| POST | `/api/approve/:id` | Approve a pending post |
| POST | `/api/reject/:id` | Reject a pending post |
| POST | `/api/edit/:id` | Edit and approve |
| POST | `/api/approve-and-tweet/:id` | Approve and return content for Twitter intent |
| POST | `/api/regenerate/:id` | Regenerate with feedback comment |
| POST | `/api/schedule/:id` | Schedule post for specific time |

### Video
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/render-reel/:id` | Render pending reels script to MP4 (TTS + FFmpeg) |
| GET | `/reels/:userId/:file` | Download rendered video |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/stats` | Content statistics |
| GET | `/api/decisions` | Decision log with format win rates |
| GET | `/api/credits` | Current user credits and plan |
| POST | `/api/whatsapp-command` | WhatsApp bot commands |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | Yes | Groq API key for LLM calls |
| `JWT_SECRET` | Yes | Secret for JWT token signing |
| `PEXELS_API_KEY` | No | Free Pexels key for stock video backgrounds in reels |
| `NTFY_TOPIC` | No | ntfy.sh topic for push notifications |
| `GROQ_MODEL` | No | Default: `llama-3.3-70b-versatile` |
| `TWITTER_API_KEY` | No | For future auto-posting |
| `TWITTER_API_SECRET` | No | For future auto-posting |
| `TWITTER_ACCESS_TOKEN` | No | For future auto-posting |
| `TWITTER_ACCESS_SECRET` | No | For future auto-posting |

---

## Quick Start

```bash
# 1. Clone and configure
git clone git@github.com:DeeprSoni/ultimate-content-engine.git
cd ultimate-content-engine
cp .env.example .env
# Edit .env with your GROQ_API_KEY, JWT_SECRET, etc.

# 2. Deploy
docker-compose up -d

# 3. Access dashboard
# http://localhost:3030/dashboard
# Login: deep@deepsoni.com / ContentMachine2026!
```

---

## Build History

### Phase 1 — Core Engine (Initial Build)
- Express.js Content Hub with dashboard
- Groq LLM integration for content generation
- SearXNG article scouting
- Voice context + story bank system
- Approve/reject/regen workflow
- Smart notifications via ntfy.sh
- Scheduling + one-click posting

### Phase 2 — Multi-Tenant + Video (2026-03-22)
- JWT auth system with login/register
- Tenant-scoped data isolation (`/data/tenants/{userId}/`)
- Credit system (50 free, admin unlimited)
- Admin seed with data migration
- Background jobs iterate all tenant dirs
- Public pages aggregate across tenants
- Piper TTS Docker service (self-hosted voice synthesis)
- FFmpeg video assembly pipeline (gradient backgrounds + text overlays + TTS audio)
- Render Video button in Reels dashboard tab
- Video download from `/reels/:userId/:file`

### Phase 2.1 — Video Pipeline Fixes (2026-03-22)
- Fixed Piper TTS API (`synthesize_wav` vs `synthesize`)
- Added DejaVu fonts to Alpine container for FFmpeg drawtext
- Fixed text escaping (switched to `textfile=` approach)
- Animated gradient backgrounds (hue rotation + vignette) instead of solid colors
- Styled text captions (shadow, box, fade-in animation, lower-third positioning)
- Optional Pexels stock video backgrounds (`PEXELS_API_KEY`)
- Increased render timeout for longer reels
- Proper recursive temp file cleanup

### Phase 3 — Autonomy Engine (2026-03-22)
- Service-to-service auth (`X-Service-Key` header) for n8n -> Content Hub internal API calls
- WhatsApp notifications via Intrkt Flows Engine (`sendWhatsApp()` + dual-send with ntfy.sh)
- Trust levels API: level 0 (manual), 1 (30-min auto-approve), 2 (instant publish)
- Auto-approve endpoint for trust-level automation
- Direct Twitter API v2 auto-posting with OAuth 1.0a signing
- Content repurposing: tweet -> LinkedIn (300-500 words) + Threads (<300 chars) auto-generation
- Pillar scheduling from profile config (day-of-week based)
- Weekly analytics API (7-day aggregate, approval rates, learnings history)
- Full WhatsApp command handler: LIST, SKIP, ALL, STATS, TRUST, PAUSE, RESUME, POST ABOUT, CHANGE, BRIEF, DIGEST, CANCEL, EDIT
- n8n workflow helpers updated with service auth headers
- 6 n8n workflow builders ready to seed (Morning Brief, Daily Generator, Repurposer, Trend Reactor, Analytics Loop, Command Handler)

---

## Remaining Work
- **Seed n8n Workflows** — Run seed/index.js to deploy 6 automation flows to n8n
- **Intrkt Inbound Flow Update** — Wire WhatsApp commands to n8n webhook
- **Onboarding Wizard** — Voice interview for new user context generation
- **Admin Dashboard** — User management, credit usage, content stats
- **Stripe Billing** — Credit packs + subscription plans (Free/Pro/Agency)
