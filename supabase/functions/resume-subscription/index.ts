// Supabase Edge Function: resume-subscription
//
// Undoes a pending cancellation started via cancel-subscription: sets the
// Stripe subscription back to renew normally (cancel_at_period_end: false).
// Exists as a reliable, direct alternative to Stripe's own Billing Portal
// "reactivate" button, which could not be confirmed to work in testing.
//
// Requires these secrets:
//   STRIPE_SECRET_KEY, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import Stripe from 'npm:stripe@17';
import { createClient } from 'npm:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('SITE_URL') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing auth' }, 401);

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
  if (authError || !user) return json({ error: 'Unauthorized' }, 401);

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('plan, stripe_subscription_id, cancel_at_period_end, first_name')
    .eq('id', user.id)
    .single();

  if (!profile || profile.plan !== 'pro' || !profile.stripe_subscription_id) {
    return json({ error: 'No subscription found to resume.' }, 400);
  }
  if (!profile.cancel_at_period_end) {
    return json({ error: 'This subscription is not scheduled to cancel — nothing to resume.' }, 400);
  }

  try {
    const subscription = await stripe.subscriptions.update(profile.stripe_subscription_id, {
      cancel_at_period_end: false,
    });
    const periodEnd = new Date(subscription.current_period_end * 1000);

    // The stripe-webhook function also reflects this into `profiles` when
    // Stripe's own customer.subscription.updated event arrives — this is
    // just so the page that called us doesn't have to wait for that.
    await supabaseAdmin.from('profiles')
      .update({ cancel_at_period_end: false })
      .eq('id', user.id);

    const periodEndStr = periodEnd.toLocaleDateString('en-GB', { timeZone: 'Europe/Berlin', dateStyle: 'long' });

    // The subscription change above already succeeded and is the part that
    // actually matters — a flaky SMTP send must not turn this into a
    // reported failure for something that in fact worked.
    try {
      const smtpUser = Deno.env.get('SMTP_USER');
      if (smtpUser && Deno.env.get('SMTP_HOST') && Deno.env.get('SMTP_PASSWORD')) {
        const transporter = nodemailer.createTransport({
          host: Deno.env.get('SMTP_HOST'),
          port: Number(Deno.env.get('SMTP_PORT') || '587'),
          secure: Number(Deno.env.get('SMTP_PORT') || '587') === 465,
          auth: { user: smtpUser, pass: Deno.env.get('SMTP_PASSWORD') },
        });
        await transporter.sendMail({
          from: smtpUser,
          to: user.email,
          subject: 'Your TradeLista Pro subscription — resumed',
          text: `Hi ${profile.first_name || ''},\n\nYour earlier cancellation has been undone. Your TradeLista Pro subscription will now renew as normal, with the next charge on ${periodEndStr}.\n\n— TradeLista`,
        });
      } else {
        console.error('resume-subscription: missing SMTP secrets, confirmation email not sent.');
      }
    } catch (emailErr) {
      console.error('resume-subscription: subscription resumed but confirmation email failed:', emailErr);
    }

    return json({ ok: true, periodEnd: periodEnd.toISOString() });
  } catch (err) {
    console.error('resume-subscription failed:', err);
    return json({ error: 'Could not resume the subscription. Please try again or contact support.' }, 500);
  }
});
