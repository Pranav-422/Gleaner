-- Run after schema.sql, as its own query (SQL Editor > New query > Run). Safe to run again.

-- Sign-up is invite-only, enforced here so no client can skip it. The very first account (the
-- owner) can always be made; after that only emails in signup_allowlist can sign up, by password,
-- magic link or Google alike. Invite someone with:
--   insert into public.signup_allowlist (email) values ('friend@example.com');
create table if not exists public.signup_allowlist (
  email      text primary key,
  added_at   timestamptz not null default now()
);
-- No policies: only the SQL Editor (and the check below) can read or change the list.
alter table public.signup_allowlist enable row level security;
revoke all on public.signup_allowlist from anon, authenticated;

create or replace function public.gleaner_check_signup() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  -- Serialise sign-ups, so two at the same moment cannot both count as "first".
  perform pg_advisory_xact_lock(hashtext('gleaner_signup'));
  if exists (select 1 from auth.users)
     and not exists (select 1 from public.signup_allowlist a where lower(a.email) = lower(new.email)) then
    raise exception 'Sign-up is invite-only';
  end if;
  return new;
end $$;

drop trigger if exists gleaner_check_signup on auth.users;
create trigger gleaner_check_signup before insert on auth.users
  for each row execute function public.gleaner_check_signup();
