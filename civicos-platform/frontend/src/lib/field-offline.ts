import type { RequestDetail, Session } from './civic';

export type FieldUpdate =
  | { kind: 'transition'; body: { status: string; notes: string; note_visibility: 'down_chain' } }
  | { kind: 'notes'; body: { notes: string; note_visibility: 'down_chain' } }
  | { kind: 'field-photo'; body: { photo: string; longitude?: number; latitude?: number } }
  | { kind: 'location'; body: { longitude: number; latitude: number } };
export type PendingFieldUpdate = FieldUpdate & {
  id: string; requestId: string; expectedVersion: string; createdAt: string; error?: string;
};
export type FieldCache = {
  session: Session; savedAt: string; details: RequestDetail[]; queue: PendingFieldUpdate[];
};

const databaseName = 'civicos-field-v1';
export const fieldScope = (authUserId: string, slug: string) => `${authUserId}:${slug}`;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspaces');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Offline storage could not open. Check device storage and browser permissions.'));
    request.onblocked = () => reject(new Error('Close other CivicOS tabs to enable offline storage.'));
  });
}

export async function readFieldCache(scope: string): Promise<FieldCache | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise<FieldCache | undefined>((resolve, reject) => {
      const request = db.transaction('workspaces').objectStore('workspaces').get(scope);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Could not read the offline workspace.'));
    });
  } finally { db.close(); }
}

export async function changeFieldCache(
  scope: string, change: (cache: FieldCache | undefined) => FieldCache | undefined,
): Promise<FieldCache | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise<FieldCache | undefined>((resolve, reject) => {
      const tx = db.transaction('workspaces', 'readwrite');
      const store = tx.objectStore('workspaces');
      let updated: FieldCache | undefined;
      let failure: unknown;
      const request = store.get(scope);
      request.onsuccess = () => {
        try {
          updated = change(request.result);
          if (updated) store.put(updated, scope); else store.delete(scope);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(updated);
      tx.onabort = () => reject(failure || new Error('Offline changes could not be saved. Device storage may be full. Your update was not queued.'));
      tx.onerror = () => { failure = new Error('Offline changes could not be saved. Device storage may be full. Your update was not queued.'); };
    });
  } finally { db.close(); }
}

export async function clearFieldIdentity(authUserId: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('workspaces', 'readwrite');
      const request = tx.objectStore('workspaces').openCursor(IDBKeyRange.bound(`${authUserId}:`, `${authUserId}:\uffff`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error('Could not clear offline assignments. Do not leave this device unattended.'));
    });
  } finally { db.close(); }
}

export function projectFieldDetail(detail: RequestDetail, queue: PendingFieldUpdate[]): RequestDetail {
  let projected = { ...detail, field_photos: [...detail.field_photos], history: [...detail.history] };
  for (const update of queue.filter(item => item.requestId === detail.id)) {
    if (update.kind === 'transition') projected = { ...projected, status: update.body.status };
    if (update.kind === 'location') projected = { ...projected, ...update.body };
    if (update.kind === 'field-photo') {
      projected.field_photos.push(update.body.photo);
      if (update.body.longitude !== undefined && update.body.latitude !== undefined) {
        projected = { ...projected, longitude: update.body.longitude, latitude: update.body.latitude };
      }
    }
  }
  return projected;
}

export function appendFieldUpdate(cache: FieldCache, requestId: string, update: FieldUpdate): FieldCache {
  const detail = cache.details.find(item => item.id === requestId);
  if (!detail?.sync_version) throw new Error('Refresh this assignment online before saving offline updates.');
  if (detail.assigned_to !== cache.session.user.id) throw new Error('Only your assigned tickets can be updated offline.');
  if (cache.queue.some(item => item.requestId === requestId && item.error)) throw new Error('Resolve the blocked updates for this ticket before adding more.');
  if (update.kind === 'field-photo' && projectFieldDetail(detail, cache.queue).field_photos.length >= 3) {
    throw new Error('A ticket can have no more than three field photos, including pending uploads.');
  }
  return {
    ...cache, queue: [...cache.queue, {
      ...update, id: crypto.randomUUID(), requestId, expectedVersion: detail.sync_version, createdAt: new Date().toISOString(),
    }],
  };
}
