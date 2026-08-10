import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';

import { DataSourceModule } from '../data-source/data-source.module';
import { ContentModule } from '../content/content.module';
import { AdminModule } from '../admin/admin.module';
import { Profile } from '../profile/profile.entity';
import { DataSource as DataSourceEntity } from '../data-source/data-source.entity';
import { GlobalContext } from '../admin/global-context/global-context.entity';

import { SampleSelectorService } from './sample-selector.service';
import { IngestWorkerService } from './ingest-worker.service';
import { BatchSentimentService } from './batch-sentiment.service';
import { PlatformTotalsService } from './platform-totals.service';
import { DisplayFeedService } from './display-feed.service';
import { OfficialPagesFeedService } from './official-pages-feed.service';
import { MacroContextService } from './macro-context.service';
import { PromiseFeedService } from './promise-feed.service';
import { TrendService } from './trend.service';
import { IngestRun } from './ingest-run.entity';
import { SelectedPost } from './selected-post.entity';
import { HourlyAggregate } from './hourly-aggregate.entity';
import { AiResultCache } from './ai-result-cache.entity';
import { PlatformTotal } from './platform-total.entity';
import { IngestController } from './ingest.controller';
import { IngestPublicController } from './ingest-public.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    DataSourceModule,
    forwardRef(() => ContentModule),
    forwardRef(() => AdminModule),
    TypeOrmModule.forFeature([
      Profile,
      DataSourceEntity,
      IngestRun,
      SelectedPost,
      HourlyAggregate,
      AiResultCache,
      PlatformTotal,
      GlobalContext,
    ]),
  ],
  controllers: [IngestController, IngestPublicController],
  providers: [SampleSelectorService, IngestWorkerService, BatchSentimentService, PlatformTotalsService, DisplayFeedService, OfficialPagesFeedService, MacroContextService, PromiseFeedService, TrendService],
  exports: [SampleSelectorService, IngestWorkerService, TrendService, PlatformTotalsService],
})
export class IngestModule {}
