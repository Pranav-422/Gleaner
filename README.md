# Gleaner

Share an Instagram reel from your phone. Gleaner reads it (caption, on-screen text, speech), files it
into a folder, and gives you one next step. Approve it, and the deadline and task land in a dedicated
**Gleaner** Google Calendar and task list, so your phone reminds you.

Personal tool: one owner. The work runs on your laptop; phone and laptop meet in a Supabase project,
so the laptop opens no port and needs no tunnel.

## How it works

```
Instagram ─Share→ Gleaner app (phone, hosted on Vercel) ─ waits on the phone if offline
                        │  writes an "action" row          ▲ reads the "state" row
                        ▼                                   │
                 Supabase (Postgres + Auth + private frames bucket, owner-only RLS)
                        │  laptop polls every 5 s           ▲ pushes jobs, entries, status
                        ▼                                   │
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
3. **Supabase** (free, supabase.com):
   1. New project. Pick a strong database password (you will not need it again).
   2. SQL Editor → New query → paste `supabase/schema.sql` → Run.
   3. Authentication → Users → **Add user** → your email and a strong password, "Auto confirm" on.
   4. Authentication → Sign In / Providers → turn **off** "Allow new users to sign up".
   5. Project Settings → API: copy the project URL and the **anon** key. Put them, plus the email and
      password from step 3, into `backend/.env` (`SUPABASE_*`). Never copy the `service_role` key.
4. **Host the phone app** on Vercel (free): Add New → Project → import this GitHub repo →
   Root Directory `web` → Environment Variables `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` (same two values) → Deploy. You get an `https://….vercel.app` address.

## Run

```
cd backend
uv run python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

On the phone: open the Vercel address in Chrome, sign in, menu → **Add to Home screen** → **Install**.
Gleaner then appears in Instagram's Share menu. The pill shows "Laptop online" while the backend runs.

> On this laptop, use `uv run python -m <tool>`, not `uv run <tool>`: Windows Application Control blocks
> the `.exe` launchers inside the virtual environment.

## Google reminders (optional)

1. In Google Cloud Console, create a project. Enable **Google Calendar API** and **Google Tasks API**.
2. OAuth consent screen: External, add yourself as a test user, then set the publishing status to
   **In production**. In "Testing" status, Google expires the sign-in after 7 days.
3. Credentials → Create OAuth client ID → **Web application**. Authorized redirect URI: your Vercel
   address with a trailing slash, e.g. `https://gleaner-xyz.vercel.app/`
4. In `backend/.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` set to that
   same address. Restart the backend.
5. In the app (phone is fine, laptop must be on) → Settings → **Connect Google** → wait a few seconds →
   **Continue to Google** → allow. You will see an "unverified app" warning; that is expected for a
   personal app. Google sends you back to the app, which passes the one-time code to the laptop through
   Supabase. The client secret and refresh token never leave the laptop.

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

- The backend listens on `127.0.0.1` only and nothing connects in. It only makes outgoing calls to Supabase.
- Supabase: row level security ties every row and screenshot to its owner; logged-out visitors get no
  access; sign-ups are off. The laptop signs in as the owner, so it is bound by the same rules. The anon
  key in the phone app is public by design.
- Phone actions are checked by the same code as the local API (Instagram-only links, allowed folders,
  length limits) before anything runs. Bad ones are marked failed with the reason, never executed.
- Reel data, entries and a few screenshots are stored in your Supabase project, not only on the laptop.
- Local API routes need the login cookie (`HttpOnly`, `Secure`, `SameSite=Strict`). 5 wrong passwords
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
