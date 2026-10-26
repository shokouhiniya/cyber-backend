import { ForbiddenException } from '@nestjs/common';

import { IngestPublicController } from './ingest-public.controller';
import { DEFAULT_INGEST_SETTINGS } from './ingest-settings';

/**
 * run-now is asynchronous: it must answer with { runId } as soon as the run row
 * exists, without waiting for the (mocked) pipeline.
 */
describe('IngestPublicController run-now', () => {
  let worker: any;
  let runRepo: any;
  let auditLog: any;
  let controller: IngestPublicController;

  beforeEach(() => {
    worker = {
      getSettings: jest.fn().mockResolvedValue(DEFAULT_INGEST_SETTINGS),
      isRunInFlight: jest.fn((run: any) => run?.status === 'running'),
      // Never resolves the pipeline — only the run row is returned
      startRunForProfile: jest.fn().mockResolvedValue({ id: 'run-123', status: 'running', stage: 'queued', progress: 0 }),
      runForProfile: jest.fn(() => new Promise(() => undefined)),
    };
    runRepo = { findOne: jest.fn().mockResolvedValue(null) };
    auditLog = { write: jest.fn().mockResolvedValue(undefined) };
    controller = new IngestPublicController(worker, {} as any, runRepo, {} as any, { findOne: jest.fn() } as any, auditLog);
  });

  it('returns { runId } immediately via startRunForProfile', async () => {
    const res = await controller.runNow('profile-1');
    expect(res).toEqual({ runId: 'run-123', status: 'running', stage: 'queued', progress: 0 });
    expect(worker.startRunForProfile).toHaveBeenCalledWith('profile-1');
    expect(worker.runForProfile).not.toHaveBeenCalled();
    expect(auditLog.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'ingest.run-now', entityId: 'run-123' }));
  });

  it('refuses while a run is in flight', async () => {
    runRepo.findOne.mockResolvedValue({ status: 'running', startedAt: new Date() });
    await expect(controller.runNow('profile-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(worker.startRunForProfile).not.toHaveBeenCalled();
  });

  it('applies manualCooldownMinutes from settings', async () => {
    worker.getSettings.mockResolvedValue({ ...DEFAULT_INGEST_SETTINGS, manualCooldownMinutes: 30 });
    runRepo.findOne.mockResolvedValue({ status: 'completed', startedAt: new Date(Date.now() - 20 * 60_000) });
    await expect(controller.runNow('profile-1')).rejects.toThrow('۱۰ دقیقه');

    runRepo.findOne.mockResolvedValue({ status: 'completed', startedAt: new Date(Date.now() - 31 * 60_000) });
    await expect(controller.runNow('profile-1')).resolves.toMatchObject({ runId: 'run-123' });
  });

  it('posts-only returns the new runId so pollers never read the previous run', async () => {
    controller = new IngestPublicController(
      worker, {} as any, runRepo, {} as any,
      { findOne: jest.fn().mockResolvedValue({ id: 'profile-1', name: 'x' }) } as any, auditLog,
    );
    const res = await controller.postsOnly('profile-1');
    expect(res).toMatchObject({ runId: 'run-123', status: 'running' });
    expect(worker.startRunForProfile).toHaveBeenCalledWith('profile-1', { skipAi: true });
  });
});
