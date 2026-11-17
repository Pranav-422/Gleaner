"use client";

import { useState } from "react";
import styles from "./page.module.css";

// Same order and names as FOLDERS in backend/app/llm.py.
export const FOLDERS = {
  youtube: "YouTube",
  hackathons: "Hackathons",
  opportunities: "Opportunities",
  tools: "Tools & Bots",
  quick_picks: "Quick Picks",
  learn: "Learn",
  news: "News & Events",
  make_money: "Make Money",
  project_ideas: "Project Ideas",
  career: "Career & Interviews",
  courses: "Free Courses",
  repos: "Repos & Sites",
  finance: "Finance",
  notes: "Your Notes",
} as const;
export type Folder = keyof typeof FOLDERS;

type Check = { status: string; note?: string; code?: number; deadline?: string | null; sources?: { title: string; url: string }[] };

export type Entry = {
  id: number;
  url: string;
  folder: Folder | null;
  also: Folder | null;
  review: "disputed" | "needs_context" | null;
  guesses: Folder[];
  title: string;
  summary: string | null;
  next_step: string | null;
  deadline: string | null;
  data: Record<string, string | string[]>;
  raw_text: string | null;
  frames: string[];
  decision: "approved" | "skipped" | null;
  expired: boolean;
  score: number;
  checks: { link?: Check; verify?: Check; kept?: boolean };
  chat: { role: "you" | "ai"; text: string }[];
  archived_at: string | null;
};

// Sends one action to the laptop through Supabase.
export type Act = (kind: string, payload: object) => Promise<void>;

const QUICK = ["Explain simply", "Give an example", "Why it matters"];

