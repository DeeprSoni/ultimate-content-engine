const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';

function cleanDir(dir, label) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  let removed = 0;
  const kept = [];

  for (const f of files) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const c = (p.content || '').toLowerCase();

    const isBroken = c.includes('json (javascript') ||
                     c.includes('it seems like') ||
                     c.includes('hypothetical') ||
                     c.includes('speculative') ||
                     c.includes('```json') ||
                     c.includes('json object') ||
                     c.includes('provide more context') ||
                     c.includes('provide more details');
    const isTooShort = c.length < 40;
    const isCompany = p.profile_id === 'intrkt_company';
    const isRawJson = c.startsWith('{"variations');

    if (isBroken || isTooShort || isCompany || isRawJson) {
      fs.unlinkSync(path.join(dir, f));
      removed++;
      console.log('  REMOVED [' + label + '] [' + (p.platform || '?') + '] ' + c.slice(0, 70));
    } else {
      kept.push({ platform: p.platform, format: p.format, preview: (p.content || '').slice(0, 80) });
    }
  }

  console.log('\n' + label + ': removed ' + removed + ', kept ' + kept.length);
  return kept;
}

console.log('=== Cleaning pending ===');
const pendingKept = cleanDir(path.join(DATA_DIR, 'pending'), 'pending');

console.log('\n=== Cleaning published ===');
const pubKept = cleanDir(path.join(DATA_DIR, 'published'), 'published');

console.log('\n=== Remaining pending ===');
pendingKept.forEach((p, i) => console.log((i+1) + '. [' + p.platform + '] [' + p.format + '] ' + p.preview));
