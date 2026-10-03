// Gemini coaching service — formats recent running telemetry into a structured
// prompt and asks Gemini for a 7-day adaptive plan under a strict JSON schema.
import { GoogleGenAI, Type, type Schema } from "npm:@google/genai";
import { type PaceZones, type VdotEstimate, type WeekPrescription, ZONE_FOR_WORKOUT } from "./science.ts";

export const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash";

export const WORKOUT_TYPES = [
  "easy", "recovery", "long", "tempo", "threshold", "intervals", "progression", "rest", "race",
] as const;
export type WorkoutType = typeof WORKOUT_TYPES[number];

// ---------- Input types ----------
export interface ActivityInput {
  start_time: string;
  name: string | null;
  distance_m: number;
  duration_s: number;
  avg_pace_sec_per_km: number | null;
  gap_sec_per_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  elevation_gain_m: number | null;
  training_load: number | null;
}

export interface RaceInput {
  name: string;
  race_date: string;
  distance_km: number;
  target_time_s: number | null;
  priority: string;
}

export interface PlannedInput {
  plan_date: string;
  workout_type: string;
  title: string;
  target_pace_fast_sec_km: number | null;
  target_pace_slow_sec_km: number | null;
  status: string;
}

export interface CoachInput {
  today: string; // YYYY-MM-DD (athlete's local date)
  hrMax: number;
  hrRest: number;
  activities: ActivityInput[];
  races: RaceInput[];
  previousPlan: PlannedInput[];
  loadMetrics: LoadMetrics;
  science: ScienceContext;
}

/** Deterministic, research-based targets computed before calling the LLM. */
export interface ScienceContext {
  vdot: VdotEstimate;
  paces: PaceZones;
  week: WeekPrescription;
  predictions: { name: string; distance_km: number; predicted_s: number; target_s: number | null }[];
}

// ---------- Output types ----------
export interface PrescribedWorkout {
  date: string;
  workout_type: WorkoutType;
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

export interface CoachAssessment {
  fatigue_level: "low" | "moderate" | "high";
  readiness_score: number;
  marathon_shape_pct: number;
  summary: string;
}

export interface CoachingPlanResponse {
  assessment: CoachAssessment;
  workouts: PrescribedWorkout[];
}

// ---------- Strict response schema ----------
const workoutSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    date: { type: Type.STRING, description: "ISO date YYYY-MM-DD" },
    workout_type: { type: Type.STRING, format: "enum", enum: [...WORKOUT_TYPES] },
    title: { type: Type.STRING, description: "Short Hebrew title, e.g. 'ריצה קלה 30 דק''" },
    description: { type: Type.STRING, description: "Hebrew structure: warm-up / main set / cool-down" },
    duration_min: { type: Type.INTEGER, minimum: 0, maximum: 300 },
    distance_km: { type: Type.NUMBER, nullable: true },
    target_pace_fast_sec_km: { type: Type.INTEGER, nullable: true, description: "Faster bound, seconds per km" },
    target_pace_slow_sec_km: { type: Type.INTEGER, nullable: true, description: "Slower bound, seconds per km" },
    hr_zone: { type: Type.INTEGER, nullable: true, minimum: 1, maximum: 5 },
    rationale: { type: Type.STRING, description: "Hebrew, 1-2 sentences, references the data" },
    adaptation_note: {
      type: Type.STRING,
      nullable: true,
      description: "Hebrew. Set only if this day changed vs. the previous plan, e.g. 'הקצב הואט ב-15 שנ' עקב עייפות גבוהה'",
    },
    adjustment_sec: {
      type: Type.INTEGER,
      description: "Pace change vs. previous plan in sec/km (+ slower, - faster, 0 unchanged)",
    },
  },
  required: [
    "date", "workout_type", "title", "description", "duration_min", "distance_km",
    "target_pace_fast_sec_km", "target_pace_slow_sec_km", "hr_zone", "rationale",
    "adaptation_note", "adjustment_sec",
  ],
  propertyOrdering: [
    "date", "workout_type", "title", "description", "duration_min", "distance_km",
    "target_pace_fast_sec_km", "target_pace_slow_sec_km", "hr_zone", "rationale",
    "adaptation_note", "adjustment_sec",
  ],
};

export const coachingResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    assessment: {
      type: Type.OBJECT,
      properties: {
        fatigue_level: { type: Type.STRING, format: "enum", enum: ["low", "moderate", "high"] },
        readiness_score: { type: Type.INTEGER, minimum: 0, maximum: 100 },
        marathon_shape_pct: { type: Type.INTEGER, minimum: 0, maximum: 100 },
        summary: { type: Type.STRING, description: "Hebrew, 2-3 sentences" },
      },
      required: ["fatigue_level", "readiness_score", "marathon_shape_pct", "summary"],
      propertyOrdering: ["fatigue_level", "readiness_score", "marathon_shape_pct", "summary"],
    },
    workouts: {
      type: Type.ARRAY,
      description: "Exactly 7 consecutive days starting today",
      items: workoutSchema,
    },
  },
  required: ["assessment", "workouts"],
  propertyOrdering: ["assessment", "workouts"],
};

