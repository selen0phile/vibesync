import crypto from 'crypto';

export function getStreamSecret() {
  return process.env.STREAM_SIGNING_SECRET || process.env.ADMIN_SECRET || 'dev-stream-secret-change-me';
}

/** @param {string} roomId */
/** @param {string} videoId */
/** @param {number} expMs */
export function signStreamToken(roomId, videoId, expMs) {
  const payload = `${roomId}:${videoId}:${expMs}`;
  const h = crypto.createHmac('sha256', getStreamSecret()).update(payload).digest('hex');
  return { exp: expMs, sig: h.slice(0, 48) };
}

/** @param {string} roomId */
/** @param {string} videoId */
/** @param {number} exp */
/** @param {string} sig */
export function verifyStreamToken(roomId, videoId, exp, sig) {
  if (!roomId || !videoId || !Number.isFinite(Number(exp)) || !sig) return false;
  const expN = Number(exp);
  if (Date.now() > expN + 30_000) return false;
  const expect = signStreamToken(roomId, videoId, expN).sig;
  try {
    return crypto.timingSafeEqual(Buffer.from(expect, 'utf8'), Buffer.from(String(sig), 'utf8'));
  } catch {
    return expect === sig;
  }
}

/** @param {string} roomId */
/** @param {string} coverKey basename only */
/** @param {number} expMs */
export function signCoverToken(roomId, coverKey, expMs) {
  const subject = `cover:${String(coverKey).slice(0, 160)}`;
  return signStreamToken(roomId, subject, expMs);
}

/** @param {string} roomId */
/** @param {string} coverKey */
/** @param {number} exp */
/** @param {string} sig */
export function verifyCoverToken(roomId, coverKey, exp, sig) {
  const subject = `cover:${String(coverKey).slice(0, 160)}`;
  return verifyStreamToken(roomId, subject, exp, sig);
}
