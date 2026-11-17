"""Cloud relay: phone and laptop meet in Supabase, so no tunnel and no open port are needed.

Phone  -> `actions` table (shares, approvals, ...). The laptop applies each one with the local API's own code.
Laptop -> `state` row (jobs, entries, status, seen_at) and the private `frames` bucket. The phone reads those.
The laptop signs in as the owner, so row level security applies to it as well: no service_role key exists here.
"""

import hashlib
import json
import os
import re
import time
from collections.abc import Callable

import httpx2

from . import db

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
# Files the phone uploads: <owner id>/<uuid>.<ext>. Anything else is refused before it is downloaded.
UPLOAD_NAME = re.compile(r"[0-9a-f-]{36}\.(jpg|jpeg|png|webp|webm|ogg|m4a|mp4|mp3)")
MAX_UPLOAD = 20 * 1024 * 1024
ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
HEARTBEAT = 60  # seconds between state pushes when nothing changed; the phone calls the laptop offline after 150


def configured() -> bool:
    return bool(URL and ANON_KEY and os.environ.get("SUPABASE_EMAIL") and os.environ.get("SUPABASE_PASSWORD"))


class Cloud:
    def __init__(self) -> None:
        self.http = httpx2.Client(base_url=URL, timeout=30, headers={"apikey": ANON_KEY})
        self.token, self.expires, self.owner = "", 0.0, ""
        self.digest, self.pushed = "", 0.0

    def _sign_in(self) -> None:
        if time.monotonic() < self.expires:
            return
        res = self.http.post(
            "/auth/v1/token",
            params={"grant_type": "password"},
            json={"email": os.environ["SUPABASE_EMAIL"], "password": os.environ["SUPABASE_PASSWORD"]},
        )
        if res.status_code != 200:
            raise RuntimeError(f"Supabase sign-in failed (status {res.status_code}). Check SUPABASE_EMAIL/PASSWORD.")
        body = res.json()
        self.token, self.owner = body["access_token"], body["user"]["id"]
        self.expires = time.monotonic() + body.get("expires_in", 3600) - 120

    def call(self, method: str, path: str, headers: dict | None = None, **kwargs) -> httpx2.Response:
        self._sign_in()
        res = self.http.request(method, path, headers={"Authorization": f"Bearer {self.token}", **(headers or {})}, **kwargs)
        if res.status_code == 401:
            self.expires = 0.0  # token revoked or expired early: sign in again on the next call
        if res.status_code >= 300:
            raise RuntimeError(f"Supabase {method} {path}: {res.status_code} {res.text[:200]}")
        return res

    def sync(self, apply: Callable[[str, str, object], str | None], snapshot: Callable[[], dict]) -> None:
        """One round: apply the phone's actions, upload new frames, push the state if it changed or is stale."""
        actions = self.call(
            "GET", "/rest/v1/actions", params={"status": "eq.pending", "order": "created_at", "select": "id,kind,payload"}
        ).json()
        for action in actions:
            payload, paths = action["payload"], []
            if action["kind"] in ("screenshot", "voice"):
                paths, payload = self._take_uploads(payload)
            error = apply(action["kind"], action["id"], payload)
            where = {"id": f"eq.{action['id']}"}
            if error is None:
                self.call("DELETE", "/rest/v1/actions", params=where)
            else:  # left in the table so the phone can show why
                self.call("PATCH", "/rest/v1/actions", params=where, json={"status": "failed", "error": error[:300]})
            if paths:  # the laptop has its copy (or refused it); nothing stays in the cloud
                self.call("DELETE", "/storage/v1/object/uploads", json={"prefixes": paths})

        state = snapshot()
        self._upload_frames(state["entries"])
        digest = hashlib.sha256(json.dumps(state, sort_keys=True, default=str).encode()).hexdigest()
        if digest != self.digest or time.monotonic() - self.pushed > HEARTBEAT:
            self.call(
                "POST",
                "/rest/v1/state",
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
                # The phone polls only seen_at and digest, and downloads the rest when the digest changes.
                json={"owner": self.owner, **state, "digest": digest, "seen_at": db.now()},
            )
            self.digest, self.pushed = digest, time.monotonic()

    def _take_uploads(self, payload) -> tuple[list[str], dict]:
        """Download the phone's uploads into DATA_DIR/uploads. Returns their cloud paths and the payload to apply."""
        paths = payload.get("paths") if isinstance(payload, dict) else None
        if not isinstance(paths, list) or not 1 <= len(paths) <= 5:
            return [], {"files": None}
        names = []
        for path in paths:
            owner, _, name = str(path).partition("/")
            if owner != self.owner or not UPLOAD_NAME.fullmatch(name):
                return [], {"files": None}
            names.append(name)
        folder = db.DATA_DIR / "uploads"
        folder.mkdir(parents=True, exist_ok=True)
        for path, name in zip(paths, names):
            body = self.call("GET", f"/storage/v1/object/authenticated/uploads/{path}").content
            if len(body) > MAX_UPLOAD:
                return paths, {"files": None}
            (folder / name).write_bytes(body)
        return paths, {"files": names}

    def _upload_frames(self, entries: list[dict]) -> None:
        uploaded = set(json.loads(db.get_setting("cloud_frames") or "[]"))
        new = {name for entry in entries for name in entry["frames"]} - uploaded
        for name in sorted(new):
            path = db.DATA_DIR / "frames" / name
            if path.is_file():
                self.call(
                    "POST",
                    f"/storage/v1/object/frames/{self.owner}/{name}",
                    headers={"Content-Type": "image/jpeg", "x-upsert": "true"},
                    content=path.read_bytes(),
                )
            uploaded.add(name)
        if new:
            db.set_setting("cloud_frames", json.dumps(sorted(uploaded)))
