'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  queuePublicReport, readPortalCache, type PendingPublicReport, type PublicReport,
} from '@/lib/portal-offline';
import { getCivicSupabase, isCivicSupabaseConfigured } from '@/lib/supabase';
import useOfflineSessionLock from './useOfflineSessionLock';

type Options = {
  slug: string | undefined;
  setPendingReports: (reports: PendingPublicReport[] | ((current: PendingPublicReport[]) => PendingPublicReport[])) => void;
};

function resetReportForm() {
  const form = document.getElementById('portal-report-form');
  if (form instanceof HTMLFormElement) form.reset();
}

export default function useOfflinePublicReports({ slug, setPendingReports }: Options) {
  const security = useOfflineSessionLock();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<PublicReport | null>(null);
  const [error, setError] = useState('');
  const wasUnlocked = useRef(false);

  useEffect(() => {
    if (wasUnlocked.current && !security.unlocked) {
      setPendingReports(current => current.map(({ report, ...item }) => ({ ...item, locked: !!report })));
      setDraft(null);
      setDialogOpen(false);
      resetReportForm();
    }
    wasUnlocked.current = security.unlocked;
  }, [security.unlocked, setPendingReports]);

  const queue = useCallback(async (report: PublicReport, id?: string): Promise<PendingPublicReport | null> => {
    try { return await queuePublicReport(slug || '', report, id); }
    catch (failure) {
      if (!navigator.onLine && !security.unlocked) {
        setDraft(report);
        setDialogOpen(true);
        setError('');
        return null;
      }
      throw failure;
    }
  }, [security.unlocked, slug]);

  const submitPassphrase = useCallback(async (passphrase: string, confirmation: string) => {
    setError('');
    if (!await security.submitPassphrase(passphrase, confirmation)) return false;
    if (draft) {
      try {
        if (!slug) throw new Error('Open a portal online before saving an offline report.');
        const pending = await queuePublicReport(slug, draft);
        setPendingReports(current => [...current, pending]);
        resetReportForm();
        setDraft(null);
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Could not save this offline report.');
        return false;
      }
    } else if (slug) {
      const cached = await readPortalCache(slug);
      if (cached) setPendingReports(cached.reports);
    }
    setDialogOpen(false);
    return true;
  }, [draft, security.submitPassphrase, setPendingReports, slug]);

  const unlockSavedReports = useCallback(() => {
    setError('');
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setDraft(null);
  }, []);

  const clearDevice = useCallback(async () => {
    if (!window.confirm('Clear all CivicOS offline data, cached pages, and saved sign-in sessions for every organization on this browser? Pending reports and field updates will be permanently deleted.')) return false;
    try {
      if (isCivicSupabaseConfigured()) {
        const { error: authError } = await getCivicSupabase().auth.signOut({ scope: 'local' });
        if (authError) throw authError;
      }
      const cleared = await security.clearDevice();
      if (cleared) {
        setPendingReports([]);
        setDraft(null);
        setDialogOpen(false);
        resetReportForm();
      }
      return cleared;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not clear offline data.');
      return false;
    }
  }, [security.clearDevice, setPendingReports]);

  return {
    configured: security.configured,
    error: error || security.error,
    unlocked: security.unlocked,
    dialogOpen,
    queue,
    submitPassphrase,
    unlockSavedReports,
    closeDialog,
    clearDevice,
  };
}
