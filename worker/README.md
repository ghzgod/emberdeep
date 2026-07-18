# Emberdeep Mistral proxy (Cloudflare Worker) — TODO 891

The game is a static GitHub Pages site, so an API key can't live in its client JS
(it'd be public and abused in minutes). This tiny Worker holds your **Mistral API
key server-side** as an encrypted Cloudflare secret, only answers requests from
the game's own origin, and forwards chat completions to Mistral. The browser
calls the Worker's URL with **no key**.

When configured, the game's LLM router (`src/ai/llm.js`) **prefers** this Worker
(reliable, not rate-limited) and falls back to the free keyless llm7 endpoint if
the Worker is unset or fails. Until you deploy + configure it, nothing changes —
the game keeps using llm7.

## One-time deploy (≈2 minutes)

You need a (free) Cloudflare account and your Mistral API key.

```bash
cd worker

# 1. Edit mistral-proxy.js -> ALLOWED_ORIGINS: put your GitHub Pages origin,
#    e.g. 'https://your-username.github.io'  (scheme + host, no path).

# 2. Log in + store the key as an encrypted secret (paste the key when prompted):
npx wrangler login
npx wrangler secret put MISTRAL_API_KEY

# 3. Deploy:
npx wrangler deploy
#    -> prints a URL like  https://emberdeep-mistral.<you>.workers.dev
```

## Point the game at it

Two ways:

- **Permanent:** paste the Worker URL into `WORKER_ENDPOINT` in
  `src/ai/llm.js`, then commit + push (GitHub Pages redeploys automatically).
- **Quick test (no rebuild):** in the game's browser console, run
  `localStorage.setItem('emberdeep-llm-worker', 'https://emberdeep-mistral.<you>.workers.dev')`
  and reload. (This overrides the constant for that browser only.)

That's it — tavern banter (and other NPC dialogue) then comes from Mistral
through your Worker, with the free llm7 endpoint as an automatic fallback.
