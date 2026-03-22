// Fix all Ollama HTTP Request nodes in workflows.js
// Problem: n8n 1.70.3 doesn't properly serialize nested arrays in body objects
// Solution: Use specifyBody:'json' with jsonBody string expression

const fs = require("fs");
const path = process.argv[2] || "/home/deep/content-machine/seed/lib/workflows.js";
let wf = fs.readFileSync(path, "utf8");
let changes = 0;

// ── Fix 1: ollamaNode helper function ──
// This helper isn't actually used by the inline nodes, but fix it anyway
wf = wf.replace(
  /function ollamaNode\(id, name, systemExpr, userExpr, temperature, position\) \{[\s\S]*?return httpNode\([^)]+\);\s*\}/,
  `function ollamaNode(id, name, systemExpr, userExpr, temperature, position) {
  // Fixed: use specifyBody:'json' with jsonBody string to avoid array serialization bug
  return {
    id, name,
    type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position,
    continueOnFail: true,
    parameters: {
      method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
      sendBody: true, specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: ' + JSON.stringify(systemExpr) + ' }, { role: "user", content: ' + JSON.stringify(userExpr) + ' }], stream: false, temperature: ' + temperature + ' }) }}'
    }
  };
}`
);
changes++;
console.log("Fixed: ollamaNode helper");

// ── Fix 2: All inline Ollama HTTP Request nodes ──
// These all have pattern: sendBody: true, contentType: 'json', body: { model:..., messages:[...], ... }
// We need to replace contentType:'json' + body:{...} with specifyBody:'json' + jsonBody:'...'

// Strategy: Find each Ollama node by its unique id+name, extract the expressions used,
// and replace with jsonBody format.

// Morning Brief - "Ollama — Score Topics"
wf = wf.replace(
  /id: 'ollama-score', name: 'Ollama — Score Topics',\s*type: 'n8n-nodes-base\.httpRequest', typeVersion: 4\.2, position: \[1280, 200\],\s*continueOnFail: true,\s*parameters: \{[^}]*method: 'POST', url: 'http:\/\/ollama:11434\/v1\/chat\/completions',\s*sendBody: true, contentType: 'json',\s*body: \{[\s\S]*?\}\s*\}\s*\}/,
  `id: 'ollama-score', name: 'Ollama — Score Topics',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1280, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: $json.system_for_scoring || "" }, { role: "user", content: $json.news_for_scoring || "" }], stream: false, temperature: 0.2 }) }}'
      }`
);
changes++;
console.log("Fixed: Morning Brief - Ollama Score Topics");

// Daily Generator - "Generate Content — Ollama"
wf = wf.replace(
  /id: 'ollama-generate', name: 'Generate Content — Ollama',\s*type: 'n8n-nodes-base\.httpRequest', typeVersion: 4\.2, position: \[1280, 200\],\s*continueOnFail: true,\s*parameters: \{[^}]*method: 'POST', url: 'http:\/\/ollama:11434\/v1\/chat\/completions',\s*sendBody: true, contentType: 'json',\s*body: \{[\s\S]*?\}\s*\}\s*\}/,
  `id: 'ollama-generate', name: 'Generate Content — Ollama',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1280, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: $json.system_prompt || "" }, { role: "user", content: $json.user_message || "" }], stream: false, temperature: 0.75 }) }}'
      }`
);
changes++;
console.log("Fixed: Daily Generator - Generate Content");

// Repurposer - "Refine LinkedIn"
wf = wf.replace(
  /id: 'ollama-linkedin', name: 'Refine LinkedIn',\s*type: 'n8n-nodes-base\.httpRequest', typeVersion: 4\.2, position: \[640, 180\],\s*continueOnFail: true,\s*parameters: \{[^}]*method: 'POST', url: 'http:\/\/ollama:11434\/v1\/chat\/completions',\s*sendBody: true, contentType: 'json',\s*body: \{[\s\S]*?\}\s*\}\s*\}/,
  `id: 'ollama-linkedin', name: 'Refine LinkedIn',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [640, 180],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: ($json.context_block || "") + "\\\\n\\\\nAGENT:\\\\n" + ($json.agent_content_creator || "") }, { role: "user", content: "Adapt for LinkedIn: professional tone, 100-150 words, industry insight, CTA to follow. Return only the post text.\\\\n\\\\nOriginal tweet: " + ($json.tweet || "") + "\\\\nDraft: " + ($json.linkedin_draft || "") }], stream: false, temperature: 0.6 }) }}'
      }`
);
changes++;
console.log("Fixed: Repurposer - Refine LinkedIn");

// Repurposer - "Refine Threads"
wf = wf.replace(
  /id: 'ollama-threads', name: 'Refine Threads',\s*type: 'n8n-nodes-base\.httpRequest', typeVersion: 4\.2, position: \[640, 420\],\s*continueOnFail: true,\s*parameters: \{[^}]*method: 'POST', url: 'http:\/\/ollama:11434\/v1\/chat\/completions',\s*sendBody: true, contentType: 'json',\s*body: \{[\s\S]*?\}\s*\}\s*\}/,
  `id: 'ollama-threads', name: 'Refine Threads',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [640, 420],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: ($json.context_block || "") + "\\\\n\\\\nAGENT:\\\\n" + ($json.agent_content_creator || "") }, { role: "user", content: "Adapt for Threads: casual, under 300 chars, same energy as tweet, no hashtags. Return only post text.\\\\n\\\\nTweet: " + ($json.tweet || "") }], stream: false, temperature: 0.7 }) }}'
      }`
);
changes++;
console.log("Fixed: Repurposer - Refine Threads");

