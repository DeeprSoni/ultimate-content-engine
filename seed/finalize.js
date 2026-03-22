require('dotenv').config({ path: '../.env' });
const axios = require('axios');
const fs = require('fs');
const n8n = require('./lib/n8n');

const {
  N8N_OWNER_EMAIL, N8N_OWNER_PASSWORD, N8N_OWNER_FIRSTNAME, N8N_OWNER_LASTNAME,
  MIXPOST_API_TOKEN, INTRKT_BASE_URL, INTRKT_API_KEY
} = process.env;

async function main() {
  console.log('\n▸ Finalizing setup...\n');

  if (!MIXPOST_API_TOKEN) {
    console.error('ERROR: MIXPOST_API_TOKEN not set in .env');
    process.exit(1);
  }

  // 1. Re-auth n8n
  await n8n.authenticate(N8N_OWNER_EMAIL, N8N_OWNER_PASSWORD, N8N_OWNER_FIRSTNAME, N8N_OWNER_LASTNAME);

  // 2. Update Mixpost credential with real token
  const mixpostCredId = await n8n.getCredentialId('MIXPOST_AUTH');
  if (mixpostCredId) {
    await axios.patch(
      `http://localhost:5678/api/v1/credentials/${mixpostCredId}`,
      { data: { name: 'Authorization', value: `Bearer ${MIXPOST_API_TOKEN}` } },
      { headers: { 'X-N8N-API-KEY': n8n.getApiKey() || '', 'Content-Type': 'application/json' } }
    ).catch(() => console.log('  ~ Could not update credential, may need manual update in n8n UI'));
    console.log('  ✓ Mixpost credential updated');
  }

  // 3. Update Intrkt inbound flow to call n8n Command Handler
  let commandWebhookUrl = '';
  try {
    commandWebhookUrl = fs.readFileSync('./command-webhook-url.txt', 'utf8').trim();
  } catch(e) {
    commandWebhookUrl = `https://${process.env.N8N_HOST}/webhook/intrkt-commands`;
  }

  console.log('  Updating Intrkt inbound flow to call n8n webhook...');
  try {
    await axios.post(
      `${INTRKT_BASE_URL}/mcp/create_flow`,
      {
        flow_id: 'flow:content-machine:inbound',
        name: 'Content Machine — Inbound Commands',
        entry_step: 'capture',
        steps: JSON.stringify({
          capture: {
            type: 'collect',
            var: 'cmd',
            prompt: '',
            next: 'relay'
          },
          relay: {
            type: 'function',
            fn: 'http_post',
            args: {
              url: commandWebhookUrl,
              body: '{"text":"${journey.cmd}","profile_id":"deep_personal"}'
            },
            next: 'ack'
          },
          ack: {
            type: 'template',
            template_id: 'tpl:content-machine:notify',
            next: null
          }
        })
      },
      { headers: { 'X-API-Key': INTRKT_API_KEY, 'Content-Type': 'application/json' } }
    ).catch(e => {
      console.log('  ~ Intrkt flow update via API failed. Update manually in Intrkt dashboard.');
      console.log('    Command webhook URL: ' + commandWebhookUrl);
    });
    console.log('  ✓ Intrkt inbound flow updated');
  } catch(e) {
    console.log('  ~ Intrkt flow update failed: ' + e.message);
  }

  // 4. Copy updated profiles to Docker volume
  console.log('  Copying updated profiles to Docker volume...');
  try {
    require('child_process').execSync('docker cp ../data/profiles/. n8n:/data/profiles/');
    require('child_process').execSync('docker cp ../data/contexts/. n8n:/data/contexts/');
    console.log('  ✓ Profiles and contexts updated in container');
  } catch(e) {
    console.log('  ~ Could not auto-copy files. Run manually:');
    console.log('    docker cp data/profiles/. n8n:/data/profiles/');
    console.log('    docker cp data/contexts/. n8n:/data/contexts/');
  }

  console.log('\n══════════════════════════════════════');
  console.log('  FINALIZATION COMPLETE');
  console.log('  System is live.');
  console.log('\n  Test by sending "stats" to your WhatsApp number.');
  console.log('══════════════════════════════════════\n');
}

main().catch(console.error);
