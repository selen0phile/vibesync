import jwt from 'jsonwebtoken';

const ISSUER = process.env.JWT_ISSUER || 'syncwatch';
const AUDIENCE = process.env.JWT_AUDIENCE || 'syncwatch-clients';
const SECRET = process.env.JWT_SECRET || process.env.ADMIN_SECRET || 'dev-jwt-secret-change-me';
const TTL_MIN = Number(process.env.JWT_ACCESS_TTL_MIN || 60 * 24);

export type AppJwtPayload = {
  sub: string;
  email?: string;
  name?: string;
};

export function signAppToken(payload: AppJwtPayload): string {
  const { sub, email, name } = payload;
  return jwt.sign(
    { ...(email ? { email } : {}), ...(name ? { name } : {}) },
    SECRET,
    {
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresIn: `${TTL_MIN}m`,
      subject: sub,
    },
  );
}

export function verifyAppToken(token: string): AppJwtPayload | null {
  try {
    const decoded = jwt.verify(token, SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
    }) as jwt.JwtPayload;
    if (typeof decoded.sub !== 'string' || !decoded.sub) return null;
    return {
      sub: decoded.sub,
      email: typeof decoded.email === 'string' ? decoded.email : undefined,
      name: typeof decoded.name === 'string' ? decoded.name : undefined,
    };
  } catch {
    return null;
  }
}

export function bearerFromHeader(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const t = authHeader.slice(7).trim();
  return t || null;
}
