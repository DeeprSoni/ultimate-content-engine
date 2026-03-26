const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Multi-Tenant Auth System ─────────────────────────────────────────────────

const DATA_DIR = process.env.DATA_DIR || '/data';
const USERS_DIR = path.join(DATA_DIR, 'users');
fs.mkdirSync(USERS_DIR, { recursive: true });

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'cm_session';

function createToken(userId) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: userId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 30 })).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(header + '.' + payload).digest('base64url');
  return header + '.' + payload + '.' + sig;
}

function verifyToken(token) {
  try {
    const [header, payload, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(header + '.' + payload).digest('base64url');
    if (sig !== expected) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data.sub;
  } catch { return null; }
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function getUser(userId) {
  const file = path.join(USERS_DIR, userId + '.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getUserByEmail(email) {
  const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const user = JSON.parse(fs.readFileSync(path.join(USERS_DIR, f), 'utf8'));
      if (user.email === email.toLowerCase()) return user;
    } catch {}
  }
  return null;
}

function saveUser(user) {
  fs.writeFileSync(path.join(USERS_DIR, user.id + '.json'), JSON.stringify(user, null, 2));
}

function getUserDataDir(userId) {
  const dir = path.join(DATA_DIR, 'tenants', userId);
  fs.mkdirSync(path.join(dir, 'published'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'pending'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'articles'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'stories'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'contexts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'reels'), { recursive: true });
  return dir;
}

// ── Tenant aggregation helpers (for public pages & background jobs) ──────────

function getAllTenantDirs() {
  const tenantsDir = path.join(DATA_DIR, 'tenants');
  try {
    return fs.readdirSync(tenantsDir)
      .filter(f => { try { return fs.statSync(path.join(tenantsDir, f)).isDirectory(); } catch { return false; } })
      .map(f => path.join(tenantsDir, f));
  } catch { return []; }
}

function readJsonDir(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));
  } catch { return []; }
}

function readAllTenantsDir(sub) {
  let all = [];
  for (const dir of getAllTenantDirs()) {
    all = all.concat(readJsonDir(path.join(dir, sub)));
  }
  return all.sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));
}

function findPostInTenants(postId) {
  for (const dir of getAllTenantDirs()) {
    const file = path.join(dir, 'published', postId + '.json');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Auth middleware — sets req.userId, req.user, req.userDataDir
function authMiddleware(req, res, next) {
  const publicPaths = ['/login', '/register', '/api/health', '/', '/post/', '/rss.xml'];
  if (publicPaths.some(p => req.path === p || req.path.startsWith('/post/'))) return next();

  // Phase 1: Service-to-service auth (n8n → Content Hub on internal Docker network)
  const serviceKey = req.headers['x-service-key'];
  if (serviceKey && process.env.INTERNAL_SERVICE_KEY && serviceKey === process.env.INTERNAL_SERVICE_KEY) {
    const targetUser = req.headers['x-target-user'] || 'user-deep-admin';
    req.userId = targetUser;
    req.user = getUser(targetUser) || { id: targetUser, credits: 99999, plan: 'admin', name: 'Service' };
    req.userDataDir = getUserDataDir(targetUser);
    return next();
  }

  const token = req.cookies?.[COOKIE_NAME] || req.headers['authorization']?.replace('Bearer ', '');
  if (!token) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
    return res.redirect('/login');
  }

  const userId = verifyToken(token);
  if (!userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Invalid session' });
    return res.redirect('/login');
  }

  const user = getUser(userId);
  if (!user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'User not found' });
    return res.redirect('/login');
  }

  req.userId = userId;
  req.user = user;
  req.userDataDir = getUserDataDir(userId);
  next();
}

// Cookie parser (simple)
app.use(function(req, res, next) {
  req.cookies = {};
  const cookieHeader = req.headers.cookie || '';
  cookieHeader.split(';').forEach(function(c) {
    const parts = c.trim().split('=');
    if (parts.length === 2) req.cookies[parts[0]] = parts[1];
  });
  next();
});

