// Edge Function: POST /functions/v1/recalibrate-plan
// Body: { today?: "YYYY-MM-DD", days?: 14..30 }
// Pulls the athlete's telemetry, asks Gemini for a 7-day plan, upserts it into coaching_plans.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { computeLoadMetrics, GeminiBusyError, generateCoachingPlan, GEMINI_MODEL, type ScienceContext } from "../_shared/gemini.ts";
import { estimateVdot, marathonShape, predictRaceTime, prescribeWeek, trainingPaces, vdotFromPerformance } from "../_shared/science.ts";

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
    const days = Math.min(30, Math.max(14, Number(body.days) || 28));
    const since = new Date(Date.parse(today) - days * 86_400_000).toISOString();
    // VDOT looks back 6 weeks, further than the prompt window.
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
        .select("plan_date, workout_type, title, target_pace_fast_sec_km, target_pace_slow_sec_km, status")
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

    const apiKey = secretRes.data?.gemini_api_key ?? Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) return json({ error: "לא הוגדר מפתח Gemini. הוסיפו אותו במסך ההגדרות." }, 400);

    const allActivities = activitiesRes.data ?? [];
    const activities = allActivities.filter((a) => a.start_time >= since);
    const loadMetrics = computeLoadMetrics(activities, today);
    const hrMax = profileRes.data?.hr_max ?? 185;
    const hrRest = profileRes.data?.hr_rest ?? 55;
    const races = racesRes.data ?? [];

    // Research-based targets, computed deterministically before the LLM call.
    // No runs yet → start slightly below what the goal race requires.
    const goal = races.find((r) => r.priority === "A" && r.target_time_s) ?? races.find((r) => r.target_time_s);
    const fallbackVdot = goal ? vdotFromPerformance(Number(goal.distance_km) * 1000, goal.target_time_s!) - 2 : 40;
    const vdot = estimateVdot(allActivities, hrMax, hrRest, today, prevAssessRes.data?.vdot ?? null, fallbackVdot);
    const science: ScienceContext = {
      vdot,
      paces: trainingPaces(vdot.vdot),
      week: prescribeWeek({ today, races, avgWeeklyKm28: loadMetrics.avgWeeklyKm28, km7: loadMetrics.km7, acwr: loadMetrics.acwr }),
      predictions: races.map((r) => ({
        name: r.name,
        distance_km: Number(r.distance_km),
        predicted_s: predictRaceTime(vdot.vdot, Number(r.distance_km) * 1000),
        target_s: r.target_time_s,
      })),
    };

    const plan = await generateCoachingPlan(apiKey, {
      today,
      hrMax,
      hrRest,
      activities,
      races,
      previousPlan: prevPlanRes.data ?? [],
      loadMetrics,
      science,
    });

    const fullMarathon = races.find((r) => Number(r.distance_km) > 40);
    plan.assessment.marathon_shape_pct = marathonShape(
      vdot.vdot,
      fullMarathon?.target_time_s ?? null,
      loadMetrics.longestRun28Km,
      loadMetrics.avgWeeklyKm28,
    );

    // Keep the status of days the athlete already completed/skipped.
    const lockedDates = new Set(
      (prevPlanRes.data ?? []).filter((p) => p.status !== "planned").map((p) => p.plan_date),
    );

    const rows = plan.workouts
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
        source: "gemini",
        model: GEMINI_MODEL,
      }));

    const [upsertRes, assessRes] = await Promise.all([
      admin.from("coaching_plans").upsert(rows, { onConflict: "user_id,plan_date" }).select(),
      admin
        .from("coach_assessments")
        .insert({
          user_id: user.id,
          ...plan.assessment,
          acwr: loadMetrics.acwr,
          model: GEMINI_MODEL,
          vdot: vdot.vdot,
          vdot_source: vdot.source,
          training_paces: science.paces,
          race_predictions: science.predictions,
          phase: science.week.phase,
          weekly_km_target: science.week.weeklyKmTarget,
        })
        .select()
        .single(),
    ]);
    if (upsertRes.error) throw upsertRes.error;
    if (assessRes.error) throw assessRes.error;

    return json({ assessment: assessRes.data, workouts: upsertRes.data, loadMetrics, science });
  } catch (err) {
    console.error("recalibrate-plan failed", err);
    if (err instanceof GeminiBusyError) {
      return json({ error: "Gemini עמוס כרגע. נסו שוב בעוד דקה-שתיים." }, 503);
    }
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
