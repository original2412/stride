// Edge Function: POST /functions/v1/recalibrate-plan
// Body: { today?: "YYYY-MM-DD" }
// Builds the next 7 days deterministically from research-based rules (science.ts + planner.ts),
// optionally asks Gemini to phrase the coach note, and upserts the plan.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { computeLoadMetrics, generateCoachNote, GEMINI_MODEL } from "../_shared/gemini.ts";
import { assess, buildPlan } from "../_shared/planner.ts";
import { estimateVdot, marathonShape, predictRaceTime, prescribeWeek, trainingPaces, vdotFromPerformance } from "../_shared/science.ts";

const ENGINE_VERSION = "stride-rules-v1";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const jwt = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "Missing Authorization header" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const { data: { user }, error: authError } = await admin.auth.getUser(jwt);
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const today: string = /^\d{4}-\d{2}-\d{2}$/.test(body.today ?? "")
      ? body.today
      : new Date().toISOString().slice(0, 10);
    // VDOT looks back 6 weeks; load metrics use the last 28 days.
    const fitnessSince = new Date(Date.parse(today) - 42 * 86_400_000).toISOString();
    const weekEnd = new Date(Date.parse(today) + 6 * 86_400_000).toISOString().slice(0, 10);

    const [profileRes, secretRes, activitiesRes, racesRes, prevPlanRes, prevAssessRes] = await Promise.all([
      admin.from("profiles").select("hr_max, hr_rest").eq("id", user.id).single(),
      admin.from("user_secrets").select("gemini_api_key").eq("user_id", user.id).maybeSingle(),
      admin
        .from("activities")
        .select("start_time, name, distance_m, duration_s, avg_pace_sec_per_km, gap_sec_per_km, avg_hr, max_hr, elevation_gain_m, training_load")
        .eq("user_id", user.id)
        .gte("start_time", fitnessSince)
        .order("start_time", { ascending: true }),
      admin
        .from("races")
        .select("name, race_date, distance_km, target_time_s, priority")
        .eq("user_id", user.id)
        .gte("race_date", today)
        .order("race_date"),
      admin
        .from("coaching_plans")
        .select("plan_date, workout_type, target_pace_fast_sec_km, status")
        .eq("user_id", user.id)
        .gte("plan_date", today)
        .lte("plan_date", weekEnd)
        .order("plan_date"),
      admin
        .from("coach_assessments")
        .select("vdot")
        .eq("user_id", user.id)
        .not("vdot", "is", null)
        // A goal-based default must not anchor the first real estimate.
        .neq("vdot_source", "default")
        .order("assessed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    for (const r of [activitiesRes, racesRes, prevPlanRes]) if (r.error) throw r.error;

    const activities = activitiesRes.data ?? [];
    const loadMetrics = computeLoadMetrics(activities, today);
    const hrMax = profileRes.data?.hr_max ?? 185;
    const hrRest = profileRes.data?.hr_rest ?? 55;
    const races = (racesRes.data ?? []).map((r) => ({ ...r, distance_km: Number(r.distance_km) }));
    const previousVdot = prevAssessRes.data?.vdot ? Number(prevAssessRes.data.vdot) : null;

    // ---- Science: fitness, paces, this week's prescription ----
    const goal = races.find((r) => r.priority === "A" && r.target_time_s) ?? races.find((r) => r.target_time_s);
    const fallbackVdot = goal ? vdotFromPerformance(goal.distance_km * 1000, goal.target_time_s!) - 2 : 40;
    const vdot = estimateVdot(activities, hrMax, hrRest, today, previousVdot, fallbackVdot);
    const paces = trainingPaces(vdot.vdot);
    const week = prescribeWeek({ today, races, avgWeeklyKm28: loadMetrics.avgWeeklyKm28, km7: loadMetrics.km7, acwr: loadMetrics.acwr });
    const predictions = races.map((r) => ({
      name: r.name,
      distance_km: r.distance_km,
      predicted_s: predictRaceTime(vdot.vdot, r.distance_km * 1000),
      target_s: r.target_time_s,
    }));

    // Keep the athlete's current rhythm (runs/week over 4 weeks), 4–6 by default.
    const runsPerWeek = loadMetrics.runs28 >= 4 ? Math.min(6, Math.max(4, Math.round(loadMetrics.runs28 / 4))) : 5;

    // ---- Planner: deterministic 7-day plan ----
    const workouts = buildPlan({
      today,
      vdot: vdot.vdot,
      previousVdot,
      paces,
      week,
      races,
      runsPerWeek,
      acwr: loadMetrics.acwr,
      previousPlan: prevPlanRes.data ?? [],
    });
    const assessment = assess({
      vdot: vdot.vdot,
      previousVdot,
      acwr: loadMetrics.acwr,
      km7: loadMetrics.km7,
      avgWeeklyKm28: loadMetrics.avgWeeklyKm28,
      daysSinceLastRun: loadMetrics.daysSinceLastRun,
      week,
    });

    // ---- Optional: Gemini phrases the coach note (never changes the plan) ----
    const apiKey = secretRes.data?.gemini_api_key ?? Deno.env.get("GEMINI_API_KEY");
    let summary = assessment.summary;
    let usedGemini = false;
    if (apiKey) {
      const note = await generateCoachNote(apiKey, assessment.summary);
      if (note) {
        summary = note;
        usedGemini = true;
      }
    }

    const fullMarathon = races.find((r) => r.distance_km > 40);
    const shape = marathonShape(vdot.vdot, fullMarathon?.target_time_s ?? null, loadMetrics.longestRun28Km, loadMetrics.avgWeeklyKm28);

    // Keep the status of days the athlete already completed/skipped.
    const lockedDates = new Set((prevPlanRes.data ?? []).filter((p) => p.status !== "planned").map((p) => p.plan_date));
    const rows = workouts
      .filter((w) => !lockedDates.has(w.date))
      .map((w) => ({
        user_id: user.id,
        plan_date: w.date,
        workout_type: w.workout_type,
        title: w.title,
        description: w.description,
        duration_min: w.duration_min,
        distance_km: w.distance_km,
        target_pace_fast_sec_km: w.target_pace_fast_sec_km,
        target_pace_slow_sec_km: w.target_pace_slow_sec_km,
        hr_zone: w.hr_zone,
        rationale: w.rationale,
        adaptation_note: w.adaptation_note,
        adjustment_sec: w.adjustment_sec,
        status: "planned",
        source: "engine",
        model: ENGINE_VERSION,
      }));

    const [upsertRes, assessRes] = await Promise.all([
      admin.from("coaching_plans").upsert(rows, { onConflict: "user_id,plan_date" }).select(),
      admin
        .from("coach_assessments")
        .insert({
          user_id: user.id,
          fatigue_level: assessment.fatigue_level,
          readiness_score: assessment.readiness_score,
          marathon_shape_pct: shape,
          summary,
          acwr: loadMetrics.acwr,
          model: usedGemini ? `${ENGINE_VERSION}+${GEMINI_MODEL}` : ENGINE_VERSION,
          vdot: vdot.vdot,
          vdot_source: vdot.source,
          training_paces: paces,
          race_predictions: predictions,
          phase: week.phase,
          weekly_km_target: week.weeklyKmTarget,
        })
        .select()
        .single(),
    ]);
    if (upsertRes.error) throw upsertRes.error;
    if (assessRes.error) throw assessRes.error;

    return json({ assessment: assessRes.data, workouts: upsertRes.data, loadMetrics, week });
  } catch (err) {
    console.error("recalibrate-plan failed", err);
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
