// Demo data — used when Supabase env vars are not configured.
import { addDays, toISODate } from './format';
import type { Activity, CoachAssessment, CoachingPlan, Profile, Race, WorkoutType } from './types';

// Deterministic PRNG so the demo looks the same on every reload.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

type Template = { type: WorkoutType; km: number; pace: number; hr: number; elev: number; name: string } | null;

// Sun..Sat
const WEEK_PATTERN: Template[] = [
  { type: 'easy', km: 8, pace: 412, hr: 142, elev: 45, name: 'ריצה קלה בוקר' },
  { type: 'intervals', km: 10, pace: 330, hr: 162, elev: 30, name: '6×800 במסלול' },
  null,
  { type: 'easy', km: 7, pace: 418, hr: 140, elev: 60, name: 'ריצת ערב בפארק' },
  { type: 'tempo', km: 11, pace: 315, hr: 165, elev: 70, name: 'טמפו 5 ק"מ' },
  { type: 'long', km: 20, pace: 395, hr: 148, elev: 150, name: 'ארוכה של שישי' },
  { type: 'recovery', km: 5, pace: 445, hr: 128, elev: 20, name: 'שחרור' },
];

function mockActivities(): Activity[] {
  const rand = rng(42);
  const today = new Date();
  const out: Activity[] = [];
  for (let i = 1; i <= 70; i++) {
    const d = addDays(today, -i);
    const t = WEEK_PATTERN[d.getDay()];
    if (!t) continue;
    if (rand() < 0.12) continue; // occasional missed run
    // Volume ramps up a bit over the weeks (older = less).
    const ramp = 1 - (i / 70) * 0.25;
    const km = +(t.km * ramp * (0.92 + rand() * 0.16)).toFixed(2);
    const pace = Math.round(t.pace * (0.97 + rand() * 0.06));
    const elev = Math.round(t.elev * (0.7 + rand() * 0.6));
    d.setHours(6 + Math.floor(rand() * 3), Math.floor(rand() * 60));
    out.push({
      id: `mock-act-${i}`,
      garmin_activity_id: 14_000_000_000 + i,
      start_time: d.toISOString(),
      name: t.name,
      distance_m: Math.round(km * 1000),
      duration_s: Math.round(km * pace),
      avg_pace_sec_per_km: pace,
      gap_sec_per_km: Math.round(pace - elev / km / 2.2),
      avg_hr: Math.round(t.hr + (rand() - 0.5) * 6),
      max_hr: Math.round(t.hr + 12 + rand() * 10),
      elevation_gain_m: elev,
      training_load: Math.round(km * (t.hr - 100) * 0.35),
    });
  }
  return out;
}

const PLAN_TEMPLATES: Record<number, Omit<CoachingPlan, 'id' | 'plan_date' | 'status'>> = {
  0: {
    workout_type: 'easy', title: 'ריצה קלה 45 דק׳', duration_min: 45, distance_km: 6.5,
    target_pace_fast_sec_km: 405, target_pace_slow_sec_km: 435, hr_zone: 2,
    description: 'כל הריצה בקצב שיחה. 4 האצות של 20 שנ׳ בסוף.',
    rationale: 'שבוע עמוס מאחוריך — שומרים על נפח אירובי בלי להעמיס.',
    adaptation_note: null, adjustment_sec: 0,
  },
  1: {
    workout_type: 'intervals', title: '5×1000 בקצב 10K', duration_min: 60, distance_km: 11,
    target_pace_fast_sec_km: 300, target_pace_slow_sec_km: 312, hr_zone: 4,
    description: 'חימום 15 דק׳ · 5×1000 מ׳ עם 2 דק׳ ג׳וג · שחרור 10 דק׳',
    rationale: 'בונים VO2max לקראת חצי המרתון בנובמבר.',
    adaptation_note: null, adjustment_sec: 0,
  },
  2: {
    workout_type: 'rest', title: 'יום מנוחה', duration_min: 0, distance_km: null,
    target_pace_fast_sec_km: null, target_pace_slow_sec_km: null, hr_zone: null,
    description: 'מתיחות קלות או יוגה, 8 שעות שינה.',
    rationale: 'הגוף מתחזק במנוחה, לא באימון.',
    adaptation_note: null, adjustment_sec: 0,
  },
  3: {
    workout_type: 'easy', title: 'ריצה קלה 40 דק׳', duration_min: 40, distance_km: 6,
    target_pace_fast_sec_km: 410, target_pace_slow_sec_km: 440, hr_zone: 2,
    description: 'קצב שיחה, מישורי ככל האפשר.',
    rationale: 'ריצת חיבור בין שני אימוני איכות.',
    adaptation_note: null, adjustment_sec: 0,
  },
  4: {
    workout_type: 'tempo', title: 'טמפו 3×10 דק׳', duration_min: 55, distance_km: 10,
    target_pace_fast_sec_km: 312, target_pace_slow_sec_km: 322, hr_zone: 4,
    description: 'חימום 12 דק׳ · 3×10 דק׳ טמפו, 2 דק׳ מנוחה · שחרור 8 דק׳',
    rationale: 'משפרים סף לקטט — המפתח לקצב חצי מרתון.',
    adaptation_note: null, adjustment_sec: 0,
  },
  5: {
    workout_type: 'long', title: 'ריצה ארוכה 22 ק״מ', duration_min: 145, distance_km: 22,
    target_pace_fast_sec_km: 390, target_pace_slow_sec_km: 415, hr_zone: 2,
    description: '18 ק״מ קלים + 4 ק״מ אחרונים בקצב מרתון (5:20).',
    rationale: 'בניית סיבולת לקראת המרתון בפברואר.',
    adaptation_note: null, adjustment_sec: 0,
  },
  6: {
    workout_type: 'recovery', title: 'התאוששות 30 דק׳', duration_min: 30, distance_km: 4.2,
    target_pace_fast_sec_km: 430, target_pace_slow_sec_km: 465, hr_zone: 1,
    description: 'ממש לאט. אם הרגליים כבדות — הליכה זה בסדר.',
    rationale: 'זרימת דם לשרירים אחרי הארוכה.',
    adaptation_note: null, adjustment_sec: 0,
  },
};

function mockPlan(): CoachingPlan[] {
  const today = new Date();
  const out: CoachingPlan[] = [];
  for (let i = -3; i < 14; i++) {
    const d = addDays(today, i);
    const t = { ...PLAN_TEMPLATES[d.getDay()] };
    // Showcase dynamic adaptations on a few days.
    if (i === 0 && t.workout_type !== 'rest') {
      t.target_pace_fast_sec_km! += 15;
      t.target_pace_slow_sec_km! += 15;
      t.adjustment_sec = 15;
      t.adaptation_note = 'הקצב הואט ב-15 שנ׳ עקב עייפות גבוהה (ACWR 1.34)';
    }
    if (i === 4 && t.workout_type !== 'rest') {
      t.adaptation_note = 'קוצר ב-10 דק׳ — שבוע הורדת עומס';
      t.duration_min = Math.max(20, (t.duration_min ?? 40) - 10);
    }
    out.push({
      ...t,
      id: `mock-plan-${i}`,
      plan_date: toISODate(d),
      status: i < 0 ? (i === -2 ? 'skipped' : 'completed') : 'planned',
    });
  }
  return out;
}

export const mockStore = {
  profile: {
    id: 'demo',
    display_name: 'רץ/ה',
    hr_max: 188,
    hr_rest: 52,
    weekly_km_target: 55,
    garmin_connected: true,
    garmin_last_sync_at: addDays(new Date(), 0).toISOString(),
    garmin_last_sync_status: 'ok: 12 runs',
  } satisfies Profile as Profile,
  activities: mockActivities(),
  plan: mockPlan(),
  assessment: {
    id: 'mock-assess',
    assessed_at: new Date().toISOString(),
    fatigue_level: 'moderate',
    readiness_score: 68,
    marathon_shape_pct: 61,
    acwr: 1.34,
    summary:
      'העומס של 7 הימים האחרונים גבוה ב-34% מהממוצע החודשי. הדופק בריצות הקלות עלה בכ-4 פעימות — סימן לעייפות מצטברת. מאטים מעט היום ושומרים על האיכות לסוף השבוע.',
  } satisfies CoachAssessment as CoachAssessment,
  races: [
    { id: 'r1', name: 'חצי מרתון — נובמבר', race_date: '2026-11-27', distance_km: 21.0975, target_time_s: 6300, priority: 'B' },
    { id: 'r2', name: 'מרתון מלא — פברואר', race_date: '2027-02-26', distance_km: 42.195, target_time_s: 13500, priority: 'A' },
  ] as Race[],
  geminiKeySet: false,
};
