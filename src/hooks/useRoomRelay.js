import { useCallback, useEffect, useRef, useState } from 'react';
import * as clockSync from '../lib/clockSync.js';
import { DEFAULT_ROOM, getCurrentRoom, getIdentity, saveCurrentRoom } from '../lib/localStore.js';

function wsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export function useRoomRelay(onRelay, appToken = '') {
  const [connected, setConnected] = useState(false);
  const [room, setRoomState] = useState(DEFAULT_ROOM);
  const [connectedUsers, setConnectedUsers] = useState(0);
  const [hostCount, setHostCount] = useState(0);
  const [serverAudioLive, setServerAudioLive] = useState(false);
  const [clientId, setClientId] = useState('');
  const wsRef = useRef(null);
  const roomRef = useRef(DEFAULT_ROOM);
  const identityRef = useRef(null);
  const onRelayRef = useRef(onRelay);
  const reconnectRef = useRef(0);
  const appTokenRef = useRef(appToken);
  onRelayRef.current = onRelay;
  appTokenRef.current = appToken;

  const joinWireRoom = useCallback(() => {
    const ws = wsRef.current;
    const identity = identityRef.current;
    const current = roomRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !identity?.clientId || !current?.id) return;
    const wantsHost = Boolean(current.isHost);
    const payload = {
      type: 'join',
      roomId: current.id,
      clientId: identity.clientId,
      isHost: wantsHost,
    };
    if (wantsHost && appTokenRef.current) {
      payload.authToken = appTokenRef.current;
    }
    ws.send(JSON.stringify(payload));
  }, []);

  useEffect(() => {
    joinWireRoom();
  }, [appToken, joinWireRoom]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getIdentity(), getCurrentRoom()]).then(([identity, storedRoom]) => {
      if (cancelled) return;
      identityRef.current = identity;
      setClientId(identity?.clientId || '');
      roomRef.current = storedRoom;
      setRoomState(storedRoom);
      joinWireRoom();
    });
    return () => {
      cancelled = true;
    };
  }, [joinWireRoom]);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer;

    const connect = () => {
      if (cancelled) return;
      const ws = new WebSocket(wsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setConnected(true);
        reconnectRef.current = 0;
        joinWireRoom();
      };

      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }

        if (typeof msg.serverNow === 'number') {
          clockSync.ingestStateSample(msg.serverNow);
        }

        if (msg.type === 'hello') {
          if (typeof msg.serverAudio === 'boolean') setServerAudioLive(msg.serverAudio);
          return;
        }

        if (msg.type === 'presence' || msg.type === 'joined') {
          if (!msg.roomId || msg.roomId === roomRef.current.id) {
            setConnectedUsers(msg.connected ?? 0);
            if (typeof msg.hostCount === 'number') setHostCount(msg.hostCount);
            if (typeof msg.serverAudio === 'boolean') setServerAudioLive(msg.serverAudio);
          }
          return;
        }

        if (msg.type === 'relay' && msg.roomId === roomRef.current.id) {
          onRelayRef.current?.(msg);
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnected(false);
        wsRef.current = null;
        reconnectTimer = window.setTimeout(connect, Math.min(10_000, 700 + reconnectRef.current * 500));
        reconnectRef.current += 1;
      };

      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      cancelled = true;
      window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [joinWireRoom]);

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
        if (typeof j.s === 'number') clockSync.ingestPingSample(t0, j.s, t2);
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

  const setRoom = useCallback(
    async (nextRoom) => {
      roomRef.current = nextRoom;
      setRoomState(nextRoom);
      setConnectedUsers(0);
      setHostCount(0);
      await saveCurrentRoom(nextRoom);
      joinWireRoom();
    },
    [joinWireRoom],
  );

  const sendRelay = useCallback((event, payload, includeSelf = false) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: 'relay', event, payload, includeSelf }));
    return true;
  }, []);

  return {
    connected,
    connectedUsers,
    hostCount,
    serverAudioLive,
    room,
    setRoom,
    sendRelay,
    clientId,
  };
}
