// Supabase Edge Function: ingest-trade
//
// The endpoint a real MT4/MT5 Expert Advisor would POST closed trades to
// (see web/connect.html's setup guide, step 4 — "Allow WebRequest for
// listed URL"). Authenticated by api_key (per trading account), not a
// Supabase user session, since an EA has no login of its own.
//
// No such EA exists yet, so nothing calls this today — it exists so the
// rest of the multi-account system (trading_accounts, trades.source) has
// somewhere real to receive data the day an EA is actually built.
//
// Expected JSON body:
//   { api_key, symbol, lot, entry, exit, profit, date, side }
// date is 'YYYY-MM-DD'; entry/exit/side are optional. side is 'buy'/'sell' —
// anything else (older EA builds that don't send it yet, or garbage) is
// silently stored as null rather than rejecting the whole trade over it.

import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  const body = await req.json().catch(() => null);
  if (!body || !body.api_key) {
    return new Response(JSON.stringify({ error: 'Missing api_key.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: account, error: accountError } = await supabaseAdmin
    .from('trading_accounts')
    .select('id, user_id')
    .eq('api_key', body.api_key)
    .single();

  if (accountError || !account) {
    return new Response(JSON.stringify({ error: 'Invalid api_key.' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // EA auto-sync is a Pro feature (see connect.html / the pricing page) —
  // enforced here, not just implied by the setup guide's wording, so a Free
  // account can't get free EA sync just by attaching the EA to its one
  // manual-entry account.
  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('plan, cancel_at_period_end, period_end')
    .eq('id', account.user_id)
    .single();

  const isExpiredPro = profile?.cancel_at_period_end && profile.period_end && new Date(profile.period_end) <= new Date();
  if (!profile || profile.plan !== 'pro' || isExpiredPro) {
    return new Response(JSON.stringify({ error: 'Pro plan required for EA auto-sync.' }), {
      status: 402,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!body.symbol || !body.date || typeof body.profit !== 'number') {
    return new Response(JSON.stringify({ error: 'Missing symbol, date or profit.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Anyone holding a valid api_key (a long-lived value pasted into an EA's
  // config, more prone to leaking than a password) can otherwise write
  // arbitrary text into `symbol` for that account's owner — and it's
  // rendered back into the owner's own page later. Real symbols are short
  // and plain (EURUSD, US30, XAUUSD, DE40.cash), so a tight allow-list here
  // costs nothing and closes that off at the source, on top of the client
  // already escaping it before render.
  if (!/^[A-Za-z0-9._#-]{1,20}$/.test(body.symbol)) {
    return new Response(JSON.stringify({ error: 'Invalid symbol.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // The remaining EA-supplied fields either end up inside the row id (date,
  // deal_ticket) or in typed numeric/date columns. Validate each one's shape
  // here so a tampered EA config can't build a malformed id or push a value
  // that would otherwise only blow up later at the database layer. Same
  // reasoning as the symbol allow-list above — a leaked api_key shouldn't let
  // anyone write junk into its owner's account.
  const reject = (msg: string) => new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

  // Must be exactly YYYY-MM-DD: it's concatenated into the id, which the
  // client splits on '-' to recover the trade's date (a real calendar date
  // is still enforced by the `date` column itself on upsert).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return reject('Invalid date — expected YYYY-MM-DD.');
  }
  // MT5 deal tickets are integers; keep the id clean and predictable.
  if (body.deal_ticket !== undefined && body.deal_ticket !== null && !/^\d{1,20}$/.test(String(body.deal_ticket))) {
    return reject('Invalid deal_ticket.');
  }
  // typeof already passed above, but that still admits NaN/Infinity.
  if (!Number.isFinite(body.profit)) {
    return reject('Invalid profit.');
  }
  for (const field of ['lot', 'entry', 'exit'] as const) {
    const v = body[field];
    if (v !== undefined && v !== null && !Number.isFinite(v)) {
      return reject(`Invalid ${field}.`);
    }
  }
  if (body.time !== undefined && body.time !== null && !/^\d{1,2}:\d{2}$/.test(String(body.time))) {
    return reject('Invalid time — expected HH:MM.');
  }
  if (body.tz_offset_minutes !== undefined && body.tz_offset_minutes !== null &&
      (!Number.isInteger(body.tz_offset_minutes) || Math.abs(body.tz_offset_minutes) > 840)) {
    return reject('Invalid tz_offset_minutes.');
  }

  // Keyed off the MT5 deal ticket (stable and unique per account) rather
  // than a timestamp, so the exact same closed trade always maps to the
  // exact same row — if it's ever sent twice (MT5 firing the event twice,
  // or the EA attached to more than one chart on the same account), the
  // second POST just updates that row instead of creating a duplicate.
  // Must still START with the YYYY-MM-DD date — the client derives a
  // trade's date by splitting its id on '-' and taking the first 3 parts
  // (see app.html's findTrade/deleteTradeById/etc.), so the date has to
  // stay in that exact position regardless of what else is in the id.
  const id = body.deal_ticket
    ? `${body.date}-ea-${account.id}-${body.deal_ticket}`
    : `${body.date}-ea${Date.now()}`;
  const side = typeof body.side === 'string' && ['buy', 'sell'].includes(body.side.toLowerCase())
    ? body.side.toLowerCase()
    : null;
  const { error } = await supabaseAdmin.from('trades').upsert({
    id,
    user_id: account.user_id,
    account_id: account.id,
    is_manual: false,
    source: 'ea',
    date: body.date,
    time: body.time ?? null,
    tz_offset_minutes: body.tz_offset_minutes ?? null,
    symbol: body.symbol,
    lot: body.lot ?? null,
    entry: body.entry ?? null,
    exit_price: body.exit ?? null,
    profit: body.profit,
    side,
  });

  if (error) {
    console.error('ingest-trade upsert failed:', error.message);
    return new Response(JSON.stringify({ error: 'Could not save trade.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, id }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
