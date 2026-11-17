"use client";

import { useEffect, useRef, useState } from "react";
import { type Entry, EntryCard, FOLDERS, type Folder } from "./entries";
import styles from "./page.module.css";

type Queued = { id: string; text: string };
type Job = {
  id: string;
  url: string;
  status: "pending" | "processing" | "done" | "failed";
  error: string | null;
  created_at: string;
  tokens_in: number | null;
  tokens_out: number | null;
  folder: Folder | null;
  review: string | null;
  title: string | null;
};
type Status = { gemini_key: boolean; groq_key: boolean; google_configured: boolean; google_connected: boolean };
// up: laptop answers. down: no answer. login: password needed. setup: no password set on the laptop yet.
type Conn = "checking" | "up" | "down" | "login" | "setup";
type Tab = "inbox" | Folder | "history" | "settings";

const KEY = "gleaner-queue";

// shortcut: localStorage holds the waiting list (a few short links); move to IndexedDB if the
// service worker ever has to send it (Background Sync cannot read localStorage).
function readQueue(): Queued[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}
const writeQueue = (queue: Queued[]) => localStorage.setItem(KEY, JSON.stringify(queue));
// The id is made here so the laptop can ignore a link that gets sent twice.
const enqueue = (text: string) => writeQueue([...readQueue(), { id: crypto.randomUUID(), text }]);

// A switched-off laptop does not refuse the connection, it just never answers: give up after 8 s.
const api = (path: string, body?: object) =>
  fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);

const connFrom = (res: Response | null): Conn =>
  res?.status === 401 ? "login" : res?.status === 503 ? "setup" : "down";

const ago = (iso: string) => {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

function Mark() {
  // A wheat ear: the gleaner picks up what was left behind.
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M12 22V8" />
      <path d="M12 8c0-2.5 1.2-4.5 3-6-.2 2.6-1.2 4.6-3 6Zm0 0c0-2.5-1.2-4.5-3-6 .2 2.6 1.2 4.6 3 6Z" />
      <path d="M12 13c1.8-1.6 4-2.2 6-2-1.4 1.8-3.6 2.4-6 2Zm0 0c-1.8-1.6-4-2.2-6-2 1.4 1.8 3.6 2.4 6 2Z" />
      <path d="M12 18c1.8-1.6 4-2.2 6-2-1.4 1.8-3.6 2.4-6 2Zm0 0c-1.8-1.6-4-2.2-6-2 1.4 1.8 3.6 2.4 6 2Z" />
    </svg>
  );
}

