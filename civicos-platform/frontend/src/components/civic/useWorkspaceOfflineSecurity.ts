'use client';

import { useCallback, useEffect } from 'react';
import { getCivicSupabase, isCivicSupabaseConfigured } from '@/lib/supabase';
import { lockOfflineVault } from '@/lib/offline-security';
import useOfflineSessionLock from './useOfflineSessionLock';

type Options = { lockFieldCache(): void; clearSensitiveState(): void; setError(message: string): void };

export default function useWorkspaceOfflineSecurity({ lockFieldCache, clearSensitiveState, setError }: Options) {
  const security = useOfflineSessionLock();

  useEffect(() => {
    if (security.unlocked) return;
    lockFieldCache();
    clearSensitiveState();
  }, [security.unlocked, lockFieldCache, clearSensitiveState]);

  const clearDeviceData = useCallback(async () => {
    if (isCivicSupabaseConfigured()) {
      const { error } = await getCivicSupabase().auth.signOut({ scope: 'local' });
      if (error) throw error;
    }
    if (!await security.clearDevice()) throw new Error('Could not clear offline data. See the security message for details.');
    lockFieldCache();
  }, [lockFieldCache, security.clearDevice]);

  const clearOfflineData = useCallback(async () => {
    if (!window.confirm('Clear all CivicOS offline data, cached pages, and saved sign-in sessions for every organization on this browser? Pending offline reports and field updates will be permanently deleted.')) return;
    try { await clearDeviceData(); }
    catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not clear offline data.');
    }
  }, [clearDeviceData, setError]);

  return {
    ...security,
    clearOfflineData,
    clearDeviceData,
    lockOfflineData: lockOfflineVault,
  };
}
