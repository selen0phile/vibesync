import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Project root: works for `tsx server/` (dev) and `node build/server/` (prod). */
export function resolveProjectRoot(): string {
  if (process.env.SYNCWATCH_ROOT) return process.env.SYNCWATCH_ROOT;
  const parent = path.basename(path.dirname(__dirname));
  const self = path.basename(__dirname);
  if (self === 'server' && parent === 'build') return path.join(__dirname, '..', '..');
  if (self === 'server') return path.join(__dirname, '..');
  return process.cwd();
}

export const SERVER_ROOT = resolveProjectRoot();

export const PORT = Number(process.env.PORT || 3847);
export const isProd = process.env.NODE_ENV === 'production';
export const PUBLIC_APP_ORIGIN = process.env.PUBLIC_APP_ORIGIN || 'http://localhost:5173';

export const USER_AUDIO_QUOTA_BYTES = Number(
  process.env.USER_AUDIO_QUOTA_BYTES || process.env.HOST_PLAYLIST_MAX_BYTES || 100 * 1024 * 1024,
);

export function envBool(k: string, def = false): boolean {
  const v = process.env[k];
  if (v == null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

export const SERVER_AUDIO_ENABLED = envBool('SERVER_AUDIO_ENABLED', false);

export function s3Config() {
  const endpoint =
    process.env.S3_ENDPOINT ||
    process.env.MINIO_INTERNAL_ENDPOINT ||
    process.env.MINIO_ENDPOINT ||
    'http://localhost:9000';
  const publicEndpoint =
    process.env.S3_PUBLIC_URL || process.env.MINIO_PUBLIC_URL || endpoint;
  const accessKey = process.env.S3_ACCESS_KEY || process.env.MINIO_ACCESS_KEY || '';
  const secretKey = (process.env.S3_SECRET_KEY || process.env.MINIO_SECRET_KEY || '').replace(/\\\$/g, '$');
  const bucket = process.env.S3_BUCKET || process.env.MINIO_BUCKET || 'syncwatch-audio';
  const region = process.env.S3_REGION || 'us-east-1';
  const useSsl = envBool('S3_USE_SSL', endpoint.startsWith('https'));
  return { endpoint, publicEndpoint, accessKey, secretKey, bucket, region, useSsl };
}

export const S3_PRESIGN_PUT_TTL_SEC = Number(process.env.S3_PRESIGN_PUT_TTL_SEC || 600);
export const S3_PRESIGN_GET_TTL_SEC = Number(process.env.S3_PRESIGN_GET_TTL_SEC || 3600);
