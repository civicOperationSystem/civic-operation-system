'use client';
import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { civicApi, CivicRecord, Portal as PortalData, Tracking, displayDate, readPhoto } from '@/lib/civic';
import MapEmbed from './MapEmbed';
import styles from './civic.module.css';

const kinds = ['all', 'service', 'announcement', 'event', 'project', 'facility', 'document', 'emergency', 'infrastructure'];
export default function Portal({ initialSlug = '' }: { initialSlug?: string }) {
  const [slug, setSlug] = useState(initialSlug);
  const [organizations, setOrganizations] = useState<{ name: string; slug: string }[]>([]);
  const [organizationsLoading, setOrganizationsLoading] = useState(true);
  const [organizationsError, setOrganizationsError] = useState('');
  const [organizationSearch, setOrganizationSearch] = useState('');
  const [organizationQuery, setOrganizationQuery] = useState('');
  const [portal, setPortal] = useState<PortalData | null>(null);
  const [content, setContent] = useState<CivicRecord[]>([]);
  const [view, setView] = useState('overview');
  const [kind, setKind] = useState('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [point, setPoint] = useState<[number, number] | null>(null);
  const [reference, setReference] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [tracked, setTracked] = useState<Tracking | null>(null);
  const [anonymous, setAnonymous] = useState(true);
  async function load(nextSlug?: string) {
    setError(''); setBusy(true);
    try {
      const org = nextSlug ? await civicApi<PortalData>(`/public/${encodeURIComponent(nextSlug)}`) :
        await civicApi<PortalData>(`/public/portal?domain=${encodeURIComponent(window.location.hostname)}`);
      const records = await civicApi<CivicRecord[]>(`/public/${org.slug}/content`);
      setPortal(org); setSlug(org.slug); setContent(records); setAnonymous(org.settings.anonymous);
      setSubmitted(''); setTracked(null); setPoint(null);
      document.documentElement.lang = org.settings.language;
      document.title = `${org.name} | CivicOS`;
    } catch (failure) { setPortal(null); setError(failure instanceof Error ? failure.message : 'Could not load portal'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(initialSlug || new URLSearchParams(window.location.search).get('org') || undefined); }, [initialSlug]);
  useEffect(() => {
    const abort = new AbortController();
    void civicApi<{ name: string; slug: string }[]>('/public/organizations/list', { signal: abort.signal })
      .then(items => {
        if (!Array.isArray(items) || items.some(item => !item || typeof item.name !== 'string' || typeof item.slug !== 'string')) {
          throw new Error('The organization directory returned invalid data. Check the backend deployment.');
        }
        if (!abort.signal.aborted) setOrganizations(items);
      })
      .catch(failure => {
        if (!abort.signal.aborted) setOrganizationsError(failure instanceof Error ? failure.message : 'Could not load organizations');
      })
      .finally(() => { if (!abort.signal.aborted) setOrganizationsLoading(false); });
    return () => abort.abort();
  }, []);
  async function report(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const file = data.get('photo');
      const photo = file instanceof File && file.size ? await readPhoto(file) : null;
      const longitude = data.get('longitude')?.toString();
      const latitude = data.get('latitude')?.toString();
      const response = await civicApi<{ reference: string }>(`/public/${portal!.slug}/requests`, {
        method: 'POST', body: {
          category: data.get('category'), description: data.get('description'), location: data.get('location'),
          longitude: longitude ? Number(longitude) : null, latitude: latitude ? Number(latitude) : null,
          anonymous, photo, contact: anonymous ? null : {
            name: data.get('name'), email: data.get('email'), phone: data.get('phone'),
          },
        },
      });
      setSubmitted(response.reference); setReference(response.reference); setPoint(null); form.reset();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not submit request'); }
    finally { setBusy(false); }
  }
  async function track(event: FormEvent) {
    event.preventDefault(); setError(''); setTracked(null); setBusy(true);
    try { setTracked(await civicApi<Tracking>(`/public/${portal!.slug}/track`, { method: 'POST', body: { reference: reference.trim() } })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not track request'); }
    finally { setBusy(false); }
  }
  const settings = portal?.settings;
  const visibleOrganizations = organizations.filter(organization =>
    `${organization.name} /portal/${organization.slug}`.toLowerCase().includes(organizationQuery.trim().toLowerCase()));
  return <main className={styles.shell} style={{ '--civic-accent': settings?.color || '#0d9488' } as React.CSSProperties}>
    <header className={styles.header}>
      <Link href="/" className={styles.brand}>C<span>O</span> <strong>CivicOS</strong></Link>
      <div className={styles.headerLinks}>{!portal && <Link href="/platform">Platform owner</Link>}<Link href={`/staff?org=${encodeURIComponent(portal?.slug || slug)}`}>Staff sign in</Link><Link href={`/field?org=${encodeURIComponent(portal?.slug || slug)}`}>Field workspace</Link></div>
    </header>
    {!portal ? <section className={styles.welcome}>
      <p className={styles.eyebrow}>ONE COMMUNITY. ONE CONNECTED PLATFORM.</p>
      <h1>Everyday services.<br />A stronger community.</h1>
      <p>Find local information, report a problem, and follow the work that matters to your community.</p>
      <form onSubmit={event => { event.preventDefault(); setOrganizationQuery(organizationSearch); }} className={styles.inline} role="search" aria-label="Find an organization">
        <label>Organization name or workspace address<input type="search" list="organization-suggestions" autoComplete="off" value={organizationSearch} onChange={event => { setOrganizationSearch(event.target.value); setOrganizationQuery(event.target.value); }} placeholder="Organization name or /portal/village-b" /></label>
        <datalist id="organization-suggestions">
          {organizations.map(organization => <option key={organization.slug} value={organization.name} label={`/portal/${organization.slug}`} />)}
        </datalist>
        <button disabled={organizationsLoading || !!organizationsError} className={styles.primary}>Search</button>
      </form>
      {organizationsError && <p role="alert" className={styles.error}>{organizationsError}</p>}
      {organizationsLoading && <p role="status">Loading organizations…</p>}
      {!organizationsLoading && !organizationsError && <section className={styles.directory} aria-label="Available organizations">
        <h2>Available organizations</h2>
        {!organizations.length ? <p role="status">No organizations are available yet. A platform owner can create one from the platform console.</p> :
          !visibleOrganizations.length ? <p role="status">No organizations match your search.</p> :
          <div className={styles.organizationCards}>{visibleOrganizations.map(organization => <article key={organization.slug} className={styles.card}>
            <span className={styles.tag}>Public portal</span>
            <h3>{organization.name}</h3>
            <p className={styles.workspaceAddress}>/portal/{organization.slug}</p>
            <Link href={`/portal/${encodeURIComponent(organization.slug)}`} className={styles.secondary} aria-label={`Open ${organization.name} portal`}>Open portal</Link>
          </article>)}</div>}
      </section>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </section> : <>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>YOUR COMMUNITY, CONNECTED</p>
          <div className={styles.organization}>{settings?.logo && <img src={settings.logo} alt="" width={48} height={48} />}<h1>{portal.name}</h1></div>
          <p>Local information and everyday services, all in one place.<br />No account needed. Everyone welcome.</p>
          <div className={styles.inline}><button className={styles.primary} onClick={() => setView('report')}>Report a problem <span aria-hidden>↗</span></button>
            <button className={styles.secondary} onClick={() => setView('track')}>Track a request</button></div>
        </div>
        <aside className={styles.heroAside}><span className={styles.pulse} /> Open, local, accountable<p>One platform for residents,<br />staff, and field teams.</p><strong>{settings?.departments.length} departments · {settings?.services.length} services</strong></aside>
      </section>
      <nav className={styles.tabs} aria-label="Portal sections">
        {['overview', 'map', 'report', 'track'].map(tab => <button key={tab} aria-current={view === tab ? 'page' : undefined} onClick={() => { setView(tab); setError(''); }}>{({ overview: 'Community hub', map: 'Explore the map', report: 'Report a problem', track: 'Track a request' })[tab]}</button>)}
      </nav>
      <div className={styles.body}>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {content.filter(item => item.kind === 'emergency').map(item => <aside key={item.id} className={styles.emergency}><strong>Emergency notice · {item.title}</strong><p>{item.description}</p></aside>)}
        {view === 'overview' && <>
          <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>WHAT'S HAPPENING</p><h2>Your community hub</h2></div>
            <label>Show<select value={kind} onChange={event => setKind(event.target.value)}>{kinds.map(type => <option key={type} value={type}>{type === 'all' ? 'All information' : type}</option>)}</select></label></div>
          <div className={styles.cards}>{content.filter(item => kind === 'all' || item.kind === kind).map(item => <article className={styles.card} key={item.id}>
            <span className={styles.tag}>{item.kind}</span><h3>{item.title}</h3><p>{item.description}</p>
            {item.location && <small>{item.location}</small>}
            {item.url && <a href={item.url} target="_blank" rel="noopener noreferrer">Open document or information ↗</a>}
          </article>)}</div>
          {!content.length && <div className={styles.empty}><h3>Your community hub is ready.</h3><p>Published services, events, facilities and announcements will appear here.</p></div>}
          <section className={styles.contact}><h3>Here to help</h3><p>{settings?.contact || 'Contact your community staff through the service request form.'}</p>
            <div className={styles.inline}>{settings?.services.map(service => <span className={styles.tag} key={service}>{service}</span>)}</div></section>
        </>}
        {view === 'map' && <><div className={styles.sectionTitle}><div><p className={styles.eyebrow}>EXPLORE YOUR COMMUNITY</p><h2>Places, infrastructure & public work</h2></div></div>
          <p className={styles.hint}>Only information explicitly approved for public display appears on this map.</p><MapEmbed portal={portal} /></>}
        {view === 'report' && <div className={styles.twoColumns}><section><p className={styles.eyebrow}>LET'S MAKE IT BETTER</p><h2>Report a community problem</h2><p className={styles.hint}>For immediate danger, contact local emergency services. This form is not monitored as an emergency line.</p>
          {submitted && <div role="status" className={styles.success}><strong>Request received.</strong><p>Save this private tracking reference. Anyone with it can check the public status.</p><code>{submitted}</code><button className={styles.secondary} onClick={() => setView('track')}>Track this request</button></div>}
          <form onSubmit={report} className={styles.form}>
            <label>Category<select name="category" required>{settings?.categories.map(category => <option key={category}>{category}</option>)}</select></label>
            <label>What happened?<textarea name="description" rows={4} required maxLength={5000} placeholder="Describe the issue and anything our team should know." /></label>
            <label>Location<input name="location" required maxLength={500} placeholder="Street, landmark, or facility" /></label>
            <div className={styles.inline}><label>Longitude<input name="longitude" type="number" step="any" min={-180} max={180} value={point?.[0] ?? ''} onChange={event => setPoint([Number(event.target.value), point?.[1] ?? 0])} /></label>
              <label>Latitude<input name="latitude" type="number" step="any" min={-90} max={90} value={point?.[1] ?? ''} onChange={event => setPoint([point?.[0] ?? 0, Number(event.target.value)])} /></label></div>
            <label>Photo (optional, up to 2 MB)<input name="photo" type="file" accept="image/png,image/jpeg,image/webp" /></label>
            {settings?.anonymous && <label className={styles.checkbox}><input type="checkbox" checked={anonymous} onChange={event => setAnonymous(event.target.checked)} /> Report anonymously</label>}
            {!anonymous && <><label>Your name<input name="name" required maxLength={100} autoComplete="name" /></label><label>Email<input name="email" type="email" required maxLength={254} autoComplete="email" /></label><label>Phone (optional)<input name="phone" maxLength={50} type="tel" autoComplete="tel" /></label></>}
            <button disabled={busy} className={styles.primary}>{busy ? 'Submitting…' : 'Submit request'}</button>
          </form></section><aside><h3>Pin the location</h3><p className={styles.hint}>Click on the map to add coordinates. Contact details and photos are never published.</p><MapEmbed portal={portal} onPoint={setPoint} /></aside></div>}
        {view === 'track' && <section className={styles.narrow}><p className={styles.eyebrow}>FOLLOW THE PROGRESS</p><h2>Track your request</h2><p className={styles.hint}>Use the private reference you received when submitting your report.</p>
          <form onSubmit={track} className={styles.form}><label>Tracking reference<input value={reference} onChange={event => setReference(event.target.value)} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" required maxLength={39} autoComplete="off" /></label><button disabled={busy} className={styles.primary}>Check status</button></form>
          {tracked && <article className={styles.card}><span className={styles.tag}>{tracked.status}</span><h3>{tracked.title}</h3><p>{tracked.category}</p><p>Reported {displayDate(tracked.reported, portal.settings)}</p><p>Updated {displayDate(tracked.updated, portal.settings)}</p>
            <ol className={styles.timeline}>{tracked.history.map((event, index) => <li key={index}><strong>{event.status}</strong><small>{displayDate(event.timestamp, portal.settings)}</small></li>)}</ol></article>}
        </section>}
      </div>
    </>}
    <footer className={styles.footer}><strong>CivicOS</strong><span>Open infrastructure for everyday community life.</span><span>Public portal · No account required</span></footer>
  </main>;
}
