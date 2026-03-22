const axios = require('axios');

const BASE = 'http://localhost:5678';
let _apiKey = null;

function headers() {
  if (!_apiKey) throw new Error('n8n not authenticated');
  return { 'X-N8N-API-KEY': _apiKey, 'Content-Type': 'application/json' };
}

async function authenticate(email, password, firstName, lastName) {
  // Check if owner is set up
  let ownerSetUp = false;
  try {
    const s = await axios.get(`${BASE}/rest/settings`);
    ownerSetUp = s.data?.data?.userManagement?.showSetupOnFirstLoad === false;
  } catch {}

  if (!ownerSetUp) {
    console.log('  Setting up n8n owner account...');
    try {
      await axios.post(`${BASE}/rest/owner/setup`, { email, password, firstName, lastName });
    } catch (e) {
      // May already be set up
    }
  }

  // Log in to get session cookie
  const loginRes = await axios.post(`${BASE}/rest/login`, { email, password });
  const cookie = loginRes.headers['set-cookie']?.join('; ') || '';

  // Delete existing API keys and create a fresh one (listing returns masked keys)
  try {
    const listRes = await axios.get(`${BASE}/rest/api-keys`, { headers: { Cookie: cookie } });
    const existing = listRes.data?.data || [];
    for (const k of existing) {
      await axios.delete(`${BASE}/rest/api-keys/${k.id}`, { headers: { Cookie: cookie } }).catch(() => {});
    }
  } catch {}

  try {
    const keyRes = await axios.post(
      `${BASE}/rest/api-keys`,
      { label: `content-machine-${Date.now()}` },
      { headers: { Cookie: cookie, 'Content-Type': 'application/json' } }
    );
    _apiKey = keyRes.data?.data?.apiKey;
  } catch (e) {
    console.log('  API key creation failed:', e.response?.status);
  }

  if (!_apiKey) throw new Error('Could not obtain n8n API key');
  console.log('  ✓ n8n authenticated');
  return _apiKey;
}

async function createCredential(name, type, data) {
  try {
    const res = await axios.post(
      `${BASE}/api/v1/credentials`,
      { name, type, data },
      { headers: headers() }
    );
    const id = res.data.id;
    console.log(`  ✓ Credential: ${name} (id: ${id})`);
    return id;
  } catch (e) {
    if (e.response?.data?.message?.toLowerCase().includes('already exists') ||
        e.response?.status === 409) {
      // Fetch existing credential ID by listing
      const list = await axios.get(`${BASE}/api/v1/credentials?limit=250`, { headers: headers() });
      const found = list.data?.data?.find(c => c.name === name);
      if (found) {
        console.log(`  ~ Credential exists: ${name} (id: ${found.id})`);
        return found.id;
      }
    }
    throw new Error(`Failed to create credential "${name}": ${e.response?.data?.message || e.message}`);
  }
}

async function getCredentialId(name) {
  const list = await axios.get(`${BASE}/api/v1/credentials?limit=250`, { headers: headers() });
  const found = list.data?.data?.find(c => c.name === name);
  return found?.id || null;
}

async function createWorkflow(workflow) {
  const res = await axios.post(
    `${BASE}/api/v1/workflows`,
    workflow,
    { headers: headers() }
  );
  const id = res.data.id;
  console.log(`  ✓ Workflow: ${workflow.name} (id: ${id})`);
  return id;
}

async function activateWorkflow(id) {
  await axios.patch(
    `${BASE}/api/v1/workflows/${id}`,
    { active: true },
    { headers: headers() }
  );
}

async function getWorkflowWebhookUrl(workflowId, path) {
  // n8n webhook URLs follow the pattern /webhook/{path}
  return `http://localhost:5678/webhook/${path}`;
}

function getApiKey() { return _apiKey; }

module.exports = { authenticate, createCredential, getCredentialId, createWorkflow, activateWorkflow, getWorkflowWebhookUrl, getApiKey };
