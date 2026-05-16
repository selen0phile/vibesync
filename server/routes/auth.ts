import { Router } from 'express';
import { prisma } from '../db.js';
import { signAppToken } from '../auth/appJwt.js';
import { firebaseAdminReady, verifyFirebaseIdToken } from '../auth/firebaseAdmin.js';
import { requireAuth, type AuthedRequest } from '../middleware/auth.js';
import { USER_AUDIO_QUOTA_BYTES } from '../config.js';

const router = Router();

router.post('/session', async (req, res) => {
  const idToken = typeof req.body?.idToken === 'string' ? req.body.idToken.trim() : '';
  if (!idToken) {
    res.status(400).json({ ok: false, error: 'missing_id_token' });
    return;
  }
  if (!firebaseAdminReady()) {
    res.status(503).json({ ok: false, error: 'firebase_admin_not_configured' });
    return;
  }
  try {
    const decoded = await verifyFirebaseIdToken(idToken);
    const user = await prisma.user.upsert({
      where: { firebaseUid: decoded.uid },
      create: {
        firebaseUid: decoded.uid,
        email: decoded.email ?? null,
        name: decoded.name ?? null,
        pictureUrl: decoded.picture ?? null,
      },
      update: {
        email: decoded.email ?? null,
        name: decoded.name ?? null,
        pictureUrl: decoded.picture ?? null,
      },
    });
    const token = signAppToken({
      sub: user.id,
      email: user.email ?? undefined,
      name: user.name ?? undefined,
    });
    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        pictureUrl: user.pictureUrl,
        audioBytesUsed: Number(user.audioBytesUsed),
        audioQuotaBytes: USER_AUDIO_QUOTA_BYTES,
      },
    });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const msg = err.message || '';
    const isJwtMint = /options\.subject|jsonwebtoken/i.test(msg);
    res.status(401).json({
      ok: false,
      error: isJwtMint ? 'session_token_failed' : err.code || 'invalid_id_token',
      message: msg || undefined,
    });
  }
});

router.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) {
    res.status(404).json({ ok: false, error: 'user_not_found' });
    return;
  }
  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      pictureUrl: user.pictureUrl,
      audioBytesUsed: Number(user.audioBytesUsed),
      audioQuotaBytes: USER_AUDIO_QUOTA_BYTES,
    },
  });
});

router.post('/logout', (_req, res) => {
  res.json({ ok: true });
});

export default router;
