"use client";

import { useRef, useState } from "react";
import styles from "./landing.module.css";

export function Mark({ size = 26 }: { size?: number }) {
  // A wheat ear: the gleaner picks up what was left behind.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M12 22V8" />
      <path d="M12 8c0-2.5 1.2-4.5 3-6-.2 2.6-1.2 4.6-3 6Zm0 0c0-2.5-1.2-4.5-3-6 .2 2.6 1.2 4.6 3 6Z" />
      <path d="M12 13c1.8-1.6 4-2.2 6-2-1.4 1.8-3.6 2.4-6 2Zm0 0c-1.8-1.6-4-2.2-6-2 1.4 1.8 3.6 2.4 6 2Z" />
      <path d="M12 18c1.8-1.6 4-2.2 6-2-1.4 1.8-3.6 2.4-6 2Zm0 0c-1.8-1.6-4-2.2-6-2 1.4 1.8 3.6 2.4 6 2Z" />
    </svg>
  );
}

const Icon = ({ d }: { d: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

const ICONS = {
  share: "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13",
  read: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  calendar: "M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm4 11 2 2 4-4",
  gauge: "M12 14l4-4M3.3 17a10 10 0 1 1 17.4 0",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12Z",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Zm-3-10 2 2 4-4",
  plug: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0V8ZM12 18v4",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
};

const STEPS = [
  ["share", "Share it", "Tap Share on any reel and pick Gleaner. Screenshots and voice notes work too."],
  ["read", "Gleaner reads it", "Frames, captions and speech are read on your own laptop, then sorted into the right folder."],
  ["calendar", "You decide", "Approve what is worth it. The next step lands in your Google Calendar and Tasks."],
] as const;

const FEATURES = [
  ["gauge", "Worth-it score", "Relevance, credibility, payoff and effort, rolled into one number. Gold rises, junk sinks."],
  ["folder", "14 smart folders", "Tools, hackathons, opportunities, learning and more. Fits two? It shows up in both."],
  ["mic", "Screenshots & voice", "Snap a poster or mumble an idea. Gleaner reads the text and transcribes the audio."],
  ["chat", "Ask about any save", "“Is this free?” “What do I need first?” Ask the AI right on the card."],
  ["shield", "Checks the facts", "Dead links and passed deadlines are caught, and stale saves archive themselves."],
  ["plug", "Works with Claude", "Connect Claude to search your saves or file new ones from a chat."],
] as const;

type Props = {
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  onLogin: (event: React.FormEvent) => void;
  onForgot: () => void;
  queued: number;
};

export function Landing({ email, setEmail, password, setPassword, onLogin, onForgot, queued }: Props) {
  const [show, setShow] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const focusSignIn = () => {
    emailRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    emailRef.current?.focus({ preventScroll: true });
  };

  return (
    <div className={styles.page}>
      <nav className={styles.nav}>
        <span className={styles.brand}>
          <Mark />
          Gleaner
        </span>
        <button type="button" className={styles.navButton} onClick={focusSignIn}>
          Sign in
        </button>
      </nav>

      <header className={styles.hero}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Your private reel inbox</p>
          <h1>
            Saved reels, finally <em>put to work.</em>
          </h1>
          <p className={styles.lede}>
            Share an Instagram reel, screenshot or voice note. Gleaner watches it, pulls out the useful part, scores whether
            it is worth your time, and puts the next step on your calendar.
          </p>
          <ul className={styles.trust}>
            <li>Runs on your own laptop</li>
            <li>Owner-only, no public sign-up</li>
            <li>Shares wait while the laptop sleeps</li>
          </ul>
        </div>

        <form onSubmit={onLogin} className={styles.card} aria-labelledby="signin-title">
          <div>
            <h2 id="signin-title">Welcome back</h2>
            <p className={styles.muted}>Sign in to open your Gleaner.</p>
          </div>
          {queued > 0 && (
            <p className={styles.queued}>
              {queued} shared {queued > 1 ? "items are" : "item is"} waiting on this phone. {queued > 1 ? "They go" : "It goes"} up as
              soon as you sign in.
            </p>
          )}
          <label className={styles.field}>
            <span>Email</span>
            <input
              ref={emailRef}
              type="email"
              autoComplete="username"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldHead}>
              Password
              <button type="button" className={styles.link} onClick={onForgot}>
                Forgot password?
              </button>
            </span>
            <span className={styles.password}>
              <input
                type={show ? "text" : "password"}
                autoComplete="current-password"
                required
                placeholder="Your password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className={styles.reveal}
                aria-label={show ? "Hide password" : "Show password"}
                aria-pressed={show}
                onClick={() => setShow(!show)}
              >
                {show ? "Hide" : "Show"}
              </button>
            </span>
          </label>
          <button type="submit" className={styles.submit}>
            Sign in
          </button>
          <p className={styles.footnote}>
            <Icon d={ICONS.lock} />
            <span>
              Gleaner has one owner account, so there is no sign-up. Use the login you created in Supabase under
              Authentication, Users.
            </span>
          </p>
        </form>
      </header>

      <section className={styles.demo} aria-label="What a saved reel turns into">
        <div className={styles.reel} aria-hidden="true">
          <span className={styles.play}>▶</span>
          <span className={styles.reelHandle}>@buildwithai</span>
          <span className={styles.reelCaption}>5 free AI tools that replace a $200 stack 🤯</span>
        </div>
        <div className={styles.arrow} aria-hidden="true">
          <svg width="56" height="24" viewBox="0 0 56 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M2 12h50M44 4l8 8-8 8" />
          </svg>
        </div>
        <article className={styles.result}>
          <div className={styles.resultHead}>
            <span className={styles.chip}>Tools</span>
            <span className={styles.score}>
              <strong>86</strong> worth it
            </span>
          </div>
          <h3>Replace paid design tools with free AI ones</h3>
          <ol className={styles.checklist}>
            <li data-done="true">Try the free image upscaler</li>
            <li data-done="true">Export a test logo</li>
            <li>Cancel the old subscription</li>
          </ol>
          <p className={styles.nudge}>
            <Icon d={ICONS.calendar} />
            Next step on your calendar · Fri 6 pm
          </p>
        </article>
      </section>

      <section className={styles.section}>
        <p className={styles.eyebrow}>How it works</p>
        <h2>From scroll to schedule in three taps.</h2>
        <ol className={styles.steps}>
          {STEPS.map(([icon, title, text], index) => (
            <li key={title}>
              <span className={styles.stepIcon}>
                <Icon d={ICONS[icon]} />
              </span>
              <span className={styles.stepNo}>0{index + 1}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.section}>
        <p className={styles.eyebrow}>What you get</p>
        <h2>Less hoarding. More doing.</h2>
        <ul className={styles.features}>
          {FEATURES.map(([icon, title, text]) => (
            <li key={title}>
              <span className={styles.featureIcon}>
                <Icon d={ICONS[icon]} />
              </span>
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.cta}>
        <h2>Your saved folder is full of good ideas. Let&rsquo;s use them.</h2>
        <button type="button" className={styles.submit} onClick={focusSignIn}>
          Sign in to Gleaner
        </button>
      </section>

      <footer className={styles.footer}>
        <span className={styles.brandSmall}>
          <Mark size={18} />
          Gleaner
        </span>
        <a href="https://github.com/Pranav-422/Gleaner" target="_blank" rel="noreferrer">
          Open source on GitHub
        </a>
      </footer>
    </div>
  );
}
