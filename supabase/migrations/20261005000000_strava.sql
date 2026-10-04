-- =====================================================================
-- Strava (official OAuth) as the activity source. Garmin auto-uploads to Strava.
-- OAuth tokens live in Supabase Vault; only Edge Functions (service role) read them.
-- =====================================================================

alter table public.activities add column if not exists source text not null default 'garmin';
alter table public.activities add column if not exists strava_activity_id bigint;
create unique index if not exists activities_user_strava_uidx on public.activities (user_id, strava_activity_id);

create table if not exists public.strava_links (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  athlete_id       bigint,
  athlete_name     text,
  token_secret_id  uuid,
  oauth_state      text,
  status           text not null default 'pending' check (status in ('pending','ok','error','revoked')),
  last_error       text,
  last_sync_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

drop trigger if exists strava_links_updated_at on public.strava_links;
create trigger strava_links_updated_at
  before update on public.strava_links
  for each row execute function public.set_updated_at();

alter table public.strava_links enable row level security;
revoke all on public.strava_links from anon, authenticated;
grant select (user_id, athlete_id, athlete_name, status, last_error, last_sync_at) on public.strava_links to authenticated;
drop policy if exists "strava_links_select_own" on public.strava_links;
create policy "strava_links_select_own" on public.strava_links
  for select to authenticated using ((select auth.uid()) = user_id);

-- ---------- service-role only: token storage in Vault ----------
create or replace function public.strava_save_tokens(p_user uuid, p_tokens text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tid uuid;
begin
  select token_secret_id into v_tid from public.strava_links where user_id = p_user;
  if v_tid is not null then
    perform vault.update_secret(v_tid, p_tokens);
  else
    v_tid := vault.create_secret(p_tokens, 'strava_tokens_' || p_user::text, 'Strava OAuth tokens');
    update public.strava_links set token_secret_id = v_tid where user_id = p_user;
  end if;
end;
$$;

create or replace function public.strava_get_tokens(p_user uuid)
returns text
language sql
security definer
set search_path = ''
stable
as $$
  select d.decrypted_secret
  from public.strava_links l
  join vault.decrypted_secrets d on d.id = l.token_secret_id
  where l.user_id = p_user;
$$;

create or replace function public.strava_remove(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tid uuid;
begin
  select token_secret_id into v_tid from public.strava_links where user_id = p_user;
  if v_tid is not null then delete from vault.secrets where id = v_tid; end if;
  delete from public.strava_links where user_id = p_user;
end;
$$;

create or replace function public.strava_sync_users()
returns table (user_id uuid, last_sync_at timestamptz)
language sql
security definer
set search_path = ''
stable
as $$
  select user_id, last_sync_at from public.strava_links
  where token_secret_id is not null and status in ('ok', 'error');
$$;

revoke execute on function public.strava_save_tokens(uuid, text) from public, anon, authenticated;
revoke execute on function public.strava_get_tokens(uuid)        from public, anon, authenticated;
revoke execute on function public.strava_remove(uuid)            from public, anon, authenticated;
revoke execute on function public.strava_sync_users()            from public, anon, authenticated;
grant  execute on function public.strava_save_tokens(uuid, text) to service_role;
grant  execute on function public.strava_get_tokens(uuid)        to service_role;
grant  execute on function public.strava_remove(uuid)            to service_role;
grant  execute on function public.strava_sync_users()            to service_role;
