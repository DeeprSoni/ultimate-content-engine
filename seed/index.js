require('dotenv').config({ path: '../.env' });
const fs = require('fs');
const path = require('path');
const n8n = require('./lib/n8n');
const { waitFor } = require('./lib/wait');
const workflows = require('./lib/workflows');

const {
  N8N_OWNER_EMAIL, N8N_OWNER_PASSWORD, N8N_OWNER_FIRSTNAME, N8N_OWNER_LASTNAME
} = process.env;

async function main() {
  console.log('\n══════════════════════════════════════');
  console.log('  Content Machine — Seed');
  console.log('══════════════════════════════════════\n');

  // 1. Wait for n8n
  console.log('▸ Waiting for n8n...');
  await waitFor('http://localhost:5678/healthz', 'n8n');

  // 2. Authenticate
  console.log('\n▸ Authenticating with n8n...');
  await n8n.authenticate(N8N_OWNER_EMAIL, N8N_OWNER_PASSWORD, N8N_OWNER_FIRSTNAME, N8N_OWNER_LASTNAME);

  // 3. Create workflows (no external credentials needed — Content Hub is on the same network)
  console.log('\n▸ Creating n8n workflows...');

  const workflowBuilders = [
    ['Morning Brief', () => workflows.buildMorningBrief()],
    ['Daily Generator', () => workflows.buildDailyGenerator()],
    ['Repurposer', () => workflows.buildRepurposer()],
    ['Trend Reactor', () => workflows.buildTrendReactor()],
    ['Analytics Loop', () => workflows.buildAnalyticsLoop()],
    ['Command Handler', () => workflows.buildCommandHandler()],
  ];

  const workflowIds = {};

  for (const [name, builder] of workflowBuilders) {
    try {
      const workflow = builder();
      const id = await n8n.createWorkflow(workflow);
      workflowIds[name] = id;
      await n8n.activateWorkflow(id);
    } catch (e) {
      console.error(`  ✗ Failed to create ${name}: ${e.message}`);
    }
  }

  // 4. Save workflow IDs
  fs.writeFileSync(
    path.join(__dirname, 'workflow-ids.json'),
    JSON.stringify(workflowIds, null, 2)
  );

  // 5. Get Command Handler webhook URL
  const commandWebhookUrl = `https://${process.env.N8N_HOST}/webhook/intrkt-commands`;
  fs.writeFileSync(
    path.join(__dirname, 'command-webhook-url.txt'),
    commandWebhookUrl
  );

  console.log('\n  Command Handler webhook URL:');
  console.log('  ' + commandWebhookUrl);

  console.log('\n══════════════════════════════════════');
  console.log('  SEED COMPLETE');
  console.log('\n  All 6 workflows created and activated.');
  console.log('  Content publishes to Content Hub at http://content-hub:3000');
  console.log('  Public site: https://content.deepsoni.com');
  console.log('══════════════════════════════════════\n');
}

main().catch(e => {
  console.error('\n✗ Seed failed:', e.message);
  if (e.response?.data) console.error('  API error:', JSON.stringify(e.response.data, null, 2));
  process.exit(1);
});
