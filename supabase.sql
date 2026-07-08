-- Run dit in je Supabase project → SQL Editor.

create table if not exists public.leads (
  id          bigint generated always as identity primary key,
  created_at  timestamptz default now(),
  adres       text,
  pand_id     text,
  gebruik     text,
  bestemming  text,
  bouwjaar    int,
  lat         double precision,
  lng         double precision,
  status      text default 'te benaderen',
  notitie     text
);

alter table public.leads enable row level security;

-- Interne tool: anon-rol mag lezen/schrijven. Wil je het dichttimmeren,
-- vervang dit door auth-gebaseerde policies.
drop policy if exists "leads_anon_all" on public.leads;
create policy "leads_anon_all" on public.leads
  for all to anon using (true) with check (true);

-- ===== Gemeente-scan (server-side bulk) =====
create table if not exists public.scan_jobs (
  id          bigint generated always as identity primary key,
  created_at  timestamptz default now(),
  gemeente    text,
  status      text default 'gestart',
  total_cells int default 0,
  done_cells  int default 0,
  hits        int default 0,
  functies    text,
  keywords    text
);
create table if not exists public.scan_resultaten (
  id          bigint generated always as identity primary key,
  created_at  timestamptz default now(),
  job_id      bigint,
  pand_id     text,
  gebruik     text,
  bestemming  text,
  lat         double precision,
  lng         double precision
);
alter table public.scan_jobs enable row level security;
alter table public.scan_resultaten enable row level security;
drop policy if exists "scan_jobs_anon" on public.scan_jobs;
create policy "scan_jobs_anon" on public.scan_jobs for all to anon using (true) with check (true);
drop policy if exists "scan_res_anon" on public.scan_resultaten;
create policy "scan_res_anon" on public.scan_resultaten for all to anon using (true) with check (true);
