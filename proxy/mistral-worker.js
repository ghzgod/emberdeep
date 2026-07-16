// Emberdeep LLM proxy — Cloudflare Worker.
//
// WHY THIS EXISTS: GitHub Pages serves only static files, so ANY key placed in
// the game's JavaScript is public — bots scrape it within minutes and Mistral
// auto-revokes it. There is no "hidden" client-side secret. The only secure
// design is a proxy: this Worker holds the key server-side (as a Worker secret,
// never in this file), and the game calls the Worker URL with NO key attached.
//
// DEPLOY (free tier, ~100k requests/day):
//   1. npm i -g wrangler        (or use the Cloudflare dashboard "Quick edit")
//   2. wrangler login
//   3. wrangler deploy proxy/mistral-worker.js --name emberdeep-llm
//   4. wrangler secret put MISTRAL_API_KEY      (paste the key when prompted —
//      it lives encrypted in Cloudflare, NOT in git, NOT in the client)
//   5. Set ALLOWED_ORIGINS below to the game's Pages origin.
//   6. Point the game's LLM base URL at https://emberdeep-llm.<you>.workers.dev
//
// The key never touches the repo or the browser. Restricting Origin keeps other
// sites from spending your quota (not bulletproof — a determined caller can
// forge Origin — so also keep the Worker's own rate limit below).

const ALLOWED_ORIGINS = new Set([
  'https://ghzgod.github.io',      // the GitHub Pages origin
  'http://localhost:5173',         // local Vite dev
  'http://127.0.0.1:5173',
]);

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
// Only let the game reach chat completions, and cap the models it may request
// so a leaked Worker URL can't be pointed at something expensive.
const ALLOWED_MODELS = new Set(['mistral-small-latest', 'codestral-latest', 'open-mistral-nemo']);

function cors(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = cors(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers });
    if (!ALLOWED_ORIGINS.has(origin)) return new Response('Forbidden origin', { status: 403, headers });

    let body;
    try { body = await request.json(); } catch { return new Response('Bad JSON', { status: 400, headers }); }

    // Whitelist the model; default to the cheap small model.
    const model = ALLOWED_MODELS.has(body.model) ? body.model : 'mistral-small-latest';
    const payload = {
      model,
      messages: Array.isArray(body.messages) ? body.messages.slice(0, 24) : [],
      temperature: typeof body.temperature === 'number' ? body.temperature : 1.0,
      max_tokens: Math.min(Number(body.max_tokens) || 240, 512),
      ...(body.response_format ? { response_format: body.response_format } : {}),
    };
    if (!payload.messages.length) return new Response('No messages', { status: 400, headers });

    const upstream = await fetch(MISTRAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.MISTRAL_API_KEY}` },
      body: JSON.stringify(payload),
    });

    // Pass the upstream status through so the game's circuit breaker still sees
    // 429s and falls back to the keyless gateway / canned banks.
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });
  },
};
