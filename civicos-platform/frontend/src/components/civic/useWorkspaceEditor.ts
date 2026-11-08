'use client';

import { useEffect, useState } from 'react';
import type { CivicRecord } from '@/lib/civic';

export default function useWorkspaceEditor() {
  const [calendarMonth, setCalendarMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [worker, setWorker] = useState('');
  const [roles, setRoles] = useState<Record<string, string[]>>({});
  const [newRole, setNewRole] = useState('');
  const [editingContent, setEditingContent] = useState<CivicRecord | null>(null);
  const [contentLongitude, setContentLongitude] = useState('');
  const [contentLatitude, setContentLatitude] = useState('');
  const [contentMapOpen, setContentMapOpen] = useState(false);

  useEffect(() => {
    setContentLongitude(editingContent?.longitude?.toString() ?? '');
    setContentLatitude(editingContent?.latitude?.toString() ?? '');
    setContentMapOpen(false);
  }, [editingContent]);

  const longitude = Number(contentLongitude);
  const latitude = Number(contentLatitude);
  const contentPoint = contentLongitude.trim() && contentLatitude.trim() &&
    Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90
    ? [longitude, latitude] as [number, number]
    : null;

  return {
    calendarMonth, setCalendarMonth, worker, setWorker, roles, setRoles, newRole, setNewRole,
    editingContent, setEditingContent, contentLongitude, setContentLongitude, contentLatitude,
    setContentLatitude, contentMapOpen, setContentMapOpen, contentPoint,
  };
}
