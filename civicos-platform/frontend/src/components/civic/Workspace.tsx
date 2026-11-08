'use client';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { Session as SupabaseSession } from '@supabase/supabase-js';
import { civicApi, CivicRecord, Session, Member, RequestDetail, Portal, readFieldPhoto } from '@/lib/civic';
import { projectFieldDetail, type FieldUpdate } from '@/lib/field-offline';
import { clearStaffCache, readStaffCache, saveStaffSnapshot, staffOfflineScope } from '@/lib/portal-offline';
import { getCivicSupabase, isCivicSupabaseConfigured } from '@/lib/supabase';
import useFieldOffline from './useFieldOffline';
import WorkspaceView from './WorkspaceView';
import useWorkspaceEditor from './useWorkspaceEditor';
import useWorkspaceFieldLocation from './useWorkspaceFieldLocation';
import {
  offlineStaffRecord, readFieldCoordinates as parseFieldCoordinates, staffIdentityKey,
  ticketTransitions, visibleWorkspaceRecords,
} from './workspace-data';

export default function Workspace({ field = false }: { field?: boolean }) {
  const offline = useFieldOffline(field);
  const editor = useWorkspaceEditor();
  const {
    calendarMonth, setCalendarMonth, worker, setWorker, roles, setRoles, newRole, setNewRole,
    editingContent, setEditingContent, contentLongitude, setContentLongitude, contentLatitude,
    setContentLatitude, contentMapOpen, setContentMapOpen, contentPoint,
  } = editor;
  const [slug, setSlug] = useState('');
  const [linkedOrganization, setLinkedOrganization] = useState(false);
  const [organizationName, setOrganizationName] = useState('');
  const [token, setToken] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [records, setRecords] = useState<CivicRecord[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [content, setContent] = useState<CivicRecord[]>([]);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const fieldLocation = useWorkspaceFieldLocation(field, detail);
  const {
    fieldPoint, setFieldPoint, fieldLongitude, setFieldLongitude, fieldLatitude, setFieldLatitude,
    editingFieldLocation, setEditingFieldLocation,
  } = fieldLocation;
  const [view, setView] = useState('requests');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState('');
  const [noteVisibility, setNoteVisibility] = useState<'role_only' | 'down_chain'>('role_only');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [staffOffline, setStaffOffline] = useState(false);
  const [networkOnline, setNetworkOnline] = useState(true);
  const [staffSnapshotSavedAt, setStaffSnapshotSavedAt] = useState('');
  const [offlineStorageWarning, setOfflineStorageWarning] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const exchangedToken = useRef('');
  const staffIdentity = useRef('');
  const exchangeSession = useRef<((authSession: SupabaseSession) => Promise<void>) | null>(null);
  useEffect(() => {
    if (!field || !offline.cache) return;
    const current = offline.cache;
    setSession(current.session);
    setRecords(current.details.map(item => projectFieldDetail(item, current.queue)));
    setDetail(previous => {
      const item = current.details.find(item => item.id === previous?.id);
      return item ? projectFieldDetail(item, current.queue) : null;
    });
  }, [field, offline.cache]);
  useEffect(() => {
    const organization = new URLSearchParams(window.location.search).get('org') || '';
    setSlug(organization);
    setLinkedOrganization(!!organization);
  }, []);
  useEffect(() => {
    if (field) return;
    setNetworkOnline(navigator.onLine);
    if (!('serviceWorker' in navigator)) {
      setOfflineStorageWarning('Offline page caching requires a current browser over HTTPS.');
      return;
    }
    let active = true;
    void navigator.serviceWorker.register('/field-sw.js', { scope: '/' })
      .then(registration => navigator.serviceWorker.ready.then(() => registration))
      .then(registration => {
        if (active && registration.active) {
          registration.active.postMessage({ type: 'CACHE_APP_SHELL', url: window.location.href });
        }
      })
      .catch(failure => {
        if (active) setOfflineStorageWarning(`Offline page caching failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      });
    const disconnected = () => { setNetworkOnline(false); setStaffOffline(true); };
    const reconnected = () => {
      setNetworkOnline(true);
      if (!isCivicSupabaseConfigured()) return;
      exchangedToken.current = '';
      void getCivicSupabase().auth.getSession().then(({ data, error: authError }) => {
        if (authError) throw authError;
        if (data.session) return exchangeSession.current?.(data.session);
      }).catch(failure => setError(failure instanceof Error ? failure.message : 'Could not refresh staff access'));
    };
    window.addEventListener('offline', disconnected);
    window.addEventListener('online', reconnected);
    return () => {
      active = false;
      window.removeEventListener('offline', disconnected);
      window.removeEventListener('online', reconnected);
    };
  }, [field]);
  useEffect(() => {
    setOrganizationName('');
    if (!linkedOrganization || !slug) return;
    const abort = new AbortController();
    void civicApi<Portal>(`/public/${encodeURIComponent(slug)}`, { signal: abort.signal })
      .then(organization => { if (!abort.signal.aborted) setOrganizationName(organization.name); })
      .catch(failure => {
        if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load organization');
      });
    return () => abort.abort();
  }, [linkedOrganization, slug]);
  useEffect(() => {
    if (!session) return;
    document.documentElement.lang = session.portal.settings.language;
    document.title = `${session.portal.name} | ${field ? 'Field workspace' : 'Staff operations'} | CivicOS`;
  }, [session, field]);
  const has = (permission: string) => !!session?.permissions.includes(permission);
  const load = useCallback(async (access = token, selectedPage = page) => {
    if (field) {
      await offline.refresh(access);
      setRevision(value => value + 1);
      return;
    }
    const current = await civicApi<Session>('/staff/me', { token: access });
    const [requests, people, pages] = await Promise.all([
      current.permissions.some(item => item === 'read' || item === 'field') ? civicApi<CivicRecord[]>(`/staff/requests?page=${selectedPage}`, { token: access }) : Promise.resolve([]),
      current.permissions.includes('read') ? civicApi<Member[]>('/staff/members', { token: access }) : Promise.resolve([]),
      current.permissions.includes('publish') ? civicApi<CivicRecord[]>('/staff/content', { token: access }) : Promise.resolve([]),
    ]);
    setSession(current); setRecords(requests); setMembers(people); setContent(pages);
    if (current.permissions.includes('manage')) {
      const config = await civicApi<{ roles: Record<string, string[]> }>('/staff/roles', { token: access });
      setRoles(config.roles);
    }
    if (!field && staffIdentity.current) {
      try {
        await saveStaffSnapshot(staffOfflineScope(staffIdentity.current, slug), {
          session: current, records: requests.map(offlineStaffRecord), content: pages, page: selectedPage,
        });
        setStaffSnapshotSavedAt(new Date().toISOString());
        setOfflineStorageWarning('');
        localStorage.setItem(staffIdentityKey(slug), staffIdentity.current);
      } catch (failure) {
        setOfflineStorageWarning(failure instanceof Error ? failure.message : 'Staff data could not be saved for offline access.');
      }
    }
    setStaffOffline(false);
    setRevision(value => value + 1);
  }, [page, token, field, offline.refresh, slug]);
  useEffect(() => {
    if (!slug || !isCivicSupabaseConfigured()) return;
    let active = true;
    if (field && !navigator.onLine) {
      void offline.resume(slug).catch(failure => {
        if (active) setError(failure instanceof Error ? failure.message : 'Could not restore cached assignments.');
      });
      return () => { active = false; };
    }
    const supabase = getCivicSupabase();
    const exchange = async (authSession: SupabaseSession) => {
      const exchangeKey = `${slug}:${authSession.access_token}`;
      if (!active || exchangedToken.current === exchangeKey) return;
      exchangedToken.current = exchangeKey;
      staffIdentity.current = authSession.user.id;
      setBusy(true); setError('');
      try {
        if (field && !navigator.onLine) {
          await offline.open(authSession.user.id, slug);
          return;
        }
        const response = await civicApi<{ token: string }>('/login', {
          method: 'POST', body: { slug, access_token: authSession.access_token },
        });
        if (field) await offline.open(authSession.user.id, slug, response.token);
        else await load(response.token, 1);
        if (active) { setToken(response.token); setPage(1); setNotice(''); }
        if (field) void offline.sync();
      } catch (failure) {
        if (active) {
          if (field && failure instanceof TypeError) {
            try { await offline.open(authSession.user.id, slug); return; }
            catch (cacheFailure) { setError(cacheFailure instanceof Error ? cacheFailure.message : 'Could not restore offline assignments'); }
          }
          if (!field && failure instanceof TypeError) {
            try {
              const cached = await readStaffCache(staffOfflineScope(authSession.user.id, slug));
              if (cached) {
                setSession(cached.session); setRecords(cached.records); setContent(cached.content);
                setMembers([]); setRoles({}); setToken(''); setPage(cached.page);
                setStaffSnapshotSavedAt(cached.savedAt); setStaffOffline(true); setError('');
                return;
              }
            } catch (cacheFailure) {
              setError(cacheFailure instanceof Error ? cacheFailure.message : 'Could not restore cached staff access');
            }
          }
          setError(failure instanceof Error ? failure.message : 'Could not verify your organization access');
          setSession(null); setToken('');
        }
      } finally { if (active) setBusy(false); }
    };
    exchangeSession.current = exchange;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, authSession) => {
      if (event === 'SIGNED_OUT') {
        if (field) offline.pause();
        else if (!navigator.onLine && localStorage.getItem(staffIdentityKey(slug))) {
          const identity = localStorage.getItem(staffIdentityKey(slug))!;
          staffIdentity.current = identity;
          void readStaffCache(staffOfflineScope(identity, slug)).then(cached => {
            if (!cached) throw new Error('No saved staff workspace is available offline.');
            setSession(cached.session); setRecords(cached.records); setContent(cached.content);
            setMembers([]); setRoles({}); setToken(''); setPage(cached.page);
            setStaffSnapshotSavedAt(cached.savedAt); setStaffOffline(true); setError('');
          }).catch(failure => setError(failure instanceof Error ? failure.message : 'Could not restore cached staff access'));
          exchangedToken.current = '';
          return;
        } else {
          const identity = staffIdentity.current;
          if (identity) void clearStaffCache(staffOfflineScope(identity, slug)).catch(failure =>
            setError(failure instanceof Error ? failure.message : 'Could not clear the cached staff workspace'));
          localStorage.removeItem(staffIdentityKey(slug));
          staffIdentity.current = '';
          setStaffOffline(false); setStaffSnapshotSavedAt('');
        }
        exchangedToken.current = '';
        setToken(''); setSession(null); setRecords([]); setContent([]); setMembers([]); setDetail(null);
        setRoles({}); setEditingContent(null); setError('');
        setNotice(field ? 'Your online session ended. Sign in to recover any pending work saved on this device.' : '');
      } else if (authSession) {
        window.setTimeout(() => { void exchange(authSession); }, 0);
      }
    });
    void supabase.auth.getSession().then(({ data, error: authError }) => {
      if (authError) throw authError;
      if (data.session) return exchange(data.session);
    }).catch(failure => {
      if (active) setError(failure instanceof Error ? failure.message : 'Could not restore your sign-in');
    });
    return () => { active = false; exchangeSession.current = null; subscription.unsubscribe(); };
  }, [load, slug, field, offline.open, offline.resume, offline.sync, offline.pause, offline.online]);
  const reconnect = useCallback(async () => {
    if (!isCivicSupabaseConfigured()) throw new Error('Authentication is not configured.');
    exchangedToken.current = '';
    const { data, error: authError } = await getCivicSupabase().auth.getSession();
    if (authError) throw authError;
    if (!data.session) throw new Error('Sign in online again to sync pending work.');
    await exchangeSession.current?.(data.session);
    await offline.sync();
  }, [offline.sync]);
  useEffect(() => {
    if (!field) return;
    const connected = () => {
      void reconnect().catch(failure => setError(failure instanceof Error ? failure.message : 'Sign in online again to sync pending work.'));
    };
    window.addEventListener('online', connected);
    return () => window.removeEventListener('online', connected);
  }, [field, reconnect]);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const { error: authError } = await getCivicSupabase().auth.signInWithOtp({
        email: String(data.get('email')).trim().toLowerCase(),
        options: {
          shouldCreateUser: true,
          emailRedirectTo: `${window.location.origin}${field ? '/field' : '/staff'}?org=${encodeURIComponent(slug)}`,
        },
      });
      if (authError) throw authError;
      setNotice('If that email belongs to an active CivicOS account, a one-time sign-in link has been sent.');
      form.reset();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send a sign-in link'); }
    finally { setBusy(false); }
  }
  async function action(work: () => Promise<void>, success = 'Saved successfully') {
    setBusy(true); setError(''); setNotice('');
    try { await work(); setNotice(success); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Operation failed'); }
    finally { setBusy(false); }
  }
  async function selectRequest(id: string) {
    await action(async () => {
      const cached = offline.cache?.details.find(item => item.id === id);
      const result = field && cached ? projectFieldDetail(cached, offline.cache!.queue) :
        await civicApi<RequestDetail>(`/staff/requests/${id}`, { token });
      setDetail(result); setWorker(result.assigned_to || ''); setNotes('');
      const location = result.longitude !== null && result.latitude !== null ? [result.longitude, result.latitude] as [number, number] : null;
      setFieldPoint(location); setEditingFieldLocation(!location);
    }, '');
  }
  async function transition(next: string) {
    if (!detail) return;
    if (field) { await queueFieldUpdate({ kind: 'transition', body: { status: next, notes, note_visibility: 'down_chain' } }); return; }
    await action(async () => {
      await civicApi(`/staff/requests/${detail.id}/transition`, { token, method: 'POST', body: { status: next, notes, note_visibility: noteVisibility } });
      setDetail(await civicApi<RequestDetail>(`/staff/requests/${detail.id}`, { token }));
      setNotes(''); await load();
    }, 'Workflow updated. The transition has been recorded.');
  }
  async function archive() {
    if (!detail) return;
    await action(async () => {
      await civicApi(`/staff/requests/${detail.id}/archive`, { token, method: 'POST' });
      setDetail(null); await load(token, page);
    }, 'Request archived. It remains visible in the public portal.');
  }
  async function archiveContent(item: CivicRecord) {
    if (!window.confirm(`Archive "${item.title}"? It will be removed from staff and field workspaces and can no longer be edited or withdrawn here.${item.published ? ' It stays visible on the public portal.' : ''}`)) return;
    await action(async () => {
      await civicApi(`/staff/content/${item.id}/archive`, { token, method: 'POST' });
      if (editingContent?.id === item.id) setEditingContent(null);
      setRevision(value => value + 1); await load();
    }, item.published ? 'Information archived. It remains visible in the public portal.' : 'Information archived.');
  }
  async function addNote() {
    if (!detail || !notes.trim()) return;
    if (field) { await queueFieldUpdate({ kind: 'notes', body: { notes, note_visibility: 'down_chain' } }); return; }
    await action(async () => {
      await civicApi(`/staff/requests/${detail.id}/notes`, { token, method: 'POST', body: { notes, note_visibility: noteVisibility } });
      setDetail(await civicApi<RequestDetail>(`/staff/requests/${detail.id}`, { token }));
      setNotes('');
    }, 'Private note added to this ticket.');
  }
  async function uploadFieldPhoto(file: File | null) {
    if (!detail || !file) return;
    await action(async () => {
      const photo = await readFieldPhoto(file);
      if (field) {
        const point = readFieldCoordinates();
        await offline.queue(detail.id, { kind: 'field-photo', body: {
          photo, ...(point ? { longitude: point[0], latitude: point[1] } : {}),
        } });
        return;
      }
      await civicApi(`/staff/requests/${detail.id}/field-photo`, {
        token, method: 'POST', body: {
          photo, longitude: fieldPoint?.[0], latitude: fieldPoint?.[1],
        },
      });
      const updated = await civicApi<RequestDetail>(`/staff/requests/${detail.id}`, { token });
      setDetail(updated);
      const location = updated.longitude !== null && updated.latitude !== null ? [updated.longitude, updated.latitude] as [number, number] : null;
      setFieldPoint(location); setEditingFieldLocation(!location);
      await load();
    }, field ? 'Photo saved on this device. Check pending updates for sync status.' : 'Field photo uploaded.');
  }
  async function queueFieldUpdate(update: FieldUpdate) {
    if (!detail) return;
    await action(async () => {
      await offline.queue(detail.id, update); setNotes('');
    }, 'Update saved on this device. Check pending updates for sync status.');
  }
  const readFieldCoordinates = () => parseFieldCoordinates(fieldLongitude, fieldLatitude);
  function stateLabel(key: string | null): string {
    return session?.portal.settings.states.find(state => state.key === key)?.label || key || 'Submitted';
  }
  const visible = visibleWorkspaceRecords(records, field, session?.user.id, status, search, stateLabel);
  const memberLabel = (id: string | null) => id ? members.find(member => member.id === id)?.display_name || id : 'Resident / unassigned';
  const { nextStates, previousStates, canPublishTicket } = ticketTransitions(detail, session);
  const fieldPhotoCount = detail?.field_photos.length || 0;
  async function logout() {
    if (field && !window.confirm('Signing out deletes cached assignments and any pending updates across all your workspaces on this device. Synchronize before signing out. Continue?')) return;
    try {
      if (field) { await offline.forget(); setSession(null); setDetail(null); setRecords([]); }
      else {
        localStorage.removeItem(staffIdentityKey(slug));
        if (staffIdentity.current) await clearStaffCache(staffOfflineScope(staffIdentity.current, slug));
        staffIdentity.current = '';
      }
      if (isCivicSupabaseConfigured()) {
        const { error: authError } = await getCivicSupabase().auth.signOut(field || !navigator.onLine ? { scope: 'local' } : undefined);
        if (authError) throw authError;
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not sign out');
      return;
    }
    setToken(''); setSession(null); setRecords([]); setContent([]); setMembers([]); setDetail(null);
    setError(''); setNotice(''); setRoles({}); setEditingContent(null); exchangedToken.current = '';
    setStaffOffline(false); setStaffSnapshotSavedAt('');
  }
  const viewProps = {
    field, offline, slug, linkedOrganization, organizationName, setSlug, session, records, members, content, detail, setDetail,
    view, setView, page, setPage, search, setSearch, status, setStatus, notes, setNotes, noteVisibility, setNoteVisibility,
    fieldPoint, setFieldPoint, fieldLongitude, setFieldLongitude, fieldLatitude, setFieldLatitude, editingFieldLocation, setEditingFieldLocation,
    calendarMonth, setCalendarMonth, worker, setWorker, roles, setRoles, newRole, setNewRole, editingContent, setEditingContent,
    contentLongitude, setContentLongitude, contentLatitude, setContentLatitude, contentPoint, contentMapOpen, setContentMapOpen,
    error, setError, notice, setNotice, staffOffline, networkOnline, staffSnapshotSavedAt, offlineStorageWarning, busy, revision, setRevision,
    token, visible, nextStates, previousStates, canPublishTicket, fieldPhotoCount, has, login, logout, action, reconnect, selectRequest,
    transition, addNote, uploadFieldPhoto, archive, archiveContent, load, readFieldCoordinates, stateLabel, memberLabel,
  };
  return <WorkspaceView {...viewProps} />;
}
