alter table public.matter_properties
  add column if not exists flags jsonb not null default '{}'::jsonb,
  add column if not exists attorney_review_days integer not null default 5,
  add column if not exists inspection_days integer not null default 5,
  add column if not exists earnest_days integer,
  add column if not exists prior_year_unpaid numeric;