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

import nodemailer from 'npm:nodemailer@6';

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
  if (!body) {
    return new Response(JSON.stringify({ error: 'Invalid request body.' }), {
      status: 400,
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

  const smtpUser = Deno.env.get('SMTP_USER')!;
  const transporter = nodemailer.createTransport({
    host: Deno.env.get('SMTP_HOST'),
    port: Number(Deno.env.get('SMTP_PORT') || '587'),
    secure: Number(Deno.env.get('SMTP_PORT') || '587') === 465,
    auth: {
      user: smtpUser,
      pass: Deno.env.get('SMTP_PASSWORD'),
    },
  });

  try {
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
