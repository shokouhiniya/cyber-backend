import { applyKeywordRules, hasKeywordRules, keywordRejection, normaliseForMatch } from './keyword-filter';

describe('keyword-filter', () => {
  it('normalises Arabic letter variants, half-spaces, diacritics and case', () => {
    expect(normaliseForMatch('رئيس‌جمهور')).toBe('رئیس جمهور');
    expect(normaliseForMatch('  كشور   ايران ')).toBe('کشور ایران');
    expect(normaliseForMatch('مُحسن')).toBe('محسن');
    expect(normaliseForMatch('IRGC Commander')).toBe('irgc commander');
    expect(normaliseForMatch(null)).toBe('');
  });

  it('passes everything when the profile has no rules', () => {
    expect(hasKeywordRules({})).toBe(false);
    expect(hasKeywordRules({ contextKeywords: [' ', ''], excludedKeywords: null })).toBe(false);
    expect(keywordRejection('هر متنی', {})).toBeNull();
    const items = [{ text: 'a' }, { text: null }];
    expect(applyKeywordRules(items, { contextKeywords: [] }).kept).toBe(items);
  });

  it('drops posts that mention an excluded keyword, whatever the spelling', () => {
    const rules = { excludedKeywords: ['محسن رضایی‌زاده'] };
    expect(keywordRejection('گل محسن رضائی زاده در لیگ', { excludedKeywords: ['رضائی زاده'] })).toBe('excluded');
    expect(keywordRejection('بازی محسن رضايی‌زاده', rules)).toBe('excluded');
    expect(keywordRejection('سخنان محسن رضایی درباره اقتصاد', rules)).toBeNull();
  });

  it('requires a role term when context keywords are set (namesakes stay out)', () => {
    const rules = { contextKeywords: ['معاون اقتصادی', 'سردار', 'مجمع تشخیص'] };
    expect(keywordRejection('سردار محسن رضایی در جلسه دولت', rules)).toBeNull();
    expect(keywordRejection('محسن رضایی، معاون اقتصادي رئیس‌جمهور', rules)).toBeNull();
    // Same name, unrelated person (a footballer)
    expect(keywordRejection('محسن رضایی گلزن هفته شد', rules)).toBe('no_context');
    expect(keywordRejection(null, rules)).toBe('no_context');
  });

  it('a keyword that already contains the role term passes on its own', () => {
    const rules = { contextKeywords: ['رئیس مجلس'] };
    expect(keywordRejection('نطق رئیس‌مجلس قالیباف', rules)).toBeNull();
  });

  it('exclusion wins over context', () => {
    const rules = { contextKeywords: ['سردار'], excludedKeywords: ['فوتبال'] };
    expect(keywordRejection('سردار محسن رضایی در ورزشگاه فوتبال', rules)).toBe('excluded');
  });

  it('applyKeywordRules keeps order and counts each kind of drop', () => {
    const items = [
      { id: 1, text: 'سردار رضایی' },
      { id: 2, text: 'رضایی فوتبال سردار' },
      { id: 3, text: 'رضایی گلزن' },
      { id: 4, text: 'سخنان سردار' },
    ];
    const res = applyKeywordRules(items, { contextKeywords: ['سردار'], excludedKeywords: ['فوتبال'] });
    expect(res.kept.map((i) => i.id)).toEqual([1, 4]);
    expect(res.excluded).toBe(1);
    expect(res.noContext).toBe(1);
  });
});
