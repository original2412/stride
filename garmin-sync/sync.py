"""
Garmin Connect -> Supabase sync (core + single-user CLI).

Pulls recent running activities (summary + laps/splits) through the unofficial
`python-garminconnect` wrapper (>= 0.3, native auth client) and upserts them
into `public.activities`. Multi-user cloud sync lives in `sync_all.py`.

Usage (local, single user from .env):
    python sync.py --days 30
    python sync.py --days 7 --dry-run
"""
from __future__ import annotations

import argparse
import logging
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from garminconnect import Garmin
from supabase import Client, create_client

load_dotenv()
log = logging.getLogger("garmin-sync")

TOKEN_DIR = Path(os.getenv("GARMIN_TOKEN_DIR", "~/.garminconnect")).expanduser()
RUNNING_TYPES = {"running", "trail_running", "treadmill_running", "track_running", "street_running", "indoor_running"}


# --------------------------------------------------------------------------- #
# Clients
# --------------------------------------------------------------------------- #
def get_supabase() -> Client:
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def login_garmin() -> Garmin:
    """Local login: reuse tokens from TOKEN_DIR, fall back to .env credentials once."""
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    garmin = Garmin(email=os.getenv("GARMIN_EMAIL"), password=os.getenv("GARMIN_PASSWORD"))
    # Loads tokens from the path if present; otherwise logs in and dumps tokens there.
    garmin.login(str(TOKEN_DIR))
    return garmin


# --------------------------------------------------------------------------- #
# Grade Adjusted Pace (fallback when Garmin doesn't provide it)
# --------------------------------------------------------------------------- #
def _minetti_cost(grade: float) -> float:
    """Energy cost of running (J/kg/m) at a given grade — Minetti et al. 2002."""
    g = max(-0.45, min(0.45, grade))
    return 155.4 * g**5 - 30.4 * g**4 - 43.3 * g**3 + 46.3 * g**2 + 19.5 * g + 3.6


def estimate_gap_sec_per_km(splits: list[dict[str, Any]]) -> float | None:
    """Distance-weighted GAP from laps using net grade per lap."""
    total_dist = total_adj_time = 0.0
    for s in splits:
        dist, dur = s.get("distance_m") or 0, s.get("duration_s") or 0
        if dist < 50 or dur <= 0:
            continue
        grade = ((s.get("elevation_gain_m") or 0) - (s.get("elevation_loss_m") or 0)) / dist
        factor = _minetti_cost(grade) / 3.6
        total_adj_time += dur / factor
        total_dist += dist
    return round(total_adj_time / (total_dist / 1000), 1) if total_dist else None


def speed_to_pace(mps: float | None) -> float | None:
    return round(1000 / mps, 1) if mps and mps > 0 else None


# --------------------------------------------------------------------------- #
# Mapping
# --------------------------------------------------------------------------- #
def normalize_splits(raw_splits: dict[str, Any] | None) -> list[dict[str, Any]]:
    laps = (raw_splits or {}).get("lapDTOs") or []
    out = []
    for i, lap in enumerate(laps, start=1):
        out.append({
            "lap": i,
            "distance_m": lap.get("distance"),
            "duration_s": lap.get("duration"),
            "pace_sec_per_km": speed_to_pace(lap.get("averageSpeed")),
            "gap_sec_per_km": speed_to_pace(lap.get("avgGradeAdjustedSpeed")),
            "avg_hr": lap.get("averageHR"),
            "max_hr": lap.get("maxHR"),
            "elevation_gain_m": lap.get("elevationGain"),
            "elevation_loss_m": lap.get("elevationLoss"),
            "cadence_spm": lap.get("averageRunCadence"),
        })
    return out


def _round(v: Any, nd: int = 1) -> float | None:
    return round(float(v), nd) if v is not None else None


def _int(v: Any) -> int | None:
    return int(round(float(v))) if v is not None else None


