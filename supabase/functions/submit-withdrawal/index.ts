// Supabase Edge Function: submit-withdrawal
//
// Backs the site-wide "Withdraw from contract" button required by § 356a
// BGB (the "Widerrufsbutton" law, in force since 19 June 2026). This only
// ever RECEIVES and ACKNOWLEDGES a withdrawal declaration — it never
// cancels a subscription or issues a refund by itself. Whether a given
// declaration is actually effective (deadlines, exclusion grounds, whether
// the customer already waived their right at checkout) is a human decision
// made after reading the email this sends, not something this function
// can determine automatically.
//
// Needs "Verify JWT" turned OFF (this must work for a logged-out visitor —
// the withdrawal-form's own accessibility must not depend on account login).
// Requires these secrets (same ones send-contact-email already uses):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, CONTACT_TO
//   SITE_URL   e.g. https://tradelista.com — restricts CORS (defaults to "*")

import nodemailer from 'npm:nodemailer@6';
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('SITE_URL') ?? '*',
  'Access-Control-Allow-Headers': 'content-type',
};

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

const RATE_LIMIT_WINDOW_MINUTES = 10;
const RATE_LIMIT_MAX_SUBMISSIONS = 5;

// Escape any user-supplied value before it goes into the HTML email body — the
// withdrawal form's name/reference/details are visitor-controlled.
function escapeHtml(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Shared TradeLista branded email shell (dark header, light card, sign-off).
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
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return new Response(JSON.stringify({ error: 'Invalid request body.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Hidden honeypot field — see send-contact-email for the same pattern.
  if (body.website) {
    return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const { name, contractRef, email, details } = body;
  if (!name || !contractRef || !email) {
    return new Response(JSON.stringify({ error: 'Please fill in your name, account email and contract reference.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRe.test(email)) {
    return new Response(JSON.stringify({ error: 'Please enter a valid email address.' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Shared with send-contact-email's rate limiting — same abuse profile
  // (a public form that emails a third party), so one combined limit per IP.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { count } = await supabaseAdmin
    .from('contact_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('ip', ip)
    .gte('created_at', windowStart);
  if ((count ?? 0) >= RATE_LIMIT_MAX_SUBMISSIONS) {
    return new Response(JSON.stringify({ error: "You've submitted several requests recently — please wait a bit before trying again." }), {
      status: 429,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  await supabaseAdmin.from('contact_submissions').insert({ ip });

  const receivedAt = new Date();
  const receivedAtStr = receivedAt.toLocaleString('en-GB', { timeZone: 'Europe/Berlin', dateStyle: 'long', timeStyle: 'short' }) + ' (Europe/Berlin)';

  try {
    const smtpUser = Deno.env.get('SMTP_USER');
    if (!smtpUser || !Deno.env.get('SMTP_HOST') || !Deno.env.get('SMTP_PASSWORD')) {
      console.error('submit-withdrawal: missing SMTP_USER/SMTP_HOST/SMTP_PASSWORD secret.');
      return new Response(JSON.stringify({ error: 'This form is misconfigured. Please email us directly instead.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const transporter = nodemailer.createTransport({
      host: Deno.env.get('SMTP_HOST'),
      port: Number(Deno.env.get('SMTP_PORT') || '587'),
      secure: Number(Deno.env.get('SMTP_PORT') || '587') === 465,
      auth: { user: smtpUser, pass: Deno.env.get('SMTP_PASSWORD') },
    });

    // To the site owner — for manual review. This is the only place
    // eligibility (deadlines, exclusion grounds, identity) gets decided.
    await transporter.sendMail({
      from: smtpUser,
      to: Deno.env.get('CONTACT_TO') || smtpUser,
      replyTo: email,
      subject: `[TradeLista] Withdrawal request from ${name}`,
      text: `A withdrawal declaration was submitted via the site's Withdraw-from-contract form.\n\nName: ${name}\nAccount email / contract reference: ${contractRef}\nReply-to email: ${email}\nReceived: ${receivedAtStr}\n\nDetails / partial withdrawal notes:\n${details || '(none provided)'}\n\nThis has NOT been approved or actioned automatically — check the checkout-consent waiver, the 14-day deadline and the customer's identity before deciding.`,
    });

    // To the consumer — immediate, required receipt confirmation. Echoes
    // their own submission back; does not confirm the withdrawal itself.
    await transporter.sendMail({
      from: smtpUser,
      to: email,
      subject: 'We received your withdrawal request — TradeLista',
      text: `Hi ${name},\n\nThis confirms we received your withdrawal declaration on ${receivedAtStr}. Here's what you submitted:\n\nName: ${name}\nAccount email / contract reference: ${contractRef}\nDetails / partial withdrawal notes: ${details || '(none provided)'}\n\nThis email only confirms receipt — it does not itself confirm that the withdrawal is valid or effective. We'll review it and get back to you by email.\n\n— TradeLista`,
      html: brandedEmail(
        `Hi ${escapeHtml(name)},`,
        `<p style="${P}">This confirms we received your withdrawal declaration on <strong>${receivedAtStr}</strong>. Here's what you submitted:</p>
         <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#3a4453;">
           <tr><td style="padding-right:12px;color:#8a93a3;vertical-align:top;">Name</td><td>${escapeHtml(name)}</td></tr>
           <tr><td style="padding-right:12px;color:#8a93a3;vertical-align:top;">Account / contract reference</td><td>${escapeHtml(contractRef)}</td></tr>
           <tr><td style="padding-right:12px;color:#8a93a3;vertical-align:top;">Details</td><td>${details ? escapeHtml(details) : '(none provided)'}</td></tr>
         </table>
         <p style="${P}">This email only confirms receipt — it does not itself confirm that the withdrawal is valid or effective. We'll review it and get back to you by email.</p>`,
      ),
    });
  } catch (err) {
    console.error('submit-withdrawal failed:', err);
    return new Response(JSON.stringify({ error: 'Could not send your request. Please try again later or email us directly.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
