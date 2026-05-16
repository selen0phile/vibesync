// @ts-nocheck
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { signStreamToken, signCoverToken } from './streamAuth.js';
import { downloadBestAudio } from './ytdlpWorker.js';
import { findExistingTrackFile } from './hostMediaStore.js';
import { isLibraryTrackId, resolveLibraryTrackForUser } from './libraryTracks.js';

import { SERVER_ROOT } from './config.js';

const root = SERVER_ROOT;

function envBool(k, def = false) {
  const v = process.env[k];
  if (v == null || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

export const SERVER_AUDIO_ENABLED = envBool('SERVER_AUDIO_ENABLED', false);

export const CACHE_DIR = process.env.AUDIO_CACHE_DIR || path.join(root, 'data', 'audio-cache');
const IDLE_TTL_MS = Number(process.env.ROOM_IDLE_TTL_MS || 30 * 60_000);
const MAX_CACHE_BYTES = Number(process.env.AUDIO_CACHE_MAX_BYTES || 8 * 1024 ** 3);

/**
 * @param {{ videoId?: string | null, playing?: boolean, positionSec?: number, stampMs?: number, syncSeq?: number, durationSec?: number }} s
 * @param {number} wallMs
 */
export function effectivePositionSec(s, wallMs) {
  if (s.videoId == null) return 0;
  const dur = s.durationSec;
  const raw =
    !s.playing
      ? Number(s.positionSec) || 0
      : (Number(s.positionSec) || 0) + Math.max(0, wallMs - Number(s.stampMs || 0)) / 1000;
  if (!Number.isFinite(dur) || dur <= 1) return raw;
  if (!s.playing) return Math.min(dur, Math.max(0, raw));
  return ((raw % dur) + dur) % dur;
}

function normPlaylist(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw.slice(0, 80)) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    const title = String(row.title || id || 'track').slice(0, 200);
    const sizeBytes = typeof row.sizeBytes === 'number' && Number.isFinite(row.sizeBytes) ? row.sizeBytes : undefined;
    if (!id) continue;
    out.push({ id, title, sizeBytes });
  }
  return out;
}

function emptyInnerState() {
  return {
    videoId: null,
    playing: false,
    positionSec: 0,
    stampMs: Date.now(),
    syncSeq: 0,
    durationSec: undefined,
    /** @type {'youtube'|'server_audio'} */
    playbackMode: 'youtube',
    downloadStatus: /** @type {'idle'|'downloading'|'ready'|'error'|'skipped'} */ ('idle'),
    downloadError: /** @type {string | null} */ (null),
    playlist: [],
    coverImageUrl: null,
    coverImageKey: null,
    /** @type {'off'|'all'|'one'} */
    playlistRepeatMode: 'off',
    playlistShuffle: false,
  };
}

/** @typedef {(roomId: string, payload: object) => void} BroadcastFn */

/** @type {Map<string, ReturnType<typeof createSession>>} */
const sessions = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const idleTimers = new Map();

/** @type {null | ((roomId: string) => number)} */
let countClientsFn = null;

function createSession(roomId) {
  return {
    roomId,
    inner: emptyInnerState(),
    autonomous: false,
    downloading: /** @type {Promise<void> | null} */ (null),
    cachePath: /** @type {string | null} */ (null),
    cachedVideoId: /** @type {string | null} */ (null),
    /** Last WebSocket host identity (for resolving per-host URL imports). */
    lastHostClientId: /** @type {string | null} */ (null),
    /** Authenticated host user id (Postgres). */
    lastHostUserId: /** @type {string | null} */ (null),
    /** MinIO key when playing a library track (`lib_*`). */
    libraryStorageKey: /** @type {string | null} */ (null),
  };
}

export function registerIdleHelpers(getOpenClientCount) {
  countClientsFn = getOpenClientCount;
}

export function getOrCreateSession(roomId) {
  let s = sessions.get(roomId);
  if (!s) {
    s = createSession(roomId);
    sessions.set(roomId, s);
  }
  return s;
}

function clearIdleTimer(roomId) {
  const t = idleTimers.get(roomId);
  if (t) clearTimeout(t);
  idleTimers.delete(roomId);
}

function scheduleIdleEviction(roomId) {
  clearIdleTimer(roomId);
  idleTimers.set(
    roomId,
    setTimeout(() => {
      idleTimers.delete(roomId);
      const n = countClientsFn ? countClientsFn(roomId) : 0;
      if (n <= 0) {
        sessions.delete(roomId);
      }
    }, IDLE_TTL_MS),
  );
}

