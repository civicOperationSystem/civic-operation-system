import type { CivicRecord, RequestDetail, Session } from '@/lib/civic';

export const staffIdentityKey = (slug: string) => `civicos-staff-identity:${slug}`;

export function readFieldCoordinates(longitudeValue: string, latitudeValue: string): [number, number] | null {
  if (!longitudeValue.trim() && !latitudeValue.trim()) return null;
  const longitude = Number(longitudeValue);
  const latitude = Number(latitudeValue);
  if (!longitudeValue.trim() || !latitudeValue.trim() || !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    throw new Error('Enter valid longitude and latitude.');
  }
  return [longitude, latitude];
}

export function offlineStaffRecord(record: CivicRecord): CivicRecord {
  return {
    id: record.id, kind: record.kind, title: record.title, description: record.description,
    location: record.location, category: record.category, status: record.status, reference: record.reference,
    published: record.published, assigned_to: record.assigned_to, archived_at: record.archived_at,
    longitude: record.longitude, latitude: record.latitude, created_at: record.created_at, updated_at: record.updated_at,
  };
}

export function ticketTransitions(detail: RequestDetail | null, session: Session | null) {
  const states = session?.portal.settings.states || [];
  return {
    nextStates: states.find(state => state.key === detail?.status)?.next || [],
    previousStates: detail ? states.filter(state => state.next.includes(detail.status)).map(state => state.key) : [],
    canPublishTicket: !!detail && (() => {
      const state = states.find(item => item.key === detail.status);
      return !!state && (state.key === 'completed' || state.next.length === 0);
    })(),
  };
}

export function visibleWorkspaceRecords(
  records: CivicRecord[],
  field: boolean,
  userId: string | undefined,
  status: string,
  search: string,
  stateLabel: (key: string | null) => string,
): CivicRecord[] {
  return records.filter(record => (!field || record.assigned_to === userId) &&
    (!status || record.status === status) &&
    `${record.title} ${record.description} ${record.category} ${record.location} ${record.reference} ${stateLabel(record.status)}`.toLowerCase().includes(search.toLowerCase()));
}
