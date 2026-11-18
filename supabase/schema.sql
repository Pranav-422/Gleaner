-- Gleaner cloud relay. Paste into Supabase: SQL Editor > New query > Run. Safe to run again.
--
-- actions: what the phone asks for (share, approve, ...). The laptop applies and deletes them.
-- state:   one row per owner: the laptop's latest jobs, entries and status, plus when it was last seen.
-- frames:  private storage bucket, one folder per owner, for the screenshots shown on cards.
-- Every row is tied to its owner by row level security, and the laptop signs in as that same owner.

create table if not exists public.actions (
  id         uuid primary key,  -- made on the phone, so a resent share is not applied twice
  owner      uuid not null default auth.uid() references auth.users on delete cascade,
  kind       text not null,
  payload    jsonb not null default '{}' check (length(payload::text) <= 4000),
  status     text not null default 'pending' check (status in ('pending', 'failed')),
  error      text,
  created_at timestamptz not null default now()
);

create table if not exists public.state (
  owner    uuid primary key default auth.uid() references auth.users on delete cascade,
  jobs     jsonb not null default '[]',
  entries  jsonb not null default '[]',
  status   jsonb not null default '{}',
  seen_at  timestamptz not null default now()
);
-- Hash of jobs+entries+status: the phone re-downloads them only when this changes.
alter table public.state add column if not exists digest text not null default '';

-- The laptop checks every kind against its own list and refuses unknown ones, so the database only
-- bounds the size; new features then need no schema change.
alter table public.actions drop constraint if exists actions_kind_check;
alter table public.actions add constraint actions_kind_check check (kind ~ '^[a-z_]{1,40}$');

alter table public.actions enable row level security;
alter table public.state enable row level security;

drop policy if exists "owner only" on public.actions;
create policy "owner only" on public.actions for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

drop policy if exists "owner only" on public.state;
create policy "owner only" on public.state for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- Logged-out visitors get nothing at all; logged-in users only what the policies above allow.
revoke all on public.actions, public.state from anon;
grant select, insert, update, delete on public.actions, public.state to authenticated;

-- frames: screenshots the laptop keeps from reels.
-- uploads: screenshots and voice notes the phone sends in (20 MB max); the laptop deletes each after reading it.
insert into storage.buckets (id, name, public) values ('frames', 'frames', false)
  on conflict (id) do nothing;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('uploads', 'uploads', false, 20971520,
          array['image/jpeg', 'image/png', 'image/webp', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg'])
  on conflict (id) do update set file_size_limit = excluded.file_size_limit,
                                 allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "gleaner frames owner" on storage.objects;
create policy "gleaner frames owner" on storage.objects for all to authenticated
  using (bucket_id in ('frames', 'uploads') and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id in ('frames', 'uploads') and (storage.foldername(name))[1] = (select auth.uid())::text);

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
