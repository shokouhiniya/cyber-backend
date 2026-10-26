import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { rename, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * Media cache for post images / videos / avatars.
 *
 * Social CDN links (Instagram especially) are signed and expire within days,
 * and some refuse hot-linking (403). The first request for a URL fetches it once
 * and stores it under static/media-cache/<sha256(url)>.<ext>; later requests are
 * served from disk. Only allowlisted CDN hosts are fetched so this can't be used
 * as an open proxy.
 */

/** Hosts (and their subdomains) we are willing to fetch from. */
export const MEDIA_HOST_ALLOWLIST = [
  'cdninstagram.com',
  'fbcdn.net',
  'twimg.com',
  'telesco.pe',
  'telegram.org',
  'telegram-cdn.org',
  '8tag.ir',
];

const MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const FAILURE_TTL_MS = 30 * 60_000;
const MAX_REMEMBERED_FAILURES = 5000;
/** Upstream fetches allowed per minute (cache hits are free) — bounds abuse of the public route. */
const MAX_FETCHES_PER_MINUTE = 120;

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};
const TYPE_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_TYPE).map(([type, ext]) => [ext, type]),
);
TYPE_BY_EXT.jpg = 'image/jpeg';

export function isAllowedMediaUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '443' && u.port !== '80') return null;
  const host = u.hostname.toLowerCase();
  return MEDIA_HOST_ALLOWLIST.some((d) => host === d || host.endsWith(`.${d}`)) ? u : null;
}

export interface CachedMedia {
  path: string;
  contentType: string;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly dir = process.env.MEDIA_CACHE_DIR || join(process.cwd(), 'static', 'media-cache');
  /** sha256 → stored file name, built from the directory on startup */
  private readonly index = new Map<string, string>();
  private readonly failures = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<CachedMedia | null>>();
  private fetchWindow = { start: 0, count: 0 };

  constructor() {
    try {
      mkdirSync(this.dir, { recursive: true });
      for (const f of readdirSync(this.dir)) {
        const m = /^([0-9a-f]{64})\.([a-z0-9]+)$/.exec(f);
        if (m) this.index.set(m[1], f);
      }
    } catch (err) {
      this.logger.warn(`media cache dir unavailable (${this.dir}): ${err.message}`);
    }
  }

  /** Cached file for an allowlisted URL, fetching it on first use; null when it can't be fetched. */
  async get(url: URL): Promise<CachedMedia | null> {
    const key = createHash('sha256').update(url.href).digest('hex');

    const file = this.index.get(key);
    if (file) {
      const path = join(this.dir, file);
      if (existsSync(path)) return { path, contentType: this.typeOf(file) };
      this.index.delete(key);
    }

    const failedAt = this.failures.get(key);
    if (failedAt && Date.now() - failedAt < FAILURE_TTL_MS) return null;

    let pending = this.inflight.get(key);
    if (!pending) {
      if (!this.takeFetchSlot()) return null;
      pending = this.fetchAndStore(url, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async fetchAndStore(url: URL, key: string): Promise<CachedMedia | null> {
    try {
      const res = await axios.get<ArrayBuffer>(url.href, {
        responseType: 'arraybuffer',
        timeout: FETCH_TIMEOUT_MS,
        maxContentLength: MAX_BYTES,
        maxBodyLength: MAX_BYTES,
        maxRedirects: 3,
        // Redirects must stay on allowlisted hosts too
        beforeRedirect: (opts: Record<string, any>) => {
          const target = `${opts.protocol}//${opts.hostname}${opts.port ? `:${opts.port}` : ''}${opts.path ?? ''}`;
          if (!isAllowedMediaUrl(target)) throw new Error(`redirect to non-allowlisted host ${opts.hostname}`);
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'image/*,video/*;q=0.9,*/*;q=0.5',
        },
        validateStatus: (s) => s === 200,
      });

      const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = EXT_BY_TYPE[contentType];
      if (!ext) throw new Error(`unsupported content-type "${contentType}"`);
      const body = Buffer.from(res.data);
      if (body.length === 0 || body.length > MAX_BYTES) throw new Error(`bad size ${body.length}`);

      const fileName = `${key}.${ext}`;
      const path = join(this.dir, fileName);
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, body);
      await rename(tmp, path);
      this.index.set(key, fileName);
      return { path, contentType };
    } catch (err) {
      this.rememberFailure(key);
      this.logger.debug(`media fetch failed ${url.hostname}: ${err.message}`);
      return null;
    }
  }

  private takeFetchSlot(): boolean {
    const now = Date.now();
    if (now - this.fetchWindow.start > 60_000) this.fetchWindow = { start: now, count: 0 };
    if (this.fetchWindow.count >= MAX_FETCHES_PER_MINUTE) return false;
    this.fetchWindow.count++;
    return true;
  }

  private rememberFailure(key: string) {
    if (this.failures.size >= MAX_REMEMBERED_FAILURES) {
      // Drop the oldest entry (Map keeps insertion order)
      const oldest = this.failures.keys().next().value;
      if (oldest) this.failures.delete(oldest);
    }
    this.failures.set(key, Date.now());
  }

  private typeOf(file: string): string {
    const ext = file.slice(file.lastIndexOf('.') + 1);
    return TYPE_BY_EXT[ext] || 'application/octet-stream';
  }
}
