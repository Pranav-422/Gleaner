# Gleaner

Share an Instagram reel from your phone. Gleaner reads it (caption, on-screen text, speech), files it
into a folder, and gives you one next step. Approve it, and the deadline and task land in a dedicated
**Gleaner** Google Calendar and task list, so your phone reminds you.

Personal tool: one owner, runs on your laptop, reachable only from your own devices through Tailscale.

## How it works

```
Instagram ─Share→ Gleaner app (phone) ─ waits on the phone if the laptop is off
                        │  over Tailscale HTTPS
                        ▼
          Backend on the laptop (FastAPI + SQLite, one background worker)
          yt-dlp → FFmpeg key frames → Windows OCR → Groq Whisper → rule cleanup
                        │  clean text only (+2 frames when text is thin)
                        ▼
                Gemini → validated JSON → folder, or Disputed / Needs Context
                        │  only when you tap Approve
                        ▼
            Google Calendar "Gleaner" + Google Tasks "Gleaner"
```

Folders in v1: YouTube, Hackathons, Opportunities, Tools & Bots.

## Setup (once)

Needs: Python with `uv`, Node.js, FFmpeg on PATH, Windows 10/11 (for the built-in OCR).

1. **Keys.** Copy `backend/.env.example` to `backend/.env`. Add your Gemini key and Groq key.
2. **Password.** In `backend/`, run `uv run python -m app.auth`. Paste the printed line into `.env`.
3. **Build the app.**
   ```
   cd web
   npm install
   npm run build
   ```
4. **Tailscale.** Install it on the laptop and the phone, same account. In the Tailscale admin
   console, DNS page: turn on MagicDNS and HTTPS Certificates.

## Run

```
cd backend
uv run python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

In a second terminal, once: `tailscale serve --bg 8000`. It prints your `https://<laptop>.<tailnet>.ts.net` address.

On the phone: open that address in Chrome, menu → **Add to Home screen** → **Install**. Gleaner then
appears in Instagram's Share menu.

> On this laptop, use `uv run python -m <tool>`, not `uv run <tool>`: Windows Application Control blocks
> the `.exe` launchers inside the virtual environment.

## Google reminders (optional)

1. In Google Cloud Console, create a project. Enable **Google Calendar API** and **Google Tasks API**.
2. OAuth consent screen: External, add yourself as a test user, then set the publishing status to
   **In production**. In "Testing" status, Google expires the sign-in after 7 days.
3. Credentials → Create OAuth client ID → **Web application**. Authorized redirect URI:
   `http://127.0.0.1:8000/api/google/callback`
4. Put the client ID and secret in `backend/.env`, restart the backend.
5. **On the laptop**, open `http://127.0.0.1:8000` → Settings → **Connect Google**. You will see an
   "unverified app" warning; that is expected for a personal app.

Gleaner asks only for `calendar.app.created` (its own calendars, nothing else) and `tasks`. The
refresh token is stored in Windows Credential Manager, not in a file.

## Measuring accuracy

```
copy eval\testset.example.json eval\testset.json   # then fill in real reels and the right answers
cd backend
uv run python ../eval/run.py
```

Prints folder accuracy, per-field accuracy and tokens per reel. Extracted text is cached in
`eval/cache/`, so re-runs after a prompt change cost only Gemini calls.

## Tests

```
cd backend
uv run python -m pytest -q
```

## Security notes

- The backend listens on `127.0.0.1` only. `tailscale serve` is the only way in from other devices.
- Every API route needs the login cookie (`HttpOnly`, `Secure`, `SameSite=Strict`). 5 wrong passwords
  lock login for 5 minutes.
- Only `instagram.com` links are accepted, rebuilt without query strings before reaching yt-dlp.
- Reel text is sent to Gemini as data inside a delimited block; the model has no tools, and its
  output must pass a strict schema. Calendar and task writes happen only on your tap.
- Free-tier Gemini and Groq may use your inputs to improve their models. Reels are public, but keep
  private information out of "Needs Context" explanations.
- Data lives in `backend/data/` (database, a few kept screenshots, 7 daily backups). Videos are
  deleted right after processing.

## Not in v1

Worth-it score, cross-folder shortcuts, web search enrichment, news verification, the other folders,
voice notes, Ask AI panel, weekly digest beyond the calendar review slot, Claude MCP (v2).
