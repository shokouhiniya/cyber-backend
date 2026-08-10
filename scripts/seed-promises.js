require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('pg');
const fs = require('fs'), path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../extra_files/promises.json'), 'utf8'));
const db = new Client({ host: process.env.DB_HOST, port: +process.env.DB_PORT || 5432, database: process.env.DB_NAME, user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD });

async function main() {
  await db.connect();
  let updated = 0, skipped = 0;
  for (const entry of data) {
    if (!entry.public_promises || entry.public_promises.length === 0) { skipped++; continue; }
    const promises = entry.public_promises.map(text => ({ text, status: 'pending', addedAt: new Date().toISOString() }));
    const res = await db.query(
      `UPDATE profiles SET promises = $1::jsonb WHERE name = $2 RETURNING name`,
      [JSON.stringify(promises), entry.name]
    );
    if (res.rowCount > 0) { process.stdout.write(`OK  ${entry.name} — ${promises.length} promises\n`); updated++; }
    else { process.stdout.write(`MISS ${entry.name}\n`); }
  }
  process.stdout.write(`\nDone. Updated: ${updated} | Skipped (no promises): ${skipped}\n`);
  await db.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
