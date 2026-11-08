'use client';

import { useEffect, useState } from 'react';
import type { RequestDetail } from '@/lib/civic';

export default function useWorkspaceFieldLocation(field: boolean, detail: RequestDetail | null) {
  const [fieldPoint, setFieldPoint] = useState<[number, number] | null>(null);
  const [fieldLongitude, setFieldLongitude] = useState('');
  const [fieldLatitude, setFieldLatitude] = useState('');
  const [editingFieldLocation, setEditingFieldLocation] = useState(false);

  useEffect(() => {
    if (!field) return;
    const location: [number, number] | null = detail?.longitude != null && detail.latitude != null
      ? [detail.longitude, detail.latitude] : null;
    setFieldPoint(location); setEditingFieldLocation(!location);
  }, [field, detail?.id, detail?.longitude, detail?.latitude]);

  useEffect(() => {
    setFieldLongitude(fieldPoint?.[0].toString() || '');
    setFieldLatitude(fieldPoint?.[1].toString() || '');
  }, [fieldPoint]);

  return {
    fieldPoint, setFieldPoint, fieldLongitude, setFieldLongitude,
    fieldLatitude, setFieldLatitude, editingFieldLocation, setEditingFieldLocation,
  };
}
