'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { civicApi, CivicApiError, type CivicRecord, type RequestDetail, type Session } from '@/lib/civic';
import {
  appendFieldUpdate, changeFieldCache, clearFieldIdentity, fieldScope, projectFieldDetail, readFieldCache,
  type FieldCache, type FieldUpdate, type PendingFieldUpdate,
} from '@/lib/field-offline';

const identityKey = 'civicos-field-identity';
const lockName = (scope: string) => `civicos-field:${scope.split(':')[0]}`;

export default function useFieldOffline(enabled: boolean) {
  const [cache, setCache] = useState<FieldCache>();
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [shellReady, setShellReady] = useState(false);
  const [error, setError] = useState('');
  const scope = useRef('');
  const access = useRef('');
  const syncingRef = useRef(false);
  const mounted = useRef(true);
  const publish = useCallback((key: string, value: FieldCache | undefined) => {
    if (mounted.current && key === scope.current) setCache(value);
  }, []);

  const refresh = useCallback(async (token = access.current) => {
    const key = scope.current;
    if (!key) throw new Error('Sign in online to prepare this device for offline work.');
    const session = await civicApi<Session>('/staff/me', { token });
    const records: CivicRecord[] = [];
    for (let page = 1; ; page++) {
      const items = await civicApi<CivicRecord[]>(`/staff/requests?page=${page}`, { token });
      records.push(...items.filter(item => item.assigned_to === session.user.id));
      if (items.length < 100) break;
    }
    const details: RequestDetail[] = [];
    for (let offset = 0; offset < records.length; offset += 5) {
      details.push(...await Promise.all(records.slice(offset, offset + 5).map(item =>
        civicApi<RequestDetail>(`/staff/requests/${item.id}`, { token }))));
    }
    if (key !== scope.current) return;
    const updated = await changeFieldCache(key, existing => key !== scope.current ? existing : ({
      session, savedAt: new Date().toISOString(), queue: existing?.queue || [],
      // Pending operations keep their original base version, even if dispatch has since changed the ticket.
      details: [
        ...details.filter(item => !existing?.queue.some(update => update.requestId === item.id)),
        ...(existing?.details.filter(item => existing.queue.some(update => update.requestId === item.id)) || []),
      ],
    }));
    access.current = token;
    publish(key, updated);
    return updated;
  }, [publish]);

  const sync = useCallback(async () => {
    if (!scope.current || !navigator.onLine || !access.current || syncingRef.current) return;
    if (!navigator.locks) { setError('This browser does not support safe offline synchronization. Use a current browser over HTTPS.'); return; }
    syncingRef.current = true; setSyncing(true); setError('');
    const key = scope.current;
    const token = access.current;
    try {
      await navigator.locks.request(lockName(key), async () => {
        let current = await readFieldCache(key);
        let applied = false;
        const blocked = new Set<string>();
        while (current && key === scope.current && navigator.onLine) {
          const update = current.queue.find(item => !item.error && !blocked.has(item.requestId)
            && !current?.queue.some(other => other.requestId === item.requestId && other.error));
          if (!update) break;
          try {
            const result = await civicApi<{ sync_version: string }>(`/staff/requests/${update.requestId}/${update.kind}`, {
              token, method: 'POST', signal: AbortSignal.timeout(15000), body: {
                ...update.body, client_operation_id: update.id, expected_version: update.expectedVersion,
              },
            });
            current = await changeFieldCache(key, saved => {
              if (!saved) throw new Error('Offline workspace was cleared while syncing.');
              const nextQueue = saved.queue.filter(item => item.id !== update.id).map(item =>
                item.requestId === update.requestId ? { ...item, expectedVersion: result.sync_version } : item);
              const details = saved.details.map(item => item.id === update.requestId
                ? { ...appendAppliedUpdate(item, update, saved.session), sync_version: result.sync_version } : item);
              return { ...saved, details, queue: nextQueue };
            });
            publish(key, current);
            applied = true;
          } catch (failure) {
            if (!(failure instanceof CivicApiError) || failure.status >= 500 || failure.status === 429) {
              throw failure;
            }
            const message = failure.status === 401 ? 'Sign in online again to sync these updates.' : failure.message;
            current = await changeFieldCache(key, saved => saved && ({
              ...saved, queue: saved.queue.map(item => item.id === update.id ? { ...item, error: message } : item),
            }));
            publish(key, current);
            blocked.add(update.requestId);
            if (failure.status === 401) { access.current = ''; throw new Error(message); }
          }
        }
        if (applied && key === scope.current && navigator.onLine) await refresh(token);
      });
    } catch (failure) {
      if (key === scope.current) setError(failure instanceof Error ? failure.message : 'Sync failed. Pending updates remain on this device.');
    } finally { syncingRef.current = false; if (mounted.current) setSyncing(false); }
  }, [publish, refresh]);

  const open = useCallback(async (authUserId: string, slug: string, token?: string) => {
    const key = fieldScope(authUserId, slug);
    scope.current = key; access.current = token || '';
    const saved = await readFieldCache(key);
    publish(key, saved);
    if (token) {
      await refresh(token);
      if (key !== scope.current) return;
      localStorage.setItem(identityKey, authUserId);
      // Authentication errors are retried only after a new successful sign-in.
      publish(key, await changeFieldCache(key, value => value && ({
        ...value, queue: value.queue.map(item => item.error === 'Sign in online again to sync these updates.'
          ? { ...item, error: undefined } : item),
      })));
    } else if (!saved) throw new Error('No cached assignments for this account. Sign in and refresh while online first.');
    return saved;
  }, [publish, refresh]);

  const resume = useCallback(async (slug: string) => {
    const identity = localStorage.getItem(identityKey);
    if (!identity) throw new Error('Sign in online and cache your assignments before working offline.');
    await open(identity, slug);
  }, [open]);

  const queue = useCallback(async (requestId: string, update: FieldUpdate) => {
    const key = scope.current;
    if (!key) throw new Error('Offline workspace is not ready.');
    publish(key, await changeFieldCache(key, saved => {
      if (key !== scope.current) throw new Error('The active offline workspace changed. Your update was not queued.');
      if (!saved) throw new Error('Offline workspace is not ready.');
      return appendFieldUpdate(saved, requestId, update);
    }));
    void sync();
  }, [publish, sync]);

  const discard = useCallback(async (requestId: string) => {
    const key = scope.current;
    if (syncingRef.current) throw new Error('Wait for synchronization to finish before discarding updates.');
    if (!navigator.locks) throw new Error('A current browser over HTTPS is required to manage offline updates.');
    await navigator.locks.request(lockName(key), async () => {
      publish(key, await changeFieldCache(key, saved => saved && ({
        ...saved, queue: saved.queue.filter(item => item.requestId !== requestId),
      })));
      if (navigator.onLine && access.current) await refresh();
    });
  }, [publish, refresh]);

  const forget = useCallback(async () => {
    const key = scope.current;
    if (syncingRef.current) throw new Error('Wait for synchronization to finish before signing out.');
    scope.current = ''; access.current = ''; setCache(undefined);
    if (key) {
      if (!navigator.locks) throw new Error('A current browser over HTTPS is required to clear the offline workspace safely.');
      await navigator.locks.request(lockName(key), async () => { await clearFieldIdentity(key.split(':')[0]); });
    }
    localStorage.removeItem(identityKey);
  }, []);

  const pause = useCallback(() => {
    scope.current = ''; access.current = ''; setCache(undefined);
    localStorage.removeItem(identityKey);
  }, []);
  const lock = useCallback(() => {
    scope.current = ''; access.current = ''; setCache(undefined);
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!enabled) return;
    const update = () => { setOnline(navigator.onLine); if (navigator.onLine) void sync(); };
    update();
    window.addEventListener('online', update); window.addEventListener('offline', update);
    const timer = window.setInterval(update, 30000);
    return () => {
      mounted.current = false;
      window.removeEventListener('online', update); window.removeEventListener('offline', update); clearInterval(timer);
    };
  }, [enabled, sync]);

  useEffect(() => {
    if (!enabled) return;
    if (!('serviceWorker' in navigator)) { setError('Offline reopening requires a current browser over HTTPS.'); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      if (active) setError('Offline page caching is not ready. Stay online and refresh before leaving for the field.');
    }, 20000);
    void Promise.all([
      navigator.serviceWorker.register('/field-sw.js', { scope: '/field' }),
      navigator.serviceWorker.register('/field-sw.js', { scope: '/' }),
    ]).then(async ([fieldRegistration, rootRegistration]) => {
      await navigator.serviceWorker.ready;
      return { fieldRegistration, rootRegistration };
    }).then(({ fieldRegistration, rootRegistration }) => {
        if (active) {
          clearTimeout(timer);
          setShellReady(true);
          fieldRegistration.active?.postMessage({ type: 'CACHE_APP_SHELL', url: window.location.href });
          rootRegistration.active?.postMessage({ type: 'CACHE_APP_SHELL', url: window.location.href });
        }
      })
      .catch(failure => {
        clearTimeout(timer);
        if (active) setError(`Offline page caching failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      });
    return () => { active = false; clearTimeout(timer); };
  }, [enabled]);

  return { cache, online, syncing, shellReady, error, open, resume, refresh, queue, sync, discard, forget, pause, lock };
}

function appendAppliedUpdate(detail: RequestDetail, update: PendingFieldUpdate, session: Session): RequestDetail {
  const projected = projectFieldDetail(detail, [update]);
  if (update.kind !== 'notes' && update.kind !== 'transition') return projected;
  return {
    ...projected, history: [...projected.history, {
      id: update.id, actor: session.user.id, previous_status: detail.status, new_status: projected.status,
      notes: update.body.notes, note_visibility: 'down_chain', assigned_to: detail.assigned_to, created_at: update.createdAt,
    }],
  };
}
