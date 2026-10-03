// Data access layer. Each function talks to Supabase, or falls back to the
// in-memory demo store when Supabase isn't configured.
import { addDays, toISODate } from './format';
import { assess, buildPlan } from './planner';
import { estimateVdot, marathonShape, prescribeWeek, trainingPaces, vdotFromPerformance } from './science';
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
    await delay(900);
    return recalibrateDemo(today);
  }
  const { data, error } = await supabase.functions.invoke<RecalibrateResult>('recalibrate-plan', {
    body: { today },
  });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const msg = ctx ? (await ctx.json().catch(() => null))?.error : null;
    throw new Error(msg ?? error.message);
  }
  return data!;
}

/** Demo mode runs the exact same research engine locally on mock data. */
function recalibrateDemo(today: string): RecalibrateResult {
  const { activities, races, profile } = mockStore;
  const now = Date.parse(`${today}T23:59:59`);
  const age = (a: Activity) => (now - Date.parse(a.start_time)) / 86_400_000;
  const last28 = activities.filter((a) => age(a) >= 0 && age(a) <= 28);
  const last7 = last28.filter((a) => age(a) <= 7);
  const load = (xs: Activity[]) => xs.reduce((s, a) => s + (a.training_load ?? a.duration_s / 60), 0);
  const km = (xs: Activity[]) => xs.reduce((s, a) => s + a.distance_m / 1000, 0);
  const acwr = last28.length >= 4 ? Math.round((load(last7) / (load(last28) / 4)) * 100) / 100 : null;
  const avgWeekly = Math.round((km(last28) / 4) * 10) / 10;

  const prevVdot = mockStore.assessment.vdot ?? null;
  const goal = races.find((r) => r.priority === 'A' && r.target_time_s);
  const fallback = goal ? vdotFromPerformance(goal.distance_km * 1000, goal.target_time_s!) - 2 : 40;
  const vdot = estimateVdot(activities, profile.hr_max, profile.hr_rest, today, prevVdot, fallback);
  const paces = trainingPaces(vdot.vdot);
  const week = prescribeWeek({ today, races, avgWeeklyKm28: avgWeekly, km7: km(last7), acwr });
  const days = buildPlan({
    today,
    vdot: vdot.vdot,
    previousVdot: prevVdot,
    paces,
    week,
    races,
    runsPerWeek: Math.min(6, Math.max(4, Math.round(last28.length / 4))),
    acwr,
    previousPlan: mockStore.plan,
  });
  const a = assess({ vdot: vdot.vdot, previousVdot: prevVdot, acwr, km7: km(last7), avgWeeklyKm28: avgWeekly, daysSinceLastRun: 1, week });

  const byDate = new Map(mockStore.plan.map((p) => [p.plan_date, p]));
  for (const d of days) {
    const existing = byDate.get(d.date);
    if (existing && existing.status !== 'planned') continue;
    const row: CoachingPlan = { ...d, id: existing?.id ?? `demo-${d.date}`, plan_date: d.date, status: 'planned' };
    if (existing) Object.assign(existing, row);
    else mockStore.plan.push(row);
  }
  mockStore.plan.sort((x, y) => x.plan_date.localeCompare(y.plan_date));
  const longest = Math.max(0, ...last28.map((x) => x.distance_m / 1000));
  const marathon = races.find((r) => r.distance_km > 40);
  mockStore.assessment = {
    id: `demo-assess-${Date.now()}`,
    assessed_at: new Date().toISOString(),
    fatigue_level: a.fatigue_level,
    readiness_score: a.readiness_score,
    marathon_shape_pct: marathonShape(vdot.vdot, marathon?.target_time_s ?? null, longest, avgWeekly),
    acwr,
    summary: a.summary,
    vdot: vdot.vdot,
    vdot_source: vdot.source,
    training_paces: paces,
    phase: week.phase,
    weekly_km_target: week.weeklyKmTarget,
  };
  return { assessment: clone(mockStore.assessment), workouts: clone(mockStore.plan) };
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
