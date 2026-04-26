import { useEffect, useState, useRef } from 'react';
import * as clockSync from '../lib/clockSync.js';

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export function useRadioSocket() {
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState(null);
  const wsRef = useRef(null);
  const reconnectRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer;

    fetch('/api/state')
      .then((r) => r.json())
      .then((s) => {
        if (cancelled) return;
        clockSync.ingestStateSample(s.serverNow);
        setState({
          videoId: s.videoId,
          playing: s.playing,
          positionSec: s.positionSec,
          stampMs: s.stampMs,
          serverNow: s.serverNow,
          syncSeq: s.syncSeq ?? 0,
          connected: s.connected ?? s.listeners ?? 0,
        });
      })
      .catch(() => {});

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        reconnectRef.current = 0;
        // Initial HTTP fetch can run before this tab’s socket is counted — refresh counts once WS is up.
        fetch('/api/state')
          .then((r) => r.json())
          .then((s) => {
            if (cancelled) return;
            clockSync.ingestStateSample(s.serverNow);
            setState((prev) => ({
              videoId: s.videoId,
              playing: s.playing,
              positionSec: s.positionSec,
              stampMs: s.stampMs,
              serverNow: s.serverNow,
              syncSeq: s.syncSeq ?? 0,
              connected: s.connected ?? prev?.connected ?? 0,
            }));
          })
          .catch(() => {});
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'state') {
            clockSync.ingestStateSample(msg.serverNow);
            setState({
              videoId: msg.videoId,
              playing: msg.playing,
              positionSec: msg.positionSec,
              stampMs: msg.stampMs,
              serverNow: msg.serverNow,
              syncSeq: msg.syncSeq ?? 0,
              connected: msg.connected ?? msg.listeners ?? 0,
            });
          }
        } catch {
          /* ignore */
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        wsRef.current = null;
        const delay = Math.min(10_000, 800 + reconnectRef.current * 400);
        reconnectRef.current += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function pingOnce() {
      if (cancelled) return;
      const t0 = Date.now();
      try {
        const r = await fetch('/api/ping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ t0 }),
        });
        if (!r.ok) return;
        const j = await r.json();
        const t2 = Date.now();
        if (typeof j.s === 'number') {
          clockSync.ingestPingSample(t0, j.s, t2);
        }
      } catch {
        /* ignore */
      }
    }

    void pingOnce();
    const warmupIds = [200, 450, 800, 1300, 1900].map((delay) => window.setTimeout(pingOnce, delay));
    const id = window.setInterval(pingOnce, 5000);
    return () => {
      cancelled = true;
      for (const timeoutId of warmupIds) window.clearTimeout(timeoutId);
      window.clearInterval(id);
    };
  }, []);

  return { connected, state };
}
