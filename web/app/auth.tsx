"use client";

import { useEffect, useRef, useState } from "react";
import { cloud, key, url } from "./cloud";
import styles from "./landing.module.css";

type Mode = "signin" | "signup" | "forgot" | "link" | "sent";
type Sent = "signup" | "link" | "reset";
type Settings = { google: boolean; signup: boolean };

const MIN = 10; // characters; also enforced by Supabase if its minimum is set the same

// Supabase's own messages, said the way a person would.
export function friendly(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "Email or password is wrong.";
  if (m.includes("email not confirmed")) return "Confirm your email first. The link is in your inbox, or resend it below.";
  if (m.includes("database error saving new user") || m.includes("invite-only"))
    return "Sign-up is invite-only and this email is not on the list. Ask the owner to add it, or sign in instead.";
  if (m.includes("signups not allowed") || m.includes("signup is disabled") || m.includes("signup_disabled"))
    return "New accounts are switched off in Supabase (Authentication, Sign In / Providers, Allow new users to sign up).";
  if (m.includes("provider is not enabled")) return "Google sign-in is not switched on yet. Use email for now.";
  if (m.includes("already registered") || m.includes("already exists")) return "That email already has an account. Sign in instead.";
  if (m.includes("expired") || m.includes("invalid or has expired")) return "That link has expired or was already used. Ask for a new one.";
  if (m.includes("rate limit") || m.includes("security purposes") || m.includes("too many"))
    return "Too many tries. Wait a minute, then try again.";
  if (m.includes("failed to fetch") || m.includes("network")) return "No connection. Check your internet and try again.";
  return message;
}

export function rules(password: string): [boolean, string][] {
  return [
    [password.length >= MIN, `${MIN}+ characters`],
    [/[a-z]/.test(password) && /[A-Z]/.test(password), "Upper and lower case"],
    [/\d/.test(password), "A number"],
    [/[^A-Za-z0-9]/.test(password), "A symbol"],
  ];
}

