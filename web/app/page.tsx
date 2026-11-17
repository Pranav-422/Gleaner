"use client";

import { useEffect, useRef, useState } from "react";
import { cloud } from "./cloud";
import { type Act, type Entry, EntryCard, FOLDERS, type Folder } from "./entries";
import styles from "./page.module.css";

type Queued = { id: string; text: string };
type Job = {
  id: string;
  url: string;
  source: "link" | "screenshot" | "voice" | "claude";
  status: "pending" | "processing" | "done" | "failed";
  error: string | null;
  created_at: string;
  tokens_in: number | null;
  tokens_out: number | null;
  folder: Folder | null;
  review: string | null;
  title: string | null;
};
type Status = {
  gemini_key: boolean;
  groq_key: boolean;
  google_configured: boolean;
  google_connected: boolean;
  google_auth_url: string | null; // consent link the laptop made after "Connect Google"; valid 10 minutes
};
type Action = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: "pending" | "failed";
  error: string | null;
};
// up: laptop seen lately. down: laptop off, showing what it last sent. nonet: this phone cannot reach Supabase.
// login: not signed in. setup: the app was built without its Supabase settings.
type Conn = "checking" | "up" | "down" | "nonet" | "login" | "setup";
type Tab = "inbox" | Folder | "archive" | "history" | "settings";
type Upload = { blob: Blob; type: string };

const CORE: Folder[] = ["youtube", "hackathons", "opportunities", "tools"]; // always shown; the rest once they have entries
const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const AUDIO_TYPES: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3" };
const MAX_RECORDING = 5 * 60_000;
const byScore = (a: Entry, b: Entry) => b.score - a.score;

