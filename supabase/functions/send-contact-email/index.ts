// Supabase Edge Function: send-contact-email
//
// Sends the homepage/contact-page "Get in touch" form straight to the site
// owner's IONOS mailbox over SMTP, instead of the old mailto: link (which
// only opened the visitor's own email app and needed their permission).
//
// Needs "Verify JWT" turned OFF for this function in the Supabase Dashboard —
// visitors filling out the contact form aren't logged in, so there's no
// Supabase session to check. Requires these secrets (Edge Function Secrets):
//   SMTP_HOST     e.g. smtp.ionos.de
//   SMTP_PORT     e.g. 587
//   SMTP_USER     the full IONOS mailbox address (used to log in and as "From")
//   SMTP_PASSWORD the IONOS mailbox password
//   CONTACT_TO    where messages should land (defaults to SMTP_USER)
//   SITE_URL      e.g. https://tradelista.com — restricts which origin can
//                 read this function's response (defaults to "*" until set)

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return new Response(JSON.stringify({ error: 'Invalid request body.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Hidden form field real visitors never see or fill in — bots that fill
  // every field tend to fill this one too. Report success without actually
  // sending anything, so scripted submitters have no signal to adapt to.
  if (body.website) {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { firstName, lastName, email, subject, message } = body;
  if (!firstName || !lastName || !email || !subject || !message) {
    return new Response(JSON.stringify({ error: 'Please fill in every field.' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { count } = await supabaseAdmin
    .from('contact_submissions')
    .select('id', { count: 'exact', head: true })
    .eq('ip', ip)
    .gte('created_at', windowStart);
  if ((count ?? 0) >= RATE_LIMIT_MAX_SUBMISSIONS) {
    return new Response(JSON.stringify({ error: "You've sent several messages recently — please wait a bit before sending another." }), {
      status: 429,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  await supabaseAdmin.from('contact_submissions').insert({ ip });

  // Everything below — including building the transporter — is wrapped in
  // one try/catch. A missing/malformed SMTP secret throws synchronously
  // from createTransport, and an uncaught throw here means Deno returns its
  // own plain-text error page instead of JSON, which the client can't parse
  // — it then falls back to a generic "something went wrong" with no way to
  // tell what actually failed. This way every failure mode still comes back
  // as valid JSON with a real error message, visible in the function logs too.
  try {
    const smtpUser = Deno.env.get('SMTP_USER');
    if (!smtpUser || !Deno.env.get('SMTP_HOST') || !Deno.env.get('SMTP_PASSWORD')) {
      console.error('send-contact-email: missing SMTP_USER/SMTP_HOST/SMTP_PASSWORD secret.');
      return new Response(JSON.stringify({ error: 'Contact form is misconfigured. Please email us directly instead.' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const transporter = nodemailer.createTransport({
      host: Deno.env.get('SMTP_HOST'),
      port: Number(Deno.env.get('SMTP_PORT') || '587'),
      secure: Number(Deno.env.get('SMTP_PORT') || '587') === 465,
      auth: {
        user: smtpUser,
        pass: Deno.env.get('SMTP_PASSWORD'),
      },
    });

    await transporter.sendMail({
      from: smtpUser,
      to: Deno.env.get('CONTACT_TO') || smtpUser,
      replyTo: email,
      subject: `[TradeLista contact] ${subject}`,
      text: `From: ${firstName} ${lastName} <${email}>\n\n${message}`,
    });
  } catch (err) {
    console.error('send-contact-email failed:', err);
    return new Response(JSON.stringify({ error: 'Could not send the message. Please try again later.' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