// ---------- Load metrics (computed deterministically, not by the LLM) ----------
export interface LoadMetrics {
  km7: number;
  km28: number;
  avgWeeklyKm28: number;
  load7: number;
  load28: number;
  acwr: number | null; // acute (7d) / chronic (28d weekly avg)
  runs7: number;
  longestRun28Km: number;
  daysSinceLastRun: number | null;
}

export function computeLoadMetrics(activities: ActivityInput[], today: string): LoadMetrics {
  const todayMs = Date.parse(`${today}T23:59:59Z`);
  const dayMs = 86_400_000;
  // Fall back to a duration-based proxy (minutes) when Garmin has no training load.
  const loadOf = (a: ActivityInput) => a.training_load ?? a.duration_s / 60;

  let km7 = 0, km28 = 0, load7 = 0, load28 = 0, runs7 = 0, longest = 0;
  let lastRun: number | null = null;

  for (const a of activities) {
    const t = Date.parse(a.start_time);
    const ageDays = (todayMs - t) / dayMs;
    if (ageDays < 0 || ageDays > 28) continue;
    const km = a.distance_m / 1000;
    km28 += km;
    load28 += loadOf(a);
    longest = Math.max(longest, km);
    if (ageDays <= 7) {
      km7 += km;
      load7 += loadOf(a);
      runs7++;
    }
    lastRun = lastRun === null ? t : Math.max(lastRun, t);
  }

  const chronicWeekly = load28 / 4;
  return {
    km7: round1(km7),
    km28: round1(km28),
    avgWeeklyKm28: round1(km28 / 4),
    load7: Math.round(load7),
    load28: Math.round(load28),
    acwr: chronicWeekly > 0 ? Math.round((load7 / chronicWeekly) * 100) / 100 : null,
    runs7,
    longestRun28Km: round1(longest),
    daysSinceLastRun: lastRun === null ? null : Math.floor((todayMs - lastRun) / dayMs),
  };
}

// ---------- Prompt ----------
const SYSTEM_INSTRUCTION = `You are an elite, evidence-based running coach (Daniels / Pfitzinger / polarized-training school).
You prescribe adaptive daily workouts from objective telemetry.
Rules:
- Output ONLY JSON matching the provided schema. All human-readable strings MUST be in Hebrew.
- Paces are integers in seconds per km. target_pace_fast_sec_km <= target_pace_slow_sec_km.
- PACES ARE NOT YOURS TO INVENT. Use exactly the Daniels pace zones given under SCIENCE for each workout type
  (easy/long → E, recovery → Recovery, tempo/threshold → T, intervals → I, progression → finish at M, race → predicted race pace).
  In descriptions, give the structure with these paces (e.g. "5×1000 מ' ב-4:36 עם 2 דק' ג'וג").
- Hit the weekly volume target (±10%), cap the long run at the given max, and respect the quality-volume caps
  (T ≤ maxThresholdKm, I ≤ maxIntervalKm, R ≤ maxRepetitionKm of work per session).
- Use exactly the number of quality sessions given; never on consecutive days; keep ~80% of time easy (polarized).
- Choose session types that fit the phase: base → strides/hills + T; build → T + I; specific → M-pace long runs + T;
  taper → short sharp I/T, reduced volume.
- For rest days: workout_type "rest", duration_min 0, distances/paces/hr_zone null.
- Fatigue (ACWR > 1.3, or HR on easy runs higher than usual for the pace): convert a quality day to easy and/or
  set a positive adjustment_sec (max +20) on easy days — never slow down interval paces; replace them instead.
- Use GAP rather than raw pace when judging hilly runs.
- When a day differs from the previous plan, fill adaptation_note and adjustment_sec explaining why.
- rationale must cite the data (VDOT, phase, ACWR, recent runs) in plain Hebrew.`;

