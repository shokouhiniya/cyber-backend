import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SmsService } from '../../libs/sms/sms.service';
import {
  APP_EVENTS,
  AppEvents,
  CrisisLevel,
  CrisisLevelChangedEvent,
  IngestRunCompletedEvent,
  IngestRunFailedEvent,
} from '../notifications/app-events';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ALERT_EVENT_LABELS,
  AlertChannel,
  AlertEvent,
  AlertSettings,
  DEFAULT_ALERT_SETTINGS,
  rejectedRecipients,
  sanitizeAlertSettings,
} from './alert-settings';
import { entersCrisis, evaluateIngestRun, staleHours } from './alert-rules';
import { BaleClient } from './bale.client';

export const ALERTS_BATCH_DELAY_MS = Symbol('ALERTS_BATCH_DELAY_MS');

export interface AlertCandidate {
  event: AlertEvent;
  dedupKey: string;
  profileId?: string | null;
  title: string;
  body: string;
  /** Fire once per key, ignoring the cooldown window (stale episodes). */
  oncePerKey?: boolean;
}

export interface ChannelOutcome {
  ok: boolean;
  sent: number;
  failed: number;
  errors: string[];
}

const CRISIS_LABEL: Record<CrisisLevel, string> = { safe: 'عادی', warning: 'هشدار', critical: 'بحرانی' };
const fa = (n: number) => n.toLocaleString('fa-IR');
const APP_NAME = 'سامانه صادق';
const SMS_MAX = 480;

/**
 * Out-of-band alerts (SMS via SmsService, Bale bot) for:
 *   (a) failed ingest runs, and runs that "complete" while most sources return nothing;
 *   (b) profiles without a successful collection for N hours (AlertsScheduler);
 *   (c) a profile entering the crisis threshold.
 *
 * Listens to the same AppEvents as NotificationsService. Each alert has a
 * de-duplication key (event + profile); a key that was sent or skipped within
 * the cooldown is dropped. Alerts raised close together (one cron batch of
 * runs) are merged into one message per event, so ten failing profiles give
 * one SMS, not ten. Every alert is recorded in alert_deliveries.
 */
