import * as clockSync from './clockSync.js';

export function nowMsSkewed() {
  return Date.now() + clockSync.getSkewMs();
}

/**
 * Media timeline (seconds) — same model as server engine `effectivePositionSec`.
 * @param {{ videoId?: string | null, playing?: boolean, positionSec?: number, stampMs?: number, durationSec?: number }} state
 */
export function effectiveTimelineSec(state) {
  const duration = state?.durationSec;
  const wall = nowMsSkewed();
  const rawPosition = !state?.playing
    ? (state?.positionSec ?? 0)
    : (state.positionSec ?? 0) + Math.max(0, wall - state.stampMs) / 1000;
  if (!Number.isFinite(duration) || duration <= 1) return rawPosition;
  if (!state?.playing) return Math.min(duration, Math.max(0, rawPosition));
  return ((rawPosition % duration) + duration) % duration;
}
