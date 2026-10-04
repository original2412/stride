// Edge Function: POST /functions/v1/intervals
// Pulls runs from intervals.icu (official Garmin partner) with each user's personal API key.
// Body: { action: "sync" }      → sync the calling user now
//       { action: "sync_all" }  → scheduled job; requires a service-role key as bearer
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "TreadmillRun"]);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pace = (mps: number | null) => (mps && mps > 0 ? Math.round((1000 / mps) * 10) / 10 : null);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// deno-lint-ignore no-explicit-any
function mapActivity(userId: string, a: any) {
  const distance = num(a.distance) ?? num(a.icu_distance) ?? 0;
  const moving = num(a.moving_time) ?? num(a.elapsed_time) ?? 0;
  const speed = num(a.average_speed) ?? (moving > 0 ? distance / moving : null);
  // intervals.icu reports grade-adjusted pace as a speed (m/s) in `gap` when available.
  const gapSpeed = num(a.gap);
  const startIso = a.start_date ?? (a.start_date_local ? `${a.start_date_local}` : null);
  return {
    user_id: userId,
    source: "intervals",
    icu_activity_id: String(a.id),
    start_time: startIso,
    activity_type: String(a.type ?? "Run").toLowerCase(),
    name: a.name ?? null,
    distance_m: Math.round(distance * 10) / 10,
    duration_s: Math.round(moving),
    moving_duration_s: Math.round(moving),
    avg_pace_sec_per_km: pace(speed),
    gap_sec_per_km: gapSpeed && gapSpeed > 0.5 && gapSpeed < 12 ? pace(gapSpeed) : pace(speed),
    avg_hr: num(a.average_heartrate) ?? num(a.icu_average_hr),
    max_hr: num(a.max_heartrate) ?? num(a.icu_max_hr),
    elevation_gain_m: num(a.total_elevation_gain) ?? num(a.icu_elevation_gain),
    elevation_loss_m: num(a.total_elevation_loss),
    avg_cadence_spm: num(a.average_cadence) ? Math.round(a.average_cadence) : null,
    training_load: num(a.icu_training_load),
    raw: a,
  };
}

async function syncUser(admin: SupabaseClient, userId: string): Promise<{ fetched: number; upserted: number }> {
  try {
    const { data, error } = await admin.rpc("icu_get_credentials", { p_user: userId });
    if (error) throw error;
    const cred = (data ?? [])[0];
    if (!cred?.api_key) throw new Error("intervals.icu לא מחובר");

    // First sync: 60 days (VDOT needs 6 weeks). Later: overlap 3 days to catch edits.
    const since = cred.last_sync_at ? Date.parse(cred.last_sync_at) - 3 * 86_400_000 : Date.now() - 60 * 86_400_000;
    const url = `https://intervals.icu/api/v1/athlete/${encodeURIComponent(cred.athlete_id || "0")}/activities` +
      `?oldest=${day(since)}&newest=${day(Date.now() + 86_400_000)}`;
    const res = await fetch(url, { headers: { Authorization: `Basic ${btoa(`API_KEY:${cred.api_key}`)}` } });
    if (res.status === 401 || res.status === 403) throw new Error("intervals.icu דחה את המפתח — בדקו את ה-API key ואת מזהה הספורטאי");
    if (!res.ok) throw new Error(`intervals.icu ${res.status}`);
    // deno-lint-ignore no-explicit-any
    const all = (await res.json()) as any[];
    if (all.length) console.log("icu activity fields:", Object.keys(all[0]).join(","));

    // Activities that intervals.icu imported from Strava are not exposed via its API (Strava terms);
    // those come back without a type/distance — skip them.
    const runs = all.filter((a) => RUN_TYPES.has(a.type) && (num(a.distance) ?? 0) > 0);
    const rows = runs.map((a) => mapActivity(userId, a));
    if (rows.length) {
      const { error: upErr } = await admin.from("activities").upsert(rows, { onConflict: "user_id,icu_activity_id" });
      if (upErr) throw upErr;
    }

    const now = new Date().toISOString();
    await admin.from("icu_links").update({ status: "ok", last_error: null, last_sync_at: now }).eq("user_id", userId);
    await admin.from("profiles").update({
      garmin_connected: true,
      garmin_last_sync_at: now,
      garmin_last_sync_status: `ok (intervals.icu): ${rows.length} runs`,
    }).eq("id", userId);
    return { fetched: all.length, upserted: rows.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await admin.from("icu_links").update({ status: "error", last_error: msg.slice(0, 300) }).eq("user_id", userId);
    throw err;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!bearer) return json({ error: "Missing Authorization header" }, 401);

    // Scheduled job: only a service-level key can call the service-only RPC.
    if (body.action === "sync_all") {
      const svc = createClient(SUPABASE_URL, bearer, { auth: { persistSession: false } });
      const { data: users, error } = await svc.rpc("icu_sync_users");
      if (error) return json({ error: "Unauthorized" }, 401);
      const results: Record<string, unknown> = {};
      for (const u of users ?? []) {
        try {
          results[String(u.user_id).slice(0, 8)] = await syncUser(svc, u.user_id);
        } catch (e) {
          results[String(u.user_id).slice(0, 8)] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      return json({ ok: true, results });
    }

    const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: { user }, error: authError } = await admin.auth.getUser(bearer);
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    if (body.action === "sync") return json({ ok: true, ...(await syncUser(admin, user.id)) });
    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("intervals function failed", err);
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
