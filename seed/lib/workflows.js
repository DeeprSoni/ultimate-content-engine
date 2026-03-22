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
      responseMode: 'lastNode',
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
    trust_level: trustLevel
  }
}];
`;

// ── LLM call helper (Groq / Ollama) ─────────────────────────────────────────

function llmNode(id, name, systemExpr, userExpr, temperature, position) {
  return {
    id, name,
    type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position,
    continueOnFail: true,
    parameters: {
      method: 'POST',
      url: '={{ process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1/chat/completions" : "http://ollama:11434/v1/chat/completions" }}',
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'Authorization', value: '={{ process.env.GROQ_API_KEY ? "Bearer " + process.env.GROQ_API_KEY : "" }}' }
      ]},
      sendBody: true, specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ model: process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || "llama-3.3-70b-versatile") : (process.env.OLLAMA_MODEL || "qwen2.5:7b"), messages: [{ role: "system", content: ' + JSON.stringify(systemExpr) + ' }, { role: "user", content: ' + JSON.stringify(userExpr) + ' }], stream: false, temperature: ' + temperature + ' }) }}'
    }
  };
}

// ── Content Hub publish helper ───────────────────────────────────────────────

function contentHubPublishNode(id, name, position) {
  return {
    id, name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    continueOnFail: true,
    parameters: {
      method: 'POST',
      url: 'http://content-hub:3000/api/publish',
      sendBody: true,
      contentType: 'json',
      body: '={{ JSON.stringify({ profile_id: $json.profile_id, display_name: $json.display_name, platform: $json.primary_platform || $json.platform || "twitter", content: $json.content || $json.post_content, pillar: $json.pillar || $json.default_pillar, trend: $json.trend }) }}'
    }
  };
}

function contentHubPendingNode(id, name, position) {
  return {
    id, name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    continueOnFail: true,
    parameters: {
      method: 'POST',
      url: 'http://content-hub:3000/api/pending',
      sendBody: true,
      contentType: 'json',
      body: '={{ JSON.stringify({ profile_id: $json.profile_id, display_name: $json.display_name, platform: $json.primary_platform || $json.platform || "twitter", content: $json.content || $json.post_content, pillar: $json.pillar || $json.default_pillar, trend: $json.trend }) }}'
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

function buildMorningBrief() {
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
        url: 'http://searxng:8080/search',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Accept', value: 'application/json' }
        ]},
        sendQuery: true,
        queryParameters: { parameters: [
          { name: 'q', value: '={{ $json.trend_keywords.join(" OR ") }}' },
          { name: 'format', value: 'json' },
          { name: 'categories', value: 'news' },
          { name: 'time_range', value: 'day' }
        ]}
      }
    },
    // Score trends with Trend Researcher agent
    codeNode('score-trends', 'Score Trends', `
const items = $input.all();
const config = $('Load Config').first().json;
const news = items[0].json.results || [];

const systemPrompt = config.context_block + '\\n\\n' + config.agent_trend_researcher;
const userMsg = 'Score these news items 1-10 for relevance to ' + config.display_name + '\\n' +
  'Keywords: ' + config.trend_keywords.join(', ') + '\\n\\n' +
  'News: ' + JSON.stringify(news.slice(0,8).map(r => ({ title: r.title, description: r.content || r.description || '' }))) + '\\n\\n' +
  'Return ONLY valid JSON array: [{"topic":"string","score":number,"angle":"string"}]';

return [{ json: { ...config, news_for_scoring: userMsg, system_for_scoring: systemPrompt } }];
    `, [1060, 200]),
    // LLM scoring call (Groq or Ollama)
    {
      id: 'llm-score', name: 'LLM — Score Topics',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1280, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{ process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1/chat/completions" : "http://ollama:11434/v1/chat/completions" }}',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Authorization', value: '={{ process.env.GROQ_API_KEY ? "Bearer " + process.env.GROQ_API_KEY : "" }}' }
        ]},
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || "llama-3.3-70b-versatile") : (process.env.OLLAMA_MODEL || "qwen2.5:7b"), messages: [{ role: "system", content: $json.system_for_scoring || "" }, { role: "user", content: $json.news_for_scoring || "" }], stream: false, temperature: 0.2 }) }}'
      }
    },
    // Decide today's plan based on scores
    codeNode('decide-plan', 'Decide Today Plan', `
const fs = require('fs');
const config = $('Score Trends').first().json;
const llmRes = $input.first().json;

