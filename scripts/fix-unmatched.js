const fs = require('fs');
const { Client } = require('pg');

async function main() {
  const c = new Client({ host: 'localhost', port: 5432, database: 'cyber', user: 'postgres', password: 'B0b_Dylan' });
  await c.connect();

  const pairs = [
    ['cb0e0534-687a-45d5-bdda-97a3a31c6556', 'kioumars-heydari-profile.md'],
    ['41277bab-284e-4a93-b834-c12d0b4cda3c', 'eskandar-momeni-profile.md'],
  ];

  for (const [id, file] of pairs) {
    const content = fs.readFileSync(`c:/Users/DELSHAD/Documents/Pishrun/Projects/Cyber/extra_files/revised_prompts/${file}`, 'utf-8');
    await c.query(
      `UPDATE profiles SET profile_contexts = jsonb_set(COALESCE(profile_contexts, '{}'::jsonb), '{default}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify(content), id]
    );
    console.log('Done:', file);
  }

  await c.end();
}

main().catch(e => { console.error(e); process.exit(1); });
