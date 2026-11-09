'use client';

import { useEffect } from 'react';
import type { MapFeature } from '@/lib/civic-map';
import type { MapLocationDetails } from '@/lib/map-location';
import styles from '@/app/civic/map.module.css';

type Props = {
  feature: MapFeature;
  details: MapLocationDetails | null;
  loading: boolean;
  error: string;
  onClose(): void;
};

export default function MapLocationDialog({ feature, details, loading, error, onClose }: Props) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return <div className={styles.dialogBackdrop} onClick={onClose}>
    <section
      className={styles.locationDialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby="map-location-title"
      onClick={event => event.stopPropagation()}
    >
      <button className={styles.dialogClose} type="button" aria-label="Close location details" onClick={onClose}>×</button>
      <p className={styles.kind}>{feature.properties.kind}</p>
      <h2 id="map-location-title">{feature.properties.title}</h2>
      {details?.category && <p><strong>Category:</strong> {details.category}</p>}
      {(details?.status || feature.properties.status) && <p><strong>Status:</strong> {details?.status || feature.properties.status}</p>}
      {(details?.location || feature.properties.location) && <p><strong>Location:</strong> {details?.location || feature.properties.location}</p>}
      {details?.calendar_date && <p><strong>Date:</strong> {details.calendar_date}</p>}
      {details?.description && <p className={styles.locationDescription}>{details.description}</p>}
      {details?.url && <p><a href={details.url} target="_blank" rel="noopener noreferrer">More information ↗</a></p>}
      {details?.updated_at && <p><small>Updated {new Date(details.updated_at).toLocaleString()}</small></p>}
      <p><small>Coordinates: {feature.geometry.coordinates.join(', ')}</small></p>
      {loading && <p role="status">Loading location details…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!!details?.photos.length && <section aria-label="Location photos" className={styles.locationPhotos}>
        {details.photos.map((photo, index) => <img key={`${feature.id}-${index}`} src={photo} alt={`${feature.properties.title} photo ${index + 1}`} />)}
      </section>}
    </section>
  </div>;
}
