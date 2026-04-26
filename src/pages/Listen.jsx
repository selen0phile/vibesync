import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useRoomRelay } from '../hooks/useRoomRelay';
import { useYouTubeSync } from '../hooks/useYouTubeSync';
import * as clockSync from '../lib/clockSync.js';
import { DEFAULT_ROOM, createRoom, getRoomState, joinRoom, saveRoomState } from '../lib/localStore.js';

const SCHEDULED_PLAY_DELAY_MS = 1400;

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

function emptyState() {
  return {
    videoId: null,
    playing: false,
    positionSec: 0,
    stampMs: nowMs(),
    syncSeq: 0,
  };
}

function nowMs() {
  return Date.now() + clockSync.getSkewMs();
}

function effectivePosition(state) {
  const duration = state?.durationSec;
  const rawPosition = !state?.playing
    ? (state?.positionSec ?? 0)
    : (state.positionSec ?? 0) + Math.max(0, nowMs() - state.stampMs) / 1000;
  if (!Number.isFinite(duration) || duration <= 1) return rawPosition;
  if (!state?.playing) return Math.min(duration, Math.max(0, rawPosition));
  return ((rawPosition % duration) + duration) % duration;
}

function IconPlay() {
  return (
    <svg className="h-10 w-10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg className="h-10 w-10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  );
}

function IconHeadphones() {
  return (
    <svg className="h-4 w-4 text-white/75" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
    </svg>
  );
}

