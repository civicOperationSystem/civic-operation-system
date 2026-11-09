'use client';
import { useEffect, useState } from 'react';
import { readOrganizationDirectory, saveOrganizationDirectory } from '@/lib/portal-offline';
import { civicApi } from '@/lib/civic';

export default function usePublicOrganizationDirectory() {
  const [organizations, setOrganizations] = useState<{ name: string; slug: string }[]>([]);
  const [organizationsLoading, setOrganizationsLoading] = useState(true);
  const [organizationsError, setOrganizationsError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setOrganizationsLoading(true);
    setOrganizationsError('');
    void civicApi<{ name: string; slug: string }[]>('/public/organizations/list', { signal: abort.signal })
      .then(async items => {
        if (!Array.isArray(items) || items.some(item => !item || typeof item.name !== 'string' || typeof item.slug !== 'string')) {
          throw new Error('The organization directory returned invalid data. Check the backend deployment.');
        }
        await saveOrganizationDirectory(items);
        if (!abort.signal.aborted) setOrganizations(items);
      })
      .catch(async failure => {
        if (abort.signal.aborted) return;
        try {
          const cached = await readOrganizationDirectory();
          if (cached) setOrganizations(cached);
          else setOrganizationsError(failure instanceof Error ? failure.message : 'Could not load organizations');
        } catch (cacheFailure) {
          setOrganizationsError(cacheFailure instanceof Error ? cacheFailure.message : 'Could not read the saved organization directory');
        }
      })
      .finally(() => { if (!abort.signal.aborted) setOrganizationsLoading(false); });
    return () => abort.abort();
  }, [attempt]);

  return {
    organizations,
    organizationsLoading,
    organizationsError,
    retryOrganizations: () => setAttempt(value => value + 1),
  };
}