// ── Auth Routes ──────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  const error = req.query.error || '';
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Content Machine — Login</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:32px;width:340px}
h1{font-size:20px;margin-bottom:4px}
.sub{color:#888;font-size:12px;margin-bottom:20px}
label{font-size:12px;color:#888;display:block;margin-bottom:4px}
input{width:100%;padding:10px;background:#1a1a1a;border:1px solid #333;color:#fff;border-radius:6px;font-size:14px;margin-bottom:12px}
button{width:100%;padding:10px;background:#4ade80;color:#000;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:#22c55e}
.link{text-align:center;margin-top:12px;font-size:12px}
.link a{color:#60a5fa;text-decoration:none}
.error{color:#f87171;font-size:12px;margin-bottom:10px}
</style></head><body>
<div class="card">
<h1>Content Machine</h1>
<p class="sub">Sign in to your account</p>
${error ? '<div class="error">' + error + '</div>' : ''}
<form method="POST" action="/login">
<label>Email</label><input name="email" type="email" required autofocus>
<label>Password</label><input name="password" type="password" required>
<button type="submit">Sign In</button>
</form>
<div class="link"><a href="/register">Create an account</a></div>
</div></body></html>`);
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = getUserByEmail(email);
  if (!user) return res.redirect('/login?error=Invalid+email+or+password');

  const { hash } = hashPassword(password, user.salt);
  if (hash !== user.hash) return res.redirect('/login?error=Invalid+email+or+password');

  const token = createToken(user.id);
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; Max-Age=' + (86400 * 30) + '; SameSite=Lax');
  res.redirect('/dashboard');
});

app.get('/register', (req, res) => {
  const error = req.query.error || '';
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Content Machine — Register</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;display:flex;justify-content:center;align-items:center;min-height:100vh}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:32px;width:340px}
h1{font-size:20px;margin-bottom:4px}
.sub{color:#888;font-size:12px;margin-bottom:20px}
label{font-size:12px;color:#888;display:block;margin-bottom:4px}
input{width:100%;padding:10px;background:#1a1a1a;border:1px solid #333;color:#fff;border-radius:6px;font-size:14px;margin-bottom:12px}
button{width:100%;padding:10px;background:#4ade80;color:#000;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:#22c55e}
.link{text-align:center;margin-top:12px;font-size:12px}
.link a{color:#60a5fa;text-decoration:none}
.error{color:#f87171;font-size:12px;margin-bottom:10px}
</style></head><body>
<div class="card">
<h1>Content Machine</h1>
<p class="sub">Create your account</p>
${error ? '<div class="error">' + error + '</div>' : ''}
<form method="POST" action="/register">
<label>Name</label><input name="name" required autofocus>
<label>Email</label><input name="email" type="email" required>
<label>Password</label><input name="password" type="password" required minlength="6">
<button type="submit">Create Account</button>
</form>
<div class="link"><a href="/login">Already have an account?</a></div>
</div></body></html>`);
});

app.post('/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.redirect('/register?error=All+fields+required');
  if (password.length < 6) return res.redirect('/register?error=Password+must+be+6%2B+characters');
  if (getUserByEmail(email)) return res.redirect('/register?error=Email+already+registered');

  const userId = 'user-' + crypto.randomBytes(6).toString('hex');
  const { hash, salt } = hashPassword(password);
  const user = {
    id: userId,
    name,
    email: email.toLowerCase(),
    hash, salt,
    credits: 50,
    plan: 'free',
    created_at: new Date().toISOString()
  };
  saveUser(user);

  // Create user data directory with default context
  const dataDir = getUserDataDir(userId);
  try {
    fs.readFileSync(path.join(DATA_DIR, 'contexts/deep.txt'), 'utf8');
    fs.writeFileSync(path.join(dataDir, 'contexts/default.txt'), '// Customize your voice context here\n// Complete the onboarding to set this up\n');
  } catch {}
  try {
    fs.readFileSync(path.join(DATA_DIR, 'stories/deep_stories.json'), 'utf8');
    fs.writeFileSync(path.join(dataDir, 'stories/stories.json'), '[]');
  } catch {}

  const token = createToken(userId);
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; Max-Age=' + (86400 * 30) + '; SameSite=Lax');
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/login');
});

// ── Credit System ────────────────────────────────────────────────────────────

function deductCredit(userId) {
  const user = getUser(userId);
  if (!user) return { ok: false, error: 'User not found' };
  if (user.credits <= 0) return { ok: false, error: 'No credits remaining. Upgrade your plan.' };
  user.credits--;
  saveUser(user);
  return { ok: true, remaining: user.credits };
}

// Seed Deep's account on first startup
(function seedAdminUser() {
  if (!getUserByEmail('deep@deepsoni.com')) {
    const { hash, salt } = hashPassword('ContentMachine2026!');
    const user = {
      id: 'user-deep-admin',
      name: 'Deep Soni',
      email: 'deep@deepsoni.com',
      hash, salt,
      credits: 99999,
      plan: 'admin',
      created_at: new Date().toISOString()
    };
    saveUser(user);

    // Link existing data to Deep's tenant
    const dataDir = getUserDataDir('user-deep-admin');
    const srcDir = DATA_DIR;
    for (const sub of ['published', 'pending', 'articles', 'decisions']) {
      const src = path.join(srcDir, sub);
      const dst = path.join(dataDir, sub);
      if (fs.existsSync(src) && !fs.existsSync(dst + '/.linked')) {
        try {
          const files = fs.readdirSync(src).filter(f => f.endsWith('.json'));
          for (const f of files) {
            try { fs.copyFileSync(path.join(src, f), path.join(dst, f)); } catch {}
          }
          fs.writeFileSync(dst + '/.linked', 'true');
        } catch {}
      }
    }
    try { fs.copyFileSync(path.join(srcDir, 'contexts/deep.txt'), path.join(dataDir, 'contexts/default.txt')); } catch {}
    try { fs.copyFileSync(path.join(srcDir, 'stories/deep_stories.json'), path.join(dataDir, 'stories/stories.json')); } catch {}

    console.log('Admin user seeded: deep@deepsoni.com');
  }
})();

// Apply auth to everything after this point
app.use(authMiddleware);

app.get('/api/credits', (req, res) => {
  res.json({ credits: req.user.credits, plan: req.user.plan, name: req.user.name });
});

const SITE_TITLE = process.env.SITE_TITLE || 'Content Machine';
const SITE_URL = process.env.SITE_URL || 'https://content.deepsoni.com';
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'deep-content-machine';
const DASHBOARD_URL = SITE_URL + '/dashboard';

// ── Push notification via ntfy.sh ────────────────────────────────────────────

let lastNotifyTime = 0;
function sendNotification(title, body, priority) {
  const now = Date.now();
  if (now - lastNotifyTime < 120000) return;
  lastNotifyTime = now;

  const req = https.request(`https://ntfy.sh/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: {
      'Title': title,
      'Click': DASHBOARD_URL,
      'Tags': priority === '5' ? 'warning' : 'memo',
      'Priority': priority || '4'
    }
  });
  req.on('error', () => {});
  req.write(typeof body === 'string' ? body : title);
  req.end();
  console.log('Notification sent:', title);
}

// ── WhatsApp notification via Intrkt Flows Engine ────────────────────────────

function sendWhatsApp(message) {
  const apiKey = process.env.INTRKT_API_KEY;
  const baseUrl = process.env.INTRKT_BASE_URL;
  const phone = process.env.INTRKT_OPERATOR_PHONE;
  if (!apiKey || !baseUrl || !phone) return;

  const body = JSON.stringify({
    action: 'trigger_interaction',
    phone,
    flow_id: 'flow:content-machine:outbound',
    channel: 'wa_chat',
    journey: { message }
  });

  const url = new URL(baseUrl);
  const mod = url.protocol === 'https:' ? https : http;
  const triggerReq = mod.request(baseUrl + '/api/v1/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'Content-Length': Buffer.byteLength(body) }
  });
  triggerReq.on('error', () => {});
  triggerReq.write(body);
  triggerReq.end();
  console.log('WhatsApp sent:', message.slice(0, 60));
}

// Dual-send: ntfy + WhatsApp
function notify(title, body, priority) {
  sendNotification(title, body, priority);
  sendWhatsApp(title + (body && body !== title ? '\n' + body : ''));
}

// ── Smart notification scheduler (iterates all tenants) ──────────────────────

let lastReminderDate = {};

function checkSmartReminders() {
  const now = new Date();
  const istHour = (now.getUTCHours() + 5) % 24 + (now.getUTCMinutes() + 30 >= 60 ? 1 : 0);
  const istMin = (now.getUTCMinutes() + 30) % 60;
  const today = now.toISOString().slice(0, 10);

  // Aggregate pending across all tenants
  const pending = readAllTenantsDir('pending');
  if (pending.length === 0) return;

  const twitterPending = pending.filter(p => p.platform === 'twitter').length;
  const linkedinPending = pending.filter(p => p.platform === 'linkedin').length;

  const slots = [
    { hour: 11, min: 0, key: 'morning', title: 'Time to post', body: twitterPending + ' tweets + ' + linkedinPending + ' LinkedIn posts ready. Tap to review.', priority: '4' },
    { hour: 14, min: 0, key: 'afternoon', title: 'Reminder: posts waiting', body: 'You still have ' + pending.length + ' posts pending. Quick review takes 2 min.', priority: '4' },
    { hour: 18, min: 0, key: 'evening', title: 'Last call today', body: pending.length + ' posts still pending. Post now or they pile up.', priority: '5' }
  ];

  for (const slot of slots) {
    const slotKey = today + '-' + slot.key;
    if (lastReminderDate[slotKey]) continue;
    if (istHour === slot.hour && istMin >= slot.min && istMin < slot.min + 5) {
      sendNotification(slot.title, slot.body, slot.priority);
      lastReminderDate[slotKey] = true;
    }
  }

  for (const k of Object.keys(lastReminderDate)) {
    if (!k.startsWith(today)) delete lastReminderDate[k];
  }
}

setInterval(checkSmartReminders, 60000);

// ── Schedule checker — auto-approve scheduled posts (iterates all tenants) ───

function checkScheduledPosts() {
  const now = new Date();

  for (const tenantDir of getAllTenantDirs()) {
    const pendDir = path.join(tenantDir, 'pending');
    const pubDir = path.join(tenantDir, 'published');
    const decDir = path.join(tenantDir, 'decisions');
    const pending = readJsonDir(pendDir);

    for (const post of pending) {
      if (!post.scheduled_for) continue;
      const scheduledTime = new Date(post.scheduled_for);
      if (now >= scheduledTime) {
        post.published_at = now.toISOString();
        post.status = 'approved';
        post.auto_scheduled = true;
        delete post.created_at;

        fs.writeFileSync(path.join(pubDir, `${post.id}.json`), JSON.stringify(post, null, 2));

        fs.mkdirSync(decDir, { recursive: true });
        fs.writeFileSync(path.join(decDir, `${post.id}.json`), JSON.stringify({
          type: 'approved',
          post_id: post.id,
          platform: post.platform,
          format: post.format || 'unknown',
          content_preview: (post.content || '').slice(0, 100),
          pillar: post.pillar,
          scheduled: true,
          posted_at_hour: now.getHours(),
          at: now.toISOString()
        }, null, 2));

        try { fs.unlinkSync(path.join(pendDir, `${post.id}.json`)); } catch {}

        const preview = (post.content || '').slice(0, 60);
        sendNotification(
          'Scheduled ' + post.platform + ' post ready',
          preview + '... — Tap to post it now.',
          '5'
        );
        console.log('Auto-approved scheduled post:', post.id);
      }
    }
  }
}

setInterval(checkScheduledPosts, 60000);

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Groq helper ───────────────────────────────────────────────────────────────

async function callGroq(systemPrompt, userPrompt, opts) {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) throw new Error('No GROQ_API_KEY');
  const body = JSON.stringify({
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream: false,
    temperature: opts?.temperature || 0.8,
    max_tokens: opts?.max_tokens || 1500
  });
  const result = await new Promise((resolve, reject) => {
    const req2 = https.request('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Length': Buffer.byteLength(body) }
    }, res2 => { let d = ''; res2.on('data', c => d += c); res2.on('end', () => resolve(d)); });
    req2.on('error', reject);
    req2.write(body);
    req2.end();
  });
  const parsed = JSON.parse(result);
  if (parsed.error) throw new Error(parsed.error.message || 'Groq error');
  return (parsed.choices?.[0]?.message?.content || '').trim();
}

// ── Onboarding helpers ────────────────────────────────────────────────────────

function isOnboardingComplete(userDataDir) {
  const ctxFile = path.join(userDataDir, 'contexts/default.txt');
  try {
    const ctx = fs.readFileSync(ctxFile, 'utf8');
    return ctx.length > 300 && !ctx.includes('Complete the onboarding') && !ctx.includes('// Customize your voice');
  } catch { return false; }
}

// ── Story bank helpers ────────────────────────────────────────────────────────

function loadStories(userDataDir) {
  const f = path.join(userDataDir, 'stories/stories.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}

function saveStoriesFile(userDataDir, stories) {
  const f = path.join(userDataDir, 'stories/stories.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(stories, null, 2));
}

function getRelevantStories(userDataDir, topic, limit) {
  const stories = loadStories(userDataDir);
  if (stories.length === 0) return [];
  limit = limit || 3;
  if (!topic || stories.length <= limit) return stories.slice(0, limit);
  const topicLower = (topic || '').toLowerCase();
  const words = topicLower.split(/\s+/).filter(w => w.length > 3);
  const scored = stories.map(s => {
    const blob = ((s.story || '') + ' ' + (s.lesson || '') + ' ' + (s.tags || []).join(' ')).toLowerCase();
    const score = words.reduce((n, w) => n + (blob.includes(w) ? 1 : 0), 0);
    return { s, score };
  }).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => x.s);
}

// ── Quality gate ──────────────────────────────────────────────────────────────

const SLOP_PHRASES = [
  "in today's fast-paced world", "it's important to note", "game-changer", "game changer",
  "leverage", "synergy", "dive deep", "deep dive", "unpack", "delve into",
  "at the end of the day", "the truth is", "in conclusion", "to summarize",
  "moving forward", "going forward", "best practices", "cutting-edge", "innovative solution",
  "transformative", "disruptive innovation", "revolutionary", "groundbreaking", "unprecedented",
  "paradigm shift", "circle back", "let that sink in", "here's the thing",
  "the reality is", "make no mistake", "at its core", "in a nutshell",
  "long story short", "without further ado", "needless to say", "it goes without saying",
  "i'm thrilled to share", "excited to announce", "passionate about"
];

function qualityGate(content, platform) {
  const errors = [];
  const lower = (content || '').toLowerCase();

  // Slop phrases
  for (const p of SLOP_PHRASES) {
    if (lower.includes(p)) { errors.push('slop: "' + p + '"'); break; }
  }

  // Format gates
  if (platform === 'twitter' && content.length > 280) {
    errors.push('over 280 chars (' + content.length + ')');
  }
  if (platform === 'twitter') {
    if (/^(a thread:|here'?s what i learned|thread:|1\/)/i.test(content.trim())) {
      errors.push('weak thread opener as hook');
    }
  }
  if (platform === 'linkedin') {
    const lines = content.split('\n');
    const firstEmpty = lines.findIndex((l, i) => i > 0 && l.trim() === '');
    if (firstEmpty < 0 || firstEmpty > 4) errors.push('no line break near hook');
  }
  if (platform === 'reels') {
    const firstLine = content.split('\n')[0];
    if (firstLine.split(/\s+/).length > 10) errors.push('hook too long (max 8 words)');
  }

  // Weak hook patterns
  if (platform === 'twitter' || platform === 'linkedin') {
    const firstLine = content.split('\n')[0].toLowerCase();
    if (/^(i'?ve been thinking|today i want to|let me tell you|so i was|this is a (story|thread)|i wanted to share)/.test(firstLine)) {
      errors.push('weak hook opener');
    }
  }

  // Specificity: must have a number OR a named entity (CapitalWord)
  const hasNumber = /\d/.test(content);
  const hasEntity = /\b[A-Z][a-zA-Z]{2,}/.test(content);
  if (!hasNumber && !hasEntity) errors.push('no concrete detail (add number or named entity)');

  return { pass: errors.length === 0, errors };
}

// ── Layered prompt builder ────────────────────────────────────────────────────

function buildLayeredPrompt(userDataDir, pubDir, decDir, topic, platform) {
  // Layer 1: Identity
  let identity = '';
  try {
    const full = fs.readFileSync(path.join(userDataDir, 'contexts/default.txt'), 'utf8');
    const liSection = full.indexOf('LINKEDIN — VOICE');
    identity = liSection > 0 ? full.slice(0, liSection).trim() : full.slice(0, 4000);
  } catch {}

  // Layer 2: Performance (regen feedback learnings)
  let performance = '';
  try {
    const regens = fs.readdirSync(decDir)
      .filter(f => f.startsWith('regen-'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(decDir, f), 'utf8')); } catch { return null; } })
      .filter(Boolean).sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 8).map(d => d.comment);
    if (regens.length > 0) {
      performance = '\n\nLEARNED PREFERENCES (from past feedback — apply always):\n' + regens.map(r => '- ' + r).join('\n');
    }
  } catch {}

  // Layer 3: Stories (topic-relevant)
  const stories = getRelevantStories(userDataDir, topic, 3);
  const storyLayer = stories.length > 0
    ? '\n\nREAL STORIES (weave the most relevant one in):\n' + stories.map(s => '- ' + (s.story || '') + ' (Lesson: ' + (s.lesson || '') + ')').join('\n')
    : '';

  // Layer 4: Anti-repeat (last 30 posts)
  let antiRepeat = '';
  try {
    const recent = readJsonDir(pubDir).filter(p => p.platform === (platform || 'twitter')).slice(0, 30).map(p => (p.content || '').slice(0, 80));
    if (recent.length > 0) {
      antiRepeat = '\n\nALREADY COVERED — find a COMPLETELY DIFFERENT angle:\n' + recent.join('\n');
    }
  } catch {}

  return identity + performance + storyLayer + antiRepeat;
}

function escapeXml(str) {
  return escapeHtml(str).replace(/'/g, '&apos;');
}

// ── API: Publish (auto-publish from n8n) — TENANT-SCOPED ─────────────────────

app.post('/api/publish', (req, res) => {
  const { profile_id, platform, content, display_name, pillar, trend, format } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  const pubDir = path.join(req.userDataDir, 'published');
  const id = generateId();
  const post = {
    id,
    profile_id: profile_id || 'unknown',
    display_name: display_name || profile_id || 'Unknown',
    platform: platform || 'twitter',
    content: typeof content === 'string' ? content : content.tweet || JSON.stringify(content),
    content_full: typeof content === 'object' ? content : { tweet: content },
    pillar: pillar || null,
    trend: trend || null,
    format: format || null,
    published_at: new Date().toISOString(),
    views: 0
  };

  fs.writeFileSync(path.join(pubDir, `${id}.json`), JSON.stringify(post, null, 2));
  res.json({ ok: true, id, url: `${SITE_URL}/post/${id}` });
});

// ── API: Pending (needs approval) — TENANT-SCOPED ────────────────────────────

app.post('/api/pending', (req, res) => {
  const { profile_id, platform, content, display_name, pillar, trend, format } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  const pendDir = path.join(req.userDataDir, 'pending');
  const id = generateId();
  const post = {
    id,
    profile_id: profile_id || 'unknown',
    display_name: display_name || profile_id || 'Unknown',
    platform: platform || 'twitter',
    content: typeof content === 'string' ? content : content.tweet || JSON.stringify(content),
    content_full: typeof content === 'object' ? content : { tweet: content },
    pillar: pillar || null,
    trend: trend || null,
    format: format || null,
    created_at: new Date().toISOString(),
    status: 'pending'
  };

  fs.writeFileSync(path.join(pendDir, `${id}.json`), JSON.stringify(post, null, 2));

  const pendingCount = readJsonDir(pendDir).length;
  sendNotification(
    'Content Machine: ' + pendingCount + ' posts ready',
    (platform || 'twitter') + ' post waiting for review. Tap to open dashboard.'
  );

  res.json({ ok: true, id });
});

// ── API: Approve / Reject / Edit — TENANT-SCOPED ────────────────────────────

app.post('/api/approve/:id', (req, res) => {
  const pendDir = path.join(req.userDataDir, 'pending');
  const pubDir = path.join(req.userDataDir, 'published');
  const decDir = path.join(req.userDataDir, 'decisions');
  const pendingFile = path.join(pendDir, `${req.params.id}.json`);
  if (!fs.existsSync(pendingFile)) return res.status(404).json({ error: 'not found' });

  const post = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  post.published_at = new Date().toISOString();
  post.status = 'published';
  delete post.created_at;

  fs.writeFileSync(path.join(pubDir, `${post.id}.json`), JSON.stringify(post, null, 2));

  fs.mkdirSync(decDir, { recursive: true });
  fs.writeFileSync(path.join(decDir, `${post.id}.json`), JSON.stringify({
    type: 'approved',
    post_id: post.id,
    platform: post.platform,
    format: post.format || 'unknown',
    content_preview: (post.content || '').slice(0, 100),
    pillar: post.pillar,
    trend: post.trend,
    at: new Date().toISOString()
  }, null, 2));

  fs.unlinkSync(pendingFile);
  res.json({ ok: true, id: post.id, url: `${SITE_URL}/post/${post.id}` });
});

app.post('/api/reject/:id', (req, res) => {
  const pendDir = path.join(req.userDataDir, 'pending');
  const decDir = path.join(req.userDataDir, 'decisions');
  const pendingFile = path.join(pendDir, `${req.params.id}.json`);
  if (!fs.existsSync(pendingFile)) return res.status(404).json({ error: 'not found' });

  const rejectedPost = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  fs.mkdirSync(decDir, { recursive: true });
  fs.writeFileSync(path.join(decDir, `${req.params.id}.json`), JSON.stringify({
    type: 'rejected',
    post_id: req.params.id,
    platform: rejectedPost.platform,
    format: rejectedPost.format || 'unknown',
    content_preview: (rejectedPost.content || '').slice(0, 100),
    pillar: rejectedPost.pillar,
    at: new Date().toISOString()
  }, null, 2));

  fs.unlinkSync(pendingFile);
  res.json({ ok: true, rejected: req.params.id });
});

app.post('/api/edit/:id', (req, res) => {
  const pendDir = path.join(req.userDataDir, 'pending');
  const pubDir = path.join(req.userDataDir, 'published');
  const decDir = path.join(req.userDataDir, 'decisions');
  const pendingFile = path.join(pendDir, `${req.params.id}.json`);
  if (!fs.existsSync(pendingFile)) return res.status(404).json({ error: 'not found' });

  const post = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  if (req.body.content) {
    post.content = typeof req.body.content === 'string' ? req.body.content : req.body.content.tweet || JSON.stringify(req.body.content);
    if (typeof req.body.content === 'object') post.content_full = req.body.content;
  }
  post.published_at = new Date().toISOString();
  post.status = 'published';
  post.edited = true;
  delete post.created_at;

  fs.writeFileSync(path.join(pubDir, `${post.id}.json`), JSON.stringify(post, null, 2));

  fs.mkdirSync(decDir, { recursive: true });
  fs.writeFileSync(path.join(decDir, `${post.id}.json`), JSON.stringify({
    type: 'edited',
    post_id: post.id,
    platform: post.platform,
    format: post.format || 'unknown',
    content_preview: (post.content || '').slice(0, 100),
    pillar: post.pillar,
    trend: post.trend,
    at: new Date().toISOString()
  }, null, 2));

  fs.unlinkSync(pendingFile);
  res.json({ ok: true, id: post.id, url: `${SITE_URL}/post/${post.id}` });
});

// ── API: List posts — TENANT-SCOPED ──────────────────────────────────────────

app.get('/api/posts', (req, res) => {
  const pubDir = path.join(req.userDataDir, 'published');
  const posts = readJsonDir(pubDir);
  const limit = parseInt(req.query.limit) || 50;
  res.json({ data: posts.slice(0, limit), total: posts.length });
});

app.get('/api/pending', (req, res) => {
  const pendDir = path.join(req.userDataDir, 'pending');
  const posts = readJsonDir(pendDir);
  res.json({ data: posts, total: posts.length });
});

// ── API: WhatsApp Command — TENANT-SCOPED ─────────────────────────────────────

app.post('/api/whatsapp-command', async (req, res) => {
  const pendDir = path.join(req.userDataDir, 'pending');
  const pubDir = path.join(req.userDataDir, 'published');
  const decDir = path.join(req.userDataDir, 'decisions');
  const stateDir = path.join(req.userDataDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const { text, phone } = req.body;
  const cmd = (text || '').trim().toLowerCase();
  const pending = readJsonDir(pendDir);

  if (!cmd) return res.json({ reply: 'Commands: LIST, SKIP, ALL, STATS, TRUST 0/1/2, PAUSE, RESUME, POST ABOUT <topic>, BRIEF, DIGEST, or send a number to approve.' });

  // LIST pending
  if (cmd === 'list' || cmd === 'pending') {
    if (pending.length === 0) return res.json({ reply: 'No pending posts.' });
    const list = pending.slice(0, 6).map((p, i) =>
      `${i + 1}. [${p.platform}] ${(p.content || '').slice(0, 80)}...`
    ).join('\n');
    return res.json({ reply: `${pending.length} pending:\n\n${list}\n\nReply with number to approve, SKIP to reject all.` });
  }

  // SKIP / REJECT all
  if (cmd === 'skip' || cmd === 'skip all' || cmd === 'reject') {
    let count = 0;
    for (const p of pending) {
      try { fs.unlinkSync(path.join(pendDir, `${p.id}.json`)); count++; } catch {}
    }
    return res.json({ reply: `Rejected ${count} pending posts.` });
  }

  // APPROVE ALL
  if (cmd === 'approve all' || cmd === 'all') {
    let count = 0;
    for (const p of pending) {
      p.published_at = new Date().toISOString();
      p.status = 'published';
      delete p.created_at;
      fs.writeFileSync(path.join(pubDir, `${p.id}.json`), JSON.stringify(p, null, 2));
      try { fs.unlinkSync(path.join(pendDir, `${p.id}.json`)); } catch {}
      count++;
    }
    return res.json({ reply: `Approved all ${count} posts.` });
  }

  // STATS
  if (cmd === 'stats') {
    const published = readJsonDir(pubDir);
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const thisWeek = published.filter(p => new Date(p.published_at) >= weekAgo);
    return res.json({ reply: `Stats:\nTotal published: ${published.length}\nPending: ${pending.length}\nThis week: ${thisWeek.length}\nPlatforms: ${[...new Set(published.map(p => p.platform))].join(', ')}` });
  }

  // TRUST 0/1/2 or TRUST <channel> <level>
  if (cmd.startsWith('trust ')) {
    const parts = cmd.split(' ');
    const channels = ['twitter', 'linkedin', 'reels', 'threads'];
    let lvl, channel;
    if (parts.length === 3 && channels.includes(parts[1])) {
      channel = parts[1];
      lvl = parseInt(parts[2]);
    } else {
      lvl = parseInt(parts[1]);
    }
    if (isNaN(lvl) || lvl < 0 || lvl > 2) return res.json({ reply: 'Usage: TRUST 0/1/2 (all channels) or TRUST twitter 2 (per channel)' });
    const trustFile = path.join(stateDir, 'trust.json');
    let current = {};
    try { current = JSON.parse(fs.readFileSync(trustFile, 'utf8')); } catch {}
    if (!current.per_channel_trust) current.per_channel_trust = { twitter: 0, linkedin: 0, reels: 0, threads: 0 };
    if (channel) {
      current.per_channel_trust[channel] = lvl;
    } else {
      current.trust_level = lvl;
      for (const ch of Object.keys(current.per_channel_trust)) current.per_channel_trust[ch] = lvl;
    }
    current.updated_at = new Date().toISOString();
    fs.writeFileSync(trustFile, JSON.stringify(current, null, 2));
    const labels = ['Manual approval', '30-min auto-approve', 'Instant publish'];
    const scope = channel ? channel : 'all channels';
    return res.json({ reply: `Trust level ${lvl} (${labels[lvl]}) set for ${scope}.` });
  }

  // PAUSE / RESUME
  if (cmd === 'pause') {
    fs.writeFileSync(path.join(stateDir, 'paused.json'), JSON.stringify({ paused: true, at: new Date().toISOString() }));
    return res.json({ reply: 'Content generation paused. Send RESUME to restart.' });
  }
  if (cmd === 'resume') {
    try { fs.unlinkSync(path.join(stateDir, 'paused.json')); } catch {}
    return res.json({ reply: 'Content generation resumed.' });
  }

  // POST ABOUT <topic>
  if (cmd.startsWith('post about ')) {
    const topic = text.trim().slice(11);
    fs.writeFileSync(path.join(stateDir, 'post_about.json'), JSON.stringify({ topic, at: new Date().toISOString() }));
    return res.json({ reply: `Queued: will generate a post about "${topic}" on next cycle.` });
  }

  // CHANGE (generate 3 alt briefs for today)
  if (cmd === 'change') {
    try {
      const briefFile = path.join(stateDir, 'brief_today.json');
      let currentTopic = '';
      try { currentTopic = JSON.parse(fs.readFileSync(briefFile, 'utf8')).topic; } catch {}
      const ctxFile = path.join(req.userDataDir, 'contexts/default.txt');
      let ctx = '';
      try { ctx = fs.readFileSync(ctxFile, 'utf8').slice(0, 2000); } catch {}
      const altResult = await callGroq(
        ctx + '\n\nGenerate 3 alternative content briefs. Return ONLY valid JSON array of 3 objects.',
        'Current topic: "' + (currentTopic || 'none') + '". Generate 3 fresh alternatives.\n[{"topic":"...","angle":"...","framework":"...","hook_direction":"...","emotion":"..."},...]',
        { temperature: 0.9, max_tokens: 500 }
      );
      const jsonMatch = altResult.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const alts = JSON.parse(jsonMatch[0]);
        fs.writeFileSync(path.join(stateDir, 'brief_alternatives.json'), JSON.stringify({ alts, at: new Date().toISOString() }, null, 2));
        const altText = alts.slice(0, 3).map((a, i) => `${i+1}. [${a.framework}] ${a.topic} — ${a.angle}`).join('\n');
        return res.json({ reply: `3 alternative briefs:\n\n${altText}\n\nReply with number (1/2/3) to pick one.` });
      }
    } catch (e) { console.error('Change brief error:', e.message); }
    fs.writeFileSync(path.join(stateDir, 'override_use_trend.json'), JSON.stringify({ use_trend: true, at: new Date().toISOString() }));
    return res.json({ reply: 'Switched today to trending topic instead of scheduled pillar.' });
  }

  // BRIEF (show last morning brief)
  if (cmd === 'brief') {
    try {
      const brief = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state/last_brief_deep_personal.json'), 'utf8'));
      return res.json({ reply: brief.brief || 'No brief available.' });
    } catch {
      return res.json({ reply: 'No brief available yet. Wait for the morning scan.' });
    }
  }

  // DIGEST (show last weekly digest)
  if (cmd === 'digest') {
    try {
      const digest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state/last_digest_deep_personal.json'), 'utf8'));
      return res.json({ reply: digest.digest || 'No digest available.' });
    } catch {
      return res.json({ reply: 'No digest available yet. Wait for Sunday evening.' });
    }
  }

  // CANCEL (cancel last auto-posted)
  if (cmd === 'cancel') {
    const published = readJsonDir(pubDir);
    const lastAuto = published.find(p => p.auto_approved);
    if (!lastAuto) return res.json({ reply: 'No auto-approved posts to cancel.' });
    const twoHoursAgo = Date.now() - 2 * 3600000;
    if (new Date(lastAuto.published_at).getTime() < twoHoursAgo) return res.json({ reply: 'Cancel window expired (2 hours).' });
    try { fs.unlinkSync(path.join(pubDir, `${lastAuto.id}.json`)); } catch {}
    return res.json({ reply: `Cancelled: [${lastAuto.platform}] ${(lastAuto.content || '').slice(0, 80)}` });
  }

  // EDIT <number> <new text>
  const editMatch = cmd.match(/^edit\s+(\d+)\s+(.+)/);
  if (editMatch) {
    const idx = parseInt(editMatch[1]) - 1;
    if (idx < 0 || idx >= pending.length) return res.json({ reply: `No pending post #${idx + 1}.` });
    const post = pending[idx];
    post.content = text.trim().slice(editMatch[0].indexOf(editMatch[2]));
    post.edited = true;
    fs.writeFileSync(path.join(pendDir, `${post.id}.json`), JSON.stringify(post, null, 2));
    return res.json({ reply: `Edited #${idx + 1}. Send ${idx + 1} to approve or LIST to review.` });
  }

  // Approve by number
  const num = parseInt(cmd);
  if (!isNaN(num) && num >= 1 && num <= pending.length) {
    const post = pending[num - 1];
    post.published_at = new Date().toISOString();
    post.status = 'published';
    delete post.created_at;
    fs.writeFileSync(path.join(pubDir, `${post.id}.json`), JSON.stringify(post, null, 2));
    try { fs.unlinkSync(path.join(pendDir, `${post.id}.json`)); } catch {}
    const preview = (post.content || '').slice(0, 100);
    return res.json({ reply: `Approved #${num} [${post.platform}]:\n${preview}` });
  }

  return res.json({ reply: `Commands: LIST, SKIP, ALL, STATS, TRUST 0/1/2, PAUSE, RESUME, POST ABOUT <topic>, BRIEF, DIGEST, CANCEL, EDIT <n> <text>, or number to approve.` });
});

// ── API: Schedule a pending post — TENANT-SCOPED ─────────────────────────────

app.post('/api/schedule/:id', (req, res) => {
  const pendDir = path.join(req.userDataDir, 'pending');
  const pendingFile = path.join(pendDir, `${req.params.id}.json`);
  if (!fs.existsSync(pendingFile)) return res.status(404).json({ error: 'not found' });

  const { time } = req.body;
  if (!time) return res.status(400).json({ error: 'time is required' });

  const post = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));

  let scheduledFor;
  if (time.includes('T') || time.includes('Z')) {
    scheduledFor = new Date(time);
  } else {
    const now = new Date();
    scheduledFor = new Date(now.toISOString().slice(0, 10) + 'T' + time + ':00+05:30');
    if (scheduledFor <= now) scheduledFor.setDate(scheduledFor.getDate() + 1);
  }

  post.scheduled_for = scheduledFor.toISOString();
  fs.writeFileSync(pendingFile, JSON.stringify(post, null, 2));

  res.json({ ok: true, id: post.id, scheduled_for: post.scheduled_for });
});

// ── API: Approve-and-tweet — TENANT-SCOPED ───────────────────────────────────

app.post('/api/approve-and-tweet/:id', (req, res) => {
  const pendDir = path.join(req.userDataDir, 'pending');
  const pubDir = path.join(req.userDataDir, 'published');
  const decDir = path.join(req.userDataDir, 'decisions');
  const pendingFile = path.join(pendDir, `${req.params.id}.json`);
  if (!fs.existsSync(pendingFile)) return res.status(404).json({ error: 'not found' });

  const post = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  post.published_at = new Date().toISOString();
  post.status = 'approved';
  delete post.created_at;

  fs.writeFileSync(path.join(pubDir, `${post.id}.json`), JSON.stringify(post, null, 2));

  fs.mkdirSync(decDir, { recursive: true });
  fs.writeFileSync(path.join(decDir, `${post.id}.json`), JSON.stringify({
    type: 'approved',
    post_id: post.id,
    platform: post.platform,
    format: post.format || 'unknown',
    content_preview: (post.content || '').slice(0, 100),
    pillar: post.pillar,
    trend: post.trend,
    at: new Date().toISOString()
  }, null, 2));

  fs.unlinkSync(pendingFile);
  res.json({ ok: true, id: post.id, content: post.content, platform: post.platform });
});

