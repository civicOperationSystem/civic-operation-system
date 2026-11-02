export type WorkflowState = { key: string; label: string; next: string[]; field?: boolean };
export function fieldCanEnter(state: WorkflowState): boolean {
  return state.field ?? ['in_progress', 'completed'].includes(state.key);
}
export type Settings = {
  logo: string; color: string; timezone: string; language: string; contact: string;
  locations: string[]; departments: string[]; services: string[]; categories: string[];
  anonymous: boolean; center: [number, number]; states: WorkflowState[];
};
export type Portal = { id: string; slug: string; name: string; domain: string | null; settings: Settings };
export type Member = { id: string; email: string; role: string; active: boolean };
export type Session = { user: Member; permissions: string[]; portal: Portal };
export type CivicRecord = {
  id: string; kind: string; title: string; description: string; location: string;
  category: string; status: string; reference: string; published: boolean;
  assigned_to: string | null; archived_at?: string | null; longitude: number | null; latitude: number | null;
  created_at: string; updated_at: string; url?: string | null;
};
export type History = {
  id: string; actor: string | null; previous_status: string | null; new_status: string;
  notes: string; note_visibility: 'role_only' | 'down_chain' | null; assigned_to: string | null; created_at: string;
};
export type RequestDetail = CivicRecord & {
  contact: { name: string; email: string; phone: string } | null;
  photo: string | null; history: History[];
};
export type Tracking = {
  reference: string; category: string; status: string; reported: string; updated: string;
  history: { status: string; timestamp: string }[];
};
export async function civicApi<T>(path: string, options: { token?: string; method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api/civic${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    cache: 'no-store',
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || `Operation failed (${response.status})`);
  return body as T;
}
export function displayDate(date: string, settings: Settings): string {
  return new Intl.DateTimeFormat(settings.language, {
    timeZone: settings.timezone, dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(date));
}
export async function readPhoto(file: File): Promise<string> {
  if (file.size > 2097152 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a PNG, JPEG or WebP image no larger than 2 MB.');
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read photo'));
    reader.onerror = () => reject(new Error('Could not read photo'));
    reader.readAsDataURL(file);
  });
}
