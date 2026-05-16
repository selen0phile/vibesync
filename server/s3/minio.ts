import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';
import { PUBLIC_APP_ORIGIN, s3Config, S3_PRESIGN_GET_TTL_SEC, S3_PRESIGN_PUT_TTL_SEC } from '../config.js';

let internalClient: S3Client | null = null;
let publicClient: S3Client | null = null;
let bucketReady = false;

function makeClient(endpoint: string): S3Client {
  const cfg = s3Config();
  return new S3Client({
    endpoint,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
    forcePathStyle: true,
  });
}

/** Server-side API calls (head, get stream, bucket admin). */
export function getS3Client(): S3Client {
  if (!internalClient) {
    const cfg = s3Config();
    internalClient = makeClient(cfg.endpoint);
  }
  return internalClient;
}

/** Presigned URLs returned to browsers must use the public hostname (not localhost). */
export function getPublicS3Client(): S3Client {
  if (!publicClient) {
    const cfg = s3Config();
    publicClient = makeClient(cfg.publicEndpoint);
  }
  return publicClient;
}

export function getBucket(): string {
  return s3Config().bucket;
}

async function ensureBucketCors(): Promise<void> {
  const origins = new Set<string>();
  if (PUBLIC_APP_ORIGIN) origins.add(PUBLIC_APP_ORIGIN);
  const extra = process.env.CORS_ALLOWED_ORIGINS || process.env.MINIO_CORS_ORIGINS || '';
  for (const o of extra.split(',')) {
    const t = o.trim();
    if (t) origins.add(t);
  }
  origins.add('http://localhost:5173');
  origins.add('http://127.0.0.1:5173');
  origins.add('https://music.jaber.me');
  const s3 = getS3Client();
  const Bucket = getBucket();
  try {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [...origins],
              AllowedMethods: ['GET', 'PUT', 'HEAD', 'POST'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag', 'Content-Length'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
  } catch (e) {
    console.warn('[minio] CORS setup skipped or failed:', (e as Error).message);
  }
}

export async function ensureBucket(): Promise<void> {
  if (bucketReady) return;
  const s3 = getS3Client();
  const Bucket = getBucket();
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket }));
  }
  await ensureBucketCors();
  bucketReady = true;
}

export function userTrackKey(userId: string, trackId: string): string {
  return `user/${userId}/tracks/${trackId}.mp3`;
}

export async function presignPut(storageKey: string, contentType: string): Promise<string> {
  const s3 = getPublicS3Client();
  const cmd = new PutObjectCommand({
    Bucket: getBucket(),
    Key: storageKey,
    ContentType: contentType,
  });
  return getSignedUrl(s3, cmd, { expiresIn: S3_PRESIGN_PUT_TTL_SEC });
}

export async function presignGet(storageKey: string): Promise<string> {
  const s3 = getPublicS3Client();
  const cmd = new GetObjectCommand({
    Bucket: getBucket(),
    Key: storageKey,
  });
  return getSignedUrl(s3, cmd, { expiresIn: S3_PRESIGN_GET_TTL_SEC });
}

export async function headObject(storageKey: string) {
  const s3 = getS3Client();
  return s3.send(
    new HeadObjectCommand({
      Bucket: getBucket(),
      Key: storageKey,
    }),
  );
}

export async function getObjectStream(
  storageKey: string,
  range?: string,
): Promise<{ stream: Readable; contentType: string; contentLength?: number; contentRange?: string; statusCode: number }> {
  const s3 = getS3Client();
  const out = await s3.send(
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: storageKey,
      Range: range,
    }),
  );
  if (!out.Body) {
    throw new Error('empty_body');
  }
  return {
    stream: out.Body as Readable,
    contentType: out.ContentType || 'audio/mpeg',
    contentLength: out.ContentLength,
    contentRange: out.ContentRange,
    statusCode: range && out.ContentRange ? 206 : 200,
  };
}
