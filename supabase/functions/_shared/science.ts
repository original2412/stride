// Research-based training math. Pure TS (no runtime APIs) — shared verbatim with
// supabase/functions/_shared/science.ts. Keep the two files identical.
//
// Sources:
// - Daniels & Gilbert (1979) oxygen-cost and %VO2max-vs-duration curves → VDOT.
// - Daniels' Running Formula: training intensities as fractions of VDOT,
//   quality-volume caps (T ≤ 10%, I ≤ 8%, R ≤ 5% of weekly volume).
// - Swain et al. (1994): %HRR ≈ %VO2R → VO2max estimate from submax HR.
// - Gabbett (2016): acute:chronic workload ratio, sweet spot 0.8–1.3.
// - Seiler (2010): ~80/20 polarized intensity distribution.
// - Pfitzinger: periodization (base → build → specific → taper), 3:1 load/recovery weeks.

export interface ScienceActivity {
  start_time: string;
  distance_m: number;
  duration_s: number;
  gap_sec_per_km: number | null;
  avg_hr: number | null;
}

export interface ScienceRace {
  name: string;
  race_date: string;
  distance_km: number;
  target_time_s: number | null;
  priority: string;
}

export type ZoneKey = 'recovery' | 'easy' | 'marathon' | 'threshold' | 'interval' | 'repetition';

export interface PaceZone {
  fast: number; // sec/km
  slow: number; // sec/km
}

export type PaceZones = Record<ZoneKey, PaceZone>;

// ---------------- Daniels & Gilbert ----------------

/** VO2 (ml/kg/min) at velocity v (m/min). */
export function vo2AtVelocity(v: number): number {
  return -4.6 + 0.182258 * v + 0.000104 * v * v;
}

/** Fraction of VO2max sustainable for t minutes. */
export function fractionOfVo2max(tMin: number): number {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);
}

export function vdotFromPerformance(distanceM: number, timeS: number): number {
  const t = timeS / 60;
  return vo2AtVelocity(distanceM / t) / fractionOfVo2max(t);
}