// ── API: Stats — TENANT-SCOPED ───────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const pubDir = path.join(req.userDataDir, 'published');
  const pendDir = path.join(req.userDataDir, 'pending');
  const published = readJsonDir(pubDir);
  const pending = readJsonDir(pendDir);

  const byProfile = {};
  const byPlatform = {};
  for (const p of published) {
    byProfile[p.profile_id] = (byProfile[p.profile_id] || 0) + 1;
    byPlatform[p.platform] = (byPlatform[p.platform] || 0) + 1;
  }

  res.json({
    total_published: published.length,
    total_pending: pending.length,
    total_views: published.reduce((sum, p) => sum + (p.views || 0), 0),
    by_profile: byProfile,
    by_platform: byPlatform,
    latest: published[0] || null
  });
});

// ── API: Decisions — TENANT-SCOPED ───────────────────────────────────────────

app.get('/api/decisions', (req, res) => {
  const decDir = path.join(req.userDataDir, 'decisions');
  try {
    const files = fs.readdirSync(decDir).filter(f => f.endsWith('.json'));
    const decisions = files.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(decDir, f), 'utf8')); }
      catch { return null; }
    }).filter(Boolean);

    const formatStats = {};
    for (const d of decisions) {
      const fmt = d.format || 'unknown';
      if (!formatStats[fmt]) formatStats[fmt] = { approved: 0, rejected: 0, total: 0 };
      formatStats[fmt].total++;
      if (d.type === 'approved' || d.type === 'edited') formatStats[fmt].approved++;
      else if (d.type === 'rejected') formatStats[fmt].rejected++;
    }

    for (const fmt of Object.keys(formatStats)) {
      const s = formatStats[fmt];
      s.win_rate = s.total > 0 ? Math.round((s.approved / s.total) * 100) : 0;
    }

    res.json({
      total: decisions.length,
      format_stats: formatStats,
      recent: decisions.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 20)
    });
  } catch {
    res.json({ total: 0, format_stats: {}, recent: [] });
  }
});

// ── API: Story Bank — TENANT-SCOPED ──────────────────────────────────────────

app.get('/api/stories', (req, res) => {
  const stories = loadStories(req.userDataDir);
  res.json({ data: stories, total: stories.length });
});

app.post('/api/stories', async (req, res) => {
  const { story, lesson, tags } = req.body;
  if (!story) return res.status(400).json({ error: 'story is required' });
  const stories = loadStories(req.userDataDir);
  const id = generateId();
  let autoTags = tags || [];

  // Auto-tag via Groq if no tags provided
  if (autoTags.length === 0 && process.env.GROQ_API_KEY) {
    try {
      const tagResult = await callGroq(
        'Extract 3-5 topic keywords from this story. Return ONLY a JSON array of lowercase strings, no other text.',
        story + '\n\nLesson: ' + (lesson || ''),
        { temperature: 0.3, max_tokens: 100 }
      );
      const jsonMatch = tagResult.match(/\[[\s\S]*?\]/);
      if (jsonMatch) autoTags = JSON.parse(jsonMatch[0]);
    } catch {}
  }

  const entry = { id, story, lesson: lesson || '', tags: autoTags, added_at: new Date().toISOString() };
  stories.push(entry);
  saveStoriesFile(req.userDataDir, stories);
  res.json({ ok: true, story: entry, total: stories.length });
});

app.patch('/api/stories/:id', (req, res) => {
  const stories = loadStories(req.userDataDir);
  const idx = stories.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  Object.assign(stories[idx], req.body, { updated_at: new Date().toISOString() });
  saveStoriesFile(req.userDataDir, stories);
  res.json({ ok: true, story: stories[idx] });
});

app.delete('/api/stories/:id', (req, res) => {
  const stories = loadStories(req.userDataDir);
  const filtered = stories.filter(s => s.id !== req.params.id);
  if (filtered.length === stories.length) return res.status(404).json({ error: 'not found' });
  saveStoriesFile(req.userDataDir, filtered);
  res.json({ ok: true, remaining: filtered.length });
});

// ── API: Brief-first flow — TENANT-SCOPED ────────────────────────────────────

