-- Free-text tags per trade (e.g. "Breakout", "News trade"), used by the
-- Insights panel to break performance down by strategy/setup. Stored the
-- same way images/answers already are: a jsonb array on the trades row.
alter table public.trades add column tags jsonb not null default '[]'::jsonb;
