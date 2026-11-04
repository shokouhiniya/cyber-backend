/**
 * Profile keyword rules applied to collected posts, on top of the 8tag query
 * (`or` = profile.keywords, `not` = profile.excludedKeywords):
 *
 *  - excludedKeywords: a post mentioning any of them is dropped. 8tag already
 *    gets them as `not`; we check again locally because its tokenizer misses
 *    spelling variants (ي/ی, ك/ک, half-space).
 *  - contextKeywords: role / position terms («رئیس مجلس», «سردار», «وزیر خارجه»).
 *    When the list is not empty a post must mention at least one of them, so
 *    namesakes and unrelated people with the same name stay out. A profile
 *    keyword that already contains a role term («رئیس مجلس قالیباف») passes
 *    on its own, because its text contains that term.
 *
 * Matching is a case-insensitive substring match on normalised text.
 */

export interface KeywordRules {
  contextKeywords?: string[] | null;
  excludedKeywords?: string[] | null;
}

export type KeywordRejection = 'excluded' | 'no_context';

const ZWNJ = '‌';

/** Folds Arabic letter variants, half-spaces, diacritics and case so spellings compare equal. */
export function normaliseForMatch(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .replace(/[ً-ْٰـ]/g, '') // harakat, superscript alef, tatweel
    .replace(/ي|ى/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ۀ|ة/g, 'ه')
    .replace(/[أإآ]/g, 'ا')
    .replace(new RegExp(`[${ZWNJ}\\s]+`, 'g'), ' ')
    .toLowerCase()
    .trim();
}

function cleanList(list: string[] | null | undefined): string[] {
  const out = new Set<string>();
  for (const k of list || []) {
    const n = normaliseForMatch(typeof k === 'string' ? k : '');
    if (n) out.add(n);
  }
  return [...out];
}

interface CompiledRules {
  excluded: string[];
  context: string[];
}

function compile(rules: KeywordRules): CompiledRules {
  return { excluded: cleanList(rules.excludedKeywords), context: cleanList(rules.contextKeywords) };
}

function reject(text: string | null | undefined, c: CompiledRules): KeywordRejection | null {
  if (!c.excluded.length && !c.context.length) return null;
  const t = normaliseForMatch(text);
  if (c.excluded.some((k) => t.includes(k))) return 'excluded';
  if (c.context.length && !c.context.some((k) => t.includes(k))) return 'no_context';
  return null;
}

/** True when the profile has any include (context) or exclude rule. */
export function hasKeywordRules(rules: KeywordRules): boolean {
  const c = compile(rules);
  return c.excluded.length > 0 || c.context.length > 0;
}

/** Why a post is rejected by the profile's rules, or null when it passes. */
export function keywordRejection(text: string | null | undefined, rules: KeywordRules): KeywordRejection | null {
  return reject(text, compile(rules));
}

/** Filters feed items ({ text }) by the profile's rules; returns the kept items and the drop counts. */
export function applyKeywordRules<T extends { text?: string | null }>(
  items: T[],
  rules: KeywordRules,
): { kept: T[]; excluded: number; noContext: number } {
  const c = compile(rules);
  if (!c.excluded.length && !c.context.length) return { kept: items, excluded: 0, noContext: 0 };
  const kept: T[] = [];
  let excluded = 0;
  let noContext = 0;
  for (const item of items) {
    const why = reject(item.text, c);
    if (why === 'excluded') excluded++;
    else if (why === 'no_context') noContext++;
    else kept.push(item);
  }
  return { kept, excluded, noContext };
}
