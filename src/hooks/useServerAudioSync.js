import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as clockSync from '../lib/clockSync.js';
import { CLIENT_AUDIO_FULL_DOWNLOAD_MAX_BYTES } from '../lib/clientAudioConstants.js';
import { getListenerSyncProfile } from '../lib/syncDevice.js';
import { effectiveTimelineSec } from '../lib/timeline.js';

function msUntilScheduledPlay(st) {
  if (!st?.playing || st.stampMs == null) return 0;
  return st.stampMs - (Date.now() + clockSync.getSkewMs());
}

function safeSetAudioTime(el, sec) {
  if (!el) return false;
  try {
    el.currentTime = Math.max(0, sec);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {number} maxBytes
 * @param {AbortSignal} signal
 */
async function readAllWithCap(reader, maxBytes) {
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* */
      }
      return { oversize: true, chunks: [], received };
    }
    chunks.push(value);
  }
  return { oversize: false, chunks, received };
}

/**
 * HTML5 audio synced to relay/server timeline (prefer full file in memory → blob URL).
 * @param {{ roomId: string, radioState: object, active: boolean, isHostController?: boolean, onSyncMetrics?: (m: { driftMs: number; syncPercent: number }) => void }} opts
 * @returns {{ audioRef: import('react').RefObject<HTMLAudioElement | null>, clientCacheStatus: 'idle'|'loading'|'ready'|'streaming_fallback'|'error' }}
 */