let topics = [];
try {
  const raw = llmRes.choices?.[0]?.message?.content || '[]';
  topics = JSON.parse(raw.replace(/\\\`\\\`\\\`json|\\\`\\\`\\\`/g, '').trim());
} catch(e) { topics = []; }

const sorted = [...topics].sort((a,b) => b.score - a.score);
const top = sorted[0];
const threshold = config.trend_threshold;
const opinionThreshold = config.opinion_threshold;

let plan = { type: 'default', pillar: config.default_pillar };
let brief = '';

if (top && top.score >= opinionThreshold) {
  plan = { type: 'opinion_requested', pillar: config.default_pillar, trend: top.topic, angle: top.angle, score: top.score };
  brief = '[' + config.display_name + '] Today: ' + config.default_pillar +
    '\\nBig trend: "' + top.topic + '" (score ' + top.score + '/10)' +
    '\\nAngle: ' + top.angle;
} else if (top && top.score >= threshold) {
  plan = { type: 'trend_angle', pillar: config.default_pillar, trend: top.topic, angle: top.angle, score: top.score };
  brief = '[' + config.display_name + '] Today: ' + config.default_pillar +
    '\\nTrend angle: "' + top.topic + '" (score ' + top.score + '/10)';
} else {
  brief = '[' + config.display_name + '] Today: ' + config.default_pillar +
    '\\nNo strong trends found. Default post at 7AM.';
}

fs.mkdirSync('/data/state', { recursive: true });
fs.writeFileSync('/data/state/today_plan_' + config.profile_id + '.json', JSON.stringify(plan));

// Log brief to state so dashboard can read it
fs.writeFileSync('/data/state/last_brief_' + config.profile_id + '.json', JSON.stringify({ brief, at: new Date().toISOString() }));

return [{ json: {
  brief,
  profile_id: config.profile_id
}}];
    `, [1500, 200])
  ];

  const connections = {
    'Cron 6AM — Personal': { main: [[{ node: 'Set Personal Profile', type: 'main', index: 0 }]] },
    'Cron 6AM — Company': { main: [[{ node: 'Set Company Profile', type: 'main', index: 0 }]] },
    'Set Personal Profile': { main: [[{ node: 'Load Config', type: 'main', index: 0 }]] },
    'Set Company Profile': { main: [[{ node: 'Load Config', type: 'main', index: 0 }]] },
    'Load Config': { main: [[{ node: 'Search Trends', type: 'main', index: 0 }]] },
    'Search Trends': { main: [[{ node: 'Score Trends', type: 'main', index: 0 }]] },
    'Score Trends': { main: [[{ node: 'LLM — Score Topics', type: 'main', index: 0 }]] },
    'LLM — Score Topics': { main: [[{ node: 'Decide Today Plan', type: 'main', index: 0 }]] }
  };

  return { name: '01 — Morning Brief', nodes, connections, settings: { executionOrder: 'v1' } };
}

function buildDailyGenerator() {
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

// Check for post_about override (immediate topic request)
try {
  const paFile = '/data/state/post_about_' + profileId + '.json';
  if (fs.existsSync(paFile)) {
    const pa = JSON.parse(fs.readFileSync(paFile, 'utf8'));
    override = { type: 'post_about', text: pa.topic };
    fs.unlinkSync(paFile); // consume
  }
} catch(e) {}

return [{ json: { ...config, plan, override } }];
    `, [840, 200]),
    // Build Generation Prompt with format library
    codeNode('build-prompt', 'Build Generation Prompt', `
const d = $input.first().json;
const { plan, override } = d;

// Layer 1: Read past decisions to learn what works
const fs = require('fs');
let formatWinRates = {};
try {
  const decDir = '/data/decisions';
  if (fs.existsSync(decDir)) {
    const decFiles = fs.readdirSync(decDir).filter(f => f.endsWith('.json'));
    const stats = {};
    for (const f of decFiles) {
      try {
        const dec = JSON.parse(fs.readFileSync(decDir + '/' + f, 'utf8'));
        const fmt = (dec.format || '').toLowerCase();
        if (!fmt) continue;
        if (!stats[fmt]) stats[fmt] = { approved: 0, rejected: 0 };
        if (dec.type === 'approved' || dec.type === 'edited') stats[fmt].approved++;
        else if (dec.type === 'rejected') stats[fmt].rejected++;
      } catch(e) {}
    }
    formatWinRates = stats;
  }
} catch(e) {}

// Bias style selection toward formats that get approved
function getStyleWeight(name) {
  const n = name.toLowerCase();
  for (const [fmt, s] of Object.entries(formatWinRates)) {
    if (fmt.includes(n) || n.includes(fmt)) {
      const total = s.approved + s.rejected;
      if (total < 3) return 1; // not enough data
      return s.approved / total > 0.5 ? 2 : 0.3; // boost winners, suppress losers
    }
  }
  return 1; // no data, neutral weight
}

const STYLES = [
  { name: 'raw_take', instruction: 'Write a raw, unfiltered thought. 1-3 short lines. Use line breaks for emphasis. No structure. Just conviction. Like texting a thought to a friend.' },
  { name: 'contrarian', instruction: 'Disagree with something everyone accepts. State the popular view, then destroy it in one line. Be specific about WHY they are wrong.' },
  { name: 'prediction', instruction: 'Make a bold prediction about the future. State it as fact, not speculation. Short. Inevitable tone.' },
  { name: 'provocation', instruction: 'Say something that will make people angry or make them think. Controversial. The kind of tweet people quote-tweet to argue with.' },
  { name: 'one_liner', instruction: 'One sentence. Under 100 characters. A standalone punch. The kind of thing people screenshot.' },
  { name: 'observation', instruction: 'Point out a pattern nobody is talking about. 2-3 lines max. End with the implication, not the explanation.' },
  { name: 'question', instruction: 'Ask a provocative question that implies a strong opinion. No answer needed. Let people fill in the blank.' },
  { name: 'declaration', instruction: 'State a position with zero nuance. Like a manifesto line. Absolute conviction. No room for maybe.' }
];

// Weight styles by past approval rates AND enforce diversity
const weighted = STYLES.map(s => ({ ...s, weight: getStyleWeight(s.name) }));
const sorted = weighted.sort((a, b) => (b.weight * Math.random()) - (a.weight * Math.random()));
const picked = sorted.slice(0, 3);

// Assign each variation a DIFFERENT worldview point for diversity
const WORLDVIEWS = ['HUSTLE IS A SCAM', 'AGENT-ONLY INTERNET', 'AI WRAPPERS TEMPORARY', 'VC IS NOT THE GOAL', 'CREATORS REPLACED', 'OPEN SOURCE WINS', 'PLAYING FIELD LEVELING', 'ADAPTABILITY', 'EVERYONE IS NPC', 'JOBS ARE OVER'];
const shuffledWV = [...WORLDVIEWS].sort(() => Math.random() - 0.5);

let topicInstruction = '';
if (override?.type === 'post_about') {
  topicInstruction = 'SPECIFIC ANGLE: Write about "' + override.text + '". Find a sharp, non-obvious take on this.';
} else if (override?.type === 'opinion') {
  topicInstruction = 'SPECIFIC ANGLE: Use this opinion as the core — "' + override.text + '"\\nTrend context: "' + (plan.trend || '') + '"\\nDont just restate the opinion. Add a WHY that nobody is talking about.';
} else if (plan.type === 'trend_angle' || plan.type === 'opinion_requested') {
  topicInstruction = 'SPECIFIC ANGLE: "' + plan.trend + '" is trending.\\nAngle: ' + plan.angle + '\\nPillar: ' + plan.pillar + '\\nDont just comment on the trend. Find the second-order implication that nobody else sees.';
} else {
  topicInstruction = 'SPECIFIC ANGLE: Today\\'s pillar is ' + plan.pillar + '.\\nDont write generic advice about ' + plan.pillar + '. Instead, find ONE specific insight from Deep\\'s real experience (see IDENTITY in system prompt) and build each tweet around that concrete detail.';
}

// Load recent approved tweets to avoid repetition
let recentTweets = [];
try {
  const pubDir = '/data/published';
  if (fs.existsSync(pubDir)) {
    recentTweets = fs.readdirSync(pubDir)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(fs.readFileSync(pubDir + '/' + f, 'utf8')); } catch { return null; } })
      .filter(p => p && p.platform === 'twitter')
      .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0))
      .slice(0, 15)
      .map(p => p.content);
  }
} catch(e) {}

