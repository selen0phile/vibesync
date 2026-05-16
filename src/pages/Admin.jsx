import { useState, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useRadioSocket } from '../hooks/useRadioSocket';
import { useYouTubeSync, YT_PLAYER_MOUNT_ID } from '../hooks/useYouTubeSync';

const LS_KEY = 'syncwatch-admin-token';

function parseYouTubeId(input) {
  if (!input || typeof input !== 'string') return null;
  const u = input.trim();
  if (!u) return null;
  const short = u.match(/youtu\.be\/([^?&/]+)/);
  if (short) return short[1];
  const v = u.match(/[?&]v=([^&]+)/);
  if (v) return v[1];
  const embed = u.match(/youtube\.com\/embed\/([^?&/]+)/);
  if (embed) return embed[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(u)) return u;
  return null;
}

function IconScreen() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 6h12v12H6z" />
    </svg>
  );
}

export default function Admin() {
  const { state } = useRadioSocket();
  const [token, setToken] = useState(() => localStorage.getItem(LS_KEY) || '');
  const [url, setUrl] = useState('');
  const [hasError, setHasError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (token) localStorage.setItem(LS_KEY, token);
  }, [token]);

  const control = useCallback(
    async (body) => {
      setHasError(false);
      setBusy(true);
      try {
        const r = await fetch('/api/control', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token.trim()}`,
          },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          setHasError(true);
          window.setTimeout(() => setHasError(false), 2400);
          return;
        }
      } catch {
        setHasError(true);
        window.setTimeout(() => setHasError(false), 2400);
      } finally {
        setBusy(false);
      }
    },
    [token],
  );

  const onControl = useCallback(
    (p) => {
      if (!token.trim()) return;
      if (p.action === 'play') void control({ action: 'play', time: p.time });
      if (p.action === 'pause') void control({ action: 'pause', time: p.time });
    },
    [control, token],
  );

  useYouTubeSync({
    serverState: state,
    isController: true,
    onControl,
    ignoreEchoMs: 900,
    suspendPlayback: false,
  });

  const id = parseYouTubeId(url);

  const btnViolet =
    'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-violet-500/40 bg-violet-600/40 text-white hover:bg-violet-600/55 disabled:opacity-30 disabled:pointer-events-none';
  const btnMuted =
    'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-white/15 bg-white/5 text-white/90 hover:bg-white/15 disabled:opacity-30 disabled:pointer-events-none';
  const btnEmerald =
    'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-700/40 text-white hover:bg-emerald-600/50 disabled:opacity-30 disabled:pointer-events-none';
  const btnAmber =
    'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-amber-600/40 bg-amber-800/35 text-white hover:bg-amber-700/45 disabled:opacity-30 disabled:pointer-events-none';
  const btnRed =
    'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-red-500/40 bg-red-900/45 text-white hover:bg-red-800/55 disabled:opacity-30 disabled:pointer-events-none';

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <div className="flex items-center justify-end px-3 py-3">
        <Link
          to="/"
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white/90 hover:bg-white/20"
          aria-hidden
        >
          <IconScreen />
        </Link>
      </div>

      <main className="flex-1 flex flex-col gap-4 p-4 max-w-3xl mx-auto w-full">
        <div className={`flex flex-col gap-3 ${hasError ? 'ring-2 ring-red-500/80 rounded-xl p-3 -m-0' : ''}`}>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            className="w-full rounded-xl bg-white/5 border border-white/15 px-4 py-3 text-sm text-white outline-none focus:border-white/35"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full rounded-xl bg-white/5 border border-white/15 px-4 py-3 text-sm text-white font-mono outline-none focus:border-white/35"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || !token.trim() || !id} onClick={() => void control({ action: 'load', url, play: true })} className={btnViolet} aria-hidden>
            <IconPlay />
          </button>
          <button type="button" disabled={busy || !token.trim() || !id} onClick={() => void control({ action: 'load', url, play: false })} className={btnMuted} aria-hidden>
            <IconPause />
          </button>
          <button type="button" disabled={busy || !token.trim() || !state?.videoId} onClick={() => void control({ action: 'play' })} className={btnEmerald} aria-hidden>
            <IconPlay />
          </button>
          <button type="button" disabled={busy || !token.trim() || !state?.videoId} onClick={() => void control({ action: 'pause' })} className={btnAmber} aria-hidden>
            <IconPause />
          </button>
          <button type="button" disabled={busy || !token.trim()} onClick={() => void control({ action: 'stop' })} className={btnRed} aria-hidden>
            <IconStop />
          </button>
        </div>

        <div className="w-full aspect-video bg-black rounded-xl overflow-hidden border border-white/10">
          <div id={YT_PLAYER_MOUNT_ID} className="h-full w-full" />
        </div>
      </main>
    </div>
  );
}
