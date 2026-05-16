import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import express, { type Request, type Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  SERVER_AUDIO_ENABLED,
  CACHE_DIR,
  ingestHostRelayState,
  getPublicSnapshotForRoom,
  getSessionAudioPath,
  getSessionLibraryStorageKey,
  setSessionHostUserId,
  startAutonomousTicker,
  registerIdleHelpers,
  onPresenceTick,
} from './roomPlaybackEngine.js';
import { verifyStreamToken, verifyCoverToken } from './streamAuth.js';
import { importPublicAudioUrl } from './urlAudioImport.js';
import {
  gdriveConfigured,
  gdriveServiceAccountEmail,
  importDriveFolderAudio,
} from './googleDriveImport.js';
import { totalBytesForHost, saveTrackBytes, HOST_PLAYLIST_MAX_BYTES } from './hostMediaStore.js';
import { saveRoomCoverImage, getRoomCoverPath, MAX_COVER_BYTES } from './roomCoverStore.js';
import { isLibraryTrackId } from './libraryTracks.js';
import { getObjectStream } from './s3/minio.js';
import { ensureBucket } from './s3/minio.js';
import { verifyAppToken } from './auth/appJwt.js';
import { initFirebaseAdmin } from './auth/firebaseAdmin.js';
import authRoutes from './routes/auth.js';
import playlistRoutes from './routes/playlists.js';
import { PORT, isProd, PUBLIC_APP_ORIGIN, SERVER_ROOT } from './config.js';

const root = SERVER_ROOT;

type SyncWs = WebSocket & {
  clientId: string | null;
  roomId: string | null;
  isHost: boolean;
  userId: string | null;
};

let wss: WebSocketServer | null = null;

function openWsClientCount(roomId: string | null = null): number {
  if (!wss) return 0;
  let n = 0;
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const s = ws as SyncWs;
    if (roomId && s.roomId !== roomId) continue;
    n += 1;
  }
  return n;
}

function countHosts(roomId: string): number {
  if (!wss) return 0;
  let n = 0;
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const s = ws as SyncWs;
    if (s.roomId !== roomId) continue;
    if (s.isHost) n += 1;
  }
  return n;
}

function isVerifiedHostInRoom(roomId: string, ws: SyncWs): boolean {
  if (!ws.isHost || ws.roomId !== roomId) return false;
  return Boolean(ws.userId);
}

function isOpenHostInRoom(roomId: string, clientId: string): boolean {
  if (!wss || !roomId || !clientId) return false;
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const s = ws as SyncWs;
    if (s.roomId !== roomId) continue;
    if (!s.isHost) continue;
    if (s.clientId === clientId && s.userId) return true;
  }
  return false;
}

function send(ws: WebSocket, message: object) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* ignore */
  }
}

function broadcastRoom(roomId: string, message: object, except: WebSocket | null = null) {
  if (!wss) return;
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const s = ws as SyncWs;
    if (s.roomId !== roomId) continue;
    if (except && ws === except) continue;
    send(ws, message);
  }
}

function relayServerState(roomId: string, stateObj: object) {
  broadcastRoom(roomId, {
    type: 'relay',
    roomId,
    from: 'server',
    event: 'state',
    payload: { state: stateObj },
    serverNow: Date.now(),
  });
}

const engineCtx = {
  broadcast: relayServerState,
  onDownloadReady: (roomId: string) => {
    onPresenceTick(roomId, countHosts(roomId), openWsClientCount(roomId), engineCtx);
  },
};

function broadcastPresence(roomId: string) {
  broadcastRoom(roomId, {
    type: 'presence',
    roomId,
    connected: openWsClientCount(roomId),
    hostCount: countHosts(roomId),
    serverNow: Date.now(),
  });
  if (SERVER_AUDIO_ENABLED) {
    onPresenceTick(roomId, countHosts(roomId), openWsClientCount(roomId), engineCtx);
  }
}

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.webm') return 'audio/webm';
  if (ext === '.m4a' || ext === '.mp4') return 'audio/mp4';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.opus') return 'audio/opus';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function pipeFileRange(req: Request, res: Response, filePath: string) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.status(404).end();
    return;
  }
  const size = stat.size;
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeFromPath(filePath));
  res.setHeader('Cache-Control', 'private, max-age=60');

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (!m) {
      res.status(416).end();
      return;
    }
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = size - 1;
    start = Math.max(0, Math.min(start, size - 1));
    end = Math.max(start, Math.min(end, size - 1));
    const chunk = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(chunk));
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.setHeader('Content-Length', String(size));
  fs.createReadStream(filePath).pipe(res);
}

