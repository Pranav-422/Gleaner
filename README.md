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

## What it does (v2)

- **Inputs:** Instagram reels and photo carousels from the Share menu or a pasted link; screenshots (when a
  reel will not load, or for posters); voice notes (a clear task becomes a to-do, the rest goes to Your Notes).
  The Claude app can also queue links and save entries (see "Claude connector").
- **14 folders:** YouTube, Hackathons, Opportunities, Tools & Bots, Quick Picks, Learn (with subtopics),
  News & Events, Make Money, Project Ideas, Career & Interviews, Free Courses, Repos & Sites, Finance,
  Your Notes. Each item is stored once; when it genuinely fits a second folder it shows there as a shortcut.
- **Worth-it score (0-100):** goals 35, payoff 25, credibility 20, low effort 10, freshness 10. Gemini rates
  the four parts low/medium/high; the arithmetic is in `pipeline.worth`, so every score can be explained.
  Folders and the Inbox are sorted by it.
- **Checks (hourly, in the background):** dead-link check on links found in reels, and hackathons,
  opportunities and news are checked against the official page the reel names (Verified / Differs /
  Unverified). An official deadline replaces the reel's. News counts as confirmed only from a fixed list
  of trusted sources. With `GEMINI_SEARCH=1` (needs billing) it can also search Google.
- **Anti-hoarding:** one next step per entry with Approve/Skip, "Due this week", weekly review event,
  auto-archive (untouched 30 days, expired, or low score after 7 days; Restore keeps an entry).
- **Ask AI** on every entry: Explain simply / Give an example / Why it matters, or your own question.
  The chat is kept per entry.

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

## Claude connector (optional)

Lets the Claude app read your library and save new things. Tools: `list_entries`, `get_entry`,
`list_pending` (read), `save_link`, `save_entry` (write). It cannot approve, delete, archive or touch Google;
everything it saves waits in your Inbox and is checked by the laptop like any other input.

1. Install the Supabase CLI once: `npm install -g supabase` (or use `npx supabase`), then `supabase login`.
2. Make a long random secret: `uv run python -c "import secrets; print(secrets.token_urlsafe(32))"`.
3. From the repo root:
   ```
   supabase link --project-ref <your-project-ref>
   supabase secrets set MCP_TOKEN=<secret> GLEANER_EMAIL=<your email> GLEANER_PASSWORD=<your password>
   supabase functions deploy mcp --no-verify-jwt
   ```
   `--no-verify-jwt` because Claude sends no Supabase login; the secret in the URL is the key, and the
   function signs in as you, so row level security still applies.
4. Claude → Settings → Connectors → Add custom connector → URL
   `https://<project-ref>.supabase.co/functions/v1/mcp/<secret>`.

Anyone with that URL can read your library and add to your Inbox: keep it private, and change `MCP_TOKEN`
(step 3) if it ever leaks. Tests: `node --test supabase/functions/mcp/handler.test.ts`.

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

- Links from reels are fetched only by the background checker, only over http(s) on standard ports, and
  only when every address the host resolves to is public (no localhost, LAN or cloud metadata), checked
  again at every redirect. In the app they stay plain text.
- Screenshots and voice notes are uploaded to a private bucket, copied to the laptop, then deleted from
  Supabase; the laptop deletes its copy once the item is filed.

## Measured so far

- 11 real posts: 9 read end to end (reels and photo carousels), 1 needs an Instagram login, 1 hit
  "Gemini busy" (now retried automatically). About 1,540 Gemini tokens and 10-16 s per reel.
- Folder and field accuracy: run `eval/run.py` once the test set has your answers.

## Not built

Notch overlay (needs a native Android app), passkey login, encrypted Drive backup, local Whisper fallback,
Watchlist folder, always-on VM.
