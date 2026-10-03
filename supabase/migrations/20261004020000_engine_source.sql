-- Plans are now produced by the deterministic research-based engine.
alter table public.coaching_plans drop constraint if exists coaching_plans_source_check;
alter table public.coaching_plans
  add constraint coaching_plans_source_check check (source in ('gemini', 'manual', 'engine'));
