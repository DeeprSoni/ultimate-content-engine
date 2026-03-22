const fs = require("fs");
const path = process.argv[2] || "/home/deep/content-machine/seed/lib/workflows.js";
let content = fs.readFileSync(path, "utf8");

// Remove the output expression line
content = content.replace(
  /output: '={{ \$json\.intent }}',\n\s+rules/,
  "rules"
);

// Replace simple outputKey rules with full condition-based rules
const intents = ["approve","skip","edit","trust","pause","resume","opinion","post_about","stats","change"];
const rules = intents.map(i => {
  return `{ conditions: { conditions: [{ leftValue: '={{ $json.intent }}', rightValue: '${i}', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: '${i}' }`;
});

const oldRulesPattern = /\{ outputKey: 'approve' \}[^]*?\{ outputKey: 'change' \}/;
content = content.replace(oldRulesPattern, rules.join(",\n          "));

fs.writeFileSync(path, content);
console.log("Switch node fixed");
console.log("Verify:", content.includes("renameOutput") ? "OK" : "FAILED");
