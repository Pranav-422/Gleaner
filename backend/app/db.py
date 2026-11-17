"""SQLite storage. One file, opened fresh per call so API threads and the worker never share a connection."""

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / "backend" / ".env")

# Database and kept screenshots. Tests point this at a temp folder.
DATA_DIR = Path(os.environ.get("GLEANER_DATA", ROOT / "backend" / "data"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id         TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    hint       TEXT,     -- what the owner explained on the Needs Context screen
    error      TEXT,
    entry_id   INTEGER,
    tokens_in  INTEGER,
    tokens_out INTEGER,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
    id         INTEGER PRIMARY KEY,
    url        TEXT NOT NULL,
    folder     TEXT,
    review     TEXT CHECK (review IN ('disputed', 'needs_context')),
    guesses    TEXT NOT NULL DEFAULT '[]',   -- JSON list: best folder guesses for a disputed entry
    title      TEXT NOT NULL,
    summary    TEXT,
    next_step  TEXT,
    deadline   TEXT,                         -- YYYY-MM-DD
    data       TEXT NOT NULL DEFAULT '{}',   -- JSON: the folder-specific fields
    raw_text   TEXT,
    frames     TEXT NOT NULL DEFAULT '[]',   -- JSON list of file names in DATA_DIR/frames
    decision   TEXT CHECK (decision IN ('approved', 'skipped')),
    event_id   TEXT,
    task_id    TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
"""

_ready: set[Path] = set()


def db() -> sqlite3.Connection:
    path = DATA_DIR / "gleaner.db"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    if path not in _ready:
        conn.executescript(SCHEMA)
        _ready.add(path)
    return conn


def backup(keep: int = 7) -> Path | None:
    """Once a day, a consistent copy of the database in DATA_DIR/backups. Keeps the newest `keep` copies."""
    folder = DATA_DIR / "backups"
    target = folder / f"gleaner-{datetime.now().date().isoformat()}.db"
    if target.exists():
        return None
    folder.mkdir(parents=True, exist_ok=True)
    source, copy = db(), sqlite3.connect(target)
    try:
        source.backup(copy)  # safe while the app is writing, unlike copying the file
    finally:
        copy.close()
        source.close()
    for old in sorted(folder.glob("gleaner-*.db"))[:-keep]:
        old.unlink()
    return target


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_setting(key: str) -> str | None:
    conn = db()
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    finally:
        conn.close()
    return row["value"] if row else None


def set_setting(key: str, value: str | None) -> None:
    conn = db()
    try:
        with conn:
            if value is None:
                conn.execute("DELETE FROM settings WHERE key = ?", (key,))
            else:
                conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
    finally:
        conn.close()
