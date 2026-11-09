'use client';

import { FormEvent, useState } from 'react';
import styles from './civic.module.css';

type Props = {
  configured: boolean | null;
  error: string;
  onSubmit(passphrase: string, confirmation: string): Promise<boolean>;
  onUnlocked(): Promise<void>;
  onClose(): void;
};

export default function OfflineReportSecurityDialog({
  configured, error, onSubmit, onUnlocked, onClose,
}: Props) {
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    try {
      if (await onSubmit(String(data.get('passphrase')), String(data.get('confirmation') || ''))) {
        form.reset();
        await onUnlocked();
      }
    } finally { setBusy(false); }
  }

  return <div className={styles.securityBackdrop} role="presentation">
    <section className={styles.securityDialog} role="dialog" aria-modal="true" aria-labelledby="report-security-title">
      <button type="button" className={styles.dialogClose} aria-label="Close offline report protection" onClick={onClose}>×</button>
      <h2 id="report-security-title">{configured === false ? 'Protect this offline report' : 'Unlock saved reports'}</h2>
      <p className={styles.hint}>{configured === false
        ? 'Set a passphrase of at least 12 characters to encrypt this report’s contact details and photos on this device.'
        : 'Enter your offline passphrase to access and send reports saved on this device.'}</p>
      {configured !== null && <form onSubmit={submit} className={styles.securityForm}>
        <label>Offline passphrase<input autoComplete="current-password" minLength={12} name="passphrase" required type="password" /></label>
        {configured === false && <label>Confirm offline passphrase<input autoComplete="new-password" minLength={12} name="confirmation" required type="password" /></label>}
        <button disabled={busy}>{busy ? 'Please wait…' : configured ? 'Unlock saved reports' : 'Set passphrase and encrypt report'}</button>
      </form>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </section>
  </div>;
}