const antiRepeat = recentTweets.length > 0
  ? '\\n\\nALREADY POSTED (never repeat these ideas or angles):\\n' + recentTweets.map((t, i) => (i+1) + '. ' + t.slice(0, 80)).join('\\n') + '\\nFind something COMPLETELY DIFFERENT from all of the above.'
  : '';

const userMsg = topicInstruction + '\\n\\n' +
  'Write 3 tweets. Each a different style:\\n\\n' +
  picked.map((s, i) => (i+1) + '. ' + s.name.toUpperCase() + ' [WORLDVIEW: ' + shuffledWV[i] + ']: ' + s.instruction + ' Ground it in the worldview point assigned.').join('\\n') +
  '\\n\\nUSE ONE FRAMEWORK per tweet (pick the most interesting):\\n' +
  '- HIDDEN WINNER: Who benefits that nobody is talking about?\\n' +
  '- CONTRADICTION: What does conventional wisdom get wrong here?\\n' +
  '- BUILDER ANGLE: What would you build on top of this?\\n' +
  '- TIMELINE LIE: Is this happening faster or slower than people think?\\n' +
  '- INDIA ANGLE: How is this different in India vs the US?\\n' +
  '- MONEY TRAIL: Who is paying for this and what does that reveal?\\n\\n' +
  'CRITICAL RULES:\\n' +
  '- Study the REAL TWEETS in the system prompt. Match that exact energy.\\n' +
  '- Raw > polished. Thoughts > templates. Conviction > structure.\\n' +
  '- Under 280 chars each. SPACE OUT sentences with blank lines.\\n' +
  '- No emojis. No hashtags. No "I think." No sugar coating.\\n' +
  '- NEVER make up specific numbers. Use directional language.\\n' +
  '- NEVER write "X will replace Y" or "X is dead" — those takes are done.\\n' +
  '- MINIMUM 60 chars. AHA TEST: connect two things the reader hasn\\'t connected before.\\n' +
  '- Each tweet MUST include a specific story or experience from the IDENTITY section. Not just an opinion.\\n' +
  '- Target a DIFFERENT emotion per tweet: one anger, one superiority, one fear or hope.\\n' +
  '- Study the BANGER EXAMPLES in the system prompt. Match that quality level.\\n' +
  '- Target: US tech Twitter — founders, AI builders, engineers.\\n' +
  antiRepeat + '\\n\\n' +
  'Return ONLY valid JSON:\\n{"variations":[{"tweet":"...","style":"..."},{"tweet":"...","style":"..."},{"tweet":"...","style":"..."}]}';

return [{ json: {
  ...d,
  system_prompt: d.context_block + '\\n\\nYou ARE Deep. Not writing for him — you ARE him. Match the real tweets above exactly. Raw, short, controversial.',
  user_message: userMsg,
  picked_styles: picked.map(s => s.name)
}}];
    `, [1060, 200]),
    // LLM generation (Groq or Ollama)
    {
      id: 'llm-generate', name: 'Generate Content',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1280, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{ process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1/chat/completions" : "http://ollama:11434/v1/chat/completions" }}',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Authorization', value: '={{ process.env.GROQ_API_KEY ? "Bearer " + process.env.GROQ_API_KEY : "" }}' }
        ]},
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || "llama-3.3-70b-versatile") : (process.env.OLLAMA_MODEL || "qwen2.5:7b"), messages: [{ role: "system", content: $json.system_prompt || "" }, { role: "user", content: $json.user_message || "" }], stream: false, temperature: 0.75 }) }}'
      }
    },
    // Parse 3 variations
    codeNode('parse-content', 'Parse Generated Content', `
const llmRes = $input.first().json;
const config = $('Load Today Plan').first().json;

