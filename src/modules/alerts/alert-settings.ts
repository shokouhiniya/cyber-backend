import { normalizeIranPhone } from '../../libs/sms/phone';

export const ALERT_EVENTS = ['ingest_failed', 'ingest_partial', 'data_stale', 'crisis'] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];
export type AlertChannel = 'sms' | 'bale';

export const ALERT_EVENT_LABELS: Record<AlertEvent, string> = {
  ingest_failed: 'خطای جمع‌آوری داده',
  ingest_partial: 'جمع‌آوری ناقص (بیشتر منابع خالی)',
  data_stale: 'داده‌ها به‌روز نیست',
  crisis: 'ورود پروفایل به وضعیت بحران',
};

export interface AlertSettings {
  enabled: boolean;
  recipients: { phones: string[]; baleChatIds: string[] };
  /** Which channels each event goes to. */
  routes: Record<AlertEvent, { sms: boolean; bale: boolean }>;
  /** (b) alert when a profile's last successful collection is older than this. */
  staleHours: number;
  /** The same alert (event + profile) is not repeated within this window. */
  cooldownMinutes: number;
  /** (a) a completed run is "partial" when at least this share of its sources returned nothing … */
  emptySourceShare: number;
  /** … and it queried at least this many sources. */
  minActiveSources: number;
  /** (c) lowest crisis level that alerts. */
  crisisLevel: 'warning' | 'critical';
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  enabled: true,
  recipients: { phones: [], baleChatIds: [] },
  routes: {
    ingest_failed: { sms: true, bale: true },
    ingest_partial: { sms: true, bale: true },
    data_stale: { sms: true, bale: true },
    crisis: { sms: true, bale: true },
  },
  staleHours: 24,
  cooldownMinutes: 360,
  emptySourceShare: 0.6,
  minActiveSources: 3,
  crisisLevel: 'critical',
};

const clamp = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

/** Merges stored/user input over defaults and drops anything invalid. */
export function sanitizeAlertSettings(input: any): AlertSettings {
  const src = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_ALERT_SETTINGS;

  const phones = Array.from(
    new Set(
      (Array.isArray(src.recipients?.phones) ? src.recipients.phones : [])
        .map((p: unknown) => normalizeIranPhone(p))
        .filter((p: string | null): p is string => !!p),
    ),
  ).slice(0, 20) as string[];

  // Bale chat ids are numeric (negative for groups/channels) or @channel usernames
  const baleChatIds = Array.from(
    new Set(
      (Array.isArray(src.recipients?.baleChatIds) ? src.recipients.baleChatIds : [])
        .map((c: unknown) => String(c ?? '').trim())
        .filter((c: string) => /^-?\d{1,20}$/.test(c) || /^@[A-Za-z0-9_]{3,64}$/.test(c)),
    ),
  ).slice(0, 20) as string[];

  const routes = {} as AlertSettings['routes'];
  for (const e of ALERT_EVENTS) {
    const r = src.routes?.[e] ?? {};
    routes[e] = {
      sms: typeof r.sms === 'boolean' ? r.sms : d.routes[e].sms,
      bale: typeof r.bale === 'boolean' ? r.bale : d.routes[e].bale,
    };
  }

  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : d.enabled,
    recipients: { phones, baleChatIds },
    routes,
    staleHours: Math.round(clamp(src.staleHours, 1, 24 * 14, d.staleHours)),
    cooldownMinutes: Math.round(clamp(src.cooldownMinutes, 10, 24 * 60 * 7, d.cooldownMinutes)),
    emptySourceShare: clamp(src.emptySourceShare, 0.2, 1, d.emptySourceShare),
    minActiveSources: Math.round(clamp(src.minActiveSources, 1, 20, d.minActiveSources)),
    crisisLevel: src.crisisLevel === 'warning' ? 'warning' : 'critical',
  };
}

/** Raw user input that sanitize would drop — returned to the admin as warnings. */
export function rejectedRecipients(input: any): { phones: string[]; baleChatIds: string[] } {
  const clean = sanitizeAlertSettings(input);
  const phones = (Array.isArray(input?.recipients?.phones) ? input.recipients.phones : [])
    .map((p: unknown) => String(p ?? '').trim())
    .filter((p: string) => p && !clean.recipients.phones.includes(normalizeIranPhone(p) ?? '\u0000'));
  const baleChatIds = (Array.isArray(input?.recipients?.baleChatIds) ? input.recipients.baleChatIds : [])
    .map((c: unknown) => String(c ?? '').trim())
    .filter((c: string) => c && !clean.recipients.baleChatIds.includes(c));
  return { phones, baleChatIds };
}
