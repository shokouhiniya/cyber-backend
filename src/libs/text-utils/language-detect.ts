/**
 * Language detection utilities for Arabic/Persian/Urdu/Kurdish discrimination.
 *
 * All four languages use the Arabic script block (U+0600–U+06FF), but each
 * has unique characters that reliably identify it.
 *
 * ── Persian-only characters ──────────────────────────────────────────────
 *   ک U+06A9   گ U+06AF   چ U+0686   پ U+067E
 *   ژ U+0698   ی U+06CC   Persian digits ۰-۹ U+06F0–U+06F9
 *
 * ── Arabic-only characters ───────────────────────────────────────────────
 *   ك U+0643   ي U+064A   ة U+0629   ى U+0649   ئ U+0626   ؤ U+0624
 *
 * ── Urdu-only characters ─────────────────────────────────────────────────
 *   ے U+06D2  (ye barree — final ye, extremely common in Urdu)
 *   ں U+06BA  (noon ghunna — nasal n, very common in Urdu)
 *   ٹ U+0679  (te with ring)
 *   ڈ U+0688  (dal with ring)
 *   ڑ U+0691  (re with ring)
 *
 * ── Kurdish (Sorani) characters ──────────────────────────────────────────
 *   ڤ U+06A4  (ve — v sound, very common in Kurdish, absent from Persian/Arabic)
 *   ێ U+06CE  (ye with small v above — Kurdish vowel)
 *   ۆ U+06C6  (oe — Kurdish vowel, absent from Persian)
 *   ڵ U+06B5  (lam with small v — Kurdish lateral)
 *   ڕ U+0695  (re with small v — Kurdish trill)
 *   ە U+06D5  (ae — extremely common Kurdish vowel, rare in Persian)
 *
 * Detection strategy:
 *   1. Kurdish check first: ڤ or ێ or ۆ alone are definitive Kurdish markers.
 *      Two or more of (ە, ڵ, ڕ) also indicate Kurdish.
 *   2. Urdu check: if text contains ے or ں (or ٹ/ڈ/ڑ), it's Urdu.
 *   3. Arabic check: if Arabic-only chars outnumber Persian-only chars by 3:1.
 *   4. Otherwise: Persian (or unknown).
 */

const PERSIAN_CHARS     = /[\u06A9\u06AF\u0686\u067E\u0698\u06CC\u06F0-\u06F9]/g;
const ARABIC_ONLY_CHARS = /[\u0643\u064A\u0629\u0649\u0626\u0624]/g;
const URDU_CHARS        = /[\u06D2\u06BA\u0679\u0688\u0691]/g;

// Definitive Kurdish markers (any one of these = Kurdish)
const KURDISH_DEFINITIVE = /[\u06A4\u06CE\u06C6]/;
// Secondary Kurdish markers (two or more = Kurdish)
const KURDISH_SECONDARY  = /[\u06B5\u0695\u06D5]/g;

/**
 * Returns true if the text is Kurdish (Sorani).
 * ڤ (U+06A4), ێ (U+06CE), ۆ (U+06C6) are definitive — absent from Persian/Arabic/Urdu.
 * Two or more of ڵ ڕ ە also indicate Kurdish.
 */
export function isKurdishText(text: string | null | undefined): boolean {
  if (!text || text.length < 5) return false;
  if (KURDISH_DEFINITIVE.test(text)) return true;
  const secondaryCount = (text.match(KURDISH_SECONDARY) || []).length;
  return secondaryCount >= 2;
}

/**
 * Returns true if the text is Urdu.
 * Urdu-specific characters (ے ں ٹ ڈ ڑ) are absent from Persian and Arabic.
 */
export function isUrduText(text: string | null | undefined): boolean {
  if (!text || text.length < 5) return false;
  return URDU_CHARS.test(text);
}

/**
 * Returns true if the text is primarily Arabic (not Persian/Farsi).
 * A post is classified as Arabic when Arabic-only chars outnumber
 * Persian-only chars by 3:1 or more.
 */
export function isArabicText(text: string | null | undefined): boolean {
  if (!text || text.length < 10) return false;

  // Kurdish/Urdu take priority — don't misclassify them as Arabic
  if (isKurdishText(text) || isUrduText(text)) return false;

  const persianCount = (text.match(PERSIAN_CHARS) || []).length;
  const arabicCount  = (text.match(ARABIC_ONLY_CHARS) || []).length;

  if (arabicCount === 0) return false;
  if (persianCount === 0) return true;

  return arabicCount / persianCount >= 3;
}

/**
 * Returns true if the text should be filtered out when lang=fa is requested.
 * Filters Arabic, Urdu, and Kurdish posts.
 */
export function isNonPersianText(text: string | null | undefined): boolean {
  return isKurdishText(text) || isUrduText(text) || isArabicText(text);
}

/**
 * Returns 'fa', 'ar', 'ur', 'ku', or 'unknown' for a given text.
 * Useful for tagging content at ingestion time.
 */
export function detectLanguage(text: string | null | undefined): 'fa' | 'ar' | 'ur' | 'ku' | 'unknown' {
  if (!text || text.length < 5) return 'unknown';
  if (isKurdishText(text)) return 'ku';
  if (isUrduText(text)) return 'ur';
  if (isArabicText(text)) return 'ar';
  const persianCount = (text.match(PERSIAN_CHARS) || []).length;
  if (persianCount > 0) return 'fa';
  return 'unknown';
}

/**
 * Returns true if the text looks like garbled speech-to-text output.
 *
 * Bad STT transcripts from media sources (TV/radio) have two reliable signals:
 *   1. Very short average word length — real Persian prose averages ~4-5 chars/word.
 *      STT noise averages ~2.5-3 chars/word (e.g. "ای لدا په نوی لذا").
 *   2. High short-word ratio — >60% of words are ≤3 characters.
 *
 * Thresholds are intentionally conservative to avoid false positives on
 * legitimate short-form content (poetry, bullet lists, etc.).
 * Only applied to texts with at least 10 words to avoid flagging short captions.
 */
export function isGarbledSttText(text: string | null | undefined): boolean {
  if (!text) return false;

  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 10) return false;  // too short to judge reliably

  const totalChars = words.reduce((sum, w) => sum + w.length, 0);
  const avgWordLen = totalChars / words.length;
  const shortWords = words.filter((w) => w.length <= 3).length;
  const shortRatio = shortWords / words.length;

  // Flag if average word length is very short AND most words are tiny
  return avgWordLen < 3.5 && shortRatio > 0.60;
}