def map_activity(a: dict[str, Any], splits: list[dict[str, Any]], user_id: str) -> dict[str, Any]:
    start_gmt = a.get("startTimeGMT")  # "YYYY-MM-DD HH:MM:SS"
    start_iso = (
        datetime.strptime(start_gmt, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).isoformat()
        if start_gmt else a.get("startTimeLocal")
    )
    gap = speed_to_pace(a.get("avgGradeAdjustedSpeed")) or estimate_gap_sec_per_km(splits)

    return {
        "user_id": user_id,
        "garmin_activity_id": a["activityId"],
        "start_time": start_iso,
        "activity_type": (a.get("activityType") or {}).get("typeKey", "running"),
        "name": a.get("activityName"),
        "distance_m": _round(a.get("distance")) or 0,
        "duration_s": _int(a.get("duration")) or 0,
        "moving_duration_s": _int(a.get("movingDuration")),
        "avg_pace_sec_per_km": speed_to_pace(a.get("averageSpeed")),
        "gap_sec_per_km": gap,
        "avg_hr": _int(a.get("averageHR")),
        "max_hr": _int(a.get("maxHR")),
        "elevation_gain_m": _round(a.get("elevationGain")),
        "elevation_loss_m": _round(a.get("elevationLoss")),
        "avg_cadence_spm": _int(a.get("averageRunningCadenceInStepsPerMinute")),
        "aerobic_training_effect": _round(a.get("aerobicTrainingEffect")),
        "training_load": _round(a.get("activityTrainingLoad")),
        "splits": splits,
        "raw": a,
    }


# --------------------------------------------------------------------------- #
# Sync (shared by the local CLI and the cloud worker)
# --------------------------------------------------------------------------- #
def sync_user(sb: Client, garmin: Garmin, user_id: str, days: int = 30, dry_run: bool = False) -> dict[str, Any]:
    end, start = date.today(), date.today() - timedelta(days=days)
    activities = garmin.get_activities_by_date(start.isoformat(), end.isoformat())
    runs = [a for a in activities if (a.get("activityType") or {}).get("typeKey") in RUNNING_TYPES]
    log.info("User %s: %d activities, %d runs (%s → %s)", user_id[:8], len(activities), len(runs), start, end)

    rows = []
    for a in runs:
        try:
            splits = normalize_splits(garmin.get_activity_splits(a["activityId"]))
        except Exception as exc:  # splits are optional — don't fail the whole sync
            log.warning("Splits unavailable for %s: %s", a["activityId"], exc)
            splits = []
        rows.append(map_activity(a, splits, user_id))
        time.sleep(0.3)  # be gentle with Garmin's rate limits

    if dry_run:
        for r in rows:
            log.info("[dry-run] %s  %.2f km  pace=%s  gap=%s", r["start_time"], r["distance_m"] / 1000,
                     r["avg_pace_sec_per_km"], r["gap_sec_per_km"])
        return {"fetched": len(runs), "upserted": 0, "dry_run": True}

    if rows:
        sb.table("activities").upsert(rows, on_conflict="user_id,garmin_activity_id").execute()
    set_profile_status(sb, user_id, f"ok: {len(rows)} runs", connected=True)
    return {"fetched": len(runs), "upserted": len(rows), "dry_run": False}


def set_profile_status(sb: Client, user_id: str, status: str, connected: bool) -> None:
    sb.table("profiles").update({
        "garmin_connected": connected,
        "garmin_last_sync_at": datetime.now(timezone.utc).isoformat(),
        "garmin_last_sync_status": status,
    }).eq("id", user_id).execute()


def run_sync(days: int = 30, dry_run: bool = False) -> dict[str, Any]:
    """Local single-user sync using credentials from .env."""
    user_id = os.environ["SUPABASE_USER_ID"]
    sb = get_supabase()
    try:
        garmin = login_garmin()
    except Exception as exc:
        set_profile_status(sb, user_id, f"error: {type(exc).__name__}", connected=False)
        raise
    return sync_user(sb, garmin, user_id, days=days, dry_run=dry_run)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sync Garmin Connect runs into Supabase")
    parser.add_argument("--days", type=int, default=30, help="How many days back to fetch (default 30)")
    parser.add_argument("--dry-run", action="store_true", help="Fetch and map, but don't write to Supabase")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print(run_sync(days=args.days, dry_run=args.dry_run))
