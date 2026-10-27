import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FileStorageService, contentTypeFor } from './file-storage.service';

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString();
}

describe('FileStorageService (local driver)', () => {
  let dir: string;
  let storage: FileStorageService;
  const env = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'storage-'));
    delete process.env.S3_BUCKET;
    process.env.LOCAL_STORAGE_DIR = dir;
    storage = new FileStorageService();
  });

  afterEach(() => {
    process.env = { ...env };
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses the local driver without S3_BUCKET and has no public URL', () => {
    expect(storage.driver).toBe('local');
    expect(storage.publicUrl('avatars/a.jpg')).toBeNull();
  });

  it('accepts only the known prefixes and safe names', () => {
    expect(storage.isValidKey('avatars/abc-123.jpg')).toBe(true);
    expect(storage.isValidKey('media-cache/' + 'a'.repeat(64) + '.png')).toBe(true);
    expect(storage.isValidKey('other/x.jpg')).toBe(false);
    expect(storage.isValidKey('avatars/../secret')).toBe(false);
    expect(storage.isValidKey('avatars/sub/x.jpg')).toBe(false);
    expect(storage.isValidKey('avatars/')).toBe(false);
  });

  it('writes, reads, checks and deletes a file', async () => {
    await storage.put('avatars/p-1.jpg', Buffer.from('hello'), 'image/jpeg');
    expect(await storage.exists('avatars/p-1.jpg')).toBe(true);

    const got = await storage.get('avatars/p-1.jpg');
    expect(got?.contentType).toBe('image/jpeg');
    expect(got?.size).toBe(5);
    expect(await readAll(got!.stream)).toBe('hello');

    await storage.delete('avatars/p-1.jpg');
    expect(await storage.exists('avatars/p-1.jpg')).toBe(false);
    expect(await storage.get('avatars/p-1.jpg')).toBeNull();
  });

  it('refuses to write invalid keys and ignores invalid reads', async () => {
    await expect(storage.put('../escape.jpg', Buffer.from('x'), 'image/jpeg')).rejects.toThrow();
    expect(await storage.get('avatars/../../etc')).toBeNull();
    await expect(storage.delete('nope/x')).resolves.toBeUndefined();
  });

  it('builds direct URLs for a public S3 bucket, with an optional prefix', () => {
    process.env.S3_BUCKET = 'cyber';
    process.env.S3_PUBLIC_URL = 'https://cdn.example.com/cyber/';
    process.env.S3_PREFIX = 'test';
    const s3 = new FileStorageService();
    expect(s3.driver).toBe('s3');
    expect(s3.publicUrl('avatars/a.jpg')).toBe('https://cdn.example.com/cyber/test/avatars/a.jpg');
  });

  it('maps extensions to content types', () => {
    expect(contentTypeFor('media-cache/x.webp')).toBe('image/webp');
    expect(contentTypeFor('media-cache/x.mp4')).toBe('video/mp4');
    expect(contentTypeFor('media-cache/x.bin')).toBe('application/octet-stream');
  });
});
