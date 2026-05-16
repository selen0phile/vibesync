import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRoomRelay } from '../hooks/useRoomRelay';
import { useHostAuth } from '../hooks/useHostAuth.js';
import { HostLibraryPanel } from '../components/HostLibraryPanel.jsx';
import { useServerAudioSync } from '../hooks/useServerAudioSync';
import { useYouTubeSync, YT_PLAYER_MOUNT_ID } from '../hooks/useYouTubeSync';
import * as clockSync from '../lib/clockSync.js';
import { effectiveTimelineSec } from '../lib/timeline.js';
import { getHostPositionPublishIntervalMs } from '../lib/syncDevice.js';
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

function nowMs() {
  return Date.now() + clockSync.getSkewMs();
}

function emptyState() {
  return {
    videoId: null,
    playing: false,
    positionSec: 0,
    stampMs: nowMs(),
    syncSeq: 0,
    durationSec: undefined,
    /** @type {'youtube'|'server_audio'} */
    playbackMode: 'youtube',
    downloadStatus: undefined,
    downloadError: null,
    autonomous: false,
    serverAudioEnabled: false,
    audioStreamAuth: undefined,
    playlist: [],
    coverImageUrl: null,
    coverImageKey: null,
    coverImageAuth: undefined,
  };
}

function normalizeRelayState(s) {
  if (!s || typeof s !== 'object') return emptyState();
  const auth =
    s.audioStreamAuth && typeof s.audioStreamAuth.exp === 'number' && typeof s.audioStreamAuth.sig === 'string'
      ? { exp: s.audioStreamAuth.exp, sig: String(s.audioStreamAuth.sig) }
      : undefined;
  const pl = Array.isArray(s.playlist) ? s.playlist : [];
  const playlist = pl
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      id: String(x.id || '').slice(0, 40),
      title: String(x.title || x.id || 'track').slice(0, 200),
      sizeBytes: typeof x.sizeBytes === 'number' ? x.sizeBytes : undefined,
    }))
    .filter((x) => x.id);
  const coverImageUrl =
    s.coverImageUrl == null || s.coverImageUrl === '' ? null : String(s.coverImageUrl).slice(0, 2048);
  const coverImageKey =
    s.coverImageKey == null || s.coverImageKey === '' ? null : String(s.coverImageKey).slice(0, 200);
  const coverAuth =
    s.coverImageAuth && typeof s.coverImageAuth.exp === 'number' && typeof s.coverImageAuth.sig === 'string'
      ? { exp: s.coverImageAuth.exp, sig: String(s.coverImageAuth.sig) }
      : undefined;
  return {
    videoId: s.videoId ?? null,
    playing: Boolean(s.playing),
    positionSec: Number(s.positionSec) || 0,
    stampMs: typeof s.stampMs === 'number' ? s.stampMs : nowMs(),
    syncSeq: typeof s.syncSeq === 'number' ? s.syncSeq : 0,
    durationSec: typeof s.durationSec === 'number' ? s.durationSec : undefined,
    playbackMode: s.playbackMode === 'server_audio' ? 'server_audio' : 'youtube',
    downloadStatus: typeof s.downloadStatus === 'string' ? s.downloadStatus : undefined,
    downloadError: s.downloadError != null ? String(s.downloadError) : null,
    autonomous: Boolean(s.autonomous),
    serverAudioEnabled: Boolean(s.serverAudioEnabled),
    audioStreamAuth: auth,
    playlist,
    coverImageUrl,
    coverImageKey,
    coverImageAuth: coverAuth,
  };
}

function formatCacheDownloadError(code) {
  if (!code) return 'Unknown error.';
  switch (code) {
    case 'youtube_cookie_or_bot_block':
      return 'YouTube asked for a logged-in session from this IP. Export a fresh cookies.txt while logged into youtube.com in a normal browser (see yt-dlp cookie FAQ).';
    case 'youtube_429_and_bot':
      return 'YouTube rate-limited this IP (HTTP 429) and then asked for sign-in. Wait several hours, export fresh cookies from a home/residential browser session, or try a different egress IP (datacenter IPs are often blocked).';
    case 'youtube_rate_limited':
      return 'YouTube returned HTTP 429 for this server. Wait and retry, refresh cookies, or reduce download frequency.';
    case 'youtube_needs_ejs_or_update':
      return 'yt-dlp could not get formats (YouTube JS / “n” challenge). Install Deno (~/.deno/bin), use a current yt-dlp (set YT_DLP_BIN to the release binary), and run yt-dlp -U if needed.';
    case 'youtube_video_unavailable':
      return 'That video is private, members-only, or unavailable to yt-dlp.';
    case 'output_missing':
      return 'yt-dlp reported success but the cache file was not found.';
    case 'host_audio_missing':
      return 'That playlist track is not on the server yet — import the URL again while you are connected as host.';
    case 'no_host_identity':
      return 'Server lost the host session for URL audio — reconnect as host and retry.';
    case 'no_host_user':
      return 'Sign in with Google as host so the server can load your cloud library tracks.';
    case 'library_track_missing':
      return 'That library track was not found or is not ready yet.';
    case 'host_playlist_quota':
      return 'Host import quota exceeded (100 MB total per browser identity on this server). Remove old files from disk or skip large URLs.';
    default:
      return String(code);
  }
}