export function isUrlTrackId(videoId) {
  return typeof videoId === 'string' && /^u_[a-f0-9]{16}$/.test(videoId);
}

/**
 * @param {object} raw
 */
function normalizeHostPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const videoId = raw.videoId == null ? null : String(raw.videoId).slice(0, 40);
  const playbackMode = raw.playbackMode === 'server_audio' ? 'server_audio' : 'youtube';
  const coverImageUrl =
    raw.coverImageUrl == null || raw.coverImageUrl === '' ? null : String(raw.coverImageUrl).slice(0, 2048);
  const coverImageKey =
    raw.coverImageKey == null || raw.coverImageKey === ''
      ? null
      : path.basename(String(raw.coverImageKey)).slice(0, 200);
  /** @type {Record<string, unknown>} */
  const out = {
    videoId,
    playing: Boolean(raw.playing),
    positionSec: Number(raw.positionSec) || 0,
    stampMs: typeof raw.stampMs === 'number' ? raw.stampMs : Date.now(),
    syncSeq: typeof raw.syncSeq === 'number' ? raw.syncSeq : 0,
    durationSec: typeof raw.durationSec === 'number' ? raw.durationSec : undefined,
    playbackMode,
    playlist: normPlaylist(raw.playlist),
    coverImageUrl,
    coverImageKey,
  };
  if ('playlistRepeatMode' in raw) {
    out.playlistRepeatMode =
      raw.playlistRepeatMode === 'all' || raw.playlistRepeatMode === 'one' || raw.playlistRepeatMode === 'off'
        ? raw.playlistRepeatMode
        : 'off';
  }
  if ('playlistShuffle' in raw) {
    out.playlistShuffle = Boolean(raw.playlistShuffle);
  }
  return out;
}

function attachStreamAuth(roomId, inner) {
  const base = {
    ...inner,
    audioStreamAuth: undefined,
    coverImageAuth: undefined,
    serverAudioEnabled: SERVER_AUDIO_ENABLED,
  };
  if (
    SERVER_AUDIO_ENABLED &&
    inner.playbackMode === 'server_audio' &&
    inner.coverImageKey &&
    String(inner.coverImageKey).startsWith('cv_')
  ) {
    const exp = Date.now() + 3_600_000;
    const { sig } = signCoverToken(roomId, inner.coverImageKey, exp);
    base.coverImageAuth = { exp, sig };
  }
  if (
    !SERVER_AUDIO_ENABLED ||
    inner.playbackMode !== 'server_audio' ||
    !inner.videoId ||
    inner.downloadStatus !== 'ready'
  ) {
    return base;
  }
  const exp = Date.now() + 3_600_000;
  const { sig } = signStreamToken(roomId, inner.videoId, exp);
  return { ...base, audioStreamAuth: { exp, sig } };
}

/** Full client-visible state object */
export function toPublicState(sess) {
  const i = sess.inner;
  const ready = i.downloadStatus === 'ready' && sess.cachePath && sess.cachedVideoId === i.videoId;
  const downloadStatus = ready ? 'ready' : i.downloadStatus;
  return attachStreamAuth(sess.roomId, {
    videoId: i.videoId,
    playing: i.playing,
    positionSec: i.positionSec,
    stampMs: i.stampMs,
    syncSeq: i.syncSeq,
    durationSec: i.durationSec,
    playbackMode: i.playbackMode === 'server_audio' ? 'server_audio' : 'youtube',
    downloadStatus,
    downloadError: i.downloadError,
    autonomous: sess.autonomous,
    serverAudioEnabled: SERVER_AUDIO_ENABLED,
    playlist: i.playlist || [],
    coverImageUrl: i.coverImageUrl,
    coverImageKey: i.coverImageKey,
    playlistRepeatMode:
      i.playlistRepeatMode === 'all' || i.playlistRepeatMode === 'one' || i.playlistRepeatMode === 'off'
        ? i.playlistRepeatMode
        : 'off',
    playlistShuffle: Boolean(i.playlistShuffle),
  });
}

function snapshotAt(sess, wallMs) {
  const pos = effectivePositionSec(sess.inner, wallMs);
  sess.inner.positionSec = pos;
  sess.inner.stampMs = wallMs;
}

/**
 * @param {{ inner: object, cachePath: string | null, cachedVideoId: string | null }} sess
 */
function resetSessionCache(sess) {
  sess.inner.downloadStatus = 'idle';
  sess.inner.downloadError = null;
  sess.cachePath = null;
  sess.cachedVideoId = null;
  sess.libraryStorageKey = null;
}

