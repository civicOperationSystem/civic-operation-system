'use client';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Session as SupabaseSession } from '@supabase/supabase-js';
import { civicApi, CivicRecord, Session, Member, RequestDetail, Portal, displayDate, fieldCanEnter, readFieldPhoto } from '@/lib/civic';
import { projectFieldDetail, type FieldUpdate } from '@/lib/field-offline';
import { clearStaffCache, readStaffCache, saveStaffSnapshot, staffOfflineScope } from '@/lib/portal-offline';
import { getCivicSupabase, isCivicSupabaseConfigured } from '@/lib/supabase';
import MapEmbed from './MapEmbed';
import OrganizationSettings from './OrganizationSettings';
import ChatPanel from './ChatPanel';
import useFieldOffline from './useFieldOffline';
import styles from './civic.module.css';

const staffIdentityKey = (slug: string) => `civicos-staff-identity:${slug}`;

export default function Workspace({ field = false }: { field?: boolean }) {
  const offline = useFieldOffline(field);
  const [slug, setSlug] = useState('');
  const [linkedOrganization, setLinkedOrganization] = useState(false);
  const [organizationName, setOrganizationName] = useState('');
  const [token, setToken] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [records, setRecords] = useState<CivicRecord[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [content, setContent] = useState<CivicRecord[]>([]);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [view, setView] = useState('requests');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [notes, setNotes] = useState('');
  const [noteVisibility, setNoteVisibility] = useState<'role_only' | 'down_chain'>('role_only');
  const [fieldPoint, setFieldPoint] = useState<[number, number] | null>(null);
  const [fieldLongitude, setFieldLongitude] = useState('');
  const [fieldLatitude, setFieldLatitude] = useState('');
  const [editingFieldLocation, setEditingFieldLocation] = useState(false);
  useEffect(() => {
    if (!field) return;
    const location: [number, number] | null = detail?.longitude != null && detail.latitude != null
      ? [detail.longitude, detail.latitude] : null;
    setFieldPoint(location); setEditingFieldLocation(!location);
  }, [field, detail?.id, detail?.longitude, detail?.latitude]);
  useEffect(() => {
    setFieldLongitude(fieldPoint?.[0].toString() || '');
    setFieldLatitude(fieldPoint?.[1].toString() || '');
  }, [fieldPoint]);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [worker, setWorker] = useState('');
  const [roles, setRoles] = useState<Record<string, string[]>>({});
  const [newRole, setNewRole] = useState('');
  const [editingContent, setEditingContent] = useState<CivicRecord | null>(null);
  const [contentLongitude, setContentLongitude] = useState('');
  const [contentLatitude, setContentLatitude] = useState('');
  const [contentMapOpen, setContentMapOpen] = useState(false);
  useEffect(() => {
    setContentLongitude(editingContent?.longitude?.toString() ?? '');
    setContentLatitude(editingContent?.latitude?.toString() ?? '');
    setContentMapOpen(false);
  }, [editingContent]);
  const contentPoint = (() => {
    const longitude = Number(contentLongitude), latitude = Number(contentLatitude);
    return contentLongitude.trim() && contentLatitude.trim() && Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90 ? [longitude, latitude] as [number, number] : null;
  })();
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
  function readFieldCoordinates(): [number, number] | null {
    if (!fieldLongitude.trim() && !fieldLatitude.trim()) return null;
    const longitude = Number(fieldLongitude), latitude = Number(fieldLatitude);
    if (!fieldLongitude.trim() || !fieldLatitude.trim() || !Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new Error('Enter valid longitude and latitude.');
    return [longitude, latitude];
  }
  function stateLabel(key: string | null): string {
    return session?.portal.settings.states.find(state => state.key === key)?.label || key || 'Submitted';
  }
  const visible = records.filter(record => (!field || record.assigned_to === session?.user.id) &&
    (!status || record.status === status) &&
    `${record.title} ${record.description} ${record.category} ${record.location} ${record.reference} ${stateLabel(record.status)}`.toLowerCase().includes(search.toLowerCase()));
  const memberLabel = (id: string | null) => id ? members.find(member => member.id === id)?.display_name || id : 'Resident / unassigned';
  const nextStates = session?.portal.settings.states.find(state => state.key === detail?.status)?.next || [];
  const previousStates = detail ? session?.portal.settings.states.filter(state => state.next.includes(detail.status)).map(state => state.key) || [] : [];
  const canPublishTicket = !!detail && (() => {
    const state = session?.portal.settings.states.find(item => item.key === detail.status);
    return !!state && (state.key === 'completed' || state.next.length === 0);
  })();
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
  if (!field && staffOffline && session) return <main className={styles.shell} style={{ '--civic-accent': session.portal.settings.color || '#0d9488' } as React.CSSProperties}>
    <header className={styles.header}><Link className={styles.brand} href="/">C<span>O</span> <strong>CivicOS</strong></Link>
      <div className={styles.headerLinks}><Link href={`/portal/${slug}`}>Public portal ↗</Link><button onClick={() => void logout()}>Sign out</button></div></header>
    <section className={styles.workspace}>
      <p className={styles.eyebrow}>STAFF OPERATIONS · OFFLINE</p><h1>{session.portal.name}</h1>
      <p role="status">Offline — read-only snapshot for {session.user.email}{staffSnapshotSavedAt ? ` · last refreshed ${displayDate(staffSnapshotSavedAt, session.portal.settings)}` : ''}.</p>
      <p className={styles.hint}>This device can show only data saved during a previous online sign-in. Access may have changed since the snapshot was saved. Reconnect to verify permissions and make updates. Sign-in links require internet.</p>
      {offlineStorageWarning && <p role="alert" className={styles.error}>{offlineStorageWarning}</p>}
      {!!records.length && <section><h2>Saved service requests</h2><div className={styles.fieldCards}>{records.map(record => <article key={record.id} className={styles.card}>
        <span className={styles.tag}>{stateLabel(record.status)}</span><h3>{record.title}</h3><p>{record.description}</p>
        <small>{record.category} · {record.location} · Updated {displayDate(record.updated_at, session.portal.settings)}</small>
      </article>)}</div></section>}
      {!!content.length && <section><h2>Saved organization information</h2><div className={styles.fieldCards}>{content.map(item => <article key={item.id} className={styles.card}>
        <span className={styles.tag}>{item.kind}</span><h3>{item.title}</h3><p>{item.description}</p>
      </article>)}</div></section>}
      {!records.length && !content.length && <p className={styles.hint}>This account has no saved request or public information records.</p>}
    </section>
  </main>;
  return <main className={styles.shell} style={{ '--civic-accent': session?.portal.settings.color || '#0d9488' } as React.CSSProperties}>
    <header className={styles.header}><Link className={styles.brand} href="/">C<span>O</span> <strong>CivicOS</strong></Link>
      <div className={styles.headerLinks}><Link href={`/portal/${slug}`}>Public portal ↗</Link>{session && <button disabled={busy || (field && offline.syncing)} onClick={() => void logout()}>Sign out</button>}</div></header>
    {!field && session && <section className={styles.card}>
      <p role="status">{staffSnapshotSavedAt ? `Online · read-only offline snapshot ready (refreshed ${displayDate(staffSnapshotSavedAt, session.portal.settings)}).` : 'Preparing a read-only offline snapshot.'}</p>
      <p className={styles.hint}>Offline access contains the most recently loaded request and organization information only. Reconnect to verify access or make changes. Use a trusted device; cached staff data is stored in this browser.</p>
      {offlineStorageWarning && <p role="alert" className={styles.error}>{offlineStorageWarning}</p>}
    </section>}
    {!session ? <section className={styles.login}><p className={styles.eyebrow}>{field ? 'FIELD WORKSPACE' : 'STAFF OPERATIONS'}</p><h1>{field ? 'Good work starts here.' : 'Your community at work.'}</h1><p className={styles.hint}>Sign in to your organization's secure workspace. Access is controlled by your role.</p>
    {!field && !networkOnline && <p role="status" className={styles.hint}>A sign-in link requires internet. If you have signed in here before, your cached staff workspace will open automatically.</p>}
    {offlineStorageWarning && <p role="alert" className={styles.error}>{offlineStorageWarning}</p>}
    <form onSubmit={login} className={styles.form}><label>Organization{linkedOrganization ?
      <input readOnly value={organizationName || slug} /> :
      <input required value={slug} onChange={event => setSlug(event.target.value)} pattern="[a-z0-9\-]{3,60}" />}</label><label>Email<input name="email" required type="email" autoComplete="email" /></label>
      <button disabled={busy || (!field && !networkOnline)} className={styles.primary}>{busy ? 'Sending link…' : 'Email me a sign-in link'}</button>
        {error && <p role="alert" className={styles.error}>{error}</p>}</form>
      <p className={styles.hint}>Sign-in links are one-time use. Sign out when you finish, especially on shared devices.</p>
      {notice && <p role="status" className={styles.success}>{notice}</p>}
    </section> : <div className={styles.workspace}>
      <aside className={styles.sidebar}><h3>{session.portal.name}</h3><p>{session.user.email}<br />{session.user.role} · {field ? 'Field workspace' : 'Operations'}</p>
        {(field ? ['requests', 'calendar', 'map', ...(has('chat') ? ['chat'] : [])] : [
          ...(has('read') || has('field') ? ['requests', 'calendar', 'map'] : []),
          ...(has('chat') ? ['chat'] : []), ...(has('publish') ? ['content'] : []), ...(has('manage') ? ['members', 'settings'] : []),
        ]).map(tab => <button key={tab} aria-current={tab === view ? 'page' : undefined} onClick={() => { setView(tab); setDetail(null); setError(''); setNotice(''); }}>
          {({ requests: field ? 'My assignments' : 'Service requests', calendar: 'Request calendar', map: 'Community map', chat: field ? 'Field team chat' : 'Staff chat', content: 'Public information', members: 'People & roles', settings: 'Organization settings' })[tab]}
        </button>)}
      </aside>
      <section className={styles.main}>
        {field && <section aria-label="Offline work" className={styles.card}>
          <p role="status">{offline.online ? 'Online' : 'Offline — using saved assignments'} · {offline.cache?.queue.length || 0} pending updates{offline.syncing ? ' · Syncing…' : ''}</p>
          <p className={styles.hint}>Assignments, private notes and photos are stored on this device. Last refreshed: {offline.cache ? displayDate(offline.cache.savedAt, session.portal.settings) : 'Not cached'}. Maps and chat need a connection. Keep this workspace open to sync automatically.</p>
          <p className={styles.hint}>{offline.shellReady ? 'Offline reopening ready.' : 'Preparing offline reopening. Stay online until ready.'}</p>
          <button className={styles.secondary} disabled={busy || offline.syncing || !offline.online} onClick={() => void action(reconnect, 'Sync attempted. Check pending updates for any issues.')}>Sync pending updates</button>
          {offline.error && <p role="alert" className={styles.error}>{offline.error}</p>}
          {!!offline.cache?.queue.length && <ul>{offline.cache.queue.map(update => <li key={update.id}>
            {offline.cache?.details.find(item => item.id === update.requestId)?.title || update.requestId} · {update.kind} · {update.error || 'Waiting to sync'}
            {update.kind === 'notes' && <p>{update.body.notes}</p>}
            {update.kind === 'transition' && <p>{stateLabel(update.body.status)} {update.body.notes}</p>}
            {update.kind === 'field-photo' && <img src={update.body.photo} alt="Pending field work photo" width={80} />}
            {update.error && <button className={styles.secondary} disabled={busy || offline.syncing} onClick={() => {
              if (window.confirm('Discard all pending updates for this ticket? Copy any notes you need before discarding. Refresh online to review the current assignment.')) {
                void action(() => offline.discard(update.requestId), 'Pending updates discarded. Review the ticket before submitting new work.');
              }
            }}>Discard pending updates for this ticket</button>}
          </li>)}</ul>}
        </section>}
        {view === 'chat' && has('chat') ? <><div className={styles.sectionTitle}><div><p className={styles.eyebrow}>TEAM COMMUNICATION</p><h2>{field ? 'Field team chat' : 'Staff chat'}</h2></div></div>{field && !offline.online ? <p>Chat is unavailable offline.</p> : <ChatPanel token={token} session={session} />}</> : <><div className={styles.sectionTitle}><div><p className={styles.eyebrow}>{field ? 'OUT IN THE COMMUNITY' : 'OPERATIONS OVERVIEW'}</p><h2>{({ requests: field ? 'Your work, in one place' : 'Service requests', calendar: 'Request calendar', map: 'Operational map', content: 'Public information', members: 'People & access', settings: 'Organization settings' })[view]}</h2></div>
          <button disabled={busy || (field && (!offline.online || offline.syncing))} className={styles.secondary} onClick={() => void action(() => load(), 'Workspace refreshed')}>Refresh</button></div>
        {!detail && error && <p role="alert" className={styles.error}>{error}</p>}
        {notice && <p role="status" className={styles.success}>{notice}</p>}
        {view === 'requests' && <>
          <div className={styles.stats}><div className={styles.stat}><span>Requests on this page</span><strong>{field ? records.filter(record => record.assigned_to === session.user.id).length : records.length}</strong></div>
            <div className={styles.stat}><span>In progress on this page</span><strong>{visible.filter(record => record.status === 'in_progress').length}</strong></div><div className={styles.stat}><span>Awaiting verification</span><strong>{visible.filter(record => record.status === 'completed').length}</strong></div></div>
          <div className={styles.inline}><label>Search this page<input placeholder="Category, location, reference…" value={search} onChange={event => setSearch(event.target.value)} /></label>
            <label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{session.portal.settings.states.map(state => <option key={state.key} value={state.key}>{state.label}</option>)}</select></label></div>
          <div style={{ marginTop: 20 }} className={styles.requestBoard}>
            {session.portal.settings.states.map(state => {
              const recordsForState = visible.filter(record => record.status === state.key);
              return <section className={styles.requestColumn} key={state.key}><h3>{state.label}<small>{recordsForState.length}</small></h3>
                {recordsForState.map(record => <button key={record.id} className={styles.card} onClick={() => void selectRequest(record.id)}><span className={styles.tag}>{record.archived_at ? 'Archived' : record.category}</span><strong>{record.title}</strong><p>{record.location}</p><small>{record.assigned_to ? `Assigned: ${memberLabel(record.assigned_to)}` : 'Unassigned'} · {displayDate(record.updated_at, session.portal.settings)}</small>{field && <span className={styles.evidencePrompt}>Open to add completion photo and map pin</span>}</button>)}
              </section>;
            })}
          </div>
          {!visible.length && <div className={styles.empty}><h3>No requests to show.</h3><p>{field ? 'Assigned work will appear here when your team dispatches it.' : 'Requests submitted through the public portal appear here.'}</p></div>}
          {!field && <div className={styles.inline} style={{ marginTop: 18 }}><button className={styles.secondary} disabled={busy || page === 1} onClick={() => void action(async () => { await load(token, page - 1); setPage(page - 1); }, '')}>Previous</button><span>Page {page}</span><button className={styles.secondary} disabled={busy || records.length < 100} onClick={() => void action(async () => { await load(token, page + 1); setPage(page + 1); }, '')}>Next</button></div>}
        </>}
        {view === 'calendar' && (() => {
          const monthStart = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
          const gridStart = new Date(monthStart);
          gridStart.setDate(1 - ((monthStart.getDay() + 6) % 7));
          const days = Array.from({ length: 42 }, (_, index) => {
            const date = new Date(gridStart);
            date.setDate(gridStart.getDate() + index);
            return date;
          });
          const dateKey = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: session.portal.settings.timezone }).format(date);
          const recordsForDay = (date: Date) => visible.filter(record => dateKey(new Date(record.created_at)) === dateKey(date));
          return <><p className={styles.hint}>Requests are shown on their reported date with their current status. Administrators also see archived requests.</p>
            <div className={styles.inline}><button className={styles.secondary} onClick={() => setCalendarMonth(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))}>Previous month</button><strong>{new Intl.DateTimeFormat(session.portal.settings.language, { month: 'long', year: 'numeric' }).format(calendarMonth)}</strong><button className={styles.secondary} onClick={() => setCalendarMonth(current => new Date(current.getFullYear(), current.getMonth() + 1, 1))}>Next month</button></div>
            <div className={styles.calendar} role="grid" aria-label="Request calendar">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <strong key={day}>{day}</strong>)}{days.map(date => <section key={date.toISOString()} className={date.getMonth() === calendarMonth.getMonth() ? styles.calendarDay : `${styles.calendarDay} ${styles.calendarMuted}`}><time dateTime={date.toISOString().slice(0, 10)}>{date.getDate()}</time>{recordsForDay(date).map(record => <button key={record.id} onClick={() => void selectRequest(record.id)}>{record.title}<small>{stateLabel(record.status)}{record.archived_at ? ' · Archived' : ''}</small></button>)}</section>)}</div>
          </>;
        })()}
        {view === 'map' && <><p className={styles.hint}>This map is read-only by default. Use the zoom controls to inspect an area, or enable interaction to browse locations and open a request.</p>{field && !offline.online ? <p>Map unavailable offline. Open assignments from My assignments.</p> : <MapEmbed portal={session.portal} token={token} revision={revision} locked onSelect={id => void selectRequest(id)} />}</>}
        {detail && ['requests', 'calendar', 'map'].includes(view) && <article className={`${styles.card} ${styles.detail}`}>
          <div className={styles.sectionTitle}><div><span className={styles.tag}>{stateLabel(detail.status)}</span><h3>{detail.title}</h3></div><button onClick={() => setDetail(null)} className={styles.secondary}>Close</button></div>
          {field && <section className={styles.fieldEvidence}><h3>Add completion evidence</h3><p className={styles.hint}>Pin where the work was completed and upload up to three field photos (PNG, JPEG or WebP, up to 5 MB each). Photos over 512 KB are compressed to JPEG before upload. Field photos are public when the request is verified.</p>
            <label>Upload completion photo ({fieldPhotoCount}/3)<input className={styles.photoPicker} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || fieldPhotoCount >= 3} onChange={event => {
              const file = event.currentTarget.files?.[0] || null;
              event.currentTarget.value = '';
              void uploadFieldPhoto(file);
            }} /></label>
            {fieldPhotoCount >= 3 && <p className={styles.hint}>All three field photo slots are filled.</p>}
            {!offline.online ? <p className={styles.hint}>Map unavailable offline. Enter the corrected coordinates below.</p> : fieldPoint && !editingFieldLocation ?
              <><MapEmbed portal={session.portal} token={token} revision={revision} center={fieldPoint} marker={fieldPoint} zoom={16} focused locked />
                <button className={styles.secondary} disabled={busy} onClick={() => setEditingFieldLocation(true)}>Change location</button></> :
              <MapEmbed portal={session.portal} token={token} revision={revision} center={fieldPoint || session.portal.settings.center} zoom={fieldPoint ? 16 : undefined} onPoint={point => { setFieldPoint(point); setEditingFieldLocation(false); }} />}
            <div className={styles.inline}><label>Longitude<input type="number" min={-180} max={180} step="any" value={fieldLongitude} onChange={event => setFieldLongitude(event.target.value)} /></label><label>Latitude<input type="number" min={-90} max={90} step="any" value={fieldLatitude} onChange={event => setFieldLatitude(event.target.value)} /></label></div>
            <button disabled={busy} className={styles.secondary} onClick={() => void action(async () => {
              const point = readFieldCoordinates();
              if (!point) throw new Error('Enter valid longitude and latitude.');
              const [longitude, latitude] = point;
              await offline.queue(detail.id, { kind: 'location', body: { longitude, latitude } });
              setFieldPoint([longitude, latitude]);
            }, 'Location saved on this device. Check pending updates for sync status.')}>Save location</button>
            </section>}
          <div className={!field ? styles.staffTicketLayout : undefined}>
            <div>
              <p>{detail.description}</p><p>{detail.location}</p><code>{detail.reference}</code>
              {detail.contact && <p>Private contact: {detail.contact.name} · {detail.contact.email} {detail.contact.phone}</p>}
              {detail.photos.map((photo, index) => <img key={`${index}`} src={photo} alt={`Resident-submitted issue photo ${index + 1}`} />)}
              {detail.field_photos.map((photo, index) => <img key={`${index}`} src={photo} alt={`Field work photo ${index + 1}`} />)}
            </div>
            {!field && <aside>
              <h3>Request location</h3>
              {detail.longitude !== null && detail.latitude !== null ?
                <><p className={styles.hint}>Pinned coordinates: {detail.latitude}, {detail.longitude}</p>
                  <MapEmbed portal={session.portal} token={token} revision={revision}
                    center={[detail.longitude, detail.latitude]} marker={[detail.longitude, detail.latitude]} zoom={16}
                  focused locked /></> :
                <p className={styles.hint}>A map location was not provided for this ticket.</p>}
            </aside>}
          </div>
          <h3>Work updates</h3><p className={styles.hint}>Notes and staff identities remain private. Residents see only the public status and update times.</p>
          <label>Private note<textarea rows={3} maxLength={5000} value={notes} onChange={event => setNotes(event.target.value)} /></label>
          <label>Note visibility<select value={field ? 'down_chain' : noteVisibility} disabled={field} onChange={event => setNoteVisibility(event.target.value as 'role_only' | 'down_chain')}><option value="role_only">Only my role level</option><option value="down_chain">Share down the operational chain</option></select></label>
          {field && <p className={styles.hint}>Field notes are shared with staff and administrators.</p>}
          <button disabled={busy || !notes.trim()} className={styles.secondary} onClick={() => void addNote()}>Add private note</button>
          {has('transition') && <div className={styles.inline}>{[...new Set([...previousStates, ...nextStates])].filter(next => {
            const state = session.portal.settings.states.find(item => item.key === next);
            return (!field && has('read')) || (!!state && fieldCanEnter(state));
          }).map(next => {
            const movingBack = previousStates.includes(next) && !nextStates.includes(next);
            return <button key={next} disabled={busy} className={movingBack ? styles.secondary : styles.primary} onClick={() => void transition(next)}>{movingBack ? `Move back to ${stateLabel(next)}` : field && next === 'in_progress' ? 'Start work' : field && next === 'completed' ? 'Complete work' : `Move to ${stateLabel(next)}`}</button>;
          })}</div>}
          {has('assign') && !field && <div className={styles.form}><label>Assign a worker<select value={worker} onChange={event => setWorker(event.target.value)}><option value="">Choose a team member</option>{members.filter(member => member.active).map(member => <option key={member.id} value={member.id}>{member.display_name} · {member.role}</option>)}</select></label>
            <button disabled={busy || !worker} className={styles.secondary} onClick={() => void action(async () => {
              await civicApi(`/staff/requests/${detail.id}/assign`, { token, method: 'POST', body: { assigned_to: worker, notes, note_visibility: noteVisibility } });
              setDetail(await civicApi<RequestDetail>(`/staff/requests/${detail.id}`, { token })); await load(); setNotes('');
            }, 'Assignment recorded')}>Save assignment</button></div>}
          {has('publish') && !field && !canPublishTicket && !detail.published && <p className={styles.hint}>Complete this ticket before its description can be published. Resident photos are public after review; field photos appear when verified.</p>}
          {has('publish') && !field && (canPublishTicket || detail.published) && <label className={styles.checkbox}><input type="checkbox" checked={detail.published} disabled={busy} onChange={event => {
            const published = event.target.checked;
            setDetail({ ...detail, published });
            void action(async () => {
              try { await civicApi(`/staff/requests/${detail.id}/visibility`, { token, method: 'POST', body: { published } }); }
              catch (failure) { setDetail(detail); throw failure; }
              setRevision(value => value + 1);
            }, 'Map visibility updated');
          }} /> Publish completed ticket description to the public portal</label>}
          {has('read') && <button disabled={busy} className={styles.secondary} onClick={() => void archive()}>Archive request</button>}
          {error && <p role="alert" className={styles.error}>{error}</p>}
          <h3>Audit trail</h3><ol className={styles.timeline}>{detail.history.map(event => <li key={event.id}><strong>{stateLabel(event.previous_status)} → {stateLabel(event.new_status)}</strong><small>{memberLabel(event.actor)} · {displayDate(event.created_at, session.portal.settings)}</small>{event.assigned_to && <small>Assigned: {memberLabel(event.assigned_to)}</small>}{event.notes && <p>{event.notes}</p>}</li>)}</ol>
        </article>}
        {view === 'content' && has('publish') && <div className={styles.twoColumns}><section><h3>{editingContent ? 'Edit community information' : 'Publish community information'}</h3><form key={editingContent?.id || 'new'} className={styles.form} onSubmit={event => {
          event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
          void action(async () => {
            await civicApi(editingContent ? `/staff/content/${editingContent.id}` : '/staff/content', { token, method: editingContent ? 'PUT' : 'POST', body: {
              kind: data.get('kind'), title: data.get('title'), description: data.get('description'), location: data.get('location'),
              longitude: data.get('longitude') ? Number(data.get('longitude')) : null,
              latitude: data.get('latitude') ? Number(data.get('latitude')) : null,
              url: data.get('url'), published: data.get('published') === 'on',
              calendar_date: data.get('calendar_date') || null,
            } }); form.reset(); setEditingContent(null); setContentLongitude(''); setContentLatitude(''); setContentMapOpen(false); await load();
          }, 'Content saved');
        }}>
          <label>Type<select name="kind" defaultValue={editingContent?.kind || 'service'} disabled={!!editingContent}>{['service', 'announcement', 'event', 'project', 'facility', 'document', 'emergency', 'infrastructure'].map(kind => <option key={kind}>{kind}</option>)}</select></label>
          <label>Title<input name="title" required maxLength={150} defaultValue={editingContent?.title} /></label><label>Information<textarea name="description" rows={4} required maxLength={10000} defaultValue={editingContent?.description} /></label><label>Location<input name="location" maxLength={500} defaultValue={editingContent?.location} /></label>
          <div className={styles.inline}><label>Longitude<input name="longitude" type="number" min={-180} max={180} step="any" value={contentLongitude} onChange={event => setContentLongitude(event.target.value)} /></label><label>Latitude<input name="latitude" type="number" min={-90} max={90} step="any" value={contentLatitude} onChange={event => setContentLatitude(event.target.value)} /></label></div>
          <div className={styles.inline}><button type="button" className={styles.secondary} aria-expanded={contentMapOpen} onClick={() => setContentMapOpen(open => !open)}>{contentMapOpen ? 'Hide map' : contentPoint ? 'View or change on map' : 'Pick location on map'}</button>
            {contentPoint && <button type="button" className={styles.secondary} onClick={() => { setContentLongitude(''); setContentLatitude(''); }}>Clear coordinates</button>}</div>
          {contentMapOpen && <><p className={styles.hint}>Click the map to set the longitude and latitude.</p>
            <MapEmbed portal={session.portal} token={token} revision={revision} center={contentPoint || session.portal.settings.center} zoom={contentPoint ? 16 : undefined} marker={contentPoint || undefined}
              onPoint={([longitude, latitude]) => { setContentLongitude(longitude.toFixed(6)); setContentLatitude(latitude.toFixed(6)); }} /></>}
          <label>Calendar date (optional)<input name="calendar_date" type="date" defaultValue={editingContent?.calendar_date || ''} aria-describedby="calendar-date-hint" /></label>
          <p id="calendar-date-hint" className={styles.hint}>Published information with a date appears on that day in the public calendar.</p>
          <label>Document or information URL (HTTPS)<input name="url" type="url" defaultValue={editingContent?.url || ''} /></label><label className={styles.checkbox}><input name="published" type="checkbox" defaultChecked={editingContent?.published} /> Publish immediately</label><button className={styles.primary} disabled={busy}>Save information</button>
          {editingContent && <button type="button" className={styles.secondary} onClick={() => setEditingContent(null)}>Cancel editing</button>}
        </form></section><section><h3>Community information</h3><div className={styles.fieldCards}>{content.map(item => <article key={item.id} className={styles.card}><span className={styles.tag}>{item.kind} · {item.published ? 'Public' : 'Draft'}</span>        <h3>{item.title}</h3><p>{item.description}</p>{item.calendar_date && <small>Calendar: {item.calendar_date}</small>}
                  <div className={styles.inline}><button className={styles.secondary} onClick={() => setEditingContent(item)}>Edit information</button><button disabled={busy} className={styles.secondary} onClick={() => void action(async () => { await civicApi(`/staff/content/${item.id}`, { token, method: 'PUT', body: { published: !item.published } }); await load(); }, 'Publication updated')}>{item.published ? 'Withdraw from portal' : 'Publish'}</button><button disabled={busy} className={styles.secondary} aria-label={`Archive ${item.title}`} onClick={() => void archiveContent(item)}>Archive</button></div></article>)}</div></section></div>}
        {view === 'members' && has('manage') && <>
          <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Member</th><th>Role</th><th>Access</th></tr></thead><tbody>{members.map(member => <tr key={member.id}><td><label className={styles.srOnly} htmlFor={`member-name-${member.id}`}>Name for {member.email}</label><input id={`member-name-${member.id}`} defaultValue={member.display_name} disabled={busy} maxLength={100} onBlur={event => {
            const display_name = event.currentTarget.value.trim();
            if (!display_name || display_name === member.display_name) return;
            void action(async () => { await civicApi(`/staff/members/${member.id}`, { token, method: 'PUT', body: { display_name, role: member.role, active: member.active } }); await load(); }, 'Member name updated');
          }} /><small>{member.email}</small></td><td><select aria-label={`Role for ${member.email}`} value={member.role} disabled={busy || member.id === session.user.id} onChange={event => {
            const role = event.target.value;
            void action(async () => { await civicApi(`/staff/members/${member.id}`, { token, method: 'PUT', body: { display_name: member.display_name, role, active: member.active } }); await load(); }, 'Member role updated');
          }}>{Object.keys(roles).map(role => <option key={role}>{role}</option>)}</select></td><td><button disabled={busy || member.id === session.user.id} onClick={() => void action(async () => {
            await civicApi(`/staff/members/${member.id}`, { token, method: 'PUT', body: { display_name: member.display_name, role: member.role, active: !member.active } }); await load();
          }, 'Account access updated')}>{member.active ? 'Deactivate' : 'Activate'}</button></td></tr>)}</tbody></table></div>
          <div className={styles.twoColumns} style={{ marginTop: 24 }}><section><h3>Add a team member</h3><p className={styles.hint}>Members use one-time email links to sign in. Add the address they will use with Supabase Auth.</p><form className={styles.form} onSubmit={event => {
            event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
            void action(async () => { await civicApi('/staff/members', { token, method: 'POST', body: { display_name: data.get('display_name'), email: data.get('email'), role: data.get('role') } }); form.reset(); await load(); }, 'Team member created');
          }}><label>Name<input name="display_name" required maxLength={100} autoComplete="name" /></label><label>Email<input name="email" required type="email" /></label><label>Role<select name="role" required defaultValue="field">{Object.keys(roles).map(role => <option key={role}>{role}</option>)}</select></label><button className={styles.primary} disabled={busy}>Create member</button></form></section>
            <section><h3>Organization roles</h3><p className={styles.hint}>Field-only accounts see only their own assignments. Read allows all organization requests. Admin must retain manage and read.</p>
              <form className={styles.form} onSubmit={event => { event.preventDefault(); void action(async () => { await civicApi('/staff/roles', { token, method: 'PUT', body: { roles } }); await load(); }, 'Roles updated'); }}>
                {Object.entries(roles).map(([role, allowed]) => <fieldset key={role} className={styles.card}><legend>{role}</legend>
                  {['manage', 'read', 'assign', 'transition', 'publish', 'field'].map(permission => <label key={permission} className={styles.checkbox}>
                    <input type="checkbox" checked={allowed.includes(permission)} disabled={role === 'admin' && ['manage', 'read'].includes(permission)} onChange={event => setRoles(current => ({
                      ...current, [role]: event.target.checked ? [...allowed, permission] : allowed.filter(item => item !== permission),
                    }))} /> {permission}
                  </label>)}
                  {role !== 'admin' && <button type="button" className={styles.secondary} onClick={() => setRoles(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== role)))}>Remove role</button>}
                </fieldset>)}
                <button className={styles.primary} disabled={busy}>Save roles</button>
              </form>
              <form className={styles.form} onSubmit={event => {
                event.preventDefault();
                if (Object.hasOwn(roles, newRole)) { setError('This role already exists'); return; }
                setRoles(current => ({ ...current, [newRole]: [] })); setNewRole('');
              }}><label>New role key<input required pattern="[a-z_]{2,40}" maxLength={40} value={newRole} onChange={event => setNewRole(event.target.value)} placeholder="dispatcher" /></label><button className={styles.secondary}>Add role</button></form>
            </section></div>
        </>}
        {view === 'settings' && has('manage') && <OrganizationSettings portal={session.portal} busy={busy} onSave={(name, settings) => {
          const normalized = { ...settings };
          for (const key of ['locations', 'departments', 'services', 'categories'] as const) normalized[key] = settings[key].map(item => item.trim()).filter(Boolean);
          void action(async () => { await civicApi('/staff/settings', { token, method: 'PUT', body: { name, settings: normalized } }); await load(); }, 'Organization settings updated');
        }} />}
        </>}
      </section>
    </div>}
    <footer className={styles.footer}><strong>CivicOS</strong><span>{field ? 'Field workspace' : 'Staff operations'}</span><span>Powered by Codyza</span></footer>
  </main>;
}

function offlineStaffRecord(record: CivicRecord): CivicRecord {
  return {
    id: record.id, kind: record.kind, title: record.title, description: record.description,
    location: record.location, category: record.category, status: record.status, reference: record.reference,
    published: record.published, assigned_to: record.assigned_to, archived_at: record.archived_at,
    longitude: record.longitude, latitude: record.latitude, created_at: record.created_at, updated_at: record.updated_at,
  };
}