function isUrlRoomTrack(videoId) {
  return typeof videoId === 'string' && /^u_[a-f0-9]{16}$/.test(videoId);
}

function isLibraryRoomTrack(videoId) {
  return typeof videoId === 'string' && videoId.startsWith('lib_');
}

/** @param {string} roomId @param {object} s */
function coverArtSrc(roomId, s) {
  if (!s) return null;
  if (s.coverImageKey && s.coverImageAuth) {
    const k = encodeURIComponent(s.coverImageKey);
    const { exp, sig } = s.coverImageAuth;
    return `/api/rooms/${encodeURIComponent(roomId)}/cover-image?key=${k}&exp=${exp}&sig=${encodeURIComponent(sig)}`;
  }
  const u = s.coverImageUrl;
  if (u && typeof u === 'string' && u.startsWith('https://')) return u;
  return null;
}

function formatBytesShort(n) {
  if (!Number.isFinite(n)) return '—';
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function gdriveImportErrorMessage(j) {
  const c = j?.error;
  switch (c) {
    case 'gdrive_not_configured':
      return 'Google Drive import is not enabled on this server (set GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON).';
    case 'gdrive_invalid_folder':
      return 'Paste a full Google Drive folder URL or the folder ID.';
    case 'gdrive_no_audio_files':
      return 'No supported audio files in that folder. Use mp3/m4a/wav/… and share the folder with the service account.';
    case 'gdrive_folder_not_found':
      return 'Folder not found or not shared with the service account email (Viewer is enough).';
    case 'gdrive_token_failed':
      return 'Google authentication failed — verify the service account JSON and enable the Google Drive API for that project.';
    case 'gdrive_list_failed':
      return `Drive listing failed: ${j?.message || 'unknown'}`;
    case 'host_playlist_quota':
      return formatCacheDownloadError('host_playlist_quota');
    default:
      return j?.message || c || 'Google Drive import failed.';
  }
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
  const [isTunedIn, setIsTunedIn] = useState(false);
  const [radioState, setRadioState] = useState(emptyState);
  const [httpAudioSync, setHttpAudioSync] = useState({ driftMs: 0, syncPercent: 0 });
  const [url, setUrl] = useState('');
  const [roomInput, setRoomInput] = useState('');
  const [playlistUrlsText, setPlaylistUrlsText] = useState('');
  const [gdriveFolderInput, setGdriveFolderInput] = useState('');
  const [gdriveStatus, setGdriveStatus] = useState({ configured: false, serviceAccountEmail: null });
  const [playlistBusy, setPlaylistBusy] = useState(false);
  const [playlistMsg, setPlaylistMsg] = useState('');
  const [coverMsg, setCoverMsg] = useState('');
  const [quotaBytes, setQuotaBytes] = useState({ used: 0, max: 100 * 1024 * 1024 });
  const [seekUiSec, setSeekUiSec] = useState(null);
  const coverFileRef = useRef(null);
  const stateRef = useRef(radioState);
  const roomRef = useRef(null);
  const lastEndedRestartAt = useRef(0);
  stateRef.current = radioState;

  const relayRef = useRef(null);
  const { appToken, user: hostUser, loading: authLoading, error: authError, signIn, signOut, isAuthenticated } =
    useHostAuth();

  const publishState = useCallback((nextState) => {
    setRadioState(nextState);
    if (roomRef.current?.isHost) {
      void saveRoomState(roomRef.current.id, nextState);
      relayRef.current?.('state', { state: nextState });
    }
  }, []);

  const handleRelay = useCallback(
    (msg) => {
      if (msg.event === 'state' && msg.payload?.state && typeof msg.payload.state === 'object') {
        const rawS = msg.payload.state;
        const incoming = normalizeRelayState(rawS);
        if (msg.from === 'server' && roomRef.current?.isHost) {
          setRadioState((prev) => ({
            ...prev,
            downloadStatus: incoming.downloadStatus,
            downloadError: incoming.downloadError,
            autonomous: incoming.autonomous,
            serverAudioEnabled: incoming.serverAudioEnabled,
            audioStreamAuth: incoming.audioStreamAuth,
            coverImageAuth: incoming.coverImageAuth,
            playlist: Array.isArray(incoming.playlist) ? incoming.playlist : prev.playlist,
            coverImageUrl: 'coverImageUrl' in rawS ? incoming.coverImageUrl : prev.coverImageUrl,
            coverImageKey: 'coverImageKey' in rawS ? incoming.coverImageKey : prev.coverImageKey,
            durationSec:
              prev.durationSec && prev.durationSec > 1 ? prev.durationSec : incoming.durationSec,
          }));
          return;
        }
        if (!roomRef.current?.isHost) {
          setRadioState(incoming);
        }
      }
      if ((msg.event === 'request-state' || msg.event === 'peer-joined') && roomRef.current?.isHost) {
        relayRef.current?.('state', { state: stateRef.current });
      }
    },
    [],
  );

  const { connected: wsLive, connectedUsers, hostCount, serverAudioLive, room, setRoom, sendRelay, clientId } =
    useRoomRelay(handleRelay, appToken);
  roomRef.current = room;
  relayRef.current = sendRelay;

  useEffect(() => {
    if (!forcedRoom) return;
    if (room.id === forcedRoom.id && room.isHost === forcedRoom.isHost) return;
    void setRoom(forcedRoom);
    setIsTunedIn(true);
  }, [forcedRoom, room.id, room.isHost, setRoom]);

  const effectivePlaybackMode = useMemo(() => {
    if (!serverAudioLive) return 'youtube';
    return radioState.playbackMode === 'server_audio' ? 'server_audio' : 'youtube';
  }, [radioState.playbackMode, serverAudioLive]);

  const serverAudioReady =
    serverAudioLive &&
    radioState.downloadStatus === 'ready' &&
    Boolean(radioState.videoId) &&
    Boolean(radioState.audioStreamAuth);

  const useServerAudioPath =
    effectivePlaybackMode === 'server_audio' && serverAudioReady && (room.isHost || isTunedIn);

  const onHttpAudioSyncMetrics = useCallback((m) => {
    setHttpAudioSync(m);
  }, []);

  const suspendYoutubeForMode =
    effectivePlaybackMode === 'server_audio' &&
    Boolean(radioState.videoId) &&
    (room.isHost || isTunedIn);

  const youtubeSuspended =
    suspendYoutubeForMode || (!room.isHost && !isTunedIn && effectivePlaybackMode === 'youtube');

  const { audioRef: serverAudioRef, clientCacheStatus } = useServerAudioSync({
    roomId: room.id,
    radioState,
    active: useServerAudioPath,
    isHostController: room.isHost && useServerAudioPath,
    onSyncMetrics: useServerAudioPath ? onHttpAudioSyncMetrics : undefined,
  });

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

  const showYoutubePlayer = effectivePlaybackMode === 'youtube';

  const coverDisplaySrc = useMemo(() => coverArtSrc(room.id, radioState), [room.id, radioState]);

  const refreshQuota = useCallback(async () => {
    if (!clientId) return;
    try {
      const r = await fetch('/api/host-audio/quota', { headers: { 'x-client-id': clientId } });
      const j = await r.json();
      if (j?.ok && typeof j.usedBytes === 'number') {
        setQuotaBytes({
          used: j.usedBytes,
          max: typeof j.maxBytes === 'number' ? j.maxBytes : 100 * 1024 * 1024,
        });
      }
    } catch {
      /* */
    }
  }, [clientId]);

  useEffect(() => {
    if (!room.isHost || !serverAudioLive) return undefined;
    const t = window.setTimeout(() => void refreshQuota(), 0);
    const id = window.setInterval(() => void refreshQuota(), 14000);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(id);
    };
  }, [room.isHost, serverAudioLive, refreshQuota]);

  const importPlaylistUrls = useCallback(async () => {
    if (!room.isHost || !clientId || !serverAudioLive) return;
    const lines = playlistUrlsText
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length) {
      setPlaylistMsg('Paste at least one http(s) URL to an audio file.');
      return;
    }
    setPlaylistBusy(true);
    setPlaylistMsg('');
    let ok = 0;
    try {
      for (const line of lines) {
        const r = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/host-audio/import-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-client-id': clientId },
          body: JSON.stringify({ url: line }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) {
          setPlaylistMsg(`Stopped on error (${j.error || r.status}): ${line.slice(0, 80)}…`);
          break;
        }
        const item = { id: j.trackId, title: j.title || j.trackId, sizeBytes: j.sizeBytes };
        const cur = stateRef.current;
        const nextPl = [...(cur.playlist || []).filter((x) => x.id !== item.id), item];
        publishState({
          ...cur,
          playlist: nextPl,
          playbackMode: 'server_audio',
          videoId: j.trackId,
          syncSeq: (cur.syncSeq ?? 0) + 1,
        });
        ok += 1;
        void refreshQuota();
      }
      if (ok === lines.length) setPlaylistMsg(`Imported ${ok} file(s).`);
    } finally {
      setPlaylistBusy(false);
    }
  }, [room.isHost, room.id, clientId, serverAudioLive, playlistUrlsText, publishState, refreshQuota]);

  useEffect(() => {
    if (!serverAudioLive) return undefined;
    let cancelled = false;
    fetch('/api/host-audio/gdrive-status')
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j?.ok) {
          setGdriveStatus({
            configured: Boolean(j.configured),
            serviceAccountEmail: typeof j.serviceAccountEmail === 'string' ? j.serviceAccountEmail : null,
          });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [serverAudioLive]);

  const importGdriveFolder = useCallback(async () => {
    if (!room.isHost || !clientId || !serverAudioLive) return;
    const folder = gdriveFolderInput.trim();
    if (!folder) {
      setPlaylistMsg('Paste a Google Drive folder link or ID.');
      return;
    }
    setPlaylistBusy(true);
    setPlaylistMsg('');
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/host-audio/import-gdrive-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-client-id': clientId },
        body: JSON.stringify({ folder }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setPlaylistMsg(gdriveImportErrorMessage(j));
        return;
      }
      const cur = stateRef.current;
      let nextPl = [...(cur.playlist || [])];
      for (const it of j.items || []) {
        const row = { id: it.trackId, title: it.title || it.trackId, sizeBytes: it.sizeBytes };
        nextPl = nextPl.filter((x) => x.id !== row.id);
        nextPl.push(row);
      }
      const first = j.items?.[0]?.trackId;
      publishState({
        ...cur,
        playlist: nextPl,
        playbackMode: 'server_audio',
        videoId: cur.videoId || first || null,
        syncSeq: (cur.syncSeq ?? 0) + 1,
      });
      void refreshQuota();
      const parts = [`Imported ${j.count} file(s) from Google Drive.`];
      if (j.errors?.length) parts.push(`${j.errors.length} file(s) skipped (see server logs or quota).`);
      setPlaylistMsg(parts.join(' '));
    } finally {
      setPlaylistBusy(false);
    }
  }, [room.isHost, room.id, clientId, serverAudioLive, gdriveFolderInput, publishState, refreshQuota]);

  const addLibraryTrackToPlaylist = useCallback(
    (item) => {
      if (!room.isHost || !item?.id) return;
      const cur = stateRef.current;
      const pl = Array.isArray(cur.playlist) ? [...cur.playlist] : [];
      if (!pl.some((x) => x.id === item.id)) {
        pl.push({ id: item.id, title: item.title || item.id, sizeBytes: item.sizeBytes });
      }
      publishState({
        ...cur,
        playlist: pl,
        videoId: item.id,
        playbackMode: 'server_audio',
        playing: false,
        positionSec: 0,
        stampMs: nowMs(),
        syncSeq: (cur.syncSeq ?? 0) + 1,
      });
    },
    [room.isHost, publishState],
  );

  const selectPlaylistTrack = useCallback(
    (trackId) => {
      if (!room.isHost || !trackId) return;
      const cur = stateRef.current;
      publishState({
        ...cur,
        videoId: trackId,
        playbackMode: 'server_audio',
        syncSeq: (cur.syncSeq ?? 0) + 1,
      });
    },
    [room.isHost, publishState],
  );

  const removePlaylistItem = useCallback(
    (trackId) => {
      if (!room.isHost) return;
      const cur = stateRef.current;
      const nextPl = (cur.playlist || []).filter((x) => x.id !== trackId);
      const nextVid = cur.videoId === trackId ? null : cur.videoId;
      publishState({
        ...cur,
        playlist: nextPl,
        videoId: nextVid,
        syncSeq: (cur.syncSeq ?? 0) + 1,
      });
    },
    [room.isHost, publishState],
  );

  const applyCoverHttpsUrl = useCallback(() => {
    if (!room.isHost) return;
    const raw = window.prompt('Cover image URL (https only, shown during cached playback)', radioState.coverImageUrl || '');
    if (raw == null) return;
    const trimmed = raw.trim();
    const cur = stateRef.current;
    if (!trimmed) {
      publishState({
        ...cur,
        coverImageUrl: null,
        coverImageKey: null,
        syncSeq: (cur.syncSeq ?? 0) + 1,
      });
      setCoverMsg('Cover cleared.');
      return;
    }
    if (!trimmed.startsWith('https://')) {
      setCoverMsg('Only https:// URLs are accepted.');
      return;
    }
    publishState({
      ...cur,
      coverImageUrl: trimmed,
      coverImageKey: null,
      syncSeq: (cur.syncSeq ?? 0) + 1,
    });
    setCoverMsg('Cover URL saved for this room.');
  }, [room.isHost, radioState.coverImageUrl, publishState]);

  const uploadCoverFile = useCallback(async () => {
    if (!room.isHost || !clientId) return;
    const input = coverFileRef.current;
    const file = input?.files?.[0];
    if (!file) {
      setCoverMsg('Choose an image file first.');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setCoverMsg('Use JPEG, PNG, or WebP.');
      return;
    }
    setCoverMsg('');
    try {
      const buf = await file.arrayBuffer();
      const r = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/cover-upload`, {
        method: 'POST',
        headers: { 'Content-Type': file.type, 'x-client-id': clientId },
        body: buf,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setCoverMsg(j.error || `Upload failed (${r.status})`);
        return;
      }
      const cur = stateRef.current;
      publishState({
        ...cur,
        coverImageKey: j.coverImageKey,
        coverImageUrl: null,
        syncSeq: (cur.syncSeq ?? 0) + 1,
      });
      setCoverMsg('Cover uploaded.');
      if (input) input.value = '';
    } catch (e) {
      setCoverMsg(String(e?.message || e));
    }
  }, [room.isHost, room.id, clientId, publishState]);

  const clearCover = useCallback(() => {
    if (!room.isHost) return;
    const cur = stateRef.current;
    publishState({
      ...cur,
      coverImageUrl: null,
      coverImageKey: null,
      syncSeq: (cur.syncSeq ?? 0) + 1,
    });
    setCoverMsg('Cover cleared.');
  }, [room.isHost, publishState]);

  const commitServerAudioSeek = useCallback(
    (sec) => {
      if (!room.isHost) return;
      const cur = stateRef.current;
      const dur = cur.durationSec && cur.durationSec > 1 ? cur.durationSec : null;
      const clamped = dur != null ? Math.min(Math.max(0, sec), dur) : Math.max(0, sec);
      publishState({
        ...cur,
        positionSec: clamped,
        stampMs: nowMs(),
        syncSeq: (cur.syncSeq ?? 0) + 1,
      });
    },
    [room.isHost, publishState],
  );

  const { syncMetrics, getCurrentTime, getDuration, seekTo } = useYouTubeSync({
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
    suspendPlayback: youtubeSuspended,
    suppressControllerBroadcast: room.isHost && youtubeSuspended,
    embedYoutube: showYoutubePlayer,
  });

  const syncDisplay = useServerAudioPath ? httpAudioSync : syncMetrics;

  useEffect(() => {
    if (!useServerAudioPath) {
      setHttpAudioSync({ driftMs: 0, syncPercent: 0 });
    }
  }, [useServerAudioPath]);

  useEffect(() => {
    const t = window.setTimeout(() => setSeekUiSec(null), 0);
    return () => window.clearTimeout(t);
  }, [radioState.syncSeq]);

  const serverAudioLiveRef = useRef(serverAudioLive);

  useEffect(() => {
    serverAudioLiveRef.current = serverAudioLive;
  }, [serverAudioLive]);

  const effectiveModeFromState = useCallback((cur) => {
    if (!serverAudioLiveRef.current) return 'youtube';
    return cur.playbackMode === 'server_audio' ? 'server_audio' : 'youtube';
  }, []);

  const readHostTimelineSec = useCallback(() => {
    const cur = stateRef.current;
    if (effectiveModeFromState(cur) === 'server_audio') {
      const el = serverAudioRef.current;
      const t = el && Number.isFinite(el.currentTime) ? el.currentTime : null;
      if (t != null) return t;
    }
    return getCurrentTime() || effectiveTimelineSec(cur);
  }, [effectiveModeFromState, getCurrentTime]);

  useEffect(() => {
    if (!room.isHost || !radioState.videoId || !radioState.playing) return undefined;
    if (effectivePlaybackMode !== 'youtube') return undefined;
    const tickMs = getHostPositionPublishIntervalMs();
    const id = window.setInterval(() => {
      const current = stateRef.current;
      if (!current.videoId || !current.playing) return;
      const duration = getDuration();
      const playerTime = getCurrentTime();
      const timelinePosition = effectiveTimelineSec(current);
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
    }, tickMs);
    return () => window.clearInterval(id);
  }, [
    room.isHost,
    effectivePlaybackMode,
    radioState.videoId,
    radioState.playing,
    getCurrentTime,
    getDuration,
    seekTo,
    publishLoopSeek,
  ]);

  useEffect(() => {
    if (!room.isHost || !radioState.videoId || !radioState.playing) return undefined;
    if (effectivePlaybackMode !== 'server_audio') return undefined;
    const tickMs = getHostPositionPublishIntervalMs();
    const id = window.setInterval(() => {
      const current = stateRef.current;
      if (!current.videoId || !current.playing) return;
      const el = serverAudioRef.current;
      const t = el && Number.isFinite(el.currentTime) ? el.currentTime : effectiveTimelineSec(current);
      const durFromEl = el && Number.isFinite(el.duration) && el.duration > 1 ? el.duration : null;
      const duration = durFromEl ?? (current.durationSec > 1 ? current.durationSec : 0);
      if (duration > 1 && (t >= duration - 0.35 || effectiveTimelineSec(current) >= duration - 0.25)) {
        if (el) {
          try {
            el.currentTime = 0;
          } catch {
            /* */
          }
        }
        publishLoopSeek();
        return;
      }
      const next = {
        ...current,
        positionSec: t,
        stampMs: nowMs(),
        durationSec: duration > 1 ? duration : current.durationSec,
      };
      setRadioState(next);
      void saveRoomState(roomRef.current.id, next);
      relayRef.current?.('state', { state: next });
    }, tickMs);
    return () => window.clearInterval(id);
  }, [room.isHost, effectivePlaybackMode, radioState.videoId, radioState.playing, publishLoopSeek]);

  useEffect(() => {
    let cancelled = false;
    getRoomState(room.id).then((stored) => {
      if (cancelled) return;
      if (room.isHost && stored?.videoId) setRadioState(normalizeRelayState(stored));
      else if (!room.isHost) {
        setRadioState(emptyState());
        sendRelay('request-state', {});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [room.id, room.isHost, sendRelay]);

  useEffect(() => {
    if (room.isHost || hostCount > 0) return;
    const cur = stateRef.current;
    if (!cur.videoId || !cur.playing) return;
    const youtubeOnly = effectiveModeFromState(cur) === 'youtube';
    if (!youtubeOnly) return;
    setRadioState({
      ...cur,
      playing: false,
      positionSec: effectiveTimelineSec(cur),
      stampMs: nowMs(),
      syncSeq: (cur.syncSeq ?? 0) + 1,
    });
  }, [hostCount, room.isHost]);

  const clockStats = clockSync.getClockStats();

  const loadVideo = (playNow) => {
    const videoId = parseYouTubeId(url);
    if (!videoId || !room.isHost) return;
    const cur = stateRef.current;
    const next = {
      ...cur,
      videoId,
      playing: Boolean(playNow),
      positionSec: 0,
      stampMs: playNow ? nowMs() + SCHEDULED_PLAY_DELAY_MS : nowMs(),
      syncSeq: (cur.syncSeq ?? 0) + 1,
    };
    publishState(next);
  };

  const hostPlay = () => {
    if (!room.isHost || !radioState.videoId) return;
    const cur = stateRef.current;
    publishState({
      ...cur,
      playing: true,
      positionSec: readHostTimelineSec(),
      stampMs: nowMs() + SCHEDULED_PLAY_DELAY_MS,
      syncSeq: (cur.syncSeq ?? 0) + 1,
    });
  };

  const hostPause = () => {
    if (!room.isHost || !radioState.videoId) return;
    const cur = stateRef.current;
    publishState({
      ...cur,
      playing: false,
      positionSec: readHostTimelineSec(),
      stampMs: nowMs(),
      syncSeq: (cur.syncSeq ?? 0) + 1,
    });
  };

  const setHostPlaybackMode = (mode) => {
    if (!room.isHost) return;
    if (mode === 'server_audio' && !serverAudioLive) return;
    const cur = stateRef.current;
    publishState({
      ...cur,
      playbackMode: mode,
      syncSeq: (cur.syncSeq ?? 0) + 1,
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
          <span>{syncDisplay.syncPercent}%</span>
          <span>{syncDisplay.driftMs}ms</span>
          {hostCount > 0 ? <span className="text-emerald-400/90">host</span> : null}
          {radioState?.videoId ? (
            <span className="text-sky-300/85">
              {effectivePlaybackMode === 'server_audio' ? 'cached' : 'yt'}
            </span>
          ) : null}
          {serverAudioLive && radioState.downloadStatus === 'downloading' ? (
            <span className="text-amber-300/90">cache…</span>
          ) : null}
          {useServerAudioPath && clientCacheStatus === 'loading' ? (
            <span className="text-amber-200/90">buffer…</span>
          ) : null}
          {useServerAudioPath && clientCacheStatus === 'ready' ? (
            <span className="text-emerald-300/90">local</span>
          ) : null}
          {useServerAudioPath && clientCacheStatus === 'streaming_fallback' ? (
            <span className="text-violet-300/90">stream</span>
          ) : null}
          {useServerAudioPath && clientCacheStatus === 'error' ? (
            <span className="text-rose-300/90">audio</span>
          ) : null}
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
        <audio ref={serverAudioRef} className="sr-only" playsInline preload="auto" aria-hidden />
        {showYoutubePlayer ? (
          <div className="w-full max-w-5xl aspect-video bg-black rounded-xl overflow-hidden border border-white/10 relative shadow-2xl">
            <div className="relative h-full w-full">
              <div id={YT_PLAYER_MOUNT_ID} className="absolute inset-0 h-full w-full" />
              {radioState?.videoId && !room.isHost ? (
                <div
                  className="absolute inset-0 z-20 cursor-default"
                  aria-hidden
                  style={{ pointerEvents: 'auto' }}
                  onContextMenu={(e) => e.preventDefault()}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="w-full max-w-5xl aspect-video rounded-xl overflow-hidden border border-white/10 bg-black relative shadow-2xl flex items-center justify-center">
            {coverDisplaySrc && effectivePlaybackMode === 'server_audio' ? (
              <img
                src={coverDisplaySrc}
                alt=""
                className="absolute inset-0 h-full w-full object-contain bg-black"
              />
            ) : null}
            <div className="relative z-10 max-w-lg px-6 py-10 text-center rounded-xl bg-black/55 backdrop-blur-sm border border-white/10">
              <p className="text-sm font-medium text-white/80">Cached audio</p>
              <p className="mt-2 text-xs text-white/50">
                YouTube is not loaded — playback follows the room timeline; audio is buffered locally when possible (large
                files stream from the server instead).
              </p>
              {radioState?.videoId ? (
                <p className="mt-4 font-mono text-[11px] text-white/40 tabular-nums break-all">
                  {isUrlRoomTrack(radioState.videoId) ? 'track' : 'video'} {radioState.videoId}
                </p>
              ) : null}
            </div>
          </div>
        )}

        {!room.isHost && radioState?.videoId ? (
          <div className="flex flex-wrap items-center justify-center gap-4">
            <button
              type="button"
              onClick={() => setIsTunedIn((v) => !v)}
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-lg shadow-violet-900/40 ring-2 ring-white/20 hover:brightness-110 active:scale-95 transition"
              title={effectivePlaybackMode === 'server_audio' ? 'Tune in / out of room audio' : 'Tune in / out of YouTube audio'}
            >
              {isTunedIn ? <IconPause /> : <IconPlay />}
            </button>
          </div>
        ) : null}

        {room.isHost ? (
          <div className="flex w-full max-w-3xl flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
            <div className="flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-950/20 p-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-amber-200/80">Host sign-in</span>
              {authLoading ? (
                <p className="text-xs text-white/50">Checking session…</p>
              ) : isAuthenticated ? (
                <div className="flex flex-wrap items-center gap-2 text-xs text-white/80">
                  <span>{hostUser?.name || hostUser?.email || 'Signed in'}</span>
                  <span className="tabular-nums text-white/45">
                    {formatBytesShort(hostUser?.audioBytesUsed)} / {formatBytesShort(hostUser?.audioQuotaBytes)}
                  </span>
                  <button type="button" className="rounded-lg bg-white/10 px-2 py-1 hover:bg-white/20" onClick={() => void signOut()}>
                    Sign out
                  </button>
                </div>
              ) : (
                <>
                  <p className="text-[11px] text-white/50">
                    Google sign-in is required to broadcast as host (listeners stay anonymous).
                  </p>
                  <button
                    type="button"
                    className="self-start rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-white/90"
                    onClick={() => void signIn()}
                  >
                    Sign in with Google
                  </button>
                </>
              )}
              {authError ? <p className="text-[11px] text-red-300">{authError}</p> : null}
              {!isAuthenticated ? (
                <p className="text-[11px] text-amber-200/70">Relay will not treat you as host until you sign in.</p>
              ) : null}
            </div>
            {isAuthenticated ? (
              <HostLibraryPanel appToken={appToken} onAddTrackToPlaylist={addLibraryTrackToPlaylist} />
            ) : null}
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-white/55">Playback (room-wide)</span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setHostPlaybackMode('youtube')}
                  className={`rounded-xl px-4 py-2 text-sm ring-2 transition ${
                    radioState.playbackMode === 'youtube'
                      ? 'bg-violet-600/70 text-white ring-violet-400/50'
                      : 'bg-white/10 text-white/80 ring-transparent hover:bg-white/16'
                  }`}
                >
                  YouTube only
                </button>
                <button
                  type="button"
                  disabled={!serverAudioLive}
                  onClick={() => setHostPlaybackMode('server_audio')}
                  title={
                    !serverAudioLive
                      ? 'Server cached audio is not enabled on this deployment'
                      : 'Audio from disk; timeline keeps going if you close the browser'
                  }
                  className={`rounded-xl px-4 py-2 text-sm ring-2 transition ${
                    !serverAudioLive
                      ? 'cursor-not-allowed bg-white/5 text-white/35 ring-white/10'
                      : radioState.playbackMode === 'server_audio'
                        ? 'bg-teal-700/60 text-white ring-teal-400/45'
                        : 'bg-white/10 text-white/80 ring-transparent hover:bg-white/16'
                  }`}
                >
                  Cached audio only
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-white/45">
                You control load / play / pause / seek for everyone. YouTube mode stops when no host is connected.
                Cached mode uses the HTTP stream once ready and can run after you leave.
              </p>
            </div>
            {serverAudioLive ? (
              <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/25 p-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-white/55">Host playlist (server)</span>
                <p className="text-[11px] text-white/45">
                  Paste direct https links to audio files (one per line). Quota:{' '}
                  <span className="tabular-nums text-white/70">
                    {formatBytesShort(quotaBytes.used)} / {formatBytesShort(quotaBytes.max)}
                  </span>{' '}
                  per host browser on this server (sum of stored import bytes).
                  {gdriveStatus.configured && gdriveStatus.serviceAccountEmail ? (
                    <>
                      {' '}
                      <span className="text-white/55">Google Drive:</span> share the folder with{' '}
                      <span className="break-all font-mono text-white/70">{gdriveStatus.serviceAccountEmail}</span>{' '}
                      (Viewer), then import below.
                    </>
                  ) : (
                    <>
                      {' '}
                      <span className="text-white/55">Google Drive folder import</span> is available when the operator
                      sets <span className="font-mono text-white/60">GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON</span> on the
                      server (service account JSON path or inline JSON).
                    </>
                  )}
                </p>
                <textarea
                  value={playlistUrlsText}
                  onChange={(e) => setPlaylistUrlsText(e.target.value)}
                  rows={3}
                  disabled={playlistBusy}
                  className="w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-xs text-white outline-none focus:border-white/30"
                  placeholder={"https://example.com/audio.mp3\n(one URL per line)"}
                />
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={playlistBusy || !clientId}
                    onClick={() => void importPlaylistUrls()}
                    className="rounded-lg bg-teal-700/50 px-3 py-1.5 text-xs hover:bg-teal-700/70 disabled:opacity-40"
                  >
                    {playlistBusy ? 'Importing…' : 'Import URLs'}
                  </button>
                </div>
                <div className="mt-2 flex flex-col gap-1.5 border-t border-white/10 pt-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-white/40">
                    Google Drive folder
                  </span>
                  <input
                    type="text"
                    value={gdriveFolderInput}
                    onChange={(e) => setGdriveFolderInput(e.target.value)}
                    disabled={playlistBusy || !clientId || !gdriveStatus.configured}
                    placeholder="https://drive.google.com/drive/folders/…"
                    className="w-full rounded-lg bg-black/40 border border-white/10 px-3 py-2 text-xs text-white outline-none focus:border-white/30 disabled:opacity-40"
                  />
                  <button
                    type="button"
                    disabled={playlistBusy || !clientId || !gdriveStatus.configured}
                    onClick={() => void importGdriveFolder()}
                    className="self-start rounded-lg bg-indigo-700/45 px-3 py-1.5 text-xs hover:bg-indigo-700/65 disabled:opacity-40"
                  >
                    {playlistBusy ? 'Working…' : 'Import Drive folder'}
                  </button>
                </div>
                {playlistMsg ? <p className="text-[11px] text-amber-200/90">{playlistMsg}</p> : null}
                {(radioState.playlist || []).length ? (
                  <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto text-left text-[11px]">
                    {(radioState.playlist || []).map((item) => (
                      <li
                        key={item.id}
                        className={`flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1 ${
                          radioState.videoId === item.id ? 'bg-white/10' : 'bg-white/[0.03]'
                        }`}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-white/80 hover:text-white"
                          onClick={() => selectPlaylistTrack(item.id)}
                        >
                          {item.title}
                          {typeof item.sizeBytes === 'number' ? (
                            <span className="ml-2 tabular-nums text-white/40">{formatBytesShort(item.sizeBytes)}</span>
                          ) : null}
                        </button>
                        <button
                          type="button"
                          className="shrink-0 text-rose-300/80 hover:text-rose-200"
                          onClick={() => removePlaylistItem(item.id)}
                        >
                          remove
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/25 p-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-white/55">Cover (cached mode)</span>
              <p className="text-[11px] text-white/45">HTTPS image URL and/or upload (JPEG / PNG / WebP, max ~700 KB).</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={applyCoverHttpsUrl}
                  className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20"
                >
                  Set HTTPS URL
                </button>
                <input ref={coverFileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" />
                <button
                  type="button"
                  onClick={() => coverFileRef.current?.click()}
                  className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20"
                >
                  Choose file
                </button>
                <button
                  type="button"
                  onClick={() => void uploadCoverFile()}
                  className="rounded-lg bg-sky-800/50 px-3 py-1.5 text-xs hover:bg-sky-800/70"
                >
                  Upload cover
                </button>
                <button type="button" onClick={clearCover} className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-white/60 hover:bg-white/10">
                  Clear cover
                </button>
              </div>
              {coverMsg ? <p className="text-[11px] text-sky-200/90">{coverMsg}</p> : null}
            </div>
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
            {room.isHost && effectivePlaybackMode === 'server_audio' && serverAudioReady && radioState.videoId ? (
              <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
                <div className="flex items-center justify-between gap-2 text-[11px] text-white/55">
                  <span>Seek (host)</span>
                  <span className="tabular-nums text-white/40">
                    {(seekUiSec ?? effectiveTimelineSec(radioState)).toFixed(1)}s
                    {radioState.durationSec && radioState.durationSec > 1
                      ? ` / ${radioState.durationSec.toFixed(1)}s`
                      : ''}
                  </span>
                </div>
                <input
                  type="range"
                  className="mt-1 w-full accent-teal-400"
                  min={0}
                  max={Math.max(
                    1,
                    radioState.durationSec && radioState.durationSec > 1 ? radioState.durationSec : 600,
                  )}
                  step={0.05}
                  value={seekUiSec ?? effectiveTimelineSec(radioState)}
                  onPointerDown={() => setSeekUiSec(effectiveTimelineSec(radioState))}
                  onChange={(e) => setSeekUiSec(Number(e.target.value))}
                  onPointerUp={(e) => {
                    commitServerAudioSeek(Number(e.currentTarget.value));
                    setSeekUiSec(null);
                  }}
                  onTouchEnd={(e) => {
                    const t = e.currentTarget;
                    commitServerAudioSeek(Number(t.value));
                    setSeekUiSec(null);
                  }}
                />
              </div>
            ) : null}
            {radioState?.videoId && radioState.playbackMode === 'server_audio' ? (
              <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs leading-relaxed text-white/70">
                {!serverAudioLive ? (
                  'Cached path unavailable (server flag off). Everyone falls back to YouTube until you switch mode.'
                ) : radioState.downloadStatus === 'ready' ? (
                  'Cache ready — everyone hears the track; the browser loads the full file when size allows (otherwise it streams). YouTube is hidden in this mode.'
                ) : radioState.downloadStatus === 'downloading' ? (
                  'Fetching audio to disk… no YouTube player in this mode; audio starts once the cache is ready.'
                ) : radioState.downloadStatus === 'error' ? (
                  <span className="text-rose-300/90">Cache error: {formatCacheDownloadError(radioState.downloadError)}</span>
                ) : (
                  'Waiting for cache before HTTP audio can start.'
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
