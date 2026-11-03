'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoJSONSource, GeolocateControl as GeolocateControlInstance, Map as MapInstance, Marker as MapMarker } from 'maplibre-gl';
import { filterFeatures, isMapContext, MapCollection, MapContext, MapFeature } from '@/lib/civic-map';
import styles from '@/app/civic/map.module.css';

const empty: MapCollection = { type: 'FeatureCollection', features: [] };
export default function CivicMap() {
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<MapInstance | null>(null);
  const pin = useRef<MapMarker | null>(null);
  const geolocate = useRef<GeolocateControlInstance | null>(null);
  const [map, setMap] = useState<MapInstance | null>(null);
  const [context, setContext] = useState<MapContext | null>(null);
  const contextRef = useRef<MapContext | null>(null);
  const parentOrigin = useRef<string | null>(null);
  const [slug, setSlug] = useState('');
  const [data, setData] = useState<MapCollection>(empty);
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [mapError, setMapError] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedPoint, setSelectedPoint] = useState<[number, number] | null>(null);
  const [revision, setRevision] = useState(0);
  const filtered = useMemo(() => filterFeatures(data, kind, status, search), [data, kind, status, search]);

  function send(message: object) {
    if (parentOrigin.current) window.parent.postMessage(message, parentOrigin.current);
  }
  function select(feature: MapFeature) {
    map?.flyTo({ center: feature.geometry.coordinates, zoom: 16 });
    if (feature.properties.kind === 'request') send({ type: 'civic-map-select', id: feature.properties.id });
  }
  useEffect(() => {
    const allowed = new Set((process.env.NEXT_PUBLIC_CIVIC_PARENT_ORIGINS || 'http://localhost:3100').split(',').map(value => value.trim()));
    allowed.add(window.location.origin);
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || !allowed.has(event.origin)) return;
      if (event.data?.type === 'civic-map-handshake') {
        parentOrigin.current = event.origin;
        send({ type: 'civic-map-ready' });
      }
      if (isMapContext(event.data)) {
        parentOrigin.current = event.origin;
        if (contextRef.current?.slug !== event.data.slug) { pin.current?.remove(); setSelectedPoint(null); }
        contextRef.current = event.data;
        setContext(event.data); setSlug(event.data.slug);
      }
    };
    window.addEventListener('message', receive);
    for (const origin of allowed) {
      if (window.parent !== window) window.parent.postMessage({ type: 'civic-map-ready' }, origin);
    }
    const org = new URLSearchParams(window.location.search).get('org');
    if (org && /^[a-z0-9-]{3,60}$/.test(org) && window.parent === window) {
      setSlug(org); setContext({ slug: org, token: null, center: [-73.98, 40.75], selectable: false });
    }
    return () => { window.removeEventListener('message', receive); contextRef.current = null; };
  }, []);
  useEffect(() => {
    let active = true;
    let current: MapInstance | undefined;
    let observer: ResizeObserver | undefined;
    import('maplibre-gl').then(({ Map, NavigationControl, GeolocateControl, Popup, Marker, setWorkerUrl }) => {
      if (!active || !container.current) return;
      setWorkerUrl(new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url).toString());
      current = new Map({
        container: container.current, style: 'https://tiles.openfreemap.org/styles/liberty',
        center: [-73.98, 40.75], zoom: 12, minZoom: 1, maxZoom: 19,
      });
      instance.current = current;
      current.addControl(new NavigationControl({ showCompass: false }), 'top-right');
      geolocate.current = new GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true });
      current.addControl(geolocate.current, 'top-right');
      current.getCanvas().setAttribute('aria-label', 'Interactive community infrastructure and service request map');
      current.on('error', event => {
        console.error('CivicOS map resource failed', event.error);
        if (active) setMapError('Some map tiles could not load. The authorized location list is still available.');
      });
      current.on('idle', () => { if (active && current?.areTilesLoaded()) setMapError(''); });
      current.on('load', () => {
        if (!active || !current) return;
        current.addSource('civic', { type: 'geojson', data: empty, cluster: true, clusterMaxZoom: 14, clusterRadius: 45 });
        current.addLayer({ id: 'clusters', type: 'circle', source: 'civic', filter: ['has', 'point_count'], paint: {
          'circle-color': '#0d9488', 'circle-radius': ['step', ['get', 'point_count'], 20, 10, 26, 50, 34],
          'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff',
        } });
        current.addLayer({ id: 'cluster-count', type: 'symbol', source: 'civic', filter: ['has', 'point_count'], layout: {
          'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12,
        }, paint: { 'text-color': '#ffffff' } });
        current.addLayer({ id: 'places', type: 'circle', source: 'civic', filter: ['!', ['has', 'point_count']], paint: {
          'circle-radius': 9, 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff',
          'circle-color': ['match', ['get', 'kind'], 'request', '#e08d28', 'facility', '#457ad0', 'infrastructure', '#8460ad', 'emergency', '#d44545', '#0d9488'],
        } });
        current.on('click', 'clusters', async event => {
          if (contextRef.current?.locked) return;
          const feature = event.features?.[0];
          if (!feature || feature.geometry.type !== 'Point' || !current) return;
          try {
            const zoom = await (current.getSource('civic') as GeoJSONSource).getClusterExpansionZoom(Number(feature.properties?.cluster_id));
            if (active) current.easeTo({ center: [feature.geometry.coordinates[0], feature.geometry.coordinates[1]], zoom });
          } catch (failure) {
            console.error('CivicOS cluster could not expand', failure);
            if (active) setMapError('Could not expand this group. Use the zoom controls.');
          }
        });
        current.on('click', 'places', event => {
          if (contextRef.current?.locked) return;
          const feature = event.features?.[0];
          if (!feature || feature.geometry.type !== 'Point' || !current) return;
          const properties = feature.properties;
          const element = document.createElement('div');
          const heading = document.createElement('strong');
          heading.textContent = String(properties?.title || 'Community location');
          const description = document.createElement('p');
          description.textContent = `${properties?.kind || ''}${properties?.status ? ` · ${properties.status}` : ''}`;
          element.append(heading, description);
          new Popup({ maxWidth: '260px' }).setLngLat([feature.geometry.coordinates[0], feature.geometry.coordinates[1]]).setDOMContent(element).addTo(current);
          if (properties?.kind === 'request') send({ type: 'civic-map-select', id: properties.id });
        });
        current.on('click', event => {
          if (!current || contextRef.current?.focused || contextRef.current?.locked) return;
          const point: [number, number] = [Number(event.lngLat.wrap().lng.toFixed(6)), Number(event.lngLat.lat.toFixed(6))];
          setSelectedPoint(point);
          pin.current?.remove();
          pin.current = new Marker({ color: '#e04b34' }).setLngLat(point).addTo(current);
          if (contextRef.current?.selectable) send({ type: 'civic-map-point', point });
        });
        for (const layer of ['places', 'clusters']) {
          current.on('mouseenter', layer, () => { if (current) current.getCanvas().style.cursor = contextRef.current?.locked ? '' : 'pointer'; });
          current.on('mouseleave', layer, () => { if (current) current.getCanvas().style.cursor = ''; });
        }
        setMap(current);
      });
      observer = new ResizeObserver(() => current?.resize());
      observer.observe(container.current);
    }).catch(failure => {
      console.error('CivicOS map failed to initialize', failure);
      if (active) setMapError('Interactive map could not initialize. Use the authorized location list.');
    });
    return () => { active = false; observer?.disconnect(); pin.current?.remove(); current?.remove(); geolocate.current = null; instance.current = null; };
  }, []);
  useEffect(() => {
    if (!context) return;
    if (context.focused) { setData(empty); setLoading(false); setError(''); return; }
    const abort = new AbortController();
    setLoading(true); setError(''); setData(empty);
    const path = context.token ? '/staff/map' : `/public/${encodeURIComponent(context.slug)}/map`;
    void fetch(`/api/civic${path}`, {
      headers: context.token ? { Authorization: `Bearer ${context.token}` } : {},
      signal: abort.signal, cache: 'no-store',
    }).then(async response => {
      const collection = await response.json();
      if (!response.ok) throw new Error(collection.message || 'Could not load authorized map data');
      if (collection.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw new Error('Invalid map data received');
      if (!abort.signal.aborted) setData(collection);
    }).catch(failure => {
      if (!abort.signal.aborted) { console.error('CivicOS map data failed', failure); setError(failure instanceof Error ? failure.message : 'Could not load map data'); }
    }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [context, revision]);
  useEffect(() => {
    if (!map || !context) return;
    const interactions = [map.dragPan, map.scrollZoom, map.boxZoom, map.doubleClickZoom, map.keyboard, map.touchZoomRotate];
    for (const interaction of interactions) {
      if (context.locked) interaction.disable();
      else interaction.enable();
    }
    if (context.locked && geolocate.current) {
      map.removeControl(geolocate.current);
      geolocate.current = null;
    }
  }, [map, context?.locked]);
  useEffect(() => {
    if (!map) return;
    (map.getSource('civic') as GeoJSONSource).setData(filtered);
  }, [map, filtered]);
  useEffect(() => { if (map && context) map.flyTo({ center: context.center, zoom: context.zoom || 12 }); }, [map, context?.slug, context?.center[0], context?.center[1], context?.zoom]);
  useEffect(() => {
    if (!map || !context?.marker) return;
    let active = true;
    let marker: MapMarker | undefined;
    const point = context.marker;
    void import('maplibre-gl').then(({ Marker }) => {
      if (active) marker = new Marker({ color: '#e04b34' }).setLngLat(point).addTo(map);
    }).catch(failure => {
      console.error('CivicOS location pin could not be displayed', failure);
      if (active) setMapError('The selected location pin could not be displayed.');
    });
    return () => { active = false; marker?.remove(); };
  }, [map, context?.slug, context?.marker?.[0], context?.marker?.[1]]);
  const statuses = [...new Set(data.features.map(feature => feature.properties.status).filter((item): item is string => !!item))];
  function fitLocations() {
    if (!map || !filtered.features.length) return;
    const points = filtered.features.map(feature => feature.geometry.coordinates);
    map.fitBounds([
      [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1]))],
      [Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))],
    ], { padding: 70, maxZoom: 16 });
  }
  return <main className={styles.shell}>
    {!context?.focused && !context?.locked && <header className={styles.header}><strong>CivicOS <span>Community map</span></strong><span className={styles.badge}>{context?.token ? 'Permission-aware workspace' : 'Public information only'}</span></header>}
    <div className={context?.focused || context?.locked ? `${styles.layout} ${styles.focusedLayout}` : styles.layout}>
      {!context?.focused && !context?.locked && <aside className={styles.sidebar}>
        {!context && <form onSubmit={event => { event.preventDefault(); setContext({ slug, token: null, center: [-73.98, 40.75], selectable: false }); }}><label>Organization<input required value={slug} onChange={event => setSlug(event.target.value)} pattern="[a-z0-9-]{3,60}" /></label><button>Open map</button></form>}
        <label>Search locations<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Facility, infrastructure, request…" /></label>
        <label>Layer<select value={kind} onChange={event => setKind(event.target.value)}>{['all', 'request', 'facility', 'infrastructure', 'service', 'project', 'event', 'emergency'].map(item => <option key={item} value={item}>{item === 'all' ? 'All authorized layers' : item}</option>)}</select></label>
        <label>Request status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{statuses.map(item => <option key={item}>{item}</option>)}</select></label>
        <label>Longitude<input name="longitude" type="number" step="any" value={selectedPoint?.[0] ?? ''} readOnly placeholder="Click the map" /></label>
        <label>Latitude<input name="latitude" type="number" step="any" value={selectedPoint?.[1] ?? ''} readOnly placeholder="Click the map" /></label>
        <div className={styles.actions}><button disabled={!filtered.features.length} onClick={fitLocations}>Fit locations</button><button disabled={!context || loading} onClick={() => setRevision(value => value + 1)}>Refresh</button></div>
        {(error || mapError) && <p className={styles.error} role="alert">{error || mapError}</p>}
        <p className={styles.count} role="status">{loading ? 'Loading authorized locations…' : `${filtered.features.length} authorized locations`}</p>
        {data.truncated && <p role="status" className={styles.hint}>The map is limited to the latest 5,000 authorized locations.</p>}
        <p className={styles.hint} role="status">{selectedPoint ? `Selected: ${selectedPoint[0]}, ${selectedPoint[1]}` : 'Click the map to show longitude and latitude.'}</p>
        <ul className={styles.locations}>{filtered.features.slice(0, 200).map(feature => <li key={feature.id}><button onClick={() => select(feature)}><span className={styles.kind}>{feature.properties.kind}</span><strong>{feature.properties.title}</strong><small>{feature.properties.status || feature.properties.location || 'Community location'}</small></button></li>)}</ul>
        {!loading && !error && context && !filtered.features.length && <p className={styles.hint}>No authorized locations match these filters. Unpublished requests are not shown publicly.</p>}
        {filtered.features.length > 200 && <p className={styles.hint}>Showing the first 200 in the list. All returned locations remain visible on the map. Narrow your filters to find more.</p>}
      </aside>}
      <section className={styles.mapArea} aria-busy={!map}><div ref={container} className={styles.map} />{context?.focused ? mapError && <p className={`${styles.error} ${styles.mapError}`} role="alert">{mapError}</p> : <div className={styles.legend}><span>● Requests</span><span>● Facilities</span><span>● Infrastructure</span></div>}</section>
    </div>
    {!context && <footer className={styles.footer}>Powered by Codyza</footer>}
  </main>;
}
