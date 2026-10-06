create table public.profiles (id uuid primary key, full_name text, created_at timestamptz not null default now());
grant select, insert, update on public.profiles to authenticated; grant all on public.profiles to service_role;
alter table public.profiles enable row level security;
create policy "firm reads profiles" on public.profiles for select to authenticated using (true);
create policy "own profile insert" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "own profile update" on public.profiles for update to authenticated using (auth.uid() = id);
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin insert into public.profiles(id, full_name) values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1))); return new; end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create table public.matters (id uuid primary key default gen_random_uuid(), number text, title text not null, client text, practice_area text not null default 'Corporate', status text not null default 'Active', summary text, responsible text, opened_on date default current_date, created_at timestamptz not null default now());
create table public.contacts (id uuid primary key default gen_random_uuid(), name text not null, organization text, role text, email text, phone text, created_at timestamptz not null default now());
create table public.matter_contacts (id uuid primary key default gen_random_uuid(), matter_id uuid not null references public.matters(id) on delete cascade, contact_id uuid not null references public.contacts(id) on delete cascade, relationship text);
create table public.tasks (id uuid primary key default gen_random_uuid(), matter_id uuid not null references public.matters(id) on delete cascade, title text not null, assignee text, due_on date, done boolean not null default false, source text not null default 'manual', created_at timestamptz not null default now());
create table public.deadlines (id uuid primary key default gen_random_uuid(), matter_id uuid not null references public.matters(id) on delete cascade, title text not null, due_on date not null, kind text default 'Deadline', source text not null default 'manual', created_at timestamptz not null default now());
create table public.notes (id uuid primary key default gen_random_uuid(), matter_id uuid not null references public.matters(id) on delete cascade, title text, body text not null, kind text not null default 'note', created_at timestamptz not null default now());
create table public.files (id uuid primary key default gen_random_uuid(), matter_id uuid references public.matters(id) on delete cascade, name text not null, path text not null, size bigint, extracted_text text, created_at timestamptz not null default now());
create table public.templates (id uuid primary key default gen_random_uuid(), name text not null, practice_area text, body text not null, path text, created_at timestamptz not null default now());
create table public.drafts (id uuid primary key default gen_random_uuid(), matter_id uuid not null references public.matters(id) on delete cascade, template_id uuid references public.templates(id) on delete set null, title text not null, body text not null, status text not null default 'Draft', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.closing_items (id uuid primary key default gen_random_uuid(), matter_id uuid not null references public.matters(id) on delete cascade, deliverable text not null, responsible text, status text not null default 'Open', due_on date, notes text, position int not null default 0, created_at timestamptz not null default now());
create table public.ai_runs (id uuid primary key default gen_random_uuid(), matter_id uuid references public.matters(id) on delete set null, user_id uuid, kind text not null, effort text not null, input_tokens int, output_tokens int, created_at timestamptz not null default now());
create table public.activity (id uuid primary key default gen_random_uuid(), matter_id uuid references public.matters(id) on delete cascade, actor text, message text not null, created_at timestamptz not null default now());

do $$ declare t text; begin
 foreach t in array array['matters','contacts','matter_contacts','tasks','deadlines','notes','files','templates','drafts','closing_items','ai_runs','activity'] loop
  execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  execute format('grant all on public.%I to service_role', t);
  execute format('alter table public.%I enable row level security', t);
  execute format('create policy "firm access" on public.%I for all to authenticated using (true) with check (true)', t);
 end loop; end $$;

create policy "firm files read" on storage.objects for select to authenticated using (bucket_id = 'matter-files');
create policy "firm files write" on storage.objects for insert to authenticated with check (bucket_id = 'matter-files');
create policy "firm files delete" on storage.objects for delete to authenticated using (bucket_id = 'matter-files');

insert into public.matters (id, number, title, client, practice_area, status, summary, responsible, opened_on) values
('11111111-0000-0000-0000-000000000001','2026-014','Acquisition of Lakeshore Dental Group','Brightwater Holdings LLC','Corporate','Active','Asset purchase of a three-location dental practice. LOI signed; diligence underway.','F. Mirza','2026-09-02'),
('11111111-0000-0000-0000-000000000002','2026-019','1420 W. Fulton Purchase','Kessler Family Trust','Real Estate','Active','Commercial building purchase. Title commitment and survey pending.','F. Mirza','2026-09-15'),
('11111111-0000-0000-0000-000000000003','2026-021','Okafor Estate Plan','Daniel & Grace Okafor','Estate Planning','Intake','Revocable trust, pour-over wills, POAs. Questionnaire sent.','F. Mirza','2026-09-28'),
('11111111-0000-0000-0000-000000000004','2026-008','Series Seed Financing','Northpaw Robotics, Inc.','Finance','Closing','$3.2M Series Seed preferred round led by Corridor Ventures.','F. Mirza','2026-07-20');
insert into public.tasks (matter_id,title,assignee,due_on) values
('11111111-0000-0000-0000-000000000001','Send diligence request list to seller counsel','Associate','2026-10-08'),
('11111111-0000-0000-0000-000000000001','Review landlord consent requirements in leases','F. Mirza','2026-10-12'),
('11111111-0000-0000-0000-000000000002','Order zoning report','Staff','2026-10-09'),
('11111111-0000-0000-0000-000000000003','Follow up on questionnaire','Staff','2026-10-07'),
('11111111-0000-0000-0000-000000000004','Collect investor signature pages','Staff','2026-10-10');
insert into public.deadlines (matter_id,title,due_on,kind) values
('11111111-0000-0000-0000-000000000001','Exclusivity period ends','2026-11-01','Contract'),
('11111111-0000-0000-0000-000000000002','Inspection period expires','2026-10-20','Contract'),
('11111111-0000-0000-0000-000000000002','Closing date','2026-11-14','Closing'),
('11111111-0000-0000-0000-000000000004','Target closing','2026-10-15','Closing');
insert into public.closing_items (matter_id,deliverable,responsible,status,due_on,position) values
('11111111-0000-0000-0000-000000000004','Amended & Restated Certificate of Incorporation','Company counsel','Final',null,1),
('11111111-0000-0000-0000-000000000004','Stock Purchase Agreement','Company counsel','Agreed form',null,2),
('11111111-0000-0000-0000-000000000004','Investors'' Rights Agreement','Investor counsel','In review',null,3),
('11111111-0000-0000-0000-000000000004','Board and stockholder consents','Company counsel','Open','2026-10-12',4),
('11111111-0000-0000-0000-000000000004','Wire instructions confirmed','Company','Open','2026-10-14',5);
insert into public.contacts (id,name,organization,role,email) values
('22222222-0000-0000-0000-000000000001','Ana Brightwater','Brightwater Holdings LLC','Client','ana@brightwater.example'),
('22222222-0000-0000-0000-000000000002','Marcus Lee','Lee & Partners','Seller counsel','mlee@leepartners.example'),
('22222222-0000-0000-0000-000000000003','Priya Natarajan','Northpaw Robotics, Inc.','CEO','priya@northpaw.example');
insert into public.matter_contacts (matter_id,contact_id,relationship) values
('11111111-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000001','Client'),
('11111111-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002','Opposing counsel'),
('11111111-0000-0000-0000-000000000004','22222222-0000-0000-0000-000000000003','Client');
insert into public.activity (matter_id, actor, message) values
('11111111-0000-0000-0000-000000000001','F. Mirza','Matter opened'),
('11111111-0000-0000-0000-000000000004','F. Mirza','Closing checklist updated');