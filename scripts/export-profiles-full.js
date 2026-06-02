/**
 * export-profiles-full.js
 *
 * Exports all profiles to a CSV file suitable for feeding to an LLM
 * to generate 200 new profiles in the same format.
 *
 * Includes every field that must be manually provided per profile:
 *   - Basic info (name, role, organization, avatar, sort_name)
 *   - Ingest config (tier, source weights per platform)
 *   - Search keywords (include + exclude)
 *   - Promtic identifier (external_id, display name, type)
 *   - Official channels (one column per platform)
 *   - UI customization (primary_color, plan, hidden_widgets)
 *   - Profile context (AI prompt context — the "default" key)
 *   - Promises (count + JSON for reference)
 *
 * Usage:
 *   node scripts/export-profiles-full.js
 *
 * Output:
 *   extra_files/profiles-full-export.csv  (UTF-8 with BOM for Excel)
 */

'use strict';

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// ── DB connection ─────────────────────────────────────────────────────────────
const client = new Client({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'cyber',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'B0b_Dylan',
});

// ── CSV helpers ───────────────────────────────────────────────────────────────
function esc(v) {
  if (v == null || v === '') return '';
  const s = String(v).replace(/"/g, '""');
  return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
    ? `"${s}"`
    : s;
}

// Flatten a string[] to a pipe-separated value
function pipes(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr.join('|');
}

// Extract a handle from officialChannels by platform
function channel(channels, platform) {
  if (!Array.isArray(channels)) return '';
  const found = channels.find(c => c.platform === platform);
  return found ? (found.url || found.handle || '') : '';
}

// Source weight for a given platform (empty string = use system default)
function weight(weights, platform) {
  if (!weights || weights[platform] == null) return '';
  return String(weights[platform]);
}

// ── Columns ──────────────────────────────────────────────────────────────────
// Every column here is something a human (or LLM) must decide per profile.
// Derived/computed columns (daily_avg_posts, created_at, id, etc.) are omitted.

const HEADERS = [
  // ── Identity ──────────────────────────────────────────────────────────────
  'name',                    // display name (Persian)
  'sort_name',               // family name for sorting (Persian, e.g. حداد عادل)
  'role',                    // job title / political role
  'organization',            // affiliated organization or institution
  'avatar',                  // URL or filename for avatar image

  // ── Ingest config ─────────────────────────────────────────────────────────
  'tier',                    // heavy | medium | light
  'is_active',               // true | false

  // ── Search keywords ───────────────────────────────────────────────────────
  'keywords',                // pipe-separated, e.g. قالیباف|بقایی|محمدباقر
  'excluded_keywords',       // pipe-separated false-positive exclusions

  // ── Promtic integration ───────────────────────────────────────────────────
  'promtic_external_id',     // slug used in Promtic billing (e.g. ghalibaf)
  'promtic_display_name',    // human label shown in Promtic (optional)
  'promtic_type',            // e.g. political_figure | media_outlet | ngo

  // ── UI customization ──────────────────────────────────────────────────────
  'primary_color',           // hex color, e.g. #1565C0
  'plan',                    // standard | enterprise | etc.

  // ── Official channels ─────────────────────────────────────────────────────
  'channel_telegram',
  'channel_eitaa',
  'channel_rubika',
  'channel_bale',
  'channel_x',               // Twitter/X
  'channel_instagram',
  'channel_web',             // website URL

  // ── Source weights (empty = system default = 1.0) ─────────────────────────
  'weight_telegram',
  'weight_twitter',
  'weight_instagram',
  'weight_news',
  'weight_newspaper',
  'weight_media',
  'weight_bale',
  'weight_rubika',
  'weight_aparat',
  'weight_forum',
  'weight_eitaa',

  // ── AI context ────────────────────────────────────────────────────────────
  'context_default',         // the main AI prompt context paragraph (English)

  // ── Promises ──────────────────────────────────────────────────────────────
  'promises_count',          // number of tracked promises
  'promises_json',           // full JSON blob for reference / re-import

  // ── Hidden widgets ────────────────────────────────────────────────────────
  'hidden_widgets',          // pipe-separated widget keys hidden from clients
];

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  await client.connect();
  console.log('Connected to DB');

  const { rows } = await client.query(`
    SELECT
      id, name, sort_name, role, organization, avatar,
      tier, is_active,
      keywords, excluded_keywords,
      promtic_identifier,
      primary_color, plan,
      official_channels,
      source_weights,
      profile_contexts,
      promises,
      hidden_widgets
    FROM profiles
    ORDER BY sort_name ASC NULLS LAST, name ASC
  `);

  console.log(`Exporting ${rows.length} profiles...`);

  const csvRows = rows.map(p => {
    const sw = p.source_weights || {};
    const oc = p.official_channels || [];
    const ctx = p.profile_contexts || {};
    const prms = Array.isArray(p.promises) ? p.promises : [];

    return [
      p.name,
      p.sort_name || '',
      p.role || '',
      p.organization || '',
      p.avatar || '',

      p.tier || 'medium',
      p.is_active ? 'true' : 'false',

      pipes(p.keywords),
      pipes(p.excluded_keywords),

      p.promtic_identifier?.external_id || '',
      p.promtic_identifier?.name        || '',
      p.promtic_identifier?.type        || '',

      p.primary_color || '',
      p.plan          || '',

      channel(oc, 'telegram'),
      channel(oc, 'eitaa'),
      channel(oc, 'rubika'),
      channel(oc, 'bale'),
      channel(oc, 'x'),
      channel(oc, 'instagram'),
      channel(oc, 'web'),

      weight(sw, 'telegram'),
      weight(sw, 'twitter'),
      weight(sw, 'instagram'),
      weight(sw, 'news'),
      weight(sw, 'newspaper'),
      weight(sw, 'media'),
      weight(sw, 'bale'),
      weight(sw, 'rubika'),
      weight(sw, 'aparat'),
      weight(sw, 'forum'),
      weight(sw, 'eitaa'),

      ctx['default'] || '',

      prms.length,
      prms.length > 0 ? JSON.stringify(prms) : '',

      pipes(p.hidden_widgets),
    ].map(esc).join(',');
  });

  const csv = '\uFEFF' + [HEADERS.join(','), ...csvRows].join('\n');
  const outPath = path.join(__dirname, '..', '..', 'extra_files', 'profiles-full-export.csv');
  fs.writeFileSync(outPath, csv, 'utf8');

  console.log(`✓ Exported ${rows.length} profiles → ${outPath}`);
  await client.end();
}

main().catch(err => {
  console.error('Export failed:', err.message);
  process.exit(1);
});
