import { supabase } from './supabase';

export const isPatientUser = async (): Promise<boolean> => {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.user_metadata?.role === 'patient';
};

export const getCurrentPatientId = async (): Promise<string | null> => {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.user_metadata?.patient_id ?? null;
};

export const getCurrentPatientLabId = async (): Promise<string | null> => {
  const { data: { user } } = await supabase.auth.getUser();
  return user?.user_metadata?.lab_id ?? null;
};

export const getCurrentPatientMeta = async (): Promise<{
  patient_id: string;
  lab_id: string;
  name: string;
  phone: string;
} | null> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.user_metadata?.role !== 'patient') return null;
  return {
    patient_id: user.user_metadata.patient_id,
    lab_id: user.user_metadata.lab_id,
    name: user.user_metadata.name,
    phone: user.user_metadata.phone,
  };
};

export interface PortalAccountOption {
  email: string;
  patient_name: string;
  lab_name: string;
}

export type PortalLoginResult =
  | { status: 'ok'; email: string; patient_name: string; lab_name: string }
  | { status: 'choose'; accounts: PortalAccountOption[] }
  | { status: 'failed'; reason: string; message: string };

const functionsBase = (): string => {
  const url =
    (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
    ((supabase as any).supabaseUrl as string);
  return `${url.replace(/\/$/, '')}/functions/v1`;
};

const anonKey = (): string =>
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ||
  ((supabase as any).supabaseKey as string);

// Step 1 of login: is this mobile number registered for portal access anywhere?
// Returns how many lab accounts it has — 0 means no access. Deliberately returns no
// names or lab names, so typing someone else's number reveals nothing about them.
export const countPatientPortalAccounts = async (phone: string): Promise<number> => {
  const { data, error } = await supabase.rpc('patient_portal_phone_access_count', {
    p_phone: phone,
  });
  if (error) throw error;
  return Number(data ?? 0);
};

// Step 2 of login: hand phone + PIN to the edge function, which checks the PIN against
// EVERY portal account on that number and returns the one it belongs to.
//
// The number can be registered at many labs (the same person tested at several, or a
// duplicate patient row). Resolving the number alone — as the old
// resolve_patient_virtual_email RPC did with LIMIT 1 — picked the oldest row and failed
// with invalid_credentials whenever the PIN belonged to any other account.
export const resolvePatientPortalLogin = async (
  phone: string,
  pin: string
): Promise<PortalLoginResult> => {
  let json: any;
  try {
    const res = await fetch(`${functionsBase()}/patient-portal-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey() },
      body: JSON.stringify({ phone, pin }),
    });
    json = await res.json();
  } catch {
    return { status: 'failed', reason: 'network', message: 'Unable to reach the server. Please check your connection and try again.' };
  }

  if (!json?.success) {
    return {
      status: 'failed',
      reason: json?.reason || 'error',
      message: json?.message || 'Unable to sign in. Please try again.',
    };
  }

  if (json.multiple) {
    return { status: 'choose', accounts: json.accounts as PortalAccountOption[] };
  }

  return {
    status: 'ok',
    email: json.email,
    patient_name: json.patient_name,
    lab_name: json.lab_name,
  };
};

// Final step: sign in with the resolved email + PIN
export const patientSignIn = async (email: string, pin: string) => {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: pin });
  if (error) throw new Error('Invalid PIN. Please check and try again.');
  return data;
};

// Called after the patient changes their own PIN: drops the PIN the lab recorded so
// the lab's patient page shows "patient set their own PIN" rather than a stale value.
export const forgetLabRecordedPin = async (): Promise<void> => {
  try {
    await supabase.rpc('patient_portal_forget_recorded_pin');
  } catch (err) {
    console.warn('Could not clear lab-recorded PIN:', err);
  }
};

export const patientSignOut = async () => {
  await supabase.auth.signOut();
};
