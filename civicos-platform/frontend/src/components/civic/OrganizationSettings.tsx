'use client';
import { useEffect, useState } from 'react';
import type { Portal, Settings, WorkflowState } from '@/lib/civic';
import styles from './civic.module.css';

export default function OrganizationSettings({ portal, busy, onSave }: {
  portal: Portal; busy: boolean; onSave: (name: string, settings: Settings) => void;
}) {
  const [name, setName] = useState(portal.name);
  const [settings, setSettings] = useState(portal.settings);
  useEffect(() => { setName(portal.name); setSettings(portal.settings); }, [portal]);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setSettings(current => ({ ...current, [key]: value }));
  const updateState = (index: number, change: Partial<WorkflowState>) =>
    set('states', settings.states.map((state, item) => item === index ? { ...state, ...change } : state));
  return <section>
    <p className={styles.hint}>Organization settings apply to all three experiences. Custom domains require administrator provisioning after DNS ownership verification. The language controls document language and date formatting; interface copy is currently English.</p>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); onSave(name, settings); }}>
      <div className={styles.twoColumns}>
        <section className={styles.form}>
          <h3>Identity & branding</h3>
          <label>Organization name<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
          <label>Logo URL (HTTPS)<input type="url" value={settings.logo} onChange={event => set('logo', event.target.value)} /></label>
          <label>Brand color<input type="color" value={settings.color} onChange={event => set('color', event.target.value)} /></label>
          <label>Timezone<input required value={settings.timezone} onChange={event => set('timezone', event.target.value)} placeholder="Europe/Rome" /></label>
          <label>Language / locale<input required value={settings.language} onChange={event => set('language', event.target.value)} placeholder="en, it, fr, en-US" /></label>
          <label>Public contact information<textarea rows={3} maxLength={1000} value={settings.contact} onChange={event => set('contact', event.target.value)} /></label>
          <div className={styles.inline}>
            <label>Map center longitude<input type="number" required step="any" min={-180} max={180} value={settings.center[0]} onChange={event => set('center', [Number(event.target.value), settings.center[1]])} /></label>
            <label>Map center latitude<input type="number" required step="any" min={-90} max={90} value={settings.center[1]} onChange={event => set('center', [settings.center[0], Number(event.target.value)])} /></label>
          </div>
        </section>
        <section className={styles.form}>
          <h3>Community operations</h3>
          {(['locations', 'departments', 'services', 'categories'] as const).map(key =>
            <label key={key}>{key === 'categories' ? 'Request categories' : key.charAt(0).toUpperCase() + key.slice(1)} (one per line)
              <textarea rows={4} value={settings[key].join('\n')} onChange={event => set(key, event.target.value.split('\n'))} />
            </label>)}
          <label className={styles.checkbox}><input type="checkbox" checked={settings.anonymous} onChange={event => set('anonymous', event.target.checked)} /> Allow anonymous resident reports</label>
        </section>
      </div>
      <h3>Request workflow</h3>
      <p className={styles.hint}>Keys are permanent identifiers. Existing and historical states cannot be removed. Choose allowed next states and whether assigned field workers may enter each state. Leave next states empty for the final state.</p>
      <div className={styles.cards}>{settings.states.map((state, index) => <section key={index} className={`${styles.card} ${styles.form}`}>
        <label>State key<input required pattern="[a-z_]{2,40}" value={state.key} disabled={index === 0} onChange={event => updateState(index, { key: event.target.value })} /></label>
        <label>Public status label<input required maxLength={100} value={state.label} onChange={event => updateState(index, { label: event.target.value })} /></label>
        <label>Allowed next states<select multiple value={state.next} onChange={event => updateState(index, { next: Array.from(event.target.selectedOptions).map(option => option.value) })}>
          {settings.states.filter(candidate => candidate.key !== state.key && candidate.key !== 'submitted').map(candidate => <option key={candidate.key} value={candidate.key}>{candidate.label || candidate.key}</option>)}
        </select></label>
        <label className={styles.checkbox}><input type="checkbox" checked={state.field ?? ['in_progress', 'completed'].includes(state.key)} onChange={event => updateState(index, { field: event.target.checked })} /> Field workers may enter this state</label>
        {index > 0 && <button type="button" className={styles.secondary} onClick={() => set('states', settings.states.filter((_, item) => item !== index).map(item => ({ ...item, next: item.next.filter(key => key !== state.key) })))}>Remove state</button>}
      </section>)}</div>
      <button type="button" className={styles.secondary} disabled={settings.states.length >= 20} onClick={() => {
        let key = 'new_state';
        let suffix = 1;
        while (settings.states.some(state => state.key === key)) key = `new_state_${'a'.repeat(suffix++)}`;
        set('states', [...settings.states, { key, label: 'New status', next: [], field: false }]);
      }}>Add workflow state</button>
      <button className={styles.primary} disabled={busy}>Save organization settings</button>
    </form>
  </section>;
}
