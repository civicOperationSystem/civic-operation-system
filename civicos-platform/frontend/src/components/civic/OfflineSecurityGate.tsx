'use client';

import { FormEvent, useState } from 'react';
import styles from './civic.module.css';

export default function OfflineSecurityGate({ configured, error, onSubmit, onClear }: {
  configured: boolean | null;
  error: string;
  onSubmit: (passphrase: string, confirmation: string) => Promise<void | boolean>;
  onClear: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = event.currentTarget;
    const data = new FormData(form);
    await onSubmit(String(data.get('passphrase')), String(data.get('confirmation') || ''));
    form.reset();
    setBusy(false);
  }

  async function clear() {
    if (!window.confirm('Clear all CivicOS offline data, cached pages, and saved sign-in sessions for every organization on this browser? Pending offline reports and field updates will be permanently deleted.')) return;
    setBusy(true); setActionError('');
    try { await onClear(); }
    catch (failure) { setActionError(failure instanceof Error ? failure.message : 'Could not clear offline data.'); }
    finally { setBusy(false); }
  }

  return <main className={styles.shell}>
    <section className={styles.login} aria-labelledby="offline-security-title">
      <p className={styles.eyebrow}>DEVICE OFFLINE SECURITY</p>
      <h1 id="offline-security-title">{configured === false ? 'Protect offline access' : 'Unlock this device'}</h1>
      <p className={styles.hint}>{configured === false
        ? 'Create a passphrase of at least 12 characters. It encrypts cached staff and field data on this device. CivicOS cannot recover a forgotten passphrase.'
        : 'Enter your offline passphrase to decrypt saved staff and field data. The device locks after five minutes idle or as soon as this page is backgrounded.'}</p>
      {configured !== null && <form onSubmit={submit} className={styles.form}>
        <label>Offline passphrase<input name="passphrase" type="password" minLength={12} required autoComplete="current-password" /></label>
        {configured === false && <label>Confirm offline passphrase<input name="confirmation" type="password" minLength={12} required autoComplete="new-password" /></label>}
        <button disabled={busy} className={styles.primary}>{busy ? 'Please wait…' : configured ? 'Unlock offline data' : 'Set passphrase'}</button>
      </form>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {actionError && <p role="alert" className={styles.error}>{actionError}</p>}
      <button type="button" className={styles.secondary} disabled={busy} onClick={() => void clear()}>
        Clear this device’s offline data
      </button>
    </section>
  </main>;
}