app.get('/api/brief/today', (req, res) => {
  const stateDir = path.join(req.userDataDir, 'state');
  const briefFile = path.join(stateDir, 'brief_today.json');
  try {
    const brief = JSON.parse(fs.readFileSync(briefFile, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    if (brief.date !== today) return res.json({ brief: null });
    res.json({ brief });
  } catch { res.json({ brief: null }); }
});

app.post('/api/brief', (req, res) => {
  const { topic, angle, framework, hook_direction, emotion } = req.body;
  const stateDir = path.join(req.userDataDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const brief = {
    date: new Date().toISOString().slice(0, 10),
    topic: topic || '',
    angle: angle || '',
    framework: framework || '',
    hook_direction: hook_direction || '',
    emotion: emotion || '',
    status: 'pending',
    created_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(stateDir, 'brief_today.json'), JSON.stringify(brief, null, 2));
  notify("Today's brief ready", (topic || 'Brief') + (angle ? ' — ' + angle : ''), '4');
  res.json({ ok: true, brief });
});

app.patch('/api/brief', (req, res) => {
  const stateDir = path.join(req.userDataDir, 'state');
  const briefFile = path.join(stateDir, 'brief_today.json');
  try {
    const brief = JSON.parse(fs.readFileSync(briefFile, 'utf8'));
    Object.assign(brief, req.body, { status: 'confirmed', updated_at: new Date().toISOString() });
    fs.writeFileSync(briefFile, JSON.stringify(brief, null, 2));
    res.json({ ok: true, brief });
  } catch { res.status(404).json({ error: 'No brief for today' }); }
});

// Generate 3 alt briefs (for WhatsApp CHANGE command)
app.post('/api/brief/alternatives', async (req, res) => {
  const { current_topic } = req.body;
  const stateDir = path.join(req.userDataDir, 'state');
  const ctxFile = path.join(req.userDataDir, 'contexts/default.txt');
  let ctx = '';
  try { ctx = fs.readFileSync(ctxFile, 'utf8').slice(0, 2000); } catch {}

  try {
    const result = await callGroq(
      ctx + '\n\nGenerate 3 alternative content briefs for today. Return ONLY valid JSON array.',
      'Current topic was: "' + (current_topic || 'none') + '". Generate 3 fresh alternatives.\n' +
      'Each brief: {"topic":"...","angle":"...","framework":"HIDDEN WINNER|CONTRADICTION|BUILDER ANGLE|TIMELINE LIE|INDIA ANGLE","hook_direction":"one sentence hook direction","emotion":"anger|fear|superiority|hope"}\n' +
      'Return: [brief1, brief2, brief3]',
      { temperature: 0.9, max_tokens: 600 }
    );
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON');
    const alts = JSON.parse(jsonMatch[0]);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'brief_alternatives.json'), JSON.stringify({ alts, at: new Date().toISOString() }, null, 2));
    res.json({ ok: true, alternatives: alts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API: Per-channel trust levels ────────────────────────────────────────────

app.get('/api/trust', (req, res) => {
  const stateDir = path.join(req.userDataDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  try {
    const data = JSON.parse(fs.readFileSync(path.join(stateDir, 'trust.json'), 'utf8'));
    res.json(data);
  } catch {
    res.json({ trust_level: 0, per_channel_trust: { twitter: 0, linkedin: 0, reels: 0, threads: 0 } });
  }
});

app.post('/api/trust', (req, res) => {
  const { level, channel } = req.body;
  const lvl = parseInt(level);
  if (isNaN(lvl) || lvl < 0 || lvl > 2) return res.status(400).json({ error: 'level must be 0, 1, or 2' });
  const stateDir = path.join(req.userDataDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const trustFile = path.join(stateDir, 'trust.json');
  let current = {};
  try { current = JSON.parse(fs.readFileSync(trustFile, 'utf8')); } catch {}
  if (!current.per_channel_trust) current.per_channel_trust = { twitter: 0, linkedin: 0, reels: 0, threads: 0 };

  if (channel) {
    current.per_channel_trust[channel] = lvl;
  } else {
    current.trust_level = lvl;
    // Set all channels to the same level when global trust is set
    for (const ch of Object.keys(current.per_channel_trust)) {
      current.per_channel_trust[ch] = lvl;
    }
  }
  current.updated_at = new Date().toISOString();
  fs.writeFileSync(trustFile, JSON.stringify(current, null, 2));
  const labels = ['Manual approval', '30-min auto-approve', 'Instant publish'];
  res.json({ ok: true, trust_level: current.trust_level || 0, per_channel_trust: current.per_channel_trust, label: labels[lvl] });
});

// ── API: Onboarding ───────────────────────────────────────────────────────────

app.get('/api/onboarding/status', (req, res) => {
  const complete = isOnboardingComplete(req.userDataDir);
  const stories = loadStories(req.userDataDir);
  res.json({ complete, story_count: stories.length, needs_stories: stories.length < 5 });
});

app.post('/api/onboarding', async (req, res) => {
  const { name, role, building, audience, voice_sliders, real_examples, worldview, unfair_advantage } = req.body;
  if (!name || !role) return res.status(400).json({ error: 'name and role required' });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'No GROQ_API_KEY' });

  const onboardingData = JSON.stringify(req.body, null, 2);
  const slopStyleGuide = `
STYLE RULES:
- Raw, direct, not corporate
- No buzzwords: no "leverage", "synergy", "game-changer", "innovative", "passionate"
- Short sentences. Space with line breaks.
- Opinion-first, not setup-first
- Grounded in real stories, not theories
`;

  try {
    const contextText = await callGroq(
      'You generate voice context files for content generation systems. The context file tells the AI who this person is so it can write in their exact voice.',
      'Generate a comprehensive voice context file for this person:\n\n' + onboardingData +
      '\n\nCreate a context file with these sections:\n' +
      '1. IDENTITY: Name, role, what building, unfair advantage\n' +
      '2. AUDIENCE: Who reads, what they care about, what they should feel after 10 posts\n' +
      '3. VOICE RULES: Tone, style, what to avoid (based on sliders and preferences)\n' +
      '4. WORLDVIEW: 5-7 specific contrarian beliefs they hold\n' +
      '5. BANGER FRAMEWORKS: Which of these fit them: Hidden Winner, Contradiction, Builder Angle, Timeline Lie, India Angle, Money Trail, Real Threat\n' +
      '6. EXAMPLES OF BANGER TWEETS: Real examples they provided\n' +
      '7. FORBIDDEN: Phrases and patterns to never use\n\n' +
      slopStyleGuide,
      { temperature: 0.7, max_tokens: 2000 }
    );

    const ctxDir = path.join(req.userDataDir, 'contexts');
    fs.mkdirSync(ctxDir, { recursive: true });
    fs.writeFileSync(path.join(ctxDir, 'default.txt'), contextText);
    fs.writeFileSync(path.join(ctxDir, 'onboarding_raw.json'), JSON.stringify(req.body, null, 2));

    // Seed stories from real examples if provided
    if (real_examples && Array.isArray(real_examples) && real_examples.length > 0) {
      const existing = loadStories(req.userDataDir);
      if (existing.length === 0) {
        const seedStories = real_examples.slice(0, 5).map((ex, i) => ({
          id: generateId(),
          story: typeof ex === 'string' ? ex : (ex.story || ex),
          lesson: typeof ex === 'object' ? (ex.lesson || '') : '',
          tags: [],
          added_at: new Date().toISOString()
        }));
        saveStoriesFile(req.userDataDir, seedStories);
      }
    }

    res.json({ ok: true, message: 'Voice context generated. Generation is now unlocked.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Regenerate with feedback — TENANT-SCOPED ────────────────────────────

app.post('/api/regenerate/:id', async (req, res) => {
  const pendDir = path.join(req.userDataDir, 'pending');
  const decDir = path.join(req.userDataDir, 'decisions');
  const ctxFile = path.join(req.userDataDir, 'contexts/default.txt');
  const pendingFile = path.join(pendDir, `${req.params.id}.json`);
  if (!fs.existsSync(pendingFile)) return res.status(404).json({ error: 'not found' });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'No GROQ_API_KEY' });

  const post = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  const { comment } = req.body;
  if (!comment) return res.status(400).json({ error: 'comment is required' });

  let context = '';
  try { context = fs.readFileSync(ctxFile, 'utf8'); } catch {}

  let pastFeedback = [];
  try {
    if (fs.existsSync(decDir)) {
      pastFeedback = fs.readdirSync(decDir)
        .filter(f => f.startsWith('regen-'))
        .map(f => { try { return JSON.parse(fs.readFileSync(path.join(decDir, f), 'utf8')); } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => new Date(b.at) - new Date(a.at))
        .slice(0, 10)
        .map(d => d.comment);
    }
  } catch {}

  const feedbackContext = pastFeedback.length > 0
    ? '\n\nPast feedback patterns (apply these preferences to all future content):\n' + pastFeedback.map((f, i) => '- ' + f).join('\n') + '\n'
    : '';

  const isLinkedIn = post.platform === 'linkedin';
  const isReels = post.platform === 'reels';

  let regenPrompt = 'Original ' + post.platform + ' post:\n"' + (post.content || '').slice(0, 500) + '"\n\n' +
    'User feedback: "' + comment + '"\n\n' +
    'Rewrite the post incorporating this feedback. Keep the same platform and format.\n';

  if (isReels) {
    regenPrompt += 'Return a Reels script JSON: {"hook":"...","beats":[{"voiceover":"...","visual":"...","duration":"Xs"}],"cta":"...","music_mood":"...","total_duration":"Xs"}';
  } else if (isLinkedIn) {
    regenPrompt += 'Return ONLY the LinkedIn post text. 300-500 words. Hook in first 2 lines.';
  } else {
    regenPrompt += 'Return ONLY the tweet text. Under 280 chars. Space out with line breaks. No emojis, no hashtags.';
  }

  const sysPrompt = context + feedbackContext + (isLinkedIn
    ? '\n\nYou are rewriting a LinkedIn post as Deep based on his feedback.'
    : '\n\nYou ARE Deep. Rewrite based on his feedback. Match his voice.');

  try {
    const body = JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: regenPrompt }],
      stream: false, temperature: 0.75
    });
    const result = await new Promise((resolve, reject) => {
      const req2 = https.request('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Length': Buffer.byteLength(body) }
      }, res2 => { let d = ''; res2.on('data', c => d += c); res2.on('end', () => resolve(d)); });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    const parsed = JSON.parse(result);
    let newContent = parsed.choices?.[0]?.message?.content || post.content;

    if (isReels) {
      try {
        const script = JSON.parse(newContent.replace(/```json|```/g, '').trim());
        newContent = 'HOOK: ' + (script.hook || '') + '\n\n' +
          (script.beats || []).map((b, i) => 'BEAT ' + (i+1) + ' (' + (b.duration || '?') + '):\n' + (b.voiceover || '') + '\nVISUAL: ' + (b.visual || '')).join('\n\n') +
          '\n\nCTA: ' + (script.cta || '') + '\nMOOD: ' + (script.music_mood || 'energetic');
      } catch {}
    }

    post.content = newContent;
    post.regenerated = true;
    post.regen_comment = comment;
    post.regen_count = (post.regen_count || 0) + 1;
    fs.writeFileSync(pendingFile, JSON.stringify(post, null, 2));

    fs.mkdirSync(decDir, { recursive: true });
    fs.writeFileSync(path.join(decDir, `regen-${post.id}-${Date.now()}.json`), JSON.stringify({
      type: 'regenerated',
      post_id: post.id,
      platform: post.platform,
      format: post.format || 'unknown',
      original_preview: (req.body.original || post.content || '').slice(0, 100),
      comment: comment,
      at: new Date().toISOString()
    }, null, 2));

    res.json({ ok: true, id: post.id, content: newContent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Generate Insight — TENANT-SCOPED ────────────────────────────────────

app.post('/api/insight', async (req, res) => {
  if (req.user && req.user.plan !== 'admin') {
    const credit = deductCredit(req.userId);
    if (!credit.ok) return res.status(402).json({ error: credit.error });
    deductCredit(req.userId);
  }

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'No GROQ_API_KEY' });

  const pendDir = path.join(req.userDataDir, 'pending');
  const pubDir = path.join(req.userDataDir, 'published');
  const decDir = path.join(req.userDataDir, 'decisions');
  const ctxFile = path.join(req.userDataDir, 'contexts/default.txt');
  const storiesFile = path.join(req.userDataDir, 'stories/stories.json');

  const { topic, worldview_point } = req.body;

  let context = '';
  try {
    const full = fs.readFileSync(ctxFile, 'utf8');
    const liSection = full.indexOf('LINKEDIN — VOICE');
    context = liSection > 0 ? full.slice(0, liSection).trim() : full.slice(0, 4000);
  } catch {}

  let stories = [];
  try { stories = JSON.parse(fs.readFileSync(storiesFile, 'utf8')); } catch {}

  const shuffledStories = [...stories].sort(() => Math.random() - 0.5).slice(0, 3);
  const storyContext = shuffledStories.map(s => '- ' + s.story + ' (Lesson: ' + s.lesson + ')').join('\n');

  let recentContent = [];
  try {
    recentContent = readJsonDir(pubDir)
      .slice(0, 20)
      .map(p => (p.content || '').slice(0, 60));
  } catch {}
  const antiRepeat = recentContent.length > 0
    ? '\n\nALREADY COVERED (find a COMPLETELY different angle):\n' + recentContent.join('\n')
    : '';

  let feedback = '';
  try {
    if (fs.existsSync(decDir)) {
      const regens = fs.readdirSync(decDir)
        .filter(f => f.startsWith('regen-'))
        .map(f => { try { return JSON.parse(fs.readFileSync(path.join(decDir, f), 'utf8')); } catch { return null; } })
        .filter(Boolean).slice(0, 10).map(d => d.comment);
      if (regens.length > 0) feedback = '\n\nLEARNED PREFERENCES:\n' + regens.map(r => '- ' + r).join('\n');
    }
  } catch {}

  // Use layered prompt builder instead of ad-hoc assembly
  const layeredContext = buildLayeredPrompt(req.userDataDir, pubDir, decDir, topic, 'twitter');

  const insightPrompt = (topic ? 'TOPIC: ' + topic : 'Pick a fresh topic from the worldview.') +
    (worldview_point ? '\nWORLDVIEW LENS: ' + worldview_point : '') +
    '\n\nGenerate ONE insight that passes the AHA TEST: it connects two things the reader hasn\'t connected before.' +
    '\n\nRules:' +
    '\n- The tweet MUST include a real story or specific experience — stories are in the system prompt' +
    '\n- Target ONE emotion: ANGER (at status quo) or FEAR (being left behind) or SUPERIORITY (reader feels smart) or HOPE (exciting future)' +
    '\n- Declare the emotion BEFORE writing, then write for that emotion' +
    '\n- Pick ONE framework: Hidden Winner / Contradiction / Builder Angle / Timeline Lie / India Angle' +
    '\n- The thread: Hook (curiosity gap) → Setup (popular belief) → Twist (what\'s actually true) → Evidence (specific) → Implication → CTA' +
    '\n- NEVER write "X will replace Y" or "X is dead" — find the non-obvious angle' +
    '\n- Each tweet must be something the reader SCREENSHOTS or QUOTE-TWEETS' +
    '\n\nReturn ONLY valid JSON (no markdown, no code fences):' +
    '\n{"emotion":"anger/fear/superiority/hope","framework":"which framework used","insight":"core idea","tweet":"under 280 chars with line breaks","thread":["hook","setup","twist","evidence","implication","CTA"],"linkedin_angle":"1 sentence expansion","reels_hook":"first 3 seconds that stop the scroll"}' +
    antiRepeat + feedback;

  try {
    const insightSys = layeredContext + '\n\nYou generate insights grounded in real experience. Second-order thinking. Non-obvious. Banger only.';
    const rawInsight = await callGroq(insightSys, insightPrompt, { temperature: 0.88, max_tokens: 2000 });

    let insight;
    try {
      const jsonMatch = rawInsight.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      let jsonStr = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
      insight = JSON.parse(jsonStr);
    } catch (parseErr) {
      try {
        const tweetMatch = rawInsight.match(/"tweet"\s*:\s*"([^"]+)"/);
        const insightMatch = rawInsight.match(/"insight"\s*:\s*"([^"]+)"/);
        if (tweetMatch) {
          insight = { insight: insightMatch ? insightMatch[1] : '', tweet: tweetMatch[1], thread: [], linkedin_angle: '', reels_hook: '' };
        } else throw parseErr;
      } catch {
        return res.status(500).json({ error: 'Failed to parse insight', raw: rawInsight.slice(0, 300) });
      }
    }

    // Quality gate on tweet
    const tweetGate = qualityGate(insight.tweet || '', 'twitter');
    if (!tweetGate.pass) console.log('Insight tweet quality issues:', tweetGate.errors);

    // Save tweet to pending
    const tweetId = generateId();
    fs.writeFileSync(path.join(pendDir, tweetId + '.json'), JSON.stringify({
      id: tweetId, profile_id: 'deep_personal', display_name: 'Deep – Personal',
      platform: 'twitter', content: insight.tweet || '', pillar: insight.angle || 'insight',
      format: 'insight_tweet', created_at: new Date().toISOString(), status: 'pending',
      content_full: { tweet: insight.tweet, insight: insight.insight, proof: insight.proof }
    }, null, 2));

    // Save thread to pending
    if (insight.thread && insight.thread.length > 1) {
      const threadId = generateId();
      const threadText = insight.thread.map((t, i) => (i === 0 ? t : (i) + '/ ' + t)).join('\n\n---\n\n');
      fs.writeFileSync(path.join(pendDir, threadId + '.json'), JSON.stringify({
        id: threadId, profile_id: 'deep_personal', display_name: 'Deep – Personal',
        platform: 'twitter', content: threadText, pillar: insight.angle || 'insight',
        format: 'thread', created_at: new Date().toISOString(), status: 'pending',
        content_full: { thread: insight.thread, insight: insight.insight }
      }, null, 2));
    }

    // Save LinkedIn direction to pending
    if (insight.linkedin_angle) {
      const liId = generateId();
      fs.writeFileSync(path.join(pendDir, liId + '.json'), JSON.stringify({
        id: liId, profile_id: 'deep_personal', display_name: 'Deep – Personal',
        platform: 'linkedin', content: 'INSIGHT: ' + insight.insight + '\n\nANGLE: ' + insight.linkedin_angle + '\n\nExpand this into a full LinkedIn post using the Regen button.',
        pillar: insight.angle || 'insight', format: 'insight_draft',
        created_at: new Date().toISOString(), status: 'pending'
      }, null, 2));
    }

    // Save Reels hook to pending
    if (insight.reels_hook) {
      const reelsId = generateId();
      fs.writeFileSync(path.join(pendDir, reelsId + '.json'), JSON.stringify({
        id: reelsId, profile_id: 'deep_personal', display_name: 'Deep – Personal',
        platform: 'reels', content: 'HOOK: ' + insight.reels_hook + '\n\nINSIGHT: ' + insight.insight + '\n\nExpand this into a full Reels script using the Regen button.',
        pillar: insight.angle || 'insight', format: 'insight_draft',
        created_at: new Date().toISOString(), status: 'pending'
      }, null, 2));
    }

    notify('New insight generated', 'Tweet + Thread + LinkedIn + Reels from one idea');

    res.json({ ok: true, insight });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Generate on demand — TENANT-SCOPED ──────────────────────────────────

app.post('/api/generate', async (req, res) => {
  if (req.user && req.user.plan !== 'admin') {
    const credit = deductCredit(req.userId);
    if (!credit.ok) return res.status(402).json({ error: credit.error });
  }

  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: 'No GROQ_API_KEY configured' });

  const { platform, style, topic } = req.body;
  const targetPlatform = platform || 'twitter';

  const pendDir = path.join(req.userDataDir, 'pending');
  const pubDir = path.join(req.userDataDir, 'published');
  const decDir = path.join(req.userDataDir, 'decisions');

  const chosenStyle = style || 'contrarian';
  const isLinkedIn = targetPlatform === 'linkedin' || chosenStyle === 'linkedin';
  const isReels = targetPlatform === 'reels' || chosenStyle === 'reels';
  const actualPlatform = isReels ? 'reels' : (isLinkedIn ? 'linkedin' : 'twitter');

  // Check for today's brief as topic hint
  let briefTopic = topic;
  if (!briefTopic) {
    try {
      const stateDir = path.join(req.userDataDir, 'state');
      const briefFile = path.join(stateDir, 'brief_today.json');
      const brief = JSON.parse(fs.readFileSync(briefFile, 'utf8'));
      const today = new Date().toISOString().slice(0, 10);
      if (brief.date === today && brief.topic) briefTopic = brief.topic;
    } catch {}
  }

  // Build layered system prompt
  const sysPrompt = buildLayeredPrompt(req.userDataDir, pubDir, decDir, briefTopic, actualPlatform) +
    (isLinkedIn ? '\n\nYou are writing a LinkedIn post. Professional but opinionated. Hook in first 2 lines above the fold. No bullshit.' :
     isReels ? '\n\nYou are writing a Reels script. Hook must be under 8 words. Each beat punchy.' :
     '\n\nYou ARE this person. Raw, short, no corporate speak. Match the examples.');

  const styleInstructions = {
    contrarian: 'Disagree with something everyone accepts. State the popular view, then destroy it with specifics.',
    raw_take: 'Write a raw, unfiltered thought. 1-3 short lines with line breaks. Just conviction.',
    provocation: 'Say something that makes people quote-tweet to argue. Provocative, not mean.',
    observation: 'Point out a pattern nobody talks about. 2-3 lines. End with the implication.',
    hot_take: 'Unpopular opinion backed by a reason nobody discusses.',
    prediction: 'Bold prediction stated as fact. Short. Inevitable tone.',
    one_liner: 'One sentence, under 100 characters. Standalone punch.',
    question: 'Provocative question that implies a strong opinion. No answer needed.',
    linkedin: 'LinkedIn post. Hook in first 2 lines. 300-500 words. Professional but opinionated. End with CTA or question.',
    reels: 'Return JSON: {"hook":"under 8 words","beats":[{"voiceover":"...","visual":"...","duration":"Xs"}],"cta":"...","music_mood":"...","total_duration":"Xs"}'
  };

  // HOOK-FIRST approach for Twitter: generate hook, then build post around it
  let finalContent = '';
  try {
    if (actualPlatform === 'twitter') {
      // Step 1: Generate hook
      const emotion = ['anger', 'fear', 'superiority', 'hope'][Math.floor(Math.random() * 4)];
      const frameworks = ['HIDDEN WINNER: Who benefits that nobody talks about?',
        'CONTRADICTION: What does conventional wisdom get wrong?',
        'BUILDER ANGLE: What would you build on top of this?',
        'TIMELINE LIE: Is this happening faster/slower than people think?',
        'INDIA ANGLE: How does this play out differently in India?'];
      const framework = frameworks[Math.floor(Math.random() * frameworks.length)];

      const hookPrompt = (briefTopic ? 'Topic: ' + briefTopic + '\n\n' : '') +
        'Target emotion: ' + emotion + '\n' +
        'Framework to use: ' + framework + '\n\n' +
        'Style: ' + (styleInstructions[chosenStyle] || styleInstructions.contrarian) + '\n\n' +
        'Write ONLY the first line (the hook). It must:\n' +
        '- Stop the scroll immediately\n' +
        '- State the result, pain point, or controversial take directly\n' +
        '- NOT start with "I\'ve been thinking", "Today I want to", or any setup\n' +
        '- Be under 60 characters if possible\n' +
        'Return ONLY the hook text, nothing else.';

      const hook = await callGroq(sysPrompt, hookPrompt, { temperature: 0.9, max_tokens: 80 });

      // Step 2: Build full tweet around the hook
      let genAttempts = 0;
      while (genAttempts < 2) {
        const fullPrompt = 'Hook (first line — DO NOT change this): "' + hook.trim() + '"\n\n' +
          'Now write the complete tweet STARTING with that exact hook.\n' +
          'Style: ' + (styleInstructions[chosenStyle] || styleInstructions.contrarian) + '\n' +
          'Rules:\n- Under 280 chars total\n- Line breaks between ideas\n- No emojis, no hashtags\n' +
          '- Weave in a real story or specific experience\n- End with the implication or provocation\n' +
          'Return ONLY the tweet text.';

        finalContent = await callGroq(sysPrompt, fullPrompt, { temperature: 0.8, max_tokens: 200 });
        const gate = qualityGate(finalContent, 'twitter');
        if (gate.pass || genAttempts === 1) break;
        genAttempts++;
      }

    } else if (isLinkedIn) {
      const liPrompt = (briefTopic ? 'Topic: ' + briefTopic + '\n\n' : '') +
        styleInstructions.linkedin + '\n\n' +
        'Rules:\n- Hook MUST be in first 2 lines (above the fold)\n- Line break after hook\n' +
        '- 300-500 words\n- End with a question or CTA\n- No "I\'m thrilled to share" openers\n' +
        'Return ONLY the post text.';
      finalContent = await callGroq(sysPrompt, liPrompt, { temperature: 0.72, max_tokens: 700 });

    } else if (isReels) {
      const reelsPrompt = (briefTopic ? 'Topic: ' + briefTopic + '\n\n' : '') + styleInstructions.reels;
      const raw = await callGroq(sysPrompt, reelsPrompt, { temperature: 0.8, max_tokens: 600 });
      try {
        const script = JSON.parse(raw.replace(/```json|```/g, '').trim());
        finalContent = 'HOOK: ' + (script.hook || '') + '\n\n' +
          (script.beats || []).map((b, i) => 'BEAT ' + (i+1) + ' (' + (b.duration || '?') + '):\n' + (b.voiceover || '') + '\nVISUAL: ' + (b.visual || '')).join('\n\n') +
          '\n\nCTA: ' + (script.cta || '') + '\nMOOD: ' + (script.music_mood || 'energetic');
      } catch { finalContent = raw; }
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const id = generateId();
  const post = {
    id,
    profile_id: 'deep_personal',
    display_name: 'Deep – Personal',
    platform: actualPlatform,
    content: finalContent,
    content_full: { tweet: finalContent },
    pillar: briefTopic || 'On Demand',
    format: isReels ? 'reels_script' : (isLinkedIn ? 'linkedin_post' : chosenStyle),
    created_at: new Date().toISOString(),
    status: 'pending'
  };
  fs.writeFileSync(path.join(pendDir, `${id}.json`), JSON.stringify(post, null, 2));

  notify('New content generated', actualPlatform + ' post ready for review');
  res.json({ ok: true, id, content: finalContent, platform: actualPlatform, style: chosenStyle });
});

// ── API: Article Scout — TENANT-SCOPED ───────────────────────────────────────

app.post('/api/scout', async (req, res) => {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'No GROQ_API_KEY' });

  const artDir = path.join(req.userDataDir, 'articles');
  const pubDir = path.join(req.userDataDir, 'published');
  const ctxFile = path.join(req.userDataDir, 'contexts/default.txt');

  let context = '';
  try {
    const full = fs.readFileSync(ctxFile, 'utf8');
    const examplesIdx = full.indexOf('EXAMPLES OF BANGER');
    context = examplesIdx > 0 ? full.slice(0, examplesIdx).trim() : full.slice(0, 3000);
  } catch {}

  const searches = [
    'AI Twitter discussion debate controversy',
    'tech founder hot take viral tweet',
    'AI startups funding acquisition 2026',
    'artificial intelligence business automation',
    'India tech startups UPI fintech',
    'open source AI models release',
    'AI agent framework tool',
    'solo founder bootstrapped profitable startup',
    'browser AI automation agents',
    'technology controversial opinion debate',
    'AI replacing creative jobs content',
    'startup failed lessons learned',
    'new AI product launch',
    'coding AI developer tools'
  ];

  let allArticles = [];

  for (const query of searches) {
    for (const timeRange of ['day', 'week']) {
      try {
        const searchResult = await new Promise((resolve, reject) => {
          const url = 'http://searxng:8080/search?q=' + encodeURIComponent(query) + '&format=json&categories=news&time_range=' + timeRange;
          const timeout = setTimeout(() => resolve({ results: [] }), 8000);
          http.get(url, { headers: { 'Accept': 'application/json' } }, r => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => {
              clearTimeout(timeout);
              try { resolve(JSON.parse(d)); } catch { resolve({ results: [] }); }
            });
          }).on('error', () => { clearTimeout(timeout); resolve({ results: [] }); });
        });
        if (searchResult.results && searchResult.results.length > 0) {
          allArticles = allArticles.concat(searchResult.results.slice(0, 5));
          break;
        }
      } catch {}
    }
  }

  if (allArticles.length < 3) {
    try {
      const fallbackResult = await new Promise((resolve, reject) => {
        const url = 'http://searxng:8080/search?q=' + encodeURIComponent('AI technology startups latest') + '&format=json&time_range=week';
        const timeout = setTimeout(() => resolve({ results: [] }), 8000);
        http.get(url, { headers: { 'Accept': 'application/json' } }, r => {
          let d = ''; r.on('data', c => d += c); r.on('end', () => {
            clearTimeout(timeout);
            try { resolve(JSON.parse(d)); } catch { resolve({ results: [] }); }
          });
        }).on('error', () => { clearTimeout(timeout); resolve({ results: [] }); });
      });
      if (fallbackResult.results) {
        allArticles = allArticles.concat(fallbackResult.results.slice(0, 8));
      }
    } catch {}
  }

  const seen = new Set();
  allArticles = allArticles.filter(a => {
    const key = (a.title || '').toLowerCase().slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 12);

  console.log('Scout: found ' + allArticles.length + ' raw articles after dedup');
  if (allArticles.length === 0) return res.json({ ok: true, articles: 0 });

  const articleSummaries = allArticles.map((a, i) => (i+1) + '. "' + (a.title || '') + '" — ' + (a.content || a.description || '').slice(0, 150)).join('\n');

  let recentTakes = [];
  try {
    recentTakes = readJsonDir(pubDir)
      .filter(p => p.platform === 'twitter')
      .slice(0, 15)
      .map(p => (p.content || '').slice(0, 60));
  } catch {}
  const avoidList = recentTakes.length > 0
    ? '\n\nALREADY POSTED (never repeat these angles):\n' + recentTakes.join('\n') + '\n'
    : '';

  const takePrompt = 'Here are today\'s news articles:\n\n' + articleSummaries + '\n\n' +
    'For each article, apply 4 quality filters and generate 2 banger takes.\n\n' +
    '4 FILTERS (score each 1-10):\n' +
    '1. RELEVANCE: Is this in my domain? (AI, tech, startups, India tech, automation)\n' +
    '2. AUDIENCE FIT: Would US tech Twitter / Indian founders / AI builders actually care?\n' +
    '3. CREDIBILITY: Do I have standing to comment from my background/experience?\n' +
    '4. NOVELTY: Has this exact angle been covered in the last 30 days? (novelty = fresh angle)\n' +
    'Average score must be 6+ to include the article.\n\n' +
    'FRAMEWORKS (use one per take):\n' +
    '- HIDDEN WINNER: Who benefits that nobody is talking about?\n' +
    '- REAL THREAT: What danger does the headline miss?\n' +
    '- CONTRADICTION: What does this accidentally prove wrong?\n' +
    '- TIMELINE LIE: Is this faster/slower than people think?\n' +
    '- MONEY TRAIL: Who is paying for this and what does it reveal?\n' +
    '- BUILDER ANGLE: What product would you build on top of this?\n' +
    '- INDIA ANGLE: How does this play out differently in India?\n\n' +
    'Rules for takes:\n' +
    '- Under 280 chars. No emojis, no hashtags. Line breaks between sentences.\n' +
    '- AHA TEST: connect two things the reader hasn\'t connected before\n' +
    '- Be specific. Name companies, numbers, consequences.\n' +
    '- NEVER "X will replace Y" or "X is dead"\n' +
    avoidList +
    '\nReturn ONLY valid JSON:\n{"articles":[{"index":1,"score_breakdown":{"relevance":8,"audience_fit":7,"credibility":6,"novelty":9,"avg":7.5},"takes":["take1","take2"]},...]}\n' +
    'Omit articles where avg score < 6.';

  try {
    const body = JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: context + '\n\nYou ARE Deep. Find the angle nobody sees. Second-order thinking only.' },
        { role: 'user', content: takePrompt }
      ],
      stream: false, temperature: 0.8, max_tokens: 2000
    });

    const result = await new Promise((resolve, reject) => {
      const req2 = https.request('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Length': Buffer.byteLength(body) }
      }, res2 => { let d = ''; res2.on('data', c => d += c); res2.on('end', () => resolve(d)); });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    const parsed = JSON.parse(result);
    const content = parsed.choices?.[0]?.message?.content || '{}';
    console.log('Scout Groq response length:', content.length, 'finish:', parsed.choices?.[0]?.finish_reason);
    let scored;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      scored = JSON.parse(jsonMatch[0].replace(/,\s*([}\]])/g, '$1'));
    } catch (e) {
      console.log('Scout parse error:', e.message, 'raw:', content.slice(0, 200));
      return res.json({ ok: false, error: 'Failed to parse LLM response', raw: content.slice(0, 200) });
    }

    let saved = 0;
    for (const item of (scored.articles || [])) {
      const idx = item.index - 1;
      if (idx < 0 || idx >= allArticles.length) continue;
      const article = allArticles[idx];
      const id = generateId();
      const scoreBreakdown = item.score_breakdown || {};
      const articleData = {
        id,
        title: article.title || '',
        url: article.url || '',
        source: article.engine || article.parsed_url?.[1] || 'unknown',
        summary: (article.content || article.description || '').slice(0, 300),
        score: scoreBreakdown.avg || item.score || 0,
        score_breakdown: scoreBreakdown,
        takes: item.takes || [],
        scouted_at: new Date().toISOString(),
        status: 'new'
      };
      fs.writeFileSync(path.join(artDir, id + '.json'), JSON.stringify(articleData, null, 2));
      saved++;
    }

    notify('Article Scout: ' + saved + ' articles found', 'New articles with hot takes ready for review');

    res.json({ ok: true, articles: saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Get scouted articles — TENANT-SCOPED ────────────────────────────────

app.get('/api/articles', (req, res) => {
  const artDir = path.join(req.userDataDir, 'articles');
  try {
    const articles = fs.readdirSync(artDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(artDir, f), 'utf8')); }
        catch { return null; }
      })
      .filter(a => a && a.status !== 'skipped')
      .sort((a, b) => new Date(b.scouted_at) - new Date(a.scouted_at));
    res.json({ data: articles, total: articles.length });
  } catch {
    res.json({ data: [], total: 0 });
  }
});

// ── API: React to article — TENANT-SCOPED ────────────────────────────────────

app.post('/api/article-react/:id', async (req, res) => {
  const artDir = path.join(req.userDataDir, 'articles');
  const pendDir = path.join(req.userDataDir, 'pending');
  const ctxFile = path.join(req.userDataDir, 'contexts/default.txt');
  const file = path.join(artDir, req.params.id + '.json');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });

  const article = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { action, take_index, custom_take } = req.body;

  if (action === 'skip') {
    article.status = 'skipped';
    fs.writeFileSync(file, JSON.stringify(article, null, 2));
    return res.json({ ok: true, skipped: true });
  }

  let rawTake = '';
  if (action === 'use_take' && take_index !== undefined) {
    rawTake = article.takes[take_index] || '';
  } else if (action === 'custom' && custom_take) {
    rawTake = custom_take;
  } else {
    return res.status(400).json({ error: 'provide action: use_take (with take_index) or custom (with custom_take) or skip' });
  }

  const GROQ_KEY = process.env.GROQ_API_KEY;
  let polished = rawTake;

  if (GROQ_KEY) {
    let context = '';
    try { context = fs.readFileSync(ctxFile, 'utf8'); } catch {}

    const polishPrompt = 'Article: "' + article.title + '"\n\n' +
      'Raw take: "' + rawTake + '"\n\n' +
      'Polish this into a tweet. Keep the EXACT angle and opinion. Just make it punchier, better spaced out with line breaks, and under 280 chars.\n' +
      'If the raw take is already good, return it as-is. Dont change the meaning.\n' +
      'No emojis, no hashtags. Return ONLY the tweet text.';

    try {
      const body = JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: context + '\n\nPolish this tweet. Keep the angle. Make it sharper.' },
          { role: 'user', content: polishPrompt }
        ],
        stream: false, temperature: 0.5
      });
      const result = await new Promise((resolve, reject) => {
        const req2 = https.request('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Length': Buffer.byteLength(body) }
        }, res2 => { let d = ''; res2.on('data', c => d += c); res2.on('end', () => resolve(d)); });
        req2.on('error', reject);
        req2.write(body);
        req2.end();
      });
      const parsed = JSON.parse(result);
      polished = parsed.choices?.[0]?.message?.content || rawTake;
    } catch {}
  }

  const postId = generateId();
  const post = {
    id: postId,
    profile_id: 'deep_personal',
    display_name: 'Deep – Personal',
    platform: 'twitter',
    content: polished,
    content_full: { tweet: polished, raw_take: rawTake, article_title: article.title, article_url: article.url },
    pillar: 'Article React',
    format: 'article_take',
    created_at: new Date().toISOString(),
    status: 'pending'
  };
  fs.writeFileSync(path.join(pendDir, postId + '.json'), JSON.stringify(post, null, 2));

  article.status = 'used';
  article.used_take = rawTake;
  fs.writeFileSync(file, JSON.stringify(article, null, 2));

  res.json({ ok: true, post_id: postId, polished, raw: rawTake });
});

