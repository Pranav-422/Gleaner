"""v2: worth-it score, shortcuts, screenshot and voice input, Ask AI, archive, link checks, verification."""

import json
import uuid
from contextlib import closing
from datetime import date, datetime, timedelta, timezone

import pytest

from app import checks, db, llm, main, pipeline, relay
from tests.test_pipeline import extraction, store

TODAY = date(2026, 11, 17)


def entry(job_id=None):
    with closing(db.db()) as conn:
        if job_id:
            return conn.execute("SELECT e.* FROM entries e JOIN jobs j ON j.entry_id = e.id WHERE j.id = ?", (job_id,)).fetchone()
        return conn.execute("SELECT * FROM entries ORDER BY id DESC").fetchone()


# ---------- worth-it score ----------


def test_worth_score_is_plain_arithmetic():
    best = {"relevance": "high", "credibility": "high", "payoff": "high", "effort": "low"}
    junk = {"relevance": "low", "credibility": "low", "payoff": "low", "effort": "high"}
    assert pipeline.worth(best, "2026-12-01", "2026-11-01T00:00:00+00:00", TODAY) == 100
    assert pipeline.worth(best, "2026-11-01", "2026-10-01T00:00:00+00:00", TODAY) == 90  # deadline passed
    assert pipeline.worth(junk, None, "2026-11-17T00:00:00+00:00", TODAY) == 10  # only freshness left
    assert pipeline.worth({}, None, "2026-01-01T00:00:00+00:00", TODAY) == 45  # all medium, old


# ---------- filing: shortcut and ratings ----------


def test_shortcut_only_into_a_different_folder(client):
    store(client, extraction(folder="tools", also_fits="repos", relevance="high"))
    row = entry()
    assert row["also"] == "repos" and json.loads(row["ratings"])["relevance"] == "high"
    store(client, extraction(folder="tools", title="Other tool", also_fits="tools"))
    assert entry()["also"] is None
    store(client, extraction(confidence=0.2, title="Unsure", also_fits="repos"))  # disputed: no shortcut
    assert entry()["also"] is None


def test_new_folders_are_valid():
    for folder in llm.FOLDERS:
        assert extraction(folder=folder).folder == folder
    assert set(llm.FOLDER_FIELDS) == set(llm.FOLDERS)


# ---------- screenshot and voice input ----------


def upload(name_ext="jpg", content=b"x"):
    folder = db.DATA_DIR / "uploads"
    folder.mkdir(exist_ok=True)
    name = f"{uuid.uuid4()}.{name_ext}"
    (folder / name).write_bytes(content)
    return name


def test_upload_actions_are_checked():
    good = upload()
    assert main.apply_action("screenshot", str(uuid.uuid4()), {"files": [good]}) is None
    assert main.apply_action("screenshot", str(uuid.uuid4()), {"files": ["../gleaner.db"]}).startswith("Bad request")
    assert main.apply_action("screenshot", str(uuid.uuid4()), {"files": [f"{uuid.uuid4()}.jpg"]}).startswith("Bad")
    assert main.apply_action("voice", str(uuid.uuid4()), {"files": [upload("webm"), upload("webm")]}).startswith("Bad")
    assert main.apply_action("screenshot", str(uuid.uuid4()), {"files": None}).startswith("Bad request")


def test_screenshot_job_skips_fetch_and_deletes_the_upload(client, monkeypatch):
    name = upload()
    job_id = str(uuid.uuid4())
    main.add_upload(job_id, "screenshot", [name])
    seen = {}
    monkeypatch.setattr(pipeline, "fetch", lambda *a: pytest.fail("a screenshot must not be fetched"))
    monkeypatch.setattr(pipeline, "to_jpeg", lambda path, out: out.write_bytes(b"j") or out)
    monkeypatch.setattr(pipeline, "read_videos", lambda v, c, d, w, photos=(): seen.setdefault("photos", photos) and pipeline.Extracted("HackIndia " * 40, []))
    monkeypatch.setattr(llm, "classify", lambda text, hint, images, voice=False: (extraction(), {"in": 1, "out": 1}))
    pipeline.run_job(job_id, "", None, None, "screenshot", [name])
    assert len(seen["photos"]) == 1
    assert not (db.DATA_DIR / "uploads" / name).exists()
    assert entry(job_id)["title"] == "CodeFest 2026"


