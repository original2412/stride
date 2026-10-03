-- Research-based fitness model outputs (VDOT, Daniels paces, periodization).
alter table public.coach_assessments
  add column if not exists vdot              numeric(4,1),
  add column if not exists vdot_source       text,
  add column if not exists training_paces    jsonb,
  add column if not exists race_predictions  jsonb,
  add column if not exists phase             text,
  add column if not exists weekly_km_target  numeric(5,1);