/**
 * @param {string} roomId
 * @param {object} rawState
 * @param {{ broadcast: BroadcastFn, onDownloadReady?: (rid: string) => void }} ctx
 * @param {string | null | undefined} hostClientId
 */
export function setSessionHostUserId(roomId, userId) {
  if (!userId) return;
  const sess = getOrCreateSession(roomId);
  sess.lastHostUserId = String(userId).slice(0, 80);
}

export function ingestHostRelayState(roomId, rawState, ctx, hostClientId) {
  if (!SERVER_AUDIO_ENABLED) return;

  const norm = normalizeHostPayload(rawState);
  if (!norm) return;

  const sess = getOrCreateSession(roomId);
  const raw = rawState && typeof rawState === 'object' ? rawState : null;
  /** Host ticks often omit these keys; `normalizeHostPayload` maps missing → null which would wipe art for everyone. */
  const preserveCoverUrl = Boolean(raw && !('coverImageUrl' in raw));
  const preserveCoverKey = Boolean(raw && !('coverImageKey' in raw));
  const preservePlaylist = Boolean(raw && !('playlist' in raw));
  const preservePlaylistRepeatMode = Boolean(raw && !('playlistRepeatMode' in raw));
  const preservePlaylistShuffle = Boolean(raw && !('playlistShuffle' in raw));
  const prevCoverUrl = sess.inner.coverImageUrl;
  const prevCoverKey = sess.inner.coverImageKey;
  const prevPlaylist = sess.inner.playlist || [];
  const prevPlaylistRepeatMode =
    sess.inner.playlistRepeatMode === 'all' || sess.inner.playlistRepeatMode === 'one' || sess.inner.playlistRepeatMode === 'off'
      ? sess.inner.playlistRepeatMode
      : 'off';
  const prevPlaylistShuffle = Boolean(sess.inner.playlistShuffle);

  sess.autonomous = false;
  if (hostClientId) sess.lastHostClientId = String(hostClientId).slice(0, 120);

  const prevVid = sess.inner.videoId;
  const prevMode = sess.inner.playbackMode === 'server_audio' ? 'server_audio' : 'youtube';
  Object.assign(sess.inner, norm);
  if (preserveCoverUrl) sess.inner.coverImageUrl = prevCoverUrl;
  if (preserveCoverKey) sess.inner.coverImageKey = prevCoverKey;
  if (preservePlaylist) sess.inner.playlist = prevPlaylist;
  if (preservePlaylistRepeatMode) sess.inner.playlistRepeatMode = prevPlaylistRepeatMode;
  if (preservePlaylistShuffle) sess.inner.playlistShuffle = prevPlaylistShuffle;
  sess.inner.playbackMode = norm.playbackMode;
  sess.inner.downloadStatus = sess.inner.downloadStatus || 'idle';

  if (!norm.videoId) {
    resetSessionCache(sess);
  } else {
    const vidChanged = norm.videoId !== prevVid;
    const modeNow = sess.inner.playbackMode;
    const switchedToServerAudio = modeNow === 'server_audio' && prevMode !== 'server_audio';

    if (modeNow === 'youtube' && prevMode === 'server_audio') {
      resetSessionCache(sess);
    } else if (vidChanged) {
      resetSessionCache(sess);
      if (modeNow === 'server_audio') {
        queueDownload(roomId, norm.videoId, ctx);
      }
    } else if (switchedToServerAudio) {
      resetSessionCache(sess);
      queueDownload(roomId, norm.videoId, ctx);
    }
  }

  clearIdleTimer(roomId);
  void maybeTrimCache();
  ctx.broadcast(roomId, toPublicState(sess));
}

/**
 * @param {number} hosts
 * @param {number} clients
 * @param {{ broadcast: BroadcastFn, onDownloadReady?: (rid: string) => void }} ctx
 */
