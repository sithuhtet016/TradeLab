create extension if not exists pgcrypto;

create table if not exists public.portfolios (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance_usd numeric(20,2) not null default 10000 check (balance_usd >= 0),
  btc_quantity numeric(20,8) not null default 0 check (btc_quantity >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('BUY','SELL')),
  price numeric(20,8) not null check (price > 0),
  quantity numeric(20,8) not null check (quantity > 0),
  total_value numeric(20,2) not null check (total_value > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_trades_user_created_at
  on public.trades (user_id, created_at desc);

alter table public.portfolios enable row level security;
alter table public.trades enable row level security;

drop policy if exists "portfolio_select_own" on public.portfolios;
create policy "portfolio_select_own"
  on public.portfolios for select
  using (auth.uid() = user_id);

drop policy if exists "portfolio_insert_own" on public.portfolios;
create policy "portfolio_insert_own"
  on public.portfolios for insert
  with check (auth.uid() = user_id);

drop policy if exists "portfolio_update_own" on public.portfolios;
create policy "portfolio_update_own"
  on public.portfolios for update
  using (auth.uid() = user_id);

drop policy if exists "trades_select_own" on public.trades;
create policy "trades_select_own"
  on public.trades for select
  using (auth.uid() = user_id);

drop policy if exists "trades_insert_own" on public.trades;
create policy "trades_insert_own"
  on public.trades for insert
  with check (auth.uid() = user_id);

create or replace function public.execute_market_buy(
  p_user_id uuid,
  p_quantity numeric,
  p_price numeric
)
returns table (
  trade_id uuid,
  trade_type text,
  trade_price numeric,
  trade_quantity numeric,
  trade_total_value numeric,
  trade_created_at timestamptz,
  balance_usd numeric,
  btc_quantity numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quantity numeric(20,8);
  v_price numeric(20,8);
  v_total numeric(20,2);
  v_trade_id uuid;
  v_created_at timestamptz := now();
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'Not authorized';
  end if;

  v_quantity := round(p_quantity::numeric, 8);
  v_price := round(p_price::numeric, 8);

  if v_quantity <= 0 then
    raise exception 'Invalid quantity';
  end if;

  if v_price <= 0 then
    raise exception 'Invalid price';
  end if;

  v_total := round((v_quantity * v_price)::numeric, 2);
  if v_total <= 0 then
    raise exception 'Trade amount too small';
  end if;

  insert into public.portfolios (user_id, balance_usd, btc_quantity, updated_at)
  values (p_user_id, 10000, 0, v_created_at)
  on conflict (user_id) do nothing;

  update public.portfolios
     set balance_usd = round((public.portfolios.balance_usd - v_total)::numeric, 2),
       btc_quantity = round((public.portfolios.btc_quantity + v_quantity)::numeric, 8),
         updated_at = v_created_at
   where user_id = p_user_id
     and public.portfolios.balance_usd >= v_total;

  if not found then
    raise exception 'Insufficient USD balance';
  end if;

  insert into public.trades (user_id, type, price, quantity, total_value, created_at)
  values (p_user_id, 'BUY', v_price, v_quantity, v_total, v_created_at)
  returning id into v_trade_id;

  select p.balance_usd, p.btc_quantity
    into balance_usd, btc_quantity
    from public.portfolios p
   where p.user_id = p_user_id;

  trade_id := v_trade_id;
  trade_type := 'BUY';
  trade_price := v_price;
  trade_quantity := v_quantity;
  trade_total_value := v_total;
  trade_created_at := v_created_at;

  return next;
end;
$$;

create or replace function public.execute_market_sell(
  p_user_id uuid,
  p_quantity numeric,
  p_price numeric
)
returns table (
  trade_id uuid,
  trade_type text,
  trade_price numeric,
  trade_quantity numeric,
  trade_total_value numeric,
  trade_created_at timestamptz,
  balance_usd numeric,
  btc_quantity numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quantity numeric(20,8);
  v_price numeric(20,8);
  v_total numeric(20,2);
  v_trade_id uuid;
  v_created_at timestamptz := now();
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'Not authorized';
  end if;

  v_quantity := round(p_quantity::numeric, 8);
  v_price := round(p_price::numeric, 8);

  if v_quantity <= 0 then
    raise exception 'Invalid quantity';
  end if;

  if v_price <= 0 then
    raise exception 'Invalid price';
  end if;

  v_total := round((v_quantity * v_price)::numeric, 2);
  if v_total <= 0 then
    raise exception 'Trade amount too small';
  end if;

  insert into public.portfolios (user_id, balance_usd, btc_quantity, updated_at)
  values (p_user_id, 10000, 0, v_created_at)
  on conflict (user_id) do nothing;

  update public.portfolios
     set balance_usd = round((public.portfolios.balance_usd + v_total)::numeric, 2),
       btc_quantity = round((public.portfolios.btc_quantity - v_quantity)::numeric, 8),
         updated_at = v_created_at
   where user_id = p_user_id
     and public.portfolios.btc_quantity >= v_quantity;

  if not found then
    raise exception 'Insufficient BTC balance';
  end if;

  insert into public.trades (user_id, type, price, quantity, total_value, created_at)
  values (p_user_id, 'SELL', v_price, v_quantity, v_total, v_created_at)
  returning id into v_trade_id;

  select p.balance_usd, p.btc_quantity
    into balance_usd, btc_quantity
    from public.portfolios p
   where p.user_id = p_user_id;

  trade_id := v_trade_id;
  trade_type := 'SELL';
  trade_price := v_price;
  trade_quantity := v_quantity;
  trade_total_value := v_total;
  trade_created_at := v_created_at;

  return next;
end;
$$;

revoke all on function public.execute_market_buy(uuid, numeric, numeric) from public;
revoke all on function public.execute_market_sell(uuid, numeric, numeric) from public;
grant execute on function public.execute_market_buy(uuid, numeric, numeric) to authenticated;
grant execute on function public.execute_market_sell(uuid, numeric, numeric) to authenticated;
