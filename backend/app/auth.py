"""Single-owner login: one password (stored as a scrypt hash in .env) and server-side sessions.

Set the password:  uv run python -m app.auth
"""

import hashlib
import os
import secrets
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone

from . import db

COOKIE = "gleaner_session"
SESSION_DAYS = 30
MAX_FAILURES = 5
LOCK_SECONDS = 300

_failures = 0
_locked_until = 0.0


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"{salt.hex()}${digest.hex()}"


def password_configured() -> bool:
    return bool(os.environ.get("GLEANER_PASSWORD_HASH"))


def check_password(password: str) -> bool:
    """True for the right password. After 5 wrong tries in a row, every try fails for 5 minutes."""
    global _failures, _locked_until
    stored = os.environ.get("GLEANER_PASSWORD_HASH", "")
    if time.monotonic() < _locked_until or "$" not in stored:
        return False
    salt, digest = stored.split("$", 1)
    try:
        attempt = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=2**14, r=8, p=1)
        ok = secrets.compare_digest(attempt, bytes.fromhex(digest))
    except ValueError:
        ok = False
    _failures = 0 if ok else _failures + 1
    if _failures >= MAX_FAILURES:
        _failures, _locked_until = 0, time.monotonic() + LOCK_SECONDS
    return ok


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_session() -> str:
    """Create a session and return its token. Only the token's hash is stored."""
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    with closing(db.db()) as conn, conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (db.now(),))
        conn.execute("INSERT INTO sessions VALUES (?, ?)", (_hash(token), expires.isoformat(timespec="seconds")))
    return token


def session_valid(token: str | None) -> bool:
    if not token:
        return False
    with closing(db.db()) as conn:
        row = conn.execute(
            "SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?", (_hash(token), db.now())
        ).fetchone()
    return row is not None


def end_session(token: str | None) -> None:
    if token:
        with closing(db.db()) as conn, conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash(token),))


if __name__ == "__main__":
    from getpass import getpass

    first = getpass("New Gleaner password: ")
    if len(first) < 10:
        raise SystemExit("Use at least 10 characters.")
    if first != getpass("Type it again: "):
        raise SystemExit("The two did not match.")
    print("\nPut this line in backend/.env, then restart the backend:\n")
    print(f"GLEANER_PASSWORD_HASH={hash_password(first)}")
