-- Trading accounts: a user can have several (Live/Demo, MT4/MT5, different
-- currencies), and every trade now belongs to exactly one of them. The
-- calendar filters by whichever account is currently selected (see
-- auth.js / app.html's account switcher).
create table public.trading_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  account_type text not null check (account_type in ('live','demo')),
  platform text not null check (platform in ('MT4','MT5')),
  currency text not null default 'USD',
  api_key text not null unique default gen_random_uuid()::text,
  created_at timestamptz not null default now()
);

alter table public.trading_accounts enable row level security;

create policy "Users can view their own accounts"
  on public.trading_accounts for select
  using (auth.uid() = user_id);

create policy "Users can insert their own accounts"
  on public.trading_accounts for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own accounts"
  on public.trading_accounts for update
  using (auth.uid() = user_id);

create policy "Users can delete their own accounts"
  on public.trading_accounts for delete
  using (auth.uid() = user_id);

-- Every trade now belongs to one trading account. Existing rows (from
-- before this migration) are left with a null account_id — the client
-- treats those as belonging to whichever account is marked "is_default".
alter table public.trades add column account_id uuid references public.trading_accounts(id) on delete cascade;

-- 'manual' = added/edited by the user in the app, 'ea' = received from a
-- real MT4/MT5 Expert Advisor via the ingest-trade Edge Function. Nothing
-- sets 'ea' today since no such EA exists yet — see ingest-trade/index.ts.
alter table public.trades add column source text not null default 'manual' check (source in ('manual','ea'));

-- One account per user is the default: existing trades (account_id is
-- null) and the calendar's demo data are shown under whichever account has
-- this flag, so nothing you already logged disappears after this migration.
alter table public.trading_accounts add column is_default boolean not null default false;
