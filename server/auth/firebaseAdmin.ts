import fs from 'fs';
import admin from 'firebase-admin';

let initialized = false;

function loadServiceAccount(): admin.ServiceAccount | null {
  const inline = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON;
  if (inline?.trim()) {
    const s = inline.trim();
    try {
      if (s.startsWith('{')) return JSON.parse(s) as admin.ServiceAccount;
      return JSON.parse(fs.readFileSync(s, 'utf8')) as admin.ServiceAccount;
    } catch {
      return null;
    }
  }
  const candidates = [
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.FIREBASE_ADMIN_CREDENTIALS,
    `${process.env.HOME || ''}/.config/syncwatch/firebase-adminsdk.json`,
  ].filter(Boolean) as string[];
  for (const path of candidates) {
  if (path && fs.existsSync(path)) {
    try {
      return JSON.parse(fs.readFileSync(path, 'utf8')) as admin.ServiceAccount;
    } catch {
      /* try next path */
    }
  }
  }
  return null;
}

export function initFirebaseAdmin(): boolean {
  if (initialized) return true;
  if (admin.apps.length > 0) {
    initialized = true;
    return true;
  }
  const sa = loadServiceAccount();
  if (!sa) {
    return false;
  }
  admin.initializeApp({
    credential: admin.credential.cert(sa),
  });
  initialized = true;
  return true;
}

export async function verifyFirebaseIdToken(idToken: string) {
  if (!initFirebaseAdmin()) {
    throw Object.assign(new Error('firebase_admin_not_configured'), { code: 'firebase_admin_not_configured' });
  }
  return admin.auth().verifyIdToken(idToken);
}

export function firebaseAdminReady(): boolean {
  return initFirebaseAdmin();
}
