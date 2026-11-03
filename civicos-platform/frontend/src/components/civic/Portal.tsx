'use client';
import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { civicApi, CivicRecord, Portal as PortalData, displayDate, readPublicPhoto } from '@/lib/civic';
import MapEmbed from './MapEmbed';
import styles from './civic.module.css';

const kinds = ['all', 'service', 'announcement', 'event', 'project', 'facility', 'document', 'emergency', 'infrastructure'];
const calendarMonths = Array.from({ length: 12 }, (_, month) => month);
type PublicCalendarRequest = { id: string; title: string; category: string | null; status: string; created_at: string; completed_at: string | null };
type PublicRequestDetail = PublicCalendarRequest & {
  description: string; location: string; longitude: number | null; latitude: number | null; updated_at: string;
  photos: string[]; history: { status: string; timestamp: string }[];
};
export default function Portal({ initialSlug = '' }: { initialSlug?: string }) {
  const [slug, setSlug] = useState(initialSlug);
  const [organizations, setOrganizations] = useState<{ name: string; slug: string }[]>([]);
  const [organizationsLoading, setOrganizationsLoading] = useState(true);
  const [organizationsError, setOrganizationsError] = useState('');
  const [organizationSearch, setOrganizationSearch] = useState('');
  const [organizationQuery, setOrganizationQuery] = useState('');
  const [portal, setPortal] = useState<PortalData | null>(null);
  const [content, setContent] = useState<CivicRecord[]>([]);
  const [calendarRequests, setCalendarRequests] = useState<PublicCalendarRequest[]>([]);
  const [publicRequestDetail, setPublicRequestDetail] = useState<PublicRequestDetail | null>(null);
  const [publicContentDetail, setPublicContentDetail] = useState<CivicRecord | null>(null);
  const [view, setView] = useState('overview');
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [kind, setKind] = useState('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [point, setPoint] = useState<[number, number] | null>(null);
  const [mapFocus, setMapFocus] = useState<{ title: string; point: [number, number] } | null>(null);
  const [submitted, setSubmitted] = useState('');
  const [anonymous, setAnonymous] = useState(true);
  async function load(nextSlug?: string, refresh = false) {
    setError(''); setRefreshNotice(''); setBusy(true);
    try {
      const org = nextSlug ? await civicApi<PortalData>(`/public/${encodeURIComponent(nextSlug)}`) :
        await civicApi<PortalData>(`/public/portal?domain=${encodeURIComponent(window.location.hostname)}`);
      const [records, requests] = await Promise.all([
        civicApi<CivicRecord[]>(`/public/${org.slug}/content`),
        civicApi<PublicCalendarRequest[]>(`/public/${org.slug}/requests/calendar`),
      ]);
      setPortal(org); setSlug(org.slug); setContent(records); setCalendarRequests(requests);
      if (refresh) {
        setRevision(value => value + 1);
        setRefreshNotice('Portal refreshed.');
      } else {
        setAnonymous(org.settings.anonymous);
        setSubmitted(''); setPublicRequestDetail(null); setPublicContentDetail(null); setPoint(null); setMapFocus(null);
      }
      document.documentElement.lang = org.settings.language;
      document.title = `${org.name} | CivicOS`;
    } catch (failure) {
      if (!refresh) setPortal(null);
      setError(failure instanceof Error ? failure.message : 'Could not load portal');
    }
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
      const files = data.getAll('photos').filter((value): value is File => value instanceof File && value.size > 0);
      if (files.length > 3) throw new Error('You can upload no more than three photos.');
      const photos = await Promise.all(files.map(readPublicPhoto));
      const longitude = data.get('longitude')?.toString();
      const latitude = data.get('latitude')?.toString();
      const response = await civicApi<{ reference: string }>(`/public/${portal!.slug}/requests`, {
        method: 'POST', body: {
          category: data.get('category'), description: data.get('description'), location: data.get('location'),
          longitude: longitude ? Number(longitude) : null, latitude: latitude ? Number(latitude) : null,
          anonymous, photos, contact: anonymous ? null : {
            name: data.get('name'), email: data.get('email'), phone: data.get('phone'),
          },
        },
      });
      setSubmitted(response.reference); setPoint(null); form.reset();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not submit request'); }
    finally { setBusy(false); }
  }
  async function selectPublicRequest(id: string) {
    setError('');
    setBusy(true);
    try {
      setPublicRequestDetail(await civicApi<PublicRequestDetail>(`/public/${portal!.slug}/requests/${id}`));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load public request');
    } finally { setBusy(false); }
  }
  const hasPoint = (item: CivicRecord) => item.longitude !== null && item.latitude !== null;
  function openOnMap(item: CivicRecord) {
    if (!hasPoint(item)) return;
    setMapFocus({ title: item.title, point: [item.longitude!, item.latitude!] });
    setPublicContentDetail(null); setError(''); setView('map');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const settings = portal?.settings;
  const hubGroups = content.filter(item => kind === 'all' || item.kind === kind).reduce<{ key: string; label: string; items: CivicRecord[] }[]>((groups, item) => {
    const date = new Date(item.created_at);
    const key = new Intl.DateTimeFormat('en-CA', { timeZone: settings?.timezone, year: 'numeric', month: '2-digit' }).format(date);
    let group = groups.find(current => current.key === key);
    if (!group) {
      group = { key, label: new Intl.DateTimeFormat(settings?.language, { timeZone: settings?.timezone, year: 'numeric', month: 'long' }).format(date), items: [] };
      groups.push(group);
    }
    group.items.push(item);
    return groups;
  }, []);
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
            <button type="button" className={styles.secondary} disabled={busy} onClick={() => void load(portal.slug, true)}>Refresh</button>
            </div>
          {refreshNotice && <p role="status">{refreshNotice}</p>}
        </div>
        <aside className={styles.heroAside}><span className={styles.pulse} /> Open, local, accountable<p>One platform for residents,<br />staff, and field teams.</p><strong>{settings?.departments.length} departments · {settings?.services.length} services</strong></aside>
      </section>
      <nav className={styles.tabs} aria-label="Portal sections">
        {['overview', 'map', 'calendar', 'report'].map(tab => <button key={tab} aria-current={view === tab ? 'page' : undefined} onClick={() => { setView(tab); setError(''); setMapFocus(null); }}>{({ overview: 'Community hub', map: 'Explore the map', calendar: 'Public requests', report: 'Report a problem' })[tab]}</button>)}
      </nav>
      <div className={styles.body}>
        {content.filter(item => item.kind === 'emergency').map(item => <aside key={item.id} className={styles.emergency}><strong>Emergency notice · {item.title}</strong><p>{item.description}</p></aside>)}
        {view === 'overview' && <>
          <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>WHAT'S HAPPENING</p><h2>Your community hub</h2></div>
            <label>Show<select value={kind} onChange={event => setKind(event.target.value)}>{kinds.map(type => <option key={type} value={type}>{type === 'all' ? 'All information' : type}</option>)}</select></label></div>
          <div className={styles.hubGroups}>{hubGroups.map(group => <section key={group.key}><h3>{group.label}</h3><div className={styles.cards}>{group.items.map(item => <div className={styles.hubItem} key={item.id}>
            <button type="button" className={styles.card} onClick={() => setPublicContentDetail(item)}>
              <span className={styles.tag}>{item.kind}</span><h3>{item.title}</h3><p>{item.description}</p>
              <small>Published {displayDate(item.created_at, portal.settings)}</small>
              {item.location && <small>{item.location}</small>}
              <span className={styles.openDetails}>Open details</span>
            </button>
            {hasPoint(item) && <button type="button" className={styles.secondary} aria-label={`View ${item.title} on the map`} onClick={() => openOnMap(item)}>View on map</button>}
          </div>)}</div></section>)}</div>
          {!content.length && <div className={styles.empty}><h3>Your community hub is ready.</h3><p>Published services, events, facilities and announcements will appear here.</p></div>}
          {!!calendarRequests.length && <section className={styles.publicTickets}><h3>Community work updates</h3><div className={styles.cards}>{calendarRequests.map(record => <button key={record.id} className={styles.card} onClick={() => void selectPublicRequest(record.id)}><span className={styles.tag}>{record.status}</span><strong>{record.title}</strong><small>{record.category || 'Community request'}</small>{record.completed_at && <small>Completed {displayDate(record.completed_at, portal.settings)}</small>}<span>Open ticket details</span></button>)}</div></section>}
          <section className={styles.contact}><h3>Here to help</h3><p>{settings?.contact || 'Contact your community staff through the service request form.'}</p>
            <div className={styles.inline}>{settings?.services.map(service => <span className={styles.tag} key={service}>{service}</span>)}</div></section>
        </>}
        {view === 'map' && <><div className={styles.sectionTitle}><div><p className={styles.eyebrow}>EXPLORE YOUR COMMUNITY</p><h2>Places, infrastructure & public work</h2></div></div>
          {mapFocus && <div className={styles.inline} role="status"><p className={styles.hint}>Showing <strong>{mapFocus.title}</strong> on the map.</p><button type="button" className={styles.secondary} onClick={() => setMapFocus(null)}>Show the whole community</button></div>}
          <p className={styles.hint}>This map is read-only by default. Use the zoom controls to inspect an area, or enable interaction to browse public locations and open a request.</p><MapEmbed portal={portal} revision={revision} locked center={mapFocus?.point} marker={mapFocus?.point} zoom={mapFocus ? 16 : undefined} onSelect={id => void selectPublicRequest(id)} />
          {error && <p role="alert" className={styles.error}>{error}</p>}
          <section className={styles.publicTickets}><h3>Public request tickets</h3>{!calendarRequests.length ? <p className={styles.hint}>There are no public request tickets yet.</p> :
            <div className={styles.cards}>{calendarRequests.map(record => <button key={record.id} className={styles.card} onClick={() => void selectPublicRequest(record.id)}><span className={styles.tag}>{record.status}</span><strong>{record.title}</strong><small>{record.category || 'Community request'}</small><span>View public ticket details</span></button>)}</div>}
          </section></>}
        {view === 'calendar' && (() => {
          const monthStart = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
          const gridStart = new Date(monthStart);
          gridStart.setDate(1 - ((monthStart.getDay() + 6) % 7));
          const days = Array.from({ length: 42 }, (_, index) => {
            const date = new Date(gridStart);
            date.setDate(gridStart.getDate() + index);
            return date;
          });
          const dateKey = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: portal.settings.timezone }).format(date);
          // Calendar cells are local dates; calendar_date is date-only, so compare without a timezone conversion.
          const cellKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          const scheduled = content.filter(item => item.calendar_date);
          const currentYear = new Date().getFullYear();
          const calendarYears = Array.from({ length: 21 }, (_, index) => currentYear - 10 + index);
          if (!calendarYears.includes(calendarMonth.getFullYear())) calendarYears.push(calendarMonth.getFullYear());
          calendarYears.sort((left, right) => left - right);
          return <section><div className={styles.sectionTitle}><div><p className={styles.eyebrow}>PUBLIC WORK IN PROGRESS</p><h2>Public request calendar</h2></div></div>
            <p className={styles.hint}>Only requests explicitly approved for public display and dated community information appear here.</p>
            <div className={styles.calendarControls}><button className={styles.secondary} onClick={() => setCalendarMonth(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))}>Previous month</button>
              <label>Month<select aria-label="Calendar month" value={calendarMonth.getMonth()} onChange={event => setCalendarMonth(current => new Date(current.getFullYear(), Number(event.target.value), 1))}>{calendarMonths.map(month => <option key={month} value={month}>{new Intl.DateTimeFormat(portal.settings.language, { month: 'long' }).format(new Date(2000, month, 1))}</option>)}</select></label>
              <label>Year<select aria-label="Calendar year" value={calendarMonth.getFullYear()} onChange={event => setCalendarMonth(current => new Date(Number(event.target.value), current.getMonth(), 1))}>{calendarYears.map(year => <option key={year} value={year}>{year}</option>)}</select></label>
              <button className={styles.secondary} onClick={() => setCalendarMonth(current => new Date(current.getFullYear(), current.getMonth() + 1, 1))}>Next month</button></div>
            <div className={styles.calendar} role="grid" aria-label="Public request calendar">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => <strong key={day}>{day}</strong>)}{days.map(date => <section key={date.toISOString()} className={date.getMonth() === calendarMonth.getMonth() ? styles.calendarDay : `${styles.calendarDay} ${styles.calendarMuted}`}><time dateTime={date.toISOString().slice(0, 10)}>{date.getDate()}</time>{scheduled.filter(item => item.calendar_date === cellKey(date)).map(item => <button key={item.id} className={styles.calendarInformation} aria-label={`${item.title} (${item.kind})`} onClick={() => setPublicContentDetail(item)}><strong>{item.title}</strong><small>{item.kind}{item.location ? ` · ${item.location}` : ''}</small></button>)}{calendarRequests.filter(record => dateKey(new Date(record.created_at)) === dateKey(date)).map(record => <button key={record.id} onClick={() => void selectPublicRequest(record.id)}><strong>{record.title}</strong><small>{record.status}{record.category ? ` · ${record.category}` : ''}{record.completed_at ? ` · Completed ${displayDate(record.completed_at, portal.settings)}` : ''}</small></button>)}</section>)}</div>
          </section>;
        })()}
        {view === 'report' && <div className={styles.twoColumns}><section><p className={styles.eyebrow}>LET'S MAKE IT BETTER</p><h2>Report a community problem</h2><p className={styles.hint}>For immediate danger, contact local emergency services. This form is not monitored as an emergency line.</p>
          {submitted && <div role="status" className={styles.success}><strong>Request received.</strong><p>Save this private tracking reference for your records.</p><code>{submitted}</code></div>}
          <form onSubmit={report} className={styles.form}>
            <label>Category<select name="category" required>{settings?.categories.map(category => <option key={category}>{category}</option>)}</select></label>
            <label>What happened?<textarea name="description" rows={4} required maxLength={5000} placeholder="Describe the issue and anything our team should know." /></label>
            <label>Location<input name="location" required maxLength={500} placeholder="Street, landmark, or facility" /></label>
            <div className={styles.inline}><label>Longitude<input name="longitude" type="number" step="any" min={-180} max={180} value={point?.[0] ?? ''} onChange={event => setPoint([Number(event.target.value), point?.[1] ?? 0])} /></label>
              <label>Latitude<input name="latitude" type="number" step="any" min={-90} max={90} value={point?.[1] ?? ''} onChange={event => setPoint([point?.[0] ?? 0, Number(event.target.value)])} /></label></div>
            <label>Photos (optional, up to 3; 5 MB each)<input name="photos" type="file" accept="image/png,image/jpeg,image/webp" multiple /></label>
            <p className={styles.hint}>Your photos will be visible to everyone once the request is reviewed. Do not include private or sensitive information. Photos over 512 KB are compressed to JPEG before upload.</p>
            {settings?.anonymous && <label className={styles.checkbox}><input type="checkbox" checked={anonymous} onChange={event => setAnonymous(event.target.checked)} /> Report anonymously</label>}
            {!anonymous && <><label>Your name<input name="name" required maxLength={100} autoComplete="name" /></label><label>Email<input name="email" type="email" required maxLength={254} autoComplete="email" /></label><label>Phone (optional)<input name="phone" maxLength={50} type="tel" autoComplete="tel" /></label></>}
            <button disabled={busy} className={styles.primary}>{busy ? 'Submitting…' : 'Submit request'}</button>
            {error && <p role="alert" className={styles.error}>{error}</p>}
          </form></section><aside><h3>Pin the location</h3><p className={styles.hint}>Click on the map to add coordinates. Contact details are never published.</p><MapEmbed portal={portal} onPoint={setPoint} /></aside></div>}
      </div>
      {publicRequestDetail && <div className={styles.modalBackdrop} role="presentation">
        <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="public-ticket-title">
          <div className={styles.sectionTitle}><div><span className={styles.tag}>{publicRequestDetail.status}</span><h2 id="public-ticket-title">{publicRequestDetail.title}</h2></div><button className={styles.secondary} onClick={() => setPublicRequestDetail(null)}>Close</button></div>
          <div className={styles.ticketModalLayout}><div><p>{publicRequestDetail.category || 'Community request'}</p>{publicRequestDetail.description && <p>{publicRequestDetail.description}</p>}<p>Reported {displayDate(publicRequestDetail.created_at, portal.settings)}</p>{publicRequestDetail.completed_at && <p>Completed {displayDate(publicRequestDetail.completed_at, portal.settings)}</p>}<p>Updated {displayDate(publicRequestDetail.updated_at, portal.settings)}</p>
            {publicRequestDetail.photos.map((photo, index) => <img key={index} className={styles.ticketPhoto} src={photo} alt={`Ticket photo ${index + 1} for ${publicRequestDetail.title}`} />)}
            <h3>Public status updates</h3><ol className={styles.timeline}>{publicRequestDetail.history.map((event, index) => <li key={index}><strong>{event.status}</strong><small>{displayDate(event.timestamp, portal.settings)}</small></li>)}</ol></div>
            <aside><h3>Public location</h3><p>{publicRequestDetail.location || 'No location description was provided.'}</p>{publicRequestDetail.longitude !== null && publicRequestDetail.latitude !== null ?
              <><p className={styles.hint}>Pinned coordinates: {publicRequestDetail.latitude}, {publicRequestDetail.longitude}</p><MapEmbed portal={portal} center={[publicRequestDetail.longitude, publicRequestDetail.latitude]} marker={[publicRequestDetail.longitude, publicRequestDetail.latitude]} zoom={16} focused locked /></> :
              <p className={styles.hint}>A map location was not provided for this ticket.</p>}</aside></div>
        </section>
      </div>}
      {publicContentDetail && <div className={styles.modalBackdrop} role="presentation">
        <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="public-content-title">
          <div className={styles.sectionTitle}><div><span className={styles.tag}>{publicContentDetail.kind}</span><h2 id="public-content-title">{publicContentDetail.title}</h2></div><button className={styles.secondary} onClick={() => setPublicContentDetail(null)}>Close</button></div>
          <div className={styles.ticketModalLayout}><div><p>{publicContentDetail.description}</p><p>Published {displayDate(publicContentDetail.created_at, portal.settings)}</p>{publicContentDetail.calendar_date && <p>Calendar date: {new Intl.DateTimeFormat(portal.settings.language, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${publicContentDetail.calendar_date}T00:00:00Z`))}</p>}{publicContentDetail.location && <p>Location: {publicContentDetail.location}</p>}
            <div className={styles.inline}>{publicContentDetail.url && <a className={styles.primary} href={publicContentDetail.url} target="_blank" rel="noopener noreferrer">Open document or information ↗</a>}
              {hasPoint(publicContentDetail) && <button type="button" className={styles.secondary} onClick={() => openOnMap(publicContentDetail)}>Open in community map</button>}</div></div>
            <aside><h3>Location</h3>{publicContentDetail.longitude !== null && publicContentDetail.latitude !== null ?
              <MapEmbed portal={portal} center={[publicContentDetail.longitude, publicContentDetail.latitude]} zoom={16} /> :
              <p className={styles.hint}>A map location was not provided for this information.</p>}</aside></div>
        </section>
      </div>}
      {error && view !== 'report' && view !== 'map' && <p role="alert" className={styles.error}>{error}</p>}
    </>}
    <footer className={styles.footer}><strong>CivicOS</strong><span>Open infrastructure for everyday community life.</span><span>Public portal · No account required</span><span>Powered by Codyza</span></footer>
  </main>;
}
