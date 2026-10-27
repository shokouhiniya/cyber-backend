import { Global, Module } from '@nestjs/common';

import { FilesController } from './files.controller';
import { FileStorageService } from './file-storage.service';

/** File storage (S3 or local disk) shared by avatars and the media cache. */
@Global()
@Module({
  controllers: [FilesController],
  providers: [FileStorageService],
  exports: [FileStorageService],
})
export class StorageModule {}
