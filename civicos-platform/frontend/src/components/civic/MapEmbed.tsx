'use client';
import { useEffect, useRef, useState } from 'react';
import type { Portal } from '@/lib/civic';
import styles from './civic.module.css';

export default function MapEmbed({ portal, token, revision = 0, center, zoom, marker, focused = false, locked = false, onPoint, onSelect }: {
  portal: Portal; token?: string; revision?: number; center?: [number, number]; zoom?: number; marker?: [number, number];
  focused?: boolean; locked?: boolean; onPoint?: (point: [number, number]) => void; onSelect?: (id: string) => void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [interactionEnabled, setInteractionEnabled] = useState(false);
  const callbacks = useRef({ onPoint, onSelect });
  callbacks.current = { onPoint, onSelect };
  const selectable = !!onPoint;
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
    };
    window.addEventListener('message', receive);
    const timeout = setTimeout(() => { if (!connected) setError('Map is taking too long to load. Check the map service and its allowed parent origins.'); }, 20000);
    return () => { window.removeEventListener('message', receive); clearTimeout(timeout); };
  }, [mapUrl]);
  useEffect(() => {
    if (!ready) return;
    iframe.current?.contentWindow?.postMessage({
      type: 'civic-map-context', slug: portal.slug, center: center || portal.settings.center, zoom: zoom || null,
      token: token || null, selectable, revision, marker: marker || null, focused, locked: mapLocked,
    }, new URL(mapUrl, window.location.origin).origin);
  }, [mapUrl, portal, token, ready, revision, selectable, center, zoom, marker, focused, mapLocked]);
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