export function useServerAudioSync({ roomId, radioState, active, isHostController, onSyncMetrics }) {
  const audioRef = useRef(null);
  const stateRef = useRef(radioState);
  /** Avoid resetting streaming <audio src> on every relay tick — server re-signs tokens each broadcast. */
  const loadedStreamRef = useRef({ roomId: '', videoId: '', exp: 0 });
  const blobUrlRef = useRef('');
  const fetchAbortRef = useRef(null);
  /** Track we currently serve from blob (`blob`) or signed HTTP URL (`stream`). */
  const clientModeRef = useRef({ roomId: '', videoId: '', mode: /** @type {'none'|'blob'|'stream'} */ ('none') });
  /** Bumps when load should be abandoned (track/room/off or new load). */
  const fetchGenRef = useRef(0);
  /** Same as active fetch target — avoids aborting when only stream auth token rotates on relay. */
  const inflightTrackKeyRef = useRef('');
  const onSyncMetricsRef = useRef(onSyncMetrics);
  const [clientCacheStatus, setClientCacheStatus] = useState(
    /** @type {'idle'|'loading'|'ready'|'streaming_fallback'|'error'} */ ('idle'),
  );

  /** Same idea as `useYouTubeSync` listener loop — PID + deadband + soft seek cooldown (tuned in syncDevice). */
  const syncProfile = useMemo(() => getListenerSyncProfile(), []);
  const driftEwma = useRef(0);
  const driftIntegral = useRef(0);
  const previousDrift = useRef(0);
  const lastDriftCorrectionAt = useRef(0);
  const localBiasSec = useRef(0);
  const residualEwma = useRef(0);
  const residualStableSamples = useRef(0);
  const residualSign = useRef(0);
  const isSyncing = useRef(false);

  useEffect(() => {
    onSyncMetricsRef.current = onSyncMetrics;
  }, [onSyncMetrics]);

  stateRef.current = radioState;

  /** Display drift vs server timeline (no intentional playback lead) — matches `useYouTubeSync` `updateMetrics(serverError, …)`. */
  const emitDisplayMetrics = useCallback((serverDriftSec) => {
    const cb = onSyncMetricsRef.current;
    if (!cb) return;
    const driftMs = Math.round(serverDriftSec * 1000);
    const syncPercent = Math.max(0, Math.min(100, 100 - Math.abs(driftMs) / 15));
    cb({ driftMs, syncPercent: Math.round(syncPercent) });
  }, []);

  const revokeBlob = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = '';
    }
  }, []);

  const abortInFlightFetch = useCallback(() => {
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
      fetchAbortRef.current = null;
    }
  }, []);

  useEffect(() => {
    const st = radioState;
    const el = audioRef.current;
    if (!el || !active || !st?.videoId || !st.audioStreamAuth) {
      fetchGenRef.current += 1;
      abortInFlightFetch();
      inflightTrackKeyRef.current = '';
      revokeBlob();
      loadedStreamRef.current = { roomId: '', videoId: '', exp: 0 };
      clientModeRef.current = { roomId: '', videoId: '', mode: 'none' };
      setClientCacheStatus('idle');
      emitDisplayMetrics(0);
      el?.pause();
      if (el) {
        el.removeAttribute('src');
        try {
          el.load();
        } catch {
          /* */
        }
      }
      return undefined;
    }

    const { exp, sig } = st.audioStreamAuth;
    const streamUrl = `/api/rooms/${encodeURIComponent(roomId)}/audio?videoId=${encodeURIComponent(st.videoId)}&exp=${exp}&sig=${encodeURIComponent(sig)}`;
    const trackKey = `${roomId}|${st.videoId}`;

    const sameTrack =
      clientModeRef.current.roomId === roomId &&
      clientModeRef.current.videoId === st.videoId &&
      clientModeRef.current.mode !== 'none';

    if (sameTrack && clientModeRef.current.mode === 'blob' && blobUrlRef.current) {
      if (el.src !== blobUrlRef.current) {
        el.src = blobUrlRef.current;
        try {
          el.load();
        } catch {
          /* */
        }
      }
      setClientCacheStatus('ready');
      return undefined;
    }

    if (sameTrack && clientModeRef.current.mode === 'stream') {
      const cur = loadedStreamRef.current;
      const now = Date.now();
      const sameStreamTrack = cur.roomId === roomId && cur.videoId === st.videoId && cur.exp > 0;
      const tokenNearExpiry = sameStreamTrack && now > cur.exp - 150_000;
      const needNewSrc = !sameStreamTrack || tokenNearExpiry;
      if (needNewSrc) {
        loadedStreamRef.current = { roomId, videoId: st.videoId, exp };
        el.src = streamUrl;
        try {
          el.load();
        } catch {
          /* */
        }
      }
      setClientCacheStatus('streaming_fallback');
      return undefined;
    }

    if (inflightTrackKeyRef.current === trackKey && fetchAbortRef.current) {
      return undefined;
    }

    abortInFlightFetch();
    revokeBlob();
    loadedStreamRef.current = { roomId: '', videoId: '', exp: 0 };
    clientModeRef.current = { roomId: '', videoId: '', mode: 'none' };

    const ac = new AbortController();
    fetchAbortRef.current = ac;
    const myGen = ++fetchGenRef.current;
    inflightTrackKeyRef.current = trackKey;
    setClientCacheStatus('loading');

    void (async () => {
      const stillCurrent = () => myGen === fetchGenRef.current;
      try {
        const r = await fetch(streamUrl, { credentials: 'same-origin', signal: ac.signal });
        if (!stillCurrent()) return;
        if (!r.ok) throw new Error(`http_${r.status}`);
        const ct = r.headers.get('content-type') || 'application/octet-stream';
        const cl = r.headers.get('content-length');
        const parsedLen = cl ? parseInt(cl, 10) : NaN;

        if (Number.isFinite(parsedLen) && parsedLen > CLIENT_AUDIO_FULL_DOWNLOAD_MAX_BYTES) {
          if (!stillCurrent()) return;
          if (ac.signal.aborted) return;
          loadedStreamRef.current = { roomId, videoId: st.videoId, exp };
          clientModeRef.current = { roomId, videoId: st.videoId, mode: 'stream' };
          el.src = streamUrl;
          try {
            el.load();
          } catch {
            /* */
          }
          setClientCacheStatus('streaming_fallback');
          try {
            r.body?.cancel();
          } catch {
            /* */
          }
          return;
        }

        if (!r.body) {
          const buf = await r.arrayBuffer();
          if (!stillCurrent()) return;
          if (ac.signal.aborted) return;
          if (buf.byteLength > CLIENT_AUDIO_FULL_DOWNLOAD_MAX_BYTES) {
            if (!stillCurrent()) return;
            loadedStreamRef.current = { roomId, videoId: st.videoId, exp };
            clientModeRef.current = { roomId, videoId: st.videoId, mode: 'stream' };
            el.src = streamUrl;
            try {
              el.load();
            } catch {
              /* */
            }
            setClientCacheStatus('streaming_fallback');
            return;
          }
          const blob = new Blob([buf], { type: ct });
          const objUrl = URL.createObjectURL(blob);
          if (!stillCurrent()) {
            URL.revokeObjectURL(objUrl);
            return;
          }
          blobUrlRef.current = objUrl;
          loadedStreamRef.current = { roomId: '', videoId: '', exp: 0 };
          clientModeRef.current = { roomId, videoId: st.videoId, mode: 'blob' };
          el.src = objUrl;
          try {
            el.load();
          } catch {
            /* */
          }
          setClientCacheStatus('ready');
          return;
        }

        const reader = r.body.getReader();
        const cap = await readAllWithCap(reader, CLIENT_AUDIO_FULL_DOWNLOAD_MAX_BYTES);
        if (!stillCurrent()) return;
        if (ac.signal.aborted) return;

        if (cap.oversize) {
          if (!stillCurrent()) return;
          loadedStreamRef.current = { roomId, videoId: st.videoId, exp };
          clientModeRef.current = { roomId, videoId: st.videoId, mode: 'stream' };
          el.src = streamUrl;
          try {
            el.load();
          } catch {
            /* */
          }
          setClientCacheStatus('streaming_fallback');
          return;
        }

        const blob = new Blob(cap.chunks, { type: ct });
        const objUrl = URL.createObjectURL(blob);
        if (!stillCurrent()) {
          URL.revokeObjectURL(objUrl);
          return;
        }
        blobUrlRef.current = objUrl;
        loadedStreamRef.current = { roomId: '', videoId: '', exp: 0 };
        clientModeRef.current = { roomId, videoId: st.videoId, mode: 'blob' };
        el.src = objUrl;
        try {
          el.load();
        } catch {
          /* */
        }
        setClientCacheStatus('ready');
      } catch (e) {
        if (!stillCurrent()) return;
        if (ac.signal.aborted) return;
        const name = e && typeof e === 'object' && 'name' in e ? e.name : '';
        if (name === 'AbortError') return;
        try {
          if (!stillCurrent()) return;
          loadedStreamRef.current = { roomId, videoId: st.videoId, exp };
          clientModeRef.current = { roomId, videoId: st.videoId, mode: 'stream' };
          el.src = streamUrl;
          el.load();
          setClientCacheStatus('streaming_fallback');
        } catch {
          if (stillCurrent()) setClientCacheStatus('error');
        }
      } finally {
        if (myGen === fetchGenRef.current) {
          inflightTrackKeyRef.current = '';
        }
        if (fetchAbortRef.current === ac) fetchAbortRef.current = null;
      }
    })();

    return () => {
      ac.abort();
    };
  }, [roomId, active, radioState.videoId, emitDisplayMetrics, revokeBlob, abortInFlightFetch]);
  /* Intentionally omit audioStreamAuth exp/sig from deps: server re-signs on every relay tick. */

  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => {
      const el = audioRef.current;
      if (!el) return;
      if (clientModeRef.current.mode !== 'stream') return;
      const st = stateRef.current;
      if (!st?.videoId || !st.audioStreamAuth) return;
      const cur = loadedStreamRef.current;
      if (cur.roomId !== roomId || cur.videoId !== st.videoId || cur.exp <= 0) return;
      const now = Date.now();
      if (now < cur.exp - 150_000) return;
      const a = st.audioStreamAuth;
      const nextUrl = `/api/rooms/${encodeURIComponent(roomId)}/audio?videoId=${encodeURIComponent(st.videoId)}&exp=${a.exp}&sig=${encodeURIComponent(a.sig)}`;
      loadedStreamRef.current = { roomId, videoId: st.videoId, exp: a.exp };
      el.src = nextUrl;
      try {
        el.load();
      } catch {
        /* */
      }
    }, 25_000);
    return () => window.clearInterval(id);
  }, [roomId, active]);

  useEffect(() => {
    if (!active || !isHostController) return undefined;
    const el = audioRef.current;
    if (!el?.src) return undefined;
    const t = effectiveTimelineSec(radioState);
    try {
      el.currentTime = Math.max(0, t);
    } catch {
      /* */
    }
    return undefined;
  }, [active, isHostController, radioState.syncSeq, radioState.videoId]);

  useEffect(() => {
    driftEwma.current = 0;
    driftIntegral.current = 0;
    previousDrift.current = 0;
    localBiasSec.current = 0;
    residualEwma.current = 0;
    residualStableSamples.current = 0;
    residualSign.current = 0;
    lastDriftCorrectionAt.current = 0;
  }, [active, radioState.videoId, roomId]);

  useEffect(() => {
    if (!active || isHostController) return undefined;
    isSyncing.current = true;
    const tid = window.setTimeout(() => {
      isSyncing.current = false;
    }, 280);
    return () => window.clearTimeout(tid);
  }, [radioState.syncSeq, active, isHostController]);

  useEffect(() => {
    if (!active) {
      emitDisplayMetrics(0);
      return undefined;
    }
    const id = window.setInterval(() => {
      const st = stateRef.current;
      const el = audioRef.current;
      if (!el || !st?.videoId) return;

      if (isHostController) {
        emitDisplayMetrics(0);
        if (st.playing) {
          if (el.paused) void el.play().catch(() => {});
        } else {
          el.pause();
        }
        return;
      }

      const waitMs = msUntilScheduledPlay(st);
      if (st.playing && waitMs > 50) return;

      const actual = Number.isFinite(el.currentTime) ? el.currentTime : NaN;
      if (!Number.isFinite(actual)) return;

      const serverExpected = Math.max(0, effectiveTimelineSec(st));
      const isBlob = clientModeRef.current.mode === 'blob';
      const netLead = !st.playing ? 0 : isBlob ? 0 : clockSync.getPlaybackLeadSec();
      const expected = Math.max(0, serverExpected + netLead + localBiasSec.current);
      const serverError = serverExpected - actual;
      const rawError = expected - actual;
      emitDisplayMetrics(serverError);

      if (st.playing) {
        const sign = Math.sign(serverError);
        residualEwma.current = 0.12 * serverError + 0.88 * residualEwma.current;
        if (Math.abs(serverError) > 0.08 && sign === residualSign.current) {
          residualStableSamples.current += 1;
        } else {
          residualStableSamples.current = Math.abs(serverError) > 0.08 ? 1 : 0;
          residualSign.current = sign;
        }
        if (residualStableSamples.current >= 6) {
          localBiasSec.current = Math.max(
            -0.8,
            Math.min(1.0, localBiasSec.current + Math.max(-0.03, Math.min(0.03, residualEwma.current * 0.06))),
          );
        }
      }

      driftEwma.current = 0.35 * rawError + 0.65 * driftEwma.current;
      driftIntegral.current = Math.max(-1.4, Math.min(1.4, driftIntegral.current + driftEwma.current * 0.7));
      const derivative = (driftEwma.current - previousDrift.current) / 0.7;
      previousDrift.current = driftEwma.current;

      const control = 0.78 * driftEwma.current + 0.05 * driftIntegral.current + 0.16 * derivative;
      const now = Date.now();
      const absError = Math.abs(rawError);
      const absControl = Math.abs(control);

      if (isSyncing.current) {
        if (st.playing && el.paused) void el.play().catch(() => {});
        else if (!st.playing && !el.paused) el.pause();
        return;
      }

      if (!st.playing) {
        if (absError > syncProfile.driftPausedSeek) {
          safeSetAudioTime(el, expected);
        }
        el.pause();
        return;
      }

      if (absError < syncProfile.driftDeadbandErr && absControl < syncProfile.driftDeadbandCtrl) {
        if (el.paused) void el.play().catch(() => {});
        return;
      }

      if (absError > syncProfile.hardSeekErr || absControl > syncProfile.hardSeekCtrl) {
        lastDriftCorrectionAt.current = now;
        safeSetAudioTime(el, expected);
        driftIntegral.current *= 0.35;
        void el.play().catch(() => {});
        return;
      }

      if (
        (absError > syncProfile.softSeekErr || absControl > syncProfile.softSeekCtrl) &&
        now - lastDriftCorrectionAt.current > syncProfile.softSeekCooldownMs
      ) {
        lastDriftCorrectionAt.current = now;
        const nudge =
          expected + Math.sign(rawError) * Math.min(0.18, Math.abs(control) * 0.12);
        safeSetAudioTime(el, nudge);
        void el.play().catch(() => {});
        return;
      }

      if (st.playing && el.paused) void el.play().catch(() => {});
    }, syncProfile.driftIntervalMs);

    return () => {
      window.clearInterval(id);
      emitDisplayMetrics(0);
    };
  }, [active, emitDisplayMetrics, isHostController, syncProfile]);

  return { audioRef, clientCacheStatus };
}
