import pytest

from app import auth
from tests.conftest import PASSWORD

PROTECTED = [
    ("get", "/api/jobs"),
    ("get", "/api/entries"),
    ("get", "/api/status"),
    ("post", "/api/share"),
    ("post", "/api/entries/1/decision"),
    ("get", "/api/frames/x.jpg"),
    ("get", "/api/google/start"),
    ("post", "/api/google/disconnect"),
]


@pytest.mark.parametrize("method, path", PROTECTED)
def test_api_needs_login(anonymous, method, path):
    assert anonymous.request(method, path).status_code == 401


def test_api_is_closed_when_no_password_is_set(anonymous, monkeypatch):
    monkeypatch.delenv("GLEANER_PASSWORD_HASH")
    assert anonymous.get("/api/jobs").status_code == 503


def test_login_sets_a_locked_down_cookie_and_logout_ends_it(anonymous):
    res = anonymous.post("/api/login", json={"password": PASSWORD})
    cookie = res.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie
    assert anonymous.get("/api/jobs").status_code == 200
    anonymous.post("/api/logout")
    assert anonymous.get("/api/jobs").status_code == 401


def test_five_wrong_passwords_lock_login_even_for_the_right_one(anonymous):
    for _ in range(auth.MAX_FAILURES):
        assert anonymous.post("/api/login", json={"password": "wrong"}).status_code == 401
    assert anonymous.post("/api/login", json={"password": PASSWORD}).status_code == 401
