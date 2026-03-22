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