// Trend Reactor - "Score Relevance"
wf = wf.replace(
  /id: 'ollama-score', name: 'Score Relevance',\s*type: 'n8n-nodes-base\.httpRequest', typeVersion: 4\.2, position: \[860, 200\],\s*continueOnFail: true,\s*parameters: \{[^}]*method: 'POST', url: 'http:\/\/ollama:11434\/v1\/chat\/completions',\s*sendBody: true, contentType: 'json',\s*body: \{[\s\S]*?\}\s*\}\s*\}/,
  `id: 'ollama-score', name: 'Score Relevance',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [860, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: $json.agent_trend_researcher || "" }, { role: "user", content: "Score news 1-10 for " + ($json.display_name || "") + ". Keywords: " + ($json.trend_keywords || []).join(", ") + "\\\\n\\\\nNews: " + JSON.stringify(($json.results || []).slice(0,6).map(function(r){return {title:r.title}})) + "\\\\n\\\\nReturn ONLY JSON: {\\"topic\\":\\"string\\",\\"score\\":number,\\"angle\\":\\"string\\"}" }], stream: false, temperature: 0.2 }) }}'
      }`
);
changes++;
console.log("Fixed: Trend Reactor - Score Relevance");

// Trend Reactor - "Auto Generate Hot Take"
wf = wf.replace(
  /id: 'auto-generate', name: 'Auto Generate Hot Take',\s*type: 'n8n-nodes-base\.httpRequest', typeVersion: 4\.2, position: \[1740, 200\],\s*continueOnFail: true,\s*parameters: \{[^}]*method: 'POST', url: 'http:\/\/ollama:11434\/v1\/chat\/completions',\s*sendBody: true, contentType: 'json',\s*body: \{[\s\S]*?\}\s*\}\s*\}/,
  `id: 'auto-generate', name: 'Auto Generate Hot Take',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1740, 200],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: ($json.context_block || "") + "\\\\n\\\\nAGENT:\\\\n" + ($json.agent_twitter_engager || "") }, { role: "user", content: "Write a hot take tweet about: \\"" + ($json.topic || "") + "\\". Angle: " + ($json.angle || "") + ". Under 240 chars. Strong opinion. Return only tweet text." }], stream: false, temperature: 0.85 }) }}'
      }`
);
changes++;
console.log("Fixed: Trend Reactor - Auto Generate Hot Take");

// Analytics Loop - "Analyse with Growth Hacker"
wf = wf.replace(
  /id: 'ollama-analyse', name: 'Analyse with Growth Hacker',\s*type: 'n8n-nodes-base\.httpRequest', typeVersion: 4\.2, position: \[860, 300\],\s*continueOnFail: true,\s*parameters: \{[^}]*method: 'POST', url: 'http:\/\/ollama:11434\/v1\/chat\/completions',\s*sendBody: true, contentType: 'json',\s*body: \{[\s\S]*?\}\s*\}\s*\}/,
  `id: 'ollama-analyse', name: 'Analyse with Growth Hacker',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [860, 300],
      continueOnFail: true,
      parameters: {
        method: 'POST', url: 'http://ollama:11434/v1/chat/completions',
        sendBody: true, specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: $("Load Profiles").first().json.agent_growth_hacker || "" }, { role: "user", content: "Analyse this week for " + ($("Load Profiles").first().json.display_name || "") + ".\\\\nPosts: " + JSON.stringify(($json.data || []).slice(0,15)) + "\\\\nReturn JSON: {\\"what_worked\\":\\"string\\",\\"avoid\\":\\"string\\",\\"next_week\\":\\"string\\",\\"summary\\":\\"string\\"}" }], stream: false, temperature: 0.3 }) }}'
      }`
);
changes++;
console.log("Fixed: Analytics Loop - Analyse with Growth Hacker");

// Verify no remaining old-style Ollama body patterns
const remainingOldBodies = (wf.match(/url: 'http:\/\/ollama[^']*'[\s\S]{0,100}contentType: 'json'/g) || []);
console.log("\nRemaining old-style Ollama contentType:'json':", remainingOldBodies.length);
if (remainingOldBodies.length > 0) {
  console.log("WARNING: Some Ollama nodes may not have been fixed!");
  remainingOldBodies.forEach((m, i) => console.log("  " + (i+1) + ":", m.substring(0, 80)));
}

// Verify new style exists
const newStyle = (wf.match(/specifyBody: 'json'/g) || []).length;
console.log("Nodes using specifyBody:'json':", newStyle);

fs.writeFileSync(path, wf);
console.log("\nSaved. Total changes:", changes);
