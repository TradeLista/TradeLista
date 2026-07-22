// Supabase Edge Function: cancel-subscription
//
// Backs the site-wide "Cancel contract here" button required by § 312k BGB
// (the "Kündigungsbutton" law, in force since 1 July 2022). Unlike
// withdraw-subscription-style flows, this ends the contract going
// forward rather than reversing a purchase: it sets the Stripe
// subscription to stop renewing at the end of the period already paid
// for, then immediately emails the required confirmation (content, date
// and time of receipt, and the date the contract actually ends).
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

// Escape any user-supplied value before it goes into the HTML email body, so a
// name/field can't inject markup or links into the message.
function escapeHtml(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Wraps a greeting + body paragraphs in the shared TradeLista branded shell
// (dark header, light card, "Best regards" sign-off). bodyHtml is trusted
// markup we build ourselves — interpolate user values through escapeHtml first.
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
    .select('plan, stripe_subscription_id, first_name, last_name')
    .eq('id', user.id)
    .single();

  if (!profile || profile.plan !== 'pro' || !profile.stripe_subscription_id) {
    return json({ error: 'No active subscription found to cancel.' }, 400);
  }

  try {
    const subscription = await stripe.subscriptions.update(profile.stripe_subscription_id, {
      cancel_at_period_end: true,
    });
    const periodEnd = new Date(subscription.current_period_end * 1000);

    // The stripe-webhook function also reflects this into `profiles` when
    // Stripe's own customer.subscription.updated event arrives — this is
    // just so the confirmation email below (and the page that called us)
    // don't have to wait for that separate round trip.
    await supabaseAdmin.from('profiles')
      .update({ cancel_at_period_end: true, period_end: periodEnd.toISOString() })
      .eq('id', user.id);

    const receivedAt = new Date();
    const receivedAtStr = receivedAt.toLocaleString('en-GB', { timeZone: 'Europe/Berlin', dateStyle: 'long', timeStyle: 'short' }) + ' (Europe/Berlin)';
    const periodEndStr = periodEnd.toLocaleDateString('en-GB', { timeZone: 'Europe/Berlin', dateStyle: 'long' });

    // The cancellation above already succeeded and is the part that legally
    // and functionally matters — a flaky SMTP send must not turn this into
    // a reported failure for something that in fact worked.
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
          subject: 'Your TradeLista Pro subscription cancellation — confirmed',
          text: `Hi ${profile.first_name || ''},\n\nThis confirms we received your cancellation declaration on ${receivedAtStr}.\n\nWhat you cancelled: TradeLista Pro subscription\nReceived: ${receivedAtStr}\nYour contract will end on: ${periodEndStr}\n\nYou'll keep full Pro access until then — no further charges after that date. You can undo this and keep your Pro plan anytime before ${periodEndStr} from Account settings.\n\n— TradeLista`,
          html: brandedEmail(
            profile.first_name ? `Hi ${escapeHtml(profile.first_name)},` : 'Hi there,',
            `<p style="${P}">This confirms we received your cancellation declaration on <strong>${receivedAtStr}</strong>.</p>
             <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#3a4453;">
               <tr><td style="padding-right:12px;color:#8a93a3;">What you cancelled</td><td>TradeLista Pro subscription</td></tr>
               <tr><td style="padding-right:12px;color:#8a93a3;">Received</td><td>${receivedAtStr}</td></tr>
               <tr><td style="padding-right:12px;color:#8a93a3;">Your contract ends</td><td><strong>${periodEndStr}</strong></td></tr>
             </table>
             <p style="${P}">You'll keep full Pro access until then — no further charges after that date. You can undo this and keep your Pro plan anytime before ${periodEndStr} from your Account settings.</p>`,
          ),
        });
      } else {
        console.error('cancel-subscription: missing SMTP secrets, confirmation email not sent.');
      }
    } catch (emailErr) {
      console.error('cancel-subscription: cancellation processed but confirmation email failed:', emailErr);
    }

    return json({ ok: true, periodEnd: periodEnd.toISOString(), receivedAt: receivedAt.toISOString() });
  } catch (err) {
    console.error('cancel-subscription failed:', err);
    return json({ error: 'Could not process the cancellation. Please try again or contact support.' }, 500);
  }
});
