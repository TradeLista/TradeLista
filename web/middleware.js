// Gates the entire site behind HTTP Basic Auth until launch is ready.
// Free-tier alternative to Vercel's Pro-only "Deployment Protection" —
// remove this file (or the matcher below) once the site should go public.
//
// Requires two environment variables set in the Vercel project
// (Project Settings -> Environment Variables), NOT hardcoded here:
//   SITE_USER
//   SITE_PASSWORD

export const config = {
  matcher: '/:path*',
};

export default function middleware(request) {
  const authHeader = request.headers.get('authorization');

  if (authHeader) {
    const [scheme, encoded] = authHeader.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [user, pass] = atob(encoded).split(':');
      if (user === process.env.SITE_USER && pass === process.env.SITE_PASSWORD) {
        return;
      }
    }
  }

  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="TradeLista"' },
  });
}
