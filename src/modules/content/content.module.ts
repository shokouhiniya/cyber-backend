import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Content } from './content.entity';
import { Profile } from '../profile/profile.entity';
import { StatsController } from './stats.controller';
import { PostsController } from './posts.controller';
import { EmotionsController } from './emotions.controller';
import { InfluencersController } from './influencers.controller';
import { AiContentController } from './ai-content.controller';
import { ContentService } from './content.service';
import { AiContentService } from './ai-content.service';
import { AdminModule } from '../admin/admin.module';
import { SelectedPost } from '../ingest/selected-post.entity';
import { IngestRun } from '../ingest/ingest-run.entity';
import { AiResultCache } from '../ingest/ai-result-cache.entity';
import { PlatformTotal } from '../ingest/platform-total.entity';
import { HourlyAggregate } from '../ingest/hourly-aggregate.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Content, Profile, SelectedPost, IngestRun, AiResultCache, PlatformTotal, HourlyAggregate]),    AdminModule,
  ],
  controllers: [
    StatsController,
    PostsController,
    EmotionsController,
    InfluencersController,
    AiContentController,
  ],
  providers: [ContentService, AiContentService],
  exports: [AiContentService],
})
export class ContentModule {}
