import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from 'react';
import * as clockSync from '../lib/clockSync.js';

/** Media timeline (seconds) using EWMA skew vs server; stampMs is server epoch anchor. */
function serverNowMs() {
  return Date.now() + clockSync.getSkewMs();
}

function computeTime(serverState) {
  if (serverState == null || serverState.stampMs == null) return 0;
  const serverWallMs = serverNowMs();
  const duration = serverState.durationSec;
  const rawPosition = !serverState.playing
    ? (serverState.positionSec ?? 0)
    : (serverState.positionSec ?? 0) + Math.max(0, serverWallMs - serverState.stampMs) / 1000;
  if (!Number.isFinite(duration) || duration <= 1) return rawPosition;
  if (!serverState.playing) return Math.min(duration, Math.max(0, rawPosition));
  return ((rawPosition % duration) + duration) % duration;
}

function msUntilScheduledPlay(serverState) {
  if (!serverState?.playing || serverState.stampMs == null) return 0;
  return serverState.stampMs - serverNowMs();
}

/**
 * @param {{ serverState: object | null, isController: boolean, onControl?: (p: { action: string, time: number }) => void, ignoreEchoMs?: number, suspendPlayback?: boolean }} opts
 */
export function useYouTubeSync({
  serverState,
  isController,
  onControl,
  ignoreEchoMs = 0,
  suspendPlayback = false,
}) {
  const clockTick = useSyncExternalStore(clockSync.subscribeClock, clockSync.getClockTick, clockSync.getClockTick);
  const playerRef = useRef(null);
  const [apiReady, setApiReady] = useState(() => Boolean(window.YT?.Player));
  const [playerReady, setPlayerReady] = useState(false);
  const [syncMetrics, setSyncMetrics] = useState({
    pingMs: 0,
    rttMs: 0,
    driftMs: 0,
    targetDriftMs: 0,
    localFixMs: 0,
    syncPercent: 0,
  });
  const isSyncing = useRef(false);
  const lastVideoId = useRef(null);
  const lastLocalControl = useRef(0);
  const lastSyncSeq = useRef(-1);
  const lastServerVideoId = useRef(null);
  const scheduledPlayTimer = useRef(null);
  const driftEwma = useRef(0);
  const driftIntegral = useRef(0);
  const previousDrift = useRef(0);
  const lastDriftCorrectionAt = useRef(0);
  const localBiasSec = useRef(0);
  const residualEwma = useRef(0);
  const residualStableSamples = useRef(0);
  const residualSign = useRef(0);
  const serverStateRef = useRef(serverState);
  serverStateRef.current = serverState;
  const onControlRef = useRef(onControl);
  onControlRef.current = onControl;
  const suspendRef = useRef(suspendPlayback);
  suspendRef.current = suspendPlayback;

  const listenerOnly = !isController;

  const updateMetrics = useCallback((serverDriftSec = 0, targetDriftSec = serverDriftSec) => {
    const stats = clockSync.getClockStats();
    const driftMs = serverDriftSec * 1000;
    const targetDriftMs = targetDriftSec * 1000;
    const syncPercent = Math.max(0, Math.min(100, 100 - Math.abs(driftMs) / 15));
    setSyncMetrics({
      pingMs: Math.round(stats.pingMs),
      rttMs: Math.round(stats.rttMs),
      driftMs: Math.round(driftMs),
      targetDriftMs: Math.round(targetDriftMs),
      localFixMs: Math.round(localBiasSec.current * 1000),
      syncPercent: Math.round(syncPercent),
    });
  }, []);

  const clearScheduledPlay = useCallback(() => {
    if (scheduledPlayTimer.current == null) return;
    window.clearTimeout(scheduledPlayTimer.current);
    scheduledPlayTimer.current = null;
    isSyncing.current = false;
  }, []);

  const markLocal = useCallback(() => {
    lastLocalControl.current = Date.now();
  }, []);

  const unmute = useCallback(() => {
    try {
      const p = playerRef.current;
      p?.unMute?.();
      p?.setVolume?.(100);
    } catch {
      /* */
    }
  }, []);

  const getCurrentTime = useCallback(() => {
    try {
      return playerRef.current?.getCurrentTime?.() ?? 0;
    } catch {
      return 0;
    }
  }, []);

  const getDuration = useCallback(() => {
    try {
      const duration = playerRef.current?.getDuration?.() ?? 0;
      return Number.isFinite(duration) ? duration : 0;
    } catch {
      return 0;
    }
  }, []);

  const seekTo = useCallback((timeSec) => {
    try {
      isSyncing.current = true;
      playerRef.current?.seekTo?.(Math.max(0, timeSec), true);
    } catch {
      /* */
    }
    window.setTimeout(() => {
      isSyncing.current = false;
    }, 500);
  }, []);

  const loadVideo = useCallback((videoId, startSeconds = 0, play = false) => {
    const p = playerRef.current;
    if (!p || !videoId) return;
    isSyncing.current = true;
    try {
      p.loadVideoById({ videoId, startSeconds: Math.max(0, startSeconds) });
      if (play) p.playVideo();
      else p.pauseVideo();
    } catch {
      /* */
    }
    window.setTimeout(() => {
      isSyncing.current = false;
    }, 600);
  }, []);

  const play = useCallback(() => {
    try {
      playerRef.current?.playVideo?.();
    } catch {
      /* */
    }
  }, []);

  const pause = useCallback(() => {
    try {
      playerRef.current?.pauseVideo?.();
    } catch {
      /* */
    }
  }, []);

  const muteAndPause = useCallback(() => {
    try {
      const p = playerRef.current;
      p?.mute?.();
      p?.pauseVideo?.();
    } catch {
      /* */
    }
  }, []);

  const schedulePlay = useCallback(
    (player, st, positionSec) => {
      clearScheduledPlay();
      const waitMs = msUntilScheduledPlay(st);
      if (!st?.playing || waitMs <= 35) return false;

      const leadMs = listenerOnly
        ? Math.round((clockSync.getPlaybackLeadSec() + localBiasSec.current) * 1000)
        : 0;
      const delayMs = Math.max(0, waitMs - leadMs);

      try {
        isSyncing.current = true;
        player.seekTo(Math.max(0, positionSec), true);
        player.pauseVideo();
      } catch {
        /* */
      }

      scheduledPlayTimer.current = window.setTimeout(() => {
        scheduledPlayTimer.current = null;
        if (listenerOnly && suspendRef.current) return;
        try {
          player.playVideo();
        } catch {
          /* */
        }
        window.setTimeout(() => {
          isSyncing.current = false;
        }, 700);
      }, delayMs);

      return true;
    },
    [clearScheduledPlay, listenerOnly],
  );

  useEffect(() => {
    if (window.YT?.Player) {
      setApiReady(true);
      return undefined;
    }
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      setApiReady(true);
    };
    return undefined;
  }, []);

  useEffect(() => {
    if (!apiReady || !window.YT?.Player) return undefined;

    const vid = serverState?.videoId ?? null;

    const destroy = () => {
      clearScheduledPlay();
      try {
        playerRef.current?.destroy?.();
      } catch {
        /* */
      }
      playerRef.current = null;
      lastVideoId.current = null;
      setPlayerReady(false);
    };

    if (!vid) {
      destroy();
      return undefined;
    }

    if (playerRef.current && lastVideoId.current === vid) {
      return undefined;
    }

    if (playerRef.current && lastVideoId.current && lastVideoId.current !== vid) {
      isSyncing.current = true;
      const t = computeTime(serverStateRef.current);
      playerRef.current.loadVideoById({ videoId: vid, startSeconds: Math.max(0, t) });
      lastVideoId.current = vid;
      const st = serverStateRef.current;
      if (listenerOnly && suspendRef.current) {
        playerRef.current.pauseVideo();
        playerRef.current.mute?.();
      } else if (st?.playing && schedulePlay(playerRef.current, st, t)) {
        /* Scheduled play was queued. */
      } else if (st?.playing) {
        playerRef.current.playVideo();
      } else {
        playerRef.current.pauseVideo();
      }
      setTimeout(() => {
        isSyncing.current = false;
      }, 500);
      return undefined;
    }

    destroy();

    playerRef.current = new window.YT.Player('yt-player', {
      videoId: vid,
      playerVars: {
        autoplay: 0,
        mute: listenerOnly ? 1 : 0,
        controls: isController ? 1 : 0,
        disablekb: listenerOnly ? 1 : 0,
        modestbranding: 1,
        rel: 0,
        fs: listenerOnly ? 0 : 1,
        playsinline: 1,
        loop: 0,
      },
      events: {
        onReady: (e) => {
          setPlayerReady(true);
          const p = e.target;
          const st = serverStateRef.current;
          const time = Math.max(0, computeTime(st));
          if (time > 0.25) p.seekTo(time, true);
          if (listenerOnly && suspendRef.current) {
            p.pauseVideo();
            p.mute?.();
          } else if (st?.playing && schedulePlay(p, st, time)) {
            /* Scheduled play was queued. */
          } else if (st?.playing) {
            p.playVideo();
          } else {
            p.pauseVideo();
          }
        },
        onStateChange: (e) => {
          if (!isController) return;
          const cb = onControlRef.current;
          if (!cb) return;
          if (isSyncing.current) return;
          const st = e.data;
          const p = playerRef.current;
          if (!p?.getCurrentTime) return;
          const time = p.getCurrentTime();
          if (st === window.YT.PlayerState.PLAYING) {
            markLocal();
            cb({ action: 'play', time });
          } else if (st === window.YT.PlayerState.PAUSED) {
            markLocal();
            cb({ action: 'pause', time });
          }
        },
      },
    });
    lastVideoId.current = vid;

    return destroy;
  }, [apiReady, serverState?.videoId, isController, listenerOnly, markLocal, schedulePlay, clearScheduledPlay]);

  useEffect(() => {
    if (!playerRef.current || !playerReady || isController) return undefined;
    if (suspendPlayback) {
      clearScheduledPlay();
      muteAndPause();
      return undefined;
    }
    unmute();
    return undefined;
  }, [suspendPlayback, playerReady, isController, clearScheduledPlay, muteAndPause, unmute]);

  useEffect(() => {
    if (!playerRef.current || !playerReady || !serverState?.videoId) return undefined;
    if (serverState.videoId !== lastVideoId.current) return undefined;
    if (ignoreEchoMs > 0 && Date.now() - lastLocalControl.current < ignoreEchoMs) {
      return undefined;
    }

    if (serverState.videoId !== lastServerVideoId.current) {
      lastServerVideoId.current = serverState.videoId;
      lastSyncSeq.current = -1;
    }

    const p = playerRef.current;
    const cur = p.getCurrentTime?.() ?? 0;

    if (listenerOnly && suspendRef.current) {
      clearScheduledPlay();
      isSyncing.current = true;
      const target = Math.max(0, computeTime(serverState));
      if (Math.abs(cur - target) > 0.35) {
        p.seekTo(target, true);
      }
      try {
        p.pauseVideo();
        p.mute?.();
      } catch {
        /* */
      }
      window.setTimeout(() => {
        isSyncing.current = false;
      }, 120);
      return undefined;
    }

    const seq = serverState.syncSeq ?? 0;
    const hard = seq !== lastSyncSeq.current;
    const lead = listenerOnly && serverState.playing ? clockSync.getPlaybackLeadSec() + localBiasSec.current : 0;
    const target = Math.max(0, computeTime(serverState) + lead);
    if (hard) lastSyncSeq.current = seq;

    isSyncing.current = true;

    if (listenerOnly && hard) {
      p.seekTo(target, true);
      if (serverState.playing) {
        if (schedulePlay(p, serverState, target)) {
          const tid = window.setTimeout(() => {
            isSyncing.current = false;
          }, Math.max(220, msUntilScheduledPlay(serverState) + 220));
          return () => window.clearTimeout(tid);
        }
        const tid = window.setTimeout(() => {
          try {
            p.playVideo();
          } catch {
            /* */
          }
          window.setTimeout(() => {
            isSyncing.current = false;
          }, 180);
        }, 85);
        return () => window.clearTimeout(tid);
      }
      try {
        p.pauseVideo();
      } catch {
        /* */
      }
      window.setTimeout(() => {
        isSyncing.current = false;
      }, 200);
      return undefined;
    }

    if (listenerOnly && !hard) {
      if (serverState.playing && schedulePlay(p, serverState, target)) {
        const tid = window.setTimeout(() => {
          isSyncing.current = false;
        }, Math.max(220, msUntilScheduledPlay(serverState) + 220));
        return () => window.clearTimeout(tid);
      }
      if (Math.abs(cur - target) > 0.85) {
        p.seekTo(target, true);
      }
      if (serverState.playing) p.playVideo();
      else p.pauseVideo();
      const tid = window.setTimeout(() => {
        isSyncing.current = false;
      }, 200);
      return () => window.clearTimeout(tid);
    }

    if (Math.abs(cur - target) > 1.2) {
      p.seekTo(target, true);
    }
    if (serverState.playing && schedulePlay(p, serverState, target)) {
      const tid = window.setTimeout(() => {
        isSyncing.current = false;
      }, Math.max(220, msUntilScheduledPlay(serverState) + 220));
      return () => window.clearTimeout(tid);
    }
    if (serverState.playing) p.playVideo();
    else p.pauseVideo();

    const tid = window.setTimeout(() => {
      isSyncing.current = false;
    }, 350);
    return () => window.clearTimeout(tid);
  }, [
    serverState,
    playerReady,
    ignoreEchoMs,
    listenerOnly,
    clockTick,
    suspendPlayback,
    clearScheduledPlay,
    schedulePlay,
  ]);

  useEffect(() => {
    if (!listenerOnly || !playerReady) return undefined;

    const id = window.setInterval(() => {
      const st = serverStateRef.current;
      const p = playerRef.current;
      if (!p || !st?.videoId || lastVideoId.current !== st.videoId) return;

      if (suspendRef.current) {
        driftEwma.current = 0;
        driftIntegral.current = 0;
        previousDrift.current = 0;
        updateMetrics(0);
        return;
      }

      const waitMs = msUntilScheduledPlay(st);
      if (st.playing && waitMs > 50) {
        schedulePlay(p, st, computeTime(st));
        return;
      }

      const actual = p.getCurrentTime?.();
      if (!Number.isFinite(actual)) return;

      const serverExpected = Math.max(0, computeTime(st));
      const lead = st.playing ? clockSync.getPlaybackLeadSec() + localBiasSec.current : 0;
      const expected = Math.max(0, serverExpected + lead);
      const serverError = serverExpected - actual;
      const rawError = expected - actual;
      updateMetrics(serverError, rawError);

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

      if (!st.playing) {
        if (absError > 0.35) {
          p.seekTo(expected, true);
        }
        p.pauseVideo();
        return;
      }

      if (absError < 0.12 && absControl < 0.16) return;

      if (absError > 0.85 || absControl > 0.7) {
        lastDriftCorrectionAt.current = now;
        p.seekTo(expected, true);
        p.playVideo();
        driftIntegral.current *= 0.35;
        return;
      }

      if ((absError > 0.24 || absControl > 0.22) && now - lastDriftCorrectionAt.current > 1000) {
        lastDriftCorrectionAt.current = now;
        p.seekTo(expected + Math.sign(rawError) * Math.min(0.18, Math.abs(control) * 0.12), true);
        p.playVideo();
      }
    }, 500);

    return () => window.clearInterval(id);
  }, [listenerOnly, playerReady, schedulePlay, updateMetrics]);

  return {
    playerReady,
    markLocal,
    unmute,
    muteAndPause,
    syncMetrics,
    getCurrentTime,
    getDuration,
    seekTo,
    loadVideo,
    play,
    pause,
  };
}
