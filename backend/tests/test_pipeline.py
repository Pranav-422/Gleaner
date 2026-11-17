import shutil
import subprocess
import sys
import uuid
from datetime import date, timedelta

import pytest
from pydantic import ValidationError

from app import db, google, llm, pipeline


def extraction(**changes):
    base = {
        "folder": "hackathons",
        "second_folder": "opportunities",
        "confidence": 0.9,
        "readable": True,
        "title": "CodeFest 2026",
        "summary": "A student hackathon.",
        "next_step": "Register on Unstop",
        "deadline": "2026-11-30",
        "prize": "Rs 50,000",
    }
    return llm.Extraction.model_validate({**base, **changes})


def share(client):
    job_id = str(uuid.uuid4())
    client.post("/api/share", json={"id": job_id, "text": "https://www.instagram.com/reel/abc/"})
    return job_id


def store(client, result, entry_id=None):
    job_id = share(client)
    pipeline.store(job_id, "https://www.instagram.com/reel/abc/", entry_id, "raw", [], result, {"in": 10, "out": 5})
    return job_id


# ---------- rule cleanup ----------


def test_hints_find_links_dates_amounts_and_handles():
    found = pipeline.hints("Register by 30 Nov 2026 at unstop.com/codefest. Prize ₹50,000 or Rs 1 lakh. Follow @codefest_in")
    assert found["links"] == ["unstop.com/codefest"]
    assert found["dates"] == ["30 Nov 2026"]
    assert found["amounts"] == ["₹50,000", "Rs 1 lakh"]
    assert found["handles"] == ["@codefest_in"]


def test_repeated_and_half_drawn_lines_are_merged():
    pages = [["CodeFest Hack", "Free"], ["CodeFest Hackathon 2026", "Free", "•"], ["CodeFest Hackath0n 2026"]]
    assert pipeline.merge_lines(pages) == ["Free", "CodeFest Hackathon 2026"]


def test_clean_is_empty_when_the_reel_gave_nothing():
    assert pipeline.clean("", [[], ["•"]], "  ") == ""


# ---------- model output is validated before anything is stored ----------


def test_schema_sent_to_gemini_matches_the_validation_model():
    assert set(llm.RESPONSE_SCHEMA["properties"]) == set(llm.Extraction.model_fields)


@pytest.mark.parametrize("bad", [{"folder": "crypto"}, {"confidence": 7}, {"deadline": "next week"}])
def test_malformed_model_output_is_rejected(bad):
    with pytest.raises(ValidationError):
        extraction(**bad)


# ---------- filing ----------


def test_confident_result_is_filed_with_its_fields(client):
    store(client, extraction())
    [entry] = client.get("/api/entries").json()
    assert (entry["folder"], entry["review"], entry["deadline"]) == ("hackathons", None, "2026-11-30")
    assert entry["data"] == {"prize": "Rs 50,000"}
    [job] = client.get("/api/jobs").json()
    assert (job["status"], job["folder"], job["tokens_in"]) == ("done", "hackathons", 10)


def test_unsure_result_goes_to_disputed_with_two_guesses(client):
    store(client, extraction(confidence=0.4))
    [entry] = client.get("/api/entries").json()
    assert (entry["folder"], entry["review"]) == (None, "disputed")
    assert entry["guesses"] == ["hackathons", "opportunities"]
    client.post(f"/api/entries/{entry['id']}/file", json={"folder": "opportunities"})
    [entry] = client.get("/api/entries").json()
    assert (entry["folder"], entry["review"]) == ("opportunities", None)


def test_unreadable_reel_goes_to_needs_context_and_a_hint_requeues_it(client):
    job_id = store(client, None)
    [entry] = client.get("/api/entries").json()
    assert entry["review"] == "needs_context"
    assert client.post(f"/api/entries/{entry['id']}/context", json={"hint": "It is a hackathon poster"}).status_code == 200
    [job] = client.get("/api/jobs").json()
    assert job["status"] == "pending"
    # The worker then stores the second result into the same entry.
    pipeline.store(job_id, entry["url"], entry["id"], "raw", [], extraction(), {"in": 1, "out": 1})
    [entry] = client.get("/api/entries").json()
    assert (entry["folder"], entry["review"]) == ("hackathons", None)


def test_same_hackathon_shared_twice_is_one_entry_with_gaps_filled(client):
    store(client, extraction(deadline=None))
    store(client, extraction(title="codefest 2026!", prize="Rs 99", organiser="IIT Delhi"))
    [entry] = client.get("/api/entries").json()
    assert entry["deadline"] == "2026-11-30"
    assert entry["data"] == {"prize": "Rs 50,000", "organiser": "IIT Delhi"}  # first value wins, gaps filled


def test_past_deadline_is_flagged_expired(client):
    store(client, extraction(deadline=(date.today() - timedelta(days=1)).isoformat()))
    assert client.get("/api/entries").json()[0]["expired"] is True


