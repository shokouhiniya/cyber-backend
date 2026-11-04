/**
 * Light, deterministic clean-up for Persian text written by an LLM.
 *
 * It does NOT rewrite wording. It only fixes what models get wrong most often:
 *   - Arabic letters (ي ى ك ة‌-less forms) → Persian (ی ک)
 *   - markdown junk (**bold**, # headings, `code`, list bullets, [n] citations)
 *   - spacing around Persian punctuation (، ؛ ؟ . : !)
 *   - Latin punctuation between Persian words (, ; ?) → Persian (، ؛ ؟)
 *   - the most common missing zero-width non-joiners (نیم‌فاصله):
 *       «می / نمی» verb prefixes and «ها / های / هایی / ترین» suffixes
 *   - % after a number → ٪
 */

const ZWNJ = '‌';
/** Persian / Arabic letters only (no digits, so «۳۳.۳» is never split). */
const PERSIAN_LETTER = 'ء-يپچژکگۀ-ی';

/** Arabic → Persian letters and digits that should not survive in Persian prose. */
export function normalizeArabicLetters(text: string): string {
  return text
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[٠-٩]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d.charCodeAt(0) - 0x0660]);
}

/** Removes markdown formatting and citation markers; keeps the words. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,،؛:!؟]|$)/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*(?:[-*•▪◦]|\d+[.)]|[۰-۹]+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[(\d+|[۰-۹]+)\]/g, '')
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, '$1')
    .replace(/[*#]{2,}/g, '');
}

/** Persian punctuation and spacing. */
export function fixPersianSpacing(text: string): string {
  const L = PERSIAN_LETTER;
  let t = text;
  // Latin punctuation directly attached to Persian words → Persian forms
  t = t.replace(new RegExp(`([${L}])\\s*,\\s*`, 'g'), '$1، ');
  t = t.replace(new RegExp(`([${L}])\\s*;\\s*`, 'g'), '$1؛ ');
  t = t.replace(new RegExp(`([${L}])\\s*\\?`, 'g'), '$1؟');
  // Number followed by % → ٪ (no space, Persian style)
  t = t.replace(/([0-9۰-۹])\s*%/g, '$1٪');
  // No space before punctuation, one space after it (unless end / another punct / digit for decimals)
  t = t.replace(/[ \t ]+([،؛؟!:.٪)\]»])/g, '$1');
  t = t.replace(new RegExp(`([،؛؟!])(?=[${L}A-Za-z0-9۰-۹«(])`, 'g'), '$1 ');
  t = t.replace(new RegExp(`([${L}])([.:])(?=[${L}«(])`, 'g'), '$1$2 ');
  // No space just inside guillemets / parentheses
  t = t.replace(/([«(])\s+/g, '$1').replace(/\s+([»)])/g, '$1');
  return t;
}

/** Inserts the zero-width non-joiner where it is almost always required. */
export function fixHalfSpaces(text: string): string {
  const L = PERSIAN_LETTER;
  let t = text;
  // Verb prefixes: «می کند» → «می‌کند», «نمی شود» → «نمی‌شود»
  t = t.replace(new RegExp(`(^|[^${L}])(ن?می)[ ](?=[${L}]{2,})`, 'g'), `$1$2${ZWNJ}`);
  // Plural / superlative suffixes: «کاربر ها» → «کاربر‌ها», «مهم ترین» → «مهم‌ترین»
  t = t.replace(new RegExp(`([${L}])[ ](ها|های|هایی|هایش|هایشان|ترین|تری)(?![${L}])`, 'g'), `$1${ZWNJ}$2`);
  // Clean up ZWNJ misuse: next to spaces, doubled, or at word edges
  t = t.replace(/‌{2,}/g, ZWNJ).replace(/‌(?=\s)|(?<=\s)‌/g, '');
  return t;
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Full clean-up for one Persian string. Safe to run more than once. */
export function normalizePersianText(text: string | null | undefined): string {
  if (!text) return '';
  let t = String(text);
  t = normalizeArabicLetters(t);
  t = stripMarkdown(t);
  t = fixPersianSpacing(t);
  t = fixHalfSpaces(t);
  return collapseWhitespace(t);
}

/** Applies normalizePersianText to every string inside a parsed JSON value. */
export function normalizePersianDeep<T>(value: T): T {
  if (typeof value === 'string') return normalizePersianText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => normalizePersianDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizePersianDeep(v);
    return out as T;
  }
  return value;
}

/**
 * Parses an LLM reply that should be JSON: strips code fences and citation
 * markers, then tries the whole string and finally the outermost {...} / [...].
 * Returns null when nothing parses.
 */
export function parseLlmJson(raw: string | null | undefined): any {
  if (!raw) return null;
  const unfenced = String(raw)
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  // Search-enabled models append citation markers like [1][3]; try with and without them.
  const attempts: string[] = [];
  for (const s of [unfenced, unfenced.replace(/\[\d+\]/g, '')]) {
    attempts.push(s);
    const obj = s.match(/\{[\s\S]*\}/);
    const arr = s.match(/\[[\s\S]*\]/);
    if (obj) attempts.push(obj[0]);
    if (arr) attempts.push(arr[0]);
  }
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch { /* try next */ }
  }
  return null;
}

/** Latin and Persian digits → a JS number (handles ٫ / . decimals, ٪ / % signs). */
export function toLatinNumber(value: string): number {
  const latin = value
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٫]/g, '.')
    .replace(/[٬,]/g, '')
    .replace(/[٪%]/g, '');
  return parseFloat(latin);
}

/**
 * Numbers in `text` that do not appear in `allowed` (± tolerance). Used to
 * flag possibly invented figures in an LLM summary; years and tiny counts
 * (< 3) are ignored because they are usually ordinals or dates.
 */
export function findUngroundedNumbers(text: string, allowed: number[], tolerance = 1): number[] {
  const found = (text.match(/[0-9۰-۹][0-9۰-۹٬,]*(?:[.٫][0-9۰-۹]+)?/g) || []).map(toLatinNumber);
  return [...new Set(found)].filter(
    (n) => Number.isFinite(n) && n >= 3 && !(n >= 1300 && n <= 2100) && !allowed.some((a) => Math.abs(a - n) <= tolerance),
  );
}
