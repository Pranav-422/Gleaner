"""Background upkeep: dead-link checks, checking claims against official pages, auto-archive.

Links come from reels, so they are untrusted. They are only ever requested here, never shown as clickable,
and only when every address the host resolves to is a public one: no localhost, LAN, link-local or cloud
metadata addresses, at every redirect hop.
"""

import html
import ipaddress
import json
import os
import re
import socket
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urljoin, urlsplit

import httpx2

from . import db, llm, pipeline

RECHECK = timedelta(days=1)
ARCHIVE_AFTER = timedelta(days=30)
JUNK_AFTER = timedelta(days=7)  # low scorers sink and leave the Inbox sooner
JUNK_SCORE = 25
VERIFY_FOLDERS = ("hackathons", "opportunities", "news")
# News counts as confirmed only when the source is on this fixed list (ideation: "my fixed list").
TRUSTED_NEWS = (
    "pib.gov.in", "gov.in", "nic.in", "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "thehindu.com",
    "indianexpress.com", "hindustantimes.com", "livemint.com", "economictimes.indiatimes.com", "ndtv.com",
    "theverge.com", "techcrunch.com", "blog.google", "openai.com", "anthropic.com",
)  # fmt: skip


class Blocked(Exception):
    """The link points somewhere Gleaner refuses to go."""


def public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        return False
    return bool(infos) and all(ipaddress.ip_address(info[4][0].split("%")[0]).is_global for info in infos)


def normalise(link: str) -> str:
    """Reel text often drops the scheme ("unstop.com/x"); add https so it can be checked."""
    link = link.strip().rstrip(".,)")
    return link if re.match(r"https?://", link, re.I) else f"https://{link}"


def safe_get(url: str, max_bytes: int = 300_000) -> tuple[int, str, bytes]:
    """GET with the public-address rule applied at every hop. Returns status, content type, first bytes."""
    # shortcut: the address is checked, then httpx resolves again (DNS rebinding window); acceptable for a
    # personal tool that only reads pages, revisit if this ever runs on a server with private neighbours.
    for _ in range(4):
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or parts.port not in (None, 80, 443) or parts.username:
            raise Blocked("only plain http(s) links on standard ports")
        if not parts.hostname or not public_host(parts.hostname):
            raise Blocked("not a public internet address")
        with httpx2.stream(
            "GET", url, timeout=10, follow_redirects=False, headers={"User-Agent": "Mozilla/5.0 (Gleaner link check)"}
        ) as res:
            if res.status_code in (301, 302, 303, 307, 308) and res.headers.get("location"):
                url = urljoin(url, res.headers["location"])
                continue
            body = b""
            for chunk in res.iter_bytes():
                body += chunk
                if len(body) >= max_bytes:
                    break
            return res.status_code, res.headers.get("content-type", ""), body[:max_bytes]
    raise Blocked("too many redirects")


def check_link(link: str) -> dict:
    try:
        status, _, _ = safe_get(normalise(link), max_bytes=1)
    except Blocked as exc:
        return {"status": "blocked", "note": str(exc), "at": db.now()}
    except httpx2.HTTPError:
        return {"status": "dead", "note": "could not connect", "at": db.now()}
    # 403/429 usually mean "bots not welcome", not a dead page.
    state = "ok" if status < 400 or status in (401, 403, 429) else "dead"
    return {"status": state, "code": status, "at": db.now()}


def page_text(link: str) -> str:
    status, kind, body = safe_get(normalise(link))
    if status >= 400 or "html" not in kind and "text" not in kind:
        return ""
    text = body.decode("utf-8", errors="ignore")
    text = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", text)
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return re.sub(r"\s+", " ", text).strip()[:12_000]


def _domain(url: str) -> str:
    return (urlsplit(normalise(url)).hostname or "").removeprefix("www.")


def trusted(url: str) -> bool:
    host = _domain(url)
    return any(host == item or host.endswith("." + item) for item in TRUSTED_NEWS)


