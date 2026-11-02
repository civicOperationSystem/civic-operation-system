'use client';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Session as SupabaseSession } from '@supabase/supabase-js';
import { civicApi, CivicRecord, Session, Member, RequestDetail, Portal, displayDate, fieldCanEnter } from '@/lib/civic';
import { getCivicSupabase, isCivicSupabaseConfigured } from '@/lib/supabase';
import MapEmbed from './MapEmbed';
import OrganizationSettings from './OrganizationSettings';
import ChatPanel from './ChatPanel';
import styles from './civic.module.css';

export default function Workspace({ field = false }: { field?: boolean }) {
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
  const [worker, setWorker] = useState('');
  const [roles, setRoles] = useState<Record<string, string[]>>({});
  const [newRole, setNewRole] = useState('');
  const [editingContent, setEditingContent] = useState<CivicRecord | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const exchangedToken = useRef('');
  useEffect(() => {
    const organization = new URLSearchParams(window.location.search).get('org') || '';
    setSlug(organization);
    setLinkedOrganization(!!organization);
  }, []);
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
    setRevision(value => value + 1);
  }, [page, token]);
  useEffect(() => {
    if (!slug || !isCivicSupabaseConfigured()) return;
    let active = true;
    const supabase = getCivicSupabase();
    const exchange = async (authSession: SupabaseSession) => {
      const exchangeKey = `${slug}:${authSession.access_token}`;
      if (!active || exchangedToken.current === exchangeKey) return;
      exchangedToken.current = exchangeKey;
      setBusy(true); setError('');
      try {
        const response = await civicApi<{ token: string }>('/login', {
          method: 'POST', body: { slug, access_token: authSession.access_token },
        });
        await load(response.token, 1);
        if (active) { setToken(response.token); setPage(1); setNotice(''); }
      } catch (failure) {
        if (active) {
          setError(failure instanceof Error ? failure.message : 'Could not verify your organization access');
          setSession(null); setToken('');
        }
      } finally { if (active) setBusy(false); }
    };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, authSession) => {
      if (event === 'SIGNED_OUT') {
        exchangedToken.current = '';
        setToken(''); setSession(null); setRecords([]); setContent([]); setMembers([]); setDetail(null);
        setRoles({}); setEditingContent(null); setError(''); setNotice('');
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
    return () => { active = false; subscription.unsubscribe(); };
  }, [load, slug]);
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
      const result = await civicApi<RequestDetail>(`/staff/requests/${id}`, { token });
      setDetail(result); setWorker(result.assigned_to || ''); setNotes('');
    }, '');
  }
  async function transition(next: string) {
    if (!detail) return;
    await action(async () => {
      await civicApi(`/staff/requests/${detail.id}/transition`, { token, method: 'POST', body: { status: next, notes } });
      setDetail(await civicApi<RequestDetail>(`/staff/requests/${detail.id}`, { token }));
      setNotes(''); await load();
    }, 'Workflow updated. The transition has been recorded.');
  }
  const visible = records.filter(record => (!field || record.assigned_to === session?.user.id) &&
    (!status || record.status === status) &&
    `${record.title} ${record.location} ${record.reference}`.toLowerCase().includes(search.toLowerCase()));
  const stateLabel = (key: string | null) => session?.portal.settings.states.find(state => state.key === key)?.label || key || 'Submitted';
  const memberLabel = (id: string | null) => id ? members.find(member => member.id === id)?.email || id : 'Resident / unassigned';
  const nextStates = session?.portal.settings.states.find(state => state.key === detail?.status)?.next || [];
  async function logout() {
    try {
      if (isCivicSupabaseConfigured()) {
        const { error: authError } = await getCivicSupabase().auth.signOut();
        if (authError) throw authError;
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not sign out');
      return;
    }
    setToken(''); setSession(null); setRecords([]); setContent([]); setMembers([]); setDetail(null);
    setError(''); setNotice(''); setRoles({}); setEditingContent(null); exchangedToken.current = '';
  }
  return <main className={styles.shell} style={{ '--civic-accent': session?.portal.settings.color || '#0d9488' } as React.CSSProperties}>
    <header className={styles.header}><Link className={styles.brand} href="/">C<span>O</span> <strong>CivicOS</strong></Link>
      <div className={styles.headerLinks}><Link href={`/portal/${slug}`}>Public portal ↗</Link>{session && <button onClick={() => void logout()}>Sign out</button>}</div></header>
    {!session ? <section className={styles.login}><p className={styles.eyebrow}>{field ? 'FIELD WORKSPACE' : 'STAFF OPERATIONS'}</p><h1>{field ? 'Good work starts here.' : 'Your community at work.'}</h1><p className={styles.hint}>Sign in to your organization's secure workspace. Access is controlled by your role.</p>
      <form onSubmit={login} className={styles.form}><label>Organization{linkedOrganization ?
        <input readOnly value={organizationName || slug} /> :
        <input required value={slug} onChange={event => setSlug(event.target.value)} pattern="[a-z0-9\-]{3,60}" />}</label><label>Email<input name="email" required type="email" autoComplete="email" /></label>
        <button disabled={busy} className={styles.primary}>{busy ? 'Sending link…' : 'Email me a sign-in link'}</button></form>
      <p className={styles.hint}>Sign-in links are one-time use. Sign out when you finish, especially on shared devices.</p>
      {notice && <p role="status" className={styles.success}>{notice}</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </section> : <div className={styles.workspace}>
      <aside className={styles.sidebar}><h3>{session.portal.name}</h3><p>{session.user.email}<br />{session.user.role} · {field ? 'Field workspace' : 'Operations'}</p>
        {(field ? ['requests', 'map'] : [
          ...(has('read') || has('field') ? ['requests', 'map'] : []),
          ...(has('chat') ? ['chat'] : []), ...(has('publish') ? ['content'] : []), ...(has('manage') ? ['members', 'settings'] : []),
        ]).map(tab => <button key={tab} aria-current={tab === view ? 'page' : undefined} onClick={() => { setView(tab); setDetail(null); setError(''); setNotice(''); }}>
          {({ requests: field ? 'My assignments' : 'Service requests', map: 'Community map', chat: 'Staff chat', content: 'Public information', members: 'People & roles', settings: 'Organization settings' })[tab]}
        </button>)}
      </aside>
      <section className={styles.main}>
        {view === 'chat' && !field && has('chat') ? <><div className={styles.sectionTitle}><div><p className={styles.eyebrow}>TEAM COMMUNICATION</p><h2>Staff chat</h2></div></div><ChatPanel token={token} session={session} /></> : <><div className={styles.sectionTitle}><div><p className={styles.eyebrow}>{field ? 'OUT IN THE COMMUNITY' : 'OPERATIONS OVERVIEW'}</p><h2>{({ requests: field ? 'Your work, in one place' : 'Service requests', map: 'Operational map', content: 'Public information', members: 'People & access', settings: 'Organization settings' })[view]}</h2></div>
          <button disabled={busy} className={styles.secondary} onClick={() => void action(() => load(), 'Workspace refreshed')}>Refresh</button></div>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {notice && <p role="status" className={styles.success}>{notice}</p>}
        {view === 'requests' && <>
          <div className={styles.stats}><div className={styles.stat}><span>Requests on this page</span><strong>{field ? records.filter(record => record.assigned_to === session.user.id).length : records.length}</strong></div>
            <div className={styles.stat}><span>In progress on this page</span><strong>{visible.filter(record => record.status === 'in_progress').length}</strong></div><div className={styles.stat}><span>Awaiting verification</span><strong>{visible.filter(record => record.status === 'completed').length}</strong></div></div>
          <div className={styles.inline}><label>Search this page<input placeholder="Category, location, reference…" value={search} onChange={event => setSearch(event.target.value)} /></label>
            <label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{session.portal.settings.states.map(state => <option key={state.key} value={state.key}>{state.label}</option>)}</select></label></div>
          <div style={{ marginTop: 20 }} className={field ? styles.fieldCards : styles.tableWrap}>
            {field ? visible.map(record => <button key={record.id} className={styles.card} style={{ textAlign: 'left' }} onClick={() => void selectRequest(record.id)}><span className={styles.tag}>{stateLabel(record.status)}</span><h3>{record.title}</h3><p>{record.location}</p><small>Updated {displayDate(record.updated_at, session.portal.settings)}</small></button>) :
              <table className={styles.table}><thead><tr><th>Request</th><th>Location</th><th>Status</th><th>Assigned to</th><th>Reported</th></tr></thead><tbody>{visible.map(record => <tr key={record.id}><td><button onClick={() => void selectRequest(record.id)}>{record.title}</button><small>{record.reference}</small></td><td>{record.location}</td><td><span className={styles.tag}>{stateLabel(record.status)}</span></td><td>{record.assigned_to ? memberLabel(record.assigned_to) : 'Unassigned'}</td><td>{displayDate(record.created_at, session.portal.settings)}</td></tr>)}</tbody></table>}
          </div>
          {!visible.length && <div className={styles.empty}><h3>No requests to show.</h3><p>{field ? 'Assigned work will appear here when your team dispatches it.' : 'Requests submitted through the public portal appear here.'}</p></div>}
          <div className={styles.inline} style={{ marginTop: 18 }}><button className={styles.secondary} disabled={busy || page === 1} onClick={() => void action(async () => { await load(token, page - 1); setPage(page - 1); }, '')}>Previous</button><span>Page {page}</span><button className={styles.secondary} disabled={busy || records.length < 100} onClick={() => void action(async () => { await load(token, page + 1); setPage(page + 1); }, '')}>Next</button></div>
        </>}
        {view === 'map' && <><p className={styles.hint}>Your permissions determine which requests and locations appear. Select a request marker to open its work record.</p><MapEmbed portal={session.portal} token={token} revision={revision} onSelect={id => void selectRequest(id)} /></>}
        {detail && ['requests', 'map'].includes(view) && <article className={`${styles.card} ${styles.detail}`}>
          <div className={styles.sectionTitle}><div><span className={styles.tag}>{stateLabel(detail.status)}</span><h3>{detail.title}</h3></div><button onClick={() => setDetail(null)} className={styles.secondary}>Close</button></div>
          <p>{detail.description}</p><p>{detail.location}</p><code>{detail.reference}</code>
          {detail.contact && <p>Private contact: {detail.contact.name} · {detail.contact.email} {detail.contact.phone}</p>}
          {detail.photo && <img src={detail.photo} alt="Resident-submitted issue photo" />}
          <h3>Work updates</h3><p className={styles.hint}>Notes and staff identities remain private. Residents see only the public status and update times.</p>
          <label>Internal notes<textarea rows={3} maxLength={5000} value={notes} onChange={event => setNotes(event.target.value)} /></label>
          {has('transition') && <div className={styles.inline}>{nextStates.filter(next => {
            const state = session.portal.settings.states.find(item => item.key === next);
            return (!field && has('read')) || (!!state && fieldCanEnter(state));
          }).map(next => <button key={next} disabled={busy} className={styles.primary} onClick={() => void transition(next)}>{field && next === 'in_progress' ? 'Start work' : field && next === 'completed' ? 'Complete work' : `Move to ${stateLabel(next)}`}</button>)}</div>}
          {has('assign') && !field && <div className={styles.form}><label>Assign a worker<select value={worker} onChange={event => setWorker(event.target.value)}><option value="">Choose a team member</option>{members.filter(member => member.active).map(member => <option key={member.id} value={member.id}>{member.email} · {member.role}</option>)}</select></label>
            <button disabled={busy || !worker} className={styles.secondary} onClick={() => void action(async () => {
              await civicApi(`/staff/requests/${detail.id}/assign`, { token, method: 'POST', body: { assigned_to: worker, notes } });
              setDetail(await civicApi<RequestDetail>(`/staff/requests/${detail.id}`, { token })); await load(); setNotes('');
            }, 'Assignment recorded')}>Save assignment</button></div>}
          {has('publish') && !field && <label className={styles.checkbox}><input type="checkbox" checked={detail.published} disabled={busy} onChange={event => {
            const published = event.target.checked;
            setDetail({ ...detail, published });
            void action(async () => {
              try { await civicApi(`/staff/requests/${detail.id}/visibility`, { token, method: 'POST', body: { published } }); }
              catch (failure) { setDetail(detail); throw failure; }
              setRevision(value => value + 1);
            }, 'Map visibility updated');
          }} /> Publish this request's coordinates and category on the public map</label>}
          <h3>Audit trail</h3><ol className={styles.timeline}>{detail.history.map(event => <li key={event.id}><strong>{stateLabel(event.previous_status)} → {stateLabel(event.new_status)}</strong><small>{memberLabel(event.actor)} · {displayDate(event.created_at, session.portal.settings)}</small>{event.assigned_to && <small>Assigned: {memberLabel(event.assigned_to)}</small>}<p>{event.notes}</p></li>)}</ol>
        </article>}
        {view === 'content' && has('publish') && <div className={styles.twoColumns}><section><h3>{editingContent ? 'Edit community information' : 'Publish community information'}</h3><form key={editingContent?.id || 'new'} className={styles.form} onSubmit={event => {
          event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
          void action(async () => {
            await civicApi(editingContent ? `/staff/content/${editingContent.id}` : '/staff/content', { token, method: editingContent ? 'PUT' : 'POST', body: {
              kind: data.get('kind'), title: data.get('title'), description: data.get('description'), location: data.get('location'),
              longitude: data.get('longitude') ? Number(data.get('longitude')) : null,
              latitude: data.get('latitude') ? Number(data.get('latitude')) : null,
              url: data.get('url'), published: data.get('published') === 'on',
            } }); form.reset(); setEditingContent(null); await load();
          }, 'Content saved');
        }}>
          <label>Type<select name="kind" defaultValue={editingContent?.kind || 'service'} disabled={!!editingContent}>{['service', 'announcement', 'event', 'project', 'facility', 'document', 'emergency', 'infrastructure'].map(kind => <option key={kind}>{kind}</option>)}</select></label>
          <label>Title<input name="title" required maxLength={150} defaultValue={editingContent?.title} /></label><label>Information<textarea name="description" rows={4} required maxLength={10000} defaultValue={editingContent?.description} /></label><label>Location<input name="location" maxLength={500} defaultValue={editingContent?.location} /></label>
          <div className={styles.inline}><label>Longitude<input name="longitude" type="number" min={-180} max={180} step="any" defaultValue={editingContent?.longitude ?? ''} /></label><label>Latitude<input name="latitude" type="number" min={-90} max={90} step="any" defaultValue={editingContent?.latitude ?? ''} /></label></div>
          <label>Document or information URL (HTTPS)<input name="url" type="url" defaultValue={editingContent?.url || ''} /></label><label className={styles.checkbox}><input name="published" type="checkbox" defaultChecked={editingContent?.published} /> Publish immediately</label><button className={styles.primary} disabled={busy}>Save information</button>
          {editingContent && <button type="button" className={styles.secondary} onClick={() => setEditingContent(null)}>Cancel editing</button>}
        </form></section><section><h3>Community information</h3><div className={styles.fieldCards}>{content.map(item => <article key={item.id} className={styles.card}><span className={styles.tag}>{item.kind} · {item.published ? 'Public' : 'Draft'}</span><h3>{item.title}</h3><p>{item.description}</p>
          <div className={styles.inline}><button className={styles.secondary} onClick={() => setEditingContent(item)}>Edit information</button><button disabled={busy} className={styles.secondary} onClick={() => void action(async () => { await civicApi(`/staff/content/${item.id}`, { token, method: 'PUT', body: { published: !item.published } }); await load(); }, 'Publication updated')}>{item.published ? 'Withdraw from portal' : 'Publish'}</button></div></article>)}</div></section></div>}
        {view === 'members' && has('manage') && <>
          <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Member</th><th>Role</th><th>Access</th></tr></thead><tbody>{members.map(member => <tr key={member.id}><td>{member.email}</td><td><select aria-label={`Role for ${member.email}`} value={member.role} disabled={busy || member.id === session.user.id} onChange={event => {
            const role = event.target.value;
            void action(async () => { await civicApi(`/staff/members/${member.id}`, { token, method: 'PUT', body: { role, active: member.active } }); await load(); }, 'Member role updated');
          }}>{Object.keys(roles).map(role => <option key={role}>{role}</option>)}</select></td><td><button disabled={busy || member.id === session.user.id} onClick={() => void action(async () => {
            await civicApi(`/staff/members/${member.id}`, { token, method: 'PUT', body: { role: member.role, active: !member.active } }); await load();
          }, 'Account access updated')}>{member.active ? 'Deactivate' : 'Activate'}</button></td></tr>)}</tbody></table></div>
          <div className={styles.twoColumns} style={{ marginTop: 24 }}><section><h3>Add a team member</h3><p className={styles.hint}>Members use one-time email links to sign in. Add the address they will use with Supabase Auth.</p><form className={styles.form} onSubmit={event => {
            event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
            void action(async () => { await civicApi('/staff/members', { token, method: 'POST', body: { email: data.get('email'), role: data.get('role') } }); form.reset(); await load(); }, 'Team member created');
          }}><label>Email<input name="email" required type="email" /></label><label>Role<select name="role" required defaultValue="field">{Object.keys(roles).map(role => <option key={role}>{role}</option>)}</select></label><button className={styles.primary} disabled={busy}>Create member</button></form></section>
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
  </main>;
}
