import type { CivicRecord } from '@/lib/civic';

export const portalContentKinds = [
  'all', 'service', 'announcement', 'event', 'project', 'facility', 'document', 'emergency', 'infrastructure',
];

export type PortalContentGroup = { key: string; label: string; items: CivicRecord[] };

export function groupPortalContent(
  content: CivicRecord[],
  kind: string,
  timezone?: string,
  language?: string,
): PortalContentGroup[] {
  return content.filter(item => kind === 'all' || item.kind === kind)
    .reduce<PortalContentGroup[]>((groups, item) => {
      const date = new Date(item.created_at);
      const key = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit' }).format(date);
      let group = groups.find(current => current.key === key);
      if (!group) {
        group = {
          key,
          label: new Intl.DateTimeFormat(language, { timeZone: timezone, year: 'numeric', month: 'long' }).format(date),
          items: [],
        };
        groups.push(group);
      }
      group.items.push(item);
      return groups;
    }, []);
}

export function searchOrganizations(
  organizations: { name: string; slug: string }[],
  query: string,
): { name: string; slug: string }[] {
  const search = query.trim().toLowerCase();
  return organizations.filter(organization =>
    `${organization.name} /portal/${organization.slug}`.toLowerCase().includes(search));
}
