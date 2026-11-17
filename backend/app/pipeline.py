"""Reel in, filed entry out: fetch, frames, OCR, speech, rule cleanup, then one Gemini call on text."""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from dataclasses import dataclass
from datetime import date
from difflib import SequenceMatcher
from pathlib import Path
from urllib.parse import urlsplit

import httpx2
import yt_dlp

from . import db, llm

# The only hosts the fetcher will ever be given.
INSTAGRAM_HOSTS = {"instagram.com", "www.instagram.com"}
VIDEO_TYPES = {".mp4", ".mov", ".webm", ".mkv"}
MAX_FRAMES = 20
KEPT_FRAMES = 4
# Below this much extracted text, two frames are sent to Gemini as well.
WEAK_TEXT_CHARS = 200
CONFIDENT = 0.6


def instagram_url(text: str) -> str | None:
    """Return the first Instagram link in shared text, rebuilt without query, port or userinfo."""
    for raw in re.findall(r"https?://\S+", text):
        parts = urlsplit(raw.rstrip(".,)"))
        if parts.hostname in INSTAGRAM_HOSTS and re.fullmatch(r"/[\w\-./]+", parts.path):
            return f"https://www.instagram.com{parts.path}"
    return None


# ---------- stages ----------


def fetch(url: str, workdir: Path) -> tuple[list[Path], list[Path], str, float]:
    """Download a public reel or carousel without an account. Returns videos, photos, caption, duration (s)."""
    if instagram_url(url) != url:
        raise ValueError("Not an Instagram link")
    options = {
        "outtmpl": str(workdir / "%(id)s.%(ext)s"),
        "format": "best[ext=mp4]/best",
        "max_filesize": 150 * 1024 * 1024,
        "playlistend": 10,
        "socket_timeout": 30,
        "retries": 2,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "ignore_no_formats_error": True,  # photo posts and photo slides have no video; we take the photo instead
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        # Look first, then download only the slides that have a video: downloading a photo slide is an error.
        try:
            info = ydl.extract_info(url, download=False)
        except yt_dlp.utils.DownloadError as exc:
            # Instagram sometimes answers logged-out requests with nothing for a while; one slow retry.
            if "empty media response" not in str(exc):
                raise
            time.sleep(30)
            info = ydl.extract_info(url, download=False)
        items = [item for item in (info.get("entries") or [info]) if item]
        for item in items:
            if item.get("formats"):
                ydl.process_info(item)
    first = items[0] if items else {}
    caption = info.get("description") or first.get("description") or ""
    duration = float(info.get("duration") or first.get("duration") or 0)
    videos = sorted(path for path in workdir.iterdir() if path.suffix.lower() in VIDEO_TYPES)
    photos = [
        path
        for index, item in enumerate(items)
        if not item.get("formats") and item.get("thumbnail")
        and (path := photo(item["thumbnail"], workdir / f"photo_{index:02d}.jpg"))
    ]  # fmt: skip
    if not videos and not photos:
        raise RuntimeError("Instagram gave no video or photo for this post")
    return videos, photos, caption, duration


# Photo URLs come from Instagram's own answer; anything pointing elsewhere is ignored.
PHOTO_HOSTS = (".cdninstagram.com", ".fbcdn.net")
MAX_PHOTO = 10 * 1024 * 1024


def photo(url: str, out: Path) -> Path | None:
    """Download one post photo from Instagram's CDN and store it as a JPEG the OCR can read."""
    parts = urlsplit(url)
    if parts.scheme != "https" or not (parts.hostname or "").endswith(PHOTO_HOSTS):
        return None
    res = httpx2.get(url, timeout=30)
    if res.status_code != 200 or not res.headers.get("content-type", "").startswith("image/") or len(res.content) > MAX_PHOTO:
        return None
    raw = out.with_suffix(".img")
    raw.write_bytes(res.content)
    try:
        return to_jpeg(raw, out)
    finally:
        raw.unlink()


def to_jpeg(image: Path, out: Path) -> Path | None:
    """Re-encode with FFmpeg: same size limit as video frames, and PNG/WebP become a JPEG the OCR reads."""
    done = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(image), "-vf", "scale=960:960:force_original_aspect_ratio=decrease",
         "-q:v", "3", str(out)],
        capture_output=True, timeout=60,
    )  # fmt: skip
    return out if done.returncode == 0 and out.exists() else None


