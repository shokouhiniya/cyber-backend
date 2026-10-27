import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { FileStorageService } from '../../libs/storage';
import { MediaService, isAllowedMediaUrl } from './media.service';

/**
 * GET /api/media?url=<cdn url> — cached copy of a post image / video / avatar.
 *
 * Public on purpose: <img>/<video> tags can't send the JWT. It is not an open
 * proxy — only allowlisted CDN hosts (MEDIA_HOST_ALLOWLIST) are fetched, only
 * image/video content up to 8 MB is stored, and failures are remembered so a
 * dead link answers 404 immediately.
 */
@Controller('media')
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly storage: FileStorageService,
  ) {}

  @Get()
  async get(@Query('url') url: string | undefined, @Res() res: Response) {
    const target = url ? isAllowedMediaUrl(url) : null;
    if (!target) {
      res.status(400).setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }

    const cached = await this.media.get(target);
    if (!cached) {
      // Short cache so browsers don't hammer a dead link, but can retry later
      res.status(404).setHeader('Cache-Control', 'public, max-age=600');
      res.end();
      return;
    }

    // Public bucket: let the browser load it from S3/CDN directly
    const direct = this.storage.publicUrl(cached.key);
    if (direct) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.redirect(302, direct);
      return;
    }

    const stored = await this.storage.get(cached.key);
    if (!stored) {
      res.status(404).setHeader('Cache-Control', 'public, max-age=600');
      res.end();
      return;
    }
    res.setHeader('Content-Type', stored.contentType || cached.contentType);
    if (stored.size) res.setHeader('Content-Length', String(stored.size));
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