// ── Helpers: Pexels stock video backgrounds ──────────────────────────────────

function searchPexelsVideo(query) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) return Promise.resolve(null);
  return new Promise((resolve) => {
    const searchUrl = 'https://api.pexels.com/videos/search?query=' + encodeURIComponent(query) + '&per_page=3&orientation=portrait&size=small';
    https.get(searchUrl, { headers: { 'Authorization': apiKey } }, (res2) => {
      let d = '';
      res2.on('data', c => d += c);
      res2.on('end', () => {
        try {
          const data = JSON.parse(d);
          const video = data.videos && data.videos[Math.floor(Math.random() * Math.min(data.videos.length, 3))];
          if (!video || !video.video_files) return resolve(null);
          const file = video.video_files.find(f => f.quality === 'sd' && f.height >= 1080) || video.video_files.find(f => f.quality === 'sd') || video.video_files[0];
          resolve(file && file.link ? file.link : null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const getter = url.startsWith('https') ? https : http;
    getter.get(url, (res2) => {
      if ((res2.statusCode === 301 || res2.statusCode === 302) && res2.headers.location) {
        return downloadToFile(res2.headers.location, dest).then(resolve).catch(reject);
      }
      if (res2.statusCode !== 200) return reject(new Error('Download failed: ' + res2.statusCode));
      const ws = fs.createWriteStream(dest);
      res2.pipe(ws);
      ws.on('finish', () => resolve());
      ws.on('error', reject);
    }).on('error', reject);
  });
}

function ffmpegRun(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: timeout || 90000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('FFmpeg: ' + (stderr || err.message).slice(-300)));
      resolve();
    });
  });
}

function ffprobeDuration(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], (err, stdout) => {
      resolve(parseFloat((stdout || '').trim()) || 5);
    });
  });
}

// ── API: Render Reel Video (TTS + FFmpeg + Pexels) — TENANT-SCOPED ───────────

app.post('/api/render-reel/:id', async (req, res) => {
  const pendDir = path.join(req.userDataDir, 'pending');
  const reelsDir = path.join(req.userDataDir, 'reels');
  fs.mkdirSync(reelsDir, { recursive: true });

  const pendFile = path.join(pendDir, req.params.id + '.json');
  if (!fs.existsSync(pendFile)) return res.status(404).json({ error: 'not found' });

  const post = JSON.parse(fs.readFileSync(pendFile, 'utf8'));
  if (post.platform !== 'reels') return res.status(400).json({ error: 'Not a reels post' });

  // Parse script — extract text, visual keywords, and duration per beat
  let beats = [];
  try {
    const content = post.content;
    const hookMatch = content.match(/HOOK:\s*(.+)/);
    const beatMatches = [...content.matchAll(/BEAT\s+\d+\s*\((\d+)s?\):\s*\n([\s\S]*?)(?=\n\nBEAT|\n\nCTA|$)/g)];
    const ctaMatch = content.match(/CTA:\s*(.+)/);

    if (hookMatch) beats.push({ text: hookMatch[1].trim(), visual: 'technology dark abstract', duration: 3 });
    for (const m of beatMatches) {
      const voiceover = m[2].replace(/\nVISUAL:[\s\S]*/, '').trim();
      const visualMatch = m[2].match(/VISUAL:\s*(.+)/);
      const visual = visualMatch ? visualMatch[1].trim() : 'technology business dark';
      beats.push({ text: voiceover, visual, duration: parseInt(m[1]) || 5 });
    }
    if (ctaMatch) beats.push({ text: ctaMatch[1].trim(), visual: 'social media phone dark', duration: 3 });

    if (beats.length === 0) {
      beats = [{ text: content.slice(0, 200), visual: 'technology dark', duration: 10 }];
    }
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse reels script: ' + e.message });
  }

  const tmpDir = path.join(reelsDir, 'tmp-' + post.id);
  fs.mkdirSync(tmpDir, { recursive: true });
  const fontPath = '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf';

  function cleanupTmp() {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }

  try {
    // ── Step 1: Generate TTS audio for each beat ──
    for (let i = 0; i < beats.length; i++) {
      const audioPath = path.join(tmpDir, `beat-${i}.wav`);
      await new Promise((resolve, reject) => {
        const body = JSON.stringify({ text: beats[i].text });
        const ttsReq = http.request('http://piper-tts:5500/synthesize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, ttsRes => {
          const chunks = [];
          ttsRes.on('data', c => chunks.push(c));
          ttsRes.on('end', () => {
            if (ttsRes.statusCode !== 200) return reject(new Error('TTS failed: ' + Buffer.concat(chunks).toString().slice(0, 200)));
            fs.writeFileSync(audioPath, Buffer.concat(chunks));
            resolve();
          });
        });
        ttsReq.on('error', reject);
        ttsReq.write(body);
        ttsReq.end();
      });
      beats[i].audioPath = audioPath;
      beats[i].audioDuration = await ffprobeDuration(audioPath);
    }

    // ── Step 2: Download Pexels stock video backgrounds ──
    const hasPexels = !!process.env.PEXELS_API_KEY;
    if (hasPexels) {
      console.log('Render: fetching Pexels stock videos for', beats.length, 'beats');
    }
    for (let i = 0; i < beats.length; i++) {
      const bgRaw = path.join(tmpDir, `bg-raw-${i}.mp4`);
      const bgScaled = path.join(tmpDir, `bg-${i}.mp4`);
      let gotVideo = false;

      if (hasPexels) {
        try {
          const videoUrl = await searchPexelsVideo(beats[i].visual);
          if (videoUrl) {
            await downloadToFile(videoUrl, bgRaw);
            // Scale & crop to 1080x1920 portrait, trim to audio duration + 0.5s
            const dur = beats[i].audioDuration + 0.5;
            await ffmpegRun([
              '-i', bgRaw, '-t', String(dur),
              '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1',
              '-an', '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
              '-r', '30', '-y', bgScaled
            ]);
            gotVideo = true;
            console.log('Render: beat', i, 'got Pexels video');
          }
        } catch (e) {
          console.log('Render: Pexels failed for beat', i, e.message.slice(0, 100));
        }
      }

      // Fallback: animated gradient with slow hue shift + vignette
      if (!gotVideo) {
        const colors = ['1a1a2e', '16213e', '0f3460', '533483', '2c3e50', '1b2838', '0d1117', '1e1e2e'];
        const color = colors[i % colors.length];
        const dur = beats[i].audioDuration + 0.5;
        await ffmpegRun([
          '-f', 'lavfi', '-i', `color=c=0x${color}:s=1080x1920:d=${dur}:r=30`,
          '-vf', 'hue=H=t*12:s=1.8,vignette=PI/4',
          '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
          '-y', bgScaled
        ]);
      }

      beats[i].bgPath = bgScaled;
    }

    // ── Step 3: Create clips — background + styled text overlay + audio ──
    const clipPaths = [];
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i];
      const clipPath = path.join(tmpDir, `clip-${i}.mp4`);

      // Write text to file (avoids ALL FFmpeg escaping issues)
      const textFilePath = path.join(tmpDir, `text-${i}.txt`);
      fs.writeFileSync(textFilePath, beat.text);

      // Darken video background slightly so white text pops
      // Add styled caption: large bold white text with black shadow + semi-transparent box
      // Position in center-lower area (y=60% of height) for reel style
      // Fade in text after 0.3s, fade entire clip in/out
      const dur = beat.audioDuration + 0.3;
      const fadeOut = Math.max(dur - 0.4, 0.1);
      const vf = [
        'colorchannelmixer=rr=0.7:gg=0.7:bb=0.7',  // darken bg for readability
        `drawtext=textfile=${textFilePath}:fontfile=${fontPath}:fontsize=58:fontcolor=white:` +
          `x=(w-text_w)/2:y=(h-text_h)/2+200:` +
          `shadowcolor=black:shadowx=4:shadowy=4:` +
          `line_spacing=24:` +
          `box=1:boxcolor=black@0.4:boxborderw=24:` +
          `enable='gte(t\\,0.3)'`,
        `fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOut}:d=0.4`
      ].join(',');

      await ffmpegRun([
        '-i', beat.bgPath,
        '-i', beat.audioPath,
        '-vf', vf,
        '-t', String(dur),
        '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest', '-y', clipPath
      ]);
      clipPaths.push(clipPath);
    }

    // ── Step 4: Concatenate all clips into final MP4 ──
    const concatFile = path.join(tmpDir, 'concat.txt');
    fs.writeFileSync(concatFile, clipPaths.map(p => `file '${p}'`).join('\n'));

    const outputFile = path.join(reelsDir, post.id + '.mp4');
    await ffmpegRun([
      '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', outputFile
    ], 600000);

    cleanupTmp();

    // Update post with video URL
    post.video_file = post.id + '.mp4';
    post.video_rendered_at = new Date().toISOString();
    fs.writeFileSync(pendFile, JSON.stringify(post, null, 2));

    const stat = fs.statSync(outputFile);
    console.log('Render complete:', post.id, (stat.size / 1024 / 1024).toFixed(1) + 'MB');
    res.json({ ok: true, id: post.id, video_url: `/reels/${req.userId}/${post.id}.mp4`, size_mb: (stat.size / 1024 / 1024).toFixed(1) });
  } catch (e) {
    cleanupTmp();
    console.error('Render error:', e.message);
    res.status(500).json({ error: 'Render failed: ' + e.message });
  }
});

// ── Static: Serve rendered reels ─────────────────────────────────────────────

app.get('/reels/:userId/:file', (req, res) => {
  const filePath = path.join(DATA_DIR, 'tenants', req.params.userId, 'reels', req.params.file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  res.type('video/mp4').sendFile(filePath);
});

// ── API: Health ──────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const allPublished = readAllTenantsDir('published');
  res.json({ status: 'ok', uptime: process.uptime(), posts: allPublished.length });
});

// ── Public Website (aggregates all tenants) ──────────────────────────────────

