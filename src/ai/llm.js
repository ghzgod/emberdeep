// Keyless LLM text generation for NPC dialogue (Obsidian 801).
//
// Uses LLM7.io's OpenAI-compatible endpoint. It needs NO account, NO signup and
// NO API key - so there is nothing in this source to steal or abuse (the user's
// explicit requirement: a leaked key must not affect them; there is no key).
// CORS is open, so the browser calls it directly. (Pollinations was the first
// pick but now gates BROWSER requests behind Cloudflare Turnstile - 403 - so it
// only works server-side; LLM7 still serves the browser keyless.)
//
// It is a best-effort public service, NOT a stable backend (models 503 under
// load): callers MUST treat this as an OPPORTUNISTIC enhancement over their own
// canned lines. This module returns null (never throws) on any failure and
// trips a short circuit-breaker after repeated failures so we never hammer a
// struggling endpoint or make the player wait on it.

const ENDPOINT = 'https://api.llm7.io/v1/chat/completions';
// codestral-latest is the one model LLM7 still serves KEYLESS (all the gpt-5.x /
// claude / deepseek models now 401 = require a key; devstral is 402 = paid).
// It's a small, free, fast Mistral model (~0.6s) that handles casual dialogue
// fine. Free + lightweight, exactly what we want; max_tokens capped low below.
const MODELS = ['codestral-latest'];
const DEFAULT_TIMEOUT = 6000;   // opportunistic - never blocks the player
const FAIL_LIMIT = 3;           // consecutive failures before we back off
const COOLDOWN_MS = 90000;      // ...and for how long we stay off

class LLM {
  constructor() {
    this.fails = 0;
    this.mutedUntil = 0;
  }

  // True unless the circuit-breaker is currently tripped.
  get ready() { return Date.now() >= this.mutedUntil; }

  // messages: [{ role, content }]. Returns the assistant text, or null on any
  // failure/timeout/empty (caller falls back to its canned lines). Never throws.
  async chat(messages, { timeout = DEFAULT_TIMEOUT, temperature = 0.9 } = {}) {
    if (!this.ready) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      // Try each keyless model until one answers (free models 503 under load).
      for (const model of MODELS) {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, temperature, max_tokens: 90 }),
          signal: ctrl.signal,
          cache: 'no-store',
        }).catch(() => null);
        if (!res) break; // network/abort - stop trying this round
        if (res.status === 503) continue; // model busy, try the next one
        if (!res.ok) return this._fail();
        const data = await res.json().catch(() => null);
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== 'string' || !text.trim()) return this._fail();
        this.fails = 0;
        return text.trim();
      }
      return this._fail();
    } catch {
      return this._fail();
    } finally {
      clearTimeout(timer);
    }
  }

  _fail() {
    if (++this.fails >= FAIL_LIMIT) { this.mutedUntil = Date.now() + COOLDOWN_MS; this.fails = 0; }
    return null;
  }
}

export const llm = new LLM();
