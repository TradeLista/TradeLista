// Supabase Edge Function: delete-account
// Full, permanent self-service account deletion — cancels any active Stripe
// subscription, removes every trade-image Storage object, then deletes the
// auth.users row itself. profiles/trading_accounts/trades all cascade-delete
// from that last step automatically (see schema.sql, trading_accounts_schema.sql,
// trades_schema.sql — every one of them is "references auth.users on delete cascade").
//
// Required secrets (Project Settings -> Edge Functions -> Secrets):
//   STRIPE_SECRET_KEY  — your Stripe test secret key (sk_test_...)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import Stripe from 'npm:stripe@17';
import { createClient } from 'npm:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('SITE_URL') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

async function removeAllUserFiles(userId: string) {
  async function collectPaths(path: string): Promise<string[]> {
    const { data, error } = await supabaseAdmin.storage.from('trade-images').list(path, { limit: 1000 });
    if (error || !data) return [];
    const paths: string[] = [];
    for (const entry of data) {
      const fullPath = `${path}/${entry.name}`;
      if (entry.id === null) paths.push(...await collectPaths(fullPath));
      else paths.push(fullPath);
    }
    return paths;
  }
  const paths = await collectPaths(userId);
  if (paths.length) await supabaseAdmin.storage.from('trade-images').remove(paths);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return new Response(JSON.stringify({ error: 'Missing auth' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('stripe_subscription_id')
      .eq('id', user.id)
      .single();

    if (profile?.stripe_subscription_id) {
      try {
        await stripe.subscriptions.cancel(profile.stripe_subscription_id);
      } catch (err) {
        // Already-cancelled or missing subscriptions shouldn't block account
        // deletion — the user's data still needs to go either way.
        console.error('delete-account: could not cancel Stripe subscription:', err);
      }
    }

    await removeAllUserFiles(user.id);

    const { error: deleteError } = await supabaseAdmin.auth.admin.deleteUser(user.id);
    if (deleteError) throw deleteError;

    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('delete-account failed:', err);
    return new Response(JSON.stringify({ error: 'Could not delete your account. Please try again or contact support.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
