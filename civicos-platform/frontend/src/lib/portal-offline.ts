import type { CivicRecord, Portal, Session } from './civic';

export type PublicCalendarRequest = {
  id: string;
  title: string;
  category: string | null;
  status: string;
  created_at: string;
  completed_at: string | null;
};
export type PublicRequestDetail = PublicCalendarRequest & {
  description: string;
  location: string;
  longitude: number | null;
  latitude: number | null;
  updated_at: string;
  photos: string[];
  history: { status: string; timestamp: string }[];
};
export type PublicReport = {
  category: string;
  description: string;
  location: string;
  longitude: number | null;
  latitude: number | null;
  anonymous: boolean;
  photos: string[];
  contact: { name: string | null; email: string | null; phone: string | null } | null;
};
export type PendingPublicReport = {
  id: string;
  createdAt: string;
  report?: PublicReport;
  reference?: string;
  error?: string;
};
export type PortalOfflineCache = {
  portal: Portal;
  content: CivicRecord[];
  calendarRequests: PublicCalendarRequest[];
  savedAt: string;
  details: Record<string, PublicRequestDetail>;
  reports: PendingPublicReport[];
};
export type StaffOfflineCache = {
  session: Session;
  records: CivicRecord[];
  content: CivicRecord[];
  savedAt: string;
  page: number;
};

const databaseName = 'civicos-offline-v1';
const stores = ['portals', 'directories', 'staff'];

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      for (const store of stores) request.result.createObjectStore(store);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Offline storage could not open. Check device storage and browser permissions.'));
    request.onblocked = () => reject(new Error('Close other CivicOS tabs to enable offline storage.'));
  });
}

async function read<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Could not read the offline portal data.'));
    });
  } finally { db.close(); }
}

async function change<T>(
  storeName: string, key: string, update: (value: T | undefined) => T | undefined,
): Promise<T | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      let result: T | undefined;
      let failure: unknown;
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          result = update(request.result);
          if (result === undefined) store.delete(key);
          else store.put(result, key);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || new Error('Offline data could not be saved. Device storage may be full.'));
      tx.onerror = () => { failure = new Error('Offline data could not be saved. Device storage may be full.'); };
    });
  } finally { db.close(); }
}

export function staffOfflineScope(authUserId: string, slug: string): string {
  return `${authUserId}:${slug}`;
}

export const readPortalCache = (slug: string) => read<PortalOfflineCache>('portals', slug);

export async function savePortalSnapshot(
  slug: string,
  snapshot: Pick<PortalOfflineCache, 'portal' | 'content' | 'calendarRequests'>,
): Promise<PortalOfflineCache> {
  const result = await change<PortalOfflineCache>('portals', slug, current => ({
    ...current,
    ...snapshot,
    savedAt: new Date().toISOString(),
    details: current?.details || {},
    reports: current?.reports || [],
  }));
  if (!result) throw new Error('The offline portal snapshot was not saved.');
  if (snapshot.portal.domain) {
    await change<PortalOfflineCache>('portals', `domain:${snapshot.portal.domain}`, () => result);
  }
  return result;
}

export async function readPortalCacheForDomain(domain: string): Promise<PortalOfflineCache | undefined> {
  const cached = await read<PortalOfflineCache>('portals', `domain:${domain}`);
  return cached ? (await readPortalCache(cached.portal.slug)) || cached : undefined;
}

export async function savePublicRequestDetail(slug: string, detail: PublicRequestDetail): Promise<void> {
  await change<PortalOfflineCache>('portals', slug, current => current && ({
    ...current, details: { ...current.details, [detail.id]: detail },
  }));
}

export async function queuePublicReport(slug: string, report: PublicReport): Promise<PendingPublicReport> {
  const pending: PendingPublicReport = {
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), report,
  };
  await change<PortalOfflineCache>('portals', slug, current => {
    if (!current) throw new Error('Open the portal online once before saving an offline report.');
    return { ...current, reports: [...current.reports, pending] };
  });
  return pending;
}

export async function updatePublicReport(
  slug: string, id: string, update: (report: PendingPublicReport) => PendingPublicReport | undefined,
): Promise<void> {
  await change<PortalOfflineCache>('portals', slug, current => current && ({
    ...current,
    reports: current.reports.flatMap(report => {
      if (report.id !== id) return [report];
      const next = update(report);
      return next ? [next] : [];
    }),
  }));
}

export async function saveOrganizationDirectory(organizations: { name: string; slug: string }[]): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('directories', 'readwrite');
      tx.objectStore('directories').put(organizations, 'organizations');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error('The offline organization directory could not be saved.'));
      tx.onerror = () => reject(new Error('The offline organization directory could not be saved.'));
    });
  } finally { db.close(); }
}

export const readOrganizationDirectory = () => read<{ name: string; slug: string }[]>('directories', 'organizations');
export const readStaffCache = (scope: string) => read<StaffOfflineCache>('staff', scope);

export async function saveStaffSnapshot(
  scope: string,
  snapshot: Omit<StaffOfflineCache, 'savedAt'>,
): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('staff', 'readwrite');
      tx.objectStore('staff').put({ ...snapshot, savedAt: new Date().toISOString() }, scope);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error('The staff offline snapshot could not be saved.'));
      tx.onerror = () => reject(new Error('The staff offline snapshot could not be saved.'));
    });
  } finally { db.close(); }
}

export async function clearStaffCache(scope: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('staff', 'readwrite');
      tx.objectStore('staff').delete(scope);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error('The cached staff workspace could not be cleared.'));
      tx.onerror = () => reject(new Error('The cached staff workspace could not be cleared.'));
    });
  } finally { db.close(); }
}