const raw = llmRes.choices?.[0]?.message?.content || '{}';
let parsed;
try {
  parsed = JSON.parse(raw.replace(/\\\`\\\`\\\`json|\\\`\\\`\\\`/g, '').trim());
} catch(e) {
  // Fallback: treat entire response as a single tweet
  parsed = { variations: [{ tweet: raw.slice(0, 280), format: 'raw', linkedin_draft: raw.slice(0, 700) }] };
}

const variations = parsed.variations || [parsed];

// Return all variations as separate items
return variations.map(v => ({
  json: {
    ...config,
    content: v,
    tweet: v.tweet || '',
    format_used: v.style || v.format || 'unknown',
    linkedin_draft: v.linkedin_draft || ''
  }
}));
    `, [1500, 200]),
    // Layer 2: Quality gate — filter out low-quality tweets
    codeNode('quality-gate', 'Quality Gate', `
const items = $input.all();
const filtered = items.filter(item => {
  const tweet = item.json.tweet || '';

  // Reject if too short
  if (tweet.length < 60) return false;

  // Reject if it's just a vague declaration without substance
  const vaguePatterns = [
    /^\\w+ is dead$/i,
    /^\\w+ is coming$/i,
    /^\\w+ will (die|fail|win|replace|destroy)$/i,
    /^the future (is|of)/i,
    /^everyone should/i
  ];
  for (const p of vaguePatterns) {
    if (p.test(tweet.trim())) return false;
  }

  // Reject if it contains fabricated-sounding specific stats
  if (/\\d{2,3}%/.test(tweet) && !tweet.includes('my ') && !tweet.includes('our ') && !tweet.includes('I ')) {
    return false; // specific percentage without first-person = likely fabricated
  }

  // Reject if it sounds like AI slop
  const slopPhrases = ['it seems like', 'json (javascript', 'provide more context', 'in conclusion', 'game-changer', 'revolutionary'];
  for (const phrase of slopPhrases) {
    if (tweet.toLowerCase().includes(phrase)) return false;
  }

  return true;
});

// If all filtered out, keep at least the longest one
if (filtered.length === 0 && items.length > 0) {
  const longest = items.sort((a, b) => (b.json.tweet || '').length - (a.json.tweet || '').length)[0];
  return [longest];
}

return filtered;
    `, [1600, 200]),
    // Save all variations to Content Hub as pending
    codeNode('save-variations', 'Save All Variations', `
const http = require('http');
const items = $input.all();

function postToHub(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: 'content-hub', port: 3000, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const results = [];
for (const item of items) {
  const d = item.json;
  const res = await postToHub('/api/pending', {
    profile_id: d.profile_id,
    display_name: d.display_name,
    platform: d.primary_platform || 'twitter',
    content: { tweet: d.tweet, linkedin_draft: d.linkedin_draft },
    pillar: d.default_pillar,
    trend: d.plan?.trend,
    format: d.format_used
  });
  results.push(JSON.parse(res));
}

return [{ json: { saved: results.length, variations: results } }];
    `, [1720, 200]),
    // Build LinkedIn prompt from best tweet
    codeNode('build-linkedin-prompt', 'Build LinkedIn Prompt', `
const config = $('Load Today Plan').first().json;
const twitterItems = $input.all();
const bestTweet = twitterItems[0]?.json?.tweet || '';

const userMsg = 'Write a LinkedIn post for ' + config.display_name + '.\\n\\n' +
  'Base topic/angle (from today\\'s Twitter content): "' + bestTweet + '"\\n\\n' +
  'LinkedIn post rules:\\n' +
  '- 300-500 words. Professional but opinionated. NOT corporate LinkedIn slop.\\n' +
  '- First 2 lines are the HOOK — must make people click "see more"\\n' +
  '- Use line breaks between paragraphs for readability\\n' +
  '- Share specific results, numbers, lessons learned\\n' +
  '- End with a question or CTA to drive comments\\n' +
  '- Target audience: Indian tech leaders, founders, business owners\\n' +
  '- Tone: thought leader sharing battle-tested insights, not advice-giver\\n' +
  '- Can use minimal emojis as bullet markers (→ or •) but not excessively\\n\\n' +
  'Return ONLY the LinkedIn post text. No JSON wrapping.';

return [{ json: {
  ...config,
  linkedin_system: config.context_block + '\\n\\nYou are writing a LinkedIn post as Deep. Professional but still direct and opinionated. Target: Indian business audience.',
  linkedin_user: userMsg,
  source_tweet: bestTweet
}}];
    `, [1940, 200]),
    // Generate LinkedIn post via LLM (inline — llmNode helper can't pass n8n expressions for system/user)
    {
      id: 'llm-linkedin-gen', name: 'Generate LinkedIn Post',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [2160, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{ process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1/chat/completions" : "http://ollama:11434/v1/chat/completions" }}',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Authorization', value: '={{ process.env.GROQ_API_KEY ? "Bearer " + process.env.GROQ_API_KEY : "" }}' }
        ]},
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || "llama-3.3-70b-versatile") : (process.env.OLLAMA_MODEL || "qwen2.5:7b"), messages: [{ role: "system", content: $json.linkedin_system || "" }, { role: "user", content: $json.linkedin_user || "" }], stream: false, temperature: 0.7 }) }}'
      }
    },
    // Save LinkedIn post to Content Hub
    codeNode('save-linkedin', 'Save LinkedIn Post', `
const http = require('http');
const config = $('Build LinkedIn Prompt').first().json;
const linkedinContent = $input.first().json.choices?.[0]?.message?.content || '';

if (!linkedinContent) return [{ json: { saved: false } }];

function postToHub(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: 'content-hub', port: 3000, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const res = await postToHub('/api/pending', {
  profile_id: config.profile_id,
  display_name: config.display_name,
  platform: 'linkedin',
  content: linkedinContent,
  pillar: config.default_pillar,
  trend: config.plan?.trend,
  format: 'linkedin_post'
});

return [{ json: { saved: true, result: JSON.parse(res) } }];
    `, [2380, 200]),
    // Build Reels prompt from best tweet
    codeNode('build-reels-prompt', 'Build Reels Prompt', `
const config = $('Load Today Plan').first().json;
const items = $('Parse Generated Content').all();
const bestTweet = items[0]?.json?.tweet || '';

const userMsg = 'Create a 30-60 second Instagram Reels script for ' + config.display_name + '.\\n\\n' +
  'Topic (from today\\'s content): "' + bestTweet + '"\\n\\n' +
  'Script format rules:\\n' +
  '- HOOK (first 3 seconds): One punchy line that stops the scroll. This is the most important part.\\n' +
  '- BODY (20-45 seconds): 3-4 short beats. Each beat is 1-2 sentences spoken to camera.\\n' +
  '- CTA (last 5 seconds): Tell viewer what to do — follow, comment, share.\\n' +
  '- Total: 30-60 seconds when read aloud at normal pace.\\n' +
  '- Voice: Direct, raw, like talking to a friend. NOT scripted-sounding.\\n' +
  '- Include visual direction for each beat (what should be on screen).\\n' +
  '- Target: Tech founders, AI builders, young entrepreneurs.\\n\\n' +
  'Return ONLY valid JSON:\\n{"hook":"...","beats":[{"voiceover":"...","visual":"...","duration":"Xs"}],"cta":"...","music_mood":"...","total_duration":"Xs"}';

return [{ json: {
  ...config,
  reels_system: config.context_block + '\\n\\nYou are scripting a short-form video for Deep. Raw, direct, talking-head style. Not polished — authentic.',
  reels_user: userMsg,
  source_tweet: bestTweet
}}];
    `, [2600, 200]),
    // Generate Reels script via LLM (inline — llmNode helper can't pass n8n expressions)
    {
      id: 'llm-reels-gen', name: 'Generate Reels Script',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [2820, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{ process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1/chat/completions" : "http://ollama:11434/v1/chat/completions" }}',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Authorization', value: '={{ process.env.GROQ_API_KEY ? "Bearer " + process.env.GROQ_API_KEY : "" }}' }
        ]},
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || "llama-3.3-70b-versatile") : (process.env.OLLAMA_MODEL || "qwen2.5:7b"), messages: [{ role: "system", content: $json.reels_system || "" }, { role: "user", content: $json.reels_user || "" }], stream: false, temperature: 0.75 }) }}'
      }
    },
    // Save Reels script to Content Hub
    codeNode('save-reels', 'Save Reels Script', `
const http = require('http');
const config = $('Build Reels Prompt').first().json;
const raw = $input.first().json.choices?.[0]?.message?.content || '';

let script;
try {
  script = JSON.parse(raw.replace(/\\\`\\\`\\\`json|\\\`\\\`\\\`/g, '').trim());
} catch(e) {
  script = { hook: raw.slice(0, 200), beats: [], cta: '', error: 'Failed to parse script' };
}

// Format as readable text for the dashboard
const readable = 'HOOK: ' + (script.hook || '') + '\\n\\n' +
  (script.beats || []).map((b, i) => 'BEAT ' + (i+1) + ' (' + (b.duration || '?') + '):\\n' + (b.voiceover || '') + '\\nVISUAL: ' + (b.visual || '')).join('\\n\\n') +
  '\\n\\nCTA: ' + (script.cta || '') +
  '\\n\\nMOOD: ' + (script.music_mood || 'energetic') +
  '\\nTOTAL: ' + (script.total_duration || '30-60s');

function postToHub(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: 'content-hub', port: 3000, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const res = await postToHub('/api/pending', {
  profile_id: config.profile_id,
  display_name: config.display_name,
  platform: 'reels',
  content: readable,
  pillar: config.default_pillar,
  trend: config.plan?.trend,
  format: 'reels_script'
});

return [{ json: { saved: true, script, result: JSON.parse(res) } }];
    `, [3040, 200])
  ];

  const connections = {
    'Cron 7AM — Personal': { main: [[{ node: 'Set Personal Profile', type: 'main', index: 0 }]] },
    'Cron 7AM — Company': { main: [[{ node: 'Set Company Profile', type: 'main', index: 0 }]] },
    'Set Personal Profile': { main: [[{ node: 'Load Config', type: 'main', index: 0 }]] },
    'Set Company Profile': { main: [[{ node: 'Load Config', type: 'main', index: 0 }]] },
    'Load Config': { main: [[{ node: 'Load Today Plan', type: 'main', index: 0 }]] },
    'Load Today Plan': { main: [[{ node: 'Build Generation Prompt', type: 'main', index: 0 }]] },
    'Build Generation Prompt': { main: [[{ node: 'Generate Content', type: 'main', index: 0 }]] },
    'Generate Content': { main: [[{ node: 'Parse Generated Content', type: 'main', index: 0 }]] },
    'Parse Generated Content': { main: [[{ node: 'Quality Gate', type: 'main', index: 0 }]] },
    'Quality Gate': { main: [[{ node: 'Save All Variations', type: 'main', index: 0 }]] },
    'Save All Variations': { main: [[{ node: 'Build LinkedIn Prompt', type: 'main', index: 0 }]] },
    'Build LinkedIn Prompt': { main: [[{ node: 'Generate LinkedIn Post', type: 'main', index: 0 }]] },
    'Generate LinkedIn Post': { main: [[{ node: 'Save LinkedIn Post', type: 'main', index: 0 }]] },
    'Save LinkedIn Post': { main: [[{ node: 'Build Reels Prompt', type: 'main', index: 0 }]] },
    'Build Reels Prompt': { main: [[{ node: 'Generate Reels Script', type: 'main', index: 0 }]] },
    'Generate Reels Script': { main: [[{ node: 'Save Reels Script', type: 'main', index: 0 }]] }
  };

  return { name: '02 — Daily Generator', nodes, connections, settings: { executionOrder: 'v1' } };
}

