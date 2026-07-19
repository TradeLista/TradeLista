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
//   { api_key, symbol, lot, entry, exit, profit, date }
// date is 'YYYY-MM-DD'; entry/exit are optional.

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

  if (!body.symbol || !body.date || typeof body.profit !== 'number') {
    return new Response(JSON.stringify({ error: 'Missing symbol, date or profit.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const id = `${body.date}-ea${Date.now()}`;
  const { error } = await supabaseAdmin.from('trades').insert({
    id,
    user_id: account.user_id,
    account_id: account.id,
    is_manual: false,
    source: 'ea',
    date: body.date,
    symbol: body.symbol,
    lot: body.lot ?? null,
    entry: body.entry ?? null,
    exit_price: body.exit ?? null,
    profit: body.profit,
  });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true, id }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
