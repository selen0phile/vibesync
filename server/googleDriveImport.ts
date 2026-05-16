// @ts-nocheck
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import { trackIdFromUrl, validateImportedAudio } from './urlAudioImport.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'www.googleapis.com';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const MAX_FOLDER_FILES = 60;
const DOWNLOAD_TIMEOUT_MS = 180_000;

/**
 * @returns {object | null}
 */
export function loadServiceAccountFromEnv() {
  const raw = process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON;
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  try {
    if (s.startsWith('{')) return JSON.parse(s);
    const path = s;
    const txt = fs.readFileSync(path, 'utf8');
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

export function gdriveConfigured() {
  const sa = loadServiceAccountFromEnv();
  return Boolean(sa?.client_email && sa?.private_key);
}

export function gdriveServiceAccountEmail() {
  const sa = loadServiceAccountFromEnv();
  return sa?.client_email ? String(sa.client_email) : null;
}

/**
 * @param {string} input
 * @returns {string | null}
 */
export function parseDriveFolderId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m1 = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m1) return m1[1];
  const m2 = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  return null;
}

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/**
 * @param {object} sa
 * @returns {Promise<string>}
 */
async function mintAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: DRIVE_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    iat: now,
    exp: now + 3500,
  };
  const headerPart = b64url({ alg: 'RS256', typ: 'JWT' });
  const payloadPart = b64url(claim);
  const toSign = `${headerPart}.${payloadPart}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(toSign);
  sign.end();
  const sig = sign.sign(sa.private_key, 'base64url');
  const jwt = `${toSign}.${sig}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();

  const { status, json } = await httpsRequestJson('POST', 'oauth2.googleapis.com', '/token', {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
  }, body);

  if (status < 200 || status >= 400 || !json.access_token) {
    const err = new Error(json.error || 'gdrive_token_failed');
    err.code = 'gdrive_token_failed';
    err.status = status;
    err.detail = json;
    throw err;
  }
  return String(json.access_token);
}

/**
 * @param {string} method
 * @param {string} hostname
 * @param {string} pathQuery
 * @param {Record<string, string>} headers
 * @param {string | Buffer | null} [body]
 */
function httpsRequestJson(method, hostname, pathQuery, headers, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname,
      path: pathQuery,
      headers: { ...headers },
    };
    if (body != null && body !== '') {
      const len = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body));
      opts.headers['Content-Length'] = String(len);
    }
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const txt = buf.toString('utf8');
        let json = {};
        try {
          json = txt ? JSON.parse(txt) : {};
        } catch {
          json = { _raw: txt.slice(0, 500) };
        }
        resolve({ status: res.statusCode || 0, headers: res.headers, json });
      });
    });
    req.setTimeout(60_000, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    if (body != null && body !== '') req.write(body);
    req.end();
  });
}

/**
 * @param {string} accessToken
 * @param {string} folderId
 * @returns {Promise<Array<{ id: string, name: string, mimeType: string, size?: string }>>}
 */
