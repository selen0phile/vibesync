/** Max bytes to buffer entirely in memory for server_audio playback (default 100 MiB, matches server host quota default). */
const raw = import.meta.env.VITE_CLIENT_AUDIO_FULL_DOWNLOAD_MAX_BYTES;
const parsed = raw != null && raw !== '' ? Number(raw) : NaN;
export const CLIENT_AUDIO_FULL_DOWNLOAD_MAX_BYTES =
  Number.isFinite(parsed) && parsed > 0 ? parsed : 100 * 1024 * 1024;
