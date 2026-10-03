// Data access layer. Each function talks to Supabase, or falls back to the
// in-memory demo store when Supabase isn't configured.
import { addDays, toISODate } from './format';
import { mockStore } from './mockData';
import { supabase } from './supabase';
import type { Activity, CoachAssessment, CoachingPlan, PlanStatus, Profile, Race } from './types';

export const isDemo = supabase === null;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => structuredClone(v);

async function currentUserId(): Promise<string> {
  const { data } = await supabase!.auth.getUser();
  if (!data.user) throw new Error('לא מחובר/ת');
  return data.user.id;
}

// ---------------- Activities ----------------
const ACTIVITY_COLUMNS =
  'id, garmin_activity_id, start_time, name, distance_m, duration_s, avg_pace_sec_per_km, gap_sec_per_km, avg_hr, max_hr, elevation_gain_m, training_load';

export async function fetchActivities(days = 70): Promise<Activity[]> {
  if (!supabase) {
    await delay(250);
    return clone(mockStore.activities);
  }
  const since = addDays(new Date(), -days).toISOString();
  const { data, error } = await supabase
    .from('activities')
    .select(ACTIVITY_COLUMNS)
    .gte('start_time', since)
    .order('start_time', { ascending: false });
  if (error) throw error;
  return data as Activity[];
}

// ---------------- Garmin (cloud sync via GitHub Actions worker) ----------------
export interface GarminLink {
  garmin_email: string;
  status: 'pending' | 'ok' | 'auth_error' | 'mfa_required' | 'error';
  last_error: string | null;
  last_sync_at: string | null;
  sync_requested_at: string | null;
}

export async function fetchGarminLink(): Promise<GarminLink | null> {
  if (!supabase) {
    return {
      garmin_email: 'demo@example.com',
      status: 'ok',
      last_error: null,
      last_sync_at: mockStore.profile.garmin_last_sync_at,
      sync_requested_at: null,
    };
  }
  // Explicit columns: secret ids are not readable by clients.
  const { data, error } = await supabase
    .from('garmin_links')
    .select('garmin_email, status, last_error, last_sync_at, sync_requested_at')
    .maybeSingle();
  if (error) throw error;
  return data as GarminLink | null;
}

/** Credentials go straight into Supabase Vault (encrypted); they are never read back. */
export async function saveGarminCredentials(email: string, password: string): Promise<void> {
  if (!supabase) {
    await delay(500);
    return;
  }
  const { error } = await supabase.rpc('set_garmin_credentials', { p_email: email, p_password: password });
  if (error) throw error;
}

export async function removeGarminCredentials(): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.rpc('remove_garmin_credentials');
  if (error) throw error;
}

/** Queue a sync; the cloud worker picks it up within ~30 minutes. */
export async function syncGarmin(): Promise<{ queued: boolean }> {
  if (!supabase) {
    await delay(1200);
    mockStore.profile.garmin_last_sync_at = new Date().toISOString();
    return { queued: true };
  }
  const link = await fetchGarminLink();
  if (!link) throw new Error('עדיין לא חיברתם Garmin — עשו זאת במסך ההגדרות');
  const { error } = await supabase.rpc('request_garmin_sync');
  if (error) throw error;
  return { queued: true };
}

// ---------------- Plan ----------------
export async function fetchPlan(from: string, to: string): Promise<CoachingPlan[]> {
  if (!supabase) {
    await delay(200);
    return clone(mockStore.plan.filter((p) => p.plan_date >= from && p.plan_date <= to));
  }
  const { data, error } = await supabase
    .from('coaching_plans')
    .select('*')
    .gte('plan_date', from)
    .lte('plan_date', to)
    .order('plan_date');
  if (error) throw error;
  return data as CoachingPlan[];
}

export async function updatePlanStatus(id: string, status: PlanStatus): Promise<void> {
  if (!supabase) {
    const p = mockStore.plan.find((x) => x.id === id);
    if (p) p.status = status;
    return;
  }
  const { error } = await supabase.from('coaching_plans').update({ status }).eq('id', id);
  if (error) throw error;
}

