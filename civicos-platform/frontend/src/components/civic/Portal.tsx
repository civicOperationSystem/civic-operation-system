'use client';
import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { civicApi, CivicApiError, CivicRecord, Portal as PortalData, communityMapUrl, displayDate, readPublicPhoto } from '@/lib/civic';
import {
  readOrganizationDirectory, readPortalCache, readPortalCacheForDomain, saveOrganizationDirectory, savePortalSnapshot, savePublicRequestDetail,
  saveSubmittedPublicReport, updatePublicReport, type PendingPublicReport, type PublicCalendarRequest, type PublicReport, type PublicRequestDetail,
} from '@/lib/portal-offline';
import MapEmbed from './MapEmbed';
import { groupPortalContent, portalContentKinds, searchOrganizations } from './portal-view-model';
import usePublicReportSync from './usePublicReportSync';
import useOfflinePublicReports from './useOfflinePublicReports';
import OfflineReportSecurityDialog from './OfflineReportSecurityDialog';
import styles from './civic.module.css';

const calendarMonths = Array.from({ length: 12 }, (_, month) => month);
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
  const [online, setOnline] = useState(true);
  const [offlineSnapshot, setOfflineSnapshot] = useState(false); const [offlineSavedAt, setOfflineSavedAt] = useState('');
  const [pendingReports, setPendingReports] = useState<PendingPublicReport[]>([]);
  const [offlineShellError, setOfflineShellError] = useState('');
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
      setOfflineSnapshot(false);
      try {
        const saved = await savePortalSnapshot(org.slug, { portal: org, content: records, calendarRequests: requests });
        setPendingReports(saved.reports); setOfflineSavedAt(saved.savedAt);
      } catch (failure) {
        setError(`Portal loaded, but offline data could not be saved: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
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
      if (refresh) {
        setError(failure instanceof Error ? failure.message : 'Could not refresh portal');
        return;
      }
      try {
        const cached = nextSlug ? await readPortalCache(nextSlug) : await readPortalCacheForDomain(window.location.hostname);
        if (cached) {
          setPortal(cached.portal); setSlug(cached.portal.slug); setContent(cached.content);
          setCalendarRequests(cached.calendarRequests); setPendingReports(cached.reports);
          setOfflineSnapshot(true); setOfflineSavedAt(cached.savedAt); setAnonymous(cached.portal.settings.anonymous);
          document.documentElement.lang = cached.portal.settings.language;
          document.title = `${cached.portal.name} | CivicOS`;
          setError('');
        } else {
          if (!refresh) setPortal(null);
          const domainHasNoPortal = !nextSlug && failure instanceof CivicApiError &&
            failure.status === 404 && failure.message === 'No portal is configured for this domain';
          setError(domainHasNoPortal ? '' : failure instanceof Error ? failure.message : 'Could not load portal');
        }
      } catch (cacheFailure) {
        if (!refresh) setPortal(null);
        setError(cacheFailure instanceof Error ? cacheFailure.message : 'Could not read the saved portal');
      }
    }
    finally { setBusy(false); }
  }
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) { setOfflineShellError('Offline page caching requires a current browser over HTTPS.'); return; }
    let active = true;
    void navigator.serviceWorker.register('/field-sw.js', { scope: '/' })
      .then(registration => navigator.serviceWorker.ready.then(() => registration))
      .then(registration => {
        if (!active) return;
        if (registration.active) registration.active.postMessage({ type: 'CACHE_APP_SHELL', url: window.location.href });
      })
      .catch(failure => {
        if (active) setOfflineShellError(`Offline page caching failed: ${failure instanceof Error ? failure.message : String(failure)}`);
      });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    void load(initialSlug || params.get('org') || undefined);
  }, [initialSlug]);
  useEffect(() => {
    const abort = new AbortController();
    void civicApi<{ name: string; slug: string }[]>('/public/organizations/list', { signal: abort.signal })
      .then(async items => {
        if (!Array.isArray(items) || items.some(item => !item || typeof item.name !== 'string' || typeof item.slug !== 'string')) {
          throw new Error('The organization directory returned invalid data. Check the backend deployment.');
        }
        await saveOrganizationDirectory(items);
        if (!abort.signal.aborted) setOrganizations(items);
      })
      .catch(async failure => {
        if (abort.signal.aborted) return;
        try {
          const cached = await readOrganizationDirectory();
          if (cached) setOrganizations(cached);
          else setOrganizationsError(failure instanceof Error ? failure.message : 'Could not load organizations');
        } catch (cacheFailure) {
          setOrganizationsError(cacheFailure instanceof Error ? cacheFailure.message : 'Could not read the saved organization directory');
        }
      })
      .finally(() => { if (!abort.signal.aborted) setOrganizationsLoading(false); });
    return () => abort.abort();
  }, []);
  const reportSecurity = useOfflinePublicReports({ slug: portal?.slug, setPendingReports });
  const syncReports = usePublicReportSync(portal?.slug, online, setPendingReports, setSubmitted, setError);
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
      const report: PublicReport = {
        category: String(data.get('category')), description: String(data.get('description')), location: String(data.get('location')),
        longitude: longitude ? Number(longitude) : null, latitude: latitude ? Number(latitude) : null,
        anonymous, photos, contact: anonymous ? null : {
          name: String(data.get('name')), email: String(data.get('email')), phone: String(data.get('phone') || ''),
        },
      };
      const operationId = crypto.randomUUID();
      if (navigator.onLine) {
        let response: { reference: string };
        try {
          response = await civicApi<{ reference: string }>(`/public/${portal!.slug}/requests`, {
            method: 'POST', body: { ...report, client_operation_id: operationId },
          });
        } catch (failure) {
          if (navigator.onLine) throw failure;
          const saved = await reportSecurity.queue(report, operationId);
          if (!saved) return;
          setPendingReports(current => [...current, saved]);
          setSubmitted(''); setPoint(null); form.reset();
          return;
        }
        setSubmitted(response.reference); setPoint(null); form.reset();
        try { setPendingReports(await saveSubmittedPublicReport(portal!.slug, operationId, response.reference)); }
        catch (failure) {
          setError(`Request submitted, but its tracking reference could not be saved: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
        return;
      }
      const queued = await reportSecurity.queue(report, operationId);
      if (!queued) return;
      setPendingReports(current => [...current, queued]);
      setSubmitted(''); setPoint(null); form.reset();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not submit request'); }
    finally { setBusy(false); }
  }
  async function selectPublicRequest(id: string) {
    setError('');
    setBusy(true);
    try {
      if (!navigator.onLine) {
        const cached = await readPortalCache(portal!.slug);
        const detail = cached?.details[id];
        if (!detail) throw new Error('This public request has not been saved for offline viewing.');
        setPublicRequestDetail(detail);
      } else {
        const detail = await civicApi<PublicRequestDetail>(`/public/${portal!.slug}/requests/${id}`);
        setPublicRequestDetail(detail);
        await savePublicRequestDetail(portal!.slug, detail);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load public request');
    } finally { setBusy(false); }
  }
  async function retryPublicReport(id: string) {
    try {
      await updatePublicReport(portal!.slug, id, pending => ({ ...pending, error: undefined }));
      const cached = await readPortalCache(portal!.slug);
      if (cached) setPendingReports(cached.reports);
      await syncReports();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not retry the saved request');
    }
  }
  async function clearOfflineData() {
    if (await reportSecurity.clearDevice()) {
      setOfflineSnapshot(false);
      setOfflineSavedAt('');
      setError('Offline data was cleared from this device.');
    }
  }
  const hasPoint = (item: CivicRecord) => item.longitude !== null && item.latitude !== null;
  function openOnMap(item: CivicRecord) {
    if (!hasPoint(item)) return;
    setMapFocus({ title: item.title, point: [item.longitude!, item.latitude!] });
    setPublicContentDetail(null); setError(''); setView('map');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const settings = portal?.settings; const hubGroups = groupPortalContent(content, kind, settings?.timezone, settings?.language); const visibleOrganizations = searchOrganizations(organizations, organizationQuery);
  return <main className={styles.shell} style={{ '--civic-accent': settings?.color || '#0d9488' } as React.CSSProperties}>
    <header className={styles.header}>
      <Link href="/" className={styles.brand}>C<span>O</span> <strong>CivicOS</strong></Link>
      <div className={styles.headerLinks}>{!portal && <Link href="/platform">Platform owner</Link>}<Link href={`/staff?org=${encodeURIComponent(portal?.slug || slug)}`}>Staff sign in</Link><Link href={`/field?org=${encodeURIComponent(portal?.slug || slug)}`}>Field workspace</Link></div>
    </header>
    {offlineShellError && <p role="alert" className={styles.error}>{offlineShellError}</p>}
    {portal && <p role="status" className={styles.hint}>
      {!online || offlineSnapshot
        ? `Offline — showing saved public information${offlineSavedAt ? ` from ${displayDate(offlineSavedAt, portal.settings)}` : ''}.`
        : 'Public information is saved on this device for offline viewing.'}
    </p>}
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
      {!!pendingReports.length && <section className={styles.card} aria-label="Saved public reports">
        <h2>Saved reports</h2>
        <p className={styles.hint}>Unsubmitted reports are encrypted with your offline passphrase and will be sent when a connection is available.</p>
        <ul>{pendingReports.map(report => <li key={report.id}>
          {report.locked ? <>Protected offline report · <button type="button" className={styles.secondary} onClick={reportSecurity.unlockSavedReports}>Unlock to send</button></> :
          report.reference ? <>Submitted · Tracking reference <code>{report.reference}</code></> :
            report.error ? <>Needs attention · {report.error} <button type="button" className={styles.secondary} onClick={() => void retryPublicReport(report.id)}>Retry</button></> :
              <>Waiting to send · saved {new Date(report.createdAt).toLocaleString()}</>}
        </li>)}</ul>
      </section>}
      <nav className={styles.tabs} aria-label="Portal sections">
        {['overview', 'map', 'calendar', 'report'].map(tab => <button key={tab} aria-current={view === tab ? 'page' : undefined} onClick={() => { setView(tab); setError(''); setMapFocus(null); }}>{({ overview: 'Community hub', map: 'Explore the map', calendar: 'Public requests', report: 'Report a problem' })[tab]}</button>)}
      </nav>
      <div className={styles.body}>
        {content.filter(item => item.kind === 'emergency').map(item => <aside key={item.id} className={styles.emergency}><strong>Emergency notice · {item.title}</strong><p>{item.description}</p></aside>)}
        {view === 'overview' && <>
          <div className={styles.sectionTitle}><div><p className={styles.eyebrow}>WHAT'S HAPPENING</p><h2>Your community hub</h2></div>
              <label>Show<select value={kind} onChange={event => setKind(event.target.value)}>{portalContentKinds.map(type => <option key={type} value={type}>{type === 'all' ? 'All information' : type}</option>)}</select></label></div>
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
          <p className={styles.hint}><a href={communityMapUrl(portal.slug)} target="_blank" rel="noopener noreferrer">Open the standalone community map</a></p>
          {mapFocus && <div className={styles.inline} role="status"><p className={styles.hint}>Showing <strong>{mapFocus.title}</strong> on the map.</p><button type="button" className={styles.secondary} onClick={() => setMapFocus(null)}>Show the whole community</button></div>}
          <p className={styles.hint}>This map is read-only by default. Use the zoom controls to inspect an area, or enable interaction to browse public locations and open a request.</p>{online ? <MapEmbed portal={portal} revision={revision} locked center={mapFocus?.point} marker={mapFocus?.point} zoom={mapFocus ? 16 : undefined} onSelect={id => void selectPublicRequest(id)} /> : <p className={styles.hint}>The interactive map needs an internet connection. Saved portal information remains available in the Community hub and Public requests sections.</p>}
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
          <form id="portal-report-form" onSubmit={report} className={styles.form}>
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
          </form></section><aside><h3>Pin the location</h3><p className={styles.hint}>Click on the map to add coordinates. Contact details are never published.</p>{online ? <MapEmbed portal={portal} onPoint={setPoint} /> : <p className={styles.hint}>The map needs an internet connection. You can enter the coordinates manually above.</p>}</aside></div>}
      </div>
      {publicRequestDetail && <div className={styles.modalBackdrop} role="presentation">
        <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="public-ticket-title">
          <div className={styles.sectionTitle}><div><span className={styles.tag}>{publicRequestDetail.status}</span><h2 id="public-ticket-title">{publicRequestDetail.title}</h2></div><button className={styles.secondary} onClick={() => setPublicRequestDetail(null)}>Close</button></div>
          <div className={styles.ticketModalLayout}><div><p>{publicRequestDetail.category || 'Community request'}</p>{publicRequestDetail.description && <p>{publicRequestDetail.description}</p>}<p>Reported {displayDate(publicRequestDetail.created_at, portal.settings)}</p>{publicRequestDetail.completed_at && <p>Completed {displayDate(publicRequestDetail.completed_at, portal.settings)}</p>}<p>Updated {displayDate(publicRequestDetail.updated_at, portal.settings)}</p>
            {publicRequestDetail.photos.map((photo, index) => <img key={index} className={styles.ticketPhoto} src={photo} alt={`Ticket photo ${index + 1} for ${publicRequestDetail.title}`} />)}
            <h3>Public status updates</h3><ol className={styles.timeline}>{publicRequestDetail.history.map((event, index) => <li key={index}><strong>{event.status}</strong><small>{displayDate(event.timestamp, portal.settings)}</small></li>)}</ol></div>
            <aside><h3>Public location</h3><p>{publicRequestDetail.location || 'No location description was provided.'}</p>{publicRequestDetail.longitude !== null && publicRequestDetail.latitude !== null ?
              <><p className={styles.hint}>Pinned coordinates: {publicRequestDetail.latitude}, {publicRequestDetail.longitude}</p>{online && <MapEmbed portal={portal} center={[publicRequestDetail.longitude, publicRequestDetail.latitude]} marker={[publicRequestDetail.longitude, publicRequestDetail.latitude]} zoom={16} focused locked />}</> :
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
              online ? <MapEmbed portal={portal} center={[publicContentDetail.longitude, publicContentDetail.latitude]} zoom={16} /> : <p className={styles.hint}>Map unavailable offline. Coordinates: {publicContentDetail.latitude}, {publicContentDetail.longitude}</p> :
              <p className={styles.hint}>A map location was not provided for this information.</p>}</aside></div>
        </section>
      </div>}
      {(error || reportSecurity.error) && !reportSecurity.dialogOpen && view !== 'report' && view !== 'map' && <p role="alert" className={styles.error}>{error || reportSecurity.error}</p>}
    </>}
    <footer className={styles.footer}><strong>CivicOS</strong><span>Open infrastructure for everyday community life.</span><span>Public portal · No account required</span><span>Powered by Codyza</span>
      <button type="button" className={styles.secondary} onClick={() => void clearOfflineData()}>Clear this device’s offline data</button>
    </footer>
    {reportSecurity.dialogOpen && <OfflineReportSecurityDialog
      configured={reportSecurity.configured}
      error={reportSecurity.error}
      onSubmit={reportSecurity.submitPassphrase}
      onUnlocked={syncReports}
      onClose={reportSecurity.closeDialog}
    />}
  </main>;
}
