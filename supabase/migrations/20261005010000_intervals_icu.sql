-- =====================================================================
-- intervals.icu as the activity source (official Garmin partner, free API).
-- Each user stores a personal API key; it lives encrypted in Supabase Vault.
-- =====================================================================

alter table public.activities add column if not exists icu_activity_id text;
create unique index if not exists activities_user_icu_uidx on public.activities (user_id, icu_activity_id);

create table if not exists public.icu_links (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  athlete_id     text not null default '0',
  key_secret_id  uuid,
  status         text not null default 'pending' check (status in ('pending','ok','error')),
  last_error     text,
  last_sync_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists icu_links_updated_at on public.icu_links;
create trigger icu_links_updated_at
  before update on public.icu_links
  for each row execute function public.set_updated_at();

alter table public.icu_links enable row level security;
revoke all on public.icu_links from anon, authenticated;
grant select (user_id, athlete_id, status, last_error, last_sync_at) on public.icu_links to authenticated;
drop policy if exists "icu_links_select_own" on public.icu_links;
create policy "icu_links_select_own" on public.icu_links
  for select to authenticated using ((select auth.uid()) = user_id);

-- ---------- client RPCs (write-only for the key) ----------
create or replace function public.set_icu_credentials(p_athlete text, p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_sid uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if coalesce(trim(p_key), '') = '' then raise exception 'API key is required'; end if;
  select key_secret_id into v_sid from public.icu_links where user_id = v_uid;
  if v_sid is not null then
    perform vault.update_secret(v_sid, trim(p_key));
  else
    v_sid := vault.create_secret(trim(p_key), 'icu_key_' || v_uid::text, 'intervals.icu API key');
  end if;
  insert into public.icu_links (user_id, athlete_id, key_secret_id, status, last_error)
  values (v_uid, coalesce(nullif(trim(p_athlete), ''), '0'), v_sid, 'pending', null)
  on conflict (user_id) do update
    set athlete_id = excluded.athlete_id, key_secret_id = excluded.key_secret_id, status = 'pending', last_error = null;
end;
$$;

create or replace function public.remove_icu_credentials()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sid uuid;
begin
  select key_secret_id into v_sid from public.icu_links where user_id = auth.uid();
  if v_sid is not null then delete from vault.secrets where id = v_sid; end if;
  delete from public.icu_links where user_id = auth.uid();
end;
$$;

revoke execute on function public.set_icu_credentials(text, text) from public, anon;
revoke execute on function public.remove_icu_credentials()        from public, anon;
grant  execute on function public.set_icu_credentials(text, text) to authenticated;
grant  execute on function public.remove_icu_credentials()        to authenticated;

-- ---------- service-role only ----------
create or replace function public.icu_get_credentials(p_user uuid)
returns table (athlete_id text, api_key text, last_sync_at timestamptz)
language sql
security definer
set search_path = ''
stable
as $$
  select l.athlete_id, d.decrypted_secret, l.last_sync_at
  from public.icu_links l
  join vault.decrypted_secrets d on d.id = l.key_secret_id
  where l.user_id = p_user;
$$;

create or replace function public.icu_sync_users()
returns table (user_id uuid)
language sql
security definer
set search_path = ''
stable
as $$
  select user_id from public.icu_links where key_secret_id is not null;
$$;

revoke execute on function public.icu_get_credentials(uuid) from public, anon, authenticated;
revoke execute on function public.icu_sync_users()          from public, anon, authenticated;
grant  execute on function public.icu_get_credentials(uuid) to service_role;
grant  execute on function public.icu_sync_users()          to service_role;
