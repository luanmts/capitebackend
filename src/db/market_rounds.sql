-- Estrutura mínima Fase 1 para rounds da Rodovia 5min
create table if not exists public.market_rounds (
  id text primary key,
  template_slug text not null,
  starts_at timestamptz not null,
  bets_close_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null check (status in ('live', 'betting_closed', 'ended', 'settled', 'cancelled')),
  threshold integer not null default 145,
  current_count integer not null default 0,
  final_count integer null,
  result text null check (result in ('yes', 'no', 'cancelled')),
  cancel_reason text null,
  source_health text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_market_rounds_template_slug_starts_at
  on public.market_rounds (template_slug, starts_at desc);

create index if not exists idx_market_rounds_status
  on public.market_rounds (status);

-- Trigger simples para updated_at
create or replace function public.set_updated_at_market_rounds()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_market_rounds_updated_at on public.market_rounds;
create trigger trg_market_rounds_updated_at
before update on public.market_rounds
for each row execute function public.set_updated_at_market_rounds();