function Strength({ password }: { password: string }) {
  if (!password) return null;
  const list = rules(password);
  const score = password.length < MIN ? 0 : list.filter(([ok]) => ok).length;
  const label = password.length < MIN ? "Too short" : ["Weak", "Weak", "Fair", "Good", "Strong"][score];
  return (
    <div className={styles.strength} data-score={score}>
      <div className={styles.meter} aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <p aria-live="polite">Strength: {label}</p>
      <ul>
        {list.map(([ok, text]) => (
          <li key={text} data-ok={ok}>
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

type SecretProps = {
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  show: boolean;
  setShow: (show: boolean) => void;
  onCaps: (on: boolean) => void;
  invalid?: boolean;
};

function Secret({ label, value, onChange, autoComplete, show, setShow, onCaps, invalid }: SecretProps) {
  const caps = (event: React.KeyboardEvent) => onCaps(event.getModifierState("CapsLock"));
  return (
    <label className={styles.field}>
      {label}
      <span className={styles.password}>
        <input
          type={show ? "text" : "password"}
          autoComplete={autoComplete}
          required
          aria-invalid={invalid || undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={caps}
          onKeyUp={caps}
          onBlur={() => onCaps(false)}
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
  );
}

const GoogleLogo = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5Z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7Z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44Z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5Z" />
  </svg>
);

const LockIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

type Props = {
  queued: number;
  recovering: boolean; // opened from a password-reset email
  onSignedIn: () => void;
  onPasswordSet: () => void;
};

export function AuthCard({ queued, recovering, onSignedIn, onPasswordSet }: Props) {
  const [mode, setMode] = useState<Mode>("signin");
  const [sent, setSent] = useState<Sent>("signup");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resendable, setResendable] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [settings, setSettings] = useState<Settings | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Public auth settings: is Google on, are new accounts allowed. Lets the card say so up front.
  useEffect(() => {
    if (!url || !key) return;
    fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
      .then((res) => (res.ok ? res.json() : null))
      .then((s) => s && setSettings({ google: Boolean(s.external?.google), signup: !s.disable_signup }))
      .catch(() => {});
  }, []);

  // Email links and Google come back with any error in the URL; show it, then tidy the URL.
  useEffect(() => {
    const params = new URLSearchParams(location.hash.slice(1) || location.search);
    const description = params.get("error_description");
    if (!description) return;
    setError(friendly(description));
    history.replaceState(null, "", location.pathname);
  }, []);

  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const here = () => `${location.origin}/`;
  const clean = email.trim();
  const tooShort = password.length < MIN;
  const mismatch = confirm.length > 0 && confirm !== password;

  function go(next: Mode) {
    setMode(next);
    setError("");
    setResendable(false);
    setPassword("");
    setConfirm("");
    // Focus the first field of the new view once it renders.
    requestAnimationFrame(() => formRef.current?.querySelector("input")?.focus());
  }

  async function run(task: () => Promise<string | void>) {
    if (!cloud) return setError("This copy was built without its Supabase settings.");
    setBusy(true);
    setError("");
    setResendable(false);
    try {
      const problem = await task();
      if (problem) setError(friendly(problem));
    } catch (err) {
      setError(friendly(err instanceof Error ? err.message : String(err)));
    } finally {
      setBusy(false);
    }
  }

  const showSent = (kind: Sent) => {
    setSent(kind);
    setMode("sent");
    setCooldown(60);
  };

  const signIn = () =>
    run(async () => {
      const { error } = await cloud!.auth.signInWithPassword({ email: clean, password });
      if (error) {
        setResendable(error.message.toLowerCase().includes("not confirmed"));
        return error.message;
      }
      setPassword("");
      onSignedIn();
    });

  const signUp = () =>
    run(async () => {
      if (tooShort) return `Use at least ${MIN} characters for the password.`;
      if (confirm !== password) return "The two passwords do not match.";
      const { data, error } = await cloud!.auth.signUp({ email: clean, password, options: { emailRedirectTo: here() } });
      if (error) return error.message;
      setPassword("");
      setConfirm("");
      if (data.session) return onSignedIn(); // email confirmation is off: signed in straight away
      showSent("signup");
    });

  const sendReset = () =>
    run(async () => {
      const { error } = await cloud!.auth.resetPasswordForEmail(clean, { redirectTo: here() });
      if (error) return error.message;
      showSent("reset");
    });

  const sendLink = () =>
    run(async () => {
      const { error } = await cloud!.auth.signInWithOtp({ email: clean, options: { shouldCreateUser: false, emailRedirectTo: here() } });
      // An unknown email is reported like a sent one, so the page never reveals who has an account.
      if (error && !/signups? not allowed|otp_disabled/i.test(`${error.message} ${error.code}`)) return error.message;
      showSent("link");
    });

  const resend = (kind: Sent = sent) => {
    if (kind === "reset") return sendReset();
    if (kind === "link") return sendLink();
    return run(async () => {
      const { error } = await cloud!.auth.resend({ type: "signup", email: clean, options: { emailRedirectTo: here() } });
      if (error) return error.message;
      showSent("signup");
    });
  };

  const google = () =>
    run(async () => {
      if (settings && !settings.google)
        return "Google sign-in is not switched on yet. The owner turns it on in Supabase: Authentication, Sign In / Providers, Google.";
      const { error } = await cloud!.auth.signInWithOAuth({ provider: "google", options: { redirectTo: here() } });
      if (error) return error.message;
    });

  const setNew = () =>
    run(async () => {
      if (tooShort) return `Use at least ${MIN} characters for the password.`;
      if (confirm !== password) return "The two passwords do not match.";
      const { error } = await cloud!.auth.updateUser({ password });
      if (error) return error.message;
      setPassword("");
      setConfirm("");
      onPasswordSet();
    });

  const view = recovering ? "reset" : mode;
  const submit = { signin: signIn, signup: signUp, forgot: sendReset, link: sendLink, sent: () => resend(), reset: setNew }[view];
  const signupOff = view === "signup" && settings?.signup === false;
  const what = { signup: "confirmation link", link: "sign-in link", reset: "password reset link" }[sent];
  const head = {
    signin: ["Welcome back", "Sign in to open your Gleaner."],
    signup: ["Create your account", "Start turning saved reels into next steps."],
    forgot: ["Reset your password", "We will email you a link to choose a new one."],
    link: ["Sign in with a link", "No password needed. We email you a one-time link."],
    sent: ["Check your email", ""],
    reset: ["Choose a new password", "You are signed in from the reset link. Pick a new password to finish."],
  }[view];
  const label = {
    signin: busy ? "Signing in…" : "Sign in",
    signup: busy ? "Creating account…" : "Create account",
    forgot: busy ? "Sending…" : "Send reset link",
    link: busy ? "Sending…" : "Email me a link",
    sent: cooldown ? `Resend in ${cooldown}s` : busy ? "Sending…" : "Resend email",
    reset: busy ? "Saving…" : "Save new password",
  }[view];

  const emailField = (
    <label className={styles.field}>
      Email
      <input
        type="email"
        autoComplete={view === "signup" ? "email" : "username"}
        inputMode="email"
        required
        placeholder="you@example.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
    </label>
  );

  return (
    <form
      ref={formRef}
      id="signin"
      className={styles.card}
      aria-labelledby="auth-title"
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !signupOff && !(view === "sent" && cooldown)) submit();
      }}
    >
      {(view === "signin" || view === "signup") && (
        <div className={styles.tabs} role="group" aria-label="Sign in or create an account">
          <button type="button" aria-pressed={view === "signin"} onClick={() => go("signin")}>
            Sign in
          </button>
          <button type="button" aria-pressed={view === "signup"} onClick={() => go("signup")}>
            Create account
          </button>
        </div>
      )}
      {(view === "forgot" || view === "link" || view === "sent") && (
        <button type="button" className={styles.back} onClick={() => go("signin")}>
          ← Back to sign in
        </button>
      )}

      <div>
        <h2 id="auth-title">{head[0]}</h2>
        {view === "sent" ? (
          <p className={styles.muted}>
            We sent a {what} to <strong>{clean}</strong>. It can take a minute; check spam too.
          </p>
        ) : (
          <p className={styles.muted}>{head[1]}</p>
        )}
      </div>

      {queued > 0 && view !== "reset" && (
        <p className={styles.info}>
          {queued} shared {queued > 1 ? "items are" : "item is"} waiting on this phone. {queued > 1 ? "They go" : "It goes"} up as soon
          as you sign in.
        </p>
      )}
      {signupOff && (
        <p className={styles.info}>
          New accounts are switched off. The owner turns them on in Supabase: Authentication, Sign In / Providers, Allow new users
          to sign up.
        </p>
      )}

      {(view === "signin" || view === "signup") && (
        <>
          <button type="button" className={styles.oauth} onClick={google} disabled={busy}>
            <GoogleLogo />
            Continue with Google
          </button>
          <p className={styles.divider}>
            <span>or with email</span>
          </p>
        </>
      )}

      {view !== "sent" && view !== "reset" && emailField}

      {view === "signin" && (
        <Secret
          label={
            <span className={styles.fieldHead}>
              Password
              <button type="button" className={styles.link} onClick={() => go("forgot")}>
                Forgot password?
              </button>
            </span>
          }
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          show={show}
          setShow={setShow}
          onCaps={setCaps}
        />
      )}

      {(view === "signup" || view === "reset") && (
        <>
          <Secret
            label={view === "reset" ? "New password" : "Password"}
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            show={show}
            setShow={setShow}
            onCaps={setCaps}
          />
          <Strength password={password} />
          <Secret
            label="Confirm password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            show={show}
            setShow={setShow}
            onCaps={setCaps}
            invalid={mismatch}
          />
          {mismatch && <p className={styles.hint}>The passwords do not match yet.</p>}
        </>
      )}

      {caps && <p className={styles.hint}>Caps Lock is on.</p>}

      {error && (
        <div role="alert" className={styles.error}>
          <p>{error}</p>
          {resendable && (
            <button
              type="button"
              className={styles.link}
              onClick={() => resend("signup")}
            >
              Resend confirmation email
            </button>
          )}
        </div>
      )}

      <button type="submit" className={styles.submit} disabled={busy || signupOff || (view === "sent" && cooldown > 0)}>
        {busy && <span className={styles.spinner} aria-hidden="true" />}
        {label}
      </button>

      {view === "signin" && (
        <button type="button" className={styles.secondary} onClick={() => go("link")}>
          Email me a sign-in link instead
        </button>
      )}
      {view === "sent" && /@(gmail|googlemail)\.com$/i.test(clean) && (
        <a className={styles.secondary} href="https://mail.google.com/mail/u/0/#inbox" target="_blank" rel="noreferrer">
          Open Gmail
        </a>
      )}
      {view === "sent" && (
        <button type="button" className={styles.link} onClick={() => go(sent === "signup" ? "signup" : "signin")}>
          Wrong email? Start again
        </button>
      )}

      <p className={styles.footnote}>
        <LockIcon />
        <span>
          {view === "signup"
            ? "Sign-up is invite-only: the owner adds your email first. Your password goes only to Supabase Auth, over HTTPS."
            : "Your password goes only to Supabase Auth, over HTTPS. This site never stores it."}
        </span>
      </p>
    </form>
  );
}
