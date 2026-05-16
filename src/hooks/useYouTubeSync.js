import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as clockSync from '../lib/clockSync.js';
import { CONTROLLER_RESYNC_SEEK_SEC, getListenerSyncProfile } from '../lib/syncDevice.js';

/** DOM id for the inner mount node YT.Player owns; outer wrapper stays in React. */
export const YT_PLAYER_MOUNT_ID = 'yt-player-mount';

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

function hasYtApi(player) {
  return player != null && typeof player.destroy === 'function';
}

function isTimelinePlayer(player) {
  return (
    player != null &&
    typeof player.getCurrentTime === 'function' &&
    typeof player.seekTo === 'function'
  );
}

function safeGetCurrentTime(player) {
  try {
    if (typeof player?.getCurrentTime !== 'function') return NaN;
    const t = player.getCurrentTime();
    return Number.isFinite(t) ? t : NaN;
  } catch {
    return NaN;
  }
}

function safeGetDuration(player) {
  try {
    if (typeof player?.getDuration !== 'function') return 0;
    const duration = player.getDuration();
    return Number.isFinite(duration) ? duration : 0;
  } catch {
    return 0;
  }
}

function safeSeekTo(player, timeSec, allowSeekAhead = true) {
  if (typeof player?.seekTo !== 'function') return false;
  try {
    player.seekTo(Math.max(0, timeSec), allowSeekAhead);
    return true;
  } catch {
    return false;
  }
}

function safeDestroyPlayer(player) {
  if (!player) return;
  try {
    if (typeof player.pauseVideo === 'function') player.pauseVideo();
  } catch {
    /* */
  }
  try {
    if (typeof player.destroy === 'function') player.destroy();
  } catch {
    /* */
  }
}

