import { officialAccountStates, officialHandleKey } from './official-channels';

describe('official-channels', () => {
  const now = new Date('2026-11-04T10:00:00Z');
  const rows = [
    { source: 'telegram', handle: 'ghalibaf_ir', lastPublishedAt: '2026-11-01T08:00:00Z', postCount: 12 },
    { source: 'telegram', handle: 'old_channel', lastPublishedAt: '2026-08-01T08:00:00Z', postCount: 3 },
  ];

  it('normalises handles the way the feed stores them', () => {
    expect(officialHandleKey('@Ghalibaf_IR')).toBe('ghalibaf_ir');
    expect(officialHandleKey('https://t.me/ghalibaf_ir/')).toBe('ghalibaf_ir');
    expect(officialHandleKey(null)).toBe('');
  });

  it('reports collecting / no_data / inactive with a reason', () => {
    const states = officialAccountStates(
      [
        { platform: 'telegram', handle: 'https://t.me/Ghalibaf_IR' },
        { platform: 'telegram', handle: 'old_channel' },
        { platform: 'telegram', handle: 'never_seen' },
        { platform: 'x', handle: 'mb_ghalibaf' },
        { platform: 'instagram', handle: 'ghalibaf', active: false },
        { platform: 'web', handle: '' },
      ],
      rows,
      now,
    );
    expect(states.map((s) => [s.platform, s.status])).toEqual([
      ['telegram', 'collecting'],
      ['telegram', 'inactive'],
      ['telegram', 'no_data'],
      ['x', 'no_data'],
      ['instagram', 'inactive'],
      ['web', 'no_data'],
    ]);
    expect(states[0]).toMatchObject({ collected: true, postCount: 12, lastPublishedAt: '2026-11-01T08:00:00.000Z' });
    expect(states[3].collected).toBe(false);
    expect(states[3].reason).toContain('پشتیبانی نمی‌شود');
    expect(states[4].reason).toContain('مدیر');
    expect(states.every((s) => s.reason.length > 0)).toBe(true);
  });

  it('tolerates missing channels', () => {
    expect(officialAccountStates(null, rows, now)).toEqual([]);
  });
});
