/**
 * docuSnap — API proxy (Cloudflare Worker, free tier)
 *
 * Routes:
 *   POST /check_liveness  → ID R&D liveness API
 *   POST /anthropic       → Anthropic Messages API (Claude Vision)
 *
 * Deploy:
 *   1. wrangler deploy  (or paste into the Cloudflare dashboard)
 *
 * Secrets (set in dashboard or via wrangler secret put <NAME>):
 *   IDRND_API_KEY      — ID R&D liveness API key
 *   ANTHROPIC_API_KEY   — Anthropic API key (sk-ant-...)
 */

const IDRND_URL    = 'https://idlivedoc-rest-api.idrnd.net/check_liveness';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    const path = new URL(request.url).pathname;

    // ── ID R&D liveness ───────────────────────────────────────────────
    if (path === '/check_liveness') {
      const body = await request.arrayBuffer();
      const upstream = await fetch(IDRND_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key':    env.IDRND_API_KEY,
        },
        body,
      });
      const data = await upstream.arrayBuffer();
      return new Response(data, {
        status:  upstream.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // ── Anthropic Messages API ────────────────────────────────────────
    if (path === '/anthropic') {
      if (!env.ANTHROPIC_API_KEY) {
        return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...CORS },
        });
      }

      const body = await request.arrayBuffer();
      const upstream = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body,
      });
      const data = await upstream.arrayBuffer();
      return new Response(data, {
        status:  upstream.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    return new Response('Not found. POST /check_liveness or /anthropic', {
      status: 404,
      headers: CORS,
    });
  },
};