# ---------- decisions ----------


def test_approve_without_google_records_the_decision_only(client):
    store(client, extraction())
    [entry] = client.get("/api/entries").json()
    res = client.post(f"/api/entries/{entry['id']}/decision", json={"decision": "approved"})
    assert res.json() == {"decision": "approved", "google": False}
    assert client.get("/api/entries").json()[0]["decision"] == "approved"


def test_approve_writes_calendar_and_task_once(client, monkeypatch):
    calls = []
    monkeypatch.setattr(google, "connected", lambda: True)
    monkeypatch.setattr(google, "add_deadline", lambda *args: calls.append("event") or "ev1")
    monkeypatch.setattr(google, "add_task", lambda *args: calls.append("task") or "t1")
    store(client, extraction(deadline=(date.today() + timedelta(days=10)).isoformat()))
    [entry] = client.get("/api/entries").json()
    for _ in range(2):
        client.post(f"/api/entries/{entry['id']}/decision", json={"decision": "approved"})
    assert calls == ["event", "task"]
    [entry] = client.get("/api/entries").json()
    assert (entry["event_id"], entry["task_id"]) == ("ev1", "t1")


def test_entry_in_review_cannot_be_approved(client):
    store(client, extraction(confidence=0.1))
    [entry] = client.get("/api/entries").json()
    assert client.post(f"/api/entries/{entry['id']}/decision", json={"decision": "approved"}).status_code == 409


def test_deadline_event_reminds_at_9am_three_days_and_one_day_before():
    event = google.deadline_event("CodeFest", date(2026, 11, 30), "notes")
    assert event["start"] == {"date": "2026-11-30"} and event["end"] == {"date": "2026-12-01"}
    assert [r["minutes"] for r in event["reminders"]["overrides"]] == [3780, 900]


# ---------- real frames + OCR on a generated video ----------


@pytest.mark.skipif(sys.platform != "win32" or not shutil.which("ffmpeg"), reason="needs Windows OCR and FFmpeg")
def test_text_on_screen_is_read_from_a_video(tmp_path, monkeypatch):
    font = "fontfile='C\\:/Windows/Fonts/arialbd.ttf'"
    scenes = [("0x202060", "CodeFest Hackathon 2026", "Prize Rs 50,000"), ("0x603020", "Register by 30 Nov 2026", "unstop.com/codefest")]
    inputs, filters = [], []
    for index, (colour, top, bottom) in enumerate(scenes):
        inputs += ["-f", "lavfi", "-i", f"color=c={colour}:s=720x1280:d=4"]
        filters.append(
            f"[{index}:v]drawtext={font}:text='{top}':fontcolor=white:fontsize=46:x=40:y=300,"
            f"drawtext={font}:text='{bottom}':fontcolor=white:fontsize=40:x=40:y=420[v{index}]"
        )
    video = tmp_path / "reel.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filters) + ";[v0][v1]concat=n=2:v=1:a=0[v]",
         "-map", "[v]", "-pix_fmt", "yuv420p", str(video)],
        check=True,
    )  # fmt: skip
    monkeypatch.setattr(llm, "transcribe", lambda track: "")

    result = pipeline.read_videos([video], "Tag a friend! #hackathon", 8, tmp_path)

    for expected in ("CodeFest Hackathon 2026", "Register by 30 Nov 2026", "links: unstop.com/codefest", "dates: 30 Nov 2026"):
        assert expected in result.text
    assert result.text.count("CodeFest Hackathon 2026") == 1  # seen in several frames, kept once
    assert 1 <= len(result.frames) <= pipeline.KEPT_FRAMES


def test_photo_only_from_instagram_cdn(tmp_path):
    for url in ("https://evil.example/a.jpg", "http://scontent.cdninstagram.com/a.jpg", "https://fbcdn.net.evil.example/a.jpg"):
        assert pipeline.photo(url, tmp_path / "a.jpg") is None


def test_gemini_retry_does_not_download_again(client, monkeypatch):
    from app import llm
    pulls, calls = [], []
    monkeypatch.setattr(pipeline, "extract", lambda url, tmp: pulls.append(url) or pipeline.Extracted("x" * 300, []))

    def classify(text, hint, images, voice=False):
        calls.append(text)
        if len(calls) == 1:
            raise llm.RateLimited("busy")
        return extraction(), {"in": 1, "out": 1}

    monkeypatch.setattr(llm, "classify", classify)
    job_id = client.post("/api/share", json={"id": str(uuid.uuid4()), "text": "https://www.instagram.com/reel/r1/"}).json()["id"]
    with pytest.raises(llm.RateLimited):
        pipeline.run_job(job_id, "https://www.instagram.com/reel/r1/", None, None)
    pipeline.run_job(job_id, "https://www.instagram.com/reel/r1/", None, None)
    assert len(pulls) == 1 and len(calls) == 2
    assert not list((db.DATA_DIR / "extracted").iterdir())  # cache gone once stored
