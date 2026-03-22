# Ultimate Content Engine

Autonomous multi-platform content generation system. Generates bangers for Twitter, LinkedIn, and Instagram Reels — grounded in your worldview, voice, and real stories.

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

## What's Built

### Content Generation
- **Insight Engine** — One click generates tweet + thread + LinkedIn draft + Reels hook from a single insight
- **Article Scout** — 14 search queries via SearXNG, scores articles 1-10, generates 2 banger takes per article
- **On-Demand Generation** — 8 tweet styles (contrarian, hot take, observation, provocation, raw take, prediction, one-liner, question) + LinkedIn + Reels
- **Regeneration with Feedback** — "Make it shorter", "add India angle" → learns preferences across all future content

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
- **Reels** — Generate scripts + **Render Video** button (TTS + FFmpeg → MP4)
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

## File Structure

```
├── content-hub/
│   ├── Dockerfile          # Node 20 Alpine + FFmpeg + DejaVu fonts
│   ├── package.json        # Express.js only dependency
│   └── server.js           # ~2100 lines — full API + dashboard + render pipeline
├── tts/
│   ├── Dockerfile          # Python 3.11 + Piper TTS + Flask + voice model
│   └── server.py           # POST /synthesize → WAV audio
├── searxng/                # SearXNG config (search engine)
├── docker-compose.yml      # 5 services: n8n, ollama, searxng, content-hub, piper-tts
├── setup.sh                # VPS first-time setup script
├── ONBOARDING_SOP.md       # 14-question voice interview for new users
├── IMPLEMENT.md            # Original implementation plan
└── MANUAL_STEPS.md         # Manual deployment steps
```

## Quick Start

```bash
# 1. Clone and configure
git clone git@github.com:DeeprSoni/ultimate-content-engine.git
cd ultimate-content-engine
cp .env.example .env
# Edit .env with your GROQ_API_KEY, JWT_SECRET, etc.

# 2. Deploy
docker-compose up -d

# 3. Access
# Dashboard: http://localhost:3030/dashboard
# Login: deep@deepsoni.com / ContentMachine2026!
```

### Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `GROQ_API_KEY` | Yes | Groq API key for LLM calls |
| `JWT_SECRET` | Yes | Secret for JWT token signing |
| `PEXELS_API_KEY` | No | Free Pexels key for stock video backgrounds in reels |
| `NTFY_TOPIC` | No | ntfy.sh topic for push notifications |
| `GROQ_MODEL` | No | Default: `llama-3.3-70b-versatile` |

## API Endpoints

### Content
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

## Remaining Work
- **Onboarding Wizard** — Voice interview → context file generation for new users
- **Admin Dashboard** — User management, credit usage, content stats
- **Stripe Billing** — Credit packs + subscription plans (Free/Pro/Agency)
