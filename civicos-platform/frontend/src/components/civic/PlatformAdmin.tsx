'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Session as SupabaseSession } from '@supabase/supabase-js';
import { civicApi, communityMapUrl } from '@/lib/civic';
import { getCivicSupabase, isCivicSupabaseConfigured } from '@/lib/supabase';
import styles from './civic.module.css';

type Administrator = { id: string; email: string; display_name: string; active: boolean };
type Organization = { id: string; slug: string; name: string; domain: string | null; archived_at: string | null; admins: Administrator[] };

export default function PlatformAdmin() {
  const [token, setToken] = useState('');
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reassignment, setReassignment] = useState<{ organization: Organization; administrator: Administrator } | null>(null);
  const exchangedToken = useRef('');

  useEffect(() => {
    if (!isCivicSupabaseConfigured()) return;
    let active = true;
    const supabase = getCivicSupabase();
    const exchange = async (authSession: SupabaseSession) => {
      if (!active || exchangedToken.current === authSession.access_token) return;
      exchangedToken.current = authSession.access_token;
      setBusy(true);
      setError('');
      try {
        const result = await civicApi<{ token: string }>('/platform/login', {
          method: 'POST', body: { access_token: authSession.access_token },
        });
        const items = await civicApi<Organization[]>('/platform/organizations', { token: result.token });
        if (active) {
          setToken(result.token);
          setOrganizations(items);
          setNotice('');
        }
      } catch (failure) {
        if (active) {
          setToken('');
          setOrganizations([]);
          setError(failure instanceof Error ? failure.message : 'Could not verify platform owner access');
        }
      } finally {
        if (active) setBusy(false);
      }
    };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, authSession) => {
      if (event === 'SIGNED_OUT') {
        exchangedToken.current = '';
        setToken('');
        setOrganizations([]);
        setError('');
        setNotice('');
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
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setBusy(true);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const { error: authError } = await getCivicSupabase().auth.signInWithOtp({
        email: String(data.get('email')).trim().toLowerCase(),
        options: { shouldCreateUser: true, emailRedirectTo: `${window.location.origin}/platform` },
      });
      if (authError) throw authError;
      setNotice('If this is the configured platform owner email, a one-time sign-in link has been sent.');
      form.reset();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send a sign-in link');
    } finally {
      setBusy(false);
    }
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const result = await civicApi<{ organization: Organization & { admin_email: string } }>('/platform/organizations', {
        token, method: 'POST', body: {
          name: data.get('name'), slug: data.get('slug'),
          admin_email: data.get('admin_email'), domain: data.get('domain'),
        },
      });
      setOrganizations(current => [...current, result.organization].sort((a, b) => a.name.localeCompare(b.name)));
      setNotice(`Organization created. ${result.organization.admin_email} can now request a Supabase sign-in link.`);
      form.reset();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not create organization');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      const { error: authError } = await getCivicSupabase().auth.signOut();
      if (authError) throw authError;
      setToken('');
      setOrganizations([]);
      setError('');
      setNotice('');
      exchangedToken.current = '';
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not sign out');
    } finally {
      setBusy(false);
    }
  }

  async function setOrganizationArchived(organization: Organization, archived: boolean) {
    const action = archived ? 'archive' : 'restore';
    if (!window.confirm(`${archived ? 'Archive' : 'Restore'} ${organization.name}?`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await civicApi<{ id: string; archived_at: string | null }>(`/platform/organizations/${organization.id}/archive`, {
        token, method: 'PUT', body: { archived },
      });
      setOrganizations(current => current.map(item => item.id === organization.id ? { ...item, archived_at: result.archived_at } : item));
      setNotice(`${organization.name} was ${action}d.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `Could not ${action} organization`);
    } finally {
      setBusy(false);
    }
  }

  async function removeOrganization(organization: Organization) {
    if (!window.confirm(`Permanently remove ${organization.name} and all of its data? This cannot be undone.`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await civicApi<{ removed: boolean }>(`/platform/organizations/${organization.id}`, { token, method: 'DELETE' });
      setOrganizations(current => current.filter(item => item.id !== organization.id));
      setNotice(`${organization.name} was permanently removed.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not remove organization');
    } finally {
      setBusy(false);
    }
  }

  async function setAdministratorAccess(organization: Organization, administrator: Administrator, active: boolean) {
    const action = active ? 'reactivate' : 'deactivate';
    if (!window.confirm(`${active ? 'Reactivate' : 'Deactivate'} ${administrator.display_name}?`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await civicApi<Administrator>(`/platform/organizations/${organization.id}/admins/${administrator.id}/access`, {
        token, method: 'PUT', body: { active },
      });
      setOrganizations(current => current.map(item => item.id === organization.id ? {
        ...item, admins: item.admins.map(member => member.id === updated.id ? updated : member),
      } : item));
      setNotice(`${administrator.display_name}'s access was ${action}d.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : `Could not ${action} administrator`);
    } finally {
      setBusy(false);
    }
  }

  async function reassignAdministrator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reassignment) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await civicApi<{ administrator: Administrator; previous: Administrator }>(
        `/platform/organizations/${reassignment.organization.id}/admins/${reassignment.administrator.id}/reassign`, {
          token, method: 'POST', body: { display_name: data.get('display_name'), email: data.get('email') },
        });
      setOrganizations(current => current.map(item => item.id === reassignment.organization.id ? {
        ...item,
        admins: [...item.admins.filter(member => member.id !== result.administrator.id && member.id !== result.previous.id), result.previous, result.administrator]
          .sort((left, right) => left.display_name.localeCompare(right.display_name)),
      } : item));
      setReassignment(null);
      setNotice(`${result.administrator.display_name} is now the bottom administrator. ${result.previous.display_name} was deactivated.`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not reassign administrator');
    } finally {
      setBusy(false);
    }
  }

  return <main className={styles.shell}>
    <header className={styles.header}>
      <Link className={styles.brand} href="/">C<span>O</span> <strong>CivicOS</strong></Link>
      <div className={styles.headerLinks}><Link href="/">Public site</Link>{token && <button onClick={() => void logout()} disabled={busy}>Sign out</button>}</div>
    </header>
    {!token ? <section className={styles.login}>
      <p className={styles.eyebrow}>PLATFORM OWNER</p>
      <h1>Organizations, connected.</h1>
      <p className={styles.hint}>Create organization workspaces and assign each its first administrator. Organization administrators manage their own staff and cannot administer other organizations.</p>
      {!isCivicSupabaseConfigured() ? <p role="alert" className={styles.error}>Supabase sign-in is not configured.</p> :
        <form onSubmit={login} className={styles.form}>
          <label>Platform owner email<input name="email" required type="email" autoComplete="email" /></label>
          <button disabled={busy} className={styles.primary}>{busy ? 'Sending link…' : 'Email me a sign-in link'}</button>
          {error && <p role="alert" className={styles.error}>{error}</p>}
        </form>}
      {notice && <p role="status" className={styles.success}>{notice}</p>}
    </section> : <section className={styles.body}>
      <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>PLATFORM OWNER</p><h2>Organization administration</h2></div></div>
      {notice && <p role="status" className={styles.success}>{notice}</p>}
      <div className={styles.twoColumns}>
        <section>
          <h3>Create an organization</h3>
          <p className={styles.hint}>The first administrator becomes that organization’s Bottom admin. They can add and manage its staff from People &amp; roles.</p>
          <form onSubmit={createOrganization} className={styles.form}>
            <label>Organization name<input name="name" required maxLength={120} /></label>
            <label>Organization slug<input name="slug" required maxLength={60} pattern="[a-z0-9\-]{3,60}" placeholder="village-b" /></label>
            <label>Bottom admin email<input name="admin_email" required type="email" maxLength={254} /></label>
            <label>Custom domain (optional)<input name="domain" maxLength={253} placeholder="community.example.org" /></label>
            <button disabled={busy} className={styles.primary}>Create organization</button>
            {error && <p role="alert" className={styles.error}>{error}</p>}
          </form>
        </section>
        <section>
          <h3>Organizations ({organizations.length})</h3>
          {!organizations.length ? <div className={styles.empty}><p>No organizations have been created yet.</p></div> :
            <div className={styles.fieldCards}>{organizations.map(organization => <article key={organization.id} className={styles.card}>
              <span className={styles.tag}>{organization.archived_at ? 'Archived' : organization.slug}</span>
              <h3>{organization.name}</h3>
              {organization.domain && <p>{organization.domain}</p>}
              <p className={styles.hint}>Bottom administrators</p>
              <ul className={styles.adminList}>{organization.admins.map(administrator => <li key={administrator.id}>
                <span><strong>{administrator.display_name}</strong><small>{administrator.email} · {administrator.active ? 'Active' : 'Deactivated'}</small></span>
                <button className={styles.secondary} disabled={busy} onClick={() => void setAdministratorAccess(organization, administrator, !administrator.active)}>
                  {administrator.active ? 'Deactivate' : 'Reactivate'}
                </button>
                <button className={styles.secondary} disabled={busy} onClick={() => setReassignment({ organization, administrator })}>Reassign</button>
              </li>)}</ul>
              {!organization.archived_at && <><Link href={`/staff?org=${encodeURIComponent(organization.slug)}`}>Open staff sign-in</Link>
              <Link href={`/portal/${encodeURIComponent(organization.slug)}`}>Open public portal</Link>
              <a href={communityMapUrl(organization.slug)}>Open community map</a></>}
              <div className={styles.inline}>
                <button className={styles.secondary} disabled={busy} onClick={() => void setOrganizationArchived(organization, !organization.archived_at)}>
                  {organization.archived_at ? 'Restore organization' : 'Archive organization'}
                </button>
                {organization.archived_at && <button className={styles.secondary} disabled={busy} onClick={() => void removeOrganization(organization)}>Remove permanently</button>}
              </div>
            </article>)}</div>}
        </section>
      </div>
    </section>}
    {reassignment && <div className={styles.modalBackdrop} role="presentation">
      <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="reassign-administrator-title">
        <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>BOTTOM ADMINISTRATOR</p><h2 id="reassign-administrator-title">Reassign administrator</h2></div><button className={styles.secondary} disabled={busy} onClick={() => setReassignment(null)}>Close</button></div>
        <p>Replace {reassignment.administrator.display_name} for {reassignment.organization.name}. The current administrator will be deactivated; their ticket history remains intact.</p>
        <form className={styles.form} onSubmit={reassignAdministrator}>
          <label>New administrator name<input name="display_name" required maxLength={100} autoComplete="name" /></label>
          <label>New administrator email<input name="email" required type="email" maxLength={254} autoComplete="email" /></label>
          <button className={styles.primary} disabled={busy}>Confirm reassignment</button>
        </form>
      </section>
    </div>}
    <footer className={styles.footer}><strong>CivicOS</strong><span>Platform administration</span><span>Powered by Codyza</span></footer>
  </main>;
}
