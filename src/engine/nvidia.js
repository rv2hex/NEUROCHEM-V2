/**
 * NVIDIA NIM client (OpenAI-compatible /v1/chat/completions).
 *
 * Zero dependencies: Node 20 `fetch`. Failures throw a `NvidiaError`
 * so the caller can fall back to candidate skeletons.
 * Key is NEVER hardcoded — set NVIDIA_API_KEY in the environment.
 *
 *   POST {endpoint}/v1/chat/completions
 *   { model, messages, temperature, stream: false }
 *
 * NOTE: Nemotron-style models spend tokens on hidden reasoning
 * (`reasoning_content`) BEFORE writing visible `content`. A 160-token cap
 * (enough for Ollama's local models) starves the answer entirely and the
 * API returns `content: null`. The full conversation prompt is ~1600
 * tokens and draws ~400+ reasoning tokens, so 2048 leaves room for the
 * reasoning plus a 1-3 sentence reply (verified live: `llm` first try).
 */

export class NvidiaError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "NvidiaError";
    this.cause = cause;
  }
}

export const NVIDIA_DEFAULTS = {
  endpoint: process.env.NVIDIA_ENDPOINT || "https://integrate.api.nvidia.com",
  model: process.env.NVIDIA_MODEL || "nvidia/nemotron-3-super-120b-a12b",
  temperature: 0.8,
  timeout_ms: 120000,
  /**
   * Reasoning budget + answer. See NOTE above: below ~512 a reasoning
   * model can return `content: null` with `finish_reason: "length"`,
   * which this client (correctly) reports as an empty message so the
   * caller falls back to a candidate skeleton.
   *
   * Anti-filler pressure. Without it the same closers loop forever
   * ("Tell me more.", "How'd it go?") — the persona repeats its favorite
   * shapes turn after turn. Sent only when finite, like seed/max_tokens.
   */
  max_tokens: 2048,
  presence_penalty: 0.6,
  frequency_penalty: 0.3,
};

/**
 * Streaming chat completion. Calls onToken(chunk) per delta and resolves
 * with the full trimmed text. Same error contract as chat(): failures throw
 * NvidiaError so the caller falls back. No retry here — a half-shown reply
 * must not silently restart.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [opts] { endpoint, model, temperature, seed, timeout_ms, max_tokens, presence_penalty, frequency_penalty, apiKey }
 * @param {(chunk: string) => void} [onToken]
 */
export async function chatStream(messages, opts = {}, onToken) {
  const cfg = { ...NVIDIA_DEFAULTS, ...opts };
  const apiKey = cfg.apiKey || process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new NvidiaError("NVIDIA_API_KEY is not set");
  }
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    stream: true,
  };
  if (Number.isFinite(cfg.seed)) body.seed = cfg.seed;
  if (Number.isFinite(cfg.max_tokens)) body.max_tokens = cfg.max_tokens;
  if (Number.isFinite(cfg.presence_penalty)) body.presence_penalty = cfg.presence_penalty;
  if (Number.isFinite(cfg.frequency_penalty)) body.frequency_penalty = cfg.frequency_penalty;

  let res;
  try {
    res = await fetch(`${cfg.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeout_ms),
    });
  } catch (err) {
    throw new NvidiaError(`nvidia unreachable at ${cfg.endpoint}`, err);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new NvidiaError(`nvidia ${res.status}: ${text.slice(0, 200)}`);
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buf = "";
  let full = "";
  let done = false;
  while (!done) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") {
        done = true;
        break;
      }
      try {
        const chunk = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof chunk === "string" && chunk) {
          full += chunk;
          if (onToken) onToken(chunk);
        }
      } catch {
        // Partial JSON split across TCP segments — it stays in buf.
      }
    }
  }

  if (typeof full !== "string" || !full.trim()) {
    throw new NvidiaError("nvidia returned an empty message");
  }
  return full.trim();
}

/** Is the endpoint answering with this key? Cheap liveness probe. */
export async function nvidiaUp(endpoint = NVIDIA_DEFAULTS.endpoint, apiKey = process.env.NVIDIA_API_KEY) {
  if (!apiKey) return false;
  try {
    const res = await fetch(`${endpoint}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * One chat completion. Returns the assistant text (trimmed).
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [opts] { endpoint, model, temperature, seed, timeout_ms, max_tokens, presence_penalty, frequency_penalty, apiKey }
 */
export async function chat(messages, opts = {}) {
  const cfg = { ...NVIDIA_DEFAULTS, ...opts };
  const apiKey = cfg.apiKey || process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new NvidiaError("NVIDIA_API_KEY is not set");
  }
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    stream: false,
  };
  if (Number.isFinite(cfg.seed)) body.seed = cfg.seed;
  if (Number.isFinite(cfg.max_tokens)) body.max_tokens = cfg.max_tokens;
  if (Number.isFinite(cfg.presence_penalty)) body.presence_penalty = cfg.presence_penalty;
  if (Number.isFinite(cfg.frequency_penalty)) body.frequency_penalty = cfg.frequency_penalty;

  let res;
  // One immediate retry on a network-level throw (transient blip, reset
  // connection). Timeouts (AbortError) are NOT retried — doubling a 120s
  // worst case helps nobody. HTTP statuses never retry here either: a 429
  // or 500 may clear by next turn, and the caller already falls back.
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(`${cfg.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeout_ms),
      });
      break;
    } catch (err) {
      lastErr = err;
      if (err?.name === "AbortError") break;
    }
  }
  if (!res) {
    throw new NvidiaError(`nvidia unreachable at ${cfg.endpoint}`, lastErr);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new NvidiaError(`nvidia ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new NvidiaError("nvidia returned an empty message");
  }
  return content.trim();
}
