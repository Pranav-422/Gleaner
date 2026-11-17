"""Gleaner backend: HTTP API, login, and the background worker.

Run from backend/:  uv run python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
Listens on localhost only; `tailscale serve` is the only way in from other devices.
"""

import asyncio
import json
import mimetypes
import os
import re
from contextlib import asynccontextmanager, closing
from datetime import date, timedelta
from typing import Literal
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, db, google, llm, pipeline

WEB_OUT = db.ROOT / "web" / "out"

# Windows takes MIME types from the registry, which can map .js to text/plain and break the app.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/manifest+json", ".webmanifest")


async def worker() -> None:
    """One job at a time, oldest first. A single worker is also what keeps free-tier usage gentle."""
    with closing(db.db()) as conn, conn:  # jobs cut off by a restart go back in the queue
        conn.execute("UPDATE jobs SET status = 'pending' WHERE status = 'processing'")
    while True:
        with closing(db.db()) as conn, conn:
            job = conn.execute(
                "SELECT id, url, hint, entry_id FROM jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if job:
                conn.execute("UPDATE jobs SET status = 'processing' WHERE id = ?", (job["id"],))
        if not job:
            await asyncio.to_thread(db.backup)  # does nothing if today's copy exists
            await asyncio.sleep(3)
            continue
        status, error, pause = "done", None, 0
        try:
            await asyncio.to_thread(pipeline.run_job, job["id"], job["url"], job["hint"], job["entry_id"])
        except llm.RateLimited as exc:
            status, error, pause = "pending", str(exc), 60
        except Exception as exc:  # any failure is recorded on the job; the owner can re-run it
            status, error = "failed", re.sub(r"\x1b\[[0-9;]*m", "", f"{type(exc).__name__}: {exc}")[:300]
        if status != "done":
            with closing(db.db()) as conn, conn:
                conn.execute("UPDATE jobs SET status = ?, error = ? WHERE id = ?", (status, error, job["id"]))
        await asyncio.sleep(pause)


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(worker())
    yield
    task.cancel()


app = FastAPI(title="Gleaner", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

# Everything else under /api needs a logged-in session. The Google callback is protected by its state value.
OPEN_PATHS = {"/api/login", "/api/google/callback"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path not in OPEN_PATHS:
        if not auth.password_configured():
            return JSONResponse({"detail": "No password is set. In backend/, run: uv run python -m app.auth"}, 503)
        if not auth.session_valid(request.cookies.get(auth.COOKIE)):
            return JSONResponse({"detail": "Login needed"}, 401)
    return await call_next(request)


# ---------- login ----------


class Login(BaseModel):
    password: str = Field(max_length=200)


@app.post("/api/login")
def login(body: Login, request: Request, response: Response):
    if not auth.check_password(body.password):
        raise HTTPException(401, "Wrong password. After 5 wrong tries, wait 5 minutes.")
    response.set_cookie(
        auth.COOKIE,
        auth.new_session(),
        max_age=auth.SESSION_DAYS * 86400,
        httponly=True,
        samesite="strict",
        # Browsers refuse Secure cookies over plain http, which is only ever used on the laptop itself.
        secure=request.url.hostname not in ("127.0.0.1", "localhost"),
    )
    return {"ok": True}


@app.post("/api/logout")
def logout(request: Request, response: Response):
    auth.end_session(request.cookies.get(auth.COOKIE))
    response.delete_cookie(auth.COOKIE)
    return {"ok": True}


@app.get("/api/status")
def status():
    return {
        "gemini_key": bool(os.environ.get("GEMINI_API_KEY")),
        "groq_key": bool(os.environ.get("GROQ_API_KEY")),
        "google_configured": google.configured(),
        "google_connected": google.connected(),
    }


# ---------- shares and jobs ----------


class Share(BaseModel):
    id: UUID  # made on the phone, so a resend of the same share cannot create a second job
    text: str = Field(max_length=2000)


@app.post("/api/share", status_code=201)
def share(body: Share):
    url = pipeline.instagram_url(body.text)
    if url is None:
        raise HTTPException(422, "No Instagram link found")
    with closing(db.db()) as conn, conn:
        conn.execute(
            "INSERT OR IGNORE INTO jobs (id, url, created_at) VALUES (?, ?, ?)", (str(body.id), url, db.now())
        )
    return {"id": str(body.id), "url": url}


@app.get("/api/jobs")
def jobs():
    with closing(db.db()) as conn:
        rows = conn.execute(
            "SELECT j.id, j.url, j.status, j.error, j.created_at, j.tokens_in, j.tokens_out,"
            " e.folder, e.review, e.title FROM jobs j LEFT JOIN entries e ON e.id = j.entry_id"
            " ORDER BY j.created_at DESC LIMIT 100"
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/jobs/{job_id}/retry")
def retry(job_id: UUID):
    with closing(db.db()) as conn, conn:
        changed = conn.execute(
            "UPDATE jobs SET status = 'pending', error = NULL WHERE id = ? AND status = 'failed'", (str(job_id),)
        ).rowcount
    if not changed:
        raise HTTPException(404, "No failed job with that id")
    return {"ok": True}


# ---------- entries ----------


def _entry(row) -> dict:
    entry = dict(row)
    for column in ("guesses", "data", "frames"):
        entry[column] = json.loads(entry[column])
    entry["expired"] = bool(entry["deadline"]) and entry["deadline"] < date.today().isoformat()
    return entry


def _get_entry(conn, entry_id: int):
    row = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "No such entry")
    return row


@app.get("/api/entries")
def entries():
    with closing(db.db()) as conn:
        # Soonest deadline first, then newest: there is no score in v1.
        rows = conn.execute("SELECT * FROM entries ORDER BY deadline IS NULL, deadline, created_at DESC").fetchall()
    return [_entry(row) for row in rows]


class FileInto(BaseModel):
    folder: llm.Folder


@app.post("/api/entries/{entry_id}/file")
def file_entry(entry_id: int, body: FileInto):
    """The owner picks the folder for a disputed entry."""
    with closing(db.db()) as conn, conn:
        _get_entry(conn, entry_id)
        conn.execute("UPDATE entries SET folder = ?, review = NULL WHERE id = ?", (body.folder, entry_id))
    return {"ok": True}


class Context(BaseModel):
    hint: str = Field(min_length=3, max_length=1000)


@app.post("/api/entries/{entry_id}/context")
def add_context(entry_id: int, body: Context):
    """The owner explains what the reel is about; the job runs again with that explanation."""
    with closing(db.db()) as conn, conn:
        _get_entry(conn, entry_id)
        conn.execute(
            "UPDATE jobs SET hint = ?, status = 'pending', error = NULL"
            " WHERE id = (SELECT id FROM jobs WHERE entry_id = ? ORDER BY created_at DESC LIMIT 1)",
            (body.hint, entry_id),
        )
    return {"ok": True}


class Decision(BaseModel):
    decision: Literal["approved", "skipped"]


@app.post("/api/entries/{entry_id}/decision")
def decide(entry_id: int, body: Decision):
    """Approve or skip the next step. Calendar and task writes happen here and nowhere else."""
    with closing(db.db()) as conn:
        entry = _get_entry(conn, entry_id)
    if entry["review"]:
        raise HTTPException(409, "File this entry into a folder first")

    event_id = task_id = None
    synced = False
    if body.decision == "approved" and entry["decision"] != "approved" and google.connected():
        today = date.today()
        deadline = date.fromisoformat(entry["deadline"]) if entry["deadline"] else None
        upcoming = deadline is not None and deadline >= today
        notes = "\n".join(part for part in (entry["title"], entry["summary"], entry["url"]) if part)
        try:
            if upcoming:
                event_id = google.add_deadline(entry["title"], deadline, notes)
            task_id = google.add_task(
                entry["next_step"] or entry["title"], notes, deadline if upcoming else today + timedelta(days=3)
            )
        except RuntimeError as exc:
            raise HTTPException(502, str(exc)) from exc
        synced = True

    with closing(db.db()) as conn, conn:
        conn.execute(
            "UPDATE entries SET decision = ?, event_id = COALESCE(?, event_id), task_id = COALESCE(?, task_id)"
            " WHERE id = ?",
            (body.decision, event_id, task_id, entry_id),
        )
    return {"decision": body.decision, "google": synced}


@app.get("/api/frames/{name}")
def frame(name: str):
    path = db.DATA_DIR / "frames" / name
    if not re.fullmatch(r"[0-9a-f-]{36}_\d\.jpg", name) or not path.is_file():
        raise HTTPException(404, "No such frame")
    return FileResponse(path, media_type="image/jpeg")


# ---------- Google ----------


@app.get("/api/google/start")
def google_start():
    if not google.configured():
        raise HTTPException(400, "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in backend/.env")
    return RedirectResponse(google.auth_url())


@app.get("/api/google/callback")
def google_callback(code: str = "", state: str = "", error: str = ""):
    if error or not code:
        return PlainTextResponse(f"Google sign-in was cancelled ({error or 'no code'}).", 400)
    try:
        google.finish(code, state)
    except (PermissionError, RuntimeError) as exc:
        return PlainTextResponse(str(exc), 400)
    return RedirectResponse("/")


@app.post("/api/google/disconnect")
def google_disconnect():
    google.disconnect()
    return {"ok": True}


# Mounted last so /api routes win. Missing until `npm run build` has run in web/.
if WEB_OUT.is_dir():
    app.mount("/", StaticFiles(directory=WEB_OUT, html=True), name="web")