def frames(video: Path, outdir: Path, duration: float = 0) -> list[Path]:
    """Key frames: the first one, every scene change, and at least one every few seconds."""
    # Text that changes over a still background is not a scene change, hence the time rule.
    gap = max(3.0, duration / 15)
    pattern = outdir / f"{video.stem}_%02d.jpg"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y", "-i", str(video),
            "-vf", f"select='eq(n,0)+gt(scene,0.3)+gte(t-prev_selected_t,{gap:.1f})',"
                   "scale=960:960:force_original_aspect_ratio=decrease",
            "-fps_mode", "vfr", "-frames:v", str(MAX_FRAMES), "-q:v", "3", str(pattern),
        ],
        check=True, capture_output=True, timeout=180,
    )  # fmt: skip
    return sorted(outdir.glob(f"{video.stem}_*.jpg"))


def ocr(images: list[Path]) -> list[list[str]]:
    """Text lines per image, read on this machine by the OCR engine built into Windows."""
    if not images:
        return []
    # shortcut: Windows-only (the Python OCR libraries are blocked by this laptop's Application
    # Control policy); swap this function for RapidOCR when the backend moves to a Linux server.
    if sys.platform != "win32":
        raise RuntimeError("OCR is only wired up for Windows so far")
    script = Path(__file__).with_name("ocr.ps1")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-File", str(script),
         *(str(image.resolve()) for image in images)],
        check=True, capture_output=True, timeout=180,
    )  # fmt: skip
    pages = json.loads(result.stdout.decode("utf-8") or "[]")
    return [[str(line) for line in page] if isinstance(page, list) else [str(page)] for page in pages]


def audio(video: Path, workdir: Path) -> Path | None:
    """Small mono speech track for Whisper, or None when the video has no sound."""
    out = workdir / f"{video.stem}.mp3"
    done = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(video), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", str(out)],
        capture_output=True, timeout=180,
    )  # fmt: skip
    return out if done.returncode == 0 and out.exists() and out.stat().st_size > 0 else None


# ---------- rule-based cleanup (no AI) ----------

_URL = re.compile(r"(?:https?://|www\.)\S+|\b[\w-]+\.(?:com|in|io|org|dev|ai|co|net|app|me|xyz)\b(?:/[\w\-./?=&%]*)?", re.I)
_MONTH = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*"
_DATE = re.compile(
    rf"\b\d{{1,2}}(?:st|nd|rd|th)?\s+{_MONTH}(?:,?\s+\d{{4}})?|\b{_MONTH}\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,?\s+\d{{4}})?"
    r"|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b",
    re.I,
)
_MONEY = re.compile(r"(?:₹|rs\.?|inr|\$)\s?\d[\d,.]*\s?(?:k|l|lakhs?|lacs?|cr|crores?|m|million)?\b|\b\d[\d,.]*\s?(?:lakhs?|lacs?|crores?)\b", re.I)
_HANDLE = re.compile(r"(?<![\w.])@[\w.]{2,30}")


def _key(line: str) -> str:
    return re.sub(r"[^a-z0-9]", "", line.casefold())


def merge_lines(pages: list[list[str]]) -> list[str]:
    """On-screen lines in first-seen order, without the repeats that consecutive frames produce."""
    kept: list[tuple[str, str]] = []
    for line in (line.strip() for page in pages for line in page):
        key = _key(line)
        if len(key) < 3:  # stray marks and icons read as letters
            continue
        # "Part of another line" only counts for longer lines, or "Free" would vanish into "freelancing".
        part_of = len(key) >= 8
        if any((part_of and key in old) or SequenceMatcher(None, key, old).ratio() >= 0.85 for _, old in kept):
            continue
        # A longer reading of a line already seen (text that is still animating in) replaces it.
        kept = [(text, old) for text, old in kept if not (len(old) >= 8 and old in key)]
        kept.append((line, key))
    return [text for text, _ in kept]


def hints(text: str) -> dict[str, list[str]]:
    """Links, dates, amounts and handles found by plain patterns, so the model does not have to hunt."""
    found = {
        "links": _URL.findall(text),
        "dates": _DATE.findall(text),
        "amounts": _MONEY.findall(text),
        "handles": _HANDLE.findall(text),
    }
    return {name: list(dict.fromkeys(value.strip(" .,") for value in values)) for name, values in found.items()}


