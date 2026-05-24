/**
 * 005-seed-profile-users.js
 *
 * For every profile that has a promticIdentifier.external_id,
 * create a user account with:
 *   - username  = promticIdentifier.external_id  (e.g. "ghalibaf")
 *   - name      = profile.name
 *   - password  = "Change@123"  (temporary — must be changed after first login)
 *   - role      = "client_admin"
 *   - linked to that profile via user_profiles join table
 *
 * Skips profiles that already have a linked user.
 * Safe to re-run (idempotent).
 *
 * Usage:
 *   node scripts/005-seed-profile-users.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('pg');
const bcrypt = require('bcrypt');

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || process.env.DB_DATABASE || 'postgres',
  user: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'secret',
});

const DEFAULT_PASSWORD = 'Change@123';

async function main() {
  await client.connect();
  console.log('Connected to database');

  // Fetch all profiles with a promticIdentifier
  const { rows: profiles } = await client.query(`
    SELECT id, name, promtic_identifier
    FROM profiles
    WHERE promtic_identifier IS NOT NULL
      AND promtic_identifier->>'external_id' IS NOT NULL
    ORDER BY name
  `);

  console.log(`Found ${profiles.length} profiles with promticIdentifier`);

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  let created = 0;
  let skipped = 0;

  for (const profile of profiles) {
    const username = profile.promtic_identifier.external_id;
    const name = profile.name;

    // Check if user with this username already exists
    const { rows: existing } = await client.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );

    if (existing.length > 0) {
      const userId = existing[0].id;
      // Make sure the user_profiles link exists
      await client.query(
        `INSERT INTO user_profiles (user_id, profile_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, profile.id]
      );
      console.log(`  SKIP  ${username} (user already exists, ensured profile link)`);
      skipped++;
      continue;
    }

    // Create the user
    const { rows: [newUser] } = await client.query(
      `INSERT INTO users (name, username, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'client_admin', true)
       RETURNING id`,
      [name, username, passwordHash]
    );

    // Link to profile
    await client.query(
      `INSERT INTO user_profiles (user_id, profile_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [newUser.id, profile.id]
    );

    console.log(`  CREATE ${username}  →  ${name}`);
    created++;
  }

  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}`);
  console.log(`Default password for all new users: "${DEFAULT_PASSWORD}"`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
