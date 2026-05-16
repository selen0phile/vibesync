// @ts-nocheck
import http from 'http';
import https from 'https';
import { URL } from 'url';
import crypto from 'crypto';

const MAX_REDIRECTS = 4;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 120_000;

/** @param {string} hostname */
function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h || h === 'localhost') return true;
  if (h.endsWith('.local')) return true;
  if (h === '0.0.0.0') return true;
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  if (ipv4.test(h)) {
    const p = h.split('.').map((x) => Number(x));
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    if (p[0] === 255) return true;
  }
  return false;
}

function allowedAudioMime(m) {
  if (!m || typeof m !== 'string') return false;
  const low = m.split(';')[0].trim().toLowerCase();
  return low.startsWith('audio/') || low === 'application/ogg' || low === 'application/octet-stream';
}

/**
 * @param {string} inputUrl
 * @returns {{ ok: boolean, error?: string, finalUrl?: string }}
 */
export function assertPublicHttpUrl(inputUrl) {
  let u;
  try {
    u = new URL(inputUrl);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'invalid_scheme' };
  if (isBlockedHost(u.hostname)) return { ok: false, error: 'blocked_host' };
  return { ok: true, finalUrl: u.href };
}

function requestOnce(urlStr, method) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    if (isBlockedHost(u.hostname)) {
      reject(Object.assign(new Error('blocked'), { code: 'blocked_host' }));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method,
        headers: {
          'User-Agent': 'syncwatch-host-audio/1',
          Accept: 'audio/*,*/*;q=0.8',
        },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        resolve({ res });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * @param {string} startUrl
 * @param {string} method
 */
async function followFetch(startUrl, method) {
  let url = startUrl;
  for (let i = 0; i < MAX_REDIRECTS; i += 1) {
    const check = assertPublicHttpUrl(url);
    if (!check.ok) throw Object.assign(new Error(check.error), { code: check.error });
    // eslint-disable-next-line no-await-in-loop
    const { res } = await requestOnce(url, method);
    const code = res.statusCode || 0;
    if (code >= 300 && code < 400 && res.headers.location) {
      const next = new URL(res.headers.location, url).href;
      res.resume();
      url = next;
      continue;
    }
    return { res, finalUrl: url };
  }
  throw Object.assign(new Error('too_many_redirects'), { code: 'too_many_redirects' });
}

/**
 * @param {string} url
 * @returns {Promise<{ contentType?: string, contentLength?: number, finalUrl: string }>}
 */
export async function probeUrl(url) {
  const { res, finalUrl } = await followFetch(url, 'HEAD');
  const code = res.statusCode || 0;
  res.resume();
  if (code < 200 || code >= 400) {
    throw Object.assign(new Error(`http_${code}`), { code: 'http_error', status: code });
  }
  const contentType = res.headers['content-type'] ? String(res.headers['content-type']) : undefined;
  const cl = res.headers['content-length'];
  const contentLength = cl ? Number(cl) : undefined;
  return { contentType, contentLength: Number.isFinite(contentLength) ? contentLength : undefined, finalUrl };
}

export function trackIdFromUrl(url) {
  const h = crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 16);
  return `u_${h}`;
}

export function extFromMime(m) {
  const low = (m || '').split(';')[0].trim().toLowerCase();
  if (low.includes('mpeg')) return '.mp3';
  if (low.includes('mp4') || low.includes('m4a')) return '.m4a';
  if (low.includes('ogg')) return '.ogg';
  if (low.includes('webm')) return '.webm';
  if (low.includes('opus')) return '.opus';
  if (low.includes('wav')) return '.wav';
  if (low.includes('flac')) return '.flac';
  return '.bin';
}

/**
 * @param {string} url
 * @param {number} maxBytes
 */
export async function downloadUrlToBuffer(url, maxBytes) {
  const { res, finalUrl } = await followFetch(url, 'GET');
  const code = res.statusCode || 0;
  if (code < 200 || code >= 400) {
    res.resume();
    throw Object.assign(new Error(`http_${code}`), { code: 'http_error', status: code });
  }
  const chunks = [];
  let total = 0;
  const ct = res.headers['content-type'] ? String(res.headers['content-type']) : '';
  await new Promise((resolve, reject) => {
    res.on('data', (d) => {
      total += d.length;
      if (total > maxBytes) {
        res.destroy();
        reject(Object.assign(new Error('too_large'), { code: 'too_large' }));
        return;
      }
      chunks.push(d);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  const buf = Buffer.concat(chunks);
  return { buf, contentType: ct, finalUrl };
}

function sniffAudioMagic(buf) {
  if (buf.length < 4) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return true;
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
  if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return true;
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
  return false;
}

/**
 * @param {Buffer} buf
 * @param {string} [contentType]
 * @returns {{ ok: true, ext: string, contentType: string } | { ok: false, reason: string, contentType?: string }}
 */
export function validateImportedAudio(buf, contentType) {
  const ct = (contentType || 'application/octet-stream').split(';')[0].trim();
  if (!buf?.length) return { ok: false, reason: 'empty_body' };
  if (!allowedAudioMime(ct) && !sniffAudioMagic(buf)) {
    return { ok: false, reason: 'not_audio_content', contentType: ct };
  }
  return { ok: true, ext: extFromMime(ct), contentType: ct };
}

function guessTitleFromUrl(u) {
  try {
    const { pathname } = new URL(u);
    const seg = pathname.split('/').filter(Boolean);
    const last = seg[seg.length - 1] || 'track';
    return decodeURIComponent(last.split('?')[0]).slice(0, 120) || 'track';
  } catch {
    return 'track';
  }
}

/**
 * @param {string} url
 * @param {{ remainingQuotaBytes: number }} quota
 * @returns {Promise<{ trackId: string, contentType: string, sizeBytes: number, title: string, ext: string, buf: Buffer }>}
 */
export async function importPublicAudioUrl(url, quota) {
  const u0 = assertPublicHttpUrl(url);
  if (!u0.ok) throw Object.assign(new Error(u0.error), { code: u0.error });

  let finalUrl = u0.finalUrl;
  let metaCt = '';
  let declaredLen;

  try {
    const meta = await probeUrl(url);
    finalUrl = meta.finalUrl;
    metaCt = meta.contentType || '';
    declaredLen = meta.contentLength;
  } catch {
    /* HEAD unsupported — continue with GET sniff */
  }

  const trackId = trackIdFromUrl(finalUrl);
  const remaining = quota.remainingQuotaBytes;
  if (declaredLen && declaredLen > remaining) {
    throw Object.assign(new Error('host_playlist_quota'), {
      code: 'host_playlist_quota',
      needed: declaredLen,
      remaining,
    });
  }

  const cap = Math.min(MAX_DOWNLOAD_BYTES, remaining, declaredLen || MAX_DOWNLOAD_BYTES);
  const { buf, contentType } = await downloadUrlToBuffer(finalUrl, cap);
  if (buf.length === 0) throw Object.assign(new Error('empty_body'), { code: 'empty_body' });
  const ct = contentType || metaCt || 'application/octet-stream';
  const v = validateImportedAudio(buf, ct);
  if (!v.ok) {
    throw Object.assign(new Error('not_audio_content'), { code: 'not_audio_content', contentType: ct });
  }

  const ext = v.ext;
  const title = guessTitleFromUrl(finalUrl);
  return { trackId, contentType: v.contentType, sizeBytes: buf.length, title, ext, buf };
}
