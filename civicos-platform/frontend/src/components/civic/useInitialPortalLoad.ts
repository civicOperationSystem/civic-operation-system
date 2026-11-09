'use client';
import { useEffect, useRef, useState } from 'react';

type LoadPortal = (slug?: string, refresh?: boolean, signal?: AbortSignal) => Promise<void>;

export default function useInitialPortalLoad(
  initialSlug: string,
  loadPortal: LoadPortal,
  onTimeout: () => void,
) {
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(loadPortal);
  const timeoutRef = useRef(onTimeout);
  loadRef.current = loadPortal;
  timeoutRef.current = onTimeout;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    const timeout = window.setTimeout(() => {
      controller.abort();
      if (!active) return;
      setLoading(false);
      timeoutRef.current();
    }, 10000);
    void loadRef.current(initialSlug || params.get('org') || undefined, false, controller.signal)
      .finally(() => {
        window.clearTimeout(timeout);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [initialSlug, attempt]);

  return { loading, retry: () => setAttempt(value => value + 1) };
}