export function onPresenceTick(roomId, hosts, clients, ctx) {
  if (!SERVER_AUDIO_ENABLED) return;

  const sess = sessions.get(roomId);
  if (clients === 0) {
    scheduleIdleEviction(roomId);
    return;
  }
  clearIdleTimer(roomId);

  if (!sess || !sess.inner.videoId) return;

  const wasAutonomous = sess.autonomous;
  const mode = sess.inner.playbackMode === 'server_audio' ? 'server_audio' : 'youtube';

  if (hosts === 0 && mode === 'youtube' && sess.inner.playing) {
    snapshotAt(sess, Date.now());
    sess.inner.playing = false;
    sess.autonomous = false;
    ctx.broadcast(roomId, toPublicState(sess));
    return;
  }

  const libraryReady =
    isLibraryTrackId(sess.inner.videoId) &&
    sess.libraryStorageKey &&
    sess.cachedVideoId === sess.inner.videoId;
  const fileReady = sess.cachePath && sess.cachedVideoId === sess.inner.videoId;
  if (
    hosts === 0 &&
    mode === 'server_audio' &&
    sess.inner.playing &&
    sess.inner.downloadStatus === 'ready' &&
    (fileReady || libraryReady)
  ) {
    snapshotAt(sess, Date.now());
    sess.autonomous = true;
    ctx.broadcast(roomId, toPublicState(sess));
  }

  if (hosts > 0) {
    sess.autonomous = false;
    if (wasAutonomous) {
      ctx.broadcast(roomId, toPublicState(sess));
    }
  }
}

/**
 * @param {string} roomId
 * @param {string} videoId
 * @param {{ broadcast: BroadcastFn, onDownloadReady?: (rid: string) => void }} ctx
 */
function queueDownload(roomId, videoId, ctx) {
  const sess = getOrCreateSession(roomId);
  if (!SERVER_AUDIO_ENABLED) return;
  if (sess.inner.playbackMode !== 'server_audio') return;

  if (isLibraryTrackId(videoId)) {
    if (sess.downloading) return;
    sess.inner.downloadStatus = 'downloading';
    sess.inner.downloadError = null;
    const job = (async () => {
      try {
        const uid = sess.lastHostUserId;
        if (!uid) {
          if (sess.inner.videoId === videoId && sess.inner.playbackMode === 'server_audio') {
            sess.inner.downloadStatus = 'error';
            sess.inner.downloadError = 'no_host_user';
          }
          return;
        }
        const track = await resolveLibraryTrackForUser(uid, videoId);
        if (track && sess.inner.videoId === videoId && sess.inner.playbackMode === 'server_audio') {
          sess.libraryStorageKey = track.storageKey;
          sess.cachePath = null;
          sess.cachedVideoId = videoId;
          sess.inner.downloadStatus = 'ready';
          sess.inner.downloadError = null;
        } else if (sess.inner.videoId === videoId && sess.inner.playbackMode === 'server_audio') {
          sess.inner.downloadStatus = 'error';
          sess.inner.downloadError = 'library_track_missing';
        }
      } catch (e) {
        sess.inner.downloadStatus = 'error';
        sess.inner.downloadError = String((e as Error)?.message || e);
      } finally {
        sess.downloading = null;
        ctx.broadcast(roomId, toPublicState(sess));
        ctx.onDownloadReady?.(roomId);
      }
    })();
    sess.downloading = job;
    return;
  }

  if (isUrlTrackId(videoId)) {
    if (sess.downloading) return;
    sess.inner.downloadStatus = 'downloading';
    sess.inner.downloadError = null;
    const job = (async () => {
      try {
        const hid = sess.lastHostClientId;
        if (!hid) {
          if (sess.inner.videoId === videoId && sess.inner.playbackMode === 'server_audio') {
            sess.inner.downloadStatus = 'error';
            sess.inner.downloadError = 'no_host_identity';
          }
          return;
        }
        const existing = await findExistingTrackFile(hid, videoId);
        if (existing && sess.inner.videoId === videoId && sess.inner.playbackMode === 'server_audio') {
          sess.cachePath = existing;
          sess.cachedVideoId = videoId;
          sess.inner.downloadStatus = 'ready';
          sess.inner.downloadError = null;
        } else if (sess.inner.videoId === videoId && sess.inner.playbackMode === 'server_audio') {
          sess.inner.downloadStatus = 'error';
          sess.inner.downloadError = 'host_audio_missing';
        }
      } catch (e) {
        sess.inner.downloadStatus = 'error';
        sess.inner.downloadError = String(e?.message || e);
      } finally {
        sess.downloading = null;
        ctx.broadcast(roomId, toPublicState(sess));
        ctx.onDownloadReady?.(roomId);
      }
    })();
    sess.downloading = job;
    return;
  }

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    sess.inner.downloadStatus = 'skipped';
    sess.inner.downloadError = 'invalid_id';
    ctx.broadcast(roomId, toPublicState(sess));
    return;
  }

  if (sess.downloading) return;

  sess.inner.downloadStatus = 'downloading';
  sess.inner.downloadError = null;

  const job = (async () => {
    try {
      await fs.promises.mkdir(CACHE_DIR, { recursive: true });
      const existing = await findCachedFile(videoId);
      if (existing) {
        if (sess.inner.videoId === videoId && sess.inner.playbackMode === 'server_audio') {
          sess.cachePath = existing;
          sess.cachedVideoId = videoId;
          sess.inner.downloadStatus = 'ready';
          sess.inner.downloadError = null;
        }
        ctx.broadcast(roomId, toPublicState(sess));
        ctx.onDownloadReady?.(roomId);
      } else {
        const r = await downloadBestAudio({
          cacheDir: CACHE_DIR,
          videoId,
        });
        if (
          r.ok &&
          r.filePath &&
          sess.inner.videoId === videoId &&
          sess.inner.playbackMode === 'server_audio'
        ) {
          sess.cachePath = r.filePath;
          sess.cachedVideoId = videoId;
          sess.inner.downloadStatus = 'ready';
          sess.inner.downloadError = null;
          if (r.durationSec && (!sess.inner.durationSec || sess.inner.durationSec <= 1)) {
            sess.inner.durationSec = r.durationSec;
          }
        } else if (sess.inner.videoId === videoId && sess.inner.playbackMode === 'server_audio') {
          sess.inner.downloadStatus = 'error';
          sess.inner.downloadError = r.error || 'download_failed';
        }
      }
    } catch (e) {
      sess.inner.downloadStatus = 'error';
      sess.inner.downloadError = String(e?.message || e);
    } finally {
      sess.downloading = null;
      ctx.broadcast(roomId, toPublicState(sess));
      ctx.onDownloadReady?.(roomId);
    }
  })();

  sess.downloading = job;
}

