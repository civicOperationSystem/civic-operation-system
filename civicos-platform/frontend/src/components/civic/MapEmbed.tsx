'use client';
import { useEffect, useRef, useState } from 'react';
import type { Portal } from '@/lib/civic';
import styles from './civic.module.css';

export default function MapEmbed({ portal, token, revision = 0, center, zoom, marker, focused = false, locked = false, onPoint, onSelect, onView }: {
  portal: Portal; token?: string; revision?: number; center?: [number, number]; zoom?: number; marker?: [number, number];
  focused?: boolean; locked?: boolean; onPoint?: (point: [number, number]) => void; onSelect?: (id: string) => void;
  onView?: (center: [number, number], zoom: number) => void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [interactionEnabled, setInteractionEnabled] = useState(false);
  const callbacks = useRef({ onPoint, onSelect, onView });
  callbacks.current = { onPoint, onSelect, onView };
  const selectable = !!onPoint;
  const viewSelectable = !!onView;
  const mapLocked = locked && !interactionEnabled;
  const mapUrl = process.env.NEXT_PUBLIC_CIVIC_MAP_URL || 'http://localhost:3101/civic';
  useEffect(() => {
    const origin = new URL(mapUrl, window.location.origin).origin;
    let connected = false;
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== iframe.current?.contentWindow) return;
      if (event.data?.type === 'civic-map-ready') { connected = true; setReady(true); setError(''); }
      if (event.data?.type === 'civic-map-point' && Array.isArray(event.data.point) &&
          event.data.point.length === 2 && event.data.point.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))) {
        const [longitude, latitude] = event.data.point;
        if (Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90) callbacks.current.onPoint?.([longitude, latitude]);
      }
      if (event.data?.type === 'civic-map-select' && typeof event.data.id === 'string') callbacks.current.onSelect?.(event.data.id);
      if (event.data?.type === 'civic-map-view' && Array.isArray(event.data.center) &&
          event.data.center.length === 2 && event.data.center.every((value: unknown) => typeof value === 'number' && Number.isFinite(value)) &&
          Math.abs(event.data.center[0]) <= 180 && Math.abs(event.data.center[1]) <= 90 &&
          typeof event.data.zoom === 'number' && Number.isFinite(event.data.zoom) && event.data.zoom >= 1 && event.data.zoom <= 19) {
        callbacks.current.onView?.(event.data.center, event.data.zoom);
      }
    };
    window.addEventListener('message', receive);
    const timeout = setTimeout(() => { if (!connected) setError('Map is taking too long to load. Check the map service and its allowed parent origins.'); }, 20000);
    return () => { window.removeEventListener('message', receive); clearTimeout(timeout); };
  }, [mapUrl]);
  useEffect(() => {
    if (!ready) return;
    iframe.current?.contentWindow?.postMessage({
      type: 'civic-map-context', slug: portal.slug, center: center || portal.settings.center, zoom: zoom ?? portal.settings.zoom ?? 12,
      token: token || null, selectable, viewSelectable, revision, marker: marker || null, focused, locked: mapLocked,
    }, new URL(mapUrl, window.location.origin).origin);
  }, [mapUrl, portal, token, ready, revision, selectable, viewSelectable, center, zoom, marker, focused, mapLocked]);
  return <>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.mapFrame}>
      {locked && <button type="button" className={styles.mapToggle} aria-pressed={interactionEnabled}
        onClick={() => setInteractionEnabled(value => !value)}>{interactionEnabled ? 'Lock map interaction' : 'Enable map interaction'}</button>}
      <iframe ref={iframe} src={mapUrl} title="Interactive CivicOS community map" allow="geolocation"
        onLoad={() => { setReady(false); iframe.current?.contentWindow?.postMessage({ type: 'civic-map-handshake' }, new URL(mapUrl, window.location.origin).origin); }} />
    </div>
  </>;
}
