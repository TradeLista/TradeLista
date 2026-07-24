// Supabase Edge Function: stripe-webhook
// Receives Stripe webhook events and keeps the `profiles` table in sync with
// the real subscription state (plan, period end, cancellation flag), and
// welcomes the customer by email the first time they subscribe.
//
// Required secrets (Project Settings -> Edge Functions -> Secrets):
//   STRIPE_SECRET_KEY     — your Stripe secret key (sk_live_... in production)
//   STRIPE_WEBHOOK_SECRET — signing secret shown when you create the webhook
//                           endpoint in the Stripe Dashboard (whsec_...)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD — for the welcome email
//   SITE_URL              — used for the "open my calendar" link
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// This function must have "Verify JWT" turned OFF in the Supabase Dashboard —
// Stripe calls it directly and has no Supabase session to present. It
// authenticates the caller by verifying Stripe's signature instead.
//
// After deploying, copy this function's URL into Stripe Dashboard ->
// Developers -> Webhooks -> Add endpoint, and select these events:
//   checkout.session.completed, customer.subscription.updated,
//   customer.subscription.deleted

import Stripe from 'npm:stripe@17';
import { createClient } from 'npm:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' });
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;
const SITE_URL = Deno.env.get('SITE_URL') ?? 'https://www.tradelista.com';
const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// Escape any user-supplied value before it goes into the HTML email body, so a
// name can't inject markup or links into the message.
function escapeHtml(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Same branded shell the cancellation/resume emails use, so every message the
// customer gets from TradeLista looks like it came from the same place.
function brandedEmail(greeting: string, bodyHtml: string) {
  return `<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(10,14,20,.06);">
      <tr><td style="background:#0a0e14;padding:24px 32px;">
        <span style="color:#e7edf5;font-size:20px;font-weight:800;letter-spacing:-.02em;">Trade<span style="color:#4f8cff;">Lista</span></span>
      </td></tr>
      <tr><td style="padding:36px 32px 8px;">
        <p style="margin:0 0 16px;font-size:16px;color:#0a0e14;">${greeting}</p>
        ${bodyHtml}
      </td></tr>
      <tr><td style="padding:20px 32px 32px;border-top:1px solid #eef1f6;">
        <p style="margin:16px 0 0;font-size:15px;color:#3a4453;">Best regards,<br><strong style="color:#0a0e14;">The TradeLista Team</strong></p>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}
const P = 'margin:0 0 16px;font-size:15px;line-height:1.6;color:#3a4453;';

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

// Sent once, when someone first subscribes — not on renewals, which arrive as
// customer.subscription.updated. Deliberately swallows every failure: the
// payment has already succeeded and the account is already Pro, so a flaky
// SMTP server must never make this webhook report an error. A non-2xx reply
// would make Stripe retry the whole event and re-send this mail repeatedly.
async function sendProWelcomeEmail(subscription: Stripe.Subscription, session: Stripe.Checkout.Session) {
  try {
    const smtpUser = Deno.env.get('SMTP_USER');
    if (!smtpUser || !Deno.env.get('SMTP_HOST') || !Deno.env.get('SMTP_PASSWORD')) {
      console.error('stripe-webhook: missing SMTP secrets, welcome email not sent.');
      return;
    }

    const userId = subscription.metadata?.supabase_user_id;
    let email = session.customer_details?.email ?? null;
    let firstName = '';

    if (userId) {
      const { data: profile } = await supabaseAdmin
        .from('profiles').select('first_name').eq('id', userId).single();
      firstName = profile?.first_name ?? '';
      if (!email) {
        const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
        email = authUser?.user?.email ?? null;
      }
    }
    if (!email) {
      console.error('stripe-webhook: no email address for the new subscriber, welcome email not sent.');
      return;
    }

    const perks = [
      'MT4 / MT5 auto-sync',
      'Up to 5 connected accounts',
      'Unlimited screenshots (1 GB)',
      'Custom reflection questions',
      'Golden trading rules',
      'Trade insights &amp; your TradeLista Score',
    ];

    const transporter = nodemailer.createTransport({
      host: Deno.env.get('SMTP_HOST'),
      port: Number(Deno.env.get('SMTP_PORT') || '587'),
      secure: Number(Deno.env.get('SMTP_PORT') || '587') === 465,
      auth: { user: smtpUser, pass: Deno.env.get('SMTP_PASSWORD') },
    });

    await transporter.sendMail({
      from: smtpUser,
      to: email,
      subject: 'Welcome to TradeLista Pro',
      text: `Hi ${firstName || 'there'},\n\nYour TradeLista Pro subscription is active — everything is unlocked in your calendar right away:\n\n- MT4 / MT5 auto-sync\n- Up to 5 connected accounts\n- Unlimited screenshots (1 GB)\n- Custom reflection questions\n- Golden trading rules\n- Trade insights & your TradeLista Score\n\nOpen your calendar: ${SITE_URL}/app.html\n\nYour plan renews automatically at $10/month. You can cancel anytime from Account settings — you keep all your trades, notes and screenshots either way.\n\nYour invoice arrives in a separate email from our payment provider, Stripe.\n\n— TradeLista`,
      html: brandedEmail(
        firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi there,',
        `<p style="${P}">Your <strong>TradeLista Pro</strong> subscription is active — everything below is unlocked in your calendar right away.</p>
         <table cellpadding="0" cellspacing="0" style="margin:0 0 20px;font-size:15px;line-height:1.8;color:#3a4453;">
           ${perks.map(p => `<tr><td style="padding-right:10px;color:#4f8cff;">&#10003;</td><td>${p}</td></tr>`).join('')}
         </table>
         <table cellpadding="0" cellspacing="0" style="margin:0 0 20px;">
           <tr><td style="background:#4f8cff;border-radius:999px;">
             <a href="${SITE_URL}/app.html" style="display:inline-block;padding:12px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Open my calendar</a>
           </td></tr>
         </table>
         <p style="${P}">Your plan renews automatically at <strong>$10/month</strong>. You can cancel anytime from Account settings &mdash; you keep all your trades, notes and screenshots either way.</p>
         <p style="margin:0;font-size:13px;line-height:1.6;color:#8a93a3;">Your invoice arrives in a separate email from our payment provider, Stripe.</p>`,
      ),
    });
  } catch (emailErr) {
    console.error('stripe-webhook: subscription activated but welcome email failed:', emailErr);
  }
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
          await sendProWelcomeEmail(subscription, session);
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
