import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { USER_AUDIO_QUOTA_BYTES } from '../config.js';
import { ensureBucket, headObject, presignPut, userTrackKey } from '../s3/minio.js';
import { libraryTrackIdFromUuid } from '../libraryTracks.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req: AuthedRequest, res) => {
  const playlists = await prisma.playlist.findMany({
    where: { userId: req.userId! },
    orderBy: { updatedAt: 'desc' },
    include: {
      tracks: { orderBy: { position: 'asc' } },
    },
  });
  res.json({
    ok: true,
    playlists: playlists.map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      tracks: p.tracks.map((t) => ({
        id: t.id,
        libraryId: libraryTrackIdFromUuid(t.id),
        title: t.title,
        position: t.position,
        bytes: Number(t.bytes),
        mime: t.mime,
        status: t.status,
        durationSec: t.durationSec,
      })),
    })),
  });
});

const createSchema = z.object({ name: z.string().min(1).max(120) });

router.post('/', async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'invalid_body' });
    return;
  }
  const playlist = await prisma.playlist.create({
    data: { userId: req.userId!, name: parsed.data.name.trim() },
  });
  res.status(201).json({ ok: true, playlist: { id: playlist.id, name: playlist.name } });
});

router.patch('/:playlistId', async (req: AuthedRequest, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ ok: false, error: 'invalid_name' });
    return;
  }
  const updated = await prisma.playlist.updateMany({
    where: { id: String(req.params.playlistId), userId: req.userId! },
    data: { name },
  });
  if (!updated.count) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  res.json({ ok: true });
});

router.delete('/:playlistId', async (req: AuthedRequest, res) => {
  const deleted = await prisma.playlist.deleteMany({
    where: { id: String(req.params.playlistId), userId: req.userId! },
  });
  if (!deleted.count) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  res.json({ ok: true });
});

const presignSchema = z.object({
  playlistId: z.string().uuid(),
  title: z.string().min(1).max(200),
  bytes: z.number().int().positive().max(USER_AUDIO_QUOTA_BYTES),
  mime: z.string().optional(),
});

router.post('/tracks/presign', async (req: AuthedRequest, res) => {
  const parsed = presignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: 'invalid_body' });
    return;
  }
  const { playlistId, title, bytes, mime } = parsed.data;
  const playlist = await prisma.playlist.findFirst({
    where: { id: playlistId, userId: req.userId! },
  });
  if (!playlist) {
    res.status(404).json({ ok: false, error: 'playlist_not_found' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) {
    res.status(404).json({ ok: false, error: 'user_not_found' });
    return;
  }
  const used = Number(user.audioBytesUsed);
  if (used + bytes > USER_AUDIO_QUOTA_BYTES) {
    res.status(413).json({
      ok: false,
      error: 'quota_exceeded',
      usedBytes: used,
      maxBytes: USER_AUDIO_QUOTA_BYTES,
    });
    return;
  }
  const contentType = mime?.startsWith('audio/') ? mime : 'audio/mpeg';
  const track = await prisma.playlistTrack.create({
    data: {
      playlistId,
      title: title.trim(),
      bytes: BigInt(bytes),
      mime: contentType,
      status: 'pending',
      position: await prisma.playlistTrack.count({ where: { playlistId } }),
    },
  });
  const storageKey = userTrackKey(req.userId!, track.id);
  await ensureBucket();
  const uploadUrl = await presignPut(storageKey, contentType);
  await prisma.playlistTrack.update({
    where: { id: track.id },
    data: { storageKey },
  });
  res.json({
    ok: true,
    trackId: track.id,
    libraryId: libraryTrackIdFromUuid(track.id),
    uploadUrl,
    storageKey,
    headers: { 'Content-Type': contentType },
  });
});

router.post('/tracks/:trackId/complete', async (req: AuthedRequest, res) => {
  const track = await prisma.playlistTrack.findFirst({
    where: {
      id: String(req.params.trackId),
      playlist: { userId: req.userId! },
    },
    include: { playlist: true },
  });
  if (!track || !track.storageKey) {
    res.status(404).json({ ok: false, error: 'track_not_found' });
    return;
  }
  let head;
  try {
    head = await headObject(track.storageKey);
  } catch {
    res.status(400).json({ ok: false, error: 'object_missing' });
    return;
  }
  const size = Number(head.ContentLength || 0);
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) {
    res.status(404).json({ ok: false, error: 'user_not_found' });
    return;
  }
  const usedWithout = Number(user.audioBytesUsed) - Number(track.status === 'ready' ? track.bytes : 0n);
  if (usedWithout + size > USER_AUDIO_QUOTA_BYTES) {
    res.status(413).json({ ok: false, error: 'quota_exceeded' });
    return;
  }
  const updated = await prisma.$transaction(async (tx) => {
    const prev = await tx.playlistTrack.findUnique({ where: { id: track.id } });
    const prevBytes = prev?.status === 'ready' ? Number(prev.bytes) : 0;
    const t = await tx.playlistTrack.update({
      where: { id: track.id },
      data: { status: 'ready', bytes: BigInt(size) },
    });
    await tx.user.update({
      where: { id: req.userId! },
      data: {
        audioBytesUsed: {
          increment: BigInt(size - prevBytes),
        },
      },
    });
    return t;
  });
  res.json({
    ok: true,
    track: {
      id: updated.id,
      libraryId: libraryTrackIdFromUuid(updated.id),
      title: updated.title,
      bytes: Number(updated.bytes),
      status: updated.status,
    },
  });
});

router.delete('/tracks/:trackId', async (req: AuthedRequest, res) => {
  const track = await prisma.playlistTrack.findFirst({
    where: {
      id: String(req.params.trackId),
      playlist: { userId: req.userId! },
    },
  });
  if (!track) {
    res.status(404).json({ ok: false, error: 'not_found' });
    return;
  }
  await prisma.$transaction(async (tx) => {
    if (track.status === 'ready') {
      await tx.user.update({
        where: { id: req.userId! },
        data: { audioBytesUsed: { decrement: track.bytes } },
      });
    }
    await tx.playlistTrack.delete({ where: { id: track.id } });
  });
  res.json({ ok: true });
});

export default router;