def test_voice_note_is_transcribed_and_marked_as_voice(client, monkeypatch):
    name = upload("webm")
    job_id = str(uuid.uuid4())
    main.add_upload(job_id, "voice", [name])
    got = {}
    monkeypatch.setattr(pipeline, "audio", lambda path, workdir: path)
    monkeypatch.setattr(llm, "transcribe", lambda path: "remind me to email the professor about the internship")

    def classify(text, hint, images, voice=False):
        got.update(text=text, voice=voice)
        return extraction(folder="notes", is_task=True, title="Email the professor"), {"in": 1, "out": 1}

    monkeypatch.setattr(llm, "classify", classify)
    pipeline.run_job(job_id, "", None, None, "voice", [name])
    assert got["voice"] is True and got["text"].startswith("VOICE NOTE:")
    assert entry(job_id)["folder"] == "notes"


def test_relay_takes_only_the_owners_uploads(monkeypatch):
    cloud = relay.Cloud()
    cloud.owner = "owner-1"
    name = f"{uuid.uuid4()}.png"

    class Body:
        content = b"png"

    monkeypatch.setattr(cloud, "call", lambda method, path, **kw: Body())
    assert cloud._take_uploads({"paths": [f"someone-else/{name}"]}) == ([], {"files": None})
    assert cloud._take_uploads({"paths": ["owner-1/../../etc"]}) == ([], {"files": None})
    paths, payload = cloud._take_uploads({"paths": [f"owner-1/{name}"]})
    assert payload == {"files": [name]} and (db.DATA_DIR / "uploads" / name).read_bytes() == b"png"


# ---------- Ask AI ----------


def test_ask_keeps_a_short_chat_per_entry(client, monkeypatch):
    store(client, extraction())
    entry_id = entry()["id"]
    asked = {}

    def ask(context, history, question):
        asked.update(context=context, history=history)
        return "It is a student hackathon.", {"in": 1, "out": 1}

    monkeypatch.setattr(llm, "ask", ask)
    assert main.apply_action("ask", "x", {"entry_id": entry_id, "question": "Explain simply"}) is None
    assert main.apply_action("ask", "x", {"entry_id": entry_id, "question": "Why it matters"}) is None
    assert "CodeFest 2026" in asked["context"] and len(asked["history"]) == 2
    assert [turn["role"] for turn in json.loads(entry()["chat"])] == ["you", "ai", "you", "ai"]
    assert main.apply_action("ask", "x", {"entry_id": entry_id, "question": "x" * 600}).startswith("Bad request")


def test_ask_when_gemini_is_busy(client, monkeypatch):
    store(client, extraction())

    def busy(*a):
        raise llm.RateLimited("busy")

    monkeypatch.setattr(llm, "ask", busy)
    assert "busy" in main.apply_action("ask", "x", {"entry_id": entry()["id"], "question": "Explain"})


# ---------- archive ----------


def age(entry_id, days):
    old = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
    with closing(db.db()) as conn, conn:
        conn.execute("UPDATE entries SET created_at = ?, deadline = NULL WHERE id = ?", (old, entry_id))


def test_untouched_entries_are_archived_but_kept_and_decided_ones_stay(client, monkeypatch):
    monkeypatch.setattr(checks, "check_link", lambda link: {"status": "ok", "at": db.now()})
    monkeypatch.setattr(checks, "verify", lambda e: {"status": "unverified", "note": "", "at": db.now()})
    store(client, extraction(title="Old untouched"))
    old = entry()["id"]
    store(client, extraction(title="Old approved", folder="tools"))
    approved = entry()["id"]
    store(client, extraction(title="Fresh", folder="tools"))
    fresh = entry()["id"]
    for entry_id in (old, approved):
        age(entry_id, 40)
    main.decide(approved, main.Decision(decision="approved"))
    checks.upkeep()
    with closing(db.db()) as conn:
        archived = {row["id"] for row in conn.execute("SELECT id FROM entries WHERE archived_at IS NOT NULL")}
    assert archived == {old}

    main.apply_action("restore", "x", {"entry_id": old})
    checks.upkeep()
    assert entry_id_archived(old) is None  # restored entries are kept
    main.apply_action("archive", "x", {"entry_id": fresh})
    assert entry_id_archived(fresh) is not None


def entry_id_archived(entry_id):
    with closing(db.db()) as conn:
        return conn.execute("SELECT archived_at FROM entries WHERE id = ?", (entry_id,)).fetchone()["archived_at"]