async function pipeMinioRange(req: Request, res: Response, storageKey: string) {
  const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  try {
    const out = await getObjectStream(storageKey, range);
    res.status(out.statusCode);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (out.contentLength != null) res.setHeader('Content-Length', String(out.contentLength));
    if (out.contentRange) res.setHeader('Content-Range', out.contentRange);
    out.stream.pipe(res);
  } catch {
    res.status(404).end();
  }
}

const app = express();
app.use(express.json({ limit: '64kb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin === PUBLIC_APP_ORIGIN || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Client-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

app.get('/api/state', (_req, res) => {
  res.json({ connected: openWsClientCount(), serverNow: Date.now(), serverAudio: SERVER_AUDIO_ENABLED });
});

app.post('/api/ping', (req, res) => {
  const s = Date.now();
  res.json({ s, t0: req.body?.t0 ?? null });
});

app.use('/api/auth', authRoutes);
app.use('/api/me/playlists', playlistRoutes);

app.post('/api/rooms/:roomId/control', (req, res) => {
  if (!SERVER_AUDIO_ENABLED) {
    res.status(503).json({ ok: false, error: 'server_audio_disabled' });
    return;
  }
  const secret = process.env.SERVER_AUDIO_SECRET;
  if (secret && req.headers['x-server-audio-secret'] !== secret) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  const roomId = String(req.params.roomId || '').slice(0, 80);
  const body = req.body || {};
  if (body.action === 'syncState' && body.state) {
    ingestHostRelayState(roomId, body.state, engineCtx, null);
    res.json({ ok: true });
    return;
  }
  res.status(400).json({ ok: false, error: 'unknown_action' });
});

app.get('/api/rooms/:roomId/audio', async (req, res) => {
  if (!SERVER_AUDIO_ENABLED) {
    res.status(503).end();
    return;
  }
  const roomId = String(req.params.roomId || '').slice(0, 80);
  const videoId = typeof req.query.videoId === 'string' ? req.query.videoId : '';
  const exp = Number(req.query.exp);
  const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
  if (!verifyStreamToken(roomId, videoId, exp, sig)) {
    res.status(403).end();
    return;
  }

  if (isLibraryTrackId(videoId)) {
    const storageKey = getSessionLibraryStorageKey(roomId, videoId);
    if (!storageKey) {
      res.status(404).end();
      return;
    }
    await pipeMinioRange(req, res, storageKey);
    return;
  }

  const filePath = getSessionAudioPath(roomId, videoId);
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).end();
    return;
  }
  pipeFileRange(req, res, filePath);
});

app.get('/api/host-audio/quota', async (req, res) => {
  if (!SERVER_AUDIO_ENABLED) {
    res.status(503).json({ ok: false, error: 'server_audio_disabled' });
    return;
  }
  const clientId = String(req.headers['x-client-id'] || '').slice(0, 120);
  if (!clientId) {
    res.status(400).json({ ok: false, error: 'missing_client_id' });
    return;
  }
  try {
    const usedBytes = await totalBytesForHost(clientId);
    res.json({ ok: true, usedBytes, maxBytes: HOST_PLAYLIST_MAX_BYTES });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e as Error)?.message || e) });
  }
});

app.get('/api/host-audio/gdrive-status', (_req, res) => {
  if (!SERVER_AUDIO_ENABLED) {
    res.status(503).json({ ok: false, error: 'server_audio_disabled' });
    return;
  }
  const email = gdriveServiceAccountEmail();
  res.json({
    ok: true,
    configured: gdriveConfigured(),
    serviceAccountEmail: email || undefined,
  });
});

app.post('/api/rooms/:roomId/host-audio/import-gdrive-folder', async (req, res) => {
  if (!SERVER_AUDIO_ENABLED) {
    res.status(503).json({ ok: false, error: 'server_audio_disabled' });
    return;
  }
  const roomId = String(req.params.roomId || '').slice(0, 80);
  const clientId = String(req.headers['x-client-id'] || '').slice(0, 120);
  if (!isOpenHostInRoom(roomId, clientId)) {
    res.status(403).json({ ok: false, error: 'not_host' });
    return;
  }
  if (!gdriveConfigured()) {
    res.status(503).json({ ok: false, error: 'gdrive_not_configured' });
    return;
  }
  const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : '';
  if (!folder) {
    res.status(400).json({ ok: false, error: 'missing_folder' });
    return;
  }
  try {
    const { imported, errors } = await importDriveFolderAudio(folder, {
      getRemainingBytes: async () => {
        const used = await totalBytesForHost(clientId);
        return HOST_PLAYLIST_MAX_BYTES - used;
      },
      saveOne: async (row) => {
        await saveTrackBytes(clientId, row.trackId, row.ext, row.buf);
      },
    });
    const usedAfter = await totalBytesForHost(clientId);
    res.json({
      ok: true,
      count: imported.length,
      items: imported,
      errors: errors.length ? errors : undefined,
      usedBytes: usedAfter,
      maxBytes: HOST_PLAYLIST_MAX_BYTES,
    });
  } catch (e) {
    const err = e as { code?: string; message?: string; errors?: unknown };
    const code = err.code || 'import_failed';
    const status =
      code === 'host_playlist_quota'
        ? 413
        : code === 'gdrive_not_configured' || code === 'gdrive_token_failed'
          ? 503
          : 400;
    res.status(status).json({
      ok: false,
      error: code,
      message: String(err.message || e),
      errors: err.errors,
    });
  }
});

