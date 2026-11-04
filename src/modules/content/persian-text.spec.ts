import {
  findUngroundedNumbers, fixHalfSpaces, normalizePersianDeep, normalizePersianText, parseLlmJson, stripMarkdown,
} from './persian-text';
import { buildSummaryFacts } from './ai-prompt-inputs';
import { cleanLlmOutput, cleanSummaryOutput } from './ai-content.service';

const ZWNJ = '‌';

describe('persian-text', () => {
  it('turns Arabic ي / ك / digits into Persian', () => {
    expect(normalizePersianText('كاربران ميگويند ٣٠ درصد')).toBe('کاربران میگویند ۳۰ درصد');
  });

  it('strips markdown, bullets and citation markers', () => {
    const md = '## عنوان\n**نکته مهم**: متن [1] و `کد`\n- مورد اول\n1. مورد دوم';
    expect(stripMarkdown(md)).toBe('عنوان\nنکته مهم: متن  و کد\nمورد اول\nمورد دوم');
  });

  it('fixes punctuation spacing and Latin punctuation between Persian words', () => {
    expect(normalizePersianText('مردم ,دولت ; مجلس ? بله')).toBe('مردم، دولت؛ مجلس؟ بله');
    expect(normalizePersianText('سهم منفی 45 % است .')).toBe('سهم منفی 45٪ است.');
    expect(normalizePersianText('اول،دوم')).toBe('اول، دوم');
    expect(normalizePersianText('« نقل قول »')).toBe('«نقل قول»');
  });

  it('inserts the common half-spaces without touching other words', () => {
    expect(fixHalfSpaces('کاربران می گویند و نمی دانند')).toBe(`کاربران می${ZWNJ}گویند و نمی${ZWNJ}دانند`);
    expect(fixHalfSpaces('پست ها و مهم ترین موضوع های روز')).toBe(`پست${ZWNJ}ها و مهم${ZWNJ}ترین موضوع${ZWNJ}های روز`);
    // standalone words that only look like the patterns stay as they are
    expect(fixHalfSpaces('آنها هم میز را دیدند')).toBe('آنها هم میز را دیدند');
  });

  it('is idempotent', () => {
    const once = normalizePersianText('**كاربران** می گویند ,  سهم 30 %');
    expect(normalizePersianText(once)).toBe(once);
  });

  it('normalises every string in a JSON value', () => {
    expect(normalizePersianDeep({ a: ['كتاب'], b: { c: 'ي' }, n: 3 })).toEqual({ a: ['کتاب'], b: { c: 'ی' }, n: 3 });
  });

  it('parses fenced or wrapped JSON and citation-marked replies', () => {
    expect(parseLlmJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseLlmJson('Here: {"a":[1,2]} thanks')).toEqual({ a: [1, 2] });
    expect(parseLlmJson('{"t":"x"}[1][2]')).toEqual({ t: 'x' });
    expect(parseLlmJson('not json')).toBeNull();
  });

  it('flags numbers that are not in the facts', () => {
    expect(findUngroundedNumbers('سهم منفی ۴۵٪ و ۱۲۰ پست در سال ۱۴۰۵', [45, 120])).toEqual([]);
    expect(findUngroundedNumbers('سهم منفی ۶۰٪ است', [45, 120])).toEqual([60]);
  });
});

describe('summary output', () => {
  it('keeps the {"summary"} schema and cleans the text', () => {
    const out = JSON.parse(cleanSummaryOutput('```json\n{"summary": "**وضعيت** کلی: 45 % منفی"}\n```'));
    expect(out).toEqual({ summary: 'وضعیت کلی: 45٪ منفی' });
  });

  it('accepts other reply shapes and plain text', () => {
    expect(JSON.parse(cleanSummaryOutput('{"analysis":"متن"}')).summary).toBe('متن');
    expect(JSON.parse(cleanSummaryOutput('{"summary":["بند ۱","بند ۲"]}')).summary).toBe('بند ۱\n\nبند ۲');
    expect(JSON.parse(cleanSummaryOutput('فقط متن ساده'))).toEqual({ summary: 'فقط متن ساده' });
  });

  it('cleanLlmOutput keeps arrays as arrays', () => {
    expect(JSON.parse(cleanLlmOutput('[{"title":"پيشنهاد"}]'))).toEqual([{ title: 'پیشنهاد' }]);
  });
});

describe('summary facts', () => {
  it('lists the computed figures and the numbers the model may use', () => {
    const { text, numbers } = buildSummaryFacts({
      periodFrom: new Date('2026-11-01T08:00:00Z'),
      periodTo: new Date('2026-11-04T08:00:00Z'),
      total: 200,
      positive: 50,
      negative: 90,
      neutral: 60,
      platforms: [{ source: 'twitter', count: 120, positive: 20, negative: 70, views: 15000 }],
      hashtags: [{ tag: 'بودجه', count: 12 }],
      topics: [{ topic: 'تورم', count: 40, negative: 30 }],
    });
    expect(text).toContain('تعداد کل پست‌های تحلیل‌شده (بدون صفحات رسمی): 200');
    expect(text).toContain('منفی 90 پست (45٪)');
    expect(text).toContain('ایکس (توییتر): 120 پست (60٪ کل)');
    expect(text).toContain('تورم: 40 پست (20٪)');
    expect(text).toContain('#بودجه (12)');
    expect(text).toMatch(/۱۴۰۵\/۰۸\/۱۰ \(2026-11-01\)/);
    expect(numbers).toEqual(expect.arrayContaining([200, 45, 60, 20, 15000]));
  });
});
