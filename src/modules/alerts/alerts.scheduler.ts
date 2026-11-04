import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { AlertsService } from './alerts.service';

/** Hourly (at :20, apart from the stale-notification cron): alert on stale data. */
@Injectable()
export class AlertsScheduler {
  private readonly logger = new Logger(AlertsScheduler.name);

  constructor(private readonly alerts: AlertsService) {}

  @Cron('0 20 * * * *', { name: 'alerts_stale_data' })
  async runHourly() {
    try {
      const n = await this.alerts.checkStale();
      if (n) this.logger.log(`Stale-data alerts raised: ${n}`);
    } catch (err: any) {
      this.logger.warn(`Stale-data alert check failed: ${err?.message}`);
    }
  }
}