export function buildCoachPrompt(input: CoachInput): string {
  const { today, hrMax, hrRest, activities, races, previousPlan, loadMetrics: m, science: s } = input;

  const zoneLines = (Object.entries(s.paces) as [string, { fast: number; slow: number }][])
    .map(([k, z]) => `- ${k}: ${fmtPace(z.fast)}-${fmtPace(z.slow)} /km (${z.fast}-${z.slow} sec)`)
    .join("\n");
  const predLines = s.predictions
    .map((p) => `- ${p.name}: predicted ${fmtDuration(p.predicted_s)} (pace ${fmtPace(p.predicted_s / p.distance_km)})${p.target_s ? `, target ${fmtDuration(p.target_s)}` : ""}`)
    .join("\n");
  const w = s.week;

  const runs = [...activities]
    .sort((a, b) => a.start_time.localeCompare(b.start_time))
    .map((a) =>
      [
        a.start_time.slice(0, 10),
        `${(a.distance_m / 1000).toFixed(2)}km`,
        fmtDuration(a.duration_s),
        `pace ${fmtPace(a.avg_pace_sec_per_km)}`,
        `GAP ${fmtPace(a.gap_sec_per_km)}`,
        `HR ${a.avg_hr ?? "-"}/${a.max_hr ?? "-"}`,
        `elev+ ${a.elevation_gain_m ?? "-"}m`,
        `load ${a.training_load ?? "-"}`,
      ].join(" | ")
    )
    .join("\n");

  const raceLines = races
    .map((r) => {
      const weeks = Math.round((Date.parse(r.race_date) - Date.parse(today)) / (7 * 86_400_000));
      const target = r.target_time_s ? fmtDuration(r.target_time_s) : "no target";
      return `- [${r.priority}] ${r.name}: ${r.distance_km}km on ${r.race_date} (${weeks} weeks away), target ${target}`;
    })
    .join("\n");

  const prevLines = previousPlan.length
    ? previousPlan
        .map((p) =>
          `- ${p.plan_date}: ${p.workout_type} "${p.title}" pace ${fmtPace(p.target_pace_fast_sec_km)}-${fmtPace(p.target_pace_slow_sec_km)} [${p.status}]`
        )
        .join("\n")
    : "(none — this is the first plan)";

  return `TODAY: ${today}

ATHLETE
- HRmax ${hrMax} bpm, HRrest ${hrRest} bpm (use Karvonen-style zones Z1-Z5).

LOAD METRICS (computed server-side, trust these)
- Last 7d: ${m.km7} km over ${m.runs7} runs, load ${m.load7}
- Last 28d: ${m.km28} km (avg ${m.avgWeeklyKm28} km/week), load ${m.load28}
- ACWR: ${m.acwr ?? "n/a"}
- Longest run (28d): ${m.longestRun28Km} km
- Days since last run: ${m.daysSinceLastRun ?? "n/a"}

SCIENCE (deterministic, research-based — follow strictly)
- VDOT ${s.vdot.vdot} (source: ${s.vdot.source}, ${s.vdot.samples} runs)
- Daniels pace zones:
${zoneLines}
- Race predictions at current VDOT:
${predLines || "- (none)"}
- Phase: ${w.phase}${w.weeksToARace !== null ? `, ${w.weeksToARace} weeks to A-race` : ""}${w.isRecoveryWeek ? ", RECOVERY WEEK" : ""}
- Weekly volume target: ${w.weeklyKmTarget} km; long run max ${w.longRunKmMax} km
- Quality sessions this week: ${w.qualitySessions}; caps per session: T ${w.maxThresholdKm} km, I ${w.maxIntervalKm} km, R ${w.maxRepetitionKm} km
${w.notes.map((n) => `- Note: ${n}`).join("\n")}

RECENT RUNS (oldest → newest; date | dist | time | pace | GAP | HR avg/max | elevation | load)
${runs || "(no runs in window)"}

GOAL RACES
${raceLines || "(none)"}

PREVIOUS PLAN FOR THE COMING DAYS
${prevLines}

TASK
Prescribe exactly 7 consecutive days starting ${today}. Return the assessment and workouts.`;
}

// ---------- Validation (never trust model output blindly) ----------
function sanitizePace(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n >= 150 && n <= 720 ? n : null; // 2:30 – 12:00 min/km
}

/**
 * Server-side enforcement: the LLM schedules, the science sets the numbers.
 * Paces snap to the Daniels zone for the workout type; easy-type days may be slowed
 * by up to +20 s for fatigue; long runs are capped.
 */
function enforceScience(w: PrescribedWorkout, s: ScienceContext, races: RaceInput[]): PrescribedWorkout {
  if (w.workout_type === "rest") return w;
  const out = { ...w };

  if (w.workout_type === "race") {
    const race = races.find((r) => r.race_date === w.date);
    const pred = race && s.predictions.find((p) => p.name === race.name);
    if (pred) {
      const pace = Math.round(pred.predicted_s / pred.distance_km);
      out.target_pace_fast_sec_km = pace - 3;
      out.target_pace_slow_sec_km = pace + 3;
    }
    return out;
  }

  const zoneKey = ZONE_FOR_WORKOUT[w.workout_type];
  if (zoneKey) {
    const zone = s.paces[zoneKey];
    const easyType = zoneKey === "easy" || zoneKey === "recovery";
    const shift = easyType ? Math.min(20, Math.max(0, w.adjustment_sec)) : 0;
    out.target_pace_fast_sec_km = zone.fast + shift;
    out.target_pace_slow_sec_km = zone.slow + shift;
    if (!easyType) out.adjustment_sec = 0;
    // Progression runs start at E and finish at M.
    if (w.workout_type === "progression") out.target_pace_slow_sec_km = s.paces.easy.fast;
  }
  if (w.workout_type === "long" && out.distance_km && out.distance_km > s.week.longRunKmMax) {
    out.distance_km = s.week.longRunKmMax;
  }
  return out;
}

