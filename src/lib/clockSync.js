/**
 * Client-side clock sync vs the radio server.
 * - θ (skewMs): estimated offset so server time ≈ Date.now() + skewMs (Cristian-style from ping).
 * - OWD: EWMA of RTT/2 for one-way delay heuristic; used as a playback lead for listener output latency.
 */

const subscribers = new Set();
let tick = 0;

function bump() {
  tick += 1;
  for (const cb of subscribers) cb();
}

export function subscribeClock(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getClockTick() {
  return tick;
}

/** @type {number} server epoch ms minus client epoch ms (estimate) */
let skewMs = 0;

/** @type {number} one-way delay estimate (ms), EWMA of RTT/2 */
let owdMs = 120;

/** @type {number} round-trip delay estimate (ms), EWMA */
let rttMs = 240;

const ALPHA_PING = 0.18;
const ALPHA_STATE = 0.045;
const MIN_RTT = 8;
const MAX_RTT = 12_000;

/**
 * NTP-ish: server time at "mid-flight" ≈ s; client midpoint ≈ (t0+t2)/2 → θ = s - (t0+t2)/2.
 * Also EWMA of RTT/2 as one-way delay heuristic.
 */
export function ingestPingSample(t0Client, serverS, t2Client) {
  const rtt = t2Client - t0Client;
  if (rtt < MIN_RTT || rtt > MAX_RTT) return;
  const thetaSample = serverS - (t0Client + t2Client) / 2;
  const owHalf = rtt / 2;
  if (!Number.isFinite(thetaSample) || !Number.isFinite(owHalf)) return;
  skewMs = ALPHA_PING * thetaSample + (1 - ALPHA_PING) * skewMs;
  rttMs = ALPHA_PING * rtt + (1 - ALPHA_PING) * rttMs;
  owdMs = ALPHA_PING * owHalf + (1 - ALPHA_PING) * owdMs;
  bump();
}

/** Light nudge from each state message (serverNow vs local receive time). */
export function ingestStateSample(serverNow) {
  if (serverNow == null || !Number.isFinite(serverNow)) return;
  const t = Date.now();
  const thetaSample = serverNow - t;
  skewMs = ALPHA_STATE * thetaSample + (1 - ALPHA_STATE) * skewMs;
  bump();
}

export function getSkewMs() {
  return skewMs;
}

export function getOwdMs() {
  return owdMs;
}

export function getRttMs() {
  return rttMs;
}

export function getClockStats() {
  return {
    pingMs: owdMs,
    rttMs,
    skewMs,
    leadSec: getPlaybackLeadSec(),
  };
}

/**
 * Small RTT-derived seed lead. Device/browser output latency is learned per client
 * in the playback controller instead of using a large fixed offset.
 */
export function getPlaybackLeadSec() {
  const sec = 0.04 + (rttMs / 1000) * 0.08 + (owdMs / 1000) * 0.04;
  return Math.min(0.18, Math.max(0.04, sec));
}
