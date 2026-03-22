// Fix all Ollama HTTP Request nodes - v3
// 1. Use specifyBody:'json' with jsonBody
// 2. NO escape characters (\n) in jsonBody expressions - use spaces instead
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

// ── Fix inline nodes using brace-matching approach ──
function fixNode(nodeId, nodeName, jsonBodyExpr) {
  const marker = `id: '${nodeId}', name: '${nodeName}'`;
  const idx = wf.indexOf(marker);
  if (idx === -1) { console.log("NOT FOUND:", nodeName); return; }

  const searchRegion = wf.substring(idx, idx + 800);
  const ctIdx = searchRegion.indexOf("contentType: 'json',");
  if (ctIdx === -1) {
    // Check if already using specifyBody
    const spIdx = searchRegion.indexOf("specifyBody: 'json',");
    if (spIdx !== -1) {
      // Already fixed by v2 but with bad escapes - fix the jsonBody value
      const jbStart = searchRegion.indexOf("jsonBody:", spIdx);
      if (jbStart === -1) { console.log("No jsonBody for:", nodeName); return; }
      // Find the end of the jsonBody value (it's a string ending with }}')
      const jbValueStart = idx + jbStart + 9; // after "jsonBody: "
      // Find the closing }}'
      const jbEnd = wf.indexOf("}}'", jbValueStart);
      if (jbEnd === -1) { console.log("Cannot find jsonBody end for:", nodeName); return; }
      const oldJsonBody = wf.substring(jbValueStart, jbEnd + 3);
      wf = wf.substring(0, jbValueStart) + " '" + jsonBodyExpr + "'" + wf.substring(jbEnd + 3);
      console.log("Re-fixed:", nodeName);
      return;
    }
    console.log("No contentType for:", nodeName);
    return;
  }

  const bodyStartRelative = searchRegion.indexOf("body: {", ctIdx);
  if (bodyStartRelative === -1) { console.log("No body for:", nodeName); return; }

  const bodyStart = idx + bodyStartRelative + 6;
  let braceCount = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < wf.length; i++) {
    if (wf[i] === '{') braceCount++;
    else if (wf[i] === '}') {
      braceCount--;
      if (braceCount === 0) { bodyEnd = i + 1; break; }
    }
  }
  if (bodyEnd === -1) { console.log("No body end for:", nodeName); return; }

  const contentTypeStart = idx + ctIdx;
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

// Repurposer - "Refine LinkedIn" (no \n, use spaces)
fixNode('ollama-linkedin', 'Refine LinkedIn',
  '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: ($json.context_block || "") + " AGENT: " + ($json.agent_content_creator || "") }, { role: "user", content: "Adapt for LinkedIn: professional tone, 100-150 words, industry insight, CTA to follow. Return only the post text. Original tweet: " + ($json.tweet || "") + " Draft: " + ($json.linkedin_draft || "") }], stream: false, temperature: 0.6 }) }}'
);

// Repurposer - "Refine Threads"
fixNode('ollama-threads', 'Refine Threads',
  '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: ($json.context_block || "") + " AGENT: " + ($json.agent_content_creator || "") }, { role: "user", content: "Adapt for Threads: casual, under 300 chars, same energy as tweet, no hashtags. Return only post text. Tweet: " + ($json.tweet || "") }], stream: false, temperature: 0.7 }) }}'
);

// Trend Reactor - "Score Relevance"
fixNode('ollama-score', 'Score Relevance',
  '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: $json.agent_trend_researcher || "" }, { role: "user", content: "Score news 1-10 for " + ($json.display_name || "") + ". Keywords: " + ($json.trend_keywords || []).join(", ") + " --- News: " + JSON.stringify(($json.results || []).slice(0,6).map(function(r){return {title:r.title}})) + " --- Return ONLY valid JSON object: {topic:string, score:number, angle:string}" }], stream: false, temperature: 0.2 }) }}'
);

// Trend Reactor - "Auto Generate Hot Take"
fixNode('auto-generate', 'Auto Generate Hot Take',
  '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: ($json.context_block || "") + " AGENT: " + ($json.agent_twitter_engager || "") }, { role: "user", content: "Write a hot take tweet about: " + ($json.topic || "") + ". Angle: " + ($json.angle || "") + ". Under 240 chars. Strong opinion. Return only tweet text." }], stream: false, temperature: 0.85 }) }}'
);

// Analytics Loop - "Analyse with Growth Hacker"
fixNode('ollama-analyse', 'Analyse with Growth Hacker',
  '={{ JSON.stringify({ model: process.env.OLLAMA_MODEL || "qwen2.5:7b", messages: [{ role: "system", content: $("Load Profiles").first().json.agent_growth_hacker || "" }, { role: "user", content: "Analyse this week for " + ($("Load Profiles").first().json.display_name || "") + ". Posts: " + JSON.stringify(($json.data || []).slice(0,15)) + " Return JSON: {what_worked:string, avoid:string, next_week:string, summary:string}" }], stream: false, temperature: 0.3 }) }}'
);

// Verify
const remaining = (wf.match(/url: 'http:\/\/ollama[^']*'[\s\S]{0,100}contentType: 'json'/g) || []);
console.log("\nRemaining old-style:", remaining.length);
const newStyle = (wf.match(/specifyBody: 'json'/g) || []).length;
console.log("Nodes using specifyBody:", newStyle);

// Check for any \\n in jsonBody values
const badEscapes = (wf.match(/jsonBody:.*\\\\n/g) || []);
console.log("jsonBody with \\\\n escapes:", badEscapes.length);

fs.writeFileSync(path, wf);

try {
  delete require.cache[require.resolve(path)];
  require(path);
  console.log("Syntax: PASSED");
} catch (e) {
  console.log("Syntax: FAILED -", e.message);
}
