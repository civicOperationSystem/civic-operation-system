import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { getCivicSupabase } from '@/lib/supabase';

type StringSetter = Dispatch<SetStateAction<string>>;
type BusySetter = Dispatch<SetStateAction<boolean>>;

export async function sendWorkspaceLogin(
  event: FormEvent<HTMLFormElement>, field: boolean, slug: string,
  setBusy: BusySetter, setError: StringSetter, setNotice: StringSetter,
): Promise<void> {
  event.preventDefault(); setError(''); setBusy(true);
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const { error } = await getCivicSupabase().auth.signInWithOtp({
      email: String(data.get('email')).trim().toLowerCase(),
      options: {
        shouldCreateUser: true,
        emailRedirectTo: `${window.location.origin}${field ? '/field' : '/staff'}?org=${encodeURIComponent(slug)}`,
      },
    });
    if (error) throw error;
    setNotice('If that email belongs to an active CivicOS account, a one-time sign-in link has been sent.');
    form.reset();
  } catch (failure) {
    setError(failure instanceof Error ? failure.message : 'Could not send a sign-in link');
  } finally { setBusy(false); }
}

export async function performWorkspaceAction(
  work: () => Promise<void>, success: string,
  setBusy: BusySetter, setError: StringSetter, setNotice: StringSetter,
): Promise<void> {
  setBusy(true); setError(''); setNotice('');
  try { await work(); setNotice(success); }
  catch (failure) { setError(failure instanceof Error ? failure.message : 'Operation failed'); }
  finally { setBusy(false); }
}
