import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Content } from './content.entity';
import { StatsController } from './stats.controller';
import { PostsController } from './posts.controller';
import { EmotionsController } from './emotions.controller';
import { InfluencersController } from './influencers.controller';
import { ImportController } from './import.controller';
import { ContentService } from './content.service';
import { ImportService } from './import.service';

@Module({
  imports: [TypeOrmModule.forFeature([Content])],
  controllers: [
    StatsController,
    PostsController,
    EmotionsController,
    InfluencersController,
    ImportController,
  ],
  providers: [ContentService, ImportService],
})
export class ContentModule {}
