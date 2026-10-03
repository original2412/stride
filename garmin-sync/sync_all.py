"""
Cloud sync worker: syncs every user who linked Garmin in the app.

Credentials and session tokens come from Supabase Vault via service-role RPCs
(`garmin_sync_targets`, `save_garmin_tokens`). Runs on a schedule in GitHub Actions.

Usage:
    python sync_all.py                 # everyone due for a sync
    python sync_all.py --only-requested  # only users who pressed "sync now"
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)
from supabase import Client

from sync import get_supabase, set_profile_status, sync_user

log = logging.getLogger("garmin-sync-all")


def _parse_ts(v: str | None) -> datetime | None:
    return datetime.fromisoformat(v.replace("Z", "+00:00")) if v else None


def _set_link(sb: Client, user_id: str, **fields: Any) -> None:
    sb.table("garmin_links").update(fields).eq("user_id", user_id).execute()


def login_for(target: dict[str, Any]) -> Garmin:
    """Resume from stored tokens when possible; otherwise log in with the stored password."""
    garmin = Garmin(email=target["garmin_email"], password=target["password"], prompt_mfa=_no_mfa)
    garmin.login(target["tokens"] or None)
    return garmin


class MfaRequired(Exception):
    pass


def _no_mfa() -> str:
    # Unattended worker can't answer an MFA prompt.
    raise MfaRequired()


def sync_target(sb: Client, target: dict[str, Any], days: int) -> bool:
    uid = target["user_id"]
    try:
        garmin = login_for(target)
        sb.rpc("save_garmin_tokens", {"p_user": uid, "p_tokens": garmin.client.dumps()}).execute()
        # First sync pulls more history so VDOT has 6 weeks of data.
        lookback = days if target["last_sync_at"] else max(days, 60)
        result = sync_user(sb, garmin, uid, days=lookback)
        _set_link(sb, uid, status="ok", last_error=None, last_sync_at=datetime.now(timezone.utc).isoformat())
        log.info("User %s synced: %s", uid[:8], result)
        return True
    except MfaRequired:
        _set_link(sb, uid, status="mfa_required", last_error="Garmin דורש אימות דו-שלבי (MFA)")
    except GarminConnectAuthenticationError as exc:
        _set_link(sb, uid, status="auth_error", last_error=str(exc)[:300])
        set_profile_status(sb, uid, "error: auth", connected=False)
    except (GarminConnectConnectionError, GarminConnectTooManyRequestsError) as exc:
        _set_link(sb, uid, status="error", last_error=f"{type(exc).__name__}: {exc}"[:300])
    except Exception as exc:  # keep going for other users
        log.exception("User %s failed", uid[:8])
        _set_link(sb, uid, status="error", last_error=f"{type(exc).__name__}: {exc}"[:300])
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync all linked Garmin accounts")
    parser.add_argument("--days", type=int, default=14)
    parser.add_argument("--only-requested", action="store_true", help="Only users who requested a sync")
    parser.add_argument("--min-interval-hours", type=float, default=1.5)
    parser.add_argument(
        "--tokens-only",
        action="store_true",
        help="Cloud mode: never log in with a password (Garmin blocks datacenter IPs); "
        "only resume users who already have session tokens from a first login at home.",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    sb = get_supabase()
    targets = sb.rpc("garmin_sync_targets").execute().data or []
    now = datetime.now(timezone.utc)
    ok = failed = skipped = 0

    for t in targets:
        if not t.get("password") and not t.get("tokens"):
            skipped += 1
            continue
        if args.tokens_only and not t.get("tokens"):
            if t.get("status") != "pending":
                _set_link(sb, t["user_id"], status="pending",
                          last_error="ממתין להתחברות ראשונה מהמחשב (Garmin חוסם התחברות ראשונה משרתי ענן)")
            skipped += 1
            continue
        requested = _parse_ts(t.get("sync_requested_at"))
        last = _parse_ts(t.get("last_sync_at"))
        is_requested = requested is not None and (last is None or requested > last)
        if args.only_requested and not is_requested:
            skipped += 1
            continue
        # Don't hammer Garmin: skip users synced very recently unless they asked.
        if not is_requested and last and now - last < timedelta(hours=args.min_interval_hours):
            skipped += 1
            continue
        if sync_target(sb, t, args.days):
            ok += 1
        else:
            failed += 1

    log.info("Done: %d ok, %d failed, %d skipped", ok, failed, skipped)
    # Per-user failures are reported in the app; don't fail the scheduled job for them.
    return 0


if __name__ == "__main__":
    sys.exit(main())
