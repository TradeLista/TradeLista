// Supabase Edge Function: stripe-webhook
// Receives Stripe webhook events and keeps the `profiles` table in sync with
// the real subscription state (plan, period end, cancellation flag).
//
// Required secrets (Project Settings -> Edge Functions -> Secrets):
//   STRIPE_SECRET_KEY     — your Stripe test secret key (sk_test_...)
//   STRIPE_WEBHOOK_SECRET — signing secret shown when you create the webhook
//                           endpoint in the Stripe Dashboard (whsec_...)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// After deploying, copy this function's URL into Stripe Dashboard ->
// Developers -> Webhooks -> Add endpoint, and select these events:
//   checkout.session.completed, customer.subscription.updated,
//   customer.subscription.deleted

import Stripe from 'npm:stripe@17';
import { createClient } from 'npm:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

async function updateProfileFromSubscription(subscription: Stripe.Subscription) {
  const userId = subscription.metadata?.supabase_user_id;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;

  const patch = {
    plan: (subscription.status === 'active' || subscription.status === 'trialing') ? 'pro' : 'free',
    stripe_subscription_id: subscription.id,
    period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    cancel_at_period_end: subscription.cancel_at_period_end,
  };

  let query = supabaseAdmin.from('profiles').update(patch);
  query = userId ? query.eq('id', userId) : query.eq('stripe_customer_id', customerId);
  const { error } = await query;
  if (error) console.error('Failed to update profile from subscription:', error);
}

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature!, webhookSecret);
  } catch (err) {
    return new Response(`Webhook signature verification failed: ${(err as Error).message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === 'subscription' && session.subscription) {
          const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          if (session.metadata?.supabase_user_id && !subscription.metadata?.supabase_user_id) {
            await stripe.subscriptions.update(subscription.id, {
              metadata: { supabase_user_id: session.metadata.supabase_user_id },
            });
            subscription.metadata = { ...subscription.metadata, supabase_user_id: session.metadata.supabase_user_id };
          }
          await updateProfileFromSubscription(subscription);
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await updateProfileFromSubscription(event.data.object as Stripe.Subscription);
        break;
      }
    }
  } catch (err) {
    console.error('Error handling webhook event:', err);
    return new Response('Internal error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
