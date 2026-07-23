// Supabase Edge Function: create-checkout-session
// Creates a Stripe Checkout Session for the TradeLista Pro subscription and
// returns its URL. Called from the client with the logged-in user's JWT.
//
// Required secrets (Project Settings -> Edge Functions -> Secrets):
//   STRIPE_SECRET_KEY  — your Stripe test secret key (sk_test_...)
//   SITE_URL           — e.g. http://localhost:5173 for local testing
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Optional secrets:
//   TAX_ENABLED        — set to the literal string "true" to turn on Stripe
//     Tax (automatic VAT/sales tax calculation at checkout). Left unset
//     (or anything else) means tax stays off — the default, since Stripe
//     Tax requires you to have registered tax collection for at least the
//     jurisdictions you're charging in first (Stripe Dashboard -> Tax ->
//     Registrations). Flipping this on before that's set up won't produce
//     correct tax, so don't set it to "true" until that's actually done.
//   STRIPE_TAX_RATE_ID — a manual Stripe tax rate id (txr_...) applied to
//     every subscription while TAX_ENABLED is off. This is the free way to
//     charge a fixed VAT (e.g. German 19%) without Stripe Tax's per-
//     transaction fee. Defaults to the live German 19% rate; set to an empty
//     string to charge no tax. Ignored when TAX_ENABLED is "true".
//   STRIPE_PRICE_ID    — overrides the price below. Use this once you've
//     created a tax-inclusive $10/mo price in Stripe (Products -> Pro ->
//     Add another price -> tick "Tax behavior: inclusive") — the $10 stays
//     $10 for the customer everywhere, tax is already baked in, rather
//     than being added on top at checkout. tax_behavior can't be changed
//     on an existing price, which is why this needs a *new* price object,
//     not an edit to the current one.

import Stripe from 'npm:stripe@17';
import { createClient } from 'npm:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const PRICE_ID = Deno.env.get('STRIPE_PRICE_ID') ?? 'price_1TuWtiK3hVexCjbWUSCD5xnb';
const SITE_URL = Deno.env.get('SITE_URL') ?? 'http://localhost:5173';
const TAX_ENABLED = Deno.env.get('TAX_ENABLED') === 'true';
// Manual VAT: a fixed Stripe tax rate (txr_...) applied to every subscription
// and its recurring invoices while Stripe Tax's automatic_tax stays off
// (TAX_ENABLED=false, the default). This is the free alternative to Stripe Tax
// — no per-transaction Tax fee. Override with STRIPE_TAX_RATE_ID; falls back to
// the live German 19% rate created in the Stripe Dashboard. Set the secret to
// an empty string to charge no tax at all.
const TAX_RATE_ID = Deno.env.get('STRIPE_TAX_RATE_ID') ?? 'txr_1TwNzMK3hVexCjbWIVso5YD6';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('SITE_URL') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return new Response('Missing auth', { status: 401, headers: corsHeaders });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) {
    return new Response('Unauthorized', { status: 401, headers: corsHeaders });
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', user.id)
    .single();

  let customerId = profile?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { supabase_user_id: user.id },
    });
    customerId = customer.id;
    await supabaseAdmin.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: PRICE_ID, quantity: 1 }],
    success_url: `${SITE_URL}/app.html?upgraded=1`,
    cancel_url: `${SITE_URL}/app.html`,
    subscription_data: {
      metadata: { supabase_user_id: user.id },
      // Apply the manual VAT rate to the subscription and every renewal invoice.
      // Skipped when TAX_ENABLED turns on automatic_tax below (only one of the
      // two tax mechanisms may be active on a subscription at a time).
      ...(!TAX_ENABLED && TAX_RATE_ID ? { default_tax_rates: [TAX_RATE_ID] } : {}),
    },
    // Stripe requires customer_update.address = 'auto' whenever an existing
    // Customer is combined with automatic_tax — otherwise it can't fill in
    // the address it needs to know which jurisdiction's tax applies.
    ...(TAX_ENABLED ? {
      automatic_tax: { enabled: true },
      customer_update: { address: 'auto', name: 'auto' },
    } : {}),
  });

  return new Response(JSON.stringify({ url: session.url }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
