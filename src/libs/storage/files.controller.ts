import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';

import { FileStorageService } from './file-storage.service';

/**
 * Public read-only access to stored files (avatars, cached media):
 *   GET /api/files/avatars/<file>   GET /api/files/media-cache/<file>
 *
 * Images are loaded by <img> tags, which can't send a JWT, so this is public;
 * only the two known prefixes and safe file names are accepted. With
 * S3_PUBLIC_URL set it redirects to the bucket instead of proxying.
 */
@Controller('files')
export class FilesController {
  constructor(private readonly storage: FileStorageService) {}

  @Get(':folder/:file')
  async get(@Param('folder') folder: string, @Param('file') file: string, @Res() res: Response) {
    const key = `${folder}/${file}`;
    if (!this.storage.isValidKey(key)) {
      res.status(404).end();
      return;
    }

    const direct = this.storage.publicUrl(key);
    if (direct) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.redirect(302, direct);
      return;
    }

    const stored = await this.storage.get(key);
    if (!stored) {
      res.status(404).setHeader('Cache-Control', 'public, max-age=300');
      res.end();
      return;
    }

    res.setHeader('Content-Type', stored.contentType);
    if (stored.size) res.setHeader('Content-Length', String(stored.size));
    // Avatar names include a timestamp and cache names a content hash, so they never change
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    stored.stream.on('error', () => {
      if (!res.headersSent) res.status(404);
      res.end();
    });
    stored.stream.pipe(res);
  }
}
