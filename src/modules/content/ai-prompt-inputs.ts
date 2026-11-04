/**
 * Prompt inputs that are computed in code, so the LLM never has to guess a
 * number. Every figure the model may quote is listed in a «facts» block, and
 * the writing rules are sent as an input variable so the same rules reach every
 * prompt version (base and per-profile).
 */

/** Shared Persian writing rules for every Persian analysis prompt. */
export const PERSIAN_WRITING_RULES = [
  'فقط به فارسی معیار و رسمی بنویس؛ جمله‌ها کوتاه و روشن باشند و از ترجمهٔ تحت‌اللفظی و واژه‌های انگلیسی پرهیز کن.',
  'هیچ واقعیت، نام، رویداد یا عددی را که در داده‌ها نیامده از خودت نساز. اگر داده برای نتیجه‌گیری کافی نیست، صریحاً بنویس «داده کافی نیست».',
  'هر عدد یا درصد را دقیقاً از بخش «واقعیت‌های عددی» بردار و گرد نکن؛ عدد جدید محاسبه یا تخمین نزن.',
  'دربارهٔ محتوای پست‌ها فقط آنچه را که در نمونهٔ پست‌ها آمده گزارش کن و نقل‌قول مستقیم طولانی نیاور.',
  'نیم‌فاصله را رعایت کن، مانند «می‌شود»، «نمی‌کند»، «پست‌ها»، «مهم‌ترین» و «شبکه‌های اجتماعی».',
  'از «ی» و «ک» فارسی استفاده کن (نه ي و ك عربی) و از نشانه‌های فارسی «،» «؛» «؟» و «٪».',
  'قبل از نشانه‌های نگارشی فاصله نگذار و بعد از آن‌ها یک فاصله بگذار.',
  'از قالب‌بندی مارک‌داون (ستاره، #، خط تیره، شماره‌گذاری) استفاده نکن.',
].map((r, i) => `${i + 1}. ${r}`).join('\n');

export interface SummaryFactsInput {
  periodFrom: Date | null;
  periodTo: Date | null;
  total: number;
  positive: number;
  negative: number;
  neutral: number;
  platforms: Array<{ source: string; count: number; positive: number; negative: number; views: number }>;
  hashtags: Array<{ tag: string; count: number }>;
  topics: Array<{ topic: string; count: number; negative: number }>;
}

export const SOURCE_LABELS_FA: Record<string, string> = {
  twitter: 'ایکس (توییتر)',
  telegram: 'تلگرام',
  instagram: 'اینستاگرام',
  news: 'خبرگزاری‌ها',
  newspaper: 'روزنامه‌ها',
  media: 'صداوسیما',
  bale: 'بله',
  rubika: 'روبیکا',
  eitaa: 'ایتا',
  aparat: 'آپارات',
  youtube: 'یوتیوب',
  forum: 'انجمن‌ها',
};

/** Rounded share in percent, one decimal when below 10. */
export function share(n: number, total: number): number {
  if (!total) return 0;
  const p = (n / total) * 100;
  return p < 10 ? Math.round(p * 10) / 10 : Math.round(p);
}

/** Tehran calendar date: «۱۴۰۵/۰۸/۱۳ (2026-11-04)». */
export function formatDualDate(d: Date): string {
  const fa = d.toLocaleDateString('fa-IR-u-ca-persian', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const iso = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
  return `${fa} (${iso})`;
}

/**
 * Builds the «واقعیت‌های عددی» block for the summary prompt and returns the
 * list of numbers the model is allowed to quote (for the grounding check).
 */
export function buildSummaryFacts(f: SummaryFactsInput): { text: string; numbers: number[] } {
  const numbers: number[] = [];
  const n = (v: number) => {
    numbers.push(v);
    return v.toLocaleString('en-US');
  };
  const lines: string[] = [];
  if (f.periodFrom && f.periodTo) {
    lines.push(`بازهٔ زمانی پست‌ها: از ${formatDualDate(f.periodFrom)} تا ${formatDualDate(f.periodTo)}`);
  }
  lines.push(`تعداد کل پست‌های تحلیل‌شده (بدون صفحات رسمی): ${n(f.total)}`);
  lines.push(
    `احساسات: مثبت ${n(f.positive)} پست (${n(share(f.positive, f.total))}٪)، منفی ${n(f.negative)} پست (${n(share(f.negative, f.total))}٪)، خنثی ${n(f.neutral)} پست (${n(share(f.neutral, f.total))}٪)`,
  );
  if (f.platforms.length) {
    lines.push('سهم پلتفرم‌ها:');
    for (const p of f.platforms) {
      lines.push(
        `- ${SOURCE_LABELS_FA[p.source] || p.source}: ${n(p.count)} پست (${n(share(p.count, f.total))}٪ کل)، مثبت ${n(p.positive)}، منفی ${n(p.negative)}، بازدید ${n(p.views)}`,
      );
    }
  }
  if (f.topics.length) {
    lines.push('پرتکرارترین موضوعات (برچسب خودکار هر پست):');
    for (const t of f.topics) {
      lines.push(`- ${t.topic}: ${n(t.count)} پست (${n(share(t.count, f.total))}٪)، از این میان ${n(t.negative)} پست منفی`);
    }
  }
  if (f.hashtags.length) {
    lines.push(`هشتگ‌های پرتکرار: ${f.hashtags.map((h) => `#${h.tag} (${n(h.count)})`).join('، ')}`);
  }
  return { text: lines.join('\n'), numbers };
}

/** Output contract for dashboard_ai_summary, sent as {{output_format}}. */
export const AI_SUMMARY_OUTPUT_FORMAT = `فقط یک شیء JSON برگردان، بدون هیچ متن دیگر:
{"summary": "سه بند کوتاه که با \\n\\n از هم جدا شده‌اند"}
بند ۱ — وضعیت کلی: حجم پست‌ها و توزیع احساسات با درصدهای داده‌شده.
بند ۲ — موضوعات و پلتفرم‌ها: دو یا سه موضوع غالب و پلتفرم پرحجم، با ارجاع به محتوای نمونهٔ پست‌ها.
بند ۳ — مهم‌ترین هشدار یا فرصت برای شخصیت، فقط اگر داده از آن پشتیبانی کند.
کل متن حداکثر ۱۲۰ واژه.`;
