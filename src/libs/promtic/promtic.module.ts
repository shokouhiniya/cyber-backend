import { Module, Global } from '@nestjs/common';
import { PromticService } from './promtic.service';

@Global()
@Module({
  providers: [PromticService],
  exports: [PromticService],
})
export class PromticModule {}
