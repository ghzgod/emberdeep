// Cloudflare Worker — Mistral proxy for Emberdeep (TODO 891).
//
// WHY: a GitHub Pages site is 100% static client JS, so an API key shipped in it
// is public and gets scraped/abused in minutes. This tiny Worker holds the
// Mistral key SERVER-SIDE (as an encrypted Cloudflare secret), only answers
// requests from the game's own origin(s), and forwards chat completions to
// Mistral. The browser calls THIS worker's URL with NO key.
//
// DEPLOY (see worker/README.md for the full walk-through):
//   1. Edit ALLOWED_ORIGINS below to your GitHub Pages origin.
//   2. cd worker && npx wrangler secret put MISTRAL_API_KEY   (paste your key)
//   3. npx wrangler deploy
//   4. Paste the printed https://…workers.dev URL into WORKER_ENDPOINT in
//      src/ai/llm.js (or set localStorage 'emberdeep-llm-worker' for a quick test).

// The ONLY origins allowed to use this proxy. Add/replace with your real Pages
// origin (scheme + host, no path). Requests from anywhere else get 403, so the
// worker can't be used as a free open Mistral relay.
const ALLOWED_ORIGINS = [
  'https://YOUR-USERNAME.github.io', // <-- your GitHub Pages origin
  'http://localhost:5173',           // local Vite dev
];

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const MODEL = 'mistral-small-latest'; // small, fast, cheap - fine for tavern banter

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: cors });
    // Lock the proxy to the game's own origin(s).
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response('Forbidden', { status: 403, headers: cors });
    if (!env.MISTRAL_API_KEY) return new Response('Server not configured', { status: 500, headers: cors });

    let body;
    try { body = await request.json(); } catch { return new Response('Bad Request', { status: 400, headers: cors }); }
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages) return new Response('Bad Request', { status: 400, headers: cors });

    let upstream;
    try {
      upstream = await fetch(MISTRAL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.MISTRAL_API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: typeof body.temperature === 'number' ? body.temperature : 0.9,
          max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 120,
        }),
      });
    } catch {
      return new Response('Upstream error', { status: 502, headers: cors });
    }
    // Pass Mistral's OpenAI-compatible JSON straight back (choices[0].message.content).
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};
