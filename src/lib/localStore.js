const DB_NAME = 'vibe-radio';
const DB_VERSION = 1;
const KV = 'kv';

export const DEFAULT_ROOM = {
  id: 'jaber',
  name: 'Jaber',
  isHost: false,
};

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV, 'readonly');
    const req = tx.objectStore(KV).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function set(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV, 'readwrite');
    tx.objectStore(KV).put(value, key);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
  });
}

const ROOM_ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomToken(length = 6) {
  const data = new Uint8Array(length);
  crypto.getRandomValues(data);
  return Array.from(data, (n) => ROOM_ID_CHARS[n % ROOM_ID_CHARS.length]).join('');
}

function randomId(prefix = '') {
  return `${prefix}${randomToken(10)}`;
}

export async function getIdentity() {
  const existing = await get('identity');
  if (existing?.clientId) return existing;
  const identity = { clientId: randomId('c_') };
  await set('identity', identity);
  return identity;
}

export async function getCurrentRoom() {
  const room = await get('currentRoom');
  if (room?.id) return room;
  await set('currentRoom', DEFAULT_ROOM);
  return DEFAULT_ROOM;
}

export async function saveCurrentRoom(room) {
  await set('currentRoom', room);
  const rooms = await getRooms();
  const next = [room, ...rooms.filter((r) => r.id !== room.id)].slice(0, 20);
  await set('rooms', next);
  return room;
}

export async function getRooms() {
  const rooms = await get('rooms');
  if (Array.isArray(rooms)) return rooms;
  return [DEFAULT_ROOM];
}

export async function createRoom() {
  const rooms = await getRooms();
  const used = new Set([DEFAULT_ROOM.id, ...rooms.map((room) => room.id)]);
  let id = randomToken(6);
  while (used.has(id)) id = randomToken(6);

  return {
    id,
    name: id,
    isHost: true,
  };
}

export function joinRoom(idOrName) {
  const raw = (idOrName || '').trim();
  const id = raw ? raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : DEFAULT_ROOM.id;
  return {
    id,
    name: raw || DEFAULT_ROOM.name,
    isHost: false,
  };
}

export async function saveRoomState(roomId, state) {
  await set(`roomState:${roomId}`, state);
}

export async function getRoomState(roomId) {
  return get(`roomState:${roomId}`);
}
