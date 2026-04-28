// stripe-relay.js -- Cloudflare Worker for NenanaWISP Stripe webhooks.
//
// Stripe webhook delivery to Apps Script /exec fails with 404 because Apps
// Script always responds with a 302 redirect to a one-time-use URL on
// script.googleusercontent.com. Stripe preserves POST through the redirect
// but googleusercontent.com only accepts GET. Result: 4xx + Google Drive
// 404 page.
//
// This Worker is a thin relay that does the redirect dance correctly:
//   1. Stripe POSTs to <worker-url>?secret=<value>
//   2. Worker validates secret matches WEBHOOK_URL_SECRET env var
//   3. Worker POSTs the body to Apps Script /exec
//   4. Worker reads the 302 Location header, GETs the redirect target
//      to retrieve the cached response, returns it to Stripe
//
// Env vars (Workers > Settings > Variables and Secrets):
//   APPS_SCRIPT_URL     - https://script.google.com/macros/s/.../exec
//                         (no ?secret= suffix; Worker adds it)
//   WEBHOOK_URL_SECRET  - same value as Apps Script Script Property of the
//                         same name

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (!env.APPS_SCRIPT_URL || !env.WEBHOOK_URL_SECRET) {
      return new Response('Worker not configured', { status: 500 });
    }

    // Auth: require the same URL secret that Apps Script enforces.
    const url = new URL(request.url);
    const provided = url.searchParams.get('secret') || '';
    if (provided !== env.WEBHOOK_URL_SECRET) {
      return new Response('unauthorized', { status: 401 });
    }

    const body = await request.text();

    // Build the upstream URL with the same ?secret= so Apps Script's own
    // webhook auth check passes.
    const sep = env.APPS_SCRIPT_URL.includes('?') ? '&' : '?';
    const upstreamUrl = env.APPS_SCRIPT_URL + sep +
      'secret=' + encodeURIComponent(env.WEBHOOK_URL_SECRET);

    // Step 1: POST. Apps Script will respond 302 to googleusercontent.com.
    const post = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': request.headers.get('Content-Type') || 'application/json'
      },
      body: body,
      redirect: 'manual'
    });

    if (post.status === 301 || post.status === 302) {
      const location = post.headers.get('Location');
      if (!location) {
        return new Response('Apps Script returned redirect with no Location', { status: 502 });
      }
      // Step 2: GET the cached response from googleusercontent.com.
      const get = await fetch(location, { method: 'GET' });
      const text = await get.text();
      return new Response(text, {
        status: get.status,
        headers: {
          'Content-Type': get.headers.get('Content-Type') || 'text/plain'
        }
      });
    }

    // Direct response without redirect (rare for Apps Script). Pass through.
    const text = await post.text();
    return new Response(text, {
      status: post.status,
      headers: {
        'Content-Type': post.headers.get('Content-Type') || 'text/plain'
      }
    });
  }
};
