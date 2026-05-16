import { prisma } from './db.js';

const LIB_PREFIX = 'lib_';

export function isLibraryTrackId(videoId: string | null | undefined): boolean {
  return typeof videoId === 'string' && videoId.startsWith(LIB_PREFIX) && videoId.length > LIB_PREFIX.length + 8;
}

export function libraryTrackIdFromUuid(uuid: string): string {
  return `${LIB_PREFIX}${uuid.replace(/-/g, '')}`;
}

export function uuidFromLibraryTrackId(videoId: string): string | null {
  if (!isLibraryTrackId(videoId)) return null;
  const hex = videoId.slice(LIB_PREFIX.length);
  if (!/^[a-f0-9]{32}$/i.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function resolveLibraryTrackForUser(userId: string, videoId: string) {
  const trackUuid = uuidFromLibraryTrackId(videoId);
  if (!trackUuid) return null;
  const track = await prisma.playlistTrack.findFirst({
    where: {
      id: trackUuid,
      status: 'ready',
      storageKey: { not: null },
      playlist: { userId },
    },
    include: { playlist: true },
  });
  if (!track?.storageKey) return null;
  return track;
}
