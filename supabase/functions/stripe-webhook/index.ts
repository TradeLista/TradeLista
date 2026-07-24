// Supabase Edge Function: stripe-webhook
// Receives Stripe webhook events and keeps the `profiles` table in sync with
// the real subscription state (plan, period end, cancellation flag). It also
// sends the two emails that would otherwise never reach the customer:
//   * a welcome the first time they subscribe, and
//   * the § 312k BGB cancellation confirmation when they cancel somewhere
//     other than our own button — i.e. in Stripe's customer portal, which
//     our cancel-subscription function never hears about.
//
// Required secrets (Project Settings -> Edge Functions -> Secrets):
//   STRIPE_SECRET_KEY     — your Stripe secret key (sk_live_... in production)
//   STRIPE_WEBHOOK_SECRET — signing secret from the webhook endpoint (whsec_...)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD — for the emails
//   SITE_URL              — used for links in the emails
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// This function must have "Verify JWT" turned OFF in the Supabase Dashboard —
// Stripe calls it directly and has no Supabase session to present. It
// authenticates the caller by verifying Stripe's signature instead.
//
// Webhook events to select in Stripe:
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

function mailer() {
  const smtpUser = Deno.env.get('SMTP_USER');
  if (!smtpUser || !Deno.env.get('SMTP_HOST') || !Deno.env.get('SMTP_PASSWORD')) return null;
  const port = Number(Deno.env.get('SMTP_PORT') || '587');
  return {
    from: smtpUser,
    transporter: nodemailer.createTransport({
      host: Deno.env.get('SMTP_HOST'),
      port,
      secure: port === 465,
      auth: { user: smtpUser, pass: Deno.env.get('SMTP_PASSWORD') },
    }),
  };
}

// The profile as it looks *before* this event is applied. Reading it first is
// what lets us tell a fresh cancellation apart from one we already handled.
async function loadProfileFor(subscription: Stripe.Subscription) {
  const userId = subscription.metadata?.supabase_user_id;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
  const query = supabaseAdmin.from('profiles').select('id, first_name, cancel_at_period_end');
  const { data } = userId
    ? await query.eq('id', userId).maybeSingle()
    : await query.eq('stripe_customer_id', customerId).maybeSingle();
  return data;
}

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

// Sent once, on the first subscription. Swallows every failure on purpose:
// the payment already succeeded and the account is already Pro, so a flaky
// SMTP server must never make this webhook answer non-2xx — Stripe would
// retry the whole event and re-send the mail repeatedly.
async function sendProWelcomeEmail(subscription: Stripe.Subscription, session: Stripe.Checkout.Session) {
  try {
    const mail = mailer();
    if (!mail) { console.error('stripe-webhook: missing SMTP secrets, welcome email not sent.'); return; }

    const userId = subscription.metadata?.supabase_user_id;
    let email = session.customer_details?.email ?? null;
    let firstName = '';

    if (userId) {
      const { data: profile } = await supabaseAdmin
        .from('profiles').select('first_name').eq('id', userId).maybeSingle();
      firstName = profile?.first_name ?? '';
      if (!email) {
        const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
        email = authUser?.user?.email ?? null;
      }
    }
    if (!email) { console.error('stripe-webhook: no email for the new subscriber.'); return; }

    const perks = [
      'MT4 / MT5 auto-sync',
      'Up to 5 connected accounts',
      'Unlimited screenshots (1 GB)',
      'Custom reflection questions',
      'Golden trading rules',
      'Trade insights &amp; your TradeLista Score',
    ];

    await mail.transporter.sendMail({
      from: mail.from,
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

// § 312k BGB requires the cancellation to be confirmed immediately in a
// durable medium, with its content, the time it was received and the date the
// contract ends. Our own cancel-subscription function does that for the site's
// "Cancel contract here" button — but a customer cancelling in Stripe's
// customer portal never touches it, and used to get nothing at all.
async function sendCancellationEmail(subscription: Stripe.Subscription, profile: { id: string; first_name?: string | null }) {
  try {
    const mail = mailer();
    if (!mail) { console.error('stripe-webhook: missing SMTP secrets, cancellation email not sent.'); return; }

    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(profile.id);
    const email = authUser?.user?.email;
    if (!email) { console.error('stripe-webhook: no email for the cancelling customer.'); return; }

    const periodEnd = new Date(subscription.current_period_end * 1000);
    const receivedAtStr = new Date().toLocaleString('en-GB', { timeZone: 'Europe/Berlin', dateStyle: 'long', timeStyle: 'short' }) + ' (Europe/Berlin)';
    const periodEndStr = periodEnd.toLocaleDateString('en-GB', { timeZone: 'Europe/Berlin', dateStyle: 'long' });
    const firstName = profile.first_name ?? '';

    await mail.transporter.sendMail({
      from: mail.from,
      to: email,
      subject: 'Your TradeLista Pro subscription cancellation — confirmed',
      text: `Hi ${firstName || 'there'},\n\nThis confirms we received your cancellation declaration on ${receivedAtStr}.\n\nWhat you cancelled: TradeLista Pro subscription\nReceived: ${receivedAtStr}\nYour contract will end on: ${periodEndStr}\n\nYou'll keep full Pro access until then — no further charges after that date. You can undo this and keep your Pro plan anytime before ${periodEndStr} from Account settings.\n\n— TradeLista`,
      html: brandedEmail(
        firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi there,',
        `<p style="${P}">This confirms we received your cancellation declaration on <strong>${receivedAtStr}</strong>.</p>
         <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#3a4453;">
           <tr><td style="padding-right:12px;color:#8a93a3;">What you cancelled</td><td>TradeLista Pro subscription</td></tr>
           <tr><td style="padding-right:12px;color:#8a93a3;">Received</td><td>${receivedAtStr}</td></tr>
           <tr><td style="padding-right:12px;color:#8a93a3;">Your contract ends</td><td><strong>${periodEndStr}</strong></td></tr>
         </table>
         <p style="${P}">You'll keep full Pro access until then &mdash; no further charges after that date. You can undo this and keep your Pro plan anytime before ${periodEndStr} from your Account settings.</p>`,
      ),
    });
  } catch (emailErr) {
    console.error('stripe-webhook: cancellation recorded but confirmation email failed:', emailErr);
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
      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const before = await loadProfileFor(subscription);
        await updateProfileFromSubscription(subscription);
        // Only on the transition into "cancelling", and only when nobody has
        // confirmed it yet. cancel-subscription flips this same flag before
        // Stripe's event arrives, so a still-false value here means the
        // cancellation came from the Stripe portal instead of our own button
        // — and the customer has had no confirmation at all.
        if (subscription.cancel_at_period_end && before && !before.cancel_at_period_end) {
          await sendCancellationEmail(subscription, before);
        }
        break;
      }
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