# ---------- link checks: never reach private addresses ----------


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1", "nonexistent.invalid"])
def test_private_and_unknown_hosts_are_not_public(host):
    assert not checks.public_host(host)


@pytest.mark.parametrize(
    "url",
    ["http://127.0.0.1/admin", "https://localhost/", "https://example.com:8080/", "ftp://example.com/x",
     "https://user:pw@example.com/", "http://169.254.169.254/latest/meta-data"],
)  # fmt: skip
def test_safe_get_refuses_before_connecting(url, monkeypatch):
    monkeypatch.setattr(checks.httpx2, "stream", lambda *a, **k: pytest.fail("must not connect"))
    monkeypatch.setattr(checks, "public_host", lambda host: host == "example.com")
    with pytest.raises(checks.Blocked):
        checks.safe_get(url)


def test_redirect_to_a_private_address_is_refused(monkeypatch):
    class Res:
        status_code = 302
        headers = {"location": "http://127.0.0.1/secret"}

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(checks, "public_host", lambda host: host == "example.com")
    monkeypatch.setattr(checks.httpx2, "stream", lambda *a, **k: Res())
    with pytest.raises(checks.Blocked):
        checks.safe_get("https://example.com/go")


def test_check_link_states(monkeypatch):
    assert checks.normalise("unstop.com/codefest.") == "https://unstop.com/codefest"
    for code, state in [(200, "ok"), (403, "ok"), (404, "dead"), (500, "dead")]:
        monkeypatch.setattr(checks, "safe_get", lambda url, max_bytes=0, code=code: (code, "text/html", b""))
        assert checks.check_link("example.com")["status"] == state
    monkeypatch.setattr(checks, "safe_get", lambda *a, **k: (_ for _ in ()).throw(checks.Blocked("private")))
    assert checks.check_link("x.com")["status"] == "blocked"


# ---------- verification ----------


def test_news_is_confirmed_only_from_a_trusted_source(client, monkeypatch):
    store(client, extraction(folder="news", title="New policy", link="randomblog.example/post", deadline=None))
    monkeypatch.setattr(checks, "page_text", lambda link: "official text " * 50)
    monkeypatch.setattr(
        llm, "verify_page", lambda claims, text: (llm.Verification(status="verified", note="matches"), {"in": 1, "out": 1})
    )
    assert checks.verify(entry())["status"] == "unverified"
    store(client, extraction(folder="news", title="Policy two", link="pib.gov.in/release", deadline=None))
    assert checks.verify(entry())["status"] == "verified"


def test_official_deadline_replaces_the_reels(client, monkeypatch):
    store(client, extraction(link="unstop.com/codefest", deadline="2026-11-30"))
    monkeypatch.setattr(checks, "check_link", lambda link: {"status": "ok", "at": db.now()})
    monkeypatch.setattr(checks, "page_text", lambda link: "CodeFest registration closes 5 Dec 2026 " * 20)
    monkeypatch.setattr(
        llm,
        "verify_page",
        lambda claims, text: (llm.Verification(status="mismatch", note="Deadline differs", deadline="2026-12-05"), {}),
    )
    checks.upkeep()
    row = entry()
    assert row["deadline"] == "2026-12-05" and json.loads(row["checks"])["verify"]["status"] == "mismatch"


def test_no_link_and_no_search_quota_means_unverified(client, monkeypatch):
    monkeypatch.delenv("GEMINI_SEARCH", raising=False)
    store(client, extraction(link=None))
    assert checks.verify(entry())["status"] == "unverified"


# ---------- Claude connector: save_entry ----------


def test_save_entry_from_claude_is_validated_like_gemini_output():
    good = {"url": "https://www.instagram.com/reel/Abc1/", "notes": "Claude read it",
            "entry": {"folder": "tools", "title": "SupoClip", "summary": "Open source clipper.", "next_step": "Try it"}}
    assert main.apply_action("save_entry", str(uuid.uuid4()), good) is None
    row = entry()
    assert row["folder"] == "tools" and row["decision"] is None  # the owner still approves
    bad_link = {**good, "url": "https://evil.example/x"}
    assert main.apply_action("save_entry", str(uuid.uuid4()), bad_link).startswith("Bad request")
    bad_folder = {**good, "entry": {**good["entry"], "folder": "crypto"}}
    assert main.apply_action("save_entry", str(uuid.uuid4()), bad_folder).startswith("Bad request")
    assert main.apply_action("save_entry", str(uuid.uuid4()), "just a string").startswith("Bad request")
