import { Injectable, Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createReadStream, existsSync } from 'fs';
import { mkdir, rename, stat, unlink, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { Readable } from 'stream';

/**
 * Where uploaded and cached files live.
 *
 * - **S3** (any S3-compatible service: AWS, ArvanCloud, MinIO, Hetzner…) when
 *   `S3_BUCKET` is set. Files survive redeploys and can be served straight
 *   from the bucket/CDN when `S3_PUBLIC_URL` is set.
 * - **Local disk** under `static/` otherwise — fine for development, but
 *   files are lost on every container redeploy unless a volume is mounted.
 *
 * Keys are relative paths like `avatars/<id>-<ts>.jpg` or
 * `media-cache/<sha256>.jpg`; only the prefixes in ALLOWED_PREFIXES exist.
 */

export const ALLOWED_PREFIXES = ['avatars/', 'media-cache/'] as const;
const KEY_PATTERN = /^(avatars|media-cache)\/[A-Za-z0-9._-]{1,120}$/;

export interface StoredFile {
  stream: Readable;
  contentType: string;
  size?: number;
}

@Injectable()
export class FileStorageService {
  private readonly logger = new Logger(FileStorageService.name);

  readonly driver: 's3' | 'local';
  private readonly s3?: S3Client;
  private readonly bucket = process.env.S3_BUCKET || '';
  private readonly prefix = (process.env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '');
  private readonly publicBase = (process.env.S3_PUBLIC_URL || '').replace(/\/+$/, '');
  private readonly localRoot = resolve(process.env.LOCAL_STORAGE_DIR || join(process.cwd(), 'static'));

  constructor() {
    if (this.bucket) {
      this.driver = 's3';
      this.s3 = new S3Client({
        region: process.env.S3_REGION || 'us-east-1',
        endpoint: process.env.S3_ENDPOINT || undefined,
        forcePathStyle: /^(1|true|yes)$/i.test(process.env.S3_FORCE_PATH_STYLE || ''),
        credentials:
          process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
            ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
            : undefined,
      });
      this.logger.log(
        `File storage: S3 bucket "${this.bucket}"${process.env.S3_ENDPOINT ? ` at ${process.env.S3_ENDPOINT}` : ''}` +
          (this.publicBase ? `, public URL ${this.publicBase}` : ', served through the API'),
      );
    } else {
      this.driver = 'local';
      this.logger.log(`File storage: local disk at ${this.localRoot} (set S3_BUCKET to use S3)`);
    }
  }

  /** True for keys this service is willing to read or write. */
  isValidKey(key: string): boolean {
    return KEY_PATTERN.test(key) && !key.includes('..');
  }

  /**
   * Direct public URL for a key when the bucket is publicly readable
   * (S3_PUBLIC_URL set); null when files must be served through the API.
   */
  publicUrl(key: string): string | null {
    if (this.driver !== 's3' || !this.publicBase) return null;
    return `${this.publicBase}/${this.objectKey(key)}`;
  }

  async put(key: string, body: Buffer, contentType: string, cacheControl?: string): Promise<void> {
    this.assertKey(key);
    if (this.s3) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(key),
          Body: body,
          ContentType: contentType,
          CacheControl: cacheControl,
        }),
      );
      return;
    }
    const path = this.localPath(key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, path);
  }

  async exists(key: string): Promise<boolean> {
    if (!this.isValidKey(key)) return false;
    if (this.s3) {
      try {
        await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
        return true;
      } catch (err) {
        if (this.isNotFound(err)) return false;
        throw err;
      }
    }
    return existsSync(this.localPath(key));
  }

  /** Stream a stored file, or null when it doesn't exist. */
  async get(key: string): Promise<StoredFile | null> {
    if (!this.isValidKey(key)) return null;
    if (this.s3) {
      try {
        const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
        return {
          stream: out.Body as Readable,
          contentType: out.ContentType || contentTypeFor(key),
          size: out.ContentLength,
        };
      } catch (err) {
        if (this.isNotFound(err)) return null;
        throw err;
      }
    }
    const path = this.localPath(key);
    try {
      const st = await stat(path);
      return { stream: createReadStream(path), contentType: contentTypeFor(key), size: st.size };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    if (!this.isValidKey(key)) return;
    try {
      if (this.s3) {
        await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      } else {
        await unlink(this.localPath(key));
      }
    } catch (err) {
      if (!this.isNotFound(err) && err?.code !== 'ENOENT') {
        this.logger.warn(`Could not delete ${key}: ${err.message}`);
      }
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private assertKey(key: string) {
    if (!this.isValidKey(key)) throw new Error(`invalid storage key "${key}"`);
  }

  private objectKey(key: string) {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  private localPath(key: string) {
    const path = resolve(this.localRoot, key);
    if (!path.startsWith(this.localRoot + sep)) throw new Error(`storage key escapes root: ${key}`);
    return path;
  }

  private isNotFound(err: any) {
    const status = err?.$metadata?.httpStatusCode;
    return status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey';
  }
}

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export function contentTypeFor(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase() || '';
  return TYPES[ext] || 'application/octet-stream';
}
