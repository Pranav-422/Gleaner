import pytest
from fastapi.testclient import TestClient

from app import auth, db, main

PASSWORD = "correct horse battery"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    """Every test gets its own data folder, a known password, and no real API keys."""
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(auth, "_failures", 0)
    monkeypatch.setattr(auth, "_locked_until", 0.0)
    monkeypatch.setenv("GLEANER_PASSWORD_HASH", auth.hash_password(PASSWORD))
    for name in ("GEMINI_API_KEY", "GROQ_API_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def anonymous():
    # https, because the session cookie is Secure. Not used as a context manager, so no worker starts.
    return TestClient(main.app, base_url="https://testserver")


@pytest.fixture
def client(anonymous):
    assert anonymous.post("/api/login", json={"password": PASSWORD}).status_code == 200
    return anonymous
