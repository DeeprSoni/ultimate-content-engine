# Content Machine — Account Onboarding SOP

## For: Adding a new user or new account/company to the content machine

---

## Step 1: Voice Discovery Interview (10 minutes)

Ask the account owner these questions. Their answers become the voice guide.

### Identity
1. Who are you? (name, age, role, one sentence)
2. What are you building RIGHT NOW? (not past, not planned — today)
3. What's your unfair advantage? What do you know that others in your space don't?

### Audience & Goal
4. Who do you want reading your posts? (be specific: job titles, geography, mindset)
5. What's the real goal? (followers? clients? reputation? hiring? all?)
6. What should people think after reading 10 of your tweets?

### Voice
7. Paste 5-10 of your best tweets or posts. (If none exist, describe how you talk when arguing with a smart friend about your industry)
8. What tweet style do you HATE? Give examples of what you never want to sound like.
9. Rate these on a 1-5 scale:
   - Controversial ←→ Safe
   - Raw ←→ Polished
   - Short ←→ Long-form
   - Opinionated ←→ Balanced
   - Personal ←→ Professional

### Content
10. What 3-5 topics do you have genuinely strong opinions about? Not "what sounds good" — what would you argue about at dinner?
11. What's a lesson you learned the hard way recently?
12. What do most people in your space get wrong?
13. Do you want to share real numbers? (revenue, users, metrics) Or keep directional? ("hundreds" vs "437")
14. How much personal life in content? (just industry? or also hobbies, philosophy, life?)

### Logistics
15. Which platforms? (Twitter, LinkedIn, Threads, etc.)
16. How many posts per day? (1-3 recommended for Twitter)
17. What time zone are your audience in?
18. Any topics that are absolutely off-limits?

---

## Step 2: Create Voice Guide File

Using the interview answers, create `/data/contexts/{account_id}.txt` with this structure:

```
IDENTITY:
[1-3 lines. Name, age/role, what they build, core belief]

TARGET AUDIENCE:
[1-2 lines. Who, where, what they care about]

VOICE — HOW {NAME} WRITES:
[8-12 bullet points from the interview. Style rules.]

VOICE — NEVER DO THIS:
[5-8 bullet points. Anti-patterns from what they hate.]

REAL TWEETS/POSTS BY {NAME}:
[Paste 5-10 real examples, separated by ---]

TOPICS {NAME} CARES ABOUT:
[5-8 bullet points with specific angles, not generic categories]

CONTENT STRATEGY:
[3-5 strategic notes about what drives reach for this account]
```

---

## Step 3: Create Profile Config

Create `/data/profiles/{account_id}.json`:

```json
{
  "id": "{account_id}",
  "display_name": "{Name} – {Label}",
  "primary_platform": "twitter",
  "platforms": ["twitter", "linkedin"],
  "posting_times": {
    "twitter": "09:00",
    "linkedin": "10:00"
  },
  "pillar_schedule": {
    "Mon": "{Topic 1}",
    "Tue": "{Topic 2}",
    "Wed": "{Topic 3}",
    "Thu": "{Topic 1}",
    "Fri": "{Topic 4}",
    "Sat": "{Topic 2}",
    "Sun": "{Topic 5}"
  },
  "context_file": "{account_id}.txt",
  "trend_keywords": ["{keyword1}", "{keyword2}", "{keyword3}"],
  "trend_threshold": 6,
  "opinion_threshold": 8,
  "trust_level": 0
}
```

**Pillar schedule**: Map their top 5 topics to days of the week.
**Trend keywords**: 5-8 terms for SearXNG to scan for relevant news.
**Trust level**: 0 = auto-generate to pending. User picks from dashboard.

---

## Step 4: Register Account in Workflows

Add the new profile to the workflow cron triggers in `seed/lib/workflows.js`:

1. Add a new cron node (stagger by 2 minutes from existing ones)
2. Add a Set node that injects `profile_id: '{account_id}'`
3. Wire it into the existing Load Config → generation pipeline

For multi-user (different people), each user should have their own:
- Context file
- Profile config
- Dashboard view (filtered by profile_id)

---

## Step 5: Test Generation

Run a manual test before going live:

```bash
# From VPS, inside n8n container:
docker exec n8n node -e '
const https = require("https");
const fs = require("fs");
const ctx = fs.readFileSync("/data/contexts/{account_id}.txt", "utf8");
// ... (same Groq test call as in deployment)
'
```

Review the output. If the voice is off:
- Add more real examples to the context file
- Adjust the voice rules
- Test again

---

## Step 6: Go Live

1. Re-seed workflows: `cd seed && node index.js`
2. Activate: use the activation script
3. Verify on dashboard: check pending posts appear at scheduled time
4. First 3 days: review every post before tweeting. Refine voice guide based on what feels wrong.

---

## Ongoing Maintenance

### Weekly
- Review which tweets the user actually posted vs skipped
- Adjust voice guide based on patterns (what got skipped = what's off-brand)

### Monthly
- Ask the user: "What are you building NOW?" Update the identity section
- Refresh trend keywords based on current focus
- Review analytics: which styles/topics got the most engagement

### When Adding a New Account for Existing User
- Run the voice interview for the new account (company voice ≠ personal voice)
- Create separate context file and profile config
- The same dashboard shows all accounts, filtered by profile_id

---

## File Checklist for New Account

- [ ] `/data/contexts/{account_id}.txt` — Voice guide
- [ ] `/data/profiles/{account_id}.json` — Profile config
- [ ] Updated cron triggers in `workflows.js`
- [ ] Re-seeded workflows
- [ ] Test generation output
- [ ] User reviewed and approved voice
