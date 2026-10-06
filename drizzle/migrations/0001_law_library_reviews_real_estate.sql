-- Law library: authoritative sources fetched from public law services, full-text indexed.
create table public.authorities (
  id uuid primary key default gen_random_uuid(),
  key text unique,
  jurisdiction text not null default 'federal',
  kind text not null default 'statute',
  source text not null default 'url',
  citation text not null,
  title text not null,
  topics text[] not null default '{}',
  url text not null,
  fetch_url text,
  storage_path text,
  mime text,
  text text,
  text_chars integer not null default 0,
  summary text,
  version_label text,
  fetched_at timestamptz,
  checked_at timestamptz,
  status text not null default 'pending',
  error text,
  content_hash text,
  is_catalog boolean not null default true,
  added_by uuid,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.authorities to authenticated;
grant all on public.authorities to service_role;
alter table public.authorities enable row level security;
create policy "firm access" on public.authorities for all to authenticated using (true) with check (true);
create index authorities_topics_idx on public.authorities using gin (topics);
create index authorities_status_idx on public.authorities (status);
create index authorities_jurisdiction_idx on public.authorities (jurisdiction);

create table public.authority_chunks (
  id bigint generated always as identity primary key,
  authority_id uuid not null references public.authorities(id) on delete cascade,
  idx integer not null,
  heading text,
  body text not null,
  tsv tsvector generated always as (to_tsvector('english', coalesce(heading, '') || ' ' || body)) stored,
  unique (authority_id, idx)
);
grant select, insert, update, delete on public.authority_chunks to authenticated;
grant all on public.authority_chunks to service_role;
alter table public.authority_chunks enable row level security;
create policy "firm access" on public.authority_chunks for all to authenticated using (true) with check (true);
create index authority_chunks_tsv_idx on public.authority_chunks using gin (tsv);
create index authority_chunks_authority_idx on public.authority_chunks (authority_id, idx);

-- Federal Register (and similar) activity touching a stored authority.
create table public.authority_updates (
  id uuid primary key default gen_random_uuid(),
  authority_id uuid not null references public.authorities(id) on delete cascade,
  document_number text not null,
  title text not null,
  doc_type text,
  agency text,
  publication_date date,
  effective_on date,
  html_url text,
  pdf_url text,
  abstract text,
  created_at timestamptz not null default now(),
  unique (authority_id, document_number)
);
grant select, insert, update, delete on public.authority_updates to authenticated;
grant all on public.authority_updates to service_role;
alter table public.authority_updates enable row level security;
create policy "firm access" on public.authority_updates for all to authenticated using (true) with check (true);

-- Sources pinned to a matter.
create table public.matter_authorities (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  authority_id uuid not null references public.authorities(id) on delete cascade,
  note text,
  created_at timestamptz not null default now(),
  unique (matter_id, authority_id)
);
grant select, insert, update, delete on public.matter_authorities to authenticated;
grant all on public.matter_authorities to service_role;
alter table public.matter_authorities enable row level security;
create policy "firm access" on public.matter_authorities for all to authenticated using (true) with check (true);
create index matter_authorities_matter_idx on public.matter_authorities (matter_id);

-- Persisted AI reviews (tax flags, title/survey review) so results survive reloads and can be revisited.
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.matters(id) on delete cascade,
  kind text not null,
  title text not null,
  effort text not null default 'normal',
  input_tokens integer,
  output_tokens integer,
  result jsonb not null default '{}'::jsonb,
  decisions jsonb not null default '{}'::jsonb,
  file_ids uuid[] not null default '{}',
  authority_ids uuid[] not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on public.reviews to authenticated;
grant all on public.reviews to service_role;
alter table public.reviews enable row level security;
create policy "firm access" on public.reviews for all to authenticated using (true) with check (true);
create index reviews_matter_idx on public.reviews (matter_id, kind, created_at desc);

-- Real estate deal record (one per matter).
create table public.matter_properties (
  matter_id uuid primary key references public.matters(id) on delete cascade,
  side text not null default 'Buyer',
  address text,
  city text,
  county text not null default 'Cook',
  state text not null default 'IL',
  zip text,
  pin text,
  property_type text not null default 'Residential (1-4 units)',
  year_built integer,
  in_chicago boolean not null default false,
  purchase_price numeric,
  earnest_money numeric,
  loan_amount numeric,
  acceptance_date date,
  closing_date date,
  title_company text,
  lender text,
  survey_date date,
  last_tax_bill numeric,
  tax_year integer,
  proration_pct numeric not null default 105,
  notes text,
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.matter_properties to authenticated;
grant all on public.matter_properties to service_role;
alter table public.matter_properties enable row level security;
create policy "firm access" on public.matter_properties for all to authenticated using (true) with check (true);

-- Files can be tagged by document type (title commitment, survey, contract...).
alter table public.files add column if not exists doc_type text;

-- updated_at maintenance
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger authorities_touch before update on public.authorities for each row execute function public.touch_updated_at();
create trigger matter_properties_touch before update on public.matter_properties for each row execute function public.touch_updated_at();

-- Ranked full-text search across stored authority text (used by the Library UI and by AI grounding).
create or replace function public.search_authorities(
  q text,
  topic text default null,
  jur text default null,
  ids uuid[] default null,
  lim integer default 20
)
returns table (
  authority_id uuid,
  chunk_idx integer,
  heading text,
  snippet text,
  body text,
  rank real,
  citation text,
  title text,
  jurisdiction text,
  url text,
  version_label text
)
language sql stable security invoker set search_path = public as $$
  select c.authority_id, c.idx, c.heading,
         ts_headline('english', c.body, websearch_to_tsquery('english', q),
           'MaxWords=45, MinWords=20, StartSel=[[, StopSel=]]') as snippet,
         c.body,
         ts_rank_cd(c.tsv, websearch_to_tsquery('english', q)) as rank,
         a.citation, a.title, a.jurisdiction, a.url, a.version_label
  from public.authority_chunks c
  join public.authorities a on a.id = c.authority_id
  where a.status = 'ready'
    and c.tsv @@ websearch_to_tsquery('english', q)
    and (topic is null or topic = any(a.topics))
    and (jur is null or a.jurisdiction = jur)
    and (ids is null or a.id = any(ids))
  order by rank desc, c.authority_id, c.idx
  limit greatest(1, least(lim, 60));
$$;
grant execute on function public.search_authorities(text, text, text, uuid[], integer) to authenticated;
grant execute on function public.search_authorities(text, text, text, uuid[], integer) to service_role;

-- Storage policies for the private law-library bucket (bucket created separately).
create policy "firm library read" on storage.objects for select to authenticated using (bucket_id = 'law-library');
create policy "firm library write" on storage.objects for insert to authenticated with check (bucket_id = 'law-library');
create policy "firm library update" on storage.objects for update to authenticated using (bucket_id = 'law-library');
create policy "firm library delete" on storage.objects for delete to authenticated using (bucket_id = 'law-library');