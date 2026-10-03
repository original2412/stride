// Deterministic, research-based weekly planner. Pure TS — shared verbatim with
// supabase/functions/_shared/planner.ts. Keep the two files identical.
//
// The science module decides the numbers (VDOT, pace zones, weekly volume, caps);
// this module turns them into concrete days using published training rules:
// - Daniels: session types per intensity (E/M/T/I/R), rep lengths, I ≤ 8% & T ≤ 10% of weekly volume,
//   recoveries (I: jog ≈ rep time; T cruise: 1 min per ~1.6 km).
// - Pfitzinger: long run ≈ 25–30% of weekly volume, M-pace runs in the specific phase, taper structure.
// - Seiler: ~80/20 polarized distribution, never two hard days in a row.
// - Gabbett: ACWR > 1.3 → drop the second quality day and slow easy days.

import { type PaceZone, type PaceZones, type ScienceRace, type WeekPrescription, predictRaceTime } from './science.ts';

export type PlanWorkoutType =
  | 'easy' | 'recovery' | 'long' | 'tempo' | 'threshold' | 'intervals' | 'progression' | 'rest' | 'race';

export interface PlannedDay {
  date: string;
  workout_type: PlanWorkoutType;
  title: string;
  description: string;
  duration_min: number;
  distance_km: number | null;
  target_pace_fast_sec_km: number | null;
  target_pace_slow_sec_km: number | null;
  hr_zone: number | null;
  rationale: string;
  adaptation_note: string | null;
  adjustment_sec: number;
}

export interface PreviousDay {
  plan_date: string;
  workout_type: string;
  target_pace_fast_sec_km: number | null;
}

export interface PlannerInput {
  today: string; // YYYY-MM-DD
  vdot: number;
  previousVdot: number | null;
  paces: PaceZones;
  week: WeekPrescription;
  races: ScienceRace[];
  runsPerWeek: number;
  acwr: number | null;
  previousPlan: PreviousDay[];
}

export interface PlannerAssessment {
  fatigue_level: 'low' | 'moderate' | 'high';
  readiness_score: number;
  summary: string;
}

type Role = 'easy' | 'recovery' | 'long' | 'q1' | 'q2' | 'rest';

// Israeli week (Sun=0 … Sat=6): long run on Friday, Saturday off.
const TEMPLATES: Record<number, Role[]> = {
  3: ['q1', 'rest', 'rest', 'easy', 'rest', 'long', 'rest'],
  4: ['q1', 'rest', 'easy', 'q2', 'rest', 'long', 'rest'],
  5: ['easy', 'q1', 'rest', 'q2', 'easy', 'long', 'rest'],
  6: ['easy', 'q1', 'easy', 'q2', 'recovery', 'long', 'rest'],
  7: ['easy', 'q1', 'easy', 'q2', 'recovery', 'long', 'easy'],
};

const PHASE_HE: Record<string, string> = {
  base: 'בניית בסיס',
  build: 'בנייה',
  specific: 'ספציפי למרוץ',
  taper: 'טייפר',
  race_week: 'שבוע מרוץ',
  recovery: 'התאוששות',
};

const DAY = 86_400_000;
const r05 = (n: number) => Math.round(n * 2) / 2;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const mid = (z: PaceZone) => (z.fast + z.slow) / 2;

function fmtPace(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtZone(z: PaceZone): string {
  return `${fmtPace(z.fast)}–${fmtPace(z.slow)}`;
}
function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function isoAdd(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
function weekday(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

interface Session {
  type: PlanWorkoutType;
  title: string;
  description: string;
  workKm: number; // km at quality pace
  totalKm: number;
  zone: PaceZone;
  hrZone: number;
  rationale: string;
  extraMin: number; // recoveries between reps
}

const WU = 3; // km warm-up
const CD = 2; // km cool-down

/** Pick the quality session for a slot, by phase (Daniels/Pfitzinger session menus). */
function qualitySession(slot: 'q1' | 'q2', p: PlannerInput, isMarathon: boolean): Session {
  const { paces, week } = p;
  const T = paces.threshold, I = paces.interval, M = paces.marathon;

  const cruise = (): Session => {
    const repKm = 1.5;
    const reps = clamp(Math.floor(week.maxThresholdKm / repKm), 2, 5);
    const work = reps * repKm;
    return {
      type: 'threshold',
      title: `${reps}×1.5 ק״מ בקצב סף`,
      description: `חימום ${WU} ק״מ קל · ${reps}×1.5 ק״מ ב-${fmtZone(T)} עם דקה מנוחה בעמידה/ג׳וג · שחרור ${CD} ק״מ`,
      workKm: work, totalKm: WU + work + CD, zone: T, hrZone: 4, extraMin: reps - 1,
      rationale: `קטעי סף (Cruise intervals) — משפרים את סף הלקטט, היכולת להחזיק קצב מהיר לאורך זמן. היקף העבודה ${work} ק״מ, עד 10% מהנפח השבועי (דניאלס).`,
    };
  };
  const tempo = (): Session => {
    const km = clamp(Math.round(week.maxThresholdKm), 3, 6);
    return {
      type: 'tempo',
      title: `טמפו ${km} ק״מ`,
      description: `חימום ${WU} ק״מ קל · ${km} ק״מ רצוף ב-${fmtZone(T)} ("קשה בנוחות") · שחרור ${CD} ק״מ`,
      workKm: km, totalKm: WU + km + CD, zone: T, hrZone: 4, extraMin: 0,
      rationale: `ריצת טמפו רצופה בקצב סף (T) — כ-20 דקות במאמץ שאפשר להחזיק כשעה. מעלה את סף הלקטט (דניאלס).`,
    };
  };
  const intervals = (scale = 1): Session => {
    const budget = week.maxIntervalKm * scale;
    const repKm = budget >= 5 ? 1 : 0.8;
    const reps = clamp(Math.floor(budget / repKm), 3, 6);
    const work = Math.round(reps * repKm * 10) / 10;
    const repLabel = repKm === 1 ? '1000 מ׳' : '800 מ׳';
    const jog = repKm === 1 ? '3 דק׳' : '2:30 דק׳';
    return {
      type: 'intervals',
      title: `${reps}×${repLabel} אינטרוולים`,
      description: `חימום ${WU} ק״מ קל + 4 האצות · ${reps}×${repLabel} ב-${fmtZone(I)} עם ${jog} ג׳וג · שחרור ${CD} ק״מ`,
      workKm: work, totalKm: WU + work + CD + reps * 0.4, zone: I, hrZone: 5, extraMin: reps * (repKm === 1 ? 3 : 2.5),
      rationale: `אינטרוולים בקצב I (95–100% VO2max) — הגירוי היעיל ביותר לשיפור VO2max. חזרות של 3–5 דקות, עבודה עד 8% מהנפח השבועי (דניאלס).`,
    };
  };
  const marathonPace = (): Session => {
    const km = clamp(Math.round(week.weeklyKmTarget * 0.2), 8, 16);
    return {
      type: 'progression',
      title: `${km} ק״מ בקצב מרתון`,
      description: `חימום ${WU} ק״מ קל · ${km} ק״מ ב-${fmtZone(M)} · שחרור ${CD} ק״מ. תרגלו שתייה וג׳ל כמו ביום המרוץ.`,
      workKm: km, totalKm: WU + km + CD, zone: M, hrZone: 3, extraMin: 0,
      rationale: `ריצה בקצב המרתון החזוי — מלמדת את הגוף את הקצב, את צריכת האנרגיה ואת התזונה של יום המרוץ (פיצינגר).`,
    };
  };
  const sharpener = (): Session => {
    const reps = 3;
    return {
      type: 'threshold',
      title: '3×1 ק״מ לחידוד',
      description: `חימום ${WU} ק״מ קל · 3×1 ק״מ ב-${fmtZone(T)} עם 2 דק׳ ג׳וג · שחרור ${CD} ק״מ`,
      workKm: reps, totalKm: WU + reps + CD, zone: T, hrZone: 4, extraMin: 4,
      rationale: 'שבוע מרוץ: מעט עצימות שומרת על חדות בלי ליצור עייפות. הנפח יורד, העצימות נשארת (טייפר).',
    };
  };

  switch (week.phase) {
    case 'base':
      return slot === 'q1' ? cruise() : tempo();
    case 'build':
      return slot === 'q1' ? intervals() : week.maxThresholdKm > 6 ? cruise() : tempo();
    case 'specific':
      return slot === 'q1' ? cruise() : isMarathon ? marathonPace() : intervals();
    case 'taper':
      return slot === 'q1' ? intervals(0.6) : isMarathon ? { ...marathonPace(), totalKm: WU + 6 + CD, workKm: 6, title: '6 ק״מ בקצב מרתון', description: `חימום ${WU} ק״מ · 6 ק״מ ב-${fmtZone(M)} · שחרור ${CD} ק״מ` } : sharpener();
    case 'race_week':
    default:
      return sharpener();
  }
}

function durationMin(km: number, paceSec: number, extraMin = 0): number {
  return Math.round((km * paceSec) / 60 + extraMin);
}

/** Build the 7 days starting today. */
export function buildPlan(p: PlannerInput): PlannedDay[] {
  const { paces, week, races, acwr } = p;
  const E = paces.easy, R = paces.recovery;
  const aRace = races.find((r) => r.priority === 'A') ?? races[0];
  const isMarathon = (aRace?.distance_km ?? 0) > 30;
  const fatigued = acwr !== null && acwr > 1.3;
  const easyShift = fatigued ? 10 : 0;

  const runs = clamp(Math.round(p.runsPerWeek), 3, 7);
  let template = [...TEMPLATES[runs]];
  // Fewer quality days when the science says so (base / recovery week / race week) or when fatigued.
  const quality = fatigued ? Math.min(1, week.qualitySessions) : week.qualitySessions;
  if (quality < 2) template = template.map((r) => (r === 'q2' ? 'easy' : r));

  // Volume split: long ≈ 30% (capped), quality days fixed by their structure, the rest spread over easy days.
  const W = week.weeklyKmTarget;
  const long = r05(clamp(W * (week.phase === 'race_week' ? 0.2 : 0.3), 8, week.longRunKmMax || 32));
  const q1 = qualitySession('q1', p, isMarathon);
  const q2 = quality >= 2 ? qualitySession('q2', p, isMarathon) : null;
  const nEasy = template.filter((r) => r === 'easy').length;
  const nRec = template.filter((r) => r === 'recovery').length;
  const remaining = Math.max(0, W - long - q1.totalKm - (q2?.totalKm ?? 0));
  const easyKm = r05(clamp(remaining / Math.max(1, nEasy + 0.6 * nRec), 4, 14));
  const recKm = r05(clamp(easyKm * 0.6, 3, 8));

  const prevByDate = new Map(p.previousPlan.map((d) => [d.plan_date, d]));
  const phaseCtx = `שלב: ${PHASE_HE[week.phase] ?? week.phase}${week.weeksToARace !== null ? ` · ${Math.round(week.weeksToARace)} שבועות למרוץ A` : ''}`;

  const days: PlannedDay[] = [];
  for (let i = 0; i < 7; i++) {
    const date = isoAdd(p.today, i);
    const raceToday = races.find((r) => r.race_date === date);
    const raceTomorrow = races.find((r) => r.race_date === isoAdd(date, 1));
    const raceYesterday = races.find((r) => r.race_date === isoAdd(date, -1));
    let role: Role | 'race' | 'shakeout' = template[weekday(date)];
    if (raceToday) role = 'race';
    else if (raceTomorrow) role = 'shakeout';
    else if (raceYesterday) role = 'rest';
    // Never put a hard session the day before/after a race or back-to-back with the long run.
    if ((role === 'q1' || role === 'q2') && races.some((r) => Math.abs(Date.parse(r.race_date) - Date.parse(date)) <= 2 * DAY)) role = 'easy';

    let day: Omit<PlannedDay, 'date' | 'adaptation_note' | 'adjustment_sec'>;
    switch (role) {
      case 'race': {
        const pred = predictRaceTime(p.vdot, raceToday!.distance_km * 1000);
        const pace = Math.round(pred / raceToday!.distance_km);
        day = {
          workout_type: 'race',
          title: raceToday!.name,
          description: `חימום קל 10–15 דק׳ + 3 האצות. קצב יעד ${fmtPace(pace)} לק״מ — התחילו 5–10 שנ׳ איטי יותר בק״מ הראשונים. זמן חזוי ${fmtDur(pred)}.`,
          duration_min: Math.round(pred / 60),
          distance_km: Math.round(raceToday!.distance_km * 100) / 100,
          target_pace_fast_sec_km: pace - 3,
          target_pace_slow_sec_km: pace + 3,
          hr_zone: raceToday!.distance_km > 30 ? 3 : 4,
          rationale: `יום המרוץ! הקצב מחושב מה-VDOT הנוכחי שלך (${p.vdot}) — זה הקצב שהכושר שלך מאפשר היום (דניאלס).`,
        };
        break;
      }
      case 'shakeout':
        day = {
          workout_type: 'recovery',
          title: 'ריצת שחרור לפני מרוץ',
          description: '20 דק׳ קלות מאוד + 4 האצות של 20 שנ׳. ללכת לישון מוקדם.',
          duration_min: 24,
          distance_km: 3.5,
          target_pace_fast_sec_km: R.fast,
          target_pace_slow_sec_km: R.slow,
          hr_zone: 1,
          rationale: 'יום לפני מרוץ: תנועה קלה שומרת על הרגליים רעננות בלי לבזבז אנרגיה.',
        };
        break;
      case 'rest':
        day = {
          workout_type: 'rest',
          title: 'יום מנוחה',
          description: 'מנוחה מלאה או מתיחות/יוגה קלה. 7–9 שעות שינה.',
          duration_min: 0,
          distance_km: null,
          target_pace_fast_sec_km: null,
          target_pace_slow_sec_km: null,
          hr_zone: null,
          rationale: 'ההסתגלות לאימון קורית בזמן המנוחה — בלי ימי מנוחה הכושר לא עולה.',
        };
        break;
      case 'long': {
        const isMEnd = week.phase === 'specific' && isMarathon;
        day = {
          workout_type: 'long',
          title: `ריצה ארוכה ${long} ק״מ`,
          description: isMEnd
            ? `${long} ק״מ: רובם ב-${fmtZone(E)}, ו-${Math.min(6, Math.round(long * 0.2))} הק״מ האחרונים בקצב מרתון (${fmtZone(paces.marathon)}).`
            : `${long} ק״מ ב-${fmtZone(E)}. קצב שיחה לכל אורך הדרך; שתייה כל 20–30 דק׳.`,
          duration_min: durationMin(long, mid(E) + easyShift),
          distance_km: long,
          target_pace_fast_sec_km: E.fast + easyShift,
          target_pace_slow_sec_km: E.slow + easyShift,
          hr_zone: 2,
          rationale: `הריצה הארוכה בונה סיבולת ומשפרת ניצול שומן. כ-30% מהנפח השבועי, עד ${week.longRunKmMax} ק״מ, כדי לצמצם סיכון לפציעה (פיצינגר).`,
        };
        break;
      }
      case 'recovery':
        day = {
          workout_type: 'recovery',
          title: `התאוששות ${recKm} ק״מ`,
          description: `${recKm} ק״מ איטי מאוד ב-${fmtZone(R)}. אם הרגליים כבדות — מותר ללכת.`,
          duration_min: durationMin(recKm, mid(R)),
          distance_km: recKm,
          target_pace_fast_sec_km: R.fast,
          target_pace_slow_sec_km: R.slow,
          hr_zone: 1,
          rationale: 'ריצת התאוששות אחרי ימי עומס: זרימת דם לשרירים בלי להוסיף עייפות.',
        };
        break;
      case 'q1':
      case 'q2': {
        const s = role === 'q1' ? q1 : q2!;
        day = {
          workout_type: s.type,
          title: s.title,
          description: s.description,
          duration_min: durationMin(s.totalKm - s.workKm, mid(E)) + durationMin(s.workKm, mid(s.zone), s.extraMin),
          distance_km: r05(s.totalKm),
          target_pace_fast_sec_km: s.zone.fast,
          target_pace_slow_sec_km: s.zone.slow,
          hr_zone: s.hrZone,
          rationale: s.rationale,
        };
        break;
      }
      case 'easy':
      default: {
        // One strides session a week (Wednesday) keeps economy/speed without fatigue.
        const strides = weekday(date) === 3;
        day = {
          workout_type: 'easy',
          title: `ריצה קלה ${easyKm} ק״מ${strides ? ' + האצות' : ''}`,
          description: `${easyKm} ק״מ ב-${fmtZone({ fast: E.fast + easyShift, slow: E.slow + easyShift })}, קצב שיחה.${strides ? ' בסוף: 6×20 שנ׳ האצות עם הליכה ביניהן.' : ''}`,
          duration_min: durationMin(easyKm, mid(E) + easyShift, strides ? 4 : 0),
          distance_km: easyKm,
          target_pace_fast_sec_km: E.fast + easyShift,
          target_pace_slow_sec_km: E.slow + easyShift,
          hr_zone: 2,
          rationale: strides
            ? 'ריצה קלה עם האצות קצרות — שומרות על כלכליות ריצה ומהירות בלי להוסיף עייפות.'
            : 'כ-80% מזמן האימון צריך להיות קל (Seiler) — כך בונים בסיס אירובי ומתאוששים בין אימוני האיכות.',
        };
      }
    }

    // Explain changes vs. the previous plan for the same day.
    const prev = prevByDate.get(date);
    let adaptation_note: string | null = null;
    let adjustment_sec = 0;
    if (fatigued && (day.workout_type === 'easy' || day.workout_type === 'long')) {
      adjustment_sec = easyShift;
      adaptation_note = `הקצב הואט ב-${easyShift} שנ׳ — ACWR ${acwr!.toFixed(2)} מעל 1.3 (עומס חריג), ויתרנו על אימון האיכות השני`;
    } else if (prev && prev.workout_type !== 'rest' && day.target_pace_fast_sec_km && prev.target_pace_fast_sec_km) {
      const diff = day.target_pace_fast_sec_km - prev.target_pace_fast_sec_km;
      if (Math.abs(diff) >= 3) {
        adjustment_sec = diff;
        adaptation_note =
          diff < 0
            ? `הקצב מהיר ב-${-diff} שנ׳ — הכושר שלך עלה${p.previousVdot ? ` (VDOT ${p.previousVdot} ← ${p.vdot})` : ''}`
            : `הקצב איטי ב-${diff} שנ׳ — מותאם לנתונים העדכניים`;
      } else if (prev.workout_type !== day.workout_type) {
        adaptation_note = 'סוג האימון עודכן לפי העומס והשלב באימונים';
      }
    }

    days.push({ ...day, date, adaptation_note, adjustment_sec, rationale: `${day.rationale} ${phaseCtx}.` });
  }
  return days;
}

/** Readiness & fatigue from load data (Gabbett ACWR bands). */
export function assess(p: {
  vdot: number;
  previousVdot: number | null;
  acwr: number | null;
  km7: number;
  avgWeeklyKm28: number;
  daysSinceLastRun: number | null;
  week: WeekPrescription;
}): PlannerAssessment {
  const { acwr } = p;
  const fatigue_level: PlannerAssessment['fatigue_level'] =
    acwr === null ? 'low' : acwr > 1.3 ? 'high' : acwr > 1.15 ? 'moderate' : 'low';
  let score = 75;
  if (acwr !== null) {
    if (acwr > 1.5) score -= 35;
    else if (acwr > 1.3) score -= 25;
    else if (acwr > 1.15) score -= 10;
    else if (acwr < 0.8) score += 10;
  }
  if (p.daysSinceLastRun !== null && p.daysSinceLastRun >= 2) score += 8;
  if (p.daysSinceLastRun === 0) score -= 5;

  const parts: string[] = [];
  parts.push(`VDOT ${p.vdot}${p.previousVdot && Math.abs(p.vdot - p.previousVdot) >= 0.2 ? ` (${p.vdot > p.previousVdot ? 'עלייה' : 'ירידה'} מ-${p.previousVdot})` : ''}.`);
  parts.push(`${PHASE_HE[p.week.phase] ?? p.week.phase}${p.week.isRecoveryWeek ? ' — שבוע התאוששות' : ''}; יעד השבוע ${p.week.weeklyKmTarget} ק״מ (ממוצע 4 שבועות: ${p.avgWeeklyKm28}).`);
  if (acwr !== null) {
    parts.push(
      acwr > 1.3
        ? `העומס השבועי גבוה ב-${Math.round((acwr - 1) * 100)}% מהממוצע — מורידים עצימות כדי למנוע פציעה.`
        : acwr < 0.8
          ? 'העומס נמוך מהרגיל — אפשר לבנות בהדרגה.'
          : 'העומס בטווח הבטוח (ACWR 0.8–1.3).',
    );
  } else {
    parts.push('אין עדיין מספיק ריצות — סנכרנו Garmin לתוכנית מדויקת יותר.');
  }
  return { fatigue_level, readiness_score: clamp(Math.round(score), 20, 98), summary: parts.join(' ') };
}
