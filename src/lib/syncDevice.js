/**
 * Sync tuning split by input modality.
 *
 * - **PC / fine pointer:** `(pointer: coarse)` is false → desktop thresholds only (unchanged baseline).
 * - **Phone / coarse pointer:** looser gates + slower drift loop so YouTube embed seeks less often.
 *
 * Host timeline broadcast interval: slower only when `isCoarsePointerDevice()`.
 *
 * **Host iframe resync** (`CONTROLLER_RESYNC_SEEK_SEC`) is intentionally the same on every device so
 * hosting from a phone does not change the host-side seek gate vs PC.
 */

/** Host (controller) hard resync — fixed PC baseline; not part of coarse listener tuning. */
export const CONTROLLER_RESYNC_SEEK_SEC = 1.2;

export function isCoarsePointerDevice() {
  if (typeof window === 'undefined') return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches === true;
  } catch {
    return false;
  }
}

/** Host position relay: slower only on coarse-pointer devices. */
export function getHostPositionPublishIntervalMs() {
  return isCoarsePointerDevice() ? 1000 : 500;
}

/**
 * Listener-only drift loop + soft seek thresholds (suspend + !hard paths).
 * Desktop branch is the PC baseline; coarse branch is stricter about *avoiding* seeks.
 */
export function getListenerSyncProfile() {
  if (isCoarsePointerDevice()) {
    return {
      listenerResyncSeek: 1.42,
      suspendSeekThreshold: 0.62,
      driftIntervalMs: 1200,
      driftPausedSeek: 0.58,
      driftDeadbandErr: 0.21,
      driftDeadbandCtrl: 0.3,
      hardSeekErr: 1.18,
      hardSeekCtrl: 0.95,
      softSeekErr: 0.42,
      softSeekCtrl: 0.38,
      softSeekCooldownMs: 3200,
    };
  }
  return {
    listenerResyncSeek: 0.85,
    suspendSeekThreshold: 0.35,
    driftIntervalMs: 500,
    driftPausedSeek: 0.35,
    driftDeadbandErr: 0.12,
    driftDeadbandCtrl: 0.16,
    hardSeekErr: 0.85,
    hardSeekCtrl: 0.7,
    softSeekErr: 0.24,
    softSeekCtrl: 0.22,
    softSeekCooldownMs: 1000,
  };
}
