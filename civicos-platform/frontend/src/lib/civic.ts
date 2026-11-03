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
export type Member = { id: string; email: string; display_name: string; role: string; active: boolean };
export type Session = { user: Member; permissions: string[]; portal: Portal };
export type CivicRecord = {
  id: string; kind: string; title: string; description: string; location: string;
  category: string; status: string; reference: string; published: boolean;
  assigned_to: string | null; archived_at?: string | null; longitude: number | null; latitude: number | null;
  created_at: string; updated_at: string; sync_version?: string; url?: string | null; calendar_date?: string | null;
};
export type History = {
  id: string; actor: string | null; previous_status: string | null; new_status: string;
  notes: string; note_visibility: 'role_only' | 'down_chain' | null; assigned_to: string | null; created_at: string;
};
export type RequestDetail = CivicRecord & {
  contact: { name: string; email: string; phone: string } | null;
  photos: string[]; field_photos: string[]; history: History[];
};
export type Tracking = {
  reference: string; title: string; category: string; status: string; reported: string; updated: string;
  history: { status: string; timestamp: string }[];
};
export class CivicApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
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
  if (!response.ok) throw new CivicApiError(body.message || `Operation failed (${response.status})`, response.status);
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

export async function readFieldPhoto(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a PNG, JPEG or WebP image no larger than 5 MB.');
  }

  const uploadLimit = 512 * 1024;
  if (file.size <= uploadLimit) return readPhoto(file);

  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Could not read the selected image.'));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('The selected image has invalid dimensions.');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Photo compression is not available in this browser.');

    let scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight));
    for (let attempt = 0; attempt < 5; attempt++) {
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.7, 0.55]) {
        const compressed = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not compress the selected photo.')), 'image/jpeg', quality);
        });
        if (compressed.type !== 'image/jpeg') throw new Error('Photo compression is not available in this browser.');
        if (compressed.size <= uploadLimit) {
          return await readPhoto(new File([compressed], 'field-photo.jpg', { type: 'image/jpeg' }));
        }
      }
      scale *= 0.7;
    }
    throw new Error('Could not reduce this photo enough to upload. Try a smaller image.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function readPublicPhoto(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a PNG, JPEG or WebP image no larger than 5 MB.');
  }
  return readFieldPhoto(file);
}
