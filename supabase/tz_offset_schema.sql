-- Minutes east of UTC that a trade's `time` was recorded in (e.g. +120 for
-- UTC+2), captured from whichever device recorded it — the EA's MT4/MT5
-- terminal, or the browser when a trade is added/edited manually. Lets the
-- app convert a trade's time to whatever timezone the *viewer* is currently
-- in, instead of always showing the recording device's raw local time.
-- Null for trades that predate this column, or where the origin zone is
-- unknown — those just show their stored time as-is, unconverted.
alter table public.trades add column tz_offset_minutes integer;
