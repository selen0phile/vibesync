# VibeSync

**Listen together. Stay in sync.**

VibeSync is a web app for watching YouTube together in real time: shared rooms, WebSocket relay, and playback aligned across everyone in the session.

![VibeSync — promotional overview](docs/vibesync-promo.png)

## Features

- **Real-time sync** — Keep playback aligned across clients via WebSockets and clock sync helpers.
- **Rooms** — Join a shared session; presence and counts update live.
- **YouTube playback** — Coordinated watch experience in the room UI.
- **WebSocket-powered** — `ws` server bundled with a small Express API (`/api/state`, `/api/ping`).

## Stack

| Layer    | Technology                          |
| -------- | ----------------------------------- |
| UI       | React 19, React Router 7, Tailwind 4 |
| Build    | Vite 5                              |
| Server   | Node.js, Express 4                |
| Realtime | WebSocket (`ws`)                   |

## Requirements

- Node.js (LTS recommended)
- npm

## Setup

```bash
cp .env.example .env
npm install
```

Optional: edit `.env` — default **`PORT=3847`**.

## Scripts

| Command        | Description                                      |
| -------------- | ------------------------------------------------ |
| `npm run dev`  | Runs the WebSocket/API server and Vite dev server together |
| `npm run dev:server` | API + WebSocket server only                  |
| `npm run build`| Production build to `dist/`                      |
| `npm run start`| Serves `dist/` + server (set `NODE_ENV=production`) |
| `npm run lint` | ESLint                                             |
| `npm run preview` | Preview production build (Vite only)         |

## Development

```bash
npm run dev
```

This runs the Node server on **`PORT`** (default **3847**) and Vite on its own port (often **5173**). Vite proxies **`/api`** and **`/ws`** to `http://127.0.0.1:3847`, so use the Vite URL in the browser (for example `http://localhost:5173`).

## Routes

- `/` — Main listen / room experience  
- `/how-it-works` — How it works (lazy-loaded markdown page)

## Production

```bash
npm run build
NODE_ENV=production npm run start
```

Ensure `dist/` exists from `npm run build` before `npm run start`.
