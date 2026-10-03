// Load metrics + optional Gemini "coach note".
// The plan itself is deterministic (science.ts + planner.ts); Gemini only rewrites the
// weekly summary in friendly, natural Hebrew. If Gemini is unavailable, the
// deterministic summary is used — the plan never depends on the LLM.
import { GoogleGenAI, Type, type Schema } from "npm:@google/genai";

export const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash";
const FALLBACK_MODELS = (Deno.env.get("GEMINI_FALLBACK_MODELS") ?? "gemini-flash-latest")
  .split(",").map((s) => s.trim()).filter(Boolean);

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

// ---------- Load metrics (Gabbett ACWR) ----------
export interface LoadMetrics {
  km7: number;
  km28: number;
  avgWeeklyKm28: number;
  load7: number;
  load28: number;
  acwr: number | null; // acute (7d) / chronic (28d weekly avg)
  runs7: number;
  runs28: number;
  longestRun28Km: number;
  daysSinceLastRun: number | null;
}

export function computeLoadMetrics(activities: ActivityInput[], today: string): LoadMetrics {
  const todayMs = Date.parse(`${today}T23:59:59Z`);
  const dayMs = 86_400_000;
  // Fall back to a duration-based proxy (minutes) when Garmin has no training load.
  const loadOf = (a: ActivityInput) => a.training_load ?? a.duration_s / 60;

  let km7 = 0, km28 = 0, load7 = 0, load28 = 0, runs7 = 0, runs28 = 0, longest = 0;
  let lastRun: number | null = null;

  for (const a of activities) {
    const t = Date.parse(a.start_time);
    const ageDays = (todayMs - t) / dayMs;
    if (ageDays < 0 || ageDays > 28) continue;
    const km = a.distance_m / 1000;
    km28 += km;
    load28 += loadOf(a);
    runs28++;
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
    // Need some history before the ratio means anything.
    acwr: chronicWeekly > 0 && runs28 >= 4 ? Math.round((load7 / chronicWeekly) * 100) / 100 : null,
    runs7,
    runs28,
    longestRun28Km: round1(longest),
    daysSinceLastRun: lastRun === null ? null : Math.floor((todayMs - lastRun) / dayMs),
  };
}

// ---------- Optional coach note ----------
export class GeminiBusyError extends Error {}

const noteSchema: Schema = {
  type: Type.OBJECT,
  properties: { summary: { type: Type.STRING, description: "Hebrew, 2-3 short sentences" } },
  required: ["summary"],
};

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(503|429|500)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(msg);
}

/**
 * Rewrites the deterministic weekly summary as a short, warm coach note.
 * Must not add or change any numbers. Returns null on any failure.
 */
export async function generateCoachNote(apiKey: string, facts: string): Promise<string | null> {
  const ai = new GoogleGenAI({ apiKey });
  const models = [GEMINI_MODEL, ...FALLBACK_MODELS.filter((m) => m !== GEMINI_MODEL)];
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents: facts,
          config: {
            systemInstruction:
              "אתה מאמן ריצה חם ומקצועי. נסח מחדש את העובדות הבאות כהערת מאמן קצרה בעברית (2–3 משפטים), " +
              "מעודדת וברורה. אל תוסיף ואל תשנה אף מספר, קצב או המלצה — רק נסח.",
            responseMimeType: "application/json",
            responseSchema: noteSchema,
            temperature: 0.6,
          },
        });
        const parsed = JSON.parse(res.text ?? "{}");
        const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 600) : "";
        return summary || null;
      } catch (err) {
        if (!isTransient(err)) return null;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      }
    }
  }
  return null;
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}
