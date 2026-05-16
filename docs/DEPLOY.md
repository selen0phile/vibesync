# Deployment guide

This document covers deploying VibeSync on a single VM (API + static UI on one Node process) with PostgreSQL, MinIO, and Firebase host auth. Adjust hostnames and paths for your environment.

## Architecture

```text
Browser (https://music.example.com)
    │
    ▼
Reverse proxy (nginx / Caddy) ──TLS──► Node (127.0.0.1:3847)
    │                                      ├── Express /api
    │                                      ├── WebSocket /ws
    │                                      └── static dist/
    │
    ├── PostgreSQL (localhost:5432)
    └── MinIO API (internal localhost:9000, public https://minio.example.com)
```

Listeners only need the app URL. Hosts need Firebase Google sign-in and working MinIO **browser** uploads via `MINIO_PUBLIC_URL`.

## Prerequisites

- Node.js 20+
- PostgreSQL 16+ (or Docker)
- MinIO (or Docker)
- Firebase project: Google provider enabled, authorized domains set
- Firebase Admin service account JSON on the server (not in git)
- Reverse proxy with TLS for the app (and usually for MinIO)

## Production `.env` checklist

Copy from `.env.example` and set at minimum:

| Variable | Notes |
| -------- | ----- |
| `PORT` | Default `3847`; Node binds `127.0.0.1` only |
| `NODE_ENV` | Set to `production` for `npm run start` (via script) |
| `PUBLIC_APP_ORIGIN` | Public app URL, e.g. `https://music.example.com` |
| `DATABASE_URL` | Postgres connection string |
| `JWT_SECRET` | Long random secret (not the dev default) |
| `VITE_FIREBASE_*` | Web app config (baked into `dist/` at build time) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to Admin service account JSON |
| `MINIO_INTERNAL_ENDPOINT` | Server-side API, e.g. `http://127.0.0.1:9000` |
| `MINIO_PUBLIC_URL` | **HTTPS URL browsers use**, e.g. `https://minio.example.com` |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_BUCKET` | Match your MinIO deployment |
| `USER_AUDIO_QUOTA_BYTES` | Default `104857600` (100 MiB) |
| `SERVER_AUDIO_ENABLED` | `true` if using cached/YouTube audio features |
| `CORS_ALLOWED_ORIGINS` | Optional comma list; app also sets MinIO CORS for `PUBLIC_APP_ORIGIN` |

Rebuild the frontend after changing any `VITE_*` variable:

```bash
npm run build
```

## Infrastructure

### Docker Compose (dev / small prod)

From the repo root:

```bash
docker compose up -d
```

Align `DATABASE_URL` and MinIO credentials with `docker-compose.yml` / your `.env`.

### MinIO in production

1. **Public URL** — Presigned upload URLs must use `MINIO_PUBLIC_URL`, not `localhost`, or browsers will block cross-origin PUTs.
2. **TLS** — Terminate HTTPS on `minio.example.com` (nginx → MinIO `:9000`).
3. **CORS** — On startup the app attempts to set bucket CORS for `PUBLIC_APP_ORIGIN` and common dev origins. If uploads still fail, add CORS in the MinIO console for your app origin with methods `PUT`, `GET`, `HEAD` and headers `*`.
4. **Bucket** — Ensure `MINIO_BUCKET` exists (the app creates it on start if missing).

### Firebase

1. **Authentication → Sign-in method** — Enable Google.
2. **Authentication → Settings → Authorized domains** — Add `music.example.com` and `localhost` (for dev).
3. **Service account** — Project settings → Service accounts → Generate key. Store outside the repo, e.g. `~/.config/syncwatch/firebase-adminsdk.json`, and set `GOOGLE_APPLICATION_CREDENTIALS`.

## Build and deploy on the VM

From the project root:

```bash
npm install
npm run build:deploy
```

This runs:

1. `npm run build:server` → `build/server/`
2. `npm run build` → `dist/`
3. `prisma migrate deploy`
4. Restarts the server via `scripts/deploy-local.sh` (stops old listener on `PORT`, starts `npm run start`)

Logs: `server.log` in the project root.

Manual equivalent:

```bash
npm run build:all
npm run db:migrate
NODE_ENV=production npm run start
```

## Reverse proxy (nginx example)

Node listens on `127.0.0.1:3847`. Example server block for the app:

```nginx
server {
    listen 443 ssl http2;
    server_name music.example.com;

    # ssl_certificate / ssl_certificate_key …

    location / {
        proxy_pass http://127.0.0.1:3847;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3847;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;
    }
}
```

Set `PUBLIC_APP_ORIGIN=https://music.example.com` to match.

For MinIO, proxy `minio.example.com` to `http://127.0.0.1:9000` with a large `client_max_body_size` for MP3 uploads.

## Post-deploy checks

```bash
# Server up
curl -s http://127.0.0.1:3847/api/state

# SPA
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3847/

# Migrations applied
npm run db:migrate

# Public (via proxy)
curl -s https://music.example.com/api/state
```

In the browser as host:

1. Sign in with Google — `POST /api/auth/session` should return `200` and a `token`.
2. Upload an MP3 — network tab should show **PUT to `https://minio.example.com/...`**, not `localhost:9000`.
3. Join WebSocket with host — relay should show you as host only when signed in.

## Troubleshooting

| Symptom | Likely cause |
| ------- | ------------- |
| `firebase_admin_not_configured` | Missing or wrong `GOOGLE_APPLICATION_CREDENTIALS` |
| `invalid_id_token` / JWT errors | Clock skew, wrong Firebase project, or expired token; retry sign-in |
| CORS error on upload to `localhost:9000` | Set `MINIO_PUBLIC_URL` to public HTTPS host; rebuild/restart server |
| `404` on `/` in production | Run `npm run build` so `dist/` exists; check `NODE_ENV=production` |
| Host not controlling room | Sign in first; WS `join` must include valid `authToken` |
| `EADDRINUSE` on deploy | Old process still on `PORT`; `deploy-local.sh` kills it, or stop manually |

```bash
tail -50 server.log
ss -tlnp | grep 3847
```

## Secrets and releases

- Never commit `.env` or Firebase Admin JSON.
- Rotate `JWT_SECRET`, DB password, and MinIO keys if they were ever exposed.
- After changing `VITE_FIREBASE_*`, run `npm run build` (or `build:deploy`) before serving.

## systemd (optional)

Instead of `nohup`, you can run `npm run start` under systemd with `WorkingDirectory` set to the repo, `EnvironmentFile=/path/to/.env`, and `NODE_ENV=production`. Point `ExecStart` at `node build/server/index.js`.
