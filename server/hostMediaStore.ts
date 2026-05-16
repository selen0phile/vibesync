// @ts-nocheck
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { SERVER_ROOT } from './config.js';

const root = SERVER_ROOT;

export const HOST_MEDIA_ROOT = process.env.HOST_MEDIA_DIR || path.join(root, 'data', 'host-media');

/** Total bytes of imported URL audio allowed per host identity (default 100 MiB). */
export const HOST_PLAYLIST_MAX_BYTES = Number(process.env.HOST_PLAYLIST_MAX_BYTES || 100 * 1024 * 1024);

export function sanitizeHostId(hostClientId) {
  const s = String(hostClientId || '').slice(0, 120);
  return s.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function hostBase(hostClientId) {
  return path.join(HOST_MEDIA_ROOT, 'audio', sanitizeHostId(hostClientId));
}

export function trackPathFor(hostClientId, trackId) {
  return path.join(hostBase(hostClientId), `${trackId}`);
}

export async function totalBytesForHost(hostClientId) {
  const dir = hostBase(hostClientId);
  let total = 0;
  try {
    const names = await fs.promises.readdir(dir);
    for (const n of names) {
      try {
        const st = await fs.promises.stat(path.join(dir, n));
        if (st.isFile()) total += st.size;
      } catch {
        /* */
      }
    }
  } catch {
    /* missing */
  }
  return total;
}

/**
 * @param {string} hostClientId
 * @param {string} trackId
 * @returns {Promise<string | null>}
 */
export async function findExistingTrackFile(hostClientId, trackId) {
  const base = hostBase(hostClientId);
  const tid = String(trackId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!tid) return null;
  try {
    const names = await fs.promises.readdir(base);
    const hit = names.find((f) => f === tid || f.startsWith(`${tid}.`));
    return hit ? path.join(base, hit) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} hostClientId
 * @param {number} additionalBytes
 */
export async function assertQuota(hostClientId, additionalBytes) {
  const cur = await totalBytesForHost(hostClientId);
  if (cur + additionalBytes > HOST_PLAYLIST_MAX_BYTES) {
    const err = new Error('host_playlist_quota');
    err.code = 'host_playlist_quota';
    err.cur = cur;
    err.max = HOST_PLAYLIST_MAX_BYTES;
    throw err;
  }
}

/**
 * Write atomically: temp then rename.
 * @param {string} hostClientId
 * @param {string} trackId
 * @param {string} extWithDot e.g. ".m4a"
 * @param {Buffer} data
 */
export async function saveTrackBytes(hostClientId, trackId, extWithDot, data) {
  const dir = hostBase(hostClientId);
  await fs.promises.mkdir(dir, { recursive: true });
  const prior = await findExistingTrackFile(hostClientId, trackId);
  if (prior) {
    try {
      await fs.promises.unlink(prior);
    } catch {
      /* */
    }
  }
  await assertQuota(hostClientId, data.length);
  const safeExt = /^\.[a-z0-9]{1,8}$/i.test(extWithDot) ? extWithDot : '.bin';
  const finalPath = path.join(dir, `${trackId}${safeExt}`);
  const tmp = `${finalPath}.${Date.now()}.part`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, finalPath);
  return finalPath;
}
