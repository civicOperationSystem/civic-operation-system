export type OfflineCiphertext = { version: 1; iv: string; ciphertext: string };

type VaultMetadata = { salt: string; verifier: OfflineCiphertext };

const databaseName = 'civicos-security-v1';
const storeName = 'vault';
const verifierText = 'CivicOS offline vault verified';
const iterations = 310000;
let activeKey: CryptoKey | undefined;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Offline security settings could not be opened.'));
    request.onblocked = () => reject(new Error('Close other CivicOS tabs to update offline security settings.'));
  });
}

async function readMetadata(): Promise<VaultMetadata | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).get('metadata');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Offline security settings could not be read.'));
    });
  } finally { db.close(); }
}

async function saveMetadata(metadata: VaultMetadata): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(metadata, 'metadata');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error('Offline security settings could not be saved.'));
      transaction.onerror = () => reject(new Error('Offline security settings could not be saved.'));
    });
  } finally { db.close(); }
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new Uint8Array(salt).buffer, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptWithKey(value: unknown, key: CryptoKey): Promise<OfflineCiphertext> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { version: 1, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
}

async function decryptWithKey<T>(value: OfflineCiphertext, key: CryptoKey): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(base64ToBytes(value.iv)).buffer },
    key,
    new Uint8Array(base64ToBytes(value.ciphertext)).buffer,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export async function offlineVaultConfigured(): Promise<boolean> {
  return !!await readMetadata();
}

export async function createOfflineVault(passphrase: string): Promise<void> {
  if (passphrase.length < 12) throw new Error('Use an offline passphrase with at least 12 characters.');
  if (await readMetadata()) throw new Error('An offline passphrase already exists. Unlock it or clear this device first.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  const verifier = await encryptWithKey(verifierText, key);
  await saveMetadata({ salt: bytesToBase64(salt), verifier });
  activeKey = key;
}

export async function unlockOfflineVault(passphrase: string): Promise<void> {
  const metadata = await readMetadata();
  if (!metadata) throw new Error('Set up an offline passphrase to protect this device.');
  try {
    const key = await deriveKey(passphrase, base64ToBytes(metadata.salt));
    if (await decryptWithKey<string>(metadata.verifier, key) !== verifierText) throw new Error('Passphrase verification failed.');
    activeKey = key;
  } catch {
    throw new Error('Offline passphrase is incorrect.');
  }
}

export function getOfflineCryptoKey(): CryptoKey {
  if (!activeKey) throw new Error('Unlock offline data to continue.');
  return activeKey;
}

export function isOfflineCiphertext(value: unknown): value is OfflineCiphertext {
  return !!value && typeof value === 'object' &&
    (value as OfflineCiphertext).version === 1 &&
    typeof (value as OfflineCiphertext).iv === 'string' &&
    typeof (value as OfflineCiphertext).ciphertext === 'string';
}

export async function encryptOfflineValue(value: unknown): Promise<OfflineCiphertext> {
  return encryptWithKey(value, getOfflineCryptoKey());
}

export async function decryptOfflineValue<T>(value: OfflineCiphertext): Promise<T> {
  try {
    return await decryptWithKey<T>(value, getOfflineCryptoKey());
  } catch {
    throw new Error('Offline data could not be decrypted. Check the passphrase or clear this device’s offline data.');
  }
}

export function lockOfflineVault(): void {
  activeKey = undefined;
  window.dispatchEvent(new Event('civicos-offline-lock'));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('civicos-offline-security');
    channel.postMessage({ type: 'lock' });
    channel.close();
  }
}

export async function clearCivicOSOfflineData(): Promise<void> {
  lockOfflineVault();
  for (const name of ['civicos-offline-v1', 'civicos-field-v1', databaseName]) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error(`Could not clear offline database ${name}. Close other CivicOS tabs and retry.`));
      request.onblocked = () => reject(new Error('Close other CivicOS tabs before clearing this device’s offline data.'));
    });
  }
  if ('caches' in window) {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.filter(name => name.startsWith('civicos-')).map(name => caches.delete(name)));
  }
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('civicos-') || /^sb-.+-auth-token$/.test(key)) localStorage.removeItem(key);
  }
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith('civicos-')) sessionStorage.removeItem(key);
  }
}
