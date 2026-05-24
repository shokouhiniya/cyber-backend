/**
 * export-ashna-posts.js
 *
 * Fetches all posts for حسام‌الدین آشنا from the past week,
 * excluding eitaa, and exports to a CSV file.
 *
 * Usage: node scripts/export-ashna-posts.js
 * Output: extra_files/ashna-posts-week.csv
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const DOMAIN = 'https://d1.8tag.ir';
const SOURCES = ['telegram', 'bale', 'rubika', 'twitter', 'instagram', 'news', 'newspaper', 'media', 'forum', 'aparat'];
const OR = 'حسام الدین آشنا|حسام آشنا|آشنا مشاور روحانی|آشنا دولت روحانی|رئیس مرکز استراتژیک دولت روحانی';
const NOT = '';
const OUT = path.join(__dirname, '../../extra_files/ashna-posts-week.csv');

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

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\r/g, ' ');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Login
  const loginRes = await axios.post(`${DOMAIN}/api/v4/login`,
    { username: process.env.HASHTAG_USERNAME, password: process.env.HASHTAG_PASSWORD },
    { headers: { 'Content-Type': 'application/json' } }
  );
  if (loginRes.data.status !== 200) throw new Error('Login failed: ' + loginRes.data.error);
  const token = loginRes.data.result;
  console.log('Token acquired.\n');

  const allPosts = [];

  for (const source of SOURCES) {
    process.stdout.write(`Fetching ${source} ... `);
    let page = 0;
    let lastTimestamp = null;
    let totalFetched = 0;
    let totalFromApi = 0;

    while (true) {
      const payload = {
        token, source, sort: 'recent', range: page === 0 ? 'week' : 'custom',
        size: 100, lang: 'fa', forward: 'false', retweet: 'false',
        or: OR,
      };
      if (NOT) payload.not = NOT;
      if (page > 0 && lastTimestamp) {
        payload.since = 0;
        payload.max = lastTimestamp - 1;
      }

      try {
        const r = await axios.post(`${DOMAIN}/api/v4/search`, payload,
          { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        const items = r.data.result || [];
        if (page === 0) totalFromApi = r.data.total || 0;

        if (!items.length) break;

        const filtered = items.filter(item => passes(item, source));
        for (const item of filtered) {
          allPosts.push({
            source,
            id: item.id || item.record_index || '',
            publishedAt: item.timestamp ? new Date(item.timestamp * 1000).toISOString() : (item.date || ''),
            screenName: item.peer_username || item.peer_title || item.channel?.username || item.channel?.title || item.peer?.username || item.peer?.title || item.username || '',
            text: item.text || '',
            views: item.views || item.impression || 0,
            likes: item.total_reactions || item.likesCount || item.like_count || item.likes || 0,
            forwards: item.forwards || item.retweet_count || 0,
            comments: item.comments_count || item.commentsCount || item.comment_count || 0,
            sentiment: item.sentiment !== null && item.sentiment !== undefined ? item.sentiment : '',
            url: item.record_index || item.url || '',
          });
        }

        totalFetched += items.length;
        const lastItem = items[items.length - 1];
        lastTimestamp = lastItem?.timestamp || null;

        process.stdout.write(`p${page + 1}(${filtered.length}/${items.length}) `);

        // Stop if we got fewer than 100 (last page) or no timestamp to paginate
        if (items.length < 100 || !lastTimestamp) break;
        page++;
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        process.stdout.write(`ERR(${e.message}) `);
        break;
      }
    }

    console.log(`→ total API: ${totalFromApi}`);
  }

  // Write CSV
  const header = ['source', 'id', 'publishedAt', 'screenName', 'text', 'views', 'likes', 'forwards', 'comments', 'sentiment', 'url'];
  const lines = ['\uFEFF' + header.join(',')];
  for (const p of allPosts) {
    lines.push(header.map(k => csvEscape(p[k])).join(','));
  }
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');

  console.log(`\nTotal posts exported: ${allPosts.length}`);
  console.log(`File: ${OUT}`);

  // Token cost estimate
  const totalChars = allPosts.reduce((s, p) => s + (p.text || '').length, 0);
  const approxTokens = Math.round(totalChars / 3.5); // ~3.5 Persian chars per token
  console.log(`\nApprox total text chars: ${totalChars.toLocaleString()}`);
  console.log(`Approx tokens (Persian ~3.5 chars/token): ${approxTokens.toLocaleString()}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
