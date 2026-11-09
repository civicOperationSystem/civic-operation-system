import type { MapContext, MapFeature } from './civic-map';

export type MapLocationDetails = {
  description: string;
  category: string | null;
  status: string | null;
  location: string | null;
  updated_at: string | null;
  calendar_date: string | null;
  url: string | null;
  photos: string[];
};

function locationDetails(value: unknown): MapLocationDetails {
  if (!value || typeof value !== 'object') throw new Error('The location returned invalid details.');
  const record = value as Record<string, unknown>;
  const photos = Array.isArray(record.photos) ? record.photos.filter((item): item is string => typeof item === 'string') : [];
  const fieldPhotos = Array.isArray(record.field_photos)
    ? record.field_photos.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    description: typeof record.description === 'string' ? record.description : '',
    category: typeof record.category === 'string' ? record.category : null,
    status: typeof record.status === 'string' ? record.status : null,
    location: typeof record.location === 'string' ? record.location : null,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : null,
    calendar_date: typeof record.calendar_date === 'string' ? record.calendar_date : null,
    url: typeof record.url === 'string' ? record.url : null,
    photos: [...photos, ...fieldPhotos],
  };
}

async function getJson(path: string, context: MapContext, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/civic${path}`, {
    headers: context.token ? { Authorization: `Bearer ${context.token}` } : {},
    signal,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Location details are unavailable right now.');
  return response.json();
}

export async function loadMapLocationDetails(
  feature: MapFeature, context: MapContext, signal: AbortSignal,
): Promise<MapLocationDetails> {
  const id = encodeURIComponent(feature.properties.id);
  if (feature.properties.kind === 'request') {
    const path = context.token
      ? `/staff/requests/${id}`
      : `/public/${encodeURIComponent(context.slug)}/requests/${id}`;
    return locationDetails(await getJson(path, context, signal));
  }

  if (context.token) {
    try {
      const records = await getJson('/staff/content', context, signal);
      if (Array.isArray(records)) {
        const record = records.find(item => item && typeof item === 'object' && item.id === feature.id);
        if (record) return locationDetails(record);
      }
    } catch (failure) {
      if (signal.aborted) throw failure;
    }
  }
  const records = await getJson(`/public/${encodeURIComponent(context.slug)}/content`, context, signal);
  if (!Array.isArray(records)) throw new Error('The location returned invalid details.');
  const record = records.find(item => item && typeof item === 'object' && item.id === feature.id);
  if (!record) throw new Error('More information is not available for this location.');
  return locationDetails(record);
}
