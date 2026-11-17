"""The relay: phone actions run through the API's own checks, and the laptop's state is pushed back."""

import json
import uuid
from contextlib import closing

from app import db, main, relay


def test_share_action_creates_job():
    action_id = str(uuid.uuid4())
    assert main.apply_action("share", action_id, {"text": "look https://www.instagram.com/reel/AbC123/?igsh=x"}) is None
    with closing(db.db()) as conn:
        row = conn.execute("SELECT url FROM jobs WHERE id = ?", (action_id,)).fetchone()
    assert row["url"] == "https://www.instagram.com/reel/AbC123/"


def test_bad_actions_return_errors_not_exceptions():
    assert main.apply_action("share", str(uuid.uuid4()), {"text": "https://evil.example/reel/1"}) == "No Instagram link found"
    assert main.apply_action("decision", "x", {"entry_id": 99, "decision": "approved"}) == "No such entry"
    assert main.apply_action("decision", "x", {"entry_id": 1, "decision": "delete everything"}).startswith("Bad request")
    assert main.apply_action("file", "x", "not an object").startswith("Bad request")
    assert main.apply_action("retry", "x", {"job_id": "nope"}).startswith("Bad request")
    assert main.apply_action("drop_table", "x", {}) == "Unknown action: drop_table"


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def json(self):
        return self.body


def test_sync_applies_actions_and_pushes_state(monkeypatch):
    cloud = relay.Cloud()
    cloud.owner = "owner-1"
    calls = []
    good, bad = str(uuid.uuid4()), str(uuid.uuid4())
    pending = [
        {"id": good, "kind": "share", "payload": {"text": "https://www.instagram.com/reel/Good1/"}},
        {"id": bad, "kind": "share", "payload": {"text": "no link here"}},
    ]

    def call(method, path, headers=None, **kwargs):
        calls.append((method, path, kwargs))
        return FakeResponse(pending if method == "GET" else None)

    monkeypatch.setattr(cloud, "call", call)
    cloud.sync(main.apply_action, main.snapshot)

    assert ("DELETE", "/rest/v1/actions", {"params": {"id": f"eq.{good}"}}) in calls
    failed = [c for c in calls if c[0] == "PATCH"]
    assert failed[0][2]["params"] == {"id": f"eq.{bad}"} and failed[0][2]["json"]["status"] == "failed"
    pushed = [c for c in calls if c[1] == "/rest/v1/state"]
    assert pushed[0][2]["json"]["owner"] == "owner-1"
    assert [job["id"] for job in pushed[0][2]["json"]["jobs"]] == [good]

    # Nothing changed and the heartbeat is not due: no second push.
    calls.clear()
    pending.clear()
    cloud.sync(main.apply_action, main.snapshot)
    assert not [c for c in calls if c[1] == "/rest/v1/state"]


def test_frames_upload_once(monkeypatch):
    (db.DATA_DIR / "frames").mkdir()
    (db.DATA_DIR / "frames" / "a_0.jpg").write_bytes(b"jpg")
    cloud = relay.Cloud()
    cloud.owner = "owner-1"
    uploads = []
    monkeypatch.setattr(cloud, "call", lambda method, path, **kwargs: uploads.append(path))
    entries = [{"frames": ["a_0.jpg"]}]
    cloud._upload_frames(entries)
    cloud._upload_frames(entries)
    assert uploads == ["/storage/v1/object/frames/owner-1/a_0.jpg"]
    assert json.loads(db.get_setting("cloud_frames")) == ["a_0.jpg"]


def test_google_connect_from_phone(monkeypatch):
    assert "not set" in main.apply_action("google_start", "x", {})
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "id")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "secret")
    assert main.apply_action("google_start", "x", {}) is None
    link = main.status()["google_auth_url"]
    assert link.startswith("https://accounts.google.com/") and "code_challenge=" in link
    # A code that comes back with the wrong state is refused before Google is ever called.
    assert "invalid or has expired" in main.apply_action("google_code", "x", {"code": "c", "state": "forged"})
    assert main.status()["google_auth_url"] is None  # the link is single use
    assert main.apply_action("google_code", "x", {"code": ["c"], "state": "s"}).startswith("Bad request")


def test_snapshot_sends_raw_text_only_for_needs_context(client):
    from app import pipeline
    pipeline.store(str(uuid.uuid4()), "https://www.instagram.com/reel/a/", None, "long text", [], None, {"in": 0, "out": 0})
    entry = main.snapshot()["entries"][0]
    assert entry["review"] == "needs_context" and entry["raw_text"] == "long text"