/** "13 days left · 30 Nov", and how urgent that is. */
function due(deadline: string): { text: string; tone: "late" | "soon" | "far" } {
  const date = new Date(`${deadline}T00:00:00`);
  const days = Math.round((date.getTime() - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  const when = date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (days < 0) return { text: `Expired · ${when}`, tone: "late" };
  const left = days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `${days} days left`;
  return { text: `${left} · ${when}`, tone: days <= 7 ? "soon" : "far" };
}

function verdict(folder: Folder | null, check: Check): { text: string; tone: "good" | "warn" | "muted" } {
  const news = folder === "news";
  if (check.status === "verified") return { text: news ? "Confirmed" : "Verified", tone: "good" };
  if (check.status === "mismatch") return { text: news ? "Misleading" : "Differs from official page", tone: "warn" };
  return { text: "Unverified", tone: "muted" };
}

export function EntryCard({
  entry,
  act,
  waiting,
  asking,
  frameUrl,
  shortcut = false,
}: {
  entry: Entry;
  act: Act;
  waiting: boolean; // an action for this entry is sent but the laptop has not applied it yet
  asking: boolean; // an Ask AI question is waiting for its answer
  frameUrl: (name: string) => string | undefined;
  shortcut?: boolean; // shown in a second folder it also fits
}) {
  const [hint, setHint] = useState("");
  const [question, setQuestion] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const id = { entry_id: entry.id };
  const others = (Object.keys(FOLDERS) as Folder[]).filter((folder) => folder !== "notes" && !entry.guesses.includes(folder));
  const deadline = entry.deadline ? due(entry.deadline) : null;
  const kind = entry.folder ? FOLDERS[entry.folder] : entry.review === "disputed" ? "Which folder?" : "Could not read";
  const check = entry.checks.verify;
  const link = entry.checks.link;
  const ask = (text: string) => {
    if (text.trim().length < 2) return;
    act("ask", { ...id, question: text.trim() });
    setQuestion("");
  };

  return (
    <article className={styles.card} data-folder={entry.folder ?? "review"}>
      <header className={styles.cardTop}>
        <span className={styles.kind}>
          {shortcut ? `↗ from ${entry.folder ? FOLDERS[entry.folder] : ""}` : kind}
        </span>
        {deadline && (
          <span className={styles.due} data-tone={deadline.tone}>
            {deadline.text}
          </span>
        )}
      </header>

      <h3>{entry.title}</h3>
      {entry.summary && <p className={styles.summary}>{entry.summary}</p>}

      {!entry.review && (
        <div className={styles.flags}>
          <span className={styles.flag} title="Worth-it score: goals, payoff, credibility, effort, freshness">
            <span className={styles.score}>{entry.score}</span> worth-it
          </span>
          {check && (
            <span className={styles.flag} data-tone={verdict(entry.folder, check).tone}>
              {verdict(entry.folder, check).text}
            </span>
          )}
          {link?.status === "dead" && (
            <span className={styles.flag} data-tone="warn">
              Link looks dead
            </span>
          )}
          {entry.also && !shortcut && <span className={styles.flag}>Also in {FOLDERS[entry.also]}</span>}
        </div>
      )}
      {check?.note && check.status !== "unverified" && <p className={styles.note}>{check.note}</p>}
      {check?.sources && check.sources.length > 0 && (
        <p className={styles.note}>
          Sources:{" "}
          {check.sources.map((source, index) => (
            <span key={source.url}>
              {index > 0 && ", "}
              {/* From Google's search results, not from the reel. */}
              <a href={source.url} target="_blank" rel="noopener noreferrer nofollow">
                {source.title || "source"}
              </a>
            </span>
          ))}
        </p>
      )}

      {Object.keys(entry.data).length > 0 && (
        <dl className={styles.fields}>
          {Object.entries(entry.data).map(([name, value]) => (
            <div key={name}>
              <dt>{name.replace(/_/g, " ")}</dt>
              {/* Shown as plain text on purpose: links found inside a reel are not trusted. */}
              <dd>
                {Array.isArray(value) ? (
                  <ul className={styles.chips}>
                    {value.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  value
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {entry.frames.length > 0 && (
        <div className={styles.thumbs}>
          {entry.frames.map((name) => {
            const src = frameUrl(name);
            return (
              src && (
                <a key={name} href={src} target="_blank" rel="noopener noreferrer">
                  <img src={src} alt="Screenshot from the reel" loading="lazy" />
                </a>
              )
            );
          })}
        </div>
      )}

      {waiting && (
        <div className={styles.action}>
          <p className={styles.step}>Sent. The laptop applies it when it is on.</p>
        </div>
      )}

      {!waiting && entry.review === "disputed" && (
        <div className={styles.action}>
          <p className={styles.actionLabel}>Pick the folder</p>
          <div className={styles.row}>
            {entry.guesses.map((folder) => (
              <button key={folder} type="button" className={styles.primary} onClick={() => act("file", { ...id, folder })}>
                {FOLDERS[folder]}
              </button>
            ))}
            {others.map((folder) => (
              <button key={folder} type="button" className={`${styles.ghost} ${styles.small}`} onClick={() => act("file", { ...id, folder })}>
                {FOLDERS[folder]}
              </button>
            ))}
          </div>
        </div>
      )}

      {!waiting && entry.review === "needs_context" && (
        <form
          className={styles.action}
          onSubmit={(event) => {
            event.preventDefault();
            act("context", { ...id, hint });
          }}
        >
          <label className={styles.actionLabel} htmlFor={`hint-${entry.id}`}>
            What is this about?
          </label>
          <textarea
            id={`hint-${entry.id}`}
            rows={3}
            minLength={3}
            maxLength={1000}
            required
            placeholder="For example: a hackathon by IIT Delhi, registration closes this month"
            value={hint}
            onChange={(event) => setHint(event.target.value)}
          />
          {entry.raw_text && (
            <details className={styles.raw}>
              <summary>What Gleaner read from it</summary>
              <pre>{entry.raw_text}</pre>
            </details>
          )}
          <div className={styles.row}>
            <button type="submit" className={styles.primary}>
              Process again
            </button>
          </div>
        </form>
      )}

      {!waiting && !entry.review && !entry.decision && !entry.archived_at && (
        <div className={styles.action}>
          <p className={styles.actionLabel}>Next step</p>
          <p className={styles.step}>{entry.next_step || "Decide what to do with this."}</p>
          <div className={styles.row}>
            <button type="button" className={styles.primary} onClick={() => act("decision", { ...id, decision: "approved" })}>
              Approve
            </button>
            <button type="button" className={styles.ghost} onClick={() => act("decision", { ...id, decision: "skipped" })}>
              Skip
            </button>
          </div>
        </div>
      )}

      {!entry.review && (askOpen || entry.chat.length > 0 || asking) && (
        <div className={styles.action}>
          <p className={styles.actionLabel}>Ask AI</p>
          {entry.chat.length > 0 && (
            <div className={styles.chat}>
              {entry.chat.map((turn, index) => (
                <p key={index} className={styles.bubble} data-role={turn.role}>
                  {turn.text}
                </p>
              ))}
            </div>
          )}
          {asking ? (
            <p className={styles.note}>Thinking… the laptop answers in a few seconds when it is on.</p>
          ) : (
            <>
              <div className={styles.row}>
                {QUICK.map((text) => (
                  <button key={text} type="button" className={`${styles.ghost} ${styles.small}`} onClick={() => ask(text)}>
                    {text}
                  </button>
                ))}
              </div>
              <form
                className={styles.row}
                onSubmit={(event) => {
                  event.preventDefault();
                  ask(question);
                }}
              >
                <input
                  aria-label="Your question"
                  maxLength={500}
                  placeholder="Ask about this…"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                />
                <button type="submit" className={styles.primary}>
                  Ask
                </button>
              </form>
            </>
          )}
        </div>
      )}

      <footer className={styles.cardEnd}>
        {entry.url ? (
          <a href={entry.url} target="_blank" rel="noopener noreferrer">
            Open the reel ↗
          </a>
        ) : (
          <span className={styles.note}>From a screenshot or voice note</span>
        )}
        <span className={styles.row}>
          {!entry.review && !askOpen && entry.chat.length === 0 && !asking && (
            <button type="button" className={`${styles.ghost} ${styles.small}`} onClick={() => setAskOpen(true)}>
              Ask AI
            </button>
          )}
          {!waiting && (
            <button
              type="button"
              className={`${styles.ghost} ${styles.small}`}
              onClick={() => act(entry.archived_at ? "restore" : "archive", id)}
            >
              {entry.archived_at ? "Restore" : "Archive"}
            </button>
          )}
          {entry.decision && (
            <span className={styles.decision} data-decision={entry.decision}>
              {entry.decision === "approved" ? "✓ Approved" : "Skipped"}
            </span>
          )}
        </span>
      </footer>
    </article>
  );
}
