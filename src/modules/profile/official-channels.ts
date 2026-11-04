import { normaliseHandle } from '../content/post-quality';

/** Platforms an official account can be listed on (admin form, «صفحات رسمی»). */
export const OFFICIAL_PLATFORMS = ['x', 'telegram', 'instagram', 'eitaa', 'bale', 'rubika', 'aparat', 'youtube', 'web'] as const;
export type OfficialPlatform = (typeof OFFICIAL_PLATFORMS)[number];

/**
 * Platforms whose posts the ingest collects from the account itself
 * (official-pages-feed.service.ts). 8tag can only verify authorship on Telegram.
 */
export const COLLECTED_OFFICIAL_PLATFORMS: Record<string, string> = { telegram: 'telegram' };

/** A channel with no post for this many days is reported as inactive. */
export const OFFICIAL_STALE_DAYS = 30;

export interface OfficialChannelInput {
  platform: string;
  handle?: string | null;
  url?: string | null;
  active?: boolean;
}

export interface OfficialCollectionRow {
  source: string;
  handle: string;
  lastPublishedAt: Date | string | null;
  postCount: number;
}

export type OfficialAccountStatus = 'collecting' | 'no_data' | 'inactive';

export interface OfficialAccountState {
  platform: string;
  handle: string;
  url: string | null;
  status: OfficialAccountStatus;
  /** Persian explanation shown next to the status */
  reason: string;
  /** Whether the ingest collects this platform at all */
  collected: boolean;
  lastPublishedAt: string | null;
  postCount: number;
}

/** Handle as the official-pages feed stores it in selection_reason (no @, no URL prefix, lowercase). */
export function officialHandleKey(handle: string | null | undefined): string {
  return normaliseHandle(handle || '');
}

/**
 * Status of every configured official account:
 *  - inactive   («غیرفعال»): switched off by the admin, or no post for OFFICIAL_STALE_DAYS;
 *  - collecting («در حال جمع‌آوری»): its posts are being collected;
 *  - no_data    («بدون داده»): not collected on this platform, no handle, or nothing received yet.
 */
export function officialAccountStates(
  channels: OfficialChannelInput[] | null | undefined,
  rows: OfficialCollectionRow[],
  now = new Date(),
): OfficialAccountState[] {
  const byKey = new Map<string, OfficialCollectionRow>();
  for (const r of rows) byKey.set(`${r.source}:${officialHandleKey(r.handle)}`, r);

  return (channels || [])
    .filter((c) => c && typeof c.platform === 'string')
    .map((c) => {
      const handle = (c.handle || '').trim();
      const source = COLLECTED_OFFICIAL_PLATFORMS[c.platform];
      const row = source && handle ? byKey.get(`${source}:${officialHandleKey(handle)}`) : undefined;
      const last = row?.lastPublishedAt ? new Date(row.lastPublishedAt) : null;
      const base = {
        platform: c.platform,
        handle,
        url: c.url?.trim() || null,
        collected: Boolean(source),
        lastPublishedAt: last && !isNaN(last.getTime()) ? last.toISOString() : null,
        postCount: row?.postCount ?? 0,
      };

      if (c.active === false) {
        return { ...base, status: 'inactive' as const, reason: 'این حساب توسط مدیر غیرفعال شده و جمع‌آوری نمی‌شود.' };
      }
      if (!handle) {
        return { ...base, status: 'no_data' as const, reason: 'شناسه یا نشانی حساب وارد نشده است.' };
      }
      if (!source) {
        return {
          ...base,
          status: 'no_data' as const,
          reason: 'جمع‌آوری خودکار پست‌های این پلتفرم پشتیبانی نمی‌شود؛ فقط پیوند حساب نمایش داده می‌شود.',
        };
      }
      if (!row || row.postCount === 0) {
        return {
          ...base,
          status: 'no_data' as const,
          reason: 'هنوز پستی از این حساب دریافت نشده است؛ درستی شناسه را بررسی کنید یا منتظر نوبت بعدی جمع‌آوری بمانید.',
        };
      }
      const staleMs = OFFICIAL_STALE_DAYS * 24 * 60 * 60 * 1000;
      if (!last || now.getTime() - last.getTime() > staleMs) {
        return {
          ...base,
          status: 'inactive' as const,
          reason: `در ${OFFICIAL_STALE_DAYS} روز گذشته پستی از این حساب منتشر نشده است.`,
        };
      }
      return { ...base, status: 'collecting' as const, reason: 'پست‌های این حساب در هر نوبت جمع‌آوری دریافت می‌شود.' };
    });
}