/** Avoid redundant playVideo/pauseVideo — mobile YouTube iframes stutter when these repeat every tick. */
function ensurePlaybackMatchesServer(player, wantPlay) {
  if (!player) return;
  const YT = window.YT;
  try {
    if (YT?.PlayerState && typeof player.getPlayerState === 'function') {
      const s = player.getPlayerState();
      if (wantPlay) {
        if (s !== YT.PlayerState.PLAYING && s !== YT.PlayerState.BUFFERING) {
          if (typeof player.playVideo === 'function') player.playVideo();
        }
      } else if (s !== YT.PlayerState.PAUSED && s !== YT.PlayerState.ENDED) {
        if (typeof player.pauseVideo === 'function') player.pauseVideo();
      }
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    if (wantPlay) {
      if (typeof player.playVideo === 'function') player.playVideo();
    } else if (typeof player.pauseVideo === 'function') {
      player.pauseVideo();
    }
  } catch {
    /* */
  }
}

function clearMountDom() {
  try {
    const el = document.getElementById(YT_PLAYER_MOUNT_ID);
    if (el) el.replaceChildren();
  } catch {
    /* */
  }
}

/**
 * @param {{ serverState: object | null, isController: boolean, onControl?: (p: { action: string, time: number }) => void, ignoreEchoMs?: number, suspendPlayback?: boolean, suppressControllerBroadcast?: boolean, embedYoutube?: boolean }} opts
 */
export function useYouTubeSync({
  serverState,
  isController,
  onControl,
  ignoreEchoMs = 0,
  suspendPlayback = false,
  suppressControllerBroadcast = false,
  embedYoutube = true,
}) {
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
  const suppressControllerBroadcastRef = useRef(false);
  suppressControllerBroadcastRef.current = Boolean(suppressControllerBroadcast);

  const listenerOnly = !isController;

  const syncProfile = useMemo(() => getListenerSyncProfile(), []);

  const serverVideoId = serverState?.videoId ?? null;
  const serverSyncSeq = serverState?.syncSeq ?? 0;
  const serverPlaying = Boolean(serverState?.playing);

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
      if (typeof p?.unMute === 'function') p.unMute();
      if (typeof p?.setVolume === 'function') p.setVolume(100);
    } catch {
      /* */
    }
  }, []);

  const getCurrentTime = useCallback(() => {
    return safeGetCurrentTime(playerRef.current) || 0;
  }, []);

  const getDuration = useCallback(() => {
    return safeGetDuration(playerRef.current);
  }, []);

  const seekTo = useCallback((timeSec) => {
    const p = playerRef.current;
    if (!isTimelinePlayer(p)) return;
    try {
      isSyncing.current = true;
      safeSeekTo(p, timeSec, true);
    } catch {
      /* */
    }
    window.setTimeout(() => {
      isSyncing.current = false;
    }, 500);
  }, []);

  const loadVideo = useCallback((videoId, startSeconds = 0, play = false) => {
    const p = playerRef.current;
    if (!p || !videoId || typeof p.loadVideoById !== 'function') return;
    isSyncing.current = true;
    try {
      p.loadVideoById({ videoId, startSeconds: Math.max(0, startSeconds) });
      if (play) {
        if (typeof p.playVideo === 'function') p.playVideo();
      } else if (typeof p.pauseVideo === 'function') {
        p.pauseVideo();
      }
    } catch {
      /* */
    }
    window.setTimeout(() => {
      isSyncing.current = false;
    }, 600);
  }, []);

  const play = useCallback(() => {
    try {
      if (typeof playerRef.current?.playVideo === 'function') playerRef.current.playVideo();
    } catch {
      /* */
    }
  }, []);

  const pause = useCallback(() => {
    try {
      if (typeof playerRef.current?.pauseVideo === 'function') playerRef.current.pauseVideo();
    } catch {
      /* */
    }
  }, []);

  const muteAndPause = useCallback(() => {
    try {
      const p = playerRef.current;
      if (typeof p?.mute === 'function') p.mute();
      if (typeof p?.pauseVideo === 'function') p.pauseVideo();
    } catch {
      /* */
    }
  }, []);

  const schedulePlay = useCallback(
    (player, st, positionSec) => {
      if (!isTimelinePlayer(player)) return false;
      clearScheduledPlay();
      const waitMs = msUntilScheduledPlay(st);
      if (!st?.playing || waitMs <= 35) return false;

      const leadMs = listenerOnly
        ? Math.round((clockSync.getPlaybackLeadSec() + localBiasSec.current) * 1000)
        : 0;
      const delayMs = Math.max(0, waitMs - leadMs);

      try {
        isSyncing.current = true;
        safeSeekTo(player, positionSec, true);
        if (typeof player.pauseVideo === 'function') player.pauseVideo();
      } catch {
        /* */
      }

      scheduledPlayTimer.current = window.setTimeout(() => {
        scheduledPlayTimer.current = null;
        if (suspendRef.current) return;
        try {
          if (typeof player.playVideo === 'function') player.playVideo();
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

    const destroy = () => {
      clearScheduledPlay();
      const p = playerRef.current;
      playerRef.current = null;
      lastVideoId.current = null;
      lastServerVideoId.current = null;
      lastSyncSeq.current = -1;
      isSyncing.current = false;
      safeDestroyPlayer(p);
      clearMountDom();
      setPlayerReady(false);
    };

    if (!embedYoutube) {
      destroy();
      return undefined;
    }

    const vid = serverStateRef.current?.videoId ?? null;

    if (!vid) {
      destroy();
      return undefined;
    }

    const mountEl = document.getElementById(YT_PLAYER_MOUNT_ID);
    if (!mountEl) return undefined;

    if (playerRef.current && lastVideoId.current === vid) {
      return undefined;
    }

    if (playerRef.current && lastVideoId.current && lastVideoId.current !== vid) {
      const p = playerRef.current;
      if (typeof p.loadVideoById === 'function') {
        isSyncing.current = true;
        const t = computeTime(serverStateRef.current);
        try {
          p.loadVideoById({ videoId: vid, startSeconds: Math.max(0, t) });
        } catch {
          /* */
        }
        lastVideoId.current = vid;
        const st = serverStateRef.current;
        if (suspendRef.current) {
          if (typeof p.pauseVideo === 'function') p.pauseVideo();
          if (typeof p.mute === 'function') p.mute();
        } else if (st?.playing && schedulePlay(p, st, t)) {
          /* Scheduled play was queued. */
        } else if (st?.playing) {
          if (typeof p.playVideo === 'function') p.playVideo();
        } else if (typeof p.pauseVideo === 'function') {
          p.pauseVideo();
        }
        setTimeout(() => {
          isSyncing.current = false;
        }, 500);
      }
      return undefined;
    }

    destroy();

    try {
      playerRef.current = new window.YT.Player(mountEl, {
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
            if (!hasYtApi(p)) return;
            const st = serverStateRef.current;
            const time = Math.max(0, computeTime(st));
            if (time > 0.25) safeSeekTo(p, time, true);
            if (suspendRef.current) {
              if (typeof p.pauseVideo === 'function') p.pauseVideo();
              if (typeof p.mute === 'function') p.mute();
              return;
            }
            if (st?.playing && schedulePlay(p, st, time)) {
              /* Scheduled play was queued. */
            } else if (st?.playing) {
              if (typeof p.playVideo === 'function') p.playVideo();
            } else if (typeof p.pauseVideo === 'function') {
              p.pauseVideo();
            }
          },
          onStateChange: (e) => {
            if (!isController) return;
            if (suppressControllerBroadcastRef.current) return;
            const st = e.data;
            const p = playerRef.current;
            if (!isTimelinePlayer(p)) return;
            if (st === window.YT.PlayerState.ENDED) {
              const cbEnd = onControlRef.current;
              if (!cbEnd) return;
              let timeEnd;
              try {
                timeEnd = safeGetCurrentTime(p);
              } catch {
                return;
              }
              const t = Number.isFinite(timeEnd) ? timeEnd : 0;
              try {
                cbEnd({ action: 'ended', time: t });
              } catch {
                /* */
              }
              return;
            }
            const cb = onControlRef.current;
            if (!cb) return;
            if (isSyncing.current) return;
            let time;
            try {
              time = safeGetCurrentTime(p);
            } catch {
              return;
            }
            if (!Number.isFinite(time)) return;
            if (st === window.YT.PlayerState.PLAYING) {
              markLocal();
              try {
                cb({ action: 'play', time });
              } catch {
                /* */
              }
            } else if (st === window.YT.PlayerState.PAUSED) {
              markLocal();
              try {
                cb({ action: 'pause', time });
              } catch {
                /* */
              }
            }
          },
        },
      });
    } catch {
      playerRef.current = null;
      lastVideoId.current = null;
      setPlayerReady(false);
      return destroy;
    }
    lastVideoId.current = vid;

    return destroy;
  }, [apiReady, serverVideoId, embedYoutube, isController, listenerOnly, markLocal, schedulePlay, clearScheduledPlay]);

  useEffect(() => {
    if (!playerRef.current || !playerReady) return undefined;
    if (suspendPlayback) {
      clearScheduledPlay();
      muteAndPause();
      return undefined;
    }
    unmute();
    return undefined;
  }, [suspendPlayback, playerReady, clearScheduledPlay, muteAndPause, unmute]);

  /** Runs on discrete server transitions only — host position ticks use serverStateRef inside the drift interval. */
  useEffect(() => {
    const st = serverStateRef.current;
    const p = playerRef.current;
    if (!p || !playerReady || !st?.videoId) return undefined;
    if (st.videoId !== lastVideoId.current) return undefined;
    if (ignoreEchoMs > 0 && Date.now() - lastLocalControl.current < ignoreEchoMs) {
      return undefined;
    }

    if (!isTimelinePlayer(p)) return undefined;

    if (st.videoId !== lastServerVideoId.current) {
      lastServerVideoId.current = st.videoId;
      lastSyncSeq.current = -1;
    }

    const cur = safeGetCurrentTime(p);

    if (suspendRef.current) {
      clearScheduledPlay();
      isSyncing.current = true;
      const target = Math.max(0, computeTime(st));
      const thresh = listenerOnly ? syncProfile.suspendSeekThreshold : CONTROLLER_RESYNC_SEEK_SEC;
      if (Number.isFinite(cur) && Math.abs(cur - target) > thresh) {
        safeSeekTo(p, target, true);
      }
      try {
        ensurePlaybackMatchesServer(p, false);
        if (typeof p.mute === 'function') p.mute();
      } catch {
        /* */
      }
      window.setTimeout(() => {
        isSyncing.current = false;
      }, 120);
      return undefined;
    }

    const seq = st.syncSeq ?? 0;
    const hard = seq !== lastSyncSeq.current;
    const lead = listenerOnly && st.playing ? clockSync.getPlaybackLeadSec() + localBiasSec.current : 0;
    const target = Math.max(0, computeTime(st) + lead);
    if (hard) lastSyncSeq.current = seq;

    isSyncing.current = true;

    if (listenerOnly && hard) {
      safeSeekTo(p, target, true);
      if (st.playing) {
        if (schedulePlay(p, st, target)) {
          const tid = window.setTimeout(() => {
            isSyncing.current = false;
          }, Math.max(220, msUntilScheduledPlay(st) + 220));
          return () => window.clearTimeout(tid);
        }
        const tid = window.setTimeout(() => {
          try {
            if (typeof p.playVideo === 'function') p.playVideo();
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
        ensurePlaybackMatchesServer(p, false);
      } catch {
        /* */
      }
      window.setTimeout(() => {
        isSyncing.current = false;
      }, 200);
      return undefined;
    }

    if (listenerOnly && !hard) {
      if (st.playing && schedulePlay(p, st, target)) {
        const tid = window.setTimeout(() => {
          isSyncing.current = false;
        }, Math.max(220, msUntilScheduledPlay(st) + 220));
        return () => window.clearTimeout(tid);
      }
      if (Number.isFinite(cur) && Math.abs(cur - target) > syncProfile.listenerResyncSeek) {
        safeSeekTo(p, target, true);
      }
      ensurePlaybackMatchesServer(p, st.playing);
      const tid = window.setTimeout(() => {
        isSyncing.current = false;
      }, 200);
      return () => window.clearTimeout(tid);
    }

    if (isController) {
      if (Number.isFinite(cur) && Math.abs(cur - target) > CONTROLLER_RESYNC_SEEK_SEC) {
        safeSeekTo(p, target, true);
      }
      if (st.playing && schedulePlay(p, st, target)) {
        const tid = window.setTimeout(() => {
          isSyncing.current = false;
        }, Math.max(220, msUntilScheduledPlay(st) + 220));
        return () => window.clearTimeout(tid);
      }
      ensurePlaybackMatchesServer(p, st.playing);

      const tid = window.setTimeout(() => {
        isSyncing.current = false;
      }, 350);
      return () => window.clearTimeout(tid);
    }

    return undefined;
  }, [
    serverVideoId,
    serverSyncSeq,
    serverPlaying,
    playerReady,
    ignoreEchoMs,
    listenerOnly,
    isController,
    suspendPlayback,
    clearScheduledPlay,
    schedulePlay,
    syncProfile,
    markLocal,
  ]);

  /* Drift PID + soft seeks: listeners only. The host publishes timeline; correcting the host player
   * against that same state every tick causes constant seekTo (regression on desktop). */
  useEffect(() => {
    if (!listenerOnly || !playerReady) return undefined;

    const id = window.setInterval(() => {
      const st = serverStateRef.current;
      const p = playerRef.current;
      if (!isTimelinePlayer(p) || !st?.videoId || lastVideoId.current !== st.videoId) return;

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

      const actual = safeGetCurrentTime(p);
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

      if (isSyncing.current) return;

      if (!st.playing) {
        if (absError > syncProfile.driftPausedSeek) {
          safeSeekTo(p, expected, true);
        }
        ensurePlaybackMatchesServer(p, false);
        return;
      }

      if (absError < syncProfile.driftDeadbandErr && absControl < syncProfile.driftDeadbandCtrl) return;

      if (absError > syncProfile.hardSeekErr || absControl > syncProfile.hardSeekCtrl) {
        lastDriftCorrectionAt.current = now;
        safeSeekTo(p, expected, true);
        ensurePlaybackMatchesServer(p, true);
        driftIntegral.current *= 0.35;
        return;
      }

      if (
        (absError > syncProfile.softSeekErr || absControl > syncProfile.softSeekCtrl) &&
        now - lastDriftCorrectionAt.current > syncProfile.softSeekCooldownMs
      ) {
        lastDriftCorrectionAt.current = now;
        safeSeekTo(p, expected + Math.sign(rawError) * Math.min(0.18, Math.abs(control) * 0.12), true);
        ensurePlaybackMatchesServer(p, true);
      }
    }, syncProfile.driftIntervalMs);

    return () => window.clearInterval(id);
  }, [listenerOnly, playerReady, schedulePlay, updateMetrics, syncProfile]);

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
