// Fix all Ollama HTTP Request nodes in workflows.js
// Strategy: replace just the body-related parameters inside each node
const fs = require("fs");
const path = process.argv[2] || "/home/deep/content-machine/seed/lib/workflows.js";
let wf = fs.readFileSync(path, "utf8");

// ── Fix ollamaNode helper ──
wf = wf.replace(
  /function ollamaNode\(id, name, systemExpr, userExpr, temperature, position\) \{[\s\S]*?return httpNode\([^)]+\);\s*\}/,
  `function ollamaNode(id, name, systemExpr, userExpr, temperature, position) {
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
console.log("Fixed: ollamaNode helper");

// ── Fix inline nodes by replacing the parameters block ──
// Each inline Ollama node has:
//   sendBody: true, contentType: 'json',
//   body: { model: ..., messages: [...], stream: false, temperature: N }
//
// We replace: contentType: 'json', body: { ... }
// With: specifyBody: 'json', jsonBody: '...'
// But we keep the outer node structure intact.

// Helper: given a unique node identifier string and a jsonBody expression,
// replace the parameters content for that node
function fixNode(nodeId, nodeName, jsonBodyExpr) {
  // Find the node by id+name, then replace its body-related parameters
  const marker = `id: '${nodeId}', name: '${nodeName}'`;
  const idx = wf.indexOf(marker);
  if (idx === -1) {
    console.log("NOT FOUND:", nodeName);
    return;
  }

  // Find "contentType: 'json'," near this node
  const searchFrom = idx;
  const searchRegion = wf.substring(searchFrom, searchFrom + 800);

  const ctIdx = searchRegion.indexOf("contentType: 'json',");
  if (ctIdx === -1) {
    console.log("Already fixed or no contentType:", nodeName);
    return;
  }

  // Find the body: { start
  const bodyStartRelative = searchRegion.indexOf("body: {", ctIdx);
  if (bodyStartRelative === -1) {
    console.log("No body: { found for:", nodeName);
    return;
  }

  // Find the matching closing braces for body: { ... }
  // We need to count braces
  const bodyStart = searchFrom + bodyStartRelative + 6; // after "body: "
  let braceCount = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < wf.length; i++) {
    if (wf[i] === '{') braceCount++;
    else if (wf[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        bodyEnd = i + 1; // include the closing }
        break;
      }
    }
  }

  if (bodyEnd === -1) {
    console.log("Could not find body end for:", nodeName);
    return;
  }

  // Replace contentType + body with specifyBody + jsonBody
  const contentTypeStart = searchFrom + ctIdx;
  const oldText = wf.substring(contentTypeStart, bodyEnd);
  const newText = `specifyBody: 'json',\n        jsonBody: '${jsonBodyExpr}'`;

  wf = wf.substring(0, contentTypeStart) + newText + wf.substring(bodyEnd);
  console.log("Fixed:", nodeName);
}

// Morning Brief - "Ollama — Score Topics"
fixNode('ollama-score', 'Ollama — Score Topics',
  '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: $json.system_for_scoring || "" }, { role: "user", content: $json.news_for_scoring || "" }], stream: false, temperature: 0.2 }) }}'
);

// Daily Generator - "Generate Content — Ollama"
fixNode('ollama-generate', 'Generate Content — Ollama',
  '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: $json.system_prompt || "" }, { role: "user", content: $json.user_message || "" }], stream: false, temperature: 0.75 }) }}'
);

// Repurposer - "Refine LinkedIn"
fixNode('ollama-linkedin', 'Refine LinkedIn',
  '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: ($json.context_block || "") + "\\n\\nAGENT:\\n" + ($json.agent_content_creator || "") }, { role: "user", content: "Adapt for LinkedIn: professional tone, 100-150 words, industry insight, CTA to follow. Return only the post text.\\n\\nOriginal tweet: " + ($json.tweet || "") + "\\nDraft: " + ($json.linkedin_draft || "") }], stream: false, temperature: 0.6 }) }}'
);

// Repurposer - "Refine Threads"
fixNode('ollama-threads', 'Refine Threads',
  '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: ($json.context_block || "") + "\\n\\nAGENT:\\n" + ($json.agent_content_creator || "") }, { role: "user", content: "Adapt for Threads: casual, under 300 chars, same energy as tweet, no hashtags. Return only post text.\\n\\nTweet: " + ($json.tweet || "") }], stream: false, temperature: 0.7 }) }}'
);

// Trend Reactor - "Score Relevance"
fixNode('ollama-score', 'Score Relevance',
  '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: $json.agent_trend_researcher || "" }, { role: "user", content: "Score news 1-10 for " + ($json.display_name || "") + ". Keywords: " + ($json.trend_keywords || []).join(", ") + "\\n\\nNews: " + JSON.stringify(($json.results || []).slice(0,6).map(function(r){return {title:r.title}})) + "\\n\\nReturn ONLY JSON: {\\"topic\\":\\"string\\",\\"score\\":number,\\"angle\\":\\"string\\"}" }], stream: false, temperature: 0.2 }) }}'
);

// Trend Reactor - "Auto Generate Hot Take"
fixNode('auto-generate', 'Auto Generate Hot Take',
  '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: ($json.context_block || "") + "\\n\\nAGENT:\\n" + ($json.agent_twitter_engager || "") }, { role: "user", content: "Write a hot take tweet about: \\"" + ($json.topic || "") + "\\". Angle: " + ($json.angle || "") + ". Under 240 chars. Strong opinion. Return only tweet text." }], stream: false, temperature: 0.85 }) }}'
);

// Analytics Loop - "Analyse with Growth Hacker"
fixNode('ollama-analyse', 'Analyse with Growth Hacker',
  '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: $("Load Profiles").first().json.agent_growth_hacker || "" }, { role: "user", content: "Analyse this week for " + ($("Load Profiles").first().json.display_name || "") + ".\\nPosts: " + JSON.stringify(($json.data || []).slice(0,15)) + "\\nReturn JSON: {\\"what_worked\\":\\"string\\",\\"avoid\\":\\"string\\",\\"next_week\\":\\"string\\",\\"summary\\":\\"string\\"}" }], stream: false, temperature: 0.3 }) }}'
);

// Verify
const remaining = (wf.match(/url: 'http:\/\/ollama[^']*'[\s\S]{0,100}contentType: 'json'/g) || []);
console.log("\nRemaining old-style:", remaining.length);
const newStyle = (wf.match(/specifyBody: 'json'/g) || []).length;
console.log("Nodes using specifyBody:", newStyle);

fs.writeFileSync(path, wf);

// Verify JS syntax by trying to require it
try {
  delete require.cache[require.resolve(path)];
  require(path);
  console.log("Syntax check: PASSED");
} catch (e) {
  console.log("Syntax check: FAILED -", e.message);
}
