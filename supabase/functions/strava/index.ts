// Edge Function: POST /functions/v1/strava
// Official Strava OAuth + activity sync (Garmin auto-uploads runs to Strava).
// Body: { action: "authorize", redirect_uri } → { url }
//       { action: "exchange", code, state }  → links the account + first sync
//       { action: "sync" }                   → sync the calling user now
//       { action: "disconnect" }             → revoke + delete tokens
//       { action: "sync_all" }               → scheduled job; requires a service-role key
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
const CLIENT_ID = Deno.env.get("STRAVA_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("STRAVA_CLIENT_SECRET") ?? "";
const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);
// Only redirect back to our own app.
const ALLOWED_REDIRECT = /^(https:\/\/original2412\.github\.io\/stride\/|http:\/\/localhost:\d+\/)/;

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
}

// ---------------- Strava API helpers ----------------
async function stravaToken(params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Strava token error ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function stravaGet(path: string, accessToken: string): Promise<unknown> {
  const res = await fetch(`https://www.strava.com/api/v3${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 429) throw new Error("Strava rate limit — נסו שוב בעוד כרבע שעה");
  if (!res.ok) throw new Error(`Strava API ${res.status} on ${path}`);
  return res.json();
}

async function validTokens(admin: SupabaseClient, userId: string): Promise<Tokens> {
  const { data, error } = await admin.rpc("strava_get_tokens", { p_user: userId });
  if (error) throw error;
  if (!data) throw new Error("Strava לא מחובר");
  let tokens = JSON.parse(data as string) as Tokens;
  if (tokens.expires_at - 120 < Date.now() / 1000) {
    const r = await stravaToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    tokens = { access_token: String(r.access_token), refresh_token: String(r.refresh_token), expires_at: Number(r.expires_at) };
    const save = await admin.rpc("strava_save_tokens", { p_user: userId, p_tokens: JSON.stringify(tokens) });
    if (save.error) throw save.error;
  }
  return tokens;
}

// ---------------- Mapping ----------------
interface Split {
  distance: number;
  moving_time: number;
  elevation_difference?: number;
  average_speed?: number;
  average_grade_adjusted_speed?: number;
  average_heartrate?: number;
}

const pace = (mps?: number | null) => (mps && mps > 0 ? Math.round((1000 / mps) * 10) / 10 : null);

function gapFromSplits(splits: Split[]): number | null {
  let dist = 0, time = 0;
  for (const s of splits) {
    if (!s.average_grade_adjusted_speed || s.distance < 50) continue;
    dist += s.distance;
    time += s.distance / s.average_grade_adjusted_speed;
  }
  return dist > 0 ? Math.round((time / (dist / 1000)) * 10) / 10 : null;
}

// deno-lint-ignore no-explicit-any
function mapActivity(userId: string, a: any, detail: any | null) {
  const splits: Split[] = detail?.splits_metric ?? [];
  return {
    user_id: userId,
    source: "strava",
    strava_activity_id: a.id,
    start_time: a.start_date,
    activity_type: String(a.sport_type ?? a.type ?? "Run").toLowerCase(),
    name: a.name ?? null,
    distance_m: Math.round(a.distance * 10) / 10,
    duration_s: a.moving_time,
    moving_duration_s: a.moving_time,
    avg_pace_sec_per_km: pace(a.average_speed),
    gap_sec_per_km: gapFromSplits(splits) ?? pace(a.average_speed),
    avg_hr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
    max_hr: a.max_heartrate ? Math.round(a.max_heartrate) : null,
    elevation_gain_m: a.total_elevation_gain ?? null,
    elevation_loss_m: null,
    // Strava reports running cadence per leg.
    avg_cadence_spm: a.average_cadence ? Math.round(a.average_cadence * 2) : null,
    training_load: null,
    splits: splits.map((s, i) => ({
      lap: i + 1,
      distance_m: s.distance,
      duration_s: s.moving_time,
      pace_sec_per_km: pace(s.average_speed),
      gap_sec_per_km: pace(s.average_grade_adjusted_speed),
      avg_hr: s.average_heartrate ? Math.round(s.average_heartrate) : null,
      elevation_gain_m: s.elevation_difference && s.elevation_difference > 0 ? s.elevation_difference : 0,
      elevation_loss_m: s.elevation_difference && s.elevation_difference < 0 ? -s.elevation_difference : 0,
    })),
    raw: a,
  };
}

// ---------------- Sync ----------------
async function syncUser(admin: SupabaseClient, userId: string): Promise<{ fetched: number; upserted: number }> {
  try {
    const tokens = await validTokens(admin, userId);
    const { data: link } = await admin.from("strava_links").select("last_sync_at").eq("user_id", userId).single();
    // First sync: 60 days of history (VDOT needs 6 weeks). Later: overlap 3 days to catch edits.
    const sinceMs = link?.last_sync_at ? Date.parse(link.last_sync_at) - 3 * 86_400_000 : Date.now() - 60 * 86_400_000;
    const after = Math.floor(sinceMs / 1000);

    // deno-lint-ignore no-explicit-any
    const runs: any[] = [];
    for (let page = 1; page <= 5; page++) {
      // deno-lint-ignore no-explicit-any
      const batch = (await stravaGet(`/athlete/activities?after=${after}&per_page=100&page=${page}`, tokens.access_token)) as any[];
      runs.push(...batch.filter((a) => RUN_TYPES.has(a.sport_type ?? a.type)));
      if (batch.length < 100) break;
    }

    // Detailed splits (for GAP) only for runs we don't have yet — saves API quota.
    const ids = runs.map((r) => r.id);
    const { data: existing } = ids.length
      ? await admin.from("activities").select("strava_activity_id").eq("user_id", userId).in("strava_activity_id", ids)
      : { data: [] };
    const known = new Set((existing ?? []).map((e) => Number(e.strava_activity_id)));

    const rows = [];
    let detailCalls = 0;
    for (const a of runs) {
      let detail = null;
      if (!known.has(a.id) && detailCalls < 60) {
        detail = await stravaGet(`/activities/${a.id}`, tokens.access_token).catch(() => null);
        detailCalls++;
      }
      rows.push(mapActivity(userId, a, detail));
    }
    // Rows without fresh detail must not wipe previously stored splits/GAP.
    const withDetail = rows.filter((r) => !known.has(r.strava_activity_id));
    const summaryOnly = rows
      .filter((r) => known.has(r.strava_activity_id))
      .map(({ splits: _s, gap_sec_per_km: _g, ...rest }) => rest);

    for (const batch of [withDetail, summaryOnly]) {
      if (!batch.length) continue;
      const { error } = await admin.from("activities").upsert(batch, { onConflict: "user_id,strava_activity_id" });
      if (error) throw error;
    }

    const now = new Date().toISOString();
    await admin.from("strava_links").update({ status: "ok", last_error: null, last_sync_at: now }).eq("user_id", userId);
    await admin.from("profiles").update({
      garmin_connected: true,
      garmin_last_sync_at: now,
      garmin_last_sync_status: `ok (strava): ${rows.length} runs`,
    }).eq("id", userId);
    return { fetched: runs.length, upserted: rows.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await admin.from("strava_links").update({ status: "error", last_error: msg.slice(0, 300) }).eq("user_id", userId);
    throw err;
  }
}

// ---------------- Handler ----------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: "Strava לא מוגדר בשרת (STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET)" }, 500);
    const body = await req.json().catch(() => ({}));
    const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!bearer) return json({ error: "Missing Authorization header" }, 401);

    // Scheduled job: authorized only if the bearer is a service-level key
    // (the RPC is granted to service_role only).
    if (body.action === "sync_all") {
      const svc = createClient(SUPABASE_URL, bearer, { auth: { persistSession: false } });
      const { data: users, error } = await svc.rpc("strava_sync_users");
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

    switch (body.action) {
      case "authorize": {
        const redirect = String(body.redirect_uri ?? "");
        if (!ALLOWED_REDIRECT.test(redirect)) return json({ error: "redirect_uri not allowed" }, 400);
        const state = crypto.randomUUID();
        const { error } = await admin
          .from("strava_links")
          .upsert({ user_id: user.id, oauth_state: state }, { onConflict: "user_id" });
        if (error) throw error;
        const url = new URL("https://www.strava.com/oauth/authorize");
        url.search = new URLSearchParams({
          client_id: CLIENT_ID,
          response_type: "code",
          redirect_uri: redirect,
          approval_prompt: "auto",
          scope: "read,activity:read_all",
          state,
        }).toString();
        return json({ url: url.toString() });
      }

      case "exchange": {
        const { data: link } = await admin.from("strava_links").select("oauth_state").eq("user_id", user.id).maybeSingle();
        if (!link?.oauth_state || link.oauth_state !== body.state) return json({ error: "קישור Strava לא תקין או שפג תוקפו — נסו שוב" }, 400);
        const r = await stravaToken({ grant_type: "authorization_code", code: String(body.code ?? "") });
        const scope = String(body.scope ?? "");
        if (scope && !scope.includes("activity:read")) {
          return json({ error: "צריך לאשר גישה לפעילויות ב-Strava (activity:read_all)" }, 400);
        }
        // deno-lint-ignore no-explicit-any
        const athlete = (r.athlete ?? {}) as any;
        const { error: upErr } = await admin.from("strava_links").update({
          athlete_id: athlete.id ?? null,
          athlete_name: [athlete.firstname, athlete.lastname].filter(Boolean).join(" ") || null,
          oauth_state: null,
          status: "ok",
          last_error: null,
        }).eq("user_id", user.id);
        if (upErr) throw upErr;
        const tokens: Tokens = { access_token: String(r.access_token), refresh_token: String(r.refresh_token), expires_at: Number(r.expires_at) };
        const save = await admin.rpc("strava_save_tokens", { p_user: user.id, p_tokens: JSON.stringify(tokens) });
        if (save.error) throw save.error;
        const result = await syncUser(admin, user.id);
        return json({ ok: true, athlete: athlete.firstname ?? null, ...result });
      }

      case "sync":
        return json({ ok: true, ...(await syncUser(admin, user.id)) });

      case "disconnect": {
        try {
          const tokens = await validTokens(admin, user.id);
          await fetch("https://www.strava.com/oauth/deauthorize", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ access_token: tokens.access_token }),
          });
        } catch {
          /* already revoked — still delete locally */
        }
        const { error } = await admin.rpc("strava_remove", { p_user: user.id });
        if (error) throw error;
        return json({ ok: true });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    console.error("strava function failed", err);
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});
