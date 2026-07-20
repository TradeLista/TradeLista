-- Which direction a trade was: 'buy' (long) or 'sell' (short). Optional —
-- the MT4/MT5 EA only started sending this once support was added here, so
-- trades synced before then (and manual/imported trades left blank) stay
-- null rather than being backfilled with a guess.
alter table public.trades add column side text check (side in ('buy','sell'));