def verify(entry) -> dict:
    """Check an entry's claims against its official page, or by search when that quota exists."""
    data = json.loads(entry["data"])
    claims = "\n".join(
        f"{name}: {value}"
        for name, value in [("title", entry["title"]), ("summary", entry["summary"]), ("deadline", entry["deadline"]),
                            *data.items()]
        if value
    )  # fmt: skip
    link = data.get("link")
    if isinstance(link, str) and link:
        try:
            text = page_text(link)
        except (Blocked, httpx2.HTTPError):
            text = ""
        if len(text) > 200:
            result, _ = llm.verify_page(claims, text)
            found = result.model_dump(mode="json") | {"official_link": None, "sources": [], "by": "page"}
            if entry["folder"] == "news" and found["status"] == "verified" and not trusted(link):
                found |= {"status": "unverified", "note": "The page agrees, but it is not on the trusted news list."}
            return found | {"at": db.now()}
    if os.environ.get("GEMINI_SEARCH") == "1":
        result, sources, _ = llm.verify_search(claims)
        found = result.model_dump(mode="json") | {"sources": sources, "by": "search"}
        if entry["folder"] == "news" and found["status"] != "unverified" and not any(trusted(s["url"]) for s in sources):
            found |= {"status": "unverified", "note": "No trusted news source among the results."}
        return found | {"at": db.now()}
    return {"status": "unverified", "note": "No official page to check against.", "sources": [], "by": "none", "at": db.now()}


def _due(check: dict | None) -> bool:
    return not check or datetime.fromisoformat(check["at"]) < datetime.now(timezone.utc) - RECHECK


def upkeep(limit: int = 10) -> None:
    """One round of background work. Small batches so the worker returns to the queue quickly."""
    today = date.today()
    now = datetime.now(timezone.utc)
    with closing(db.db()) as conn:
        rows = conn.execute("SELECT * FROM entries WHERE archived_at IS NULL").fetchall()

    for entry in rows:
        checks = json.loads(entry["checks"])
        age = now - datetime.fromisoformat(entry["created_at"])
        score = pipeline.worth(json.loads(entry["ratings"]), entry["deadline"], entry["created_at"], today)
        expired = bool(entry["deadline"]) and entry["deadline"] < today.isoformat()
        stale = age > ARCHIVE_AFTER or (score < JUNK_SCORE and age > JUNK_AFTER)
        if not entry["decision"] and not checks.get("kept") and (expired or stale):
            with closing(db.db()) as conn, conn:
                conn.execute("UPDATE entries SET archived_at = ? WHERE id = ?", (db.now(), entry["id"]))
            continue

    for entry in rows:
        if limit <= 0:
            return
        checks = json.loads(entry["checks"])
        link = json.loads(entry["data"]).get("link")
        changed = False
        if isinstance(link, str) and link and _due(checks.get("link")):
            checks["link"], changed = check_link(link), True
            limit -= 1
        if entry["folder"] in VERIFY_FOLDERS and "verify" not in checks and not entry["review"]:
            try:
                checks["verify"], changed = verify(entry), True
            except llm.RateLimited:
                return  # the free tier needs a rest; try in the next round
            except Exception as exc:  # a bad page or odd model answer must not stop upkeep for the rest
                checks["verify"], changed = {"status": "unverified", "note": f"Check failed: {type(exc).__name__}",
                                             "sources": [], "by": "error", "at": db.now()}, True  # fmt: skip
            limit -= 1
        if changed:
            official = (checks.get("verify") or {}).get("deadline")
            with closing(db.db()) as conn, conn:
                conn.execute("UPDATE entries SET checks = ? WHERE id = ?", (json.dumps(checks), entry["id"]))
                # The official page beats the reel: a stated official deadline replaces the reel's.
                if official and checks["verify"]["status"] in ("verified", "mismatch"):
                    conn.execute("UPDATE entries SET deadline = ? WHERE id = ?", (official, entry["id"]))
