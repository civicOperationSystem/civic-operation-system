'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  clearCivicOSOfflineData, createOfflineVault, lockOfflineVault, offlineVaultConfigured,
  unlockOfflineVault,
} from '@/lib/offline-security';

const idleTimeoutMs = 5 * 60 * 1000;

export default function useOfflineSessionLock() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    void offlineVaultConfigured().then(value => {
      if (active) { setConfigured(value); setUnlocked(false); }
    }).catch(failure => {
      if (active) setError(failure instanceof Error ? failure.message : 'Could not load offline security settings.');
    });
    return () => { active = false; };
  }, []);

  useEffect(() => () => lockOfflineVault(), []);

  const submitPassphrase = useCallback(async (passphrase: string, confirmPassphrase: string): Promise<boolean> => {
    setError('');
    try {
      if (configured === false) {
        if (passphrase !== confirmPassphrase) throw new Error('The passphrases do not match.');
        await createOfflineVault(passphrase);
        setConfigured(true);
      } else {
        await unlockOfflineVault(passphrase);
      }
      setUnlocked(true);
      setRevision(value => value + 1);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not unlock offline data.');
      return false;
    }
  }, [configured]);

  const clearDevice = useCallback(async (): Promise<boolean> => {
    setError('');
    try {
      await clearCivicOSOfflineData();
      setConfigured(false);
      setUnlocked(false);
      setRevision(value => value + 1);
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not clear offline data.');
      return false;
    }
  }, []);

  useEffect(() => {
    if (!unlocked) return;
    let timer = window.setTimeout(lockOfflineVault, idleTimeoutMs);
    const activity = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lockOfflineVault, idleTimeoutMs);
    };
    const background = () => { if (document.visibilityState === 'hidden') lockOfflineVault(); };
    const locked = () => setUnlocked(false);
    const channel = typeof BroadcastChannel === 'undefined'
      ? null
      : new BroadcastChannel('civicos-offline-security');
    channel?.addEventListener('message', event => { if (event.data?.type === 'lock') locked(); });
    for (const event of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(event, activity, { passive: true });
    document.addEventListener('visibilitychange', background);
    window.addEventListener('civicos-offline-lock', locked);
    return () => {
      window.clearTimeout(timer);
      channel?.close();
      for (const event of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(event, activity);
      document.removeEventListener('visibilitychange', background);
      window.removeEventListener('civicos-offline-lock', locked);
    };
  }, [unlocked]);

  return { configured, unlocked, error, revision, submitPassphrase, clearDevice };
}
