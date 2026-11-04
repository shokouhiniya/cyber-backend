import {
  buildMacroPromptVars, classifySection, headlineSimilarity, jalaliToGregorian, legacyToBriefing, parseEventDate,
  parseMacroReply, profileAffinity, rankForProfile, tehranDay,
} from './macro-events';

// 2026-11-04 12:00 Tehran (08:30 UTC) = ۱۴۰۵/۰۸/۱۳
const NOW = new Date('2026-11-04T08:30:00Z');

const ev = (title: string, date: string | undefined, extra: Record<string, unknown> = {}) => ({
  title, summary: `${title} — جزئیات`, date, actor: 'نهاد', severity: 'medium', ...extra,
});

describe('macro-events dates', () => {
  it('converts Jalali to Gregorian', () => {
    expect(jalaliToGregorian(1405, 8, 13)).toEqual([2026, 11, 4]);
    expect(jalaliToGregorian(1403, 1, 1)).toEqual([2024, 3, 20]);
    expect(jalaliToGregorian(1404, 12, 29)).toEqual([2026, 3, 20]);
  });

  it('parses ISO and Jalali dates in either digit set', () => {
    expect(parseEventDate('2026-11-03')).toBe('2026-11-03');
    expect(parseEventDate('۱۴۰۵/۰۸/۱۲')).toBe('2026-11-03');
    expect(parseEventDate('1405/8/13')).toBe('2026-11-04');
    expect(parseEventDate('دیروز')).toBeNull();
    expect(parseEventDate('2026-13-01')).toBeNull();
    expect(parseEventDate(undefined)).toBeNull();
  });

  it('uses the Tehran calendar day', () => {
    // 22:00 UTC on Nov 3 is already Nov 4 in Tehran
    expect(tehranDay(new Date('2026-11-03T22:00:00Z'))).toBe('2026-11-04');
  });

  it('puts explicit today / yesterday dates in the prompt variables', () => {
    const v = buildMacroPromptVars(NOW, ['خبر قدیمی']);
    expect(v.today_date).toBe('2026-11-04');
    expect(v.yesterday_date).toBe('2026-11-03');
    expect(v.today_jalali).toBe('۱۴۰۵/۰۸/۱۳');
    expect(v.yesterday_jalali).toBe('۱۴۰۵/۰۸/۱۲');
    expect(v.date).toContain('2026-11-04');
    expect(v.date).toContain('2026-11-03');
    expect(v.previous_headlines).toBe('- خبر قدیمی');
    expect(v.sections_spec).toContain('economic_livelihood: اقتصادی، معیشتی');
  });
});