app.post('/api/rooms/:roomId/host-audio/import-url', async (req, res) => {
  if (!SERVER_AUDIO_ENABLED) {
    res.status(503).json({ ok: false, error: 'server_audio_disabled' });
    return;
  }
  const roomId = String(req.params.roomId || '').slice(0, 80);
  const clientId = String(req.headers['x-client-id'] || '').slice(0, 120);
  if (!isOpenHostInRoom(roomId, clientId)) {
    res.status(403).json({ ok: false, error: 'not_host' });
    return;
  }
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url) {
    res.status(400).json({ ok: false, error: 'missing_url' });
    return;
  }
  try {
    const used = await totalBytesForHost(clientId);
    const remaining = HOST_PLAYLIST_MAX_BYTES - used;
    if (remaining <= 0) {
      res.status(413).json({ ok: false, error: 'host_playlist_quota', usedBytes: used, maxBytes: HOST_PLAYLIST_MAX_BYTES });
      return;
    }
    const imp = await importPublicAudioUrl(url, { remainingQuotaBytes: remaining });
    await saveTrackBytes(clientId, imp.trackId, imp.ext, imp.buf);
    const usedAfter = await totalBytesForHost(clientId);
    res.json({
      ok: true,
      trackId: imp.trackId,
      title: imp.title,
      sizeBytes: imp.sizeBytes,
      contentType: imp.contentType,
      usedBytes: usedAfter,
      maxBytes: HOST_PLAYLIST_MAX_BYTES,
    });
  } catch (e) {
    const err = e as { code?: string; message?: string; needed?: number; remaining?: number };
    const code = err.code || 'import_failed';
    const status = code === 'host_playlist_quota' ? 413 : 400;
    res.status(status).json({
      ok: false,
      error: code,
      message: String(err.message || e),
      needed: err.needed,
      remaining: err.remaining,
    });
  }
});

app.post(
  '/api/rooms/:roomId/cover-upload',
  express.raw({ type: '*/*', limit: MAX_COVER_BYTES }),
  async (req, res) => {
    if (!SERVER_AUDIO_ENABLED) {
      res.status(503).json({ ok: false, error: 'server_audio_disabled' });
      return;
    }
    const roomId = String(req.params.roomId || '').slice(0, 80);
    const clientId = String(req.headers['x-client-id'] || '').slice(0, 120);
    if (!isOpenHostInRoom(roomId, clientId)) {
      res.status(403).json({ ok: false, error: 'not_host' });
      return;
    }
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const allowed = ct === 'image/jpeg' || ct === 'image/png' || ct === 'image/webp';
    if (!allowed) {
      res.status(400).json({ ok: false, error: 'unsupported_image_type' });
      return;
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    if (!buf.length) {
      res.status(400).json({ ok: false, error: 'empty_body' });
      return;
    }
    try {
      const { coverKey } = await saveRoomCoverImage(roomId, buf, ct as 'image/jpeg' | 'image/png' | 'image/webp');
      res.json({ ok: true, coverImageKey: coverKey });
    } catch (e) {
      const err = e as { code?: string };
      const code = err.code || 'upload_failed';
      const status = code === 'cover_too_large' ? 413 : 400;
      res.status(status).json({ ok: false, error: code });
    }
  },
);

app.get('/api/rooms/:roomId/cover-image', (req, res) => {
  if (!SERVER_AUDIO_ENABLED) {
    res.status(503).end();
    return;
  }
  const roomId = String(req.params.roomId || '').slice(0, 80);
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  const exp = Number(req.query.exp);
  const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
  if (!verifyCoverToken(roomId, key, exp, sig)) {
    res.status(403).end();
    return;
  }
  const filePath = getRoomCoverPath(roomId, key);
  if (!filePath || !fs.existsSync(filePath)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', mimeFromPath(filePath));
  res.setHeader('Cache-Control', 'private, max-age=120');
  fs.createReadStream(filePath).pipe(res);
});

const dist = path.join(root, 'dist');

if (isProd && fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (req.path.startsWith('/api')) {
      next();
      return;
    }
    res.sendFile(path.join(dist, 'index.html'));
  });
}

