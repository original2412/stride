-- =====================================================================
-- AI Running Coach — סכמת בסיס נתונים ראשונית
-- =====================================================================

-- ---------- פונקציית עזר: עדכון updated_at ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =====================================================================
-- profiles — פרופיל רץ (1:1 מול auth.users)
-- =====================================================================
create table public.profiles (
  id                      uuid primary key references auth.users (id) on delete cascade,
  display_name            text,
  hr_max                  smallint not null default 185 check (hr_max between 120 and 230),
  hr_rest                 smallint not null default 55  check (hr_rest between 30 and 100),
  weekly_km_target        numeric(5,1),
  garmin_connected        boolean not null default false,
  garmin_last_sync_at     timestamptz,
  garmin_last_sync_status text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- יצירת פרופיל אוטומטית בהרשמה
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- activities — ריצות שסונכרנו מ-Garmin Connect
-- =====================================================================
create table public.activities (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references auth.users (id) on delete cascade,
  garmin_activity_id      bigint,
  start_time              timestamptz not null,
  activity_type           text not null default 'running',
  name                    text,
  distance_m              numeric(9,1)  not null check (distance_m >= 0),
  duration_s              integer       not null check (duration_s >= 0),
  moving_duration_s       integer,
  avg_pace_sec_per_km     numeric(6,1),           -- קצב ממוצע (שניות לק"מ)
  gap_sec_per_km          numeric(6,1),           -- Grade Adjusted Pace
  avg_hr                  smallint,
  max_hr                  smallint,
  elevation_gain_m        numeric(7,1),
  elevation_loss_m        numeric(7,1),
  avg_cadence_spm         smallint,
  aerobic_training_effect numeric(3,1),
  training_load           numeric(6,1),
  splits                  jsonb not null default '[]'::jsonb,  -- הקפות/ספליטים מנורמלים
  raw                     jsonb,                               -- ה-payload המקורי מ-Garmin
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (user_id, garmin_activity_id)
);

create index activities_user_start_idx on public.activities (user_id, start_time desc);

create trigger activities_updated_at
  before update on public.activities
  for each row execute function public.set_updated_at();

-- =====================================================================
-- coaching_plans — אימון יומי שנקבע (שורה אחת ליום לכל משתמש)
-- =====================================================================
create table public.coaching_plans (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users (id) on delete cascade,
  plan_date                date not null,
  workout_type             text not null check (workout_type in
                             ('easy','recovery','long','tempo','threshold','intervals','progression','rest','race')),
  title                    text not null,
  description              text,
  duration_min             smallint check (duration_min between 0 and 400),
  distance_km              numeric(5,2),
  target_pace_fast_sec_km  smallint,   -- הגבול המהיר של טווח הקצב
  target_pace_slow_sec_km  smallint,   -- הגבול האיטי של טווח הקצב
  hr_zone                  smallint check (hr_zone between 1 and 5),
  rationale                text not null,
  adaptation_note          text,       -- למשל: "הקצב הואט ב-15 שנ' עקב עייפות"
  adjustment_sec           smallint not null default 0,
  status                   text not null default 'planned' check (status in ('planned','completed','skipped')),
  source                   text not null default 'gemini'  check (source in ('gemini','manual')),
  model                    text,
  completed_activity_id    uuid references public.activities (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (user_id, plan_date),
  check (target_pace_fast_sec_km is null or target_pace_slow_sec_km is null
         or target_pace_fast_sec_km <= target_pace_slow_sec_km)
);

create index coaching_plans_user_date_idx on public.coaching_plans (user_id, plan_date);

create trigger coaching_plans_updated_at
  before update on public.coaching_plans
  for each row execute function public.set_updated_at();

-- =====================================================================
-- coach_assessments — הערכת מוכנות/עייפות שמחזיר Gemini בכל כיול
-- =====================================================================
create table public.coach_assessments (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  assessed_at         timestamptz not null default now(),
  fatigue_level       text not null check (fatigue_level in ('low','moderate','high')),
  readiness_score     smallint not null check (readiness_score between 0 and 100),
  marathon_shape_pct  smallint check (marathon_shape_pct between 0 and 100),
  acwr                numeric(4,2),        -- Acute:Chronic Workload Ratio שחושב בצד השרת
  summary             text not null,
  model               text
);

create index coach_assessments_user_idx on public.coach_assessments (user_id, assessed_at desc);

-- =====================================================================
-- races — מרוצי יעד
-- =====================================================================
create table public.races (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  name           text not null,
  race_date      date not null,
  distance_km    numeric(6,3) not null,
  target_time_s  integer,
  priority       text not null default 'A' check (priority in ('A','B','C')),
  created_at     timestamptz not null default now()
);

create index races_user_date_idx on public.races (user_id, race_date);

-- =====================================================================
-- user_secrets — מפתח Gemini לכל משתמש.
-- אין גישה ישירה ללקוח: כתיבה דרך RPC, קריאה רק ע"י service role (Edge Function).
-- =====================================================================
create table public.user_secrets (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  gemini_api_key  text,
  updated_at      timestamptz not null default now()
);

revoke all on public.user_secrets from anon, authenticated;

create or replace function public.set_gemini_api_key(p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  insert into public.user_secrets (user_id, gemini_api_key, updated_at)
  values (auth.uid(), nullif(trim(p_key), ''), now())
  on conflict (user_id) do update
    set gemini_api_key = excluded.gemini_api_key,
        updated_at     = now();
end;
$$;

create or replace function public.has_gemini_api_key()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.user_secrets
    where user_id = auth.uid() and gemini_api_key is not null
  );
$$;

revoke execute on function public.set_gemini_api_key(text) from public, anon;
revoke execute on function public.has_gemini_api_key()    from public, anon;
grant  execute on function public.set_gemini_api_key(text) to authenticated;
grant  execute on function public.has_gemini_api_key()    to authenticated;

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.profiles          enable row level security;
alter table public.activities        enable row level security;
alter table public.coaching_plans    enable row level security;
alter table public.coach_assessments enable row level security;
alter table public.races             enable row level security;
alter table public.user_secrets      enable row level security;

-- profiles: קריאה ועדכון של עצמי
create policy "profiles_select_own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- activities: הלקוח קורא בלבד. כתיבה מתבצעת ע"י שירות הסנכרון (service role).
create policy "activities_select_own" on public.activities
  for select to authenticated using ((select auth.uid()) = user_id);

-- coaching_plans: קריאה + עדכון סטטוס ע"י המשתמש. יצירה ע"י ה-Edge Function.
create policy "plans_select_own" on public.coaching_plans
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "plans_update_own" on public.coaching_plans
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- coach_assessments: קריאה בלבד
create policy "assessments_select_own" on public.coach_assessments
  for select to authenticated using ((select auth.uid()) = user_id);

-- races: CRUD מלא על המרוצים שלי
create policy "races_all_own" on public.races
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- user_secrets: אין policies => אין גישה ל-anon/authenticated. רק RPC ו-service role.
