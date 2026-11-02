export type MapFeature = {
  type: 'Feature'; id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { id: string; kind: string; title: string; status: string | null; location: string | null };
};
export type MapCollection = { type: 'FeatureCollection'; features: MapFeature[]; truncated?: boolean };
export type MapContext = { slug: string; center: [number, number]; zoom?: number | null; token: string | null; selectable: boolean };
export function isMapContext(value: unknown): value is MapContext & { type: string } {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<MapContext> & { type?: string };
  return item.type === 'civic-map-context' && typeof item.slug === 'string' &&
    /^[a-z0-9-]{3,60}$/.test(item.slug) && Array.isArray(item.center) && item.center.length === 2 &&
    item.center.every(point => typeof point === 'number' && Number.isFinite(point)) &&
    Math.abs(item.center[0]) <= 180 && Math.abs(item.center[1]) <= 90 &&
    (item.zoom === undefined || item.zoom === null || (typeof item.zoom === 'number' && Number.isFinite(item.zoom) && item.zoom >= 1 && item.zoom <= 19)) &&
    (item.token === null || (typeof item.token === 'string' && item.token.length < 4096)) &&
    typeof item.selectable === 'boolean';
}
export function filterFeatures(data: MapCollection, kind: string, status: string, search: string): MapCollection {
  const query = search.trim().toLowerCase();
  return {
    type: 'FeatureCollection',
    features: data.features.filter(feature =>
      (kind === 'all' || feature.properties.kind === kind) &&
      (!status || feature.properties.status === status) &&
      `${feature.properties.title} ${feature.properties.location || ''}`.toLowerCase().includes(query)),
  };
}
