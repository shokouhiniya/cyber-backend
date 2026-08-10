/**
 * profile-content-export.js
 *
 * For every active profile:
 *   1. Fetches top posts from each source (past quarter, source-specific sort)
 *   2. Applies internal filters (language, hashtag spam, STT)
 *   3. Saves a per-profile CSV with full post content
 *   4. Builds a summary statistics spreadsheet
 *
 * Sort strategy per source:
 *   telegram   → reactions
 *   instagram  → likes
 *   twitter    → comments
 *   media      → views
 *   newspaper  → recent
 *   news       → views
 *   bale       → engagement
 *   rubika     → views
 *   aparat     → engagement
 *   forum      → views
 *
 * Eitaa is excluded entirely.
 *
 * Outputs:
 *   extra_files/profile-posts/<slug>.csv   — per-profile post content
 *   extra_files/profile-stats.csv          — summary statistics
 *
 * Usage:  node scripts/profile-content-export.js
 * Resume: safe to re-run — skips profiles whose CSV already exists
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');
const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const DOMAIN  = 'https://d1.8tag.ir';
const RANGE   = 'custom'; // past quarter (90 days) via since/max
const SINCE_TS = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60; // 90 days ago
const SIZE    = 100;

const SOURCE_SORT = {
  telegram:  'reactions',
  instagram: 'likes',
  twitter:   'comments',
  media:     'views',
  newspaper: 'recent',
  news:      'views',
  bale:      'engagement',
  rubika:    'views',
  aparat:    'engagement',
  forum:     'views',
};
const SOURCES = Object.keys(SOURCE_SORT);

const OUT_DIR   = path.join(__dirname, '../../extra_files/profile-posts');
const STATS_OUT = path.join(__dirname, '../../extra_files/profile-stats.csv');

// ── Internal filters ──────────────────────────────────────────────────────────

function isKurdish(t) {
  if (!t || t.length < 5) return false;
  if (/[\u06A4\u06CE\u06C6]/.test(t)) return true;
  return (t.match(/[\u06B5\u0695\u06D5]/g) || []).length >= 2;
}
function isUrdu(t) { return !!(t && t.length >= 5 && /[\u06D2\u06BA\u0679\u0688\u0691]/.test(t)); }
function isArabic(t) {
  if (!t || t.length < 10 || isKurdish(t) || isUrdu(t)) return false;
  const fa = (t.match(/[\u06A9\u06AF\u0686\u067E\u0698\u06CC\u06F0-\u06F9]/g) || []).length;
  const ar = (t.match(/[\u0643\u064A\u0629\u0649\u0626\u0624]/g) || []).length;
  if (!ar) return false;
  if (!fa) return true;
  return ar / fa >= 3;
}
function isNonPersian(t) { return isKurdish(t) || isUrdu(t) || isArabic(t); }
function isGarbledStt(t) {
  if (!t) return false;
  const w = t.trim().split(/\s+/).filter(Boolean);
  if (w.length < 10) return false;
  const avg = w.reduce((s, x) => s + x.length, 0) / w.length;
  const short = w.filter(x => x.length <= 3).length / w.length;
  return avg < 3.5 && short > 0.60;
}
function passes(item, source) {
  const t = item.text || '';
  if (isNonPersian(t)) return false;
  const s = Array.isArray(item.hashtags) ? item.hashtags.length : 0;
  const i = (t.match(/#[\u0600-\u06FF\w]+/g) || []).length;
  if (Math.max(s, i) > 10) return false;
  if (source === 'media' && isGarbledStt(t)) return false;
  return true;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function esc(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/[\r\n]+/g, ' ');
  return (s.includes(',') || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCsv(filePath, rows, header) {
  const lines = ['\uFEFF' + header.join(',')];
  for (const r of rows) lines.push(header.map(k => esc(r[k])).join(','));
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

// ── API ───────────────────────────────────────────────────────────────────────

let _token = null;
async function getToken() {
  if (_token) return _token;
  const r = await axios.post(`${DOMAIN}/api/v4/login`,
    { username: process.env.HASHTAG_USERNAME, password: process.env.HASHTAG_PASSWORD },
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (r.data.status !== 200) throw new Error('Login failed: ' + r.data.error);
  _token = r.data.result;
  return _token;
}

async function fetchSource(source, or_, not_) {
  const token = await getToken();
  const payload = {
    token, source,
    sort: SOURCE_SORT[source],
    range: RANGE,
    size: SIZE,
    lang: 'fa',
    forward: 'false',
    retweet: 'false',
    since: SINCE_TS,
    max: Math.floor(Date.now() / 1000),
  };
  if (or_) payload.or = or_;
  if (not_) payload.not = not_;

  const r = await axios.post(`${DOMAIN}/api/v4/search`, payload,
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );
  return { total: r.data.total || 0, items: r.data.result || [] };
}

// ── Map raw item to normalised post ──────────────────────────────────────────

function mapItem(item, source) {
  const text = item.text || item.caption || '';
  const views = item.views || item.impression || item.viewCount || item.view_count || item.video_view_count || item.metadata?.views || 0;
  const likes = item.total_reactions || item.likesCount || item.like_count || item.likes || item.favorite_count || 0;
  const forwards = item.forwards || item.retweet_count || 0;
  const comments = item.comments_count || item.commentsCount || item.comment_count || item.reply_count || 0;
  const screenName =
    item.peer_username || item.peer_title ||
    item.channel?.username || item.channel?.title ||
    item.peer?.username || item.peer?.title ||
    item.username || item.user_name || item.user_screen_name ||
    item.channel?.id || '';
  const publishedAt = item.timestamp
    ? new Date(item.timestamp * 1000).toISOString()
    : (item.date || item.created_at || '');
  const url = item.record_index || item.url || item.publisher_url || '';
  const sentiment = item.sentiment !== null && item.sentiment !== undefined ? item.sentiment : '';

  return { source, screenName, publishedAt, text, views, likes, forwards, comments, sentiment, url };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Load profiles
  const profilesRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'profiles-data.json'), 'utf8'));
  const profiles = profilesRaw.map(p => ({
    name: p.name,
    slug: p.promtic_identifier?.external_id || p.name.replace(/\s+/g, '_'),
    or: (p.keywords || []).join('|'),
    not: (p.excluded_keywords || []).join('|'),
  })).filter(p => p.or); // skip profiles with no keywords

  console.log(`Loaded ${profiles.length} profiles.\n`);
  await getToken();
  console.log('Token acquired.\n');

  // Stats header
  const statsHeader = [
    'پروفایل',
    ...SOURCES.flatMap(s => [
      `${s}_total`,
      `${s}_shown`,
      `${s}_pass_pct`,
      `${s}_top_views`,
      `${s}_avg_views`,
    ]),
    'total_all_sources',
    'shown_all_sources',
    'overall_pass_pct',
    'source_with_most_content',
    'source_with_most_views',
  ];

  // Load already-done profiles
  const doneProfiles = new Set();
  const statsRows = [];
  if (fs.existsSync(STATS_OUT)) {
    const lines = fs.readFileSync(STATS_OUT, 'utf8').replace(/^\uFEFF/, '').split('\n').filter(Boolean);
    for (let i = 1; i < lines.length; i++) {
      const name = lines[i].split(',')[0].replace(/^"|"$/g, '');
      if (name) doneProfiles.add(name);
    }
    console.log(`Resuming — ${doneProfiles.size} profiles already done.\n`);
  } else {
    fs.writeFileSync(STATS_OUT, '\uFEFF' + statsHeader.join(',') + '\n', 'utf8');
  }

  for (const profile of profiles) {
    const csvPath = path.join(OUT_DIR, `${profile.slug}.csv`);

    if (doneProfiles.has(profile.name) && fs.existsSync(csvPath)) {
      console.log(`SKIP ${profile.name}`);
      continue;
    }

    console.log(`\n▶ ${profile.name}`);
    const allPosts = [];
    const statsRow = { 'پروفایل': profile.name };
    let grandTotal = 0, grandShown = 0;
    const sourceShown = {};
    const sourceViews = {};

    for (const source of SOURCES) {
      process.stdout.write(`  ${source} ... `);
      try {
        const { total, items } = await fetchSource(source, profile.or, profile.not || undefined);
        const filtered = items.filter(item => passes(item, source));
        const mapped = filtered.map(item => mapItem(item, source));

        const shown = mapped.length;
        const passPct = total > 0 ? Math.round(shown / Math.min(total, SIZE) * 100) : 0;
        const views = mapped.map(p => +p.views || 0);
        const topViews = views.length ? Math.max(...views) : 0;
        const avgViews = views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : 0;

        statsRow[`${source}_total`]    = total;
        statsRow[`${source}_shown`]    = shown;
        statsRow[`${source}_pass_pct`] = passPct + '%';
        statsRow[`${source}_top_views`] = topViews;
        statsRow[`${source}_avg_views`] = avgViews;

        grandTotal += total;
        grandShown += shown;
        sourceShown[source] = shown;
        sourceViews[source] = topViews;

        allPosts.push(...mapped);
        process.stdout.write(`${shown}/${total} (${passPct}%) top_views=${topViews.toLocaleString()}\n`);
      } catch (e) {
        statsRow[`${source}_total`]    = 'ERR';
        statsRow[`${source}_shown`]    = 'ERR';
        statsRow[`${source}_pass_pct`] = 'ERR';
        statsRow[`${source}_top_views`] = 'ERR';
        statsRow[`${source}_avg_views`] = 'ERR';
        sourceShown[source] = 0;
        sourceViews[source] = 0;
        process.stdout.write(`ERR: ${e.message}\n`);
      }
      await new Promise(r => setTimeout(r, 400));
    }

    statsRow['total_all_sources']  = grandTotal;
    statsRow['shown_all_sources']  = grandShown;
    statsRow['overall_pass_pct']   = grandTotal > 0 ? Math.round(grandShown / Math.min(grandTotal, SIZE * SOURCES.length) * 100) + '%' : '0%';
    statsRow['source_with_most_content'] = Object.entries(sourceShown).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    statsRow['source_with_most_views']   = Object.entries(sourceViews).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    // Append stats row
    const statsLine = statsHeader.map(k => esc(statsRow[k])).join(',');
    fs.appendFileSync(STATS_OUT, statsLine + '\n', 'utf8');

    // Write per-profile post CSV
    const postHeader = ['source', 'screenName', 'publishedAt', 'views', 'likes', 'forwards', 'comments', 'sentiment', 'text', 'url'];
    // Sort by views desc for readability
    allPosts.sort((a, b) => (+b.views || 0) - (+a.views || 0));
    writeCsv(csvPath, allPosts, postHeader);

    const totalChars = allPosts.reduce((s, p) => s + (p.text || '').length, 0);
    const approxTokens = Math.round(totalChars / 3.5);
    console.log(`  → ${allPosts.length} posts saved | ~${approxTokens.toLocaleString()} tokens | ${csvPath}`);
  }

  console.log(`\n✓ All done.\nStats: ${STATS_OUT}\nPosts: ${OUT_DIR}/`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
