import { useCallback, useEffect, useState } from 'react';

export function HostLibraryPanel({ appToken, onAddTrackToPlaylist }) {
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('');
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploading, setUploading] = useState(false);

  const authHeaders = useCallback(
    () => ({
      Authorization: `Bearer ${appToken}`,
      'Content-Type': 'application/json',
    }),
    [appToken],
  );

  const loadPlaylists = useCallback(async () => {
    if (!appToken) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/me/playlists', { headers: authHeaders() });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'load_failed');
      setPlaylists(data.playlists || []);
      setSelectedPlaylistId((prev) => prev || data.playlists?.[0]?.id || '');
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, [appToken, authHeaders]);

  useEffect(() => {
    loadPlaylists();
  }, [loadPlaylists]);

  const createPlaylist = async () => {
    const name = newName.trim();
    if (!name) return;
    const r = await fetch('/api/me/playlists', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name }),
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error || 'create_failed');
      return;
    }
    setNewName('');
    await loadPlaylists();
    if (data.playlist?.id) setSelectedPlaylistId(data.playlist.id);
  };

  const onFile = async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file || !selectedPlaylistId) return;
    if (!file.type.startsWith('audio/') && !file.name.toLowerCase().endsWith('.mp3')) {
      setError('Please choose an MP3 or audio file.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const title = uploadTitle.trim() || file.name.replace(/\.[^.]+$/, '');
      const presignR = await fetch('/api/me/playlists/tracks/presign', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          playlistId: selectedPlaylistId,
          title,
          bytes: file.size,
          mime: file.type || 'audio/mpeg',
        }),
      });
      const presign = await presignR.json();
      if (!presignR.ok) throw new Error(presign.error || 'presign_failed');

      const putR = await fetch(presign.uploadUrl, {
        method: 'PUT',
        headers: presign.headers || { 'Content-Type': file.type || 'audio/mpeg' },
        body: file,
      });
      if (!putR.ok) throw new Error(`upload_http_${putR.status}`);

      const completeR = await fetch(`/api/me/playlists/tracks/${presign.trackId}/complete`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const complete = await completeR.json();
      if (!completeR.ok) throw new Error(complete.error || 'complete_failed');

      await loadPlaylists();
      if (onAddTrackToPlaylist && complete.track?.libraryId) {
        onAddTrackToPlaylist({
          id: complete.track.libraryId,
          title: complete.track.title,
          sizeBytes: complete.track.bytes,
        });
      }
      setUploadTitle('');
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setUploading(false);
    }
  };

  if (!appToken) return null;

  const selected = playlists.find((p) => p.id === selectedPlaylistId);

  return (
    <div className="rounded-lg border border-zinc-700/80 bg-zinc-900/60 p-3 text-sm space-y-3">
      <p className="font-medium text-zinc-200">Your library (cloud)</p>
      {error ? <p className="text-red-400 text-xs">{error}</p> : null}
      {loading ? <p className="text-zinc-500 text-xs">Loading playlists…</p> : null}

      <div className="flex gap-2">
        <input
          className="flex-1 rounded border border-zinc-600 bg-zinc-950 px-2 py-1 text-xs"
          placeholder="New playlist name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="button" className="rounded bg-zinc-700 px-2 py-1 text-xs hover:bg-zinc-600" onClick={createPlaylist}>
          Add
        </button>
      </div>

      <select
        className="w-full rounded border border-zinc-600 bg-zinc-950 px-2 py-1 text-xs"
        value={selectedPlaylistId}
        onChange={(e) => setSelectedPlaylistId(e.target.value)}
      >
        <option value="">Select playlist</option>
        {playlists.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.tracks?.length || 0})
          </option>
        ))}
      </select>

      <input
        className="w-full rounded border border-zinc-600 bg-zinc-950 px-2 py-1 text-xs"
        placeholder="Track title (optional)"
        value={uploadTitle}
        onChange={(e) => setUploadTitle(e.target.value)}
      />

      <label className="block">
        <span className="inline-block rounded bg-emerald-800/80 px-3 py-1.5 text-xs cursor-pointer hover:bg-emerald-700/80">
          {uploading ? 'Uploading…' : 'Upload MP3'}
        </span>
        <input
          type="file"
          accept="audio/*,.mp3"
          className="hidden"
          disabled={uploading || !selectedPlaylistId}
          onChange={onFile}
        />
      </label>

      {selected?.tracks?.length ? (
        <ul className="max-h-32 overflow-y-auto space-y-1 text-xs text-zinc-400">
          {selected.tracks.map((t) => (
            <li key={t.id} className="flex justify-between gap-2">
              <span className="truncate">{t.title}</span>
              <button
                type="button"
                className="shrink-0 text-emerald-400 hover:underline disabled:opacity-40"
                disabled={t.status !== 'ready'}
                onClick={() =>
                  onAddTrackToPlaylist?.({
                    id: t.libraryId,
                    title: t.title,
                    sizeBytes: t.bytes,
                  })
                }
              >
                Use
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
