/**
 * «وضعیت کلان کشور»: pure helpers for the daily macro briefing.
 *
 * - prompt variables with explicit today / yesterday dates (both calendars)
 * - parsing the model's reply into four short sections
 * - dropping events older than yesterday (Tehran) or without a valid date
 * - dropping events already shown in the previous days (the 7-day trend)
 * - ranking / filtering the shared briefing per profile (role + keywords)
 */

import { normalizePersianText, parseLlmJson } from '../content/persian-text';
import { PERSIAN_WRITING_RULES } from '../content/ai-prompt-inputs';
import { tokenize } from '../content/narrative-gap';

export const MACRO_SECTIONS = [
  { key: 'cultural_social', label: 'فرهنگی، اجتماعی' },
  { key: 'political_diplomatic', label: 'سیاسی، دیپلماتیک' },
  { key: 'security_military', label: 'امنیتی، نظامی' },
  { key: 'economic_livelihood', label: 'اقتصادی، معیشتی' },
] as const;

export type MacroSectionKey = (typeof MACRO_SECTIONS)[number]['key'];
export type Severity = 'high' | 'medium' | 'low';

export interface MacroEvent {
  title: string;
  summary: string | null;
  /** Tehran calendar day, YYYY-MM-DD; null only for legacy (pre-v1.2) replies */
  date: string | null;
  actor: string | null;
  severity: Severity;
}

export interface MacroBriefing {
  version: 2;
  generatedAt: string;
  window: { from: string; to: string };
  sections: Record<MacroSectionKey, MacroEvent[]>;
  /** true when the reply had no per-event dates (old prompt version) */
  legacy?: boolean;
}

export const MAX_EVENTS_PER_SECTION = 4;
const SECTION_KEYS = MACRO_SECTIONS.map((s) => s.key) as MacroSectionKey[];

// ── Dates ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86400_000;

/** YYYY-MM-DD of `d` in Tehran. */
export function tehranDay(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
}

export function tehranJalali(d: Date): string {
  return d.toLocaleDateString('fa-IR-u-ca-persian', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  });
}

