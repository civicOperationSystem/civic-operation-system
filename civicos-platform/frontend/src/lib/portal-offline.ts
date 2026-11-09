import type { CivicRecord, Portal, Session } from './civic';
import {
  decryptOfflineValue, encryptOfflineValue, getOfflineCryptoKey, isOfflineCiphertext,
  type OfflineCiphertext,
} from './offline-security';

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
  locked?: boolean;
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
type StoredPendingPublicReport = Omit<PendingPublicReport, 'report' | 'locked'> & {
  report?: PublicReport | OfflineCiphertext;
};
type StoredPortalOfflineCache = Omit<PortalOfflineCache, 'reports'> & { reports: StoredPendingPublicReport[] };

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

export async function readPortalCache(slug: string): Promise<PortalOfflineCache | undefined> {
  const cached = await read<StoredPortalOfflineCache>('portals', slug);
  if (!cached) return undefined;
  const hasReportBodies = cached.reports.some(report => report.report);
  let unlocked = true;
  if (hasReportBodies) {
    try { getOfflineCryptoKey(); }
    catch { unlocked = false; }
  }
  if (!unlocked) return {
    ...cached,
    reports: cached.reports.map(({ report, ...item }) => ({ ...item, locked: !!report })),
  };

  let migrated = false;
  const storedReports: StoredPendingPublicReport[] = [];
  const reports: PendingPublicReport[] = [];
  for (const item of cached.reports) {
    if (!item.report) {
      const { report: _report, ...metadata } = item;
      storedReports.push(item);
      reports.push(metadata);
      continue;
    }
    if (isOfflineCiphertext(item.report)) {
      storedReports.push(item);
      reports.push({ ...item, report: await decryptOfflineValue<PublicReport>(item.report) });
      continue;
    }
    const encrypted = await encryptOfflineValue(item.report);
    const { report: _report, ...metadata } = item;
    storedReports.push({ ...metadata, report: encrypted });
    reports.push({ ...metadata, report: item.report });
    migrated = true;
  }
  if (migrated) {
    const encryptedCache = { ...cached, reports: storedReports };
    await write('portals', slug, encryptedCache);
    if (cached.portal.domain) {
      await write('portals', `domain:${cached.portal.domain}`, encryptedCache);
    }
  }
  return { ...cached, reports };
}

export async function savePortalSnapshot(
  slug: string,
  snapshot: Pick<PortalOfflineCache, 'portal' | 'content' | 'calendarRequests'>,
): Promise<PortalOfflineCache> {
  const result = await change<StoredPortalOfflineCache>('portals', slug, current => ({
    ...current,
    ...snapshot,
    savedAt: new Date().toISOString(),
    details: current?.details || {},
    reports: current?.reports || [],
  }));
  if (!result) throw new Error('The offline portal snapshot was not saved.');
  if (snapshot.portal.domain) {
    await change<StoredPortalOfflineCache>('portals', `domain:${snapshot.portal.domain}`, () => result);
  }
  const hydrated = await readPortalCache(slug);
  if (!hydrated) throw new Error('The offline portal snapshot was not saved.');
  return hydrated;
}

export async function readPortalCacheForDomain(domain: string): Promise<PortalOfflineCache | undefined> {
  const cached = await read<StoredPortalOfflineCache>('portals', `domain:${domain}`);
  return cached ? readPortalCache(cached.portal.slug) : undefined;
}

export async function savePublicRequestDetail(slug: string, detail: PublicRequestDetail): Promise<void> {
  await change<StoredPortalOfflineCache>('portals', slug, current => current && ({
    ...current, details: { ...current.details, [detail.id]: detail },
  }));
}

export async function queuePublicReport(slug: string, report: PublicReport, id = crypto.randomUUID()): Promise<PendingPublicReport> {
  const encrypted = await encryptOfflineValue(report);
  const pending: PendingPublicReport = {
    id, createdAt: new Date().toISOString(), report,
  };
  await withPublicReportLock(slug, async () => {
    await change<StoredPortalOfflineCache>('portals', slug, current => {
      if (!current) throw new Error('Open the portal online once before saving an offline report.');
      const { report: _report, ...metadata } = pending;
      return { ...current, reports: [...current.reports, { ...metadata, report: encrypted }] };
    });
  });
  return pending;
}

export async function saveSubmittedPublicReport(slug: string, id: string, reference: string): Promise<PendingPublicReport[]> {
  await change<StoredPortalOfflineCache>('portals', slug, current => current && ({
    ...current,
    reports: [...current.reports, { id, createdAt: new Date().toISOString(), reference }],
  }));
  const cached = await readPortalCache(slug);
  if (!cached) throw new Error('The tracking reference could not be saved on this device.');
  return cached.reports;
}

export async function updatePublicReport(
  slug: string, id: string, update: (report: PendingPublicReport) => PendingPublicReport | undefined,
): Promise<void> {
  await withPublicReportLock(slug, async () => {
    const stored = await read<StoredPortalOfflineCache>('portals', slug);
    if (!stored) return;
    const hydrated = await readPortalCache(slug);
    if (!hydrated) return;
    const nextReports = hydrated.reports.flatMap(report => {
      if (report.id !== id) return [report];
      const next = update(report);
      return next ? [next] : [];
    });
    const reports = await Promise.all(nextReports.map(async report => {
      const { locked: _locked, report: body, ...metadata } = report;
      return { ...metadata, ...(body ? { report: await encryptOfflineValue(body) } : {}) };
    }));
    await write('portals', slug, { ...stored, reports });
  });
}

async function withPublicReportLock<T>(slug: string, work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('A current browser over HTTPS is required to safely protect saved reports.');
  return navigator.locks.request(`civicos-public-reports:${slug}`, work);
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
export async function readStaffCache(scope: string): Promise<StaffOfflineCache | undefined> {
  const stored = await read<StaffOfflineCache | import('./offline-security').OfflineCiphertext>('staff', scope);
  if (!stored) return undefined;
  if (isOfflineCiphertext(stored)) return decryptOfflineValue<StaffOfflineCache>(stored);
  const encrypted = await encryptOfflineValue(stored);
  await write('staff', scope, encrypted);
  return stored;
}

async function write<T>(storeName: string, key: string, value: T): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error('Offline data could not be saved.'));
      tx.onerror = () => reject(new Error('Offline data could not be saved.'));
    });
  } finally { db.close(); }
}

export async function saveStaffSnapshot(
  scope: string,
  snapshot: Omit<StaffOfflineCache, 'savedAt'>,
): Promise<void> {
  const encrypted = await encryptOfflineValue({ ...snapshot, savedAt: new Date().toISOString() });
  await write('staff', scope, encrypted);
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
