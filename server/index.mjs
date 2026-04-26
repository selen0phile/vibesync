import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const PORT = Number(process.env.PORT || 3847);
const isProd = process.env.NODE_ENV === 'production';

/** Filled after `WebSocketServer` is constructed — used for accurate client counts. */
let wss = /** @type {import('ws').WebSocketServer | null} */ (null);

function openWsClientCount(roomId = null) {
  if (!wss) return 0;
  let n = 0;
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (roomId && ws.roomId !== roomId) continue;
    n += 1;
  }
  return n;
}

function send(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(message));
  } catch {
    /* ignore broken pipe */
  }
}

function broadcastRoom(roomId, message, except = null) {
  if (!wss) return;
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.roomId !== roomId) continue;
    if (except && ws === except) continue;
    send(ws, message);
  }
}

function broadcastPresence(roomId) {
  broadcastRoom(roomId, {
    type: 'presence',
    roomId,
    connected: openWsClientCount(roomId),
    serverNow: Date.now(),
  });
}

const app = express();
app.use(express.json({ limit: '32kb' }));

app.get('/api/state', (_req, res) => {
  res.json({ connected: openWsClientCount(), serverNow: Date.now() });
});

/** Clock sync probe: client sends { t0: Date.now() }; responds with server time `s` for RTT / offset EWMA. */
app.post('/api/ping', (req, res) => {
  const s = Date.now();
  res.json({ s, t0: req.body?.t0 ?? null });
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

wss.on('connection', (ws) => {
  ws.clientId = null;
  ws.roomId = null;

  send(ws, {
    type: 'hello',
    serverNow: Date.now(),
    connected: openWsClientCount(),
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg?.type === 'join' && typeof msg.roomId === 'string') {
      const previousRoom = ws.roomId;
      ws.clientId = typeof msg.clientId === 'string' ? msg.clientId : ws.clientId;
      ws.roomId = msg.roomId.slice(0, 80);

      if (previousRoom && previousRoom !== ws.roomId) {
        broadcastPresence(previousRoom);
      }

      send(ws, {
        type: 'joined',
        roomId: ws.roomId,
        connected: openWsClientCount(ws.roomId),
        serverNow: Date.now(),
      });
      broadcastPresence(ws.roomId);
      broadcastRoom(
        ws.roomId,
        {
          type: 'relay',
          roomId: ws.roomId,
          from: ws.clientId,
          event: 'peer-joined',
          payload: { clientId: ws.clientId },
          serverNow: Date.now(),
        },
        ws,
      );
      return;
    }

    if (msg?.type === 'relay' && ws.roomId) {
      broadcastRoom(
        ws.roomId,
        {
          type: 'relay',
          roomId: ws.roomId,
          from: ws.clientId,
          event: msg.event,
          payload: msg.payload ?? null,
          serverNow: Date.now(),
        },
        msg.includeSelf ? null : ws,
      );
    }
  });

  ws.on('close', () => {
    const roomId = ws.roomId;
    if (!roomId) return;
    queueMicrotask(() => {
      broadcastPresence(roomId);
      broadcastRoom(roomId, {
        type: 'relay',
        roomId,
        from: ws.clientId,
        event: 'peer-left',
        payload: { clientId: ws.clientId },
        serverNow: Date.now(),
      });
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`relay server http://127.0.0.1:${PORT} prod=${isProd}`);
});
