import { APP_EVENTS, AppEvents } from './app-events';
import { NOTIFICATION_TYPES, NotificationsService } from './notifications.service';
import { StaleDataScheduler } from './stale-data.scheduler';

const flush = () => new Promise((r) => setImmediate(r));

function makeRepo(queryImpl: (sql: string, params?: any[]) => any = () => []) {
  return {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: 'n1', ...x })),
    query: jest.fn(async (sql: string, params?: any[]) => queryImpl(sql, params)),
  } as any;
}

function setup(queryImpl?: (sql: string, params?: any[]) => any) {
  const repo = makeRepo(queryImpl ?? ((sql) => (sql.includes('FROM profiles') ? [{ name: 'تست' }] : [])));
  const events = new AppEvents();
  const service = new NotificationsService(repo, events);
  service.onModuleInit();
  return { repo, events, service };
}

describe('NotificationsService listeners', () => {
  it('ingest.run.completed creates a profile-scoped notification with Persian digits', async () => {
    const { repo, events } = setup();
    events.emit(APP_EVENTS.INGEST_RUN_COMPLETED, { profileId: 'p1', runId: 'r1', postsSelected: 120 });
    await flush();
    expect(repo.save).toHaveBeenCalledTimes(1);
    const saved = repo.save.mock.calls[0][0];
    expect(saved).toMatchObject({ type: NOTIFICATION_TYPES.INGEST_COMPLETED, profileId: 'p1', audience: 'all', userId: null });
    expect(saved.body).toContain('۱۲۰');
  });

  it('ingest.run.failed is admin-only', async () => {
    const { repo, events } = setup();
    events.emit(APP_EVENTS.INGEST_RUN_FAILED, { profileId: 'p1', error: 'boom' });
    await flush();
    expect(repo.save.mock.calls[0][0]).toMatchObject({ type: NOTIFICATION_TYPES.INGEST_FAILED, audience: 'admin' });
  });

  it('crisis.level.changed only notifies when the level actually changes', async () => {
    const { repo, events } = setup();
    events.emit(APP_EVENTS.CRISIS_LEVEL_CHANGED, { profileId: 'p1', level: 'safe', score: 30 });
    events.emit(APP_EVENTS.CRISIS_LEVEL_CHANGED, { profileId: 'p1', level: 'warning', score: 60 });
    events.emit(APP_EVENTS.CRISIS_LEVEL_CHANGED, { profileId: 'p1', level: 'warning', score: 62 });
    events.emit(APP_EVENTS.CRISIS_LEVEL_CHANGED, { profileId: 'p1', level: 'safe', score: 40 });
    for (let i = 0; i < 10; i++) await flush();
    const types = repo.save.mock.calls.map((c) => c[0].meta.level);
    expect(types).toEqual(['warning', 'safe']);
  });

  it('a throwing listener never breaks the emitter', () => {
    const events = new AppEvents();
    events.on(APP_EVENTS.INGEST_RUN_COMPLETED, () => {
      throw new Error('x');
    });
    expect(() => events.emit(APP_EVENTS.INGEST_RUN_COMPLETED, { profileId: 'p1' })).not.toThrow();
  });
});

describe('StaleDataScheduler', () => {
  const now = new Date('2026-10-26T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

  function scheduler(rows: any[], settings: any = null) {
    const repo = makeRepo((sql) => {
      if (sql.includes('global_context')) return settings ? [{ value: JSON.stringify(settings) }] : [];
      if (sql.includes('LATERAL')) return rows;
      return [];
    });
    const notifications = { notify: jest.fn(async () => ({})), purgeOlderThan: jest.fn() } as any;
    return { s: new StaleDataScheduler(repo, notifications), notifications };
  }

  it('flags runs older than 2× tier interval, once per episode', async () => {
    const { s, notifications } = scheduler([
      { id: 'a', name: 'الف', tier: 'heavy', finished_at: hoursAgo(13), notified: false }, // > 12h → stale
      { id: 'b', name: 'ب', tier: 'heavy', finished_at: hoursAgo(11), notified: false }, // fresh
      { id: 'c', name: 'ج', tier: 'medium', finished_at: hoursAgo(50), notified: true }, // already told
      { id: 'd', name: 'د', tier: 'light', finished_at: hoursAgo(100), notified: false }, // < 144h
    ]);
    expect(await s.checkStaleProfiles(now)).toBe(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'a', type: NOTIFICATION_TYPES.DATA_STALE, audience: 'admin' }),
    );
  });

  it('stays quiet when automatic collection is disabled', async () => {
    const { s, notifications } = scheduler(
      [{ id: 'a', name: 'الف', tier: 'heavy', finished_at: hoursAgo(99), notified: false }],
      { automaticCollectionEnabled: false },
    );
    expect(await s.checkStaleProfiles(now)).toBe(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
