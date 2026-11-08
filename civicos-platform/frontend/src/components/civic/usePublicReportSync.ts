'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { civicApi, CivicApiError } from '@/lib/civic';
import { readPortalCache, updatePublicReport, type PendingPublicReport } from '@/lib/portal-offline';

export default function usePublicReportSync(
  slug: string | undefined,
  online: boolean,
  setPendingReports: Dispatch<SetStateAction<PendingPublicReport[]>>,
  setSubmitted: Dispatch<SetStateAction<string>>,
  setError: Dispatch<SetStateAction<string>>,
) {
  const syncing = useRef(false);
  const syncReports = useCallback(async () => {
    if (!slug || !navigator.onLine || syncing.current) return;
    syncing.current = true;
    try {
      const cached = await readPortalCache(slug);
      for (const pending of cached?.reports.filter(item => !item.reference && !item.error) || []) {
        if (!navigator.onLine) break;
        if (!pending.report) continue;
        try {
          const response = await civicApi<{ reference: string }>(`/public/${slug}/requests`, {
            method: 'POST', body: { ...pending.report, client_operation_id: pending.id },
          });
          await updatePublicReport(slug, pending.id, current => ({
            ...current, reference: response.reference, report: undefined, error: undefined,
          }));
        } catch (failure) {
          const message = failure instanceof Error ? failure.message : 'Could not submit saved request';
          if (!navigator.onLine || failure instanceof TypeError ||
            failure instanceof CivicApiError && (failure.status === 429 || failure.status >= 500)) break;
          await updatePublicReport(slug, pending.id, current => ({ ...current, error: message }));
        }
      }
      const updated = await readPortalCache(slug);
      if (updated) {
        setPendingReports(updated.reports);
        const latest = [...updated.reports].reverse().find(item => item.reference);
        if (latest?.reference) setSubmitted(latest.reference);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not synchronize saved reports');
    } finally { syncing.current = false; }
  }, [slug, setError, setPendingReports, setSubmitted]);

  useEffect(() => { if (online) void syncReports(); }, [online, syncReports]);
  useEffect(() => {
    if (!online) return;
    const timer = window.setInterval(() => { void syncReports(); }, 30000);
    return () => window.clearInterval(timer);
  }, [online, syncReports]);

  return syncReports;
}
