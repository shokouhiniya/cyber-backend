import { Logger } from '@nestjs/common';

import { AppEvents, APP_EVENTS } from '../notifications/app-events';
import { entersCrisis, evaluateIngestRun, staleHours } from './alert-rules';
import { DEFAULT_ALERT_SETTINGS, sanitizeAlertSettings, rejectedRecipients } from './alert-settings';
import { AlertsService } from './alerts.service';
import { BaleClient } from './bale.client';

const QUOTAS = { bale: 2, news: 7, eitaa: 3, forum: 2, media: 2, aparat: 2, rubika: 2, twitter: 13, telegram: 11, instagram: 5, newspaper: 3 };

// The 13 Aban run: "completed", no error, data only from bale and rubika
const ABAN_13 = {
  status: 'completed' as const,
  errorMessage: null,
  postsSelected: 4,
  stats: { quotaPerSource: QUOTAS, fetchedPerSource: { bale: 37, rubika: 21, twitter: 0, news: 0 } },
};

const HEALTHY = {
  status: 'completed' as const,
  postsSelected: 52,
  stats: {
    quotaPerSource: QUOTAS,
    fetchedPerSource: { bale: 117, news: 58, eitaa: 81, forum: 177, media: 130, aparat: 91, rubika: 102, twitter: 74, telegram: 110, instagram: 87, newspaper: 179 },
  },
};

describe('alert rules', () => {
  it('flags the 13 Aban pattern (only bale/rubika returned data) as a partial ingest', () => {
    const v = evaluateIngestRun(ABAN_13, DEFAULT_ALERT_SETTINGS);
    expect(v?.event).toBe('ingest_partial');
    expect(v?.sourcesWithData).toEqual(['bale', 'rubika']);
    expect(v?.emptySources).toHaveLength(9);
    expect(v?.reason).toContain('بله');
    expect(v?.reason).toContain('روبیکا');
  });

  it('leaves healthy runs alone, and tolerates a couple of quiet sources', () => {
    expect(evaluateIngestRun(HEALTHY, DEFAULT_ALERT_SETTINGS)).toBeNull();
    const twoQuiet = { ...HEALTHY, stats: { ...HEALTHY.stats, fetchedPerSource: { ...HEALTHY.stats.fetchedPerSource, aparat: 0, forum: 0 } } };
    expect(evaluateIngestRun(twoQuiet, DEFAULT_ALERT_SETTINGS)).toBeNull();
  });

  it('flags a completed run with zero posts from every source', () => {
    const v = evaluateIngestRun({ status: 'completed', postsSelected: 0, stats: { quotaPerSource: QUOTAS, fetchedPerSource: {} } }, DEFAULT_ALERT_SETTINGS);
    expect(v?.event).toBe('ingest_partial');
    expect(v?.reason).toContain('هیچ منبعی');
  });

  it('turns a failed run into ingest_failed with the error', () => {
    expect(evaluateIngestRun({ status: 'failed', errorMessage: '8tag login failed' }, DEFAULT_ALERT_SETTINGS)).toEqual({
      event: 'ingest_failed',
      reason: '8tag login failed',
    });
  });

  it('crisis alerts only when crossing the threshold or escalating', () => {
    expect(entersCrisis('safe', 'critical', 'critical')).toBe(true);
    expect(entersCrisis(undefined, 'critical', 'critical')).toBe(true);
    expect(entersCrisis('critical', 'critical', 'critical')).toBe(false);
    expect(entersCrisis('safe', 'warning', 'critical')).toBe(false);
    expect(entersCrisis('safe', 'warning', 'warning')).toBe(true);
    expect(entersCrisis('warning', 'critical', 'warning')).toBe(true);
    expect(entersCrisis('critical', 'warning', 'warning')).toBe(false);
  });

  it('stale after N hours', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    expect(staleHours('2026-11-04T00:00:00Z', 24, now)).toBeNull();
    expect(staleHours('2026-11-02T12:00:00Z', 24, now)).toBe(48);
    expect(staleHours(null, 24, now)).toBeNull();
  });

  it('sanitises settings and reports rejected recipients', () => {
    const input = {
      recipients: { phones: ['۰۹۱۲۱۲۳۴۵۶۷', '+989121234567', '123'], baleChatIds: ['12345', '-100200', '@ops_channel', 'bad id'] },
      staleHours: 9999,
      routes: { crisis: { sms: false } },
    };
    const s = sanitizeAlertSettings(input);
    expect(s.recipients.phones).toEqual(['09121234567']);
    expect(s.recipients.baleChatIds).toEqual(['12345', '-100200', '@ops_channel']);
    expect(s.staleHours).toBe(24 * 14);
    expect(s.routes.crisis).toEqual({ sms: false, bale: true });
    expect(rejectedRecipients(input)).toEqual({ phones: ['123'], baleChatIds: ['bad id'] });
  });
});