async function listAudioCandidates(accessToken, folderId) {
  const out = [];
  let pageToken = '';
  for (;;) {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    let path = `/drive/v3/files?q=${q}&pageSize=100&fields=nextPageToken,files(id,name,mimeType,size)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
    // eslint-disable-next-line no-await-in-loop
    const { status, json } = await httpsRequestJson('GET', DRIVE_API, path, {
      Authorization: `Bearer ${accessToken}`,
    });
    if (status === 404) {
      const e = new Error('gdrive_folder_not_found');
      e.code = 'gdrive_folder_not_found';
      throw e;
    }
    if (status < 200 || status >= 400) {
      const e = new Error(json.error?.message || 'gdrive_list_failed');
      e.code = 'gdrive_list_failed';
      e.status = status;
      e.detail = json;
      throw e;
    }
    const files = Array.isArray(json.files) ? json.files : [];
    for (const f of files) {
      if (!f?.id || !f.name) continue;
      const mime = String(f.mimeType || '');
      const name = String(f.name || '');
      if (mime.startsWith('application/vnd.google-apps.')) continue;
      const low = name.toLowerCase();
      const audioMime = mime.toLowerCase().startsWith('audio/');
      const byExt = /\.(mp3|m4a|aac|wav|ogg|opus|flac|webm)$/i.test(low);
      if (audioMime || byExt) out.push({ id: f.id, name, mimeType: mime, size: f.size });
    }
    pageToken = json.nextPageToken ? String(json.nextPageToken) : '';
    if (!pageToken || out.length >= MAX_FOLDER_FILES * 2) break;
  }
  return out.slice(0, MAX_FOLDER_FILES);
}

/**
 * @param {string} accessToken
 * @param {string} fileId
 * @param {number} maxBytes
 */
async function downloadDriveMedia(accessToken, fileId, maxBytes) {
  const path = `/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'GET',
      hostname: DRIVE_API,
      path,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      timeout: DOWNLOAD_TIMEOUT_MS,
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 400)) {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const txt = Buffer.concat(chunks).toString('utf8').slice(0, 800);
          const e = new Error(`gdrive_download_${res.statusCode}`);
          e.code = 'gdrive_download_failed';
          e.status = res.statusCode;
          e.body = txt;
          reject(e);
        });
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (d) => {
        total += d.length;
        if (total > maxBytes) {
          res.destroy();
          reject(Object.assign(new Error('too_large'), { code: 'too_large' }));
          return;
        }
        chunks.push(d);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = res.headers['content-type'] ? String(res.headers['content-type']) : 'application/octet-stream';
        resolve({ buf, contentType: ct });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * @param {string} folderInput
 * @param {{ getRemainingBytes: () => Promise<number>, saveOne: (row: { trackId: string, title: string, sizeBytes: number, contentType: string, ext: string, buf: Buffer }) => Promise<void> }} opts
 * @returns {Promise<{ imported: Array<{ trackId: string, title: string, sizeBytes: number, contentType: string }>, errors: Array<{ file: string, code: string }> }>}
 */
export async function importDriveFolderAudio(folderInput, opts) {
  if (!gdriveConfigured()) {
    const e = new Error('gdrive_not_configured');
    e.code = 'gdrive_not_configured';
    throw e;
  }
  const sa = loadServiceAccountFromEnv();
  const folderId = parseDriveFolderId(folderInput);
  if (!folderId) {
    const e = new Error('gdrive_invalid_folder');
    e.code = 'gdrive_invalid_folder';
    throw e;
  }

  const token = await mintAccessToken(sa);
  const candidates = await listAudioCandidates(token, folderId);
  if (!candidates.length) {
    const e = new Error('gdrive_no_audio_files');
    e.code = 'gdrive_no_audio_files';
    throw e;
  }

  /** @type {Array<{ trackId: string, title: string, sizeBytes: number, contentType: string }>} */
  const imported = [];
  /** @type {Array<{ file: string, code: string }>} */
  const errors = [];

  for (const file of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const remaining = await opts.getRemainingBytes();
    if (remaining <= 0) {
      errors.push({ file: file.name, code: 'host_playlist_quota' });
      break;
    }
    const declared = file.size ? Number(file.size) : NaN;
    if (Number.isFinite(declared) && declared > remaining) {
      errors.push({ file: file.name, code: 'host_playlist_quota' });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const { buf, contentType } = await downloadDriveMedia(token, file.id, remaining);
      const v = validateImportedAudio(buf, contentType);
      if (!v.ok) {
        errors.push({ file: file.name, code: v.reason || 'not_audio_content' });
        continue;
      }
      const pseudoUrl = `https://drive.google.com/file/d/${file.id}/view`;
      const trackId = trackIdFromUrl(pseudoUrl);
      const title =
        file.name.replace(/\.(mp3|m4a|aac|wav|ogg|opus|flac|webm)$/i, '').slice(0, 200) ||
        file.name.slice(0, 200);
      const row = {
        trackId,
        title,
        sizeBytes: buf.length,
        contentType: v.contentType,
        ext: v.ext,
        buf,
      };
      // eslint-disable-next-line no-await-in-loop
      await opts.saveOne(row);
      imported.push({
        trackId,
        title,
        sizeBytes: row.sizeBytes,
        contentType: row.contentType,
      });
    } catch (e) {
      errors.push({ file: file.name, code: e?.code || String(e?.message || e) });
    }
  }

  if (!imported.length && errors.length) {
    const e = new Error(errors[0].code || 'gdrive_import_failed');
    e.code = errors[0].code || 'gdrive_import_failed';
    e.errors = errors;
    throw e;
  }

  return { imported, errors };
}
