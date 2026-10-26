import { DEFAULT_INGEST_SETTINGS, describeCron, mergeIngestSettings } from './ingest-settings';

describe('ingest-settings', () => {
  describe('describeCron', () => {
    it('describes the default tier schedules in Persian', () => {
      expect(describeCron('0 0,6,12,18 * * *')).toBe('هر ۶ ساعت (ساعت ۰۰:۰۰، ۰۶:۰۰، ۱۲:۰۰، ۱۸:۰۰)');
      expect(describeCron('0 3 * * *')).toBe('هر روز ساعت ۰۳:۰۰');
      expect(describeCron('0 4 */3 * *')).toBe('هر ۳ روز یک بار، ساعت ۰۴:۰۰');
    });
    it('handles step, uneven and weekly shapes, and 6-field crons', () => {
      expect(describeCron('0 */4 * * *')).toBe('هر ۴ ساعت');
      expect(describeCron('*/30 * * * *')).toBe('هر ۳۰ دقیقه');
      expect(describeCron('30 8,20 * * *')).toBe('هر ۱۲ ساعت (ساعت ۰۸:۳۰، ۲۰:۳۰)');
      expect(describeCron('0 9,13 * * *')).toBe('روزانه ۲ بار (ساعت ۰۹:۰۰، ۱۳:۰۰)');
      expect(describeCron('0 2 * * 6')).toBe('هفتگی، شنبه ساعت ۰۲:۰۰');
      expect(describeCron('0 0 3 * * *')).toBe('هر روز ساعت ۰۳:۰۰');
    });
    it('falls back to the raw expression for unknown shapes', () => {
      expect(describeCron('0 3 1 1 *')).toContain('0 3 1 1 *');
      expect(describeCron('nonsense')).toContain('nonsense');
    });
  });

  describe('mergeIngestSettings', () => {
    it('returns defaults for empty input', () => {
      expect(mergeIngestSettings(null)).toEqual(DEFAULT_INGEST_SETTINGS);
    });
    it('merges tier objects field by field (older saves without cron keep the default cron)', () => {
      const merged = mergeIngestSettings({ heavy: { sampleSize: 150 } });
      expect(merged.heavy.sampleSize).toBe(150);
      expect(merged.heavy.cron).toBe(DEFAULT_INGEST_SETTINGS.heavy.cron);
    });
    it('sanitises retentionDays and manualCooldownMinutes', () => {
      expect(mergeIngestSettings({ retentionDays: '30' as any }).retentionDays).toBe(30);
      expect(mergeIngestSettings({ retentionDays: 0 }).retentionDays).toBe(DEFAULT_INGEST_SETTINGS.retentionDays);
      expect(mergeIngestSettings({ manualCooldownMinutes: -5 }).manualCooldownMinutes).toBe(DEFAULT_INGEST_SETTINGS.manualCooldownMinutes);
    });
  });
});