function tehranJalaliLong(d: Date): string {
  return d.toLocaleDateString('fa-IR-u-ca-persian', {
    timeZone: 'Asia/Tehran', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

/** Jalali → Gregorian (the classic jdf algorithm). */
export function jalaliToGregorian(jy: number, jm: number, jd: number): [number, number, number] {
  jy += 1595;
  let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd
    + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < 12 && gd > monthDays[gm]) gd -= monthDays[gm++];
  return [gy, gm + 1, gd];
}

const pad = (n: number) => String(n).padStart(2, '0');
const latinDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

/** An event date in ISO or Jalali form (Latin or Persian digits) → YYYY-MM-DD, or null. */
export function parseEventDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const m = latinDigits(value).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return null;
  let [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (y >= 1300 && y <= 1500) [y, mo, d] = jalaliToGregorian(y, mo, d);
  else if (y < 1900 || y > 2200) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

// ── Prompt variables ──────────────────────────────────────────────────────────

export const MACRO_OUTPUT_FORMAT = `فقط یک شیء JSON برگردان، بدون هیچ متن دیگر و بدون ارجاع [1]:
{"sections": {
  "cultural_social": [{"title": "عنوان خبری کوتاه", "summary": "یک جملهٔ کوتاه", "date": "YYYY-MM-DD", "actor": "نهاد یا شخص اصلی", "severity": "high|medium|low"}],
  "political_diplomatic": [...],
  "security_military": [...],
  "economic_livelihood": [...]
}}
- هر بخش ۲ تا ۴ رویداد؛ اگر رویداد مهم و تازه‌ای در یک بخش نیست، آرایهٔ خالی بگذار.
- date تاریخ میلادی وقوع یا انتشار خبر است و فقط می‌تواند امروز یا دیروز باشد.
- severity: high = بحرانی یا اثرگذار ملی، medium = مهم، low = قابل توجه.`;

export function buildMacroPromptVars(now: Date, previousHeadlines: string[] = []) {
  const yesterday = new Date(now.getTime() - DAY_MS);
  const today = { iso: tehranDay(now), fa: tehranJalali(now), long: tehranJalaliLong(now) };
  const yest = { iso: tehranDay(yesterday), fa: tehranJalali(yesterday), long: tehranJalaliLong(yesterday) };
  return {
    // v1.1 only read {{date}} — give it the explicit window too
    date: `${today.long} (${today.iso}). فقط رویدادهای امروز و دیروز (${yest.long}، ${yest.iso}) را گزارش کن.`,
    today_date: today.iso,
    today_jalali: today.fa,
    today_long: today.long,
    yesterday_date: yest.iso,
    yesterday_jalali: yest.fa,
    yesterday_long: yest.long,
    sections_spec: MACRO_SECTIONS.map((s) => `${s.key}: ${s.label}`).join('\n'),
    previous_headlines: previousHeadlines.length ? previousHeadlines.map((h) => `- ${h}`).join('\n') : '(ندارد)',
    output_format: MACRO_OUTPUT_FORMAT,
    writing_rules: PERSIAN_WRITING_RULES,
  };
}

// ── Parsing ───────────────────────────────────────────────────────────────────

const SECTION_ALIASES: Record<string, MacroSectionKey> = {
  cultural_social: 'cultural_social', cultural: 'cultural_social', social: 'cultural_social',
  'فرهنگی، اجتماعی': 'cultural_social', 'فرهنگی-اجتماعی': 'cultural_social', فرهنگی: 'cultural_social', اجتماعی: 'cultural_social',
  political_diplomatic: 'political_diplomatic', political: 'political_diplomatic', diplomatic: 'political_diplomatic', foreign: 'political_diplomatic',
  'سیاسی، دیپلماتیک': 'political_diplomatic', 'سیاسی-دیپلماتیک': 'political_diplomatic', سیاسی: 'political_diplomatic',
  security_military: 'security_military', security: 'security_military', military: 'security_military',
  'امنیتی، نظامی': 'security_military', 'امنیتی-نظامی': 'security_military', امنیتی: 'security_military',
  economic_livelihood: 'economic_livelihood', economic: 'economic_livelihood', economy: 'economic_livelihood',
  'اقتصادی، معیشتی': 'economic_livelihood', 'اقتصادی-معیشتی': 'economic_livelihood', اقتصادی: 'economic_livelihood',
};

/** Keyword classifier for replies that come as one flat event list. */
const SECTION_KEYWORDS: Array<[MacroSectionKey, RegExp]> = [
  ['security_military', /سپاه|ارتش|نظامی|امنیت|حمله|موشک|پهپاد|تروریس|انفجار|مرز|دفاع|انتظامی|بازداشت|جاسوس|رزمایش|پدافند/],
  ['economic_livelihood', /اقتصاد|تورم|قیمت|دلار|ارز|بورس|بودجه|یارانه|حقوق|دستمزد|مسکن|اجاره|بنزین|سوخت|نفت|گرانی|معیشت|بانک|مالیات|تحریم.*اقتصاد|صادرات|واردات/],
  ['political_diplomatic', /مذاکره|دیپلما|وزیر خارجه|سفیر|سازمان ملل|تحریم|آژانس|برجام|مجلس|دولت|رئیس‌?جمهور|انتخابات|استیضاح|لایحه|شورای|سیاسی/],
  ['cultural_social', /فرهنگ|اجتماع|آموزش|دانشگاه|مدرسه|حجاب|سینما|ورزش|سلامت|بهداشت|زلزله|سیل|آلودگی|فیلترینگ|اینترنت|مهاجرت|زنان|جوانان/],
];

export function classifySection(text: string): MacroSectionKey {
  for (const [key, re] of SECTION_KEYWORDS) if (re.test(text)) return key;
  return 'political_diplomatic';
}

function toEvent(raw: any): (MacroEvent & { rawDate: unknown }) | null {
  if (!raw || typeof raw !== 'object') return null;
  const title = normalizePersianText(String(raw.title ?? raw.headline ?? raw.event ?? '')).slice(0, 160);
  if (!title) return null;
  const summary = raw.summary ?? raw.description ?? raw.detail;
  const sev = String(raw.severity ?? raw.importance ?? '').toLowerCase();
  return {
    title,
    summary: summary ? normalizePersianText(String(summary)).slice(0, 320) : null,
    date: parseEventDate(raw.date ?? raw.event_date ?? raw.published_at),
    rawDate: raw.date ?? raw.event_date ?? raw.published_at,
    actor: raw.actor ? normalizePersianText(String(raw.actor)).slice(0, 80) : null,
    severity: sev === 'high' || sev === 'low' ? (sev as Severity) : 'medium',
  };
}

/** Similarity of two headlines (Jaccard over content words). */
export function headlineSimilarity(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export const DUPLICATE_SIMILARITY = 0.5;

export interface ParseStats {
  received: number;
  kept: number;
  droppedOld: number;
  droppedUndated: number;
  droppedDuplicate: number;
}

/**
 * Model reply → briefing. Accepts the v1.2 shape ({sections:{key:[...]}}),
 * sections at the top level, or the legacy flat {events:[...]} list.
 *
 * Dated replies: events dated before yesterday (Tehran) or without a valid
 * date are dropped; a date up to one day ahead (time-zone skew) counts as today.
 * Legacy replies have no dates at all; their events are kept but the briefing
 * is flagged `legacy` so the UI can say the dates are unverified.
 */
export function parseMacroReply(
  raw: string,
  now: Date,
  previousHeadlines: string[] = [],
): { briefing: MacroBriefing; stats: ParseStats } {
  const parsed = parseLlmJson(raw);
  const today = tehranDay(now);
  const yesterday = tehranDay(new Date(now.getTime() - DAY_MS));
  const tomorrow = tehranDay(new Date(now.getTime() + DAY_MS));

  const buckets: Record<MacroSectionKey, any[]> = {
    cultural_social: [], political_diplomatic: [], security_military: [], economic_livelihood: [],
  };
  const src = parsed?.sections && typeof parsed.sections === 'object' ? parsed.sections : parsed;
  let structured = false;
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [k, v] of Object.entries(src)) {
      const key = SECTION_ALIASES[k] || SECTION_ALIASES[k.trim()];
      if (key && Array.isArray(v)) {
        buckets[key].push(...v);
        structured = true;
      }
    }
  }
  const flat: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.events) ? parsed.events : [];
  for (const ev of flat) {
    const key = SECTION_ALIASES[String(ev?.section ?? ev?.category ?? '')]
      || classifySection(`${ev?.title ?? ''} ${ev?.summary ?? ''} ${ev?.actor ?? ''}`);
    buckets[key].push(ev);
  }

  const stats: ParseStats = { received: 0, kept: 0, droppedOld: 0, droppedUndated: 0, droppedDuplicate: 0 };
  const all = SECTION_KEYS.flatMap((k) => buckets[k]).map(toEvent).filter(Boolean);
  const anyDated = all.some((e) => e!.date);
  const legacy = !structured && !anyDated;

  const seen: string[] = [];
  const sections = {} as Record<MacroSectionKey, MacroEvent[]>;
  for (const key of SECTION_KEYS) {
    const out: MacroEvent[] = [];
    for (const rawEv of buckets[key]) {
      const ev = toEvent(rawEv);
      if (!ev) continue;
      stats.received++;
      if (!legacy) {
        if (!ev.date) { stats.droppedUndated++; continue; }
        if (ev.date < yesterday || ev.date > tomorrow) { stats.droppedOld++; continue; }
        if (ev.date > today) ev.date = today;
      }
      const dup = (h: string) => headlineSimilarity(h, ev.title) >= DUPLICATE_SIMILARITY;
      if (seen.some(dup) || previousHeadlines.some(dup)) { stats.droppedDuplicate++; continue; }
      seen.push(ev.title);
      const { rawDate: _ignored, ...clean } = ev;
      out.push(clean);
    }
    const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
    out.sort((a, b) => (b.date || '').localeCompare(a.date || '') || order[a.severity] - order[b.severity]);
    sections[key] = out.slice(0, MAX_EVENTS_PER_SECTION + 1);
    stats.kept += sections[key].length;
  }

  return {
    briefing: {
      version: 2,
      generatedAt: now.toISOString(),
      window: { from: yesterday, to: today },
      sections,
      ...(legacy ? { legacy: true } : {}),
    },
    stats,
  };
}

export function briefingHeadlines(b: Pick<MacroBriefing, 'sections'> | null | undefined): string[] {
  if (!b?.sections) return [];
  return SECTION_KEYS.flatMap((k) => (b.sections[k] || []).map((e) => e.title));
}

export function countEvents(b: Pick<MacroBriefing, 'sections'>): number {
  return SECTION_KEYS.reduce((s, k) => s + (b.sections[k]?.length || 0), 0);
}

/** Converts a pre-v2 stored value ({events,tensions,...}) for display. */
export function legacyToBriefing(value: string | null, updatedAt: Date | null): MacroBriefing | null {
  if (!value) return null;
  const parsed = parseLlmJson(value);
  if (parsed?.version === 2 && parsed.sections) return parsed as MacroBriefing;
  if (!parsed) return null;
  const at = updatedAt || new Date();
  const { briefing } = parseMacroReply(JSON.stringify(parsed), at);
  return countEvents(briefing) ? { ...briefing, legacy: true } : null;
}

// ── Per-profile relevance ─────────────────────────────────────────────────────

/** Which sections a role usually cares about most. */
const ROLE_AFFINITY: Array<[RegExp, MacroSectionKey[]]> = [
  [/سپاه|ارتش|نظامی|دفاع|امنیت|انتظامی|فرمانده|پدافند|اطلاعات|ستاد کل/, ['security_military', 'political_diplomatic']],
  [/خارجه|دیپلما|سفیر|روابط بین/, ['political_diplomatic', 'security_military']],
  [/اقتصاد|دارایی|بانک|بودجه|نفت|صنعت|تجارت|کار و رفاه|رفاه|مسکن|راه و شهرسازی|کشاورزی|نیرو|برنامه|سازمان برنامه|گمرک|مالیات/, ['economic_livelihood']],
  [/فرهنگ|ارشاد|آموزش|علوم|بهداشت|درمان|ورزش|جوانان|زنان|خانواده|میراث|صداوسیما|صدا و سیما|رسانه|حوزه|تبلیغات/, ['cultural_social']],
  [/مجلس|نماینده|رئیس‌?جمهور|ریاست جمهوری|معاون اول|دولت|قوه|قضائیه|شورای|استاندار|شهردار|وزیر کشور/, ['political_diplomatic', 'economic_livelihood']],
];

export interface ProfileLens {
  name?: string | null;
  role?: string | null;
  organization?: string | null;
  keywords?: string[] | null;
}

export function profileAffinity(p: ProfileLens): Set<MacroSectionKey> {
  const text = `${p.role || ''} ${p.organization || ''}`;
  const out = new Set<MacroSectionKey>();
  for (const [re, keys] of ROLE_AFFINITY) if (re.test(text)) keys.forEach((k) => out.add(k));
  return out;
}

/** Words in titles of office that say nothing about the topic. */
const ROLE_GENERIC = new Set(
  'رئیس ریاست معاون مشاور دبیر عضو شورای شورا اسلامی جمهوری ملی کل سازمان وزارت وزیر نهاد ستاد مرکز اداره کمیسیون'.split(' '),
);

export interface RankedEvent extends MacroEvent {
  relevance: number;
  relevant: boolean;
  matched: string[];
}

/**
 * Ranks the shared briefing for one profile: direct mentions of the profile's
 * name / keywords weigh most, then its role / organisation words, then the
 * role's usual sections and the event's severity. Each section keeps its top
 * MAX_EVENTS_PER_SECTION events; `relevant` marks direct matches.
 */
export function rankForProfile(b: MacroBriefing, p: ProfileLens) {
  const direct = new Set<string>();
  for (const v of [p.name, ...(p.keywords || [])]) for (const t of tokenize(v || '')) direct.add(t);
  const roleWords = new Set<string>(
    tokenize(`${p.role || ''} ${p.organization || ''}`).filter((t) => !direct.has(t) && !ROLE_GENERIC.has(t)),
  );
  const affinity = profileAffinity(p);
  const sevBoost: Record<Severity, number> = { high: 1.5, medium: 0.5, low: 0 };

  const sections = MACRO_SECTIONS.map(({ key, label }) => {
    const events: RankedEvent[] = (b.sections[key] || []).map((e) => {
      const words = new Set(tokenize(`${e.title} ${e.summary || ''} ${e.actor || ''}`));
      const hitsDirect = [...direct].filter((t) => words.has(t));
      const hitsRole = [...roleWords].filter((t) => words.has(t));
      const relevance = Math.min(3, hitsDirect.length) * 3 + Math.min(3, hitsRole.length) * 2
        + (affinity.has(key) ? 2 : 0) + sevBoost[e.severity];
      return { ...e, relevance, relevant: hitsDirect.length > 0 || hitsRole.length > 0, matched: [...hitsDirect, ...hitsRole] };
    });
    events.sort((a, c) => c.relevance - a.relevance);
    // Section order stays fixed; `priority` marks the sections the role cares about
    return { key, label, priority: affinity.has(key), events: events.slice(0, MAX_EVENTS_PER_SECTION) };
  });
  return sections;
}
