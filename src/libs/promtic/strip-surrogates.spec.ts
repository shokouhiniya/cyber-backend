import { stripLoneSurrogates } from './promtic.service';

describe('stripLoneSurrogates', () => {
  it('drops half of an emoji cut by slice but keeps whole emoji', () => {
    const cut = 'سلام 😀'.slice(0, 6); // ends with a lone high surrogate
    expect(stripLoneSurrogates(cut)).toBe('سلام ');
    expect(stripLoneSurrogates('ok 😀 \uDE00x')).toBe('ok 😀 x');
  });

  it('walks nested objects and arrays and leaves other values alone', () => {
    const out = stripLoneSurrogates({ posts: ['a\uD83D', { t: 'b' }], n: 3, d: null });
    expect(out).toEqual({ posts: ['a', { t: 'b' }], n: 3, d: null });
  });
});