export default function Home() {
  const [queue, setQueue] = useState<Queued[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [conn, setConn] = useState<Conn>("checking");
  const [tab, setTab] = useState<Tab>("inbox");
  const [rejected, setRejected] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [password, setPassword] = useState("");
  const busy = useRef(false);
  const connNow = useRef<Conn>("checking");

  async function sync() {
    if (busy.current) return;
    busy.current = true;
    try {
      setQueue(readQueue());
      let state: Conn = "up";
      for (const item of readQueue()) {
        const res = await api("/api/share", item);
        // 422: the laptop read it and found no Instagram link, so drop it.
        // Anything else that is not a success (offline, login needed, server error): keep it.
        if (res?.ok || res?.status === 422) {
          writeQueue(readQueue().filter((queued) => queued.id !== item.id));
          if (!res.ok) setRejected((list) => [...list, item.text]);
        } else {
          state = connFrom(res);
          break;
        }
      }
      if (state === "up") {
        const [jobsRes, entriesRes, statusRes] = await Promise.all([
          api("/api/jobs"),
          api("/api/entries"),
          api("/api/status"),
        ]);
        if (jobsRes?.ok && entriesRes?.ok && statusRes?.ok) {
          setJobs(await jobsRes.json());
          setEntries(await entriesRes.json());
          setStatus(await statusRes.json());
        } else {
          state = connFrom(jobsRes);
        }
      }
      connNow.current = state;
      setConn(state);
      setQueue(readQueue());
    } finally {
      busy.current = false;
    }
  }

  // One place for every button that changes something on the laptop.
  const act = async (path: string, body: object) => {
    const res = await api(path, body);
    if (!res) setNotice("The laptop did not answer. Nothing was changed.");
    else if (!res.ok) setNotice((await res.json().catch(() => null))?.detail || `That did not work (${res.status}).`);
    else {
      const result = await res.json().catch(() => ({}));
      setNotice(
        result.decision === "approved"
          ? result.google
            ? "Approved. Added to your Gleaner calendar and tasks."
            : "Approved. Google is not connected, so no reminder was made."
          : "",
      );
    }
    await sync();
  };

  useEffect(() => {
    if (process.env.NODE_ENV === "production") navigator.serviceWorker?.register("/sw.js");

    // Android's share menu opens the app as /?text=<what Instagram shared>.
    const params = new URLSearchParams(location.search);
    const shared = params.get("url") || params.get("text");
    if (shared) {
      enqueue(shared);
      history.replaceState(null, "", "/");
    }
    sync();

    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    // While the laptop is answering, keep the screen fresh so finished jobs appear by themselves.
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && connNow.current === "up") sync();
    }, 8000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  function addDraft(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim()) return;
    enqueue(draft.trim());
    setDraft("");
    sync();
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    const res = await api("/api/login", { password });
    setPassword("");
    setNotice(res?.ok ? "" : res ? "Wrong password. After 5 wrong tries, wait 5 minutes." : "The laptop did not answer.");
    sync();
  }

  const review = entries.filter((entry) => entry.review);
  const undecided = entries.filter((entry) => !entry.review && !entry.decision && !entry.expired);
  const inbox = [...review, ...undecided];
  const working = jobs.filter((job) => job.status === "pending" || job.status === "processing").length;
  const failed = jobs.filter((job) => job.status === "failed").length;
  const done = jobs.filter((job) => job.status === "done").length;
  const inFolder = (folder: Folder) => entries.filter((entry) => entry.folder === folder);
  const tabs: [Tab, string, number][] = [
    ["inbox", "Inbox", inbox.length],
    ...(Object.entries(FOLDERS) as [Folder, string][]).map(([name, label]): [Tab, string, number] => [name, label, 0]),
    ["history", "History", failed],
    ["settings", "Settings", 0],
  ];
  const pill = {
    checking: "Looking for the laptop",
    up: working ? `Reading ${working} reel${working > 1 ? "s" : ""}` : "Laptop connected",
    down: "Laptop offline",
    login: "Locked",
    setup: "Needs setup",
  }[conn];

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.brand}>
          <Mark />
          Gleaner
        </h1>
        <span role="status" className={styles.pill} data-conn={conn} data-working={conn === "up" && working > 0}>
          {pill}
        </span>
      </header>

      {notice && (
        <div role="alert" className={styles.notice}>
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice("")}>
            ✕
          </button>
        </div>
      )}

      {conn === "down" && (
        <p className={styles.banner}>
          The laptop is off or out of reach. Keep sharing: links wait safely on this phone and go across the next time
          you open Gleaner with the laptop on.
        </p>
      )}
      {conn === "setup" && (
        <p className={styles.banner}>
          No password is set on the laptop yet. In <code>backend/</code>, run <code>uv run python -m app.auth</code>.
        </p>
      )}

      {conn === "login" && (
        <form onSubmit={login} className={styles.panel}>
          <div>
            <label className={styles.label} htmlFor="password">
              Password
            </label>
            <p className={styles.muted}>Shared links stay on this phone until you log in.</p>
          </div>
          <div className={styles.row}>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button type="submit" className={styles.primary}>
              Unlock
            </button>
          </div>
        </form>
      )}

      {queue.length > 0 && (
        <section>
          <div className={styles.sectionHead}>
            <h2>Waiting for the laptop</h2>
            <p>{queue.length} saved on this phone</p>
          </div>
          <ul className={styles.list}>
            {queue.map((item) => (
              <li key={item.id}>
                <span className={styles.dot} data-status="pending">
                  Waiting
                </span>
                <span className={styles.meta}>{item.text}</span>
              </li>
            ))}
          </ul>
          <div className={styles.row}>
            <button type="button" className={styles.ghost} onClick={sync}>
              Try again
            </button>
          </div>
        </section>
      )}

      {rejected.length > 0 && (
        <section>
          <div className={styles.sectionHead}>
            <h2>Not saved</h2>
            <p>No Instagram link found</p>
          </div>
          <ul className={styles.list}>
            {rejected.map((text, index) => (
              <li key={index} className={styles.meta}>
                {text}
              </li>
            ))}
          </ul>
        </section>
      )}

      {conn === "up" && (
        <>
          <nav className={styles.tabs} aria-label="Sections">
            {tabs.map(([name, label, count]) => (
              <button
                key={name}
                type="button"
                aria-current={tab === name ? "page" : undefined}
                onClick={() => setTab(name)}
              >
                {label}
                {count > 0 && <span className={styles.count}>{count}</span>}
              </button>
            ))}
          </nav>

          {tab === "inbox" && (
            <section>
              <div className={styles.sectionHead}>
                <h2>Needs you</h2>
                {inbox.length > 0 && <p>Approve, skip or sort</p>}
              </div>
              {inbox.length === 0 ? (
                <div className={styles.empty}>
                  <strong>All caught up</strong>
                  Share a reel from Instagram and it lands here.
                </div>
              ) : (
                inbox.map((entry) => <EntryCard key={entry.id} entry={entry} act={act} />)
              )}
            </section>
          )}

          {tab in FOLDERS && (
            <section>
              <div className={styles.sectionHead}>
                <h2>{FOLDERS[tab as Folder]}</h2>
                <p>{inFolder(tab as Folder).length} saved</p>
              </div>
              {inFolder(tab as Folder).length === 0 ? (
                <div className={styles.empty}>
                  <strong>Nothing here yet</strong>
                  Reels that fit this folder appear here.
                </div>
              ) : (
                inFolder(tab as Folder).map((entry) => <EntryCard key={entry.id} entry={entry} act={act} />)
              )}
            </section>
          )}

          {tab === "history" && (
            <section>
              <div className={styles.sectionHead}>
                <h2>History</h2>
              </div>
              <div className={styles.stats}>
                <div>
                  <strong>{done}</strong>
                  <span>done</span>
                </div>
                <div>
                  <strong>{working}</strong>
                  <span>in progress</span>
                </div>
                <div>
                  <strong>{failed}</strong>
                  <span>failed</span>
                </div>
              </div>
              {jobs.length === 0 ? (
                <div className={styles.empty}>
                  <strong>Nothing shared yet</strong>
                  Every reel you share is logged here.
                </div>
              ) : (
                <ul className={styles.list}>
                  {jobs.map((job) => (
                    <li key={job.id}>
                      <a href={job.url} target="_blank" rel="noopener noreferrer">
                        {job.title || new URL(job.url).pathname}
                      </a>
                      <span className={styles.dot} data-status={job.status}>
                        {job.status}
                      </span>
                      <span className={styles.meta}>
                        {job.status === "done" &&
                          `${job.folder ? FOLDERS[job.folder] : job.review === "disputed" ? "Disputed" : "Needs context"} · `}
                        {ago(job.created_at)}
                        {job.status === "done" && job.tokens_in ? ` · ${job.tokens_in + (job.tokens_out ?? 0)} tokens` : ""}
                      </span>
                      {job.error && <p className={styles.error}>{job.error}</p>}
                      {job.status === "failed" && (
                        <button type="button" className={styles.ghost} onClick={() => act(`/api/jobs/${job.id}/retry`, {})}>
                          Run again
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "settings" && status && (
            <section>
              <div className={styles.sectionHead}>
                <h2>Settings</h2>
              </div>

              <form onSubmit={addDraft} className={styles.panel}>
                <label className={styles.label} htmlFor="link">
                  Add a reel by link
                </label>
                <div className={styles.row}>
                  <input
                    id="link"
                    inputMode="url"
                    autoComplete="off"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="https://www.instagram.com/reel/…"
                  />
                  <button type="submit" className={styles.primary}>
                    Add
                  </button>
                </div>
              </form>

              <ul className={styles.list}>
                <li className={styles.check}>
                  <span>Gemini key (sorting)</span>
                  <span className={status.gemini_key ? styles.ok : styles.missing}>
                    {status.gemini_key ? "Set" : "Missing"}
                  </span>
                </li>
                <li className={styles.check}>
                  <span>Groq key (speech)</span>
                  <span className={status.groq_key ? styles.ok : styles.missing}>
                    {status.groq_key ? "Set" : "Missing, speech skipped"}
                  </span>
                </li>
                <li className={styles.check}>
                  <span>Google Calendar and Tasks</span>
                  <span className={status.google_connected ? styles.ok : styles.missing}>
                    {status.google_connected ? "Connected" : status.google_configured ? "Not connected" : "Not set up"}
                  </span>
                </li>
              </ul>

              {status.google_configured && !status.google_connected && (
                <div className={styles.panel}>
                  {/* A plain link, so the browser itself goes to Google and comes back to the laptop. */}
                  <a className={styles.linkButton} href="/api/google/start">
                    Connect Google
                  </a>
                  <p className={styles.muted}>Do this once, in a browser on the laptop itself (http://127.0.0.1:8000).</p>
                </div>
              )}
              <div className={styles.row}>
                {status.google_connected && (
                  <button type="button" className={styles.ghost} onClick={() => act("/api/google/disconnect", {})}>
                    Disconnect Google
                  </button>
                )}
                <button type="button" className={styles.ghost} onClick={() => act("/api/logout", {})}>
                  Log out
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
