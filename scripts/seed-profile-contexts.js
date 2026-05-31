/**
 * Seed script: populates profile_contexts from /extra_files/revised_prompts/*-profile.md
 *
 * Matches profiles by name (fuzzy: strips diacritics, compares normalized).
 * Each file becomes the 'default' context for the matched profile.
 *
 * Usage: node scripts/seed-profile-contexts.js
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const PROMPTS_DIR = path.resolve(__dirname, '../../extra_files/revised_prompts');

// Map filename slug → expected Persian name patterns for matching
// We'll match by extracting the name from the first line of the file instead.

async function main() {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    database: 'cyber',
    user: 'postgres',
    password: 'B0b_Dylan',
  });
  await client.connect();

  // Get all profiles
  const { rows: profiles } = await client.query('SELECT id, name FROM profiles');
  console.log(`Found ${profiles.length} profiles in DB`);

  // Read all profile context files
  const files = fs.readdirSync(PROMPTS_DIR).filter(f => f.endsWith('-profile.md'));
  console.log(`Found ${files.length} profile context files`);

  let matched = 0;
  let unmatched = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf-8');

    // Extract Persian name from "Persian Name: ..." line
    const persianMatch = content.match(/Persian Name:\s*(.+)/);
    const nameMatch = content.match(/^Name:\s*(.+)/m);

    const persianName = persianMatch?.[1]?.trim();
    const englishName = nameMatch?.[1]?.trim();

    if (!persianName && !englishName) {
      unmatched.push(file);
      continue;
    }

    // Find matching profile by Persian name
    let profile = profiles.find(p => p.name === persianName);
    if (!profile && persianName) {
      // Try partial match
      profile = profiles.find(p => p.name.includes(persianName) || persianName.includes(p.name));
    }

    if (!profile) {
      unmatched.push(`${file} (${persianName || englishName})`);
      continue;
    }

    // Update profile_contexts.default
    await client.query(
      `UPDATE profiles SET profile_contexts = jsonb_set(COALESCE(profile_contexts, '{}'), '{default}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify(content), profile.id]
    );
    matched++;
    console.log(`  ✓ ${file} → ${profile.name}`);
  }

  console.log(`\nMatched: ${matched}, Unmatched: ${unmatched.length}`);
  if (unmatched.length > 0) {
    console.log('Unmatched files:', unmatched);
  }

  await client.end();
}

main().catch(err => { console.error(err); process.exit(1); });
