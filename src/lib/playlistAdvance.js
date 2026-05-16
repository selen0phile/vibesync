/** @typedef {'off' | 'all' | 'one'} PlaylistRepeatMode */

/**
 * Decide what to play after the current track ends naturally (host only).
 * @param {{ videoId: string | null, playlist: Array<{ id?: string }>, repeatMode?: string, shuffle?: boolean }} opts
 * @returns {{ nextVideoId: string | null, restartSame: boolean, stop: boolean }}
 */
export function computePlaylistAdvance({ videoId, playlist, repeatMode = 'off', shuffle = false }) {
  const mode = repeatMode === 'all' || repeatMode === 'one' || repeatMode === 'off' ? repeatMode : 'off';
  const pl = (Array.isArray(playlist) ? playlist : [])
    .map((x) => (x && typeof x.id === 'string' ? { id: x.id } : null))
    .filter(Boolean);
  if (!videoId || !pl.length) {
    return { nextVideoId: null, restartSame: true, stop: false };
  }
  const inList = pl.some((x) => x.id === videoId);
  if (!inList) {
    return { nextVideoId: null, restartSame: true, stop: false };
  }

  if (mode === 'one') {
    return { nextVideoId: videoId, restartSame: true, stop: false };
  }

  const idx = pl.findIndex((x) => x.id === videoId);

  if (shuffle) {
    if (pl.length === 1) {
      return { nextVideoId: videoId, restartSame: true, stop: false };
    }
    const others = pl.filter((x) => x.id !== videoId);
    const pick = others[Math.floor(Math.random() * others.length)];
    return { nextVideoId: pick.id, restartSame: false, stop: false };
  }

  if (idx >= 0 && idx < pl.length - 1) {
    return { nextVideoId: pl[idx + 1].id, restartSame: false, stop: false };
  }

  if (mode === 'all' && pl.length) {
    return { nextVideoId: pl[0].id, restartSame: false, stop: false };
  }

  return { nextVideoId: null, restartSame: false, stop: true };
}
