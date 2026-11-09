'use client';

import OfflineSecurityGate from './OfflineSecurityGate';
import type useOfflineSessionLock from './useOfflineSessionLock';

type Props = Pick<ReturnType<typeof useOfflineSessionLock>, 'configured' | 'error' | 'submitPassphrase'> & {
  onClear(): Promise<void>;
};

export default function OfflineWorkspaceGate({ configured, error, submitPassphrase, onClear }: Props) {
  return <OfflineSecurityGate
    configured={configured}
    error={error}
    onSubmit={submitPassphrase}
    onClear={onClear}
  />;
}