app.get('/', (req, res) => {
  const posts = readAllTenantsDir('published').slice(0, 50);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(SITE_TITLE)}</title>
<link rel="alternate" type="application/rss+xml" title="RSS" href="/rss.xml">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; max-width: 640px; margin: 0 auto; padding: 20px; }
h1 { font-size: 22px; margin-bottom: 4px; }
.subtitle { color: #888; font-size: 13px; margin-bottom: 24px; }
.post { background: #161616; border: 1px solid #2a2a2a; border-radius: 10px; padding: 16px; margin-bottom: 12px; }
.post-meta { font-size: 12px; color: #888; margin-bottom: 8px; display: flex; gap: 12px; }
.post-content { font-size: 15px; line-height: 1.5; white-space: pre-wrap; }
.tag { background: #1e293b; color: #60a5fa; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
.empty { color: #666; text-align: center; padding: 40px; }
a { color: #60a5fa; text-decoration: none; }
.rss-link { font-size: 13px; color: #888; margin-bottom: 20px; display: block; }
</style>
</head>
<body>
<h1>${escapeHtml(SITE_TITLE)}</h1>
<p class="subtitle">AI-generated content by Deep Soni</p>
<a class="rss-link" href="/rss.xml">RSS Feed</a>
${posts.length === 0 ? '<div class="empty">No posts yet. Content will appear here when the machine starts publishing.</div>' :
  posts.map(p => `<div class="post">
  <div class="post-meta">
    <span>${escapeHtml(p.display_name)}</span>
    <span class="tag">${escapeHtml(p.platform)}</span>
    ${p.pillar ? `<span class="tag">${escapeHtml(p.pillar)}</span>` : ''}
    <span>${new Date(p.published_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
  </div>
  <div class="post-content">${escapeHtml(p.content)}</div>
</div>`).join('\n')}
</body>
</html>`;
  res.type('html').send(html);
});

// ── Single post page (searches all tenants) ──────────────────────────────────

app.get('/post/:id', (req, res) => {
  const file = findPostInTenants(req.params.id);
  if (!file) return res.status(404).type('html').send('<h1>Not found</h1>');

  const post = JSON.parse(fs.readFileSync(file, 'utf8'));
  post.views = (post.views || 0) + 1;
  fs.writeFileSync(file, JSON.stringify(post, null, 2));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(post.content.slice(0, 60))} — ${escapeHtml(SITE_TITLE)}</title>
<meta property="og:title" content="${escapeHtml(post.content.slice(0, 60))}">
<meta property="og:description" content="${escapeHtml(post.content.slice(0, 200))}">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; max-width: 640px; margin: 0 auto; padding: 20px; }
h1 { font-size: 18px; margin-bottom: 16px; }
.meta { font-size: 13px; color: #888; margin-bottom: 16px; }
.content { font-size: 16px; line-height: 1.6; white-space: pre-wrap; }
.tag { background: #1e293b; color: #60a5fa; padding: 2px 8px; border-radius: 4px; font-size: 11px; }
a { color: #60a5fa; text-decoration: none; }
.back { margin-top: 24px; display: block; }
.versions { margin-top: 24px; }
.versions h2 { font-size: 14px; color: #888; margin-bottom: 8px; }
.version-block { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 12px; margin-bottom: 8px; }
.version-label { font-size: 12px; color: #60a5fa; margin-bottom: 4px; text-transform: uppercase; }
.version-text { font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
</style>
</head>
<body>
<a href="/">← All posts</a>
<div class="meta" style="margin-top:16px">
  <span>${escapeHtml(post.display_name)}</span> ·
  <span class="tag">${escapeHtml(post.platform)}</span>
  ${post.pillar ? `· <span class="tag">${escapeHtml(post.pillar)}</span>` : ''}
  · ${new Date(post.published_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
  · ${post.views} views
</div>
<div class="content">${escapeHtml(post.content)}</div>
${post.content_full && Object.keys(post.content_full).length > 1 ? `
<div class="versions">
  <h2>All Versions</h2>
  ${Object.entries(post.content_full).map(([k, v]) => v ? `<div class="version-block">
    <div class="version-label">${escapeHtml(k)}</div>
    <div class="version-text">${escapeHtml(typeof v === 'string' ? v : JSON.stringify(v))}</div>
  </div>` : '').join('\n')}
</div>` : ''}
<a class="back" href="/">← Back to all posts</a>
</body>
</html>`;
  res.type('html').send(html);
});

// ── Onboarding wizard ────────────────────────────────────────────────────────

app.get('/onboarding', (req, res) => {
  const complete = isOnboardingComplete(req.userDataDir);
  const stories = loadStories(req.userDataDir);
  res.type('html').send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Voice DNA Setup — Content Machine</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:20px;max-width:680px;margin:0 auto}
h1{font-size:22px;margin-bottom:4px;color:#4ade80}
.sub{color:#888;font-size:13px;margin-bottom:24px}
.step{display:none;animation:fadein .3s}
.step.active{display:block}
@keyframes fadein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.step-num{font-size:11px;color:#4ade80;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
h2{font-size:16px;margin-bottom:4px}
.hint{font-size:12px;color:#666;margin-bottom:12px}
label{font-size:12px;color:#888;display:block;margin-bottom:3px;margin-top:10px}
input,textarea{width:100%;padding:10px;background:#161616;border:1px solid #333;color:#e0e0e0;border-radius:6px;font-size:13px;font-family:inherit;resize:vertical}
textarea{min-height:80px}
.slider-row{display:flex;align-items:center;gap:10px;margin:8px 0}
.slider-row label{margin:0;min-width:120px;font-size:12px;color:#aaa}
.slider-row span{font-size:11px;color:#666;min-width:70px}
input[type=range]{flex:1}
.btns{display:flex;gap:8px;margin-top:16px}
button{padding:10px 20px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:600}
.btn-next{background:#4ade80;color:#000}.btn-next:hover{background:#22c55e}
.btn-back{background:#1e293b;color:#e0e0e0}.btn-back:hover{background:#334155}
.btn-submit{background:#4ade80;color:#000}.btn-submit:hover{background:#22c55e}
.progress{display:flex;gap:4px;margin-bottom:20px}
.dot{width:8px;height:8px;border-radius:50%;background:#333}
.dot.done{background:#4ade80}
.dot.active{background:#22c55e;box-shadow:0 0 6px #4ade80}
.stories-list{margin-top:8px}
.story-item{background:#161616;border:1px solid #333;border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:12px;display:flex;justify-content:space-between}
.story-item button{background:#7f1d1d;color:#f87171;border:none;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:10px}
.complete-banner{background:#166534;border:1px solid #4ade80;border-radius:8px;padding:16px;margin-bottom:16px;font-size:14px}
.add-story-row{display:flex;gap:8px;margin-top:8px}
.add-story-row input{flex:1}
.add-story-row button{background:#1e293b;color:#4ade80;border:1px solid #333;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:12px;white-space:nowrap}
</style></head><body>
<h1>Voice DNA Setup</h1>
<p class="sub">7-step interview to generate your content voice. Takes ~5 minutes.</p>
${complete ? '<div class="complete-banner">✓ Voice DNA already set up. <a href="/dashboard" style="color:#4ade80">Back to dashboard</a> or redo below to regenerate.</div>' : ''}
<div class="progress" id="progress">${[0,1,2,3,4,5,6].map((i) => '<div class="dot' + (i===0?' active':'') + '" id="dot'+i+'"></div>').join('')}</div>

<form id="onboardingForm">
<div class="step active" id="step0">
  <div class="step-num">Step 1 of 7 — Identity</div>
  <h2>Who are you?</h2>
  <p class="hint">This becomes the core of your AI voice. Be specific.</p>
  <label>Your name</label><input name="name" value="${escapeHtml(req.user?.name || '')}" required>
  <label>Your role / what you do</label><input name="role" placeholder="e.g. Founder building AI tools for Indian SMEs" required>
  <label>What are you building right now?</label><input name="building" placeholder="e.g. Intrkt — WhatsApp automation for sales teams">
  <label>Your unfair advantage (what you know that others don't)</label><textarea name="unfair_advantage" placeholder="e.g. I've run support for 50+ B2B companies and see where automation breaks..."></textarea>
  <div class="btns"><button type="button" class="btn-next" onclick="nextStep(0)">Next →</button></div>
</div>

<div class="step" id="step1">
  <div class="step-num">Step 2 of 7 — Audience</div>
  <h2>Who reads your content?</h2>
  <label>Who is your primary audience?</label><input name="audience" placeholder="e.g. Indian founders, US tech Twitter, AI builders in SE Asia">
  <label>What problem do they have that you understand deeply?</label><textarea name="audience_problem" placeholder="They're trying to automate but don't know where to start..."></textarea>
  <label>What should they think / feel after 10 of your posts?</label><textarea name="audience_outcome" placeholder="That AI automation is simpler than they think and they should start now"></textarea>
  <div class="btns"><button type="button" class="btn-back" onclick="prevStep(1)">← Back</button><button type="button" class="btn-next" onclick="nextStep(1)">Next →</button></div>
</div>

<div class="step" id="step2">
  <div class="step-num">Step 3 of 7 — Voice</div>
  <h2>What's your tone?</h2>
  <p class="hint">Drag sliders to define your voice spectrum.</p>
  ${[
    ['controversial','safe','voice_controversial'],
    ['raw','polished','voice_raw'],
    ['short-form','long-form','voice_shortform'],
    ['opinionated','balanced','voice_opinionated'],
    ['personal','professional','voice_personal']
  ].map(([l,r,name]) => `<div class="slider-row"><span>${l}</span><input type="range" min="1" max="10" value="5" name="${name}"><span>${r}</span></div>`).join('')}
  <label>Topics or styles you HATE seeing in content</label><textarea name="voice_hate" placeholder="Generic AI takes, 'disruption' language, humble-brags, corporate speak..."></textarea>
  <div class="btns"><button type="button" class="btn-back" onclick="prevStep(2)">← Back</button><button type="button" class="btn-next" onclick="nextStep(2)">Next →</button></div>
</div>

<div class="step" id="step3">
  <div class="step-num">Step 4 of 7 — Real Examples</div>
  <h2>Paste 5+ real posts you've written</h2>
  <p class="hint">These become ground truth. The AI will study your actual writing, not a description of it.</p>
  <textarea name="real_examples_raw" style="min-height:200px" placeholder="Paste your real tweets/posts here. Separate each post with a blank line.&#10;&#10;The more you give, the better the voice match."></textarea>
  <div class="btns"><button type="button" class="btn-back" onclick="prevStep(3)">← Back</button><button type="button" class="btn-next" onclick="nextStep(3)">Next →</button></div>
</div>

<div class="step" id="step4">
  <div class="step-num">Step 5 of 7 — Worldview</div>
  <h2>What do you believe that most people don't?</h2>
  <p class="hint">Write 3-5 specific contrarian beliefs you'd defend at dinner. Not "AI is important" — specifics.</p>
  <textarea name="worldview" style="min-height:120px" placeholder="1. Most Indian startups fail at automation because they outsource it too early.&#10;2. WhatsApp is more powerful than email for B2B in India.&#10;3. The best AI products are boring-looking but extremely reliable."></textarea>
  <div class="btns"><button type="button" class="btn-back" onclick="prevStep(4)">← Back</button><button type="button" class="btn-next" onclick="nextStep(4)">Next →</button></div>
</div>

<div class="step" id="step5">
  <div class="step-num">Step 6 of 7 — Story Bank</div>
  <h2>Add your real stories (min 3)</h2>
  <p class="hint">Stories ground your content in real experience. Add at least 3 to unlock the quality engine.</p>
  <div id="storiesList" class="stories-list">${stories.map(s => `<div class="story-item"><span>${escapeHtml((s.story||'').slice(0,80))}</span><button type="button" onclick="deleteStory('${s.id}')">✕</button></div>`).join('')}</div>
  <label>Story</label><textarea id="newStoryText" placeholder="What happened? Be specific — time, place, what you observed, what you did..."></textarea>
  <label>Lesson / punchline</label><input id="newStoryLesson" placeholder="What does this prove or teach?">
  <div class="add-story-row"><button type="button" onclick="addStory()">+ Add Story</button></div>
  <div id="storyStatus" style="font-size:12px;color:#4ade80;margin-top:6px"></div>
  <div class="btns" style="margin-top:16px"><button type="button" class="btn-back" onclick="prevStep(5)">← Back</button><button type="button" class="btn-next" onclick="nextStep(5)">Next →</button></div>
</div>

<div class="step" id="step6">
  <div class="step-num">Step 7 of 7 — Activate</div>
  <h2>Generate your Voice DNA</h2>
  <p class="hint">This will synthesize everything into a context file that guides all future content generation.</p>
  <div id="submitStatus" style="font-size:13px;color:#facc15;margin-bottom:12px"></div>
  <div class="btns"><button type="button" class="btn-back" onclick="prevStep(6)">← Back</button><button type="button" class="btn-submit" onclick="submitOnboarding()">Generate Voice DNA →</button></div>
</div>
</form>

<script>
var currentStep = 0;
var storyCount = ${stories.length};
function setStep(n){
  document.querySelectorAll('.step').forEach(function(s,i){s.classList.toggle('active',i===n)});
  document.querySelectorAll('.dot').forEach(function(d,i){
    d.className='dot'+(i<n?' done':(i===n?' active':''));
  });
  currentStep=n;
}
function nextStep(n){setStep(n+1)}
function prevStep(n){setStep(n-1)}
function addStory(){
  var st=document.getElementById('newStoryText').value.trim();
  var le=document.getElementById('newStoryLesson').value.trim();
  if(!st){document.getElementById('storyStatus').textContent='Write a story first.';return}
  document.getElementById('storyStatus').textContent='Adding...';
  fetch('/api/stories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({story:st,lesson:le})})
    .then(function(r){return r.json()}).then(function(d){
      if(d.ok){
        storyCount++;
        document.getElementById('storiesList').innerHTML+='<div class="story-item"><span>'+st.slice(0,80)+'</span><button type="button" onclick="deleteStory(\''+d.story.id+'\')">✕</button></div>';
        document.getElementById('newStoryText').value='';
        document.getElementById('newStoryLesson').value='';
        document.getElementById('storyStatus').textContent='Story '+storyCount+' added! ('+d.total+' total)';
      }
    }).catch(function(){document.getElementById('storyStatus').textContent='Failed to add story.'});
}
function deleteStory(id){
  fetch('/api/stories/'+id,{method:'DELETE'}).then(function(){location.reload()})
}
function submitOnboarding(){
  var status=document.getElementById('submitStatus');
  status.textContent='Generating your Voice DNA via Groq... (takes 10-20s)';
  var form=document.getElementById('onboardingForm');
  var data={};
  new FormData(form).forEach(function(v,k){data[k]=v});
  // Parse raw examples into array
  if(data.real_examples_raw){
    data.real_examples=data.real_examples_raw.split(/\\n\\n+/).map(function(s){return s.trim()}).filter(Boolean);
  }
  // Parse worldview into array
  if(data.worldview){
    data.worldview=data.worldview.split('\\n').map(function(s){return s.replace(/^\\d+\\.\\s*/,'').trim()}).filter(Boolean);
  }
  fetch('/api/onboarding',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
    .then(function(r){return r.json()}).then(function(d){
      if(d.ok){status.textContent='Done! Voice DNA generated.';setTimeout(function(){location.href='/dashboard'},1500)}
      else{status.textContent='Error: '+(d.error||'unknown')}
    }).catch(function(e){status.textContent='Error: '+e.message});
}
</script></body></html>`);
});

// ── Dashboard — TENANT-SCOPED ────────────────────────────────────────────────

app.get('/dashboard', (req, res) => {
  const pubDir = path.join(req.userDataDir, 'published');
  const pendDir = path.join(req.userDataDir, 'pending');
  const artDir = path.join(req.userDataDir, 'articles');
  const decDir = path.join(req.userDataDir, 'decisions');

  const allPosts = readJsonDir(pubDir);
  const allPending = readJsonDir(pendDir);
  const tab = req.query.tab || 'feed';

  let articles = [];
  try {
    articles = fs.readdirSync(artDir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(artDir, f), 'utf8')); } catch { return null; } })
      .filter(a => a && a.status === 'new')
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 10);
  } catch {}

  let trendingDiscussions = [];
  try {
    trendingDiscussions = fs.readdirSync(artDir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(artDir, f), 'utf8')); } catch { return null; } })
      .filter(a => a && a.status === 'new' && a.score >= 7)
      .sort((a, b) => new Date(b.scouted_at) - new Date(a.scouted_at))
      .slice(0, 5);
  } catch {}

  // Load today's brief
  let todayBrief = null;
  try {
    const briefData = JSON.parse(fs.readFileSync(path.join(req.userDataDir, 'state/brief_today.json'), 'utf8'));
    if (briefData.date === new Date().toISOString().slice(0, 10)) todayBrief = briefData;
  } catch {}

  // Load stories for stories tab
  const userStories = loadStories(req.userDataDir);

  // Load trust settings
  let trustSettings = { trust_level: 0, per_channel_trust: { twitter: 0, linkedin: 0, reels: 0, threads: 0 } };
  try {
    trustSettings = JSON.parse(fs.readFileSync(path.join(req.userDataDir, 'state/trust.json'), 'utf8'));
    if (!trustSettings.per_channel_trust) trustSettings.per_channel_trust = { twitter: 0, linkedin: 0, reels: 0, threads: 0 };
  } catch {}

  const onboardingDone = isOnboardingComplete(req.userDataDir);

  const counts = {
    feed: articles.length,
    twitter: allPending.filter(p => p.platform === 'twitter').length + allPosts.filter(p => p.platform === 'twitter').length,
    linkedin: allPending.filter(p => p.platform === 'linkedin').length + allPosts.filter(p => p.platform === 'linkedin').length,
    reels: allPending.filter(p => p.platform === 'reels').length + allPosts.filter(p => p.platform === 'reels').length,
    approved: allPosts.length,
    stories: userStories.length
  };
  const pendingCount = allPending.length;

  let tabPending = [], tabApproved = [];
  if (tab === 'feed' || tab === 'stories' || tab === 'settings') {
    // These tabs don't use tabPending/tabApproved
  } else if (tab === 'approved') {
    tabApproved = allPosts.slice(0, 20);
  } else {
    tabPending = allPending.filter(p => p.platform === tab);
    tabApproved = allPosts.filter(p => p.platform === tab).slice(0, 15);
  }

  // Decision stats
  let approvedCount = 0, rejectedCount = 0;
  try {
    const dfiles = fs.readdirSync(decDir).filter(f => f.endsWith('.json'));
    for (const f of dfiles) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(decDir, f), 'utf8'));
        if (d.type === 'approved' || d.type === 'edited') approvedCount++;
        else if (d.type === 'rejected') rejectedCount++;
      } catch {}
    }
  } catch {}

  function esc(s) { return escapeHtml(s); }

  function renderPost(p, isPending) {
    const colors = { twitter: '#0c4a6e', linkedin: '#1e3a5f', reels: '#7c2d12' };
    const content = p.content || '';
    var actions = '';
    if (isPending) {
      actions = '<div class="actions">'
        + '<button class="btn btn-edit" onclick="toggleEdit(\'' + p.id + '\')">Edit</button>';
      if (p.platform === 'linkedin') {
        actions += '<button class="btn btn-approve" onclick="approveAndLinkedIn(\'' + p.id + '\')">Approve & Post</button>';
      } else if (p.platform === 'reels') {
        actions += '<button class="btn btn-approve" onclick="approvePost(\'' + p.id + '\')">Approve</button>';
        actions += '<button class="btn btn-render" onclick="renderReel(\'' + p.id + '\')">Render Video</button>';
      } else {
        actions += '<button class="btn btn-approve" onclick="approveAndTweet(\'' + p.id + '\')">Approve & Tweet</button>';
      }
      actions += '<button class="btn btn-reject" onclick="rejectPost(\'' + p.id + '\')">Reject</button>'
        + '<button class="btn btn-copy" onclick="copyFromPost(\'' + p.id + '\')">Copy</button>'
        + '<button class="btn btn-schedule" onclick="showSchedule(\'' + p.id + '\')">Schedule</button>'
        + '<button class="btn btn-regen" onclick="showRegen(\'' + p.id + '\')">Regen</button>'
        + '</div>'
        + '<div class="regen-box" id="regen-' + p.id + '" style="display:none">'
        + '<input type="text" class="gen-input" id="regen-input-' + p.id + '" placeholder="What should change? e.g. make it more specific, add India angle, shorter..." onkeydown="if(event.key===\'Enter\')regenPost(\'' + p.id + '\')" />'
        + '<button class="btn btn-approve" onclick="regenPost(\'' + p.id + '\')">Regenerate</button>'
        + '</div>'
        + '<div class="schedule-picker" id="sched-' + p.id + '" style="display:none">'
        + '<span class="sched-label">Post at:</span>'
        + '<button class="sched-btn" onclick="schedulePost(\'' + p.id + '\',\'09:00\')">9AM</button>'
        + '<button class="sched-btn" onclick="schedulePost(\'' + p.id + '\',\'11:00\')">11AM</button>'
        + '<button class="sched-btn" onclick="schedulePost(\'' + p.id + '\',\'14:00\')">2PM</button>'
        + '<button class="sched-btn" onclick="schedulePost(\'' + p.id + '\',\'17:00\')">5PM</button>'
        + '<button class="sched-btn" onclick="schedulePost(\'' + p.id + '\',\'20:00\')">8PM</button>'
        + '</div>'
        + '<div class="render-status" id="render-' + p.id + '"></div>'
        + (p.scheduled_for ? '<div class="sched-info">Scheduled: ' + new Date(p.scheduled_for).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) + '</div>' : '')
        + (p.video_file ? '<div class="video-ready"><a href="/reels/' + req.userId + '/' + p.video_file + '" target="_blank" class="btn btn-render">Download Video</a></div>' : '');
    } else {
      actions = '<div class="actions">'
        + '<button class="btn btn-copy" onclick="copyText(\'' + esc(content).replace(/'/g, '&#39;').replace(/\n/g, '\\n') + '\', this)">Copy</button>';
      if (p.platform === 'twitter') {
        actions += '<a class="btn btn-tweet" href="https://twitter.com/intent/tweet?text=' + encodeURIComponent(content) + '" target="_blank">Tweet</a>';
      } else if (p.platform === 'linkedin') {
        actions += '<a class="btn btn-li" href="https://www.linkedin.com/feed/?shareActive=true&text=' + encodeURIComponent(content) + '" target="_blank">Post</a>';
      }
      actions += '</div>';
    }

    return '<div class="post" id="post-' + p.id + '">'
      + '<div class="post-meta">'
      + '<span class="tag" style="background:' + (colors[p.platform] || '#333') + '">' + esc(p.platform) + '</span>'
      + (p.format ? '<span class="tag tag-format">' + esc(p.format) + '</span>' : '')
      + (p.pillar ? '<span class="tag">' + esc(p.pillar) + '</span>' : '')
      + (!isPending && p.published_at ? '<span>' + new Date(p.published_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</span>' : '')
      + '</div>'
      + '<div class="post-text" id="text-' + p.id + '">' + esc(content) + '</div>'
      + '<textarea class="edit-area" id="edit-' + p.id + '" style="display:none">' + esc(content) + '</textarea>'
      + actions
      + '</div>';
  }

  function renderArticle(a) {
    var takesHtml = (a.takes || []).map(function(t, i) {
      return '<div class="take-option">'
        + '<div class="take-text">' + esc(t) + '</div>'
        + '<button class="btn btn-approve" onclick="useTake(\'' + a.id + '\',' + i + ')">Use</button>'
        + '</div>';
    }).join('');

    var scoreHtml = '';
    var bd = a.score_breakdown;
    if (bd && bd.relevance) {
      scoreHtml = '<div class="score-breakdown">'
        + '<span>R:' + bd.relevance + '</span>'
        + '<span>A:' + bd.audience_fit + '</span>'
        + '<span>C:' + bd.credibility + '</span>'
        + '<span>N:' + bd.novelty + '</span>'
        + '<span class="score-avg">avg ' + (bd.avg || a.score) + '</span>'
        + '</div>';
    } else {
      scoreHtml = '<span class="tag tag-format">score ' + (a.score || '?') + '</span>';
    }

    return '<div class="article-card">'
      + '<div class="article-header">'
      + '<a href="' + esc(a.url) + '" target="_blank" class="article-title">' + esc(a.title) + '</a>'
      + '<div class="article-meta"><span class="tag">' + esc(a.source) + '</span>' + scoreHtml + '</div>'
      + '</div>'
      + '<div class="article-summary">' + esc((a.summary || '').slice(0, 150)) + '</div>'
      + '<div class="article-takes">' + takesHtml + '</div>'
      + '<div class="article-custom">'
      + '<input type="text" class="gen-input" id="custom-' + a.id + '" placeholder="Write your own take..." onkeydown="if(event.key===\'Enter\')customTake(\'' + a.id + '\')" />'
      + '<button class="btn btn-tweet" onclick="customTake(\'' + a.id + '\')">Post</button>'
      + '<button class="btn btn-reject" onclick="skipArticle(\'' + a.id + '\')">Skip</button>'
      + '</div></div>';
  }

  // Brief section HTML
  var briefSection = '';
  if (todayBrief) {
    briefSection = '<div class="section brief-section" style="border-color:#7c3aed;margin-bottom:12px">'
      + '<div class="section-header"><h2 style="color:#a78bfa">Today\'s Brief</h2>'
      + '<div style="font-size:10px;color:' + (todayBrief.status === 'confirmed' ? '#4ade80' : '#facc15') + '">'
      + (todayBrief.status === 'confirmed' ? 'Confirmed' : 'Pending') + '</div></div>'
      + '<div style="font-size:12px;line-height:1.6;margin-bottom:8px">'
      + '<b style="color:#c4b5fd">Topic:</b> ' + esc(todayBrief.topic || '') + '<br>'
      + '<b style="color:#c4b5fd">Angle:</b> ' + esc(todayBrief.angle || '') + '<br>'
      + '<b style="color:#c4b5fd">Framework:</b> ' + esc(todayBrief.framework || '') + '<br>'
      + '<b style="color:#c4b5fd">Hook direction:</b> ' + esc(todayBrief.hook_direction || '') + '<br>'
      + '<b style="color:#c4b5fd">Emotion:</b> ' + esc(todayBrief.emotion || '')
      + '</div>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap">'
      + '<button class="btn" style="background:#166534;color:#4ade80" onclick="confirmBrief()">Looks good →</button>'
      + '<button class="btn" style="background:#1e293b;color:#c4b5fd" onclick="changeBrief()">Change it</button>'
      + '<button class="btn btn-edit" onclick="editBriefToggle()">Edit brief</button>'
      + '</div>'
      + '<div id="briefEdit" style="display:none;margin-top:8px">'
      + '<input class="gen-input" id="briefTopic" value="' + esc(todayBrief.topic || '') + '" placeholder="Topic" style="margin-bottom:4px"><br>'
      + '<input class="gen-input" id="briefAngle" value="' + esc(todayBrief.angle || '') + '" placeholder="Angle" style="margin-bottom:4px"><br>'
      + '<input class="gen-input" id="briefHook" value="' + esc(todayBrief.hook_direction || '') + '" placeholder="Hook direction" style="margin-bottom:4px"><br>'
      + '<button class="btn btn-approve" onclick="saveBriefEdit()">Save</button>'
      + '</div>'
      + '<div id="briefStatus" style="font-size:11px;color:#facc15;margin-top:5px"></div>'
      + '</div>';
  } else if (!onboardingDone) {
    briefSection = '<div class="section" style="border-color:#facc15;margin-bottom:12px"><div style="font-size:13px">⚠️ Voice DNA not set up. <a href="/onboarding" style="color:#facc15">Complete onboarding</a> to unlock content quality features.</div></div>';
  }

  let tabContent = '';
  if (tab === 'feed') {
    tabContent = briefSection
      + '<div class="section" style="border-color:#334155;margin-bottom:12px">'
      + '<div class="section-header"><h2>Generate Insight</h2></div>'
      + '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">'
      + '<input type="text" id="insightTopic" placeholder="Topic (optional)..." class="gen-input-sm" style="flex:2" />'
      + '<button class="gen-style" onclick="genInsight()">Generate Insight</button>'
      + '</div>'
      + '<div class="gen-status" id="insightStatus"></div>'
      + '<div style="font-size:10px;color:#555;margin-bottom:4px">Generates: tweet + thread + LinkedIn draft + Reels hook</div>'
      + '</div>'
      + '<div class="section" style="border-color:#7c2d12">'
      + '<div class="section-header"><h2>Article Feed</h2><button class="btn btn-edit" onclick="runScout()" id="scoutBtn">Scan Now</button></div>'
      + (articles.length === 0 ? '<div class="empty">No articles yet. Hit "Scan Now" to find fresh content.</div>' : articles.map(renderArticle).join(''))
      + '</div>';
  } else if (tab === 'approved') {
    tabContent = '<div class="section"><h2>All Approved</h2>'
      + (tabApproved.length === 0 ? '<div class="empty">No approved posts yet.</div>' : tabApproved.map(function(p) { return renderPost(p, false); }).join(''))
      + '</div>';
  } else {
    var genSection = '';
    if (tab === 'twitter') {
      genSection = '<div class="gen-bar">'
        + '<button class="gen-style" onclick="generate(\'contrarian\')">Contrarian</button>'
        + '<button class="gen-style" onclick="generate(\'hot_take\')">Hot Take</button>'
        + '<button class="gen-style" onclick="generate(\'observation\')">Observation</button>'
        + '<button class="gen-style" onclick="generate(\'provocation\')">Provocation</button>'
        + '<button class="gen-style" onclick="generate(\'raw_take\')">Raw Take</button>'
        + '<button class="gen-style" onclick="generate(\'prediction\')">Prediction</button>'
        + '<input type="text" id="genTopic" placeholder="Topic (optional)..." class="gen-input-sm" />'
        + '<div class="gen-status" id="genStatus"></div></div>';
      if (trendingDiscussions.length > 0) {
        genSection += '<div class="section" style="border-color:#7c2d12;margin-top:10px"><h2 style="font-size:13px">Trending — React with a Take</h2>';
        for (var td = 0; td < trendingDiscussions.length; td++) {
          var tr = trendingDiscussions[td];
          genSection += '<div class="article-card">'
            + '<a href="' + escapeHtml(tr.url) + '" target="_blank" class="article-title" style="font-size:12px">' + escapeHtml(tr.title) + '</a>'
            + '<div class="article-meta"><span class="tag">' + escapeHtml(tr.source) + '</span></div>'
            + '<div class="article-takes">' + (tr.takes || []).map(function(t, i) {
              return '<div class="take-option"><div class="take-text">' + escapeHtml(t) + '</div>'
                + '<button class="btn btn-approve" onclick="useTake(\'' + tr.id + '\',' + i + ')">Use</button></div>';
            }).join('') + '</div>'
            + '<div class="article-custom">'
            + '<input type="text" class="gen-input" id="custom-' + tr.id + '" placeholder="Your take..." onkeydown="if(event.key===\'Enter\')customTake(\'' + tr.id + '\')" />'
            + '<button class="btn btn-tweet" onclick="customTake(\'' + tr.id + '\')">Post</button>'
            + '<button class="btn btn-reject" onclick="skipArticle(\'' + tr.id + '\')">Skip</button>'
            + '</div></div>';
        }
        genSection += '</div>';
      }
    } else if (tab === 'linkedin') {
      genSection = '<div class="gen-bar">'
        + '<button class="gen-style" onclick="generate(\'linkedin\')">Generate LinkedIn Post</button>'
        + '<input type="text" id="genTopic" placeholder="Topic (optional)..." class="gen-input-sm" />'
        + '<div class="gen-status" id="genStatus"></div></div>';
    } else if (tab === 'reels') {
      genSection = '<div class="gen-bar">'
        + '<button class="gen-style" onclick="generate(\'reels\')">Generate Reels Script</button>'
        + '<input type="text" id="genTopic" placeholder="Topic (optional)..." class="gen-input-sm" />'
        + '<div class="gen-status" id="genStatus"></div></div>';
    }

    tabContent = genSection;
    if (tabPending.length > 0) {
      tabContent += '<div class="section section-pending"><h2>Pending</h2>' + tabPending.map(function(p) { return renderPost(p, true); }).join('') + '</div>';
    }
    if (tabApproved.length > 0) {
      tabContent += '<div class="section"><h2>Approved</h2>' + tabApproved.map(function(p) { return renderPost(p, false); }).join('') + '</div>';
    }
    if (tabPending.length === 0 && tabApproved.length === 0) {
      tabContent += '<div class="section"><div class="empty">No ' + tab + ' content yet. Generate some above.</div></div>';
    }
  }

  // Stories tab
  if (tab === 'stories') {
    tabContent = '<div class="section" style="border-color:#7c3aed">'
      + '<div class="section-header"><h2 style="color:#a78bfa">Story Bank</h2><span style="font-size:11px;color:#888">' + userStories.length + ' stories</span></div>'
      + (userStories.length < 5 ? '<div style="font-size:11px;color:#facc15;margin-bottom:8px">Add ' + (5 - userStories.length) + ' more stories to reach the quality threshold (5 minimum).</div>' : '')
      + userStories.map(function(s) {
          return '<div class="story-card">'
            + '<div class="story-text">' + esc(s.story || '') + '</div>'
            + (s.lesson ? '<div class="story-lesson">→ ' + esc(s.lesson) + '</div>' : '')
            + (s.tags && s.tags.length ? '<div class="story-tags">' + s.tags.map(function(t){ return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>' : '')
            + '<button class="btn btn-reject" style="font-size:10px;margin-top:5px" onclick="deleteStory(\'' + s.id + '\')">Delete</button>'
            + '</div>';
        }).join('')
      + '<div style="margin-top:12px;border-top:1px solid #333;padding-top:12px">'
      + '<div style="font-size:12px;color:#888;margin-bottom:6px">Add a story</div>'
      + '<textarea id="newStory" placeholder="What happened? Be specific — time, place, what you observed..." class="edit-area" style="min-height:80px"></textarea>'
      + '<input id="newLesson" placeholder="Lesson / punchline" class="gen-input" style="margin-bottom:6px">'
      + '<button class="btn btn-approve" onclick="addStoryDash()">Add Story</button>'
      + '<div id="storyDashStatus" style="font-size:11px;color:#4ade80;margin-top:5px"></div>'
      + '</div></div>';
  }

  // Settings tab
  if (tab === 'settings') {
    const pct = trustSettings.per_channel_trust || {};
    const trustLabels = ['Manual (0)', '30-min auto (1)', 'Instant (2)'];
    tabContent = '<div class="section">'
      + '<div class="section-header"><h2>Trust Levels</h2><a href="/onboarding" class="btn btn-edit" style="text-decoration:none">Edit Voice DNA</a></div>'
      + '<p style="font-size:12px;color:#888;margin-bottom:10px">Control how much autonomy the system has per channel.</p>'
      + '<table style="width:100%;border-collapse:collapse;font-size:12px">'
      + '<tr style="color:#888"><th style="text-align:left;padding:4px 8px">Channel</th><th style="text-align:left;padding:4px 8px">Trust Level</th></tr>'
      + ['twitter','linkedin','reels','threads'].map(function(ch) {
          var lvl = pct[ch] || 0;
          return '<tr style="border-top:1px solid #333">'
            + '<td style="padding:6px 8px;text-transform:capitalize">' + ch + '</td>'
            + '<td style="padding:6px 8px">'
            + '<select class="trust-select" data-channel="' + ch + '" onchange="setChannelTrust(\'' + ch + '\',this.value)" style="background:#1a1a1a;border:1px solid #333;color:#e0e0e0;padding:3px 8px;border-radius:4px;font-size:11px">'
            + trustLabels.map(function(l,i){ return '<option value="'+i+'"'+(i===lvl?' selected':'')+'>'+l+'</option>'; }).join('')
            + '</select></td></tr>';
        }).join('')
      + '</table>'
      + '<div id="trustStatus" style="font-size:11px;color:#4ade80;margin-top:8px"></div>'
      + '</div>'
      + '<div class="section">'
      + '<h2>Onboarding Status</h2>'
      + '<p style="font-size:12px;color:#888;margin-bottom:8px">'
      + (onboardingDone ? '✓ Voice DNA set up.' : '⚠ Voice DNA not complete.')
      + ' Stories: ' + userStories.length + '/5 minimum.'
      + '</p>'
      + '<a href="/onboarding" class="btn btn-approve" style="text-decoration:none">' + (onboardingDone ? 'Re-do Voice DNA' : 'Complete Onboarding') + '</a>'
      + '</div>';
  }

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${pendingCount > 0 ? '(' + pendingCount + ') ' : ''}Content Machine</title>
<meta http-equiv="refresh" content="1800">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e0e0e0;padding:16px;max-width:750px;margin:0 auto}
h1{font-size:20px;margin-bottom:2px}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.header-right{font-size:11px;color:#888}
.header-right .approved{color:#4ade80} .header-right .rejected{color:#f87171}
.tabs{display:flex;gap:0;margin-bottom:14px;border-radius:8px;overflow:hidden;border:1px solid #333}
.tab{flex:1;padding:9px 0;text-align:center;font-size:12px;font-weight:500;cursor:pointer;text-decoration:none;color:#888;background:#161616;border-right:1px solid #333;transition:all .15s}
.tab:last-child{border-right:none}
.tab:hover{background:#1e293b;color:#e0e0e0}
.tab.active{background:#1e293b;color:#4ade80;border-bottom:2px solid #4ade80}
.tab .cnt{font-size:10px;color:#555;margin-left:3px}
.tab.active .cnt{color:#4ade80}
.section{background:#161616;border:1px solid #2a2a2a;border-radius:10px;padding:14px;margin-bottom:12px}
.section h2{font-size:14px;color:#fff;margin-bottom:8px}
.section-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.section-header h2{margin-bottom:0}
.section-pending{border-color:#22543d;border-width:2px}
.post{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:11px;margin-bottom:7px}
.post-meta{font-size:10px;color:#888;margin-bottom:5px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.post-text{font-size:13px;line-height:1.5;white-space:pre-wrap;margin-bottom:7px}
.tag{background:#1e293b;color:#60a5fa;padding:1px 5px;border-radius:3px;font-size:9px}
.tag-format{background:#312e81;color:#a78bfa}
.actions{display:flex;gap:5px;flex-wrap:wrap}
.btn{font-size:11px;padding:4px 11px;border-radius:5px;cursor:pointer;border:none;text-decoration:none;display:inline-block;font-weight:500}
.btn-copy{background:#334155;color:#e0e0e0}.btn-copy:hover{background:#475569}
.btn-tweet{background:#0c4a6e;color:#38bdf8}.btn-tweet:hover{background:#075985}
.btn-li{background:#1e3a5f;color:#60a5fa}.btn-li:hover{background:#1e40af}
.btn-approve{background:#166534;color:#4ade80}.btn-approve:hover{background:#15803d}
.btn-reject{background:#7f1d1d;color:#f87171}.btn-reject:hover{background:#991b1b}
.btn-edit{background:#1e293b;color:#facc15}.btn-edit:hover{background:#334155}
.btn-schedule{background:#1e293b;color:#facc15}.btn-schedule:hover{background:#334155}
.btn-render{background:#7c2d12;color:#fb923c}.btn-render:hover{background:#9a3412}
.edit-area{width:100%;min-height:80px;background:#111;color:#e0e0e0;border:1px solid #4ade80;border-radius:6px;padding:8px;font-size:13px;line-height:1.4;font-family:inherit;resize:vertical;margin-bottom:6px}
.empty{color:#555;font-size:12px;padding:8px 0}
.schedule-picker{display:flex;gap:3px;align-items:center;margin-top:5px;flex-wrap:wrap}
.sched-label{font-size:10px;color:#888;margin-right:3px}
.sched-btn{padding:3px 8px;border-radius:3px;border:1px solid #333;background:#1a1a1a;color:#facc15;cursor:pointer;font-size:10px}
.score-breakdown{display:flex;gap:4px;font-size:9px;color:#888}
.score-breakdown span{background:#1a1a1a;border:1px solid #333;padding:1px 4px;border-radius:3px}
.score-breakdown .score-avg{background:#1e3a5f;color:#38bdf8}
.story-card{background:#1a1a1a;border:1px solid #333;border-radius:7px;padding:10px;margin-bottom:7px}
.story-text{font-size:12px;line-height:1.5;margin-bottom:4px}
.story-lesson{font-size:11px;color:#4ade80;margin-bottom:4px}
.story-tags{display:flex;gap:3px;flex-wrap:wrap}
.brief-section{animation:pulse-border 2s ease-in-out infinite alternate}
@keyframes pulse-border{from{border-color:#7c3aed}to{border-color:#a78bfa}}
.li-modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.8);z-index:1000;align-items:center;justify-content:center}
.li-modal.open{display:flex}
.li-modal-box{background:#161616;border:1px solid #7c3aed;border-radius:12px;padding:20px;max-width:500px;width:90%;max-height:80vh;overflow:auto}
.li-modal-box h3{font-size:15px;margin-bottom:8px;color:#a78bfa}
.li-modal-content{background:#111;border:1px solid #333;border-radius:6px;padding:10px;font-size:13px;white-space:pre-wrap;line-height:1.5;max-height:200px;overflow:auto;margin-bottom:10px;user-select:all}
.li-modal-btns{display:flex;gap:8px;flex-wrap:wrap}
.toast{position:fixed;bottom:20px;right:20px;background:#1e293b;border:1px solid #4ade80;color:#4ade80;padding:10px 16px;border-radius:8px;font-size:12px;z-index:9999;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.show{opacity:1}
.sched-btn:hover{background:#334155;border-color:#facc15}
.btn-regen{background:#1e293b;color:#c084fc}.btn-regen:hover{background:#334155}
.regen-box{display:flex;gap:4px;margin-top:5px;align-items:center}
.sched-info{font-size:10px;color:#facc15;margin-top:3px}
.render-status{font-size:11px;color:#fb923c;margin-top:3px}
.video-ready{margin-top:5px}
.gen-bar{background:#161616;border:1px solid #2a2a2a;border-radius:10px;padding:10px;margin-bottom:12px;display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.gen-style{padding:5px 11px;border-radius:5px;border:1px solid #333;background:#1a1a1a;color:#e0e0e0;cursor:pointer;font-size:11px;transition:all .15s}
.gen-style:hover{background:#166534;border-color:#4ade80;color:#4ade80}
.gen-style:active{transform:scale(.96)}
.gen-style.loading{opacity:.5;pointer-events:none}
.gen-input-sm{background:#1a1a1a;border:1px solid #333;color:#fff;padding:5px 10px;border-radius:5px;font-size:11px;flex:1;min-width:120px}
.gen-status{font-size:11px;color:#facc15;width:100%}
.gen-input{background:#1a1a1a;border:1px solid #333;color:#fff;padding:6px 10px;border-radius:5px;font-size:12px;flex:1;min-width:100px}
.article-card{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:11px;margin-bottom:8px}
.article-header{margin-bottom:5px}
.article-title{font-size:13px;font-weight:600;color:#f59e0b;text-decoration:none;line-height:1.3;display:block;margin-bottom:3px}
.article-title:hover{text-decoration:underline}
.article-meta{font-size:10px;display:flex;gap:5px;margin-bottom:4px}
.article-summary{font-size:11px;color:#777;margin-bottom:7px;line-height:1.3}
.article-takes{display:flex;flex-direction:column;gap:5px;margin-bottom:7px}
.take-option{display:flex;align-items:flex-start;gap:7px;padding:5px 7px;background:#111;border-radius:5px}
.take-text{flex:1;font-size:12px;line-height:1.4;white-space:pre-wrap}
.article-custom{display:flex;gap:4px;align-items:center}
.links{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.links a{color:#60a5fa;font-size:11px;padding:5px 10px;border:1px solid #333;border-radius:5px;text-decoration:none}
.links a:hover{background:#1e293b}
</style></head><body>
<div class="header">
  <h1>Content Machine</h1>
  <div class="header-right">${req.user ? '<span style="color:#4ade80">' + escapeHtml(req.user.name) + '</span> · <span>' + req.user.credits + ' credits</span> · <a href="/logout" style="color:#888;text-decoration:none">Logout</a>' : ''}</div>
</div>

<div class="tabs">
  <a class="tab ${tab==='feed'?'active':''}" href="/dashboard?tab=feed">Feed<span class="cnt">${counts.feed}</span></a>
  <a class="tab ${tab==='twitter'?'active':''}" href="/dashboard?tab=twitter">Tweets<span class="cnt">${counts.twitter}</span></a>
  <a class="tab ${tab==='linkedin'?'active':''}" href="/dashboard?tab=linkedin">LinkedIn<span class="cnt">${counts.linkedin}</span></a>
  <a class="tab ${tab==='reels'?'active':''}" href="/dashboard?tab=reels">Reels<span class="cnt">${counts.reels}</span></a>
  <a class="tab ${tab==='stories'?'active':''}" href="/dashboard?tab=stories">Stories<span class="cnt">${counts.stories}</span></a>
  <a class="tab ${tab==='approved'?'active':''}" href="/dashboard?tab=approved">All<span class="cnt">${counts.approved}</span></a>
  <a class="tab ${tab==='settings'?'active':''}" href="/dashboard?tab=settings" style="flex:0.6">⚙</a>
</div>

<!-- LinkedIn modal -->
<div class="li-modal" id="liModal">
  <div class="li-modal-box">
    <h3>Post to LinkedIn</h3>
    <p style="font-size:12px;color:#888;margin-bottom:8px">1. Copy content below → 2. Open LinkedIn → 3. Paste and post</p>
    <div class="li-modal-content" id="liModalContent"></div>
    <div class="li-modal-btns">
      <button class="btn btn-approve" onclick="copyLiContent()">Copy Content</button>
      <a id="liOpenBtn" class="btn btn-li" href="#" target="_blank" onclick="closeLiModal()">Open LinkedIn →</a>
      <button class="btn btn-reject" onclick="closeLiModal()">Close</button>
    </div>
    <div id="liModalStatus" style="font-size:11px;color:#4ade80;margin-top:8px"></div>
  </div>
</div>
<!-- Toast -->
<div class="toast" id="toast"></div>

${tabContent}

<div class="links">
  <a href="/">Public</a>
  <a href="/rss.xml">RSS</a>
  <a href="/api/stats">Stats</a>
  <a href="/api/decisions">Decisions</a>
</div>
<script>
function toggleEdit(id){var t=document.getElementById('text-'+id),e=document.getElementById('edit-'+id);if(e.style.display==='none'){e.style.display='block';t.style.display='none';e.focus()}else{e.style.display='none';t.style.display='block'}}
function getPostContent(id){var e=document.getElementById('edit-'+id);if(e&&e.style.display!=='none')return e.value;var t=document.getElementById('text-'+id);return t?t.textContent:''}
function approveAndTweet(id){var c=getPostContent(id);window.open('https://twitter.com/intent/tweet?text='+encodeURIComponent(c),'_blank');var e=document.getElementById('edit-'+id);var ed=e&&e.style.display!=='none';fetch(ed?'/api/edit/'+id:'/api/approve-and-tweet/'+id,{method:'POST',headers:ed?{'Content-Type':'application/json'}:{},body:ed?JSON.stringify({content:c}):undefined}).then(function(){setTimeout(function(){location.reload()},500)})}
function showToast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2500)}
function approveAndLinkedIn(id){
  var c=getPostContent(id),e=document.getElementById('edit-'+id),ed=e&&e.style.display!=='none';
  // First approve the post
  fetch(ed?'/api/edit/'+id:'/api/approve/'+id,{method:'POST',headers:ed?{'Content-Type':'application/json'}:{},body:ed?JSON.stringify({content:c}):undefined})
    .then(function(){
      // Show LinkedIn modal instead of relying on URL params
      document.getElementById('liModalContent').textContent=c;
      document.getElementById('liOpenBtn').href='https://www.linkedin.com/feed/?shareActive=true&text='+encodeURIComponent(c.slice(0,2900));
      document.getElementById('liModal').classList.add('open');
      document.getElementById('liModalStatus').textContent='';
    });
}
function closeLiModal(){document.getElementById('liModal').classList.remove('open');location.reload()}
function copyLiContent(){
  var c=document.getElementById('liModalContent').textContent;
  navigator.clipboard.writeText(c).then(function(){
    showToast('Copied to clipboard!');
    document.getElementById('liModalStatus').textContent='Copied! Now paste into LinkedIn.';
  }).catch(function(){
    document.getElementById('liModalStatus').textContent='Manual copy: select all text above and copy.';
  });
}
function approvePost(id){fetch('/api/approve/'+id,{method:'POST'}).then(function(){location.reload()})}
function rejectPost(id){fetch('/api/reject/'+id,{method:'POST'}).then(function(){location.reload()})}
function copyFromPost(id){var c=getPostContent(id);navigator.clipboard.writeText(c).then(function(){var b=document.getElementById('post-'+id).querySelectorAll('.btn-copy');b.forEach(function(x){x.textContent='Copied!';setTimeout(function(){x.textContent='Copy'},1500)})})}
function copyText(t,b){navigator.clipboard.writeText(t).then(function(){b.textContent='Copied!';setTimeout(function(){b.textContent='Copy'},1500)})}
function showRegen(id){var el=document.getElementById('regen-'+id);el.style.display=el.style.display==='none'?'flex':'none';if(el.style.display==='flex')document.getElementById('regen-input-'+id).focus()}
function regenPost(id){var input=document.getElementById('regen-input-'+id);if(!input||!input.value.trim())return;var btn=input.nextElementSibling;btn.textContent='Regenerating...';btn.disabled=true;fetch('/api/regenerate/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({comment:input.value.trim(),original:document.getElementById('text-'+id)?.textContent||''})}).then(function(r){return r.json()}).then(function(d){if(d.ok){document.getElementById('text-'+id).textContent=d.content;document.getElementById('regen-'+id).style.display='none';input.value='';btn.textContent='Regenerate';btn.disabled=false}else{btn.textContent='Failed';btn.disabled=false}}).catch(function(){btn.textContent='Failed';btn.disabled=false})}
function showSchedule(id){var e=document.getElementById('sched-'+id);e.style.display=e.style.display==='none'?'flex':'none'}
function schedulePost(id,time){fetch('/api/schedule/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({time:time})}).then(function(r){return r.json()}).then(function(d){if(d.ok)location.reload()})}
function useTake(aid,i){fetch('/api/article-react/'+aid,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'use_take',take_index:i})}).then(function(r){return r.json()}).then(function(d){if(d.ok)location.href='/dashboard?tab=twitter'})}
function customTake(aid){var input=document.getElementById('custom-'+aid);if(!input||!input.value.trim())return;fetch('/api/article-react/'+aid,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'custom',custom_take:input.value.trim()})}).then(function(r){return r.json()}).then(function(d){if(d.ok)location.href='/dashboard?tab=twitter'})}
function skipArticle(aid){fetch('/api/article-react/'+aid,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'skip'})}).then(function(){location.reload()})}
function runScout(){var b=document.getElementById('scoutBtn');if(b){b.textContent='Scanning...';b.disabled=true}fetch('/api/scout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(function(r){return r.json()}).then(function(d){if(b)b.textContent=d.articles+' found';setTimeout(function(){location.reload()},1000)}).catch(function(){if(b){b.textContent='Failed';b.disabled=false}})}
function generate(style){var topic=document.getElementById('genTopic');var t=topic?topic.value:'';var status=document.getElementById('genStatus');var btns=document.querySelectorAll('.gen-style');btns.forEach(function(b){b.classList.add('loading')});if(status)status.textContent='Generating...';var platform=style==='linkedin'?'linkedin':(style==='reels'?'reels':'twitter');fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({platform:platform,style:style,topic:t||undefined})}).then(function(r){return r.json()}).then(function(d){btns.forEach(function(b){b.classList.remove('loading')});if(d.ok){if(status)status.textContent='Done!';setTimeout(function(){location.reload()},500)}else{if(status)status.textContent='Error: '+(d.error||'unknown')}}).catch(function(e){btns.forEach(function(b){b.classList.remove('loading')});if(status)status.textContent='Error: '+e.message})}
function genInsight(){var t=document.getElementById('insightTopic');var s=document.getElementById('insightStatus');s.textContent='Generating insight across all platforms...';fetch('/api/insight',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:t?t.value:''})}).then(function(r){return r.json()}).then(function(d){if(d.ok){s.textContent='Insight generated! Check all platform tabs.';setTimeout(function(){location.reload()},1000)}else{s.textContent='Error: '+(d.error||'unknown')}}).catch(function(e){s.textContent='Error: '+e.message})}
function renderReel(id){var s=document.getElementById('render-'+id);if(s)s.textContent='Rendering video... (TTS + FFmpeg, may take 30-60s)';fetch('/api/render-reel/'+id,{method:'POST',headers:{'Content-Type':'application/json'}}).then(function(r){return r.json()}).then(function(d){if(d.ok){if(s)s.innerHTML='Done! <a href="'+d.video_url+'" target="_blank" style="color:#4ade80">Download MP4</a>';setTimeout(function(){location.reload()},2000)}else{if(s)s.textContent='Error: '+(d.error||'unknown')}}).catch(function(e){if(s)s.textContent='Error: '+e.message})}
// Brief functions
function confirmBrief(){fetch('/api/brief',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'confirmed'})}).then(function(){showToast('Brief confirmed!');document.getElementById('briefStatus').textContent='✓ Confirmed — generation will use this angle.'})}
function changeBrief(){var s=document.getElementById('briefStatus');s.textContent='Generating alternatives...';fetch('/api/brief/alternatives',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current_topic:''})}).then(function(r){return r.json()}).then(function(d){if(d.ok){var txt=d.alternatives.map(function(a,i){return (i+1)+'. ['+a.framework+'] '+a.topic+' — '+a.angle}).join('\n');s.textContent='Alternatives:\n'+txt+'\n\nReload to see updated brief or edit manually.'}else{s.textContent='Failed to get alternatives.'}})}
function editBriefToggle(){var el=document.getElementById('briefEdit');el.style.display=el.style.display==='none'?'block':'none'}
function saveBriefEdit(){fetch('/api/brief',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:document.getElementById('briefTopic').value,angle:document.getElementById('briefAngle').value,hook_direction:document.getElementById('briefHook').value,status:'confirmed'})}).then(function(){showToast('Brief updated!');document.getElementById('briefEdit').style.display='none';document.getElementById('briefStatus').textContent='Brief saved.'})}
// Story bank functions
function addStoryDash(){var st=document.getElementById('newStory').value.trim(),le=document.getElementById('newLesson').value.trim();if(!st)return;document.getElementById('storyDashStatus').textContent='Adding...';fetch('/api/stories',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({story:st,lesson:le})}).then(function(r){return r.json()}).then(function(d){if(d.ok){showToast('Story added!');document.getElementById('storyDashStatus').textContent='Added ('+d.total+' total). Reload to see.';document.getElementById('newStory').value='';document.getElementById('newLesson').value=''}})}
function deleteStory(id){if(!confirm('Delete this story?'))return;fetch('/api/stories/'+id,{method:'DELETE'}).then(function(){location.reload()})}
// Trust functions
function setChannelTrust(ch,lvl){fetch('/api/trust',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:ch,level:parseInt(lvl)})}).then(function(r){return r.json()}).then(function(d){if(d.ok){showToast(ch+' trust set to '+lvl);document.getElementById('trustStatus').textContent=ch+' trust level saved.'}else{document.getElementById('trustStatus').textContent='Failed.'}})}

if('Notification' in window&&Notification.permission==='default')Notification.requestPermission();
var lastPC=${pendingCount};
setInterval(function(){fetch('/api/pending').then(function(r){return r.json()}).then(function(d){var n=d.total||0;if(n>lastPC&&Notification.permission==='granted')new Notification('Content Machine',{body:(n-lastPC)+' new posts ready'});lastPC=n;document.title=n>0?'('+n+') Content Machine':'Content Machine'})},300000);
</script></body></html>`;
  res.type('html').send(html);
});

// ── RSS Feed (aggregates all tenants) ─────────────────────────────────────────

app.get('/rss.xml', (req, res) => {
  const posts = readAllTenantsDir('published').slice(0, 20);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${escapeXml(SITE_TITLE)}</title>
  <link>${escapeXml(SITE_URL)}</link>
  <description>AI-generated content by Deep Soni</description>
  <atom:link href="${escapeXml(SITE_URL)}/rss.xml" rel="self" type="application/rss+xml"/>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${posts.map(p => `  <item>
    <title>${escapeXml(p.content.slice(0, 80))}</title>
    <link>${escapeXml(SITE_URL)}/post/${escapeXml(p.id)}</link>
    <guid isPermaLink="true">${escapeXml(SITE_URL)}/post/${escapeXml(p.id)}</guid>
    <pubDate>${new Date(p.published_at).toUTCString()}</pubDate>
    <description>${escapeXml(p.content)}</description>
    <category>${escapeXml(p.platform)}</category>
  </item>`).join('\n')}
</channel>
</rss>`;
  res.type('application/rss+xml').send(xml);
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 3: Auto-Post + Repurpose (Trust levels now handled above)
// ══════════════════════════════════════════════════════════════════════════════

// ── API: Auto-approve (for trust level 1/2 automation) ───────────────────────

app.post('/api/auto-approve/:id', (req, res) => {
  const pendDir = path.join(req.userDataDir, 'pending');
  const pubDir = path.join(req.userDataDir, 'published');
  const decDir = path.join(req.userDataDir, 'decisions');
  const pendingFile = path.join(pendDir, `${req.params.id}.json`);
  if (!fs.existsSync(pendingFile)) return res.status(404).json({ error: 'not found' });

  const post = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  post.published_at = new Date().toISOString();
  post.status = 'auto-approved';
  post.auto_approved = true;
  delete post.created_at;

  fs.writeFileSync(path.join(pubDir, `${post.id}.json`), JSON.stringify(post, null, 2));

  fs.mkdirSync(decDir, { recursive: true });
  fs.writeFileSync(path.join(decDir, `${post.id}.json`), JSON.stringify({
    type: 'approved', auto: true, post_id: post.id, platform: post.platform,
    format: post.format || 'unknown', content_preview: (post.content || '').slice(0, 100),
    pillar: post.pillar, at: new Date().toISOString()
  }, null, 2));

  fs.unlinkSync(pendingFile);

  // Auto-post to Twitter if configured and platform is twitter
  if (post.platform === 'twitter' && req.body.auto_post) {
    autoPostTwitter(post).then(result => {
      if (result.ok) {
        post.tweet_id = result.tweet_id;
        fs.writeFileSync(path.join(pubDir, `${post.id}.json`), JSON.stringify(post, null, 2));
      }
    }).catch(() => {});
  }

  res.json({ ok: true, id: post.id });
});

// ── API: Auto-post to Twitter v2 ─────────────────────────────────────────────

async function autoPostTwitter(post) {
  const apiKey = process.env.TWITTER_API_KEY;
  const apiSecret = process.env.TWITTER_API_SECRET;
  const accessToken = process.env.TWITTER_ACCESS_TOKEN;
  const accessSecret = process.env.TWITTER_ACCESS_SECRET;
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) return { ok: false, error: 'Twitter API not configured' };

  const url = 'https://api.twitter.com/2/tweets';
  const method = 'POST';
  const tweetBody = JSON.stringify({ text: post.content });

  // OAuth 1.0a signing
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');

  const params = {
    oauth_consumer_key: apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: accessToken,
    oauth_version: '1.0'
  };

  const paramString = Object.keys(params).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  const baseString = method + '&' + encodeURIComponent(url) + '&' + encodeURIComponent(paramString);
  const signingKey = encodeURIComponent(apiSecret) + '&' + encodeURIComponent(accessSecret);
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  const authHeader = 'OAuth ' + Object.entries({ ...params, oauth_signature: signature })
    .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
    .join(', ');

  return new Promise((resolve) => {
    const tReq = https.request(url, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(tweetBody) }
    }, tRes => {
      let d = '';
      tRes.on('data', c => d += c);
      tRes.on('end', () => {
        try {
          const result = JSON.parse(d);
          if (result.data?.id) {
            console.log('Auto-tweeted:', result.data.id);
            resolve({ ok: true, tweet_id: result.data.id });
          } else {
            console.error('Twitter API error:', d.slice(0, 200));
            resolve({ ok: false, error: d.slice(0, 200) });
          }
        } catch { resolve({ ok: false, error: d.slice(0, 200) }); }
      });
    });
    tReq.on('error', e => resolve({ ok: false, error: e.message }));
    tReq.write(tweetBody);
    tReq.end();
  });
}

app.post('/api/auto-post/:id', async (req, res) => {
  const pubDir = path.join(req.userDataDir, 'published');
  const file = path.join(pubDir, `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });

  const post = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (post.platform !== 'twitter') return res.status(400).json({ error: 'Auto-post only supports Twitter currently' });

  const result = await autoPostTwitter(post);
  if (result.ok) {
    post.tweet_id = result.tweet_id;
    post.auto_posted_at = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(post, null, 2));
  }
  res.json(result);
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 4: Repurposing + Pillar Scheduling
// ══════════════════════════════════════════════════════════════════════════════

// ── API: Repurpose a tweet to LinkedIn + Threads ─────────────────────────────

app.post('/api/repurpose/:id', async (req, res) => {
  const pubDir = path.join(req.userDataDir, 'published');
  const pendDir = path.join(req.userDataDir, 'pending');
  const ctxFile = path.join(req.userDataDir, 'contexts/default.txt');
  const file = path.join(pubDir, `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });

  const post = JSON.parse(fs.readFileSync(file, 'utf8'));
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'No GROQ_API_KEY' });

  let context = '';
  try { context = fs.readFileSync(ctxFile, 'utf8'); } catch {}

  const results = [];

  // Generate LinkedIn version
  try {
    const liPrompt = 'Original tweet:\n"' + post.content + '"\n\nExpand this into a LinkedIn post. 300-500 words. Professional but opinionated. Hook in first 2 lines. End with a question or CTA. Return ONLY the post text.';
    const liBody = JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: context + '\n\nYou are writing a LinkedIn post based on this tweet. Professional, structured, with a hook.' }, { role: 'user', content: liPrompt }],
      stream: false, temperature: 0.7
    });
    const liResult = await new Promise((resolve, reject) => {
      const r = https.request('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Length': Buffer.byteLength(liBody) }
      }, res2 => { let d = ''; res2.on('data', c => d += c); res2.on('end', () => resolve(d)); });
      r.on('error', reject); r.write(liBody); r.end();
    });
    const liContent = JSON.parse(liResult).choices?.[0]?.message?.content || '';
    if (liContent) {
      const liId = generateId();
      fs.writeFileSync(path.join(pendDir, liId + '.json'), JSON.stringify({
        id: liId, profile_id: post.profile_id, display_name: post.display_name,
        platform: 'linkedin', content: liContent, pillar: post.pillar,
        format: 'repurposed', source_post_id: post.id,
        created_at: new Date().toISOString(), status: 'pending'
      }, null, 2));
      results.push({ platform: 'linkedin', id: liId });
    }
  } catch {}

  // Generate Threads version
  try {
    const thPrompt = 'Original tweet:\n"' + post.content + '"\n\nRewrite this as a Threads post. Casual, conversational, under 300 characters. Return ONLY the text.';
    const thBody = JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: context + '\n\nRewrite for Threads. Casual and short.' }, { role: 'user', content: thPrompt }],
      stream: false, temperature: 0.8
    });
    const thResult = await new Promise((resolve, reject) => {
      const r = https.request('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Length': Buffer.byteLength(thBody) }
      }, res2 => { let d = ''; res2.on('data', c => d += c); res2.on('end', () => resolve(d)); });
      r.on('error', reject); r.write(thBody); r.end();
    });
    const thContent = JSON.parse(thResult).choices?.[0]?.message?.content || '';
    if (thContent) {
      const thId = generateId();
      fs.writeFileSync(path.join(pendDir, thId + '.json'), JSON.stringify({
        id: thId, profile_id: post.profile_id, display_name: post.display_name,
        platform: 'threads', content: thContent, pillar: post.pillar,
        format: 'repurposed', source_post_id: post.id,
        created_at: new Date().toISOString(), status: 'pending'
      }, null, 2));
      results.push({ platform: 'threads', id: thId });
    }
  } catch {}

  res.json({ ok: true, repurposed: results });
});

// ── API: Today's pillar (from profile config) ────────────────────────────────

app.get('/api/pillar', (req, res) => {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = dayNames[new Date().getDay()];
  try {
    const profilePath = path.join(DATA_DIR, 'profiles/deep_personal.json');
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    const pillar = profile.pillar_schedule?.[today] || 'Build in Public';
    res.json({ day: today, pillar, profile_id: profile.id });
  } catch {
    res.json({ day: today, pillar: 'Build in Public', profile_id: 'default' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 5: Analytics + Weekly Digest
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/analytics/weekly', (req, res) => {
  const pubDir = path.join(req.userDataDir, 'published');
  const decDir = path.join(req.userDataDir, 'decisions');
  const weekAgo = new Date(Date.now() - 7 * 86400000);

  const posts = readJsonDir(pubDir).filter(p => new Date(p.published_at) >= weekAgo);

  const byPlatform = {};
  const byFormat = {};
  const byPillar = {};
  for (const p of posts) {
    byPlatform[p.platform] = (byPlatform[p.platform] || 0) + 1;
    if (p.format) byFormat[p.format] = (byFormat[p.format] || 0) + 1;
    if (p.pillar) byPillar[p.pillar] = (byPillar[p.pillar] || 0) + 1;
  }

  // Approval rate from decisions
  let approved = 0, rejected = 0;
  try {
    const decisions = fs.readdirSync(decDir).filter(f => f.endsWith('.json'));
    for (const f of decisions) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(decDir, f), 'utf8'));
        if (new Date(d.at) < weekAgo) continue;
        if (d.type === 'approved' || d.type === 'edited') approved++;
        else if (d.type === 'rejected') rejected++;
      } catch {}
    }
  } catch {}

  res.json({
    period: '7d',
    total_posts: posts.length,
    by_platform: byPlatform,
    by_format: byFormat,
    by_pillar: byPillar,
    approval_rate: approved + rejected > 0 ? Math.round(approved / (approved + rejected) * 100) : 100,
    approved, rejected
  });
});

app.get('/api/analytics/learnings', (req, res) => {
  const learningsFile = path.join(DATA_DIR, 'learnings', req.userId + '.json');
  try {
    const data = JSON.parse(fs.readFileSync(learningsFile, 'utf8'));
    res.json(data);
  } catch {
    res.json({ weeks: [] });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PHASE 6: Full WhatsApp Command Handler
// ══════════════════════════════════════════════════════════════════════════════
// (The expanded commands are integrated into the existing /api/whatsapp-command
//  endpoint — see the updated handler above at its original location)

// ── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Content Hub running on port ${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Multi-tenant mode: all data scoped to /data/tenants/{userId}/`);
});
