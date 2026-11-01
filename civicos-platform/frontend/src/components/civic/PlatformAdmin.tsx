'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Session as SupabaseSession } from '@supabase/supabase-js';
import { civicApi } from '@/lib/civic';
import { getCivicSupabase, isCivicSupabaseConfigured } from '@/lib/supabase';
import styles from './civic.module.css';

type Organization = { id: string; slug: string; name: string; domain: string | null };

export default function PlatformAdmin() {
  const [token, setToken] = useState('');
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
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
        </form>}
      {notice && <p role="status" className={styles.success}>{notice}</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </section> : <section className={styles.body}>
      <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>PLATFORM OWNER</p><h2>Organization administration</h2></div></div>
      {error && <p role="alert" className={styles.error}>{error}</p>}
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
          </form>
        </section>
        <section>
          <h3>Organizations ({organizations.length})</h3>
          {!organizations.length ? <div className={styles.empty}><p>No organizations have been created yet.</p></div> :
            <div className={styles.fieldCards}>{organizations.map(organization => <article key={organization.id} className={styles.card}>
              <span className={styles.tag}>{organization.slug}</span>
              <h3>{organization.name}</h3>
              {organization.domain && <p>{organization.domain}</p>}
              <Link href={`/staff?org=${encodeURIComponent(organization.slug)}`}>Open staff sign-in</Link>
              <Link href={`/portal/${encodeURIComponent(organization.slug)}`}>Open public portal</Link>
            </article>)}</div>}
        </section>
      </div>
    </section>}
  </main>;
}
