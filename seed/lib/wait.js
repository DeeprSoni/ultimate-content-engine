const axios = require('axios');

async function waitFor(url, label, attempts = 30, intervalMs = 3000) {
  for (let i = 0; i < attempts; i++) {
    try {
      await axios.get(url, { timeout: 4000 });
      return true;
    } catch {
      if (i === 0) process.stdout.write(`  Waiting for ${label}`);
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  console.log('');
  throw new Error(`${label} not ready after ${attempts} attempts`);
}

module.exports = { waitFor };
