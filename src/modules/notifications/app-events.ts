import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'events';

/**
 * Lightweight in-process event bus (@nestjs/event-emitter is not installed).
 * Global via NotificationsModule — any provider can inject AppEvents and emit:
 *
 *   this.events.emit(APP_EVENTS.INGEST_RUN_COMPLETED, { profileId, runId, postsSelected });
 *
 * Listener errors are caught and logged so a producer is never broken by a consumer.
 */
export const APP_EVENTS = {
  INGEST_RUN_COMPLETED: 'ingest.run.completed',
  INGEST_RUN_FAILED: 'ingest.run.failed',
  CRISIS_LEVEL_CHANGED: 'crisis.level.changed',
} as const;

export interface IngestRunCompletedEvent {
  profileId: string;
  runId?: string;
  postsSelected?: number;
}

export interface IngestRunFailedEvent {
  profileId: string;
  runId?: string;
  error?: string | null;
}

export type CrisisLevel = 'safe' | 'warning' | 'critical';

/**
 * Emitted by the crisis endpoint each time it computes a level. previousLevel is
 * optional: when absent the listener compares against the last level it saw,
 * so emitting on every computation is fine.
 */
export interface CrisisLevelChangedEvent {
  profileId: string;
  level: CrisisLevel;
  score?: number;
  previousLevel?: CrisisLevel;
}

export interface AppEventMap {
  'ingest.run.completed': IngestRunCompletedEvent;
  'ingest.run.failed': IngestRunFailedEvent;
  'crisis.level.changed': CrisisLevelChangedEvent;
}

@Injectable()
export class AppEvents {
  private readonly logger = new Logger(AppEvents.name);
  private readonly emitter = new EventEmitter();

  emit<K extends keyof AppEventMap>(event: K, payload: AppEventMap[K]): void {
    try {
      this.emitter.emit(event, payload);
    } catch (err) {
      this.logger.warn(`Listener for ${event} threw: ${err?.message}`);
    }
  }

  /** Async handlers are fire-and-forget; rejections are logged, never thrown back to the emitter. */
  on<K extends keyof AppEventMap>(event: K, handler: (payload: AppEventMap[K]) => unknown): void {
    this.emitter.on(event, (payload: AppEventMap[K]) => {
      try {
        const result = handler(payload);
        if (result && typeof (result as Promise<unknown>).catch === 'function') {
          (result as Promise<unknown>).catch((err) =>
            this.logger.warn(`Listener for ${event} failed: ${err?.message}`),
          );
        }
      } catch (err) {
        this.logger.warn(`Listener for ${event} failed: ${err?.message}`);
      }
    });
  }
}
