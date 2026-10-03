-- =====================================================================
-- Per-user Garmin links for cloud sync (multi-user).
-- Passwords and session tokens live encrypted in Supabase Vault; this table
-- only stores the Vault secret ids + sync status. Clients can read their own
-- status but never the secrets.
-- =====================================================================
create table if not exists public.garmin_links (
  user_id             uuid primary key references auth.users (id) on delete cascade,
  garmin_email        text not null,
  password_secret_id  uuid,
  token_secret_id     uuid,
  status              text not null default 'pending'
                        check (status in ('pending','ok','auth_error','mfa_required','error')),
  last_error          text,
  last_sync_at        timestamptz,
  sync_requested_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger garmin_links_updated_at
  before update on public.garmin_links
  for each row execute function public.set_updated_at();

alter table public.garmin_links enable row level security;
revoke all on public.garmin_links from anon, authenticated;
grant select (user_id, garmin_email, status, last_error, last_sync_at, sync_requested_at)
  on public.garmin_links to authenticated;
create policy "garmin_links_select_own" on public.garmin_links
  for select to authenticated using ((select auth.uid()) = user_id);

-- ---------- Client RPCs (write-only for secrets) ----------
create or replace function public.set_garmin_credentials(p_email text, p_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_link public.garmin_links;
  v_sid  uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if coalesce(trim(p_email), '') = '' or coalesce(p_password, '') = '' then
    raise exception 'email and password are required';
  end if;

  select * into v_link from public.garmin_links where user_id = v_uid;

  if v_link.password_secret_id is not null then
    perform vault.update_secret(v_link.password_secret_id, p_password);
    v_sid := v_link.password_secret_id;
  else
    v_sid := vault.create_secret(p_password, 'garmin_pw_' || v_uid::text, 'Garmin Connect password');
  end if;

  -- New credentials invalidate any stored session tokens.
  if v_link.token_secret_id is not null then
    delete from vault.secrets where id = v_link.token_secret_id;
  end if;

  insert into public.garmin_links (user_id, garmin_email, password_secret_id, token_secret_id, status, last_error, sync_requested_at)
  values (v_uid, trim(p_email), v_sid, null, 'pending', null, now())
  on conflict (user_id) do update
    set garmin_email = excluded.garmin_email,
        password_secret_id = excluded.password_secret_id,
        token_secret_id = null,
        status = 'pending',
        last_error = null,
        sync_requested_at = now();
end;
$$;

create or replace function public.remove_garmin_credentials()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_link public.garmin_links;
begin
  select * into v_link from public.garmin_links where user_id = auth.uid();
  if not found then return; end if;
  delete from vault.secrets where id in (v_link.password_secret_id, v_link.token_secret_id);
  delete from public.garmin_links where user_id = auth.uid();
  update public.profiles set garmin_connected = false where id = auth.uid();
end;
$$;

create or replace function public.request_garmin_sync()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.garmin_links set sync_requested_at = now() where user_id = auth.uid();
$$;

revoke execute on function public.set_garmin_credentials(text, text) from public, anon;
revoke execute on function public.remove_garmin_credentials()       from public, anon;
revoke execute on function public.request_garmin_sync()             from public, anon;
grant  execute on function public.set_garmin_credentials(text, text) to authenticated;
grant  execute on function public.remove_garmin_credentials()       to authenticated;
grant  execute on function public.request_garmin_sync()             to authenticated;

-- ---------- Sync-worker RPCs (service_role only) ----------
create or replace function public.garmin_sync_targets()
returns table (user_id uuid, garmin_email text, password text, tokens text, status text, sync_requested_at timestamptz, last_sync_at timestamptz)
language sql
security definer
set search_path = ''
as $$
  select l.user_id, l.garmin_email, pw.decrypted_secret, tk.decrypted_secret, l.status, l.sync_requested_at, l.last_sync_at
  from public.garmin_links l
  left join vault.decrypted_secrets pw on pw.id = l.password_secret_id
  left join vault.decrypted_secrets tk on tk.id = l.token_secret_id;
$$;

create or replace function public.save_garmin_tokens(p_user uuid, p_tokens text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tid uuid;
begin
  select token_secret_id into v_tid from public.garmin_links where user_id = p_user;
  if v_tid is not null then
    perform vault.update_secret(v_tid, p_tokens);
  else
    v_tid := vault.create_secret(p_tokens, 'garmin_tokens_' || p_user::text, 'Garmin session tokens');
    update public.garmin_links set token_secret_id = v_tid where user_id = p_user;
  end if;
end;
$$;

revoke execute on function public.garmin_sync_targets()           from public, anon, authenticated;
revoke execute on function public.save_garmin_tokens(uuid, text)  from public, anon, authenticated;
grant  execute on function public.garmin_sync_targets()           to service_role;
grant  execute on function public.save_garmin_tokens(uuid, text)  to service_role;

-- Races: let users manage their own goal races from the app (policy already exists).
