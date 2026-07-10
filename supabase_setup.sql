create table if not exists public.sales_dashboard_state (
  id text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.sales_dashboard_state enable row level security;

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.sales_dashboard_state to anon;
grant select, insert, update on public.sales_dashboard_state to authenticated;

drop policy if exists "sales_dashboard_select" on public.sales_dashboard_state;
drop policy if exists "sales_dashboard_insert" on public.sales_dashboard_state;
drop policy if exists "sales_dashboard_update" on public.sales_dashboard_state;

create policy "sales_dashboard_select" on public.sales_dashboard_state
for select to anon, authenticated
using (id = 'yuanpeng_a1');

create policy "sales_dashboard_insert" on public.sales_dashboard_state
for insert to anon, authenticated
with check (id = 'yuanpeng_a1');

create policy "sales_dashboard_update" on public.sales_dashboard_state
for update to anon, authenticated
using (id = 'yuanpeng_a1')
with check (id = 'yuanpeng_a1');

do $$
begin
  alter publication supabase_realtime add table public.sales_dashboard_state;
exception
  when duplicate_object then null;
end $$;
