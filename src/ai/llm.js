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
// 891: optional Mistral proxy Worker (worker/mistral-proxy.js) that holds the
// real Mistral key SERVER-SIDE. When a Worker URL is configured - paste your
// deployed https://…workers.dev URL below, or set localStorage
// 'emberdeep-llm-worker' for a quick per-browser test - the router PREFERS it
// (reliable, not rate-limited/Turnstile-gated like the free llm7 endpoint) and
// falls back to llm7 if the Worker is unset or fails. Empty = current behavior.
const WORKER_ENDPOINT = '';
function workerUrl() {
  try { const o = localStorage.getItem('emberdeep-llm-worker'); if (o) return o; } catch { /* no localStorage */ }
  return WORKER_ENDPOINT;
}
// codestral-latest is the one model LLM7 still serves KEYLESS (all the gpt-5.x /
// claude / deepseek models now 401 = require a key; devstral is 402 = paid).
// It's a small, free, fast Mistral model (~0.6s) that handles casual dialogue
// fine. Free + lightweight, exactly what we want; max_tokens capped low below.
const MODELS = ['codestral-latest'];
const DEFAULT_TIMEOUT = 6000;   // opportunistic - never blocks the player
const FAIL_LIMIT = 3;           // consecutive failures before we back off
const COOLDOWN_MS = 90000;      // ...and for how long we stay off

// Response cache (Obsidian 887): identical prompts return a stored answer
// instead of spending a request, so repeated persona/scenario prompts (an
// NPC's opener, a common beat) never re-hit the free endpoint. Keyed by a hash
// of (messages + sampling params); persisted in localStorage with a size cap
// and a TTL. Deterministic prompts benefit; high-temperature unique-context
// turns naturally miss (their key varies every time), which is fine.
const CACHE_KEY = 'emberdeep-llm-cache-v1';
const CACHE_MAX = 300;          // entries; oldest evicted past this
const CACHE_TTL_MS = 14 * 24 * 3600 * 1000; // 2 weeks

function hashStr(s) {
  // FNV-1a 32-bit - tiny, dependency-free, good enough for a cache key.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

class LLM {
  constructor() {
    this.fails = 0;
    this.mutedUntil = 0;
    this._cache = null; // lazy-loaded from localStorage
  }

  // True unless the circuit-breaker is currently tripped.
  get ready() { return Date.now() >= this.mutedUntil; }

  _loadCache() {
    if (this._cache) return this._cache;
    try { this._cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
    catch { this._cache = {}; }
    return this._cache;
  }

  _cacheGet(key) {
    const c = this._loadCache();
    const e = c[key];
    if (!e) return null;
    if (Date.now() - e.t > CACHE_TTL_MS) { delete c[key]; return null; }
    return e.v;
  }

  _cachePut(key, value) {
    const c = this._loadCache();
    c[key] = { v: value, t: Date.now() };
    const keys = Object.keys(c);
    if (keys.length > CACHE_MAX) {
      // evict the oldest entries down to the cap
      keys.sort((a, b) => c[a].t - c[b].t);
      for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete c[k];
    }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* quota - skip */ }
  }

  // messages: [{ role, content }]. Returns the assistant text, or null on any
  // failure/timeout/empty (caller falls back to its canned lines). Never throws.
  // Pass cache:false to force a fresh call (e.g. deliberately-varied banter).
  async chat(messages, { timeout = DEFAULT_TIMEOUT, temperature = 0.9, maxTokens = 90, cache = true } = {}) {
    // Cache lookup first - a hit costs zero requests and returns instantly even
    // while the circuit-breaker is tripped.
    const cacheKey = cache ? hashStr(JSON.stringify(messages) + `|${temperature}|${maxTokens}`) : null;
    if (cacheKey) { const hit = this._cacheGet(cacheKey); if (hit != null) return hit; }
    if (!this.ready) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      // 891: prefer the Mistral proxy Worker when configured - it holds the key
      // server-side and isn't rate-limited/Turnstile-gated. On any failure we
      // fall through to the keyless llm7 endpoint below (unchanged behavior).
      const wurl = workerUrl();
      if (wurl) {
        const res = await fetch(wurl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages, temperature, max_tokens: maxTokens }),
          signal: ctrl.signal,
          cache: 'no-store',
        }).catch(() => null);
        if (res && res.ok) {
          const data = await res.json().catch(() => null);
          const text = data?.choices?.[0]?.message?.content;
          if (typeof text === 'string' && text.trim()) {
            this.fails = 0;
            const out = text.trim();
            if (cacheKey) this._cachePut(cacheKey, out);
            return out;
          }
        }
        // Worker unset/failed - fall through to llm7 rather than giving up.
      }
      // Try each keyless model until one answers (free models 503 under load).
      for (const model of MODELS) {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
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
        const out = text.trim();
        if (cacheKey) this._cachePut(cacheKey, out); // remember for identical prompts (887)
        return out;
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
