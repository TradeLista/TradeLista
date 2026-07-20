-- Time of day a trade closed (e.g. "14:32"), so multiple trades logged on
-- the same calendar day can be told apart and sorted chronologically.
-- Nullable/free-text: optional on the manual-entry form, and older trades
-- (added before this column existed) simply have none.
alter table public.trades add column time text;