@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AlertsService.name);
  private pending: AlertCandidate[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private readonly crisisLevels = new Map<string, CrisisLevel>();
  private readonly batchDelayMs: number;

  constructor(
    private readonly db: DataSource,
    private readonly sms: SmsService,
    private readonly bale: BaleClient,
    private readonly events: AppEvents,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() @Inject(ALERTS_BATCH_DELAY_MS) batchDelayMs?: number,
  ) {
    this.batchDelayMs = batchDelayMs ?? 30_000;
  }

  onModuleInit() {
    this.events.on(APP_EVENTS.INGEST_RUN_FAILED, (e) => this.onIngestFailed(e));
    this.events.on(APP_EVENTS.INGEST_RUN_COMPLETED, (e) => this.onIngestCompleted(e));
    this.events.on(APP_EVENTS.CRISIS_LEVEL_CHANGED, (e) => this.onCrisis(e));
  }

  async onModuleDestroy() {
    if (this.timer) clearTimeout(this.timer);
    await this.flush();
  }

  // ── Settings ────────────────────────────────────────────────────────────────

  async getSettings(): Promise<AlertSettings> {
    try {
      const rows = await this.db.query(`SELECT config FROM alert_settings WHERE id = 1`);
      return sanitizeAlertSettings(rows[0]?.config ?? {});
    } catch (err: any) {
      this.logger.warn(`alert_settings read failed: ${err?.message}`);
      return sanitizeAlertSettings(DEFAULT_ALERT_SETTINGS);
    }
  }

  async saveSettings(input: any, userId?: string) {
    const settings = sanitizeAlertSettings(input);
    await this.db.query(
      `INSERT INTO alert_settings (id, config, updated_by, updated_at) VALUES (1, $1::jsonb, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [JSON.stringify(settings), userId ?? null],
    );
    return { settings, rejected: rejectedRecipients(input) };
  }

  channelStatus() {
    return {
      sms: { enabled: this.sms.enabled, mode: this.sms.mode },
      bale: { enabled: this.bale.enabled },
    };
  }

  async recentDeliveries(limit = 30) {
    const n = Math.min(Math.max(Number(limit) || 30, 1), 200);
    const rows = await this.db.query(
      `SELECT d.id, d.event, d.profile_id, p.name AS profile_name, d.title, d.body, d.channels,
              d.status, d.error, d.is_test, d.created_at
       FROM alert_deliveries d LEFT JOIN profiles p ON p.id = d.profile_id
       ORDER BY d.created_at DESC LIMIT ${n}`,
    );
    return rows.map((r: any) => ({
      id: String(r.id),
      event: r.event,
      profileId: r.profile_id,
      profileName: r.profile_name,
      title: r.title,
      body: r.body,
      channels: r.channels,
      status: r.status,
      error: r.error,
      isTest: r.is_test,
      createdAt: r.created_at,
    }));
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  async onIngestFailed(e: IngestRunFailedEvent) {
    if (!e?.profileId) return;
    const verdict = evaluateIngestRun({ status: 'failed', errorMessage: e.error }, DEFAULT_ALERT_SETTINGS);
    const name = await this.profileName(e.profileId);
    await this.raise({
      event: 'ingest_failed',
      dedupKey: `ingest_failed:${e.profileId}`,
      profileId: e.profileId,
      title: `جمع‌آوری داده‌های ${name} ناموفق بود`,
      body: verdict!.reason,
    });
  }

  async onIngestCompleted(e: IngestRunCompletedEvent) {
    if (!e?.profileId || !e.runId) return;
    const settings = await this.getSettings();
    const rows = await this.db.query(
      `SELECT status, error_message, posts_selected, stats FROM ingest_runs WHERE id = $1`,
      [e.runId],
    );
    const run = rows[0];
    if (!run) return;
    const verdict = evaluateIngestRun(
      { status: run.status, errorMessage: run.error_message, postsSelected: run.posts_selected, stats: run.stats },
      settings,
    );
    if (!verdict) return;
    const name = await this.profileName(e.profileId);
    const accepted = await this.raise({
      event: verdict.event,
      dedupKey: `${verdict.event}:${e.profileId}`,
      profileId: e.profileId,
      title: `جمع‌آوری ${name} ناقص بود`,
      body: verdict.reason,
    });
    // The in-app notification for this run says "completed"; flag it for admins too
    if (accepted && verdict.event === 'ingest_partial') {
      await this.notifications
        ?.notify({
          type: 'ingest_partial',
          profileId: e.profileId,
          audience: 'admin',
          title: `جمع‌آوری ${name} ناقص بود`,
          body: verdict.reason,
          link: '/dashboard/admin/profiles',
          meta: { runId: e.runId, emptySources: verdict.emptySources, sourcesWithData: verdict.sourcesWithData },
        })
        .catch((err) => this.logger.warn(`partial-ingest notification failed: ${err?.message}`));
    }
  }

  async onCrisis(e: CrisisLevelChangedEvent) {
    if (!e?.profileId || !CRISIS_LABEL[e.level]) return;
    const previous = this.crisisLevels.get(e.profileId);
    this.crisisLevels.set(e.profileId, e.level);
    if (previous === e.level) return;
    const settings = await this.getSettings();
    if (!entersCrisis(previous, e.level, settings.crisisLevel)) return;
    const name = await this.profileName(e.profileId);
    await this.raise({
      event: 'crisis',
      dedupKey: `crisis:${e.profileId}:${e.level}`,
      profileId: e.profileId,
      title: `${name} وارد وضعیت «${CRISIS_LABEL[e.level]}» شد`,
      body: `سطح بحران ${CRISIS_LABEL[e.level]}${e.score != null ? ` — امتیاز ${fa(Math.round(e.score))} از ${fa(100)}` : ''}`,
    });
  }

  /** (b) Called hourly. Returns the number of alerts raised. */
  async checkStale(now = new Date()): Promise<number> {
    const settings = await this.getSettings();
    if (!(await this.automaticCollectionEnabled())) return 0;
    const rows: Array<{ id: string; name: string; last_success: Date }> = await this.db.query(
      `SELECT p.id, p.name, lr.finished_at AS last_success
       FROM profiles p
       JOIN LATERAL (
         SELECT finished_at FROM ingest_runs
         WHERE profile_id = p.id AND status = 'completed' AND posts_selected > 0 AND finished_at IS NOT NULL
         ORDER BY finished_at DESC LIMIT 1
       ) lr ON TRUE
       WHERE p.is_active = TRUE`,
    );
    let raised = 0;
    for (const r of rows) {
      const age = staleHours(r.last_success, settings.staleHours, now);
      if (age === null) continue;
      const ok = await this.raise({
        event: 'data_stale',
        dedupKey: `data_stale:${r.id}:${new Date(r.last_success).toISOString()}`,
        profileId: r.id,
        title: `داده‌های ${r.name} به‌روز نیست`,
        body: `آخرین جمع‌آوری موفق ${fa(age)} ساعت پیش بوده است (آستانه: ${fa(settings.staleHours)} ساعت)`,
        oncePerKey: true,
      });
      if (ok) raised++;
    }
    return raised;
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  /** Queues an alert unless a duplicate is pending or within the cooldown. Returns true when queued. */
  async raise(c: AlertCandidate): Promise<boolean> {
    const settings = await this.getSettings();
    if (!settings.enabled) return false;
    if (this.pending.some((p) => p.dedupKey === c.dedupKey)) return false;
    const recent = await this.db.query(
      `SELECT 1 FROM alert_deliveries
       WHERE dedup_key = $1 AND is_test = FALSE AND status IN ('sent', 'partial', 'skipped')
         AND ($2::boolean OR created_at > NOW() - ($3 || ' minutes')::interval)
       LIMIT 1`,
      [c.dedupKey, !!c.oncePerKey, String(settings.cooldownMinutes)],
    );
    if (recent.length) return false;

    this.pending.push(c);
    if (this.batchDelayMs <= 0) await this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, this.batchDelayMs);
      this.timer.unref?.();
    }
    return true;
  }

  /** Sends everything pending, one message per event. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushNow()).catch((err) => {
      this.logger.error(`alert flush failed: ${err?.message}`);
    });
    return this.flushing;
  }

  private async flushNow() {
    const batch = this.pending;
    this.pending = [];
    if (!batch.length) return;
    const settings = await this.getSettings();

    const byEvent = new Map<AlertEvent, AlertCandidate[]>();
    for (const c of batch) byEvent.set(c.event, [...(byEvent.get(c.event) ?? []), c]);

    for (const [event, items] of byEvent) {
      const { long, short } = this.compose(event, items);
      const channels = await this.deliver(settings, settings.routes[event], long, short);
      const status = this.statusOf(channels);
      const error = Object.values(channels)
        .flatMap((o) => o?.errors ?? [])
        .join(' | ')
        .slice(0, 1000) || null;
      for (const c of items) {
        await this.record(c, channels, status, error, false);
      }
      if (status !== 'sent') this.logger.warn(`Alert ${event} (${items.length}) → ${status}${error ? `: ${error}` : ''}`);
      else this.logger.log(`Alert ${event} (${items.length}) sent`);
    }
  }

  /** «ارسال آزمایشی»: sends a test message to the configured recipients. */
  async sendTest(channel: AlertChannel | 'all' = 'all', userName?: string) {
    const settings = await this.getSettings();
    const route = { sms: channel !== 'bale', bale: channel !== 'sms' };
    const text = `${APP_NAME} — پیام آزمایشی هشدار\nاین پیام برای بررسی تنظیمات هشدار ارسال شده است${
      userName ? ` (توسط ${userName})` : ''
    }.\n${this.timestamp()}`;
    const channels = await this.deliver(settings, route, text, text, true);
    const status = this.statusOf(channels);
    const error = Object.values(channels).flatMap((o) => o?.errors ?? []).join(' | ') || null;
    await this.record(
      { event: 'ingest_failed', dedupKey: 'test', title: 'پیام آزمایشی', body: text },
      channels,
      status,
      error,
      true,
    );
    return { status, channels };
  }

  private async deliver(
    settings: AlertSettings,
    route: { sms: boolean; bale: boolean },
    longText: string,
    smsText: string,
    explain = false,
  ): Promise<Partial<Record<AlertChannel, ChannelOutcome>>> {
    const out: Partial<Record<AlertChannel, ChannelOutcome>> = {};
    const { phones, baleChatIds } = settings.recipients;

    if (route.sms && phones.length) {
      if (this.sms.enabled) {
        const r = await this.sms.sendText(phones, smsText);
        out.sms = { ok: r.ok, sent: r.sent, failed: r.failed, errors: r.errors };
      } else out.sms = { ok: false, sent: 0, failed: phones.length, errors: ['پیامک فعال نیست (GHASEDAK_API_KEY تنظیم نشده)'] };
    } else if (explain && route.sms) {
      out.sms = { ok: false, sent: 0, failed: 0, errors: ['شماره‌ای برای پیامک ثبت نشده است'] };
    }

    if (route.bale && baleChatIds.length) {
      if (this.bale.enabled) {
        const r = await this.bale.send(baleChatIds, longText);
        out.bale = { ok: r.ok, sent: r.sent, failed: r.failed, errors: r.errors };
      } else out.bale = { ok: false, sent: 0, failed: baleChatIds.length, errors: ['بات بله فعال نیست (BALE_BOT_TOKEN تنظیم نشده)'] };
    } else if (explain && route.bale) {
      out.bale = { ok: false, sent: 0, failed: 0, errors: ['شناسه گفتگوی بله ثبت نشده است'] };
    }
    return out;
  }

  private statusOf(channels: Partial<Record<AlertChannel, ChannelOutcome>>): 'sent' | 'partial' | 'failed' | 'skipped' {
    const attempted = Object.values(channels).filter((o) => o && o.sent + o.failed > 0) as ChannelOutcome[];
    if (!attempted.length) return 'skipped';
    const sent = attempted.reduce((a, o) => a + o.sent, 0);
    const failed = attempted.reduce((a, o) => a + o.failed, 0);
    if (sent && !failed) return 'sent';
    return sent ? 'partial' : 'failed';
  }

  compose(event: AlertEvent, items: AlertCandidate[]): { long: string; short: string } {
    const ts = this.timestamp();
    if (items.length === 1) {
      const [c] = items;
      const long = `⚠️ ${APP_NAME}\n${c.title}\n${c.body}\n${ts}`;
      return { long, short: truncate(`${APP_NAME}: ${c.title}\n${c.body}\n${ts}`, SMS_MAX) };
    }
    const head = `${ALERT_EVENT_LABELS[event]} — ${fa(items.length)} پروفایل`;
    const lines = items.map((c) => `• ${c.title}: ${c.body}`);
    const long = `⚠️ ${APP_NAME}\n${head}\n${lines.join('\n')}\n${ts}`;
    const shortLines = items.slice(0, 4).map((c) => `• ${c.title}`);
    if (items.length > 4) shortLines.push(`و ${fa(items.length - 4)} مورد دیگر`);
    return { long, short: truncate(`${APP_NAME}: ${head}\n${shortLines.join('\n')}\n${ts}`, SMS_MAX) };
  }

  private async record(
    c: AlertCandidate,
    channels: Partial<Record<AlertChannel, ChannelOutcome>>,
    status: string,
    error: string | null,
    isTest: boolean,
  ) {
    try {
      await this.db.query(
        `INSERT INTO alert_deliveries (event, dedup_key, profile_id, title, body, channels, status, error, is_test)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [c.event, c.dedupKey, c.profileId ?? null, c.title, c.body, JSON.stringify(channels), status, error, isTest],
      );
    } catch (err: any) {
      this.logger.warn(`alert_deliveries write failed: ${err?.message}`);
    }
  }

  private timestamp() {
    try {
      return new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
        timeZone: 'Asia/Tehran',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date());
    } catch {
      return new Date().toISOString();
    }
  }

  private async profileName(profileId: string): Promise<string> {
    try {
      const rows = await this.db.query(`SELECT name FROM profiles WHERE id = $1`, [profileId]);
      return rows[0]?.name ?? 'پروفایل';
    } catch {
      return 'پروفایل';
    }
  }

  private async automaticCollectionEnabled(): Promise<boolean> {
    try {
      const rows = await this.db.query(`SELECT value FROM global_context WHERE key = 'ingest_settings' LIMIT 1`);
      if (!rows[0]?.value) return true;
      return JSON.parse(rows[0].value)?.automaticCollectionEnabled !== false;
    } catch {
      return true;
    }
  }
}

function truncate(s: string, max: number) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