/** Fake DataSource: alert_settings / alert_deliveries / ingest_runs / profiles in memory. */
function fakeDb(config: any = {}) {
  const deliveries: any[] = [];
  const runs: Record<string, any> = {};
  const profiles: any[] = [{ id: 'p1', name: 'پروفایل الف', is_active: true }, { id: 'p2', name: 'پروفایل ب', is_active: true }];
  const lastSuccess: Record<string, Date> = {};
  const state = { config, ingestSettings: null as any };
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    if (sql.startsWith('SELECT config FROM alert_settings')) return [{ config: state.config }];
    if (sql.startsWith('INSERT INTO alert_settings')) {
      state.config = JSON.parse(p[0]);
      return [];
    }
    if (sql.includes('FROM alert_deliveries\n       WHERE dedup_key')) {
      const [key, once, minutes] = p;
      const since = Date.now() - Number(minutes) * 60_000;
      return deliveries.filter(
        (d) => d.dedup_key === key && !d.is_test && ['sent', 'partial', 'skipped'].includes(d.status) && (once || d.created_at > since),
      );
    }
    if (sql.startsWith('INSERT INTO alert_deliveries')) {
      deliveries.push({ event: p[0], dedup_key: p[1], profile_id: p[2], title: p[3], body: p[4], channels: JSON.parse(p[5]), status: p[6], error: p[7], is_test: p[8], created_at: Date.now() });
      return [];
    }
    if (sql.startsWith('SELECT status, error_message, posts_selected, stats FROM ingest_runs')) return runs[p[0]] ? [runs[p[0]]] : [];
    if (sql.startsWith('SELECT name FROM profiles')) return profiles.filter((x) => x.id === p[0]);
    if (sql.startsWith('SELECT value FROM global_context')) return state.ingestSettings ? [{ value: JSON.stringify(state.ingestSettings) }] : [];
    if (sql.includes('AS last_success')) {
      return profiles.filter((x) => lastSuccess[x.id]).map((x) => ({ id: x.id, name: x.name, last_success: lastSuccess[x.id] }));
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
  });
  return { query, deliveries, runs, lastSuccess, state };
}

const RECIPIENTS = { recipients: { phones: ['09121234567'], baleChatIds: ['5551234'] } };

function setup(config: any = RECIPIENTS, opts: { smsEnabled?: boolean; baleToken?: string } = {}) {
  const db = fakeDb(config);
  const sms = {
    enabled: opts.smsEnabled ?? true,
    mode: 'live',
    sendText: jest.fn(async (phones: string[], _text: string) => ({ ok: true, sent: phones.length, failed: 0, errors: [], mode: 'live' })),
  };
  const baleHttp = { post: jest.fn(async () => ({ status: 200, data: { ok: true } })) };
  const bale = new BaleClient({ get: (k: string) => (k === 'BALE_BOT_TOKEN' ? opts.baleToken ?? 'bot-token' : undefined) } as any, baleHttp);
  const events = new AppEvents();
  const notifications = { notify: jest.fn(async () => ({})) };
  const svc = new AlertsService(db as any, sms as any, bale, events, notifications as any, 0);
  svc.onModuleInit();
  return { svc, db, sms, bale, baleHttp, events, notifications };
}