/** Velocity (m/min) that costs `vo2`. Inverse of vo2AtVelocity. */
export function velocityAtVo2(vo2: number): number {
  const a = 0.000104, b = 0.182258, c = -4.6 - vo2;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

function paceAt(vdot: number, fraction: number): number {
  return Math.round(60000 / velocityAtVo2(vdot * fraction));
}

/** Predicted race time (s) for a distance at a given VDOT (bisection). */
export function predictRaceTime(vdot: number, distanceM: number): number {
  let lo = distanceM / 400 * 60, hi = distanceM / 50 * 60; // 24 km/h .. 3 km/h
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vdotFromPerformance(distanceM, mid) > vdot) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

/** Daniels training paces. Fractions calibrated against the Running Formula tables. */
export function trainingPaces(vdot: number): PaceZones {
  const mPace = Math.round(predictRaceTime(vdot, 42195) / 42.195);
  return {
    recovery: { fast: paceAt(vdot, 0.62), slow: paceAt(vdot, 0.56) },
    easy: { fast: paceAt(vdot, 0.7), slow: paceAt(vdot, 0.62) },
    marathon: { fast: mPace - 5, slow: mPace + 5 },
    threshold: { fast: paceAt(vdot, 0.885), slow: paceAt(vdot, 0.86) },
    interval: { fast: paceAt(vdot, 1.0), slow: paceAt(vdot, 0.96) },
    repetition: { fast: paceAt(vdot, 1.08), slow: paceAt(vdot, 1.04) },
  };
}

// ---------------- Fitness estimate ----------------

export interface VdotEstimate {
  vdot: number;
  source: 'performance' | 'heart_rate' | 'blended' | 'default';
  samples: number;
}

/**
 * Estimate VDOT from the last ~6 weeks of runs.
 * - Performance VDOT (best run) is a lower bound: you can't run faster than your fitness.
 * - HR-based estimate (Swain %HRR≈%VO2R) uses submax runs, so easy days still count.
 * - Change vs the previous estimate is capped so fitness moves gradually.
 */
export function estimateVdot(
  activities: ScienceActivity[],
  hrMax: number,
  hrRest: number,
  today: string,
  previous: number | null = null,
  fallback = 40,
): VdotEstimate {
  const cutoff = Date.parse(today) - 42 * 86_400_000;
  const recent = activities.filter((a) => Date.parse(a.start_time) >= cutoff && a.distance_m >= 3000 && a.duration_s >= 900);

  let perf = 0;
  const hrEstimates: number[] = [];
  for (const a of recent) {
    const timeS = a.gap_sec_per_km ? (a.gap_sec_per_km * a.distance_m) / 1000 : a.duration_s;
    perf = Math.max(perf, vdotFromPerformance(a.distance_m, timeS));

    if (a.avg_hr && hrMax > hrRest) {
      const hrr = (a.avg_hr - hrRest) / (hrMax - hrRest);
      if (hrr >= 0.5 && hrr <= 0.95) {
        const vo2 = vo2AtVelocity(a.distance_m / (timeS / 60));
        hrEstimates.push(3.5 + (vo2 - 3.5) / hrr);
      }
    }
  }

  let est: VdotEstimate;
  if (hrEstimates.length >= 3) {
    const sorted = [...hrEstimates].sort((x, y) => x - y);
    const median = sorted[Math.floor(sorted.length / 2)];
    // HR estimates are noisy; never trust them far above what was actually run.
    const hrVdot = perf ? Math.min(median, perf * 1.15) : median;
    est = { vdot: Math.max(perf, hrVdot), source: perf > hrVdot ? 'performance' : 'blended', samples: recent.length };
  } else if (perf) {
    // Without HR, mostly-easy training underestimates fitness; nudge up modestly.
    est = { vdot: perf * 1.05, source: 'performance', samples: recent.length };
  } else {
    est = { vdot: previous ?? fallback, source: 'default', samples: 0 };
  }

  if (previous) est.vdot = Math.min(previous + 1.5, Math.max(previous - 2, est.vdot));
  est.vdot = Math.round(Math.min(85, Math.max(25, est.vdot)) * 10) / 10;
  return est;
}

// ---------------- Periodization ----------------

export type Phase = 'base' | 'build' | 'specific' | 'taper' | 'race_week' | 'recovery';

export interface WeekPrescription {
  phase: Phase;
  weeksToARace: number | null;
  isRecoveryWeek: boolean;
  weeklyKmTarget: number;
  longRunKmMax: number;
  qualitySessions: number;
  maxThresholdKm: number;
  maxIntervalKm: number;
  maxRepetitionKm: number;
  notes: string[];
}

export function prescribeWeek(params: {
  today: string;
  races: ScienceRace[];
  avgWeeklyKm28: number;
  km7: number;
  acwr: number | null;
  weekIndexSinceStart?: number;
}): WeekPrescription {
  const { today, races, avgWeeklyKm28, acwr } = params;
  const t = Date.parse(today);
  const upcoming = races.filter((r) => Date.parse(r.race_date) >= t);
  const aRace = upcoming.find((r) => r.priority === 'A') ?? upcoming[0] ?? null;
  const weeksTo = (r: ScienceRace) => (Date.parse(r.race_date) - t) / (7 * 86_400_000);
  const weeksToA = aRace ? weeksTo(aRace) : null;
  const isMarathon = (aRace?.distance_km ?? 0) > 30;
  const notes: string[] = [];

  // Phase by weeks to the A race (Pfitzinger-style blocks).
  let phase: Phase = 'base';
  if (weeksToA !== null) {
    const taperWeeks = isMarathon ? 3 : 1.5;
    if (weeksToA < 1) phase = 'race_week';
    else if (weeksToA <= taperWeeks) phase = 'taper';
    else if (weeksToA <= 8) phase = 'specific';
    else if (weeksToA <= 16) phase = 'build';
  }

  // Mini-taper for a B race inside the next 10 days.
  const bRace = upcoming.find((r) => r !== aRace && weeksTo(r) <= 10 / 7);
  if (bRace) notes.push(`מיני-טייפר לקראת ${bRace.name} (מרוץ ${bRace.priority})`);

  // 3:1 loading — every 4th week is a recovery week (keyed to ISO week number).
  const weekNo = Math.floor(t / (7 * 86_400_000));
  const isRecoveryWeek = phase !== 'taper' && phase !== 'race_week' && weekNo % 4 === 3;

  // Volume: ≤10% growth over the 28-day average (and hold if ACWR is high).
  const base = Math.max(avgWeeklyKm28, 15);
  let target = base * 1.08;
  if (acwr !== null && acwr > 1.3) {
    target = base * 0.9;
    notes.push(`ACWR ${acwr.toFixed(2)} מעל 1.3 — מורידים עומס כדי להפחית סיכון לפציעה`);
  } else if (acwr !== null && acwr < 0.8) {
    notes.push(`ACWR ${acwr.toFixed(2)} נמוך — אפשר לבנות בהדרגה`);
  }
  if (isRecoveryWeek) {
    target = base * 0.8;
    notes.push('שבוע התאוששות (מחזור 3:1)');
  }
  if (phase === 'taper' && weeksToA !== null) {
    const factor = isMarathon ? (weeksToA > 2 ? 0.8 : weeksToA > 1 ? 0.6 : 0.45) : 0.65;
    target = base * factor;
    notes.push('טייפר — מורידים נפח, שומרים על עצימות');
  }
  if (phase === 'race_week') target = base * 0.4;
  if (bRace) target = Math.min(target, base * 0.75);

  const weeklyKmTarget = Math.round(target);
  const longCap = isMarathon ? 32 : 22;
  const longRunKmMax = Math.round(Math.min(longCap, weeklyKmTarget * (isMarathon ? 0.35 : 0.3)) * 10) / 10;

  const qualitySessions = phase === 'race_week' || isRecoveryWeek ? 1 : phase === 'base' ? 1 : 2;

  return {
    phase,
    weeksToARace: weeksToA === null ? null : Math.round(weeksToA * 10) / 10,
    isRecoveryWeek,
    weeklyKmTarget,
    longRunKmMax,
    qualitySessions,
    maxThresholdKm: Math.round(weeklyKmTarget * 0.1 * 10) / 10,
    maxIntervalKm: Math.round(Math.min(10, weeklyKmTarget * 0.08) * 10) / 10,
    maxRepetitionKm: Math.round(Math.min(8, weeklyKmTarget * 0.05) * 10) / 10,
    notes,
  };
}

/** Which pace zone governs a workout type. */
export const ZONE_FOR_WORKOUT: Record<string, ZoneKey | null> = {
  recovery: 'recovery',
  easy: 'easy',
  long: 'easy',
  progression: 'marathon',
  tempo: 'threshold',
  threshold: 'threshold',
  intervals: 'interval',
  race: null,
  rest: null,
};

/** Marathon readiness 0–100: fitness vs goal, long-run and volume readiness. */
export function marathonShape(vdot: number, targetTimeS: number | null, longestRun28Km: number, avgWeeklyKm28: number): number {
  const required = targetTimeS ? vdotFromPerformance(42195, targetTimeS) : vdot;
  const fitness = Math.min(1, vdot / required);
  const longRun = Math.min(1, longestRun28Km / 32);
  const volume = Math.min(1, avgWeeklyKm28 / 65);
  return Math.round(100 * (0.6 * fitness ** 3 + 0.25 * longRun + 0.15 * volume));
}
