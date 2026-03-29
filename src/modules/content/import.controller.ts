import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ImportService } from './import.service';

@Controller('import')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Post('json')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
      fileFilter: (_req, file, cb) => {
        if (file.mimetype !== 'application/json') {
          cb(new BadRequestException('فقط فایل JSON مجاز است'), false);
        } else {
          cb(null, true);
        }
      },
    }),
  )
  async importJson(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('فایلی آپلود نشده است');
    }

    return this.importService.importJson(file.buffer);
  }
}