export default function Listen({ forcedRoom = null }) {
  useSyncExternalStore(clockSync.subscribeClock, clockSync.getClockTick, clockSync.getClockTick);
  const [isTunedIn, setIsTunedIn] = useState(false);
  const [radioState, setRadioState] = useState(emptyState);
  const [url, setUrl] = useState('');
  const [roomInput, setRoomInput] = useState('');
  const stateRef = useRef(radioState);
  const roomRef = useRef(null);
  const lastEndedRestartAt = useRef(0);
  stateRef.current = radioState;

  const relayRef = useRef(null);

  const publishState = useCallback((nextState) => {
    setRadioState(nextState);
    if (roomRef.current?.isHost) {
      void saveRoomState(roomRef.current.id, nextState);
      relayRef.current?.('state', { state: nextState });
    }
  }, []);

  const handleRelay = useCallback(
    (msg) => {
      if (msg.event === 'state' && !roomRef.current?.isHost && msg.payload?.state) {
        setRadioState(msg.payload.state);
      }
      if ((msg.event === 'request-state' || msg.event === 'peer-joined') && roomRef.current?.isHost) {
        relayRef.current?.('state', { state: stateRef.current });
      }
    },
    [],
  );

  const { connected: wsLive, connectedUsers, room, setRoom, sendRelay } = useRoomRelay(handleRelay);
  roomRef.current = room;
  relayRef.current = sendRelay;

  useEffect(() => {
    if (!forcedRoom) return;
    if (room.id === forcedRoom.id && room.isHost === forcedRoom.isHost) return;
    void setRoom(forcedRoom);
    setIsTunedIn(true);
  }, [forcedRoom, room.id, room.isHost, setRoom]);

  const suspendPlayback = !isTunedIn;
  const publishLoopSeek = useCallback(() => {
    const now = Date.now();
    if (now - lastEndedRestartAt.current < 5000) return false;
    lastEndedRestartAt.current = now;
    publishState({
      ...stateRef.current,
      playing: true,
      positionSec: 0,
      stampMs: nowMs(),
      syncSeq: (stateRef.current.syncSeq ?? 0) + 1,
    });
    return true;
  }, [publishState]);

  const { unmute, syncMetrics, getCurrentTime, getDuration, seekTo } = useYouTubeSync({
    serverState: radioState,
    isController: room.isHost,
    onControl: (payload) => {
      if (!roomRef.current?.isHost || !stateRef.current.videoId) return;
      const base = {
        ...stateRef.current,
        positionSec: payload.time,
        stampMs: payload.action === 'play' ? nowMs() + SCHEDULED_PLAY_DELAY_MS : nowMs(),
        playing: payload.action === 'play',
        syncSeq: (stateRef.current.syncSeq ?? 0) + 1,
      };
      publishState(base);
    },
    ignoreEchoMs: 0,
    suspendPlayback: room.isHost ? false : suspendPlayback,
  });

  useEffect(() => {
    if (isTunedIn) unmute();
  }, [isTunedIn, unmute]);

  useEffect(() => {
    if (!room.isHost || !radioState.videoId || !radioState.playing) return undefined;
    const id = window.setInterval(() => {
      const current = stateRef.current;
      if (!current.videoId || !current.playing) return;
      const duration = getDuration();
      const playerTime = getCurrentTime();
      const timelinePosition = effectivePosition(current);
      if (duration > 1 && (playerTime >= duration - 1 || timelinePosition >= duration - 0.25)) {
        seekTo(0);
        publishLoopSeek();
        return;
      }
      const next = {
        ...current,
        positionSec: timelinePosition,
        stampMs: nowMs(),
        durationSec: duration > 1 ? duration : current.durationSec,
      };
      setRadioState(next);
      void saveRoomState(roomRef.current.id, next);
      relayRef.current?.('state', { state: next });
    }, 500);
    return () => window.clearInterval(id);
  }, [room.isHost, radioState.videoId, radioState.playing, getCurrentTime, getDuration, seekTo, publishLoopSeek]);

  useEffect(() => {
    let cancelled = false;
    getRoomState(room.id).then((stored) => {
      if (cancelled) return;
      if (room.isHost && stored?.videoId) setRadioState(stored);
      else if (!room.isHost) {
        setRadioState(emptyState());
        sendRelay('request-state', {});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [room.id, room.isHost, sendRelay]);

  const clockStats = clockSync.getClockStats();

  const loadVideo = (playNow) => {
    const videoId = parseYouTubeId(url);
    if (!videoId || !room.isHost) return;
    const next = {
      videoId,
      playing: Boolean(playNow),
      positionSec: 0,
      stampMs: playNow ? nowMs() + SCHEDULED_PLAY_DELAY_MS : nowMs(),
      syncSeq: (radioState.syncSeq ?? 0) + 1,
    };
    publishState(next);
  };

  const hostPlay = () => {
    if (!room.isHost || !radioState.videoId) return;
    publishState({
      ...radioState,
      playing: true,
      positionSec: getCurrentTime() || effectivePosition(radioState),
      stampMs: nowMs() + SCHEDULED_PLAY_DELAY_MS,
      syncSeq: (radioState.syncSeq ?? 0) + 1,
    });
  };

  const hostPause = () => {
    if (!room.isHost || !radioState.videoId) return;
    publishState({
      ...radioState,
      playing: false,
      positionSec: getCurrentTime() || effectivePosition(radioState),
      stampMs: nowMs(),
      syncSeq: (radioState.syncSeq ?? 0) + 1,
    });
  };

  const hostStop = () => {
    if (!room.isHost) return;
    publishState(emptyState());
  };

  const createNewRoom = async () => {
    const next = await createRoom();
    await setRoom(next);
    setRadioState(emptyState());
    setIsTunedIn(true);
  };

  const joinExistingRoom = async () => {
    const next = joinRoom(roomInput);
    await setRoom(next);
    setRoomInput('');
    setIsTunedIn(false);
  };

  const leaveRoom = async () => {
    await setRoom(DEFAULT_ROOM);
    setRoomInput('');
    setRadioState(emptyState());
    setIsTunedIn(false);
  };

  const copyRoomId = async () => {
    try {
      await navigator.clipboard.writeText(room.id);
    } catch {
      /* ignore */
    }
  };

  const roomLabel = `${room.isHost ? 'host' : 'joined'}: ${room.id}`;

  return (
    <div className="min-h-screen bg-black text-white relative">
      <div className="absolute top-3 left-3 right-3 z-40 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={copyRoomId}
            className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/85 hover:bg-white/20"
          >
            {roomLabel}
          </button>
          <input
            value={roomInput}
            onChange={(e) => setRoomInput(e.target.value)}
            className="w-28 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white outline-none focus:bg-white/15 sm:w-32"
            placeholder="room id"
          />
          <button onClick={joinExistingRoom} className="rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/85 hover:bg-white/20">
            Join
          </button>
          <button onClick={createNewRoom} className="rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/85 hover:bg-white/20">
            Create
          </button>
          <button onClick={leaveRoom} className="rounded-full bg-white/10 px-3 py-1.5 text-xs text-white/85 hover:bg-white/20">
            Leave
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${wsLive ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)]' : 'bg-amber-400 animate-pulse'}`}
          aria-hidden
        />
        <div className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-sm font-medium text-white/90 tabular-nums">
          <IconHeadphones />
          <span>{connectedUsers}</span>
        </div>
        <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/80 tabular-nums">
          <span>ping {Math.round(clockStats.pingMs)}ms</span>
          <span>{syncMetrics.syncPercent}%</span>
          <span>{syncMetrics.driftMs}ms</span>
        </div>
        <Link
          to="/how-it-works"
          target="_blank"
          rel="noreferrer"
          className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/20"
        >
          How it works
        </Link>
        </div>
      </div>

      <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-3 sm:p-6 pt-14">
        <div className="w-full max-w-5xl aspect-video bg-black rounded-xl overflow-hidden border border-white/10 relative shadow-2xl">
          {radioState?.videoId ? (
            <>
              <div id="yt-player" className="w-full h-full" />
              {!room.isHost ? (
                <div
                  className="absolute inset-0 z-20 cursor-default"
                  aria-hidden
                  style={{ pointerEvents: 'auto' }}
                  onContextMenu={(e) => e.preventDefault()}
                />
              ) : null}
            </>
          ) : null}
        </div>

        {!room.isHost && radioState?.videoId ? (
          <button
            type="button"
            onClick={() => setIsTunedIn((v) => !v)}
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-900/40 ring-2 ring-white/20 hover:brightness-110 active:scale-95 transition"
          >
            {isTunedIn ? <IconPause /> : <IconPlay />}
          </button>
        ) : null}

        {room.isHost ? (
          <div className="flex w-full max-w-3xl flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-xl bg-black/40 border border-white/10 px-4 py-3 text-sm text-white outline-none focus:border-white/30"
              placeholder="YouTube URL or video id"
            />
            <div className="flex flex-wrap gap-2">
              <button className="rounded-xl bg-violet-600/60 px-4 py-2 text-sm hover:bg-violet-600/80" onClick={() => loadVideo(true)}>
                Load & Play
              </button>
              <button className="rounded-xl bg-white/10 px-4 py-2 text-sm hover:bg-white/20" onClick={() => loadVideo(false)}>
                Load
              </button>
              <button className="rounded-xl bg-emerald-700/60 px-4 py-2 text-sm hover:bg-emerald-700/80" onClick={hostPlay}>
                Play
              </button>
              <button className="rounded-xl bg-amber-700/60 px-4 py-2 text-sm hover:bg-amber-700/80" onClick={hostPause}>
                Pause
              </button>
              <button className="rounded-xl bg-red-800/60 px-4 py-2 text-sm hover:bg-red-800/80" onClick={hostStop}>
                Stop
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
