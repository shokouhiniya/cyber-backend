/**
 * Integration test against a real S3-compatible server. Skipped unless
 * S3_TEST_ENDPOINT is set, e.g. with a throwaway MinIO:
 *
 *   docker run -d -p 127.0.0.1:9310:9000 -e MINIO_ROOT_USER=minioadmin \
 *     -e MINIO_ROOT_PASSWORD=<secret> minio/minio server /data
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9310 S3_TEST_KEY=minioadmin S3_TEST_SECRET=<secret> \
 *     npx jest file-storage.s3
 */
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';

import { FileStorageService } from './file-storage.service';

const endpoint = process.env.S3_TEST_ENDPOINT;
const run = endpoint ? describe : describe.skip;

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString();
}

run('FileStorageService (S3 driver, integration)', () => {
  const env = { ...process.env };
  const bucket = `cyber-test-${Date.now()}`;
  let storage: FileStorageService;

  beforeAll(async () => {
    const credentials = { accessKeyId: process.env.S3_TEST_KEY!, secretAccessKey: process.env.S3_TEST_SECRET! };
    const admin = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials });
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));

    Object.assign(process.env, {
      S3_BUCKET: bucket,
      S3_ENDPOINT: endpoint,
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: credentials.accessKeyId,
      S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      S3_PREFIX: 'it',
    });
    delete process.env.S3_PUBLIC_URL;
    storage = new FileStorageService();
  });

  afterAll(() => {
    process.env = { ...env };
  });

  it('round-trips a file with its content type', async () => {
    expect(storage.driver).toBe('s3');
    await storage.put('media-cache/abc.png', Buffer.from('png-bytes'), 'image/png');
    expect(await storage.exists('media-cache/abc.png')).toBe(true);
    const got = await storage.get('media-cache/abc.png');
    expect(got?.contentType).toBe('image/png');
    expect(await readAll(got!.stream)).toBe('png-bytes');
  });

  it('reports missing objects as absent and deletes', async () => {
    expect(await storage.exists('avatars/missing.jpg')).toBe(false);
    expect(await storage.get('avatars/missing.jpg')).toBeNull();
    await storage.put('avatars/p-1.jpg', Buffer.from('x'), 'image/jpeg');
    await storage.delete('avatars/p-1.jpg');
    expect(await storage.exists('avatars/p-1.jpg')).toBe(false);
  });
});
