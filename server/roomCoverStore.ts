// @ts-nocheck
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { SERVER_ROOT } from './config.js';

const root = SERVER_ROOT;

const COVERS_ROOT = process.env.ROOM_COVERS_DIR || path.join(root, 'data', 'room-covers');

export const MAX_COVER_BYTES = Number(process.env.HOST_COVER_MAX_BYTES || 700 * 1024);

function sanitizeRoomId(roomId) {
  return String(roomId || '').slice(0, 80).replace(/[^a-zA-Z0-9_-]/g, '-') || 'room';
}

function roomDir(roomId) {
  return path.join(COVERS_ROOT, sanitizeRoomId(roomId));
}

/**
 * @param {string} roomId
 * @param {Buffer} buf
 * @param {'image/jpeg'|'image/png'|'image/webp'} mime
 */
export async function saveRoomCoverImage(roomId, buf, mime) {
  if (buf.length > MAX_COVER_BYTES) {
    const err = new Error('cover_too_large');
    err.code = 'cover_too_large';
    throw err;
  }
  const ext = mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg';
  const id = `cv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const name = `${id}${ext}`;
  const dir = roomDir(roomId);
  await fs.promises.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, name);
  await fs.promises.writeFile(finalPath, buf);
  return { coverKey: name };
}

/**
 * @param {string} roomId
 * @param {string} coverKey
 */
export function getRoomCoverPath(roomId, coverKey) {
  const safe = path.basename(String(coverKey || ''));
  if (!safe || !safe.startsWith('cv_')) return null;
  const base = roomDir(roomId);
  const p = path.join(base, safe);
  if (!p.startsWith(base)) return null;
  return p;
}
