"""Google Calendar and Tasks: the nudges. Gleaner writes only to its own calendar and its own task list.

Scopes (least privilege):
  calendar.app.created  - create secondary calendars and manage events on them, nothing else
  tasks                 - Google offers no narrower scope that can write tasks
The refresh token lives in the operating system's credential store (Windows Credential Manager).
"""

import base64
import hashlib
import os
import secrets
import time
from datetime import date, datetime, timedelta
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import httpx2
import keyring

from . import db

SCOPES = "https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks"
# Must match a redirect URI registered for the OAuth client. Set it to the hosted app's address to connect from
# the phone (the app passes the code back through Supabase); the default works only in the laptop's browser.
REDIRECT_URI = os.environ.get("GOOGLE_REDIRECT_URI", "http://127.0.0.1:8000/api/google/callback")
TIMEZONE = os.environ.get("GLEANER_TZ", "Asia/Kolkata")
CALENDAR = "https://www.googleapis.com/calendar/v3"
TASKS = "https://tasks.googleapis.com/tasks/v1"
_KEYRING = ("gleaner", "google_refresh_token")

_access: tuple[str, float] | None = None  # token, expiry (monotonic)


def configured() -> bool:
    return bool(os.environ.get("GOOGLE_CLIENT_ID") and os.environ.get("GOOGLE_CLIENT_SECRET"))


def connected() -> bool:
    return configured() and keyring.get_password(*_KEYRING) is not None


def auth_url() -> str:
    """Start the consent flow. The state and PKCE verifier are kept server-side for the callback."""
    state, verifier = secrets.token_urlsafe(24), secrets.token_urlsafe(48)
    db.set_setting("google_oauth", f"{state}|{verifier}|{time.time() + 600}")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    query = {
        "client_id": os.environ["GOOGLE_CLIENT_ID"],
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(query)
    db.set_setting("google_auth_url", url)
    return url


def pending_url() -> str | None:
    """The consent link from the last start, while it is unused and under 10 minutes old."""
    saved = (db.get_setting("google_oauth") or "||0").split("|")
    return db.get_setting("google_auth_url") if saved[0] and time.time() < float(saved[2]) else None


def finish(code: str, state: str) -> None:
    """Callback: check the state, swap the code for tokens, store the refresh token, set up the nudges."""
    saved = (db.get_setting("google_oauth") or "||0").split("|")
    db.set_setting("google_oauth", None)  # single use
    if not secrets.compare_digest(saved[0], state) or not saved[0] or time.time() > float(saved[2]):
        raise PermissionError("This Google sign-in link is invalid or has expired. Start again.")
    res = httpx2.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": os.environ["GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
            "code": code,
            "code_verifier": saved[1],
            "grant_type": "authorization_code",
            "redirect_uri": REDIRECT_URI,
        },
        timeout=30,
    )
    tokens = res.json() if res.status_code == 200 else {}
    if "refresh_token" not in tokens:
        raise RuntimeError(f"Google did not return a refresh token (status {res.status_code}).")
    keyring.set_password(*_KEYRING, tokens["refresh_token"])
    _calendar_id()
    _tasklist_id()
    _weekly_review()


def disconnect() -> None:
    global _access
    token = keyring.get_password(*_KEYRING)
    if token:
        httpx2.post("https://oauth2.googleapis.com/revoke", data={"token": token}, timeout=30)
        keyring.delete_password(*_KEYRING)
    _access = None
    for key in ("google_calendar_id", "google_tasklist_id", "google_review_event"):
        db.set_setting(key, None)


def _token() -> str:
    global _access
    if _access and time.monotonic() < _access[1]:
        return _access[0]
    res = httpx2.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": os.environ["GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
            "refresh_token": keyring.get_password(*_KEYRING),
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    if res.status_code != 200:
        raise RuntimeError(f"Google sign-in has expired or was revoked (status {res.status_code}). Connect again.")
    body = res.json()
    _access = (body["access_token"], time.monotonic() + body.get("expires_in", 3600) - 60)
    return _access[0]


def _post(url: str, body: dict) -> dict:
    res = httpx2.post(url, json=body, headers={"Authorization": f"Bearer {_token()}"}, timeout=30)
    if res.status_code >= 300:
        raise RuntimeError(f"Google API error {res.status_code}: {res.text[:300]}")
    return res.json()


def _calendar_id() -> str:
    calendar_id = db.get_setting("google_calendar_id")
    if not calendar_id:
        calendar_id = _post(f"{CALENDAR}/calendars", {"summary": "Gleaner", "timeZone": TIMEZONE})["id"]
        db.set_setting("google_calendar_id", calendar_id)
    return calendar_id


def _tasklist_id() -> str:
    tasklist_id = db.get_setting("google_tasklist_id")
    if not tasklist_id:
        tasklist_id = _post(f"{TASKS}/users/@me/lists", {"title": "Gleaner"})["id"]
        db.set_setting("google_tasklist_id", tasklist_id)
    return tasklist_id


def _weekly_review() -> None:
    """One repeating half-hour every Sunday evening: look at Gleaner and pick 3 things to do."""
    if db.get_setting("google_review_event"):
        return
    today = datetime.now(ZoneInfo(TIMEZONE)).date()
    sunday = today + timedelta(days=(6 - today.weekday()) % 7 or 7)
    start = datetime.combine(sunday, datetime.min.time()).replace(hour=19)
    event = _post(
        f"{CALENDAR}/calendars/{_calendar_id()}/events",
        {
            "summary": "Gleaner review: pick 3 things to do this week",
            "start": {"dateTime": start.isoformat(), "timeZone": TIMEZONE},
            "end": {"dateTime": (start + timedelta(minutes=30)).isoformat(), "timeZone": TIMEZONE},
            "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=SU"],
            "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 10}]},
        },
    )
    db.set_setting("google_review_event", event["id"])


def deadline_event(title: str, deadline: date, notes: str) -> dict:
    """An all-day event on the deadline, with phone reminders 3 days and 1 day before, both at 9 am."""
    return {
        "summary": f"Deadline: {title}",
        "description": notes,
        "start": {"date": deadline.isoformat()},
        "end": {"date": (deadline + timedelta(days=1)).isoformat()},
        "reminders": {
            "useDefault": False,
            # Minutes before the start of the day (midnight): 9 am three days and one day earlier.
            "overrides": [{"method": "popup", "minutes": 3 * 1440 - 540}, {"method": "popup", "minutes": 1440 - 540}],
        },
    }


def add_deadline(title: str, deadline: date, notes: str) -> str:
    return _post(f"{CALENDAR}/calendars/{_calendar_id()}/events", deadline_event(title, deadline, notes))["id"]


def add_task(title: str, notes: str, due: date) -> str:
    # Google Tasks keeps only the date of `due`; timed reminders come from the calendar event.
    body = {"title": title[:1000], "notes": notes[:8000], "due": f"{due.isoformat()}T00:00:00.000Z"}
    return _post(f"{TASKS}/lists/{_tasklist_id()}/tasks", body)["id"]