def clean(caption: str, pages: list[list[str]], transcript: str) -> str:
    """One compact text block for the model. Empty string when the reel gave nothing at all."""
    screen = "\n".join(merge_lines(pages))[:4000]
    caption, transcript = caption.strip()[:2000], transcript.strip()[:4000]
    if not (caption or screen or transcript):
        return ""
    sections = [("CAPTION", caption), ("ON-SCREEN TEXT", screen), ("SPEECH", transcript)]
    blocks = [f"{name}:\n{body}" for name, body in sections if body]
    found = [f"{name}: {', '.join(values)}" for name, values in hints(f"{caption}\n{screen}\n{transcript}").items() if values]
    if found:
        blocks.append("FOUND BY RULES:\n" + "\n".join(found))
    return "\n\n".join(blocks)


# ---------- whole pipeline ----------


@dataclass
class Extracted:
    text: str
    frames: list[Path]  # the few worth keeping, most text first


def read_videos(videos: list[Path], caption: str, duration: float, workdir: Path, photos: list[Path] = ()) -> Extracted:
    """Everything after the download: frames, OCR, speech, cleanup."""
    images: list[Path] = list(photos)
    transcript: list[str] = []
    for video in videos:
        images += frames(video, workdir, duration)
        track = audio(video, workdir)
        if track:
            transcript.append(llm.transcribe(track))
    images = images[:MAX_FRAMES]
    pages = ocr(images)
    by_text = sorted(zip(pages, images), key=lambda pair: -sum(len(line) for line in pair[0]))
    return Extracted(clean(caption, pages, " ".join(transcript)), [image for _, image in by_text[:KEPT_FRAMES]])


def extract(url: str, workdir: Path) -> Extracted:
    videos, photos, caption, duration = fetch(url, workdir)
    return read_videos(videos, caption, duration, workdir, photos)


def extract_upload(source: str, files: list[str], workdir: Path) -> Extracted:
    """Screenshots go straight to OCR; a voice note goes straight to speech-to-text."""
    paths = [db.DATA_DIR / "uploads" / name for name in files]
    if source == "voice":
        track = audio(paths[0], workdir)
        transcript = llm.transcribe(track) if track else ""
        return Extracted(f"VOICE NOTE:\n{transcript.strip()[:4000]}" if transcript.strip() else "", [])
    photos = [jpeg for index, path in enumerate(paths) if (jpeg := to_jpeg(path, workdir / f"shot_{index:02d}.jpg"))]
    return read_videos([], "", 0, workdir, photos)


def run_job(
    job_id: str, url: str, hint: str | None, entry_id: int | None, source: str = "link", files: list[str] = ()
) -> None:
    """Process one job end to end and store the result. The video never outlives this call."""
    frames_dir = db.DATA_DIR / "frames"
    # The extracted text is saved until the job is stored, so a retry after "Gemini busy" (or any later
    # failure) repeats only the Gemini call, not the download, OCR and speech-to-text.
    cache = db.DATA_DIR / "extracted" / f"{job_id}.json"
    if cache.is_file():
        saved = json.loads(cache.read_text(encoding="utf-8"))
        text, kept = saved["text"], saved["frames"]
    else:
        with tempfile.TemporaryDirectory(prefix="gleaner-") as tmp:
            extracted = extract(url, Path(tmp)) if source == "link" else extract_upload(source, list(files), Path(tmp))
            frames_dir.mkdir(parents=True, exist_ok=True)
            kept = []
            for index, frame in enumerate(extracted.frames):
                name = f"{job_id}_{index}.jpg"
                shutil.copyfile(frame, frames_dir / name)
                kept.append(name)
        text = extracted.text
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"text": text, "frames": kept}), encoding="utf-8")

    if not text and not hint:
        result, tokens = None, {"in": 0, "out": 0}
    else:
        weak = len(text) < WEAK_TEXT_CHARS
        images = [frames_dir / name for name in kept[:2]] if weak else []
        result, tokens = llm.classify(text, hint, images, voice=source == "voice")
    store(job_id, url, entry_id, text, kept, result, tokens)
    cache.unlink()
    for name in files:  # uploads are read once; the text and kept frames are what remains
        (db.DATA_DIR / "uploads" / name).unlink(missing_ok=True)


