"use client";

import { useState } from "react";
import styles from "./page.module.css";

export const FOLDERS = {
  youtube: "YouTube",
  hackathons: "Hackathons",
  opportunities: "Opportunities",
  tools: "Tools & Bots",
} as const;
export type Folder = keyof typeof FOLDERS;

export type Entry = {
  id: number;
  url: string;
  folder: Folder | null;
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
};

// Sends one action to the laptop through Supabase.
export type Act = (kind: string, payload: object) => Promise<void>;

/** "13 days left · 30 Nov", and how urgent that is. */
function due(deadline: string): { text: string; tone: "late" | "soon" | "far" } {
  const date = new Date(`${deadline}T00:00:00`);
  const days = Math.round((date.getTime() - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  const when = date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (days < 0) return { text: `Expired · ${when}`, tone: "late" };
  const left = days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `${days} days left`;
  return { text: `${left} · ${when}`, tone: days <= 7 ? "soon" : "far" };
}

export function EntryCard({
  entry,
  act,
  waiting,
  frameUrl,
}: {
  entry: Entry;
  act: Act;
  waiting: boolean; // an action for this entry is sent but the laptop has not applied it yet
  frameUrl: (name: string) => string | undefined;
}) {
  const [hint, setHint] = useState("");
  const id = { entry_id: entry.id };
  const others = (Object.keys(FOLDERS) as Folder[]).filter((folder) => !entry.guesses.includes(folder));
  const deadline = entry.deadline ? due(entry.deadline) : null;
  const kind = entry.folder ? FOLDERS[entry.folder] : entry.review === "disputed" ? "Which folder?" : "Could not read";

  return (
    <article className={styles.card} data-folder={entry.folder ?? "review"}>
      <header className={styles.cardTop}>
        <span className={styles.kind}>{kind}</span>
        {deadline && (
          <span className={styles.due} data-tone={deadline.tone}>
            {deadline.text}
          </span>
        )}
      </header>

      <h3>{entry.title}</h3>
      {entry.summary && <p className={styles.summary}>{entry.summary}</p>}

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
              <button key={folder} type="button" className={styles.ghost} onClick={() => act("file", { ...id, folder })}>
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
            What is this reel about?
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

      {!waiting && !entry.review && !entry.decision && (
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

      <footer className={styles.cardEnd}>
        <a href={entry.url} target="_blank" rel="noopener noreferrer">
          Open the reel ↗
        </a>
        {entry.decision && (
          <span className={styles.decision} data-decision={entry.decision}>
            {entry.decision === "approved" ? "✓ Approved" : "Skipped"}
          </span>
        )}
      </footer>
    </article>
  );
}