const server = http.createServer(app);

wss = new WebSocketServer({ server, path: '/ws' });

registerIdleHelpers((roomId) => openWsClientCount(roomId));

if (SERVER_AUDIO_ENABLED) {
  startAutonomousTicker(engineCtx);
}

void ensureBucket().catch((e) => {
  console.warn('[minio] bucket bootstrap failed:', (e as Error).message);
});

initFirebaseAdmin();

wss.on('connection', (ws) => {
  const sock = ws as SyncWs;
  sock.clientId = null;
  sock.roomId = null;
  sock.isHost = false;
  sock.userId = null;

  send(ws, {
    type: 'hello',
    serverNow: Date.now(),
    connected: openWsClientCount(),
    serverAudio: SERVER_AUDIO_ENABLED,
  });

  ws.on('message', (raw) => {
    let msg: {
      type?: string;
      roomId?: string;
      clientId?: string;
      isHost?: boolean;
      authToken?: string;
      event?: string;
      payload?: { state?: object };
      includeSelf?: boolean;
    };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg?.type === 'join' && typeof msg.roomId === 'string') {
      const previousRoom = sock.roomId;
      sock.clientId = typeof msg.clientId === 'string' ? msg.clientId : sock.clientId;
      sock.roomId = msg.roomId.slice(0, 80);
      const wantsHost = Boolean(msg.isHost);
      const authTok = typeof msg.authToken === 'string' ? msg.authToken.trim() : '';
      let verifiedUserId: string | null = null;
      if (wantsHost && authTok) {
        const payload = verifyAppToken(authTok);
        if (payload) verifiedUserId = payload.sub;
      }
      sock.isHost = wantsHost && Boolean(verifiedUserId);
      sock.userId = verifiedUserId;

      if (sock.isHost && sock.userId && sock.roomId) {
        setSessionHostUserId(sock.roomId, sock.userId);
      }

      if (previousRoom && previousRoom !== sock.roomId) {
        broadcastPresence(previousRoom);
      }

      send(ws, {
        type: 'joined',
        roomId: sock.roomId,
        connected: openWsClientCount(sock.roomId),
        hostCount: countHosts(sock.roomId),
        hostVerified: sock.isHost,
        serverNow: Date.now(),
        serverAudio: SERVER_AUDIO_ENABLED,
      });
      broadcastPresence(sock.roomId);
      broadcastRoom(
        sock.roomId,
        {
          type: 'relay',
          roomId: sock.roomId,
          from: sock.clientId,
          event: 'peer-joined',
          payload: { clientId: sock.clientId },
          serverNow: Date.now(),
        },
        ws,
      );
      return;
    }

    if (msg?.type === 'relay' && sock.roomId) {
      if (SERVER_AUDIO_ENABLED && msg.event === 'request-state') {
        const snap = getPublicSnapshotForRoom(sock.roomId);
        if (snap) {
          send(ws, {
            type: 'relay',
            roomId: sock.roomId,
            from: 'server',
            event: 'state',
            payload: { state: snap },
            serverNow: Date.now(),
          });
        }
      }

      const skipFanout = SERVER_AUDIO_ENABLED && msg.event === 'state' && isVerifiedHostInRoom(sock.roomId, sock);
      if (!skipFanout) {
        broadcastRoom(
          sock.roomId,
          {
            type: 'relay',
            roomId: sock.roomId,
            from: sock.clientId,
            event: msg.event,
            payload: msg.payload ?? null,
            serverNow: Date.now(),
          },
          msg.includeSelf ? null : ws,
        );
      }

      if (
        SERVER_AUDIO_ENABLED &&
        msg.event === 'state' &&
        isVerifiedHostInRoom(sock.roomId, sock) &&
        msg.payload?.state
      ) {
        ingestHostRelayState(sock.roomId, msg.payload.state, engineCtx, sock.clientId);
      }
    }
  });

  ws.on('close', () => {
    const roomId = sock.roomId;
    if (!roomId) return;
    queueMicrotask(() => {
      broadcastPresence(roomId);
      broadcastRoom(roomId, {
        type: 'relay',
        roomId,
        from: sock.clientId,
        event: 'peer-left',
        payload: { clientId: sock.clientId },
        serverNow: Date.now(),
      });
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `relay server http://127.0.0.1:${PORT} prod=${isProd} serverAudio=${SERVER_AUDIO_ENABLED}` +
      (SERVER_AUDIO_ENABLED ? ` audioCache=${CACHE_DIR}` : ''),
  );
});