async function findCachedFile(videoId) {
  try {
    const files = await fs.promises.readdir(CACHE_DIR);
    const hit = files.find((f) => f.startsWith(`${videoId}.`) && !f.endsWith('.part'));
    return hit ? path.join(CACHE_DIR, hit) : null;
  } catch {
    return null;
  }
}

export function getSessionAudioPath(roomId, videoId) {
  const sess = sessions.get(roomId);
  if (!sess || sess.inner.playbackMode !== 'server_audio') return null;
  if (sess.inner.videoId !== videoId || sess.inner.downloadStatus !== 'ready') return null;
  if (sess.cachedVideoId !== videoId) return null;
  if (isLibraryTrackId(videoId)) return null;
  if (!sess.cachePath) return null;
  return sess.cachePath;
}

export function getSessionLibraryStorageKey(roomId, videoId) {
  const sess = sessions.get(roomId);
  if (!sess || sess.inner.playbackMode !== 'server_audio') return null;
  if (sess.inner.videoId !== videoId || sess.inner.downloadStatus !== 'ready') return null;
  if (sess.cachedVideoId !== videoId) return null;
  if (!isLibraryTrackId(videoId)) return null;
  return sess.libraryStorageKey || null;
}

export function getPublicSnapshotForRoom(roomId) {
  if (!SERVER_AUDIO_ENABLED) return null;
  const sess = sessions.get(roomId);
  if (!sess || !sess.inner.videoId) return null;
  if (sess.autonomous) snapshotAt(sess, Date.now());
  return toPublicState(sess);
}

async function maybeTrimCache() {
  try {
    await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    const names = await fs.promises.readdir(CACHE_DIR);
    let total = 0;
    const entries = [];
    for (const n of names) {
      try {
        const p = path.join(CACHE_DIR, n);
        const st = await fs.promises.stat(p);
        if (st.isFile()) {
          total += st.size;
          entries.push({ p, t: st.mtimeMs, size: st.size });
        }
      } catch {
        /* */
      }
    }
    if (total <= MAX_CACHE_BYTES) return;
    entries.sort((a, b) => a.t - b.t);
    for (const e of entries) {
      if (total <= MAX_CACHE_BYTES * 0.85) break;
      try {
        await fs.promises.unlink(e.p);
        total -= e.size;
      } catch {
        /* */
      }
    }
  } catch {
    /* */
  }
}

/**
 * @param {{ broadcast: BroadcastFn, onDownloadReady?: (rid: string) => void }} ctx
 */
export function startAutonomousTicker(ctx) {
  setInterval(() => {
    if (!SERVER_AUDIO_ENABLED) return;
    for (const sess of sessions.values()) {
      if (!sess.autonomous || !sess.inner.playing || !sess.inner.videoId) continue;
      snapshotAt(sess, Date.now());
      ctx.broadcast(sess.roomId, toPublicState(sess));
    }
  }, 1000);
}