def store(job_id, url, entry_id, raw_text, frames_kept, result: llm.Extraction | None, tokens) -> None:
    if result is None or not result.readable:
        folder, review, guesses = None, "needs_context", []
    elif result.folder == "none" or result.confidence < CONFIDENT:
        guesses = list(dict.fromkeys(f for f in (result.folder, result.second_folder) if f != "none"))
        folder, review = None, "disputed"
    else:
        folder, review, guesses = result.folder, None, []

    fields = result.model_dump(mode="json") if result else {}
    also = fields.get("also_fits")
    ratings = {name: fields[name] for name in RATINGS if name in fields}
    row = {
        "url": url,
        "folder": folder,
        "review": review,
        "guesses": json.dumps(guesses),
        # A shortcut only for a filed entry, and only into a different folder.
        "also": also if folder and also not in (None, "none", folder) else None,
        "ratings": json.dumps(ratings),
        "title": fields.pop("title", None) or "Could not read this reel",
        "summary": fields.pop("summary", None),
        "next_step": fields.pop("next_step", None),
        "deadline": fields.pop("deadline", None),
        "data": json.dumps({k: v for k, v in fields.items() if k in ALL_FIELDS and v}),
        "raw_text": raw_text,
        "frames": json.dumps(frames_kept),
    }
    with closing(db.db()) as conn, conn:
        if entry_id is None and folder in ("hackathons", "opportunities"):
            entry_id = _merge_duplicate(conn, folder, row)
        elif entry_id is not None:  # a Needs Context entry, processed again with the owner's hint
            conn.execute(f"UPDATE entries SET {', '.join(f'{k} = :{k}' for k in row)} WHERE id = :id", {**row, "id": entry_id})
        if entry_id is None:
            columns = ", ".join(row)
            entry_id = conn.execute(
                f"INSERT INTO entries ({columns}, created_at) VALUES ({', '.join(':' + k for k in row)}, :created_at)",
                {**row, "created_at": db.now()},
            ).lastrowid
        conn.execute(
            "UPDATE jobs SET status = 'done', error = NULL, entry_id = ?, tokens_in = ?, tokens_out = ? WHERE id = ?",
            (entry_id, tokens["in"], tokens["out"], job_id),
        )


ALL_FIELDS = {field for names in llm.FOLDER_FIELDS.values() for field in names}
RATINGS = ("relevance", "credibility", "payoff", "effort")
_LEVEL = {"low": 0.0, "medium": 0.5, "high": 1.0}


def worth(ratings: dict, deadline: str | None, created_at: str, today: date) -> int:
    """Worth-it score, 0-100: goals 35, payoff 25, credibility 20, low effort 10, freshness 10.

    Plain arithmetic on the model's four ratings, so a score can always be explained. Freshness is full while a
    deadline is ahead and zero once it passed; without a deadline it fades over 60 days.
    """
    level = {name: _LEVEL.get(ratings.get(name, "medium"), 0.5) for name in RATINGS}
    if deadline:
        fresh = 1.0 if deadline >= today.isoformat() else 0.0
    else:
        age = (today - date.fromisoformat(created_at[:10])).days
        fresh = max(0.0, 1 - age / 60)
    total = (
        35 * level["relevance"] + 25 * level["payoff"] + 20 * level["credibility"]
        + 10 * (1 - level["effort"]) + 10 * fresh
    )  # fmt: skip
    return round(total)


def _merge_duplicate(conn, folder: str, row: dict) -> int | None:
    """Same event shared twice: fill the gaps in the existing entry instead of adding a second one."""
    for old in conn.execute("SELECT id, title, deadline, data FROM entries WHERE folder = ?", (folder,)):
        if _key(old["title"]) == _key(row["title"]):
            data = {**json.loads(row["data"]), **json.loads(old["data"])}
            conn.execute(
                "UPDATE entries SET data = ?, deadline = COALESCE(deadline, ?) WHERE id = ?",
                (json.dumps(data), row["deadline"], old["id"]),
            )
            return old["id"]
    return None