function buildRepurposer() {
  const nodes = [
    webhookNode('webhook-in', 'Webhook — Repurpose', 'repurposer', [200, 300]),
    codeNode('parse-input', 'Parse Input', `
const body = $input.first().json.body || $input.first().json;
return [{ json: typeof body === 'string' ? JSON.parse(body) : body }];
    `, [420, 300]),
    // Refine for LinkedIn (Groq or Ollama)
    {
      id: 'llm-linkedin', name: 'Refine LinkedIn',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [640, 180],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{ process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1/chat/completions" : "http://ollama:11434/v1/chat/completions" }}',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Authorization', value: '={{ process.env.GROQ_API_KEY ? "Bearer " + process.env.GROQ_API_KEY : "" }}' }
        ]},
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || "llama-3.3-70b-versatile") : (process.env.OLLAMA_MODEL || "qwen2.5:7b"), messages: [{ role: "system", content: ($json.context_block || "") + " AGENT: " + ($json.agent_content_creator || "") }, { role: "user", content: "Adapt for LinkedIn: professional tone, 100-150 words, industry insight, CTA to follow. Return only the post text. Original tweet: " + ($json.tweet || "") + " Draft: " + ($json.linkedin_draft || "") }], stream: false, temperature: 0.6 }) }}'
      }
    },
    // Refine for Threads (Groq or Ollama)
    {
      id: 'llm-threads', name: 'Refine Threads',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [640, 420],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{ process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1/chat/completions" : "http://ollama:11434/v1/chat/completions" }}',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Authorization', value: '={{ process.env.GROQ_API_KEY ? "Bearer " + process.env.GROQ_API_KEY : "" }}' }
        ]},
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || "llama-3.3-70b-versatile") : (process.env.OLLAMA_MODEL || "qwen2.5:7b"), messages: [{ role: "system", content: ($json.context_block || "") + " AGENT: " + ($json.agent_content_creator || "") }, { role: "user", content: "Adapt for Threads: casual, under 300 chars, same energy as tweet, no hashtags. Return only post text. Tweet: " + ($json.tweet || "") }], stream: false, temperature: 0.7 }) }}'
      }
    },
    // Publish LinkedIn version to Content Hub
    codeNode('prep-linkedin', 'Prep LinkedIn Post', `
const input = $('Parse Input').first().json;
const refined = $input.first().json.choices?.[0]?.message?.content || input.linkedin_draft || '';
return [{ json: {
  profile_id: input.profile_id,
  display_name: input.display_name || input.profile_id,
  platform: 'linkedin',
  content: refined,
  pillar: input.pillar
}}];
    `, [880, 180]),
    codeNode('prep-threads', 'Prep Threads Post', `
const input = $('Parse Input').first().json;
const refined = $input.first().json.choices?.[0]?.message?.content || input.tweet || '';
return [{ json: {
  profile_id: input.profile_id,
  display_name: input.display_name || input.profile_id,
  platform: 'threads',
  content: refined,
  pillar: input.pillar
}}];
    `, [880, 420]),
    // Post to Content Hub
    {
      id: 'post-linkedin', name: 'Publish LinkedIn',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1100, 180],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: 'http://content-hub:3000/api/publish',
        sendBody: true, contentType: 'json',
        body: '={{ JSON.stringify({ profile_id: $json.profile_id, display_name: $json.display_name, platform: $json.platform, content: $json.content, pillar: $json.pillar }) }}'
      }
    },
    {
      id: 'post-threads', name: 'Publish Threads',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1100, 420],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: 'http://content-hub:3000/api/publish',
        sendBody: true, contentType: 'json',
        body: '={{ JSON.stringify({ profile_id: $json.profile_id, display_name: $json.display_name, platform: $json.platform, content: $json.content, pillar: $json.pillar }) }}'
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
    'Refine LinkedIn': { main: [[{ node: 'Prep LinkedIn Post', type: 'main', index: 0 }]] },
    'Refine Threads': { main: [[{ node: 'Prep Threads Post', type: 'main', index: 0 }]] },
    'Prep LinkedIn Post': { main: [[{ node: 'Publish LinkedIn', type: 'main', index: 0 }]] },
    'Prep Threads Post': { main: [[{ node: 'Publish Threads', type: 'main', index: 0 }]] }
  };

  return { name: '03 — Repurposer', nodes, connections, settings: { executionOrder: 'v1' } };
}

