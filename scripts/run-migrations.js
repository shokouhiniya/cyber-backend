/**
 * run-migrations.js — runs at container start, before the API boots.
 *
 * 1. Applies every `scripts/NNN-*.sql` with NNN >= FIRST_AUTO_MIGRATION, in
 *    order, each in its own transaction. These files MUST be idempotent
 *    (IF NOT EXISTS / ON CONFLICT …) because they run on every start; that
 *    keeps deploys simple and needs no tracking table. Older migrations
 *    (002–014) were applied by hand and are not all re-runnable.
 * 2. Runs one-off data jobs once, recording completion in `deploy_jobs`
 *    (its own table — global_context rows are injected into LLM prompts).
 *
 * Any failure exits non-zero so the container doesn't start the API on a
 * half-migrated schema.
 *
 * Usage: node scripts/run-migrations.js   (reads DB_* from the environment;
 * falls back to .env when run locally)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

if (!process.env.DB_HOST && fs.existsSync(path.join(__dirname, '../.env'))) {
  try {
    require('dotenv').config({ path: path.join(__dirname, '../.env') });
  } catch {
    /* dotenv is optional */
  }
}

const FIRST_AUTO_MIGRATION = 15;

// One-off jobs: [job key recorded in deploy_jobs, script, args]
const ONE_OFF_JOBS = [['job_backfill_hourly_aggregates_v1', 'backfill-hourly-aggregates.js', []]];

async function main() {
  const db = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  });
  await db.connect();

  try {
    const files = fs
      .readdirSync(__dirname)
      .filter((f) => /^\d{3}-.*\.sql$/.test(f) && Number(f.slice(0, 3)) >= FIRST_AUTO_MIGRATION)
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
      // Files may carry their own BEGIN/COMMIT; only wrap the ones that don't.
      const ownTx = /^\s*BEGIN\s*;/im.test(sql);
      if (!ownTx) await db.query('BEGIN');
      try {
        await db.query(sql);
        if (!ownTx) await db.query('COMMIT');
        console.log(`[migrate] ${file} ✓`);
      } catch (e) {
        if (!ownTx) await db.query('ROLLBACK').catch(() => {});
        throw new Error(`${file}: ${e.message}`);
      }
    }

    await db.query(
      `CREATE TABLE IF NOT EXISTS deploy_jobs (key VARCHAR(100) PRIMARY KEY, done_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    );
    for (const [key, script, args] of ONE_OFF_JOBS) {
      const { rows } = await db.query('SELECT 1 FROM deploy_jobs WHERE key = $1', [key]);
      if (rows.length) continue;
      console.log(`[migrate] running one-off job ${script} …`);
      const res = spawnSync(process.execPath, [path.join(__dirname, script), ...args], {
        stdio: 'inherit',
        env: process.env,
      });
      if (res.status !== 0) throw new Error(`${script} exited with ${res.status}`);
      await db.query('INSERT INTO deploy_jobs (key) VALUES ($1) ON CONFLICT (key) DO NOTHING', [key]);
      console.log(`[migrate] ${script} ✓`);
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(`[migrate] FAILED — ${e.message}`);
  process.exit(1);
});
