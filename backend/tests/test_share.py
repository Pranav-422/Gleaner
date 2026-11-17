import uuid

import pytest


def post(client, text, share_id=None):
    return client.post("/api/share", json={"id": share_id or str(uuid.uuid4()), "text": text})


def test_share_creates_pending_job_without_tracking_params(client):
    res = post(client, "Look at this https://www.instagram.com/reel/Cabc-_12/?igsh=secret")
    assert res.status_code == 201
    [job] = client.get("/api/jobs").json()
    assert job["url"] == "https://www.instagram.com/reel/Cabc-_12/"
    assert job["status"] == "pending"


def test_resending_the_same_share_makes_one_job(client):
    share_id = str(uuid.uuid4())
    for _ in range(2):
        assert post(client, "https://instagram.com/p/XYZ/", share_id).status_code == 201
    assert len(client.get("/api/jobs").json()) == 1


@pytest.mark.parametrize(
    "text",
    [
        "no link here",
        "https://evil.example/reel/abc/",
        "https://www.instagram.com@evil.example/reel/abc/",
        "https://www.instagram.com.evil.example/reel/abc/",
        "https://www.instagram.com/",
        "https://www.instagram.com/reel/<script>",
        "file:///C:/Windows/win.ini",
    ],
)
def test_non_instagram_text_is_rejected(client, text):
    assert post(client, text).status_code == 422
    assert client.get("/api/jobs").json() == []


def test_share_id_must_be_a_uuid(client):
    assert post(client, "https://www.instagram.com/reel/abc/", "not-a-uuid").status_code == 422


def test_only_failed_jobs_can_be_retried(client):
    share_id = str(uuid.uuid4())
    post(client, "https://www.instagram.com/reel/abc/", share_id)
    assert client.post(f"/api/jobs/{share_id}/retry").status_code == 404