describe('AlertsService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('alerts on a partial ingest by SMS and Bale, and only once within the cooldown', async () => {
    const { svc, db, sms, baleHttp, notifications } = setup();
    db.runs.r1 = { status: 'completed', error_message: null, posts_selected: 4, stats: ABAN_13.stats };
    await svc.onIngestCompleted({ profileId: 'p1', runId: 'r1', postsSelected: 4 });
    expect(sms.sendText).toHaveBeenCalledTimes(1);
    expect(sms.sendText.mock.calls[0][0]).toEqual(['09121234567']);
    expect(sms.sendText.mock.calls[0][1]).toContain('پروفایل الف');
    expect(baleHttp.post).toHaveBeenCalledTimes(1);
    const [url, body] = baleHttp.post.mock.calls[0] as any;
    expect(url).toBe('https://tapi.bale.ai/botbot-token/sendMessage');
    expect(body).toMatchObject({ chat_id: 5551234 });
    expect(db.deliveries[0]).toMatchObject({ event: 'ingest_partial', status: 'sent', dedup_key: 'ingest_partial:p1' });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'ingest_partial', audience: 'admin' }));

    // next run, same pattern → de-duplicated
    db.runs.r2 = db.runs.r1;
    await svc.onIngestCompleted({ profileId: 'p1', runId: 'r2' });
    expect(sms.sendText).toHaveBeenCalledTimes(1);
    expect(db.deliveries).toHaveLength(1);

    // after the cooldown it may alert again
    db.deliveries[0].created_at -= (DEFAULT_ALERT_SETTINGS.cooldownMinutes + 1) * 60_000;
    await svc.onIngestCompleted({ profileId: 'p1', runId: 'r2' });
    expect(sms.sendText).toHaveBeenCalledTimes(2);
  });

  it('does nothing for a healthy run', async () => {
    const { svc, db, sms } = setup();
    db.runs.r1 = { status: 'completed', posts_selected: 52, stats: HEALTHY.stats };
    await svc.onIngestCompleted({ profileId: 'p1', runId: 'r1' });
    expect(sms.sendText).not.toHaveBeenCalled();
    expect(db.deliveries).toHaveLength(0);
  });

  it('reacts to ingest-failed events from the event bus', async () => {
    const { db, sms, events } = setup();
    events.emit(APP_EVENTS.INGEST_RUN_FAILED, { profileId: 'p2', runId: 'r9', error: 'Dataak timeout' });
    await new Promise((r) => setTimeout(r, 10));
    expect(sms.sendText).toHaveBeenCalledTimes(1);
    expect(db.deliveries[0]).toMatchObject({ event: 'ingest_failed', body: 'Dataak timeout', status: 'sent' });
  });

  it('respects routing: crisis only to Bale', async () => {
    const { svc, sms, baleHttp, db } = setup({ ...RECIPIENTS, routes: { crisis: { sms: false, bale: true } } });
    await svc.onCrisis({ profileId: 'p1', level: 'critical', score: 81 });
    expect(sms.sendText).not.toHaveBeenCalled();
    expect(baleHttp.post).toHaveBeenCalledTimes(1);
    expect(db.deliveries[0]).toMatchObject({ event: 'crisis', status: 'sent' });
    // repeated computations at the same level don't re-alert
    await svc.onCrisis({ profileId: 'p1', level: 'critical', score: 85 });
    expect(baleHttp.post).toHaveBeenCalledTimes(1);
    // warning is below the default threshold
    await svc.onCrisis({ profileId: 'p2', level: 'warning' });
    expect(baleHttp.post).toHaveBeenCalledTimes(1);
  });

  it('alerts once per stale episode', async () => {
    const { svc, db, sms } = setup({ ...RECIPIENTS, staleHours: 12 });
    db.lastSuccess.p1 = new Date(Date.now() - 30 * 3_600_000);
    db.lastSuccess.p2 = new Date(Date.now() - 2 * 3_600_000);
    expect(await svc.checkStale()).toBe(1);
    expect(await svc.checkStale()).toBe(0);
    expect(sms.sendText).toHaveBeenCalledTimes(1);
    expect(db.deliveries[0].body).toContain('۳۰ ساعت');
    // cooldown passing doesn't matter for the same episode
    db.deliveries[0].created_at -= 30 * 24 * 3_600_000;
    expect(await svc.checkStale()).toBe(0);
    // a fresh success followed by a new gap is a new episode
    db.lastSuccess.p1 = new Date(Date.now() - 13 * 3_600_000);
    expect(await svc.checkStale()).toBe(1);
  });

  it('stays quiet about staleness when automatic collection is off', async () => {
    const { svc, db } = setup();
    db.state.ingestSettings = { automaticCollectionEnabled: false };
    db.lastSuccess.p1 = new Date(Date.now() - 100 * 3_600_000);
    expect(await svc.checkStale()).toBe(0);
  });

  it('merges alerts raised together into one message per event', async () => {
    const db = fakeDb(RECIPIENTS);
    const sms = { enabled: true, mode: 'live', sendText: jest.fn(async () => ({ ok: true, sent: 1, failed: 0, errors: [], mode: 'live' })) };
    const bale = new BaleClient({ get: () => undefined } as any);
    const svc = new AlertsService(db as any, sms as any, bale, new AppEvents(), undefined, 60_000);
    await svc.onIngestFailed({ profileId: 'p1', error: 'x' });
    await svc.onIngestFailed({ profileId: 'p2', error: 'y' });
    expect(sms.sendText).not.toHaveBeenCalled();
    await svc.flush();
    expect(sms.sendText).toHaveBeenCalledTimes(1);
    expect((sms.sendText.mock.calls[0] as any)[1]).toContain('۲ پروفایل');
    expect(db.deliveries).toHaveLength(2);
    // Bale has no token: recorded as an error, no network call
    expect(db.deliveries[0].channels.bale.errors[0]).toContain('BALE_BOT_TOKEN');
    await svc.onModuleDestroy();
  });

  it('skips (and records) alerts when no channel can deliver', async () => {
    const { svc, db, sms } = setup({ recipients: { phones: [], baleChatIds: [] } });
    await svc.onIngestFailed({ profileId: 'p1', error: 'x' });
    expect(sms.sendText).not.toHaveBeenCalled();
    expect(db.deliveries[0].status).toBe('skipped');
  });

  it('does nothing when alerts are switched off', async () => {
    const { svc, db } = setup({ ...RECIPIENTS, enabled: false });
    await svc.onIngestFailed({ profileId: 'p1', error: 'x' });
    expect(db.deliveries).toHaveLength(0);
  });

  it('sends a test message to both channels and explains missing setup', async () => {
    const { svc, sms, baleHttp, db } = setup();
    const res = await svc.sendTest('all', 'admin');
    expect(res.status).toBe('sent');
    expect(sms.sendText).toHaveBeenCalledTimes(1);
    expect(baleHttp.post).toHaveBeenCalledTimes(1);
    expect(db.deliveries[0].is_test).toBe(true);

    const empty = setup({ recipients: { phones: [], baleChatIds: [] } }, { smsEnabled: false });
    const r2 = await empty.svc.sendTest('all');
    expect(r2.status).toBe('skipped');
    expect(r2.channels.sms?.errors[0]).toContain('شماره');
    expect(empty.baleHttp.post).not.toHaveBeenCalled();
  });

  it('test sends never block real alerts (dedup ignores them)', async () => {
    const { svc, sms } = setup();
    await svc.sendTest('sms');
    await svc.onIngestFailed({ profileId: 'p1', error: 'x' });
    expect(sms.sendText).toHaveBeenCalledTimes(2);
  });
});

describe('BaleClient', () => {
  it('makes no call without a token', async () => {
    const http = { post: jest.fn() };
    const c = new BaleClient({ get: () => undefined } as any, http);
    expect(c.enabled).toBe(false);
    const r = await c.send(['1'], 'x');
    expect(r.ok).toBe(false);
    expect(http.post).not.toHaveBeenCalled();
  });

  it('never puts the token in errors', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const http = {
      post: jest.fn().mockRejectedValue({ response: { status: 403, data: { ok: false, description: 'Forbidden: bot was blocked' } }, config: { url: 'https://tapi.bale.ai/botSECRET/sendMessage' } }),
    };
    const c = new BaleClient({ get: (k: string) => (k === 'BALE_BOT_TOKEN' ? 'SECRET' : undefined) } as any, http);
    const r = await c.send(['42'], 'x');
    expect(r.failed).toBe(1);
    expect(r.errors[0]).toContain('HTTP 403');
    expect(JSON.stringify(r)).not.toContain('SECRET');
    jest.restoreAllMocks();
  });
});
