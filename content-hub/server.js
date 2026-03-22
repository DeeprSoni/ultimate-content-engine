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

app.post('/api/whatsapp-command', (req, res) => {
  const pendDir = path.join(req.userDataDir, 'pending');
  const pubDir = path.join(req.userDataDir, 'published');
  const { text, phone } = req.body;
  const cmd = (text || '').trim().toLowerCase();
  const pending = readJsonDir(pendDir);

  if (!cmd) return res.json({ reply: 'Send a number (1/2/3) to approve, SKIP to reject all, or LIST to see pending.' });

  if (cmd === 'list' || cmd === 'pending') {
    if (pending.length === 0) return res.json({ reply: 'No pending posts.' });
    const list = pending.slice(0, 6).map((p, i) =>
      `${i + 1}. [${p.platform}] ${(p.content || '').slice(0, 80)}...`
    ).join('\n');
    return res.json({ reply: `${pending.length} pending:\n\n${list}\n\nReply with number to approve, SKIP ALL to reject all.` });
  }

  if (cmd === 'skip' || cmd === 'skip all' || cmd === 'reject') {
    let count = 0;
    for (const p of pending) {
      try { fs.unlinkSync(path.join(pendDir, `${p.id}.json`)); count++; } catch {}
    }
    return res.json({ reply: `Rejected ${count} pending posts.` });
  }

  const num = parseInt(cmd);
  if (!isNaN(num) && num >= 1 && num <= pending.length) {
    const post = pending[num - 1];
    post.published_at = new Date().toISOString();
    post.status = 'published';
    delete post.created_at;
    fs.writeFileSync(path.join(pubDir, `${post.id}.json`), JSON.stringify(post, null, 2));
    try { fs.unlinkSync(path.join(pendDir, `${post.id}.json`)); } catch {}
    const preview = (post.content || '').slice(0, 100);
    return res.json({ reply: `Approved #${num} [${post.platform}]:\n${preview}\n\nPublished. Copy from dashboard to post.` });
  }

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
    return res.json({ reply: `Approved all ${count} posts. Check dashboard to tweet/copy.` });
  }

  return res.json({ reply: `Commands:\n1-${pending.length} = approve that post\nSKIP = reject all\nLIST = see pending\nALL = approve everything` });
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

  const insightPrompt = (topic ? 'TOPIC: ' + topic : 'Pick a fresh topic from Deep\'s worldview.') +
    (worldview_point ? '\nWORLDVIEW LENS: ' + worldview_point : '') +
    '\n\nDEEP\'S REAL STORIES (you MUST weave one into the tweet):\n' + storyContext +
    '\n\nGenerate ONE insight that passes the AHA TEST: it connects two things the reader hasn\'t connected before.' +
    '\n\nRules:' +
    '\n- The tweet MUST include a real story or specific experience, not just an opinion' +
    '\n- Target ONE emotion: ANGER (at status quo) or FEAR (being left behind) or SUPERIORITY (reader feels smart) or HOPE (exciting future)' +
    '\n- The thread must follow this structure: Hook (curiosity gap) → Setup (what everyone thinks) → Twist (what\'s actually true) → Evidence (specific proof) → Implication (what this means for reader) → CTA' +
    '\n- NEVER write "X will replace Y" or "X is dead" — find the non-obvious angle' +
    '\n- Each tweet must be something the reader will SCREENSHOT or QUOTE-TWEET to argue with' +
    '\n\nReturn ONLY valid JSON (no markdown, no code fences):' +
    '\n{"insight":"core idea connecting two things","emotion":"anger/fear/superiority/hope","tweet":"under 280 chars, story-grounded, with line breaks","thread":["hook that creates curiosity gap","what everyone thinks (the setup)","what is actually true (the twist)","specific evidence or story","what this means for YOU the reader","CTA - follow/agree/disagree"],"linkedin_angle":"1 sentence expansion direction","reels_hook":"first 3 seconds that stop the scroll"}' +
    antiRepeat + feedback;

  try {
    const body = JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: context + '\n\nYou ARE Deep. Generate an insight grounded in real experience. Second-order thinking. Non-obvious. Banger only.' },
        { role: 'user', content: insightPrompt }
      ],
      stream: false, temperature: 0.85, max_tokens: 2000
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
    const raw = parsed.choices?.[0]?.message?.content || '{}';
    let insight;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      let jsonStr = jsonMatch[0]
        .replace(/\n\s*\n/g, '\\n')
        .replace(/,\s*([}\]])/g, '$1');
      insight = JSON.parse(jsonStr);
    } catch (parseErr) {
      try {
        const tweetMatch = raw.match(/"tweet"\s*:\s*"([^"]+)"/);
        const insightMatch = raw.match(/"insight"\s*:\s*"([^"]+)"/);
        if (tweetMatch) {
          insight = {
            insight: insightMatch ? insightMatch[1] : '',
            tweet: tweetMatch[1],
            thread: [],
            linkedin_angle: '',
            reels_hook: ''
          };
        } else throw parseErr;
      } catch {
        return res.status(500).json({ error: 'Failed to parse insight', raw: raw.slice(0, 300) });
      }
    }

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

    sendNotification('New insight generated', 'Tweet + Thread + LinkedIn + Reels from one idea');

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

  const { platform, style, topic } = req.body;
  const targetPlatform = platform || 'twitter';

  const pendDir = path.join(req.userDataDir, 'pending');
  const pubDir = path.join(req.userDataDir, 'published');
  const decDir = path.join(req.userDataDir, 'decisions');
  const ctxFile = path.join(req.userDataDir, 'contexts/default.txt');

  let context = '';
  try { context = fs.readFileSync(ctxFile, 'utf8'); } catch {}

  let regenLearnings = '';
  try {
    if (fs.existsSync(decDir)) {
      const feedbackItems = fs.readdirSync(decDir)
        .filter(f => f.startsWith('regen-'))
        .map(f => { try { return JSON.parse(fs.readFileSync(path.join(decDir, f), 'utf8')); } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => new Date(b.at) - new Date(a.at))
        .slice(0, 10)
        .map(d => d.comment);
      if (feedbackItems.length > 0) {
        regenLearnings = '\n\nLEARNED PREFERENCES (from past feedback — apply these to ALL content):\n' + feedbackItems.map(f => '- ' + f).join('\n') + '\n';
      }
    }
  } catch {}
  context += regenLearnings;

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'No GROQ_API_KEY configured' });

  const styleInstructions = {
    contrarian: 'Disagree with something everyone accepts. State the popular view, then destroy it. Be specific about WHY.',
    raw_take: 'Write a raw, unfiltered thought. 1-3 short lines with blank lines between them. Just conviction.',
    provocation: 'Say something that will make people angry or think. The kind of tweet people quote-tweet to argue with.',
    observation: 'Point out a pattern nobody is talking about. 2-3 lines. End with the implication.',
    hot_take: 'State something unpopular and back it with a reason nobody talks about.',
    prediction: 'Make a bold prediction about the future. State it as fact. Short. Inevitable tone.',
    one_liner: 'One sentence under 100 characters. Standalone punch.',
    question: 'Ask a provocative question that implies a strong opinion. No answer needed.',
    linkedin: 'Write a 300-500 word LinkedIn post. Hook in first 2 lines. Structured. Professional but opinionated. End with CTA.',
    reels: 'Create a 30-60s Reels script. Return JSON: {"hook":"...","beats":[{"voiceover":"...","visual":"...","duration":"Xs"}],"cta":"...","music_mood":"...","total_duration":"Xs"}'
  };

  const chosenStyle = style || 'contrarian';
  const isLinkedIn = targetPlatform === 'linkedin' || chosenStyle === 'linkedin';
  const isReels = targetPlatform === 'reels' || chosenStyle === 'reels';

  let userPrompt = '';
  if (isReels) {
    userPrompt = (topic ? 'Topic: ' + topic + '\\n\\n' : '') + styleInstructions.reels;
  } else if (isLinkedIn) {
    userPrompt = (topic ? 'Topic: ' + topic + '\\n\\n' : '') + styleInstructions.linkedin + '\\n\\nReturn ONLY the post text.';
  } else {
    var recentApproved = [];
    try {
      recentApproved = readJsonDir(pubDir)
        .filter(function(p) { return p.platform === 'twitter'; })
        .slice(0, 15)
        .map(function(p) { return p.content; });
    } catch(e) {}

    var antiRepeat = recentApproved.length > 0
      ? '\\n\\nNEVER repeat these ideas (already posted):\\n' + recentApproved.map(function(t, i) { return (i+1) + '. ' + t.slice(0, 80); }).join('\\n') + '\\n\\nFind something COMPLETELY DIFFERENT.'
      : '';

    userPrompt = (topic ? 'SPECIFIC ANGLE: ' + topic + '.' : 'Pick a topic from Deep\'s identity that hasn\'t been covered recently.') +
      '\\n\\nStyle: ' + (styleInstructions[chosenStyle] || styleInstructions.contrarian) +
      '\\n\\nFRAMEWORK (use one):\\n' +
      '- HIDDEN WINNER: Who benefits that nobody talks about?\\n' +
      '- CONTRADICTION: What does conventional wisdom get wrong here?\\n' +
      '- BUILDER ANGLE: What would you build on top of this?\\n' +
      '- TIMELINE LIE: Is this faster/slower than people think?\\n' +
      '- INDIA ANGLE: How is this different in India?\\n\\n' +
      'Rules:\\n' +
      '- Under 280 chars. Space out with line breaks.\\n' +
      '- MUST include a real story or specific experience. Never just an opinion.\\n' +
      '- Target ONE emotion: anger/fear/superiority/hope.\\n' +
      '- The AHA test: connect two things the reader has not connected before.\\n' +
      '- NEVER write "X will replace Y" or "X is dead."\\n' +
      '- Study the BANGER EXAMPLES in the system prompt. Match that level.\\n' +
      'Return ONLY the tweet text.' + antiRepeat;
  }

  const sysPrompt = context + (isLinkedIn
    ? '\\n\\nYou are writing a LinkedIn post as Deep. Professional but opinionated. Target: Indian business audience.'
    : '\\n\\nYou ARE Deep. Match the real tweets above exactly. Raw, short, controversial.');

  try {
    const body = JSON.stringify({
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
      stream: false,
      temperature: isLinkedIn ? 0.7 : 0.85
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
    let content = parsed.choices?.[0]?.message?.content || '';

    if (isReels) {
      try {
        const script = JSON.parse(content.replace(/```json|```/g, '').trim());
        content = 'HOOK: ' + (script.hook || '') + '\\n\\n' +
          (script.beats || []).map((b, i) => 'BEAT ' + (i+1) + ' (' + (b.duration || '?') + '):\\n' + (b.voiceover || '') + '\\nVISUAL: ' + (b.visual || '')).join('\\n\\n') +
          '\\n\\nCTA: ' + (script.cta || '') + '\\nMOOD: ' + (script.music_mood || 'energetic');
      } catch {}
    }

    const actualPlatform = isReels ? 'reels' : (isLinkedIn ? 'linkedin' : 'twitter');

    const id = generateId();
    const post = {
      id,
      profile_id: 'deep_personal',
      display_name: 'Deep – Personal',
      platform: actualPlatform,
      content,
      content_full: { tweet: content },
      pillar: topic || 'On Demand',
      format: isReels ? 'reels_script' : (isLinkedIn ? 'linkedin_post' : chosenStyle),
      created_at: new Date().toISOString(),
      status: 'pending'
    };
    fs.writeFileSync(path.join(pendDir, `${id}.json`), JSON.stringify(post, null, 2));

    sendNotification('New content generated', actualPlatform + ' post ready for review');

    res.json({ ok: true, id, content, platform: actualPlatform, style: chosenStyle });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    'Deep has 10 specific worldview points (see system prompt under "DEEP\'S SPECIFIC WORLDVIEW"). ' +
    'For each article, filter it through ONE of those worldview points to create the take.\n\n' +
    'For each article:\n' +
    '1. Score 1-10 for relevance to Deep\'s audience (US tech Twitter, AI builders, founders, Indian tech leaders)\n' +
    '2. Generate 2 BANGER takes. Not surface-level commentary. Use ONE of these frameworks per take:\n\n' +
    'FRAMEWORKS (pick the most interesting one for each take):\n' +
    '- HIDDEN WINNER: Who benefits from this that nobody is talking about?\n' +
    '- REAL THREAT: What is the actual danger the headline misses?\n' +
    '- CONTRADICTION: What does this article accidentally prove wrong about conventional wisdom?\n' +
    '- TIMELINE LIE: Is this happening faster or slower than people think? Why?\n' +
    '- MONEY TRAIL: Who is paying for this and what does that reveal?\n' +
    '- BUILDER ANGLE: If you were building a product on top of this news, what would you build?\n' +
    '- INDIA ANGLE: How does this play out completely differently in India vs the US?\n\n' +
    'Rules:\n' +
    '- Each take under 280 chars\n' +
    '- No emojis, no hashtags\n' +
    '- Spaced out with line breaks between sentences\n' +
    '- Must pass the AHA TEST: connect two things the reader hasn\'t connected before\n' +
    '- MUST weave in a specific story or experience, not just an opinion\n' +
    '- Target an emotion: anger at status quo, fear of being left behind, superiority for knowing this, or hope for the future\n' +
    '- NEVER write "X will replace Y" or "X is dead" — find the HIDDEN angle\n' +
    '- Be specific. Name companies, name numbers, name consequences.\n' +
    avoidList +
    '\nReturn ONLY valid JSON:\n{"articles":[{"index":1,"score":8,"takes":["take1","take2"]},...]}\n' +
    'Only include articles scoring 6 or above.';

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
      const articleData = {
        id,
        title: article.title || '',
        url: article.url || '',
        source: article.engine || article.parsed_url?.[1] || 'unknown',
        summary: (article.content || article.description || '').slice(0, 300),
        score: item.score,
        takes: item.takes || [],
        scouted_at: new Date().toISOString(),
        status: 'new'
      };
      fs.writeFileSync(path.join(artDir, id + '.json'), JSON.stringify(articleData, null, 2));
      saved++;
    }

    sendNotification('Article Scout: ' + saved + ' articles found', 'New articles with hot takes ready for review');

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

  const counts = {
    feed: articles.length,
    twitter: allPending.filter(p => p.platform === 'twitter').length + allPosts.filter(p => p.platform === 'twitter').length,
    linkedin: allPending.filter(p => p.platform === 'linkedin').length + allPosts.filter(p => p.platform === 'linkedin').length,
    reels: allPending.filter(p => p.platform === 'reels').length + allPosts.filter(p => p.platform === 'reels').length,
    approved: allPosts.length
  };
  const pendingCount = allPending.length;

  let tabPending = [], tabApproved = [];
  if (tab === 'feed') {
    // Feed tab shows articles
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

    return '<div class="article-card">'
      + '<div class="article-header">'
      + '<a href="' + esc(a.url) + '" target="_blank" class="article-title">' + esc(a.title) + '</a>'
      + '<div class="article-meta"><span class="tag">' + esc(a.source) + '</span><span class="tag tag-format">score ' + a.score + '</span></div>'
      + '</div>'
      + '<div class="article-summary">' + esc((a.summary || '').slice(0, 150)) + '</div>'
      + '<div class="article-takes">' + takesHtml + '</div>'
      + '<div class="article-custom">'
      + '<input type="text" class="gen-input" id="custom-' + a.id + '" placeholder="Write your own take..." onkeydown="if(event.key===\'Enter\')customTake(\'' + a.id + '\')" />'
      + '<button class="btn btn-tweet" onclick="customTake(\'' + a.id + '\')">Post</button>'
      + '<button class="btn btn-reject" onclick="skipArticle(\'' + a.id + '\')">Skip</button>'
      + '</div></div>';
  }

  let tabContent = '';
  if (tab === 'feed') {
    tabContent = '<div class="section" style="border-color:#334155;margin-bottom:12px">'
      + '<div class="section-header"><h2>Generate Insight</h2></div>'
      + '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px">'
      + '<input type="text" id="insightTopic" placeholder="Topic (optional)..." class="gen-input-sm" style="flex:2" />'
      + '<button class="gen-style" onclick="genInsight()">Generate Insight</button>'
      + '</div>'
      + '<div class="gen-status" id="insightStatus"></div>'
      + '<div style="font-size:10px;color:#555;margin-bottom:4px">Generates: tweet + thread + LinkedIn draft + Reels hook — all from one insight</div>'
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
  <a class="tab ${tab==='approved'?'active':''}" href="/dashboard?tab=approved">All<span class="cnt">${counts.approved}</span></a>
</div>

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
function approveAndLinkedIn(id){var c=getPostContent(id),e=document.getElementById('edit-'+id),ed=e&&e.style.display!=='none';fetch(ed?'/api/edit/'+id:'/api/approve/'+id,{method:'POST',headers:ed?{'Content-Type':'application/json'}:{},body:ed?JSON.stringify({content:c}):undefined}).then(function(){navigator.clipboard.writeText(c).then(function(){window.open('https://www.linkedin.com/feed/?shareActive=true&text='+encodeURIComponent(c),'_blank');setTimeout(function(){location.reload()},1000)})})}
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

// ── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Content Hub running on port ${PORT}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Multi-tenant mode: all data scoped to /data/tenants/{userId}/`);
});
