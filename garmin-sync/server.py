"""
Tiny HTTP wrapper so the PWA's "Sync with Garmin" button can trigger a sync on demand.

    uvicorn server:app --host 0.0.0.0 --port 8787

POST /sync?days=30   (Authorization: Bearer <supabase access token>)
"""
from __future__ import annotations

import logging
import os
import threading

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from sync import get_supabase, run_sync

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

app = FastAPI(title="Garmin Sync")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")],
    allow_methods=["POST", "GET"],
    allow_headers=["Authorization", "Content-Type"],
)
_lock = threading.Lock()  # one sync at a time


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/sync")
def sync(days: int = 30, authorization: str = Header(default="")) -> dict:
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "Missing bearer token")

    # Validate the Supabase JWT and make sure it belongs to the Garmin account owner.
    try:
        user = get_supabase().auth.get_user(token).user
    except Exception:
        raise HTTPException(401, "Invalid token")
    if not user or user.id != os.environ["SUPABASE_USER_ID"]:
        raise HTTPException(403, "This sync service is bound to a different user")

    if not _lock.acquire(blocking=False):
        raise HTTPException(409, "Sync already running")
    try:
        return run_sync(days=max(1, min(days, 90)))
    except Exception as exc:
        logging.exception("Sync failed")
        raise HTTPException(502, f"Garmin sync failed: {exc}")
    finally:
        _lock.release()