describe('parseMacroReply', () => {
  const reply = JSON.stringify({
    sections: {
      cultural_social: [ev('افتتاح نمایشگاه کتاب تهران', '2026-11-04')],
      political_diplomatic: [
        ev('دور تازه مذاکرات هسته‌ای در مسقط', '2026-11-03', { severity: 'high' }),
        ev('سفر وزیر خارجه به پکن', '2026-10-30'), // too old
        ev('بی‌تاریخ', undefined), // no date
      ],
      security_military: [ev('رزمایش پدافند هوایی در جنوب', '۱۴۰۵/۰۸/۱۳')],
      economic_livelihood: [
        ev('افزایش نرخ دلار در بازار آزاد', '2026-11-05'), // tz skew → today
        ev('افزایش نرخ دلار در بازار آزاد تهران', '2026-11-04'), // near duplicate
        ev('تصویب کلیات بودجه سال آینده در مجلس', '2026-11-04'),
      ],
    },
  });

  it('keeps today and yesterday only, de-duplicates and normalises dates', () => {
    const { briefing, stats } = parseMacroReply(`\`\`\`json\n${reply}\n\`\`\`[1]`, NOW, ['تصویب کلیات بودجه سال آینده']);
    expect(briefing.window).toEqual({ from: '2026-11-03', to: '2026-11-04' });
    expect(briefing.sections.cultural_social.map((e) => e.title)).toEqual(['افتتاح نمایشگاه کتاب تهران']);
    expect(briefing.sections.political_diplomatic.map((e) => [e.title, e.date, e.severity])).toEqual([
      ['دور تازه مذاکرات هسته‌ای در مسقط', '2026-11-03', 'high'],
    ]);
    expect(briefing.sections.security_military[0].date).toBe('2026-11-04');
    expect(briefing.sections.economic_livelihood.map((e) => [e.title, e.date])).toEqual([
      ['افزایش نرخ دلار در بازار آزاد', '2026-11-04'],
    ]);
    expect(stats).toEqual({ received: 8, kept: 4, droppedOld: 1, droppedUndated: 1, droppedDuplicate: 2 });
    expect(briefing.legacy).toBeUndefined();
  });

  it('accepts sections at the top level and Persian section names', () => {
    const { briefing } = parseMacroReply(JSON.stringify({ 'امنیتی، نظامی': [ev('حادثه مرزی', '2026-11-04')] }), NOW);
    expect(briefing.sections.security_military).toHaveLength(1);
  });

  it('classifies a legacy flat list and keeps it, flagged legacy', () => {
    const legacy = JSON.stringify({
      events: [
        { title: 'بررسی لایحه بودجه در کمیسیون تلفیق', severity: 'high' },
        { title: 'دور جدید مذاکرات', summary: 'گمانه‌زنی درباره تحریم‌ها' },
      ],
      tensions: { foreign: 'بالا' },
    });
    const { briefing } = parseMacroReply(legacy, NOW);
    expect(briefing.legacy).toBe(true);
    expect(briefing.sections.economic_livelihood[0].title).toContain('بودجه');
    expect(briefing.sections.political_diplomatic[0].title).toBe('دور جدید مذاکرات');
    expect(legacyToBriefing(legacy, NOW)?.legacy).toBe(true);
    expect(legacyToBriefing('not json', NOW)).toBeNull();
  });

  it('returns an empty briefing for garbage', () => {
    const { briefing, stats } = parseMacroReply('متاسفم، اطلاعاتی ندارم', NOW);
    expect(stats.kept).toBe(0);
    expect(Object.values(briefing.sections).every((s) => s.length === 0)).toBe(true);
  });

  it('keyword classifier and headline similarity', () => {
    expect(classifySection('حمله پهپادی به مرز')).toBe('security_military');
    expect(classifySection('افزایش قیمت بنزین')).toBe('economic_livelihood');
    expect(classifySection('زلزله در کرمان')).toBe('cultural_social');
    expect(headlineSimilarity('افزایش نرخ دلار در بازار', 'نرخ دلار در بازار افزایش یافت')).toBeGreaterThanOrEqual(0.5);
    expect(headlineSimilarity('افزایش نرخ دلار', 'سفر وزیر خارجه')).toBe(0);
  });
});

describe('rankForProfile', () => {
  const { briefing } = parseMacroReply(
    JSON.stringify({
      sections: {
        political_diplomatic: [
          ev('سفر وزیر خارجه به پکن', '2026-11-04', { severity: 'high' }),
          ev('جلسه علنی مجلس درباره طرح مسکن', '2026-11-04', { severity: 'low' }),
          ev('بیانیه شورای امنیت', '2026-11-04'),
          ev('انتخابات شوراها', '2026-11-04'),
          ev('دیدار سفیر چین', '2026-11-03'),
        ],
        economic_livelihood: [ev('افزایش اجاره‌بها', '2026-11-04')],
      },
    }),
    NOW,
  );

  it('puts direct keyword / role matches first and keeps four per section', () => {
    const sections = rankForProfile(briefing, {
      name: 'محمدباقر قالیباف', role: 'رئیس مجلس', organization: 'مجلس شورای اسلامی', keywords: ['قالیباف', 'طرح مسکن'],
    });
    expect(sections.map((s) => s.key)).toEqual(['cultural_social', 'political_diplomatic', 'security_military', 'economic_livelihood']);
    const pol = sections.find((s) => s.key === 'political_diplomatic')!;
    expect(pol.priority).toBe(true);
    expect(pol.events).toHaveLength(4);
    expect(pol.events[0].title).toBe('جلسه علنی مجلس درباره طرح مسکن');
    expect(pol.events[0].relevant).toBe(true);
    expect(pol.events[0].matched).toEqual(expect.arrayContaining(['طرح', 'مسکن', 'مجلس']));
    expect(pol.events[1].relevant).toBe(false);
  });

  it('maps roles to the sections they care about', () => {
    expect([...profileAffinity({ role: 'فرمانده کل سپاه' })]).toContain('security_military');
    expect([...profileAffinity({ role: 'وزیر اقتصاد و دارایی' })]).toEqual(['economic_livelihood']);
    expect(profileAffinity({ role: '' }).size).toBe(0);
  });
});