export interface RecalibrateResult {
  assessment: CoachAssessment;
  workouts: CoachingPlan[];
}

export async function recalibratePlan(): Promise<RecalibrateResult> {
  const today = toISODate(new Date());
  if (!supabase) {
    await delay(2200);
    // Demo: pretend Gemini saw good recovery and eased today's adjustment.
    const t = mockStore.plan.find((p) => p.plan_date === today);
    if (t && t.workout_type !== 'rest' && t.adjustment_sec > 0) {
      t.target_pace_fast_sec_km! -= 5;
      t.target_pace_slow_sec_km! -= 5;
      t.adjustment_sec -= 5;
      t.adaptation_note = `הקצב הואט ב-${t.adjustment_sec} שנ׳ — ההתאוששות השתפרה מאתמול`;
    }
    mockStore.assessment = {
      ...mockStore.assessment,
      assessed_at: new Date().toISOString(),
      readiness_score: Math.min(100, mockStore.assessment.readiness_score + 4),
    };
    return { assessment: clone(mockStore.assessment), workouts: clone(mockStore.plan) };
  }
  const { data, error } = await supabase.functions.invoke<RecalibrateResult>('recalibrate-plan', {
    body: { today, days: 28 },
  });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const msg = ctx ? (await ctx.json().catch(() => null))?.error : null;
    throw new Error(msg ?? error.message);
  }
  return data!;
}

// ---------------- Assessment / races ----------------
export async function fetchLatestAssessment(): Promise<CoachAssessment | null> {
  if (!supabase) return clone(mockStore.assessment);
  const { data, error } = await supabase
    .from('coach_assessments')
    .select('*')
    .order('assessed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as CoachAssessment | null;
}

export async function fetchRaces(): Promise<Race[]> {
  if (!supabase) return clone(mockStore.races);
  const { data, error } = await supabase
    .from('races')
    .select('*')
    .gte('race_date', toISODate(new Date()))
    .order('race_date');
  if (error) throw error;
  return data as Race[];
}

export async function addRace(race: Omit<Race, 'id'>): Promise<void> {
  if (!supabase) {
    mockStore.races.push({ ...race, id: `r${Date.now()}` });
    mockStore.races.sort((a, b) => a.race_date.localeCompare(b.race_date));
    return;
  }
  const user_id = await currentUserId();
  const { error } = await supabase.from('races').insert({ ...race, user_id });
  if (error) throw error;
}

export async function deleteRace(id: string): Promise<void> {
  if (!supabase) {
    mockStore.races = mockStore.races.filter((r) => r.id !== id);
    return;
  }
  const { error } = await supabase.from('races').delete().eq('id', id);
  if (error) throw error;
}

// ---------------- Profile & settings ----------------
export async function fetchProfile(): Promise<Profile> {
  if (!supabase) return clone(mockStore.profile);
  const id = await currentUserId();
  const { data, error } = await supabase.from('profiles').select('*').eq('id', id).single();
  if (error) throw error;
  return data as Profile;
}

export async function updateProfile(patch: Partial<Pick<Profile, 'display_name' | 'hr_max' | 'hr_rest' | 'weekly_km_target'>>) {
  if (!supabase) {
    Object.assign(mockStore.profile, patch);
    return;
  }
  const id = await currentUserId();
  const { error } = await supabase.from('profiles').update(patch).eq('id', id);
  if (error) throw error;
}

export async function hasGeminiKey(): Promise<boolean> {
  if (!supabase) return mockStore.geminiKeySet;
  const { data, error } = await supabase.rpc('has_gemini_api_key');
  if (error) throw error;
  return Boolean(data);
}

/** The key is write-only from the client: stored server-side, never read back. */
export async function saveGeminiKey(key: string): Promise<void> {
  if (!supabase) {
    await delay(400);
    mockStore.geminiKeySet = key.trim().length > 0;
    return;
  }
  const { error } = await supabase.rpc('set_gemini_api_key', { p_key: key });
  if (error) throw error;
}

export async function signOut() {
  await supabase?.auth.signOut();
}