const KEY = "gleaner-queue";
const OFFLINE_AFTER = 150_000; // ms. The laptop pushes its state at least once a minute while it runs.

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
// The id is made here so a link that gets sent twice is applied once.
const enqueue = (text: string) => writeQueue([...readQueue(), { id: crypto.randomUUID(), text }]);

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
  const [actions, setActions] = useState<Action[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [seenAt, setSeenAt] = useState<string | null>(null);
  const [frames, setFrames] = useState<Record<string, string>>({});
  const [conn, setConn] = useState<Conn>("checking");
  const [tab, setTab] = useState<Tab>("inbox");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [recording, setRecording] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [newPassword, setNewPasswordValue] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const owner = useRef("");
  const fast = useRef(false); // poll every 3 s while an answer or an action is on its way
  const lastSync = useRef(0);
  const busy = useRef(false);
  const signed = useRef<Record<string, string>>({});
  const digest = useRef("");
  const entriesNow = useRef<Entry[]>([]);
  const connNow = useRef<Conn>("checking"); // for code that runs outside a render, like the Google return

  async function load(): Promise<Conn> {
    if (!cloud) return "setup";
    const { data } = await cloud.auth.getSession();
    if (!data.session) return "login";
    owner.current = data.session.user.id;

    for (const item of readQueue()) {
      const { error } = await cloud
        .from("actions")
        .upsert({ id: item.id, kind: "share", payload: { text: item.text } }, { onConflict: "id", ignoreDuplicates: true });
      if (error) return "nonet"; // kept on the phone; tried again next time
      writeQueue(readQueue().filter((queued) => queued.id !== item.id));
    }

    // Polled every few seconds, so only the small columns; the big ones come down when the digest changes.
    const [headRes, actionsRes] = await Promise.all([
      cloud.from("state").select("digest, seen_at").maybeSingle(),
      cloud.from("actions").select("id, kind, payload, status, error").order("created_at"),
    ]);
    if (headRes.error || actionsRes.error) return "nonet";
    const head = headRes.data;
    setSeenAt(head?.seen_at ?? null);
    setActions(actionsRes.data ?? []);
    fast.current = (actionsRes.data ?? []).some((action) => action.status === "pending");
    let list = entriesNow.current;
    if (head && head.digest !== digest.current) {
      const full = await cloud.from("state").select("jobs, entries, status").maybeSingle();
      if (full.error || !full.data) return "nonet";
      list = full.data.entries;
      setJobs(full.data.jobs);
      setEntries(list);
      setStatus(full.data.status);
      digest.current = head.digest;
      entriesNow.current = list;
    }

    // Screenshots sit in a private bucket: ask for links that work for a week, once per screenshot.
    const missing = list.flatMap((entry) => entry.frames).filter((name) => !signed.current[name]);
    if (missing.length) {
      const res = await cloud.storage.from("frames").createSignedUrls(missing.map((name) => `${owner.current}/${name}`), 7 * 86400);
      for (const item of res.data ?? []) {
        if (item.signedUrl && item.path) signed.current[item.path.split("/").pop()!] = item.signedUrl;
      }
      setFrames({ ...signed.current });
    }
    return head && Date.now() - new Date(head.seen_at).getTime() < OFFLINE_AFTER ? "up" : "down";
  }

  async function sync() {
    if (busy.current) return;
    busy.current = true;
    lastSync.current = Date.now();
    try {
      setQueue(readQueue());
      connNow.current = await load().catch((): Conn => "nonet");
      setConn(connNow.current);
      setQueue(readQueue());
    } finally {
      busy.current = false;
    }
  }

  // Every button that changes something becomes one row in `actions`; the laptop picks it up.
  const act: Act = async (kind, payload) => {
    if (!cloud) return;
    const { error } = await cloud.from("actions").insert({ id: crypto.randomUUID(), kind, payload });
    setNotice(
      error
        ? "Could not reach the internet. Nothing was sent."
        : connNow.current === "up"
          ? "Sent. The laptop applies it in a few seconds."
          : "Saved. The laptop applies it when it is on.",
    );
    await sync();
  };

  async function dismiss(id: string) {
    await cloud?.from("actions").delete().eq("id", id);
    await sync();
  }

  // Screenshots and voice notes go to the private uploads bucket; the action tells the laptop where they are.
  async function sendFiles(kind: "screenshot" | "voice", files: Upload[], types: Record<string, string>) {
    if (!cloud || !owner.current) return setNotice("Sign in first.");
    const paths: string[] = [];
    for (const file of files) {
      const type = file.type.split(";")[0];
      if (!types[type]) return setNotice(`This file type is not supported (${type || "unknown"}).`);
      if (file.blob.size > 20 * 1024 * 1024) return setNotice("That file is over 20 MB.");
      const path = `${owner.current}/${crypto.randomUUID()}.${types[type]}`;
      const { error } = await cloud.storage.from("uploads").upload(path, file.blob, { contentType: type });
      if (error) return setNotice(`Upload failed: ${error.message}`);
      paths.push(path);
    }
    await act(kind, { paths });
  }

  function pickScreenshots(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])].slice(0, 5);
    event.target.value = "";
    if (files.length) sendFiles("screenshot", files.map((file) => ({ blob: file, type: file.type })), IMAGE_TYPES);
  }

  async function toggleRecording() {
    if (recorder.current) return recorder.current.stop();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return setNotice("Microphone access was refused.");
    }
    const media = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    media.ondataavailable = (event) => chunks.push(event.data);
    media.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      recorder.current = null;
      setRecording(false);
      const type = media.mimeType || "audio/webm";
      sendFiles("voice", [{ blob: new Blob(chunks, { type }), type }], AUDIO_TYPES);
    };
    media.start();
    recorder.current = media;
    setRecording(true);
    setTimeout(() => media.state === "recording" && media.stop(), MAX_RECORDING);
  }

  useEffect(() => {
    if (process.env.NODE_ENV === "production") navigator.serviceWorker?.register("/sw.js");

    // Android's share menu opens the app as /?text=<what Instagram shared>.
    const params = new URLSearchParams(location.search);
    const shared = params.get("url") || params.get("text");
    if (shared) {
      enqueue(shared);
      history.replaceState(null, "", "/");
    }
    // Google's consent screen comes back as /?code=...&state=... (or ?error=...). The code is single use and
    // tied to a secret that never leaves the laptop, so it is handed over as a normal action.
    const code = params.get("code");
    const state = params.get("state");
    if (code || params.get("error")) history.replaceState(null, "", "/");
    if (params.get("error")) setNotice("Google sign-in was cancelled.");
    // Sync first, so the notice after sending the code knows whether the laptop is on.
    sync().then(() => {
      if (code && state) act("google_code", { code, state });
    });

    const onVisible = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    // Keep the screen fresh so finished jobs and the laptop's comings and goings show by themselves.
    const timer = setInterval(() => {
      const wait = fast.current && connNow.current === "up" ? 3_000 : 10_000;
      if (document.visibilityState === "visible" && Date.now() - lastSync.current >= wait) sync();
    }, 1_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    // Opening the emailed reset link signs in for recovery only; ask for the new password then.
    const listener = cloud?.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
    });
    return () => listener?.data.subscription.unsubscribe();
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
    if (!cloud) return;
    const { error } = await cloud.auth.signInWithPassword({ email: email.trim(), password });
    setPassword("");
    setNotice(error ? error.message : "");
    sync();
  }

  // Forgot password: Supabase emails a link back to this app, which then asks for a new password.
  async function forgot() {
    if (!cloud) return;
    if (!email.trim()) return setNotice("Type your email first, then tap Forgot password.");
    await cloud.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${location.origin}/` });
    // Same message either way, so the page does not reveal which emails have an account.
    setNotice("If that email has an account, a reset link is on its way.");
  }

  async function setNewPassword(event: React.FormEvent) {
    event.preventDefault();
    if (!cloud) return;
    const { error } = await cloud.auth.updateUser({ password: newPassword });
    setNewPasswordValue("");
    if (error) return setNotice(error.message);
    setRecovering(false);
    setNotice("Password changed. Also update SUPABASE_PASSWORD in backend/.env on the laptop.");
    sync();
  }

  async function logout() {
    await cloud?.auth.signOut();
    digest.current = "";
    entriesNow.current = [];
    sync();
  }

  const signedIn = conn === "up" || conn === "down" || conn === "nonet";
  const pendingFor = (ask: boolean) =>
    new Set(
      actions
        .filter((action) => action.status === "pending" && "entry_id" in action.payload && (action.kind === "ask") === ask)
        .map((action) => Number(action.payload.entry_id)),
    );
  const waitingFor = pendingFor(false);
  const askingFor = pendingFor(true);
  const sentShares = actions.filter((action) => action.kind === "share" && action.status === "pending");
  const sentFiles = actions.filter((action) => (action.kind === "screenshot" || action.kind === "voice") && action.status === "pending");
  const failedActions = actions.filter((action) => action.status === "failed");
  const card = (entry: Entry, shortcut = false) => (
    <EntryCard
      key={`${entry.id}${shortcut ? "s" : ""}`}
      entry={entry}
      act={act}
      waiting={waitingFor.has(entry.id)}
      asking={askingFor.has(entry.id)}
      frameUrl={(name) => frames[name]}
      shortcut={shortcut}
    />
  );

  const live = entries.filter((entry) => !entry.archived_at);
  const archived = entries.filter((entry) => entry.archived_at);
  const review = live.filter((entry) => entry.review);
  // The worth-it score decides the order: gold rises, junk sinks (and is archived first).
  const undecided = live.filter((entry) => !entry.review && !entry.decision && !entry.expired).sort(byScore);
  const inbox = [...review, ...undecided];
  const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const dueSoon = live
    .filter((entry) => entry.decision === "approved" && entry.deadline && !entry.expired && entry.deadline <= week)
    .sort((a, b) => a.deadline!.localeCompare(b.deadline!));
  const working = jobs.filter((job) => job.status === "pending" || job.status === "processing").length;
  const failed = jobs.filter((job) => job.status === "failed").length;
  const done = jobs.filter((job) => job.status === "done").length;
  const inFolder = (folder: Folder) => live.filter((entry) => entry.folder === folder).sort(byScore);
  const shortcuts = (folder: Folder) => live.filter((entry) => entry.also === folder && entry.folder !== folder).sort(byScore);
  const folderTabs = (Object.keys(FOLDERS) as Folder[]).filter(
    (folder) => CORE.includes(folder) || inFolder(folder).length + shortcuts(folder).length > 0 || tab === folder,
  );
  const tabs: [Tab, string, number][] = [
    ["inbox", "Inbox", inbox.length],
    ...folderTabs.map((name): [Tab, string, number] => [name, FOLDERS[name], 0]),
    ...(archived.length ? ([["archive", "Archive", 0]] as [Tab, string, number][]) : []),
    ["history", "History", failed],
    ["settings", "Settings", 0],
  ];
  const sourceLabel = { link: "Reel", screenshot: "Screenshot", voice: "Voice note", claude: "Saved by Claude" };
  // Learn is split into its subfolders (Productivity, Communication, ...).
  const groups = (folder: Folder, list: Entry[]): [string, Entry[]][] => {
    if (folder !== "learn") return [["", list]];
    const named = new Map<string, Entry[]>();
    for (const entry of list) {
      const topic = typeof entry.data.subtopic === "string" ? entry.data.subtopic : "Other";
      named.set(topic, [...(named.get(topic) ?? []), entry]);
    }
    return [...named.entries()];
  };
  const pill = {
    checking: "Connecting",
    up: working ? `Reading ${working} reel${working > 1 ? "s" : ""}` : "Laptop online",
    down: seenAt ? `Laptop offline · ${ago(seenAt)}` : "Laptop not set up",
    nonet: "No internet",
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
          {seenAt
            ? "The laptop is off. This is what it showed last. Keep sharing and tapping: it all runs when the laptop is back on."
            : "The laptop has not checked in yet. Start Gleaner on the laptop with the Supabase settings in backend/.env."}
        </p>
      )}
      {conn === "nonet" && (
        <p className={styles.banner}>No internet on this phone. Shared links wait here and go up when you are back online.</p>
      )}
      {conn === "setup" && (
        <p className={styles.banner}>
          This copy was built without its Supabase settings. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>, then build again.
        </p>
      )}

      {recovering && (
        <form onSubmit={setNewPassword} className={styles.panel}>
          <label className={styles.label} htmlFor="new-password">
            Choose a new password
          </label>
          <div className={styles.row}>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              minLength={10}
              required
              value={newPassword}
              onChange={(event) => setNewPasswordValue(event.target.value)}
            />
            <button type="submit" className={styles.primary}>
              Save
            </button>
          </div>
          <p className={styles.muted}>At least 10 characters.</p>
        </form>
      )}

      {conn === "login" && !recovering && (
        <form onSubmit={login} className={styles.panel}>
          <div>
            <label className={styles.label} htmlFor="email">
              Sign in
            </label>
            <p className={styles.muted}>
              Gleaner has one owner account, so there is no sign-up. Use the email and password you added in
              Supabase (Authentication, Users). Shared links stay on this phone until you sign in.
            </p>
          </div>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            placeholder="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <div className={styles.row}>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              placeholder="Password"
              aria-label="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button type="submit" className={styles.primary}>
              Unlock
            </button>
          </div>
          <button type="button" className={`${styles.ghost} ${styles.small}`} onClick={forgot}>
            Forgot password?
          </button>
        </form>
      )}

      {queue.length + sentShares.length + sentFiles.length > 0 && (
        <section>
          <div className={styles.sectionHead}>
            <h2>Waiting for the laptop</h2>
            <p>{queue.length + sentShares.length + sentFiles.length} waiting</p>
          </div>
          <ul className={styles.list}>
            {queue.map((item) => (
              <li key={item.id}>
                <span className={styles.dot} data-status="pending">
                  On this phone
                </span>
                <span className={styles.meta}>{item.text}</span>
              </li>
            ))}
            {sentShares.map((action) => (
              <li key={action.id}>
                <span className={styles.dot} data-status="processing">
                  Sent
                </span>
                <span className={styles.meta}>{String(action.payload.text)}</span>
              </li>
            ))}
            {sentFiles.map((action) => (
              <li key={action.id}>
                <span className={styles.dot} data-status="processing">
                  Sent
                </span>
                <span className={styles.meta}>{action.kind === "voice" ? "Voice note" : "Screenshots"}</span>
              </li>
            ))}
          </ul>
          {queue.length > 0 && (
            <div className={styles.row}>
              <button type="button" className={styles.ghost} onClick={sync}>
                Try again
              </button>
            </div>
          )}
        </section>
      )}

      {failedActions.length > 0 && (
        <section>
          <div className={styles.sectionHead}>
            <h2>Not done</h2>
            <p>The laptop could not do these</p>
          </div>
          <ul className={styles.list}>
            {failedActions.map((action) => (
              <li key={action.id}>
                <span className={styles.meta}>{action.kind === "share" ? String(action.payload.text) : action.kind}</span>
                {action.error && <p className={styles.error}>{action.error}</p>}
                <button type="button" className={styles.ghost} onClick={() => dismiss(action.id)}>
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {signedIn && (
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
              <div className={styles.panel}>
                <span className={styles.label}>Add</span>
                <form onSubmit={addDraft} className={styles.row}>
                  <input
                    aria-label="Reel link"
                    inputMode="url"
                    autoComplete="off"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Paste a reel link…"
                  />
                  <button type="submit" className={styles.primary}>
                    Add
                  </button>
                </form>
                <div className={styles.row}>
                  <button type="button" className={`${styles.ghost} ${styles.small}`} onClick={() => fileInput.current?.click()}>
                    Screenshots
                  </button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    hidden
                    tabIndex={-1}
                    onChange={pickScreenshots}
                  />
                  <button
                    type="button"
                    className={`${recording ? styles.primary : styles.ghost} ${styles.small} ${recording ? styles.recording : ""}`}
                    onClick={toggleRecording}
                    aria-pressed={recording}
                  >
                    {recording ? "● Stop and send" : "Voice note"}
                  </button>
                </div>
                <p className={styles.muted}>
                  Screenshots: when a reel will not load, or for posters. Voice notes: a clear task becomes a to-do.
                </p>
              </div>

              {dueSoon.length > 0 && (
                <>
                  <div className={styles.sectionHead}>
                    <h2>Due this week</h2>
                    <p>Approved, deadline in 7 days</p>
                  </div>
                  <ul className={styles.list}>
                    {dueSoon.map((entry) => (
                      <li key={entry.id}>
                        <strong>{entry.title}</strong>
                        <span className={styles.meta}>
                          {entry.next_step} · {entry.deadline}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className={styles.sectionHead}>
                <h2>Needs you</h2>
                {inbox.length > 0 && <p>Best first: sorted by worth-it score</p>}
              </div>
              {inbox.length === 0 ? (
                <div className={styles.empty}>
                  <strong>All caught up</strong>
                  Share a reel from Instagram and it lands here.
                </div>
              ) : (
                inbox.map((entry) => card(entry))
              )}
            </section>
          )}

          {tab in FOLDERS && (
            <section>
              <div className={styles.sectionHead}>
                <h2>{FOLDERS[tab as Folder]}</h2>
                <p>{inFolder(tab as Folder).length} saved</p>
              </div>
              {inFolder(tab as Folder).length + shortcuts(tab as Folder).length === 0 ? (
                <div className={styles.empty}>
                  <strong>Nothing here yet</strong>
                  Reels that fit this folder appear here.
                </div>
              ) : (
                <>
                  {groups(tab as Folder, inFolder(tab as Folder)).map(([name, list]) => (
                    <div key={name} className={styles.list}>
                      {name && <h3 className={styles.group}>{name}</h3>}
                      {list.map((entry) => card(entry))}
                    </div>
                  ))}
                  {shortcuts(tab as Folder).length > 0 && <h3 className={styles.group}>Also fits here</h3>}
                  {shortcuts(tab as Folder).map((entry) => card(entry, true))}
                </>
              )}
            </section>
          )}

          {tab === "archive" && (
            <section>
              <div className={styles.sectionHead}>
                <h2>Archive</h2>
                <p>Untouched for a month, expired, or low worth-it. Restore keeps it.</p>
              </div>
              {archived.map((entry) => card(entry))}
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
                      {job.url ? (
                        <a href={job.url} target="_blank" rel="noopener noreferrer">
                          {job.title || new URL(job.url).pathname}
                        </a>
                      ) : (
                        <strong>{job.title || sourceLabel[job.source] || "Upload"}</strong>
                      )}
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
                        <button type="button" className={styles.ghost} onClick={() => act("retry", { job_id: job.id })}>
                          Run again
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "settings" && (
            <section>
              <div className={styles.sectionHead}>
                <h2>Settings</h2>
              </div>

              {status && (
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
              )}

              {status?.google_configured && !status.google_connected && (
                <div className={styles.panel}>
                  {status.google_auth_url ? (
                    <a className={styles.linkButton} href={status.google_auth_url}>
                      Continue to Google
                    </a>
                  ) : (
                    <button type="button" className={styles.primary} onClick={() => act("google_start", {})}>
                      Connect Google
                    </button>
                  )}
                  <p className={styles.muted}>
                    {status.google_auth_url
                      ? "Sign in and allow Gleaner. You come back here afterwards."
                      : "The laptop has to be on. A sign-in button appears here a few seconds later."}
                  </p>
                </div>
              )}
              <div className={styles.row}>
                {status?.google_connected && (
                  <button type="button" className={styles.ghost} onClick={() => act("google_disconnect", {})}>
                    Disconnect Google
                  </button>
                )}
                <button type="button" className={styles.ghost} onClick={logout}>
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