function buildTrendReactor() {
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
        url: 'http://searxng:8080/search',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Accept', value: 'application/json' }
        ]},
        sendQuery: true,
        queryParameters: { parameters: [
          { name: 'q', value: '={{ $json.trend_keywords.join(" OR ") }}' },
          { name: 'format', value: 'json' },
          { name: 'categories', value: 'news' },
          { name: 'time_range', value: 'day' }
        ]}
      }
    },
    // Score (Groq or Ollama)
    {
      id: 'llm-score', name: 'Score Relevance',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [860, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{ process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1/chat/completions" : "http://ollama:11434/v1/chat/completions" }}',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Authorization', value: '={{ process.env.GROQ_API_KEY ? "Bearer " + process.env.GROQ_API_KEY : "" }}' }
        ]},
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || "llama-3.3-70b-versatile") : (process.env.OLLAMA_MODEL || "qwen2.5:7b"), messages: [{ role: "system", content: $json.agent_trend_researcher || "" }, { role: "user", content: "Score news 1-10 for " + ($json.display_name || "") + ". Keywords: " + ($json.trend_keywords || []).join(", ") + " --- News: " + JSON.stringify(($json.results || []).slice(0,6).map(function(r){return {title:r.title}})) + " --- Return ONLY valid JSON object: {topic:string, score:number, angle:string}" }], stream: false, temperature: 0.2 }) }}'
      }
    },
    codeNode('parse-score', 'Parse Score', `
const llmRes = $input.first().json;
// We need to get the profile data from the search step
const profileData = $('Search Trends').first().json;

let scored = { topic: '', score: 0, angle: '' };
try {
  const raw = llmRes.choices?.[0]?.message?.content || '{}';
  scored = JSON.parse(raw.replace(/\\\`\\\`\\\`json|\\\`\\\`\\\`/g, '').trim());
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
    // Auto-generate trend post (Groq or Ollama)
    {
      id: 'llm-hot-take', name: 'Auto Generate Hot Take',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1520, 100],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{ process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1/chat/completions" : "http://ollama:11434/v1/chat/completions" }}',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Authorization', value: '={{ process.env.GROQ_API_KEY ? "Bearer " + process.env.GROQ_API_KEY : "" }}' }
        ]},
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || "llama-3.3-70b-versatile") : (process.env.OLLAMA_MODEL || "qwen2.5:7b"), messages: [{ role: "system", content: ($json.context_block || "") + " AGENT: " + ($json.agent_twitter_engager || "") }, { role: "user", content: "Write a hot take tweet about: " + ($json.topic || "") + ". Angle: " + ($json.angle || "") + ".\\nRules: Under 240 chars. No emojis, no hashtags. State opinion as fact.\\nMatch the voice of the system prompt exactly.\\nReturn only the tweet text, nothing else." }], stream: false, temperature: 0.85 }) }}'
      }
    },
    // Send trend post to pending (user picks from dashboard)
    codeNode('prep-trend-post', 'Prep Trend Post', `
const profileData = $('Parse Score').first().json;
const content = $input.first().json.choices?.[0]?.message?.content || '';
return [{ json: {
  profile_id: profileData.id,
  display_name: profileData.display_name,
  platform: profileData.primary_platform || 'twitter',
  content: { tweet: content },
  pillar: 'Trend React',
  trend: profileData.topic,
  format: 'hot_take'
}}];
    `, [1740, 100]),
    {
      id: 'save-trend-pending', name: 'Save Trend to Pending',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1960, 100],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: 'http://content-hub:3000/api/pending',
        sendBody: true, contentType: 'json',
        body: '={{ JSON.stringify({ profile_id: $json.profile_id, display_name: $json.display_name, platform: $json.platform, content: $json.content, pillar: $json.pillar, trend: $json.trend, format: $json.format }) }}'
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
        [{ node: 'Auto Generate Hot Take', type: 'main', index: 0 }],
        []
      ]
    },
    'Auto Generate Hot Take': { main: [[{ node: 'Prep Trend Post', type: 'main', index: 0 }]] },
    'Prep Trend Post': { main: [[{ node: 'Save Trend to Pending', type: 'main', index: 0 }]] }
  };

  return { name: '04 — Trend Reactor', nodes, connections, settings: { executionOrder: 'v1' } };
}

function buildAnalyticsLoop() {
  const nodes = [
    cronNode('cron-sunday', 'Cron Sunday 6PM IST', '30 12 * * 0', [200, 300]),
    codeNode('load-profiles', 'Load Profiles', `
const fs = require('fs');
return ['deep_personal', 'intrkt_company'].map(id => {
  const p = JSON.parse(fs.readFileSync('/data/profiles/' + id + '.json', 'utf8'));
  const agent = fs.existsSync('/data/agents/growth-hacker.txt')
    ? fs.readFileSync('/data/agents/growth-hacker.txt', 'utf8') : '';
  return { json: { ...p, agent_growth_hacker: agent } };
});
    `, [420, 300]),
    // Fetch posts from Content Hub
    {
      id: 'fetch-analytics', name: 'Fetch Content Hub Posts',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [640, 300],
      continueOnFail: true,
      parameters: {
        method: 'GET',
        url: 'http://content-hub:3000/api/posts?limit=20'
      }
    },
    // Analyse with Growth Hacker (Groq or Ollama)
    {
      id: 'llm-analyse', name: 'Analyse with Growth Hacker',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [860, 300],
      continueOnFail: true,
      parameters: {
        method: 'POST',
        url: '={{ process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1/chat/completions" : "http://ollama:11434/v1/chat/completions" }}',
        sendHeaders: true,
        headerParameters: { parameters: [
          { name: 'Authorization', value: '={{ process.env.GROQ_API_KEY ? "Bearer " + process.env.GROQ_API_KEY : "" }}' }
        ]},
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.GROQ_API_KEY ? (process.env.GROQ_MODEL || "llama-3.3-70b-versatile") : (process.env.OLLAMA_MODEL || "qwen2.5:7b"), messages: [{ role: "system", content: $("Load Profiles").first().json.agent_growth_hacker || "" }, { role: "user", content: "Analyse this week for " + ($("Load Profiles").first().json.display_name || "") + ". Posts: " + JSON.stringify(($json.data || []).slice(0,15)) + " Return JSON: {what_worked:string, avoid:string, next_week:string, summary:string}" }], stream: false, temperature: 0.3 }) }}'
      }
    },
    codeNode('save-learnings', 'Save Learnings', `
const fs = require('fs');
const profileId = $('Load Profiles').first().json.id;
const raw = $input.first().json.choices?.[0]?.message?.content || '{}';

let analysis = {};
try { analysis = JSON.parse(raw.replace(/\\\`\\\`\\\`json|\\\`\\\`\\\`/g, '').trim()); } catch(e) {}

const learnFile = '/data/learnings/' + profileId + '.json';
fs.mkdirSync('/data/learnings', { recursive: true });
let history = [];
try { history = JSON.parse(fs.readFileSync(learnFile, 'utf8')); } catch(e) {}
history.push({ week: new Date().toISOString().slice(0,10), ...analysis });
fs.writeFileSync(learnFile, JSON.stringify(history.slice(-16), null, 2));

const digest = '[' + $('Load Profiles').first().json.display_name + '] Week of ' + new Date().toISOString().slice(0,10) +
  '\\n\\nWhat worked: ' + (analysis.what_worked || 'N/A') +
  '\\nAvoid: ' + (analysis.avoid || 'N/A') +
  '\\nNext week: ' + (analysis.next_week || 'N/A') +
  '\\n\\n' + (analysis.summary || '');

// Save digest to state so dashboard can read it
fs.mkdirSync('/data/state', { recursive: true });
fs.writeFileSync('/data/state/last_digest_' + profileId + '.json', JSON.stringify({ digest, at: new Date().toISOString() }));

return [{ json: { digest } }];
    `, [1080, 300])
  ];

  const connections = {
    'Cron Sunday 6PM IST': { main: [[{ node: 'Load Profiles', type: 'main', index: 0 }]] },
    'Load Profiles': { main: [[{ node: 'Fetch Content Hub Posts', type: 'main', index: 0 }]] },
    'Fetch Content Hub Posts': { main: [[{ node: 'Analyse with Growth Hacker', type: 'main', index: 0 }]] },
    'Analyse with Growth Hacker': { main: [[{ node: 'Save Learnings', type: 'main', index: 0 }]] }
  };

  return { name: '05 — Analytics Loop', nodes, connections, settings: { executionOrder: 'v1' } };
}

function buildCommandHandler() {
  const nodes = [
    webhookNode('webhook-cmd', 'Webhook — Commands', 'intrkt-commands', [200, 400]),
    codeNode('parse-and-handle', 'Parse & Handle Command', `
const fs = require('fs');
const body = $input.first().json.body || $input.first().json;
const raw = (body.text || body.cmd || body.message || '').trim();
const lower = raw.toLowerCase();

const isCompany = lower.includes('[intrkt]');
const profile_id = isCompany ? 'intrkt_company' : 'deep_personal';
const text = lower.replace('[intrkt]', '').trim();
const rawText = raw.replace(/\\[intrkt\\]/gi, '').trim();

fs.mkdirSync('/data/state', { recursive: true });
let ack = 'Unknown command. Try: approve, skip, edit, pause, resume, stats, trust, post about [topic]';

if (text === 'yes' || text === 'approve') {
  fs.writeFileSync('/data/state/approval_' + profile_id + '.json', JSON.stringify({ action: 'approve' }));
  ack = 'Approved — posting now.';
} else if (text === 'no' || text === 'skip') {
  fs.writeFileSync('/data/state/approval_' + profile_id + '.json', JSON.stringify({ action: 'skip' }));
  ack = 'Skipped — no post today for ' + profile_id + '.';
} else if (text.startsWith('edit ')) {
  const editText = rawText.replace(/^edit /i, '');
  fs.writeFileSync('/data/state/approval_' + profile_id + '.json', JSON.stringify({ action: 'edit', text: editText }));
  ack = 'Got it — posting your version.';
} else if (text.startsWith('trust ')) {
  const level = parseInt(text.match(/trust (\\d)/)?.[1] || '1');
  fs.writeFileSync('/data/state/trust_' + profile_id + '.json', JSON.stringify({ trust_level: level }));
  ack = 'Trust level set to ' + level + ' for ' + profile_id + '.';
} else if (text === 'pause') {
  fs.writeFileSync('/data/state/paused.json', JSON.stringify({ paused: true, at: new Date().toISOString() }));
  ack = 'Machine paused. Send RESUME to restart.';
} else if (text === 'resume') {
  try { fs.unlinkSync('/data/state/paused.json'); } catch(e) {}
  ack = 'Machine resumed.';
} else if (text === 'stats') {
  // Fetch stats from Content Hub
  ack = 'Stats: System running. Check Content Hub dashboard for analytics.';
} else if (text.startsWith('post about ')) {
  const topic = rawText.replace(/^post about /i, '');
  fs.writeFileSync('/data/state/post_about_' + profile_id + '.json', JSON.stringify({ topic, at: new Date().toISOString() }));
  ack = 'Got it — generating a post about "' + topic + '" now.';
} else if (text === 'change') {
  const planFile = '/data/state/today_plan_' + profile_id + '.json';
  let plan = {};
  try { plan = JSON.parse(fs.readFileSync(planFile, 'utf8')); } catch(e) {}
  plan.operator_change = true;
  fs.writeFileSync(planFile, JSON.stringify(plan));
  ack = 'Calendar switched to trend topic for ' + profile_id + '.';
} else {
  fs.writeFileSync('/data/state/override_' + profile_id + '.json', JSON.stringify({ type: 'opinion', text: rawText }));
  ack = 'Got your take — will use it for next post.';
}

return [{ json: { ack } }];
    `, [500, 400])
  ];

  const connections = {
    'Webhook — Commands': { main: [[{ node: 'Parse & Handle Command', type: 'main', index: 0 }]] }
  };

  return { name: '06 — Command Handler', nodes, connections, settings: { executionOrder: 'v1' } };
}

module.exports = {
  buildMorningBrief,
  buildDailyGenerator,
  buildRepurposer,
  buildTrendReactor,
  buildAnalyticsLoop,
  buildCommandHandler
};