export function validatePlan(raw: unknown, today: string, science?: ScienceContext, races: RaceInput[] = []): CoachingPlanResponse {
  if (!raw || typeof raw !== "object") throw new Error("Gemini returned a non-object payload");
  const r = raw as Partial<CoachingPlanResponse>;
  if (!r.assessment || !Array.isArray(r.workouts)) throw new Error("Gemini payload missing fields");

  const start = Date.parse(`${today}T00:00:00Z`);
  const workouts = r.workouts.slice(0, 7).map((w, i): PrescribedWorkout => {
    const type = (WORKOUT_TYPES as readonly string[]).includes(w.workout_type) ? w.workout_type : "easy";
    const isRest = type === "rest";
    let fast = isRest ? null : sanitizePace(w.target_pace_fast_sec_km);
    let slow = isRest ? null : sanitizePace(w.target_pace_slow_sec_km);
    if (fast !== null && slow !== null && fast > slow) [fast, slow] = [slow, fast];
    // Force consecutive dates so a hallucinated date can't overwrite the wrong day.
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    return {
      date,
      workout_type: type,
      title: String(w.title ?? "").slice(0, 120) || "אימון",
      description: String(w.description ?? "").slice(0, 1000),
      duration_min: isRest ? 0 : clamp(Math.round(Number(w.duration_min) || 0), 0, 300),
      distance_km: isRest || w.distance_km == null ? null : Math.round(Number(w.distance_km) * 100) / 100,
      target_pace_fast_sec_km: fast,
      target_pace_slow_sec_km: slow,
      hr_zone: isRest || w.hr_zone == null ? null : clamp(Math.round(Number(w.hr_zone)), 1, 5),
      rationale: String(w.rationale ?? "").slice(0, 600),
      adaptation_note: w.adaptation_note ? String(w.adaptation_note).slice(0, 200) : null,
      adjustment_sec: clamp(Math.round(Number(w.adjustment_sec) || 0), -120, 120),
    };
  });
  if (workouts.length < 7) throw new Error(`Gemini returned ${workouts.length} days, expected 7`);
  const enforced = science ? workouts.map((w) => enforceScience(w, science, races)) : workouts;

  const a = r.assessment;
  return {
    assessment: {
      fatigue_level: ["low", "moderate", "high"].includes(a.fatigue_level) ? a.fatigue_level : "moderate",
      readiness_score: clamp(Math.round(Number(a.readiness_score) || 50), 0, 100),
      marathon_shape_pct: clamp(Math.round(Number(a.marathon_shape_pct) || 0), 0, 100),
      summary: String(a.summary ?? "").slice(0, 800),
    },
    workouts: enforced,
  };
}

// ---------- Main entry ----------
// Tried in order when the primary model is overloaded (503) or rate limited (429).
const FALLBACK_MODELS = (Deno.env.get("GEMINI_FALLBACK_MODELS") ?? "gemini-flash-latest")
  .split(",").map((s) => s.trim()).filter(Boolean);

export class GeminiBusyError extends Error {}

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(503|429|500)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(msg);
}

export async function generateCoachingPlan(
  apiKey: string,
  input: CoachInput,
  model = GEMINI_MODEL,
): Promise<CoachingPlanResponse> {
  const ai = new GoogleGenAI({ apiKey });
  const models = [model, ...FALLBACK_MODELS.filter((m) => m !== model)];
  const request = {
    contents: buildCoachPrompt(input),
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      responseMimeType: "application/json",
      responseSchema: coachingResponseSchema,
      temperature: 0.4,
    },
  };

  // Up to 3 attempts per model with exponential backoff, then fall back.
  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
  let lastError: unknown;
  outer: for (const m of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await ai.models.generateContent({ model: m, ...request });
        break outer;
      } catch (err) {
        lastError = err;
        if (!isTransient(err)) throw err;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }
  if (!response) {
    throw isTransient(lastError) ? new GeminiBusyError("Gemini busy") : lastError;
  }

  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned invalid JSON");
  }
  return validatePlan(parsed, input.today, input.science, input.races);
}

// ---------- helpers ----------
function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
function round1(n: number) {
  return Math.round(n * 10) / 10;
}
function fmtPace(sec: number | null | undefined): string {
  if (sec == null) return "-";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
