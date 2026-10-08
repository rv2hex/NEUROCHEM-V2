/**
 * Ollama client (OpenAI-compatible /v1/chat/completions).
 *
 * Zero dependencies: Node 20 `fetch`. Failures throw an `OllamaError`
 * so the caller can fall back to candidate skeletons.
 *
 *   POST {endpoint}/v1/chat/completions
 *   { model, messages, temperature, seed, stream: false }
 */

export class OllamaError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "OllamaError";
    this.cause = cause;
  }
}

export const OLLAMA_DEFAULTS = {
  endpoint: process.env.OLLAMA_ENDPOINT || "http://localhost:11434",
  // 1.5b, not 3b: this target is a 2-core / 4-thread laptop CPU with 4 GB of
  // headroom and no swap. 3b needs ~3 GB resident and turns a one-line reply
  // into a 20 s wait; 1.5b answers in 1-6 s and still follows the 1-3
  // sentence contract. Override with OLLAMA_MODEL for anything else.
  model: process.env.OLLAMA_MODEL || "qwen2.5:1.5b",
  temperature: 0.8,
  timeout_ms: 60000,
  /**
   * Cap generated tokens. Without it a verbose reply runs until timeout_ms
   * kills the request — one turn in a live session burned all 60 s and fell
   * back to a candidate. The contract is 1-3 sentences (~60 tokens), so 160
   * leaves headroom while making the worst case bounded and fast.
   */
  max_tokens: 160,
};

/** Is the endpoint answering? Cheap liveness probe. */
export async function ollamaUp(endpoint = OLLAMA_DEFAULTS.endpoint) {
  try {
    const res = await fetch(`${endpoint}/api/version`, {
      signal: AbortSignal.timeout(2000),
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
 * @param {object} [opts] { endpoint, model, temperature, seed, timeout_ms, max_tokens }
 */
export async function chat(messages, opts = {}) {
  const cfg = { ...OLLAMA_DEFAULTS, ...opts };
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    stream: false,
  };
  if (Number.isFinite(cfg.seed)) body.seed = cfg.seed;
  if (Number.isFinite(cfg.max_tokens)) body.max_tokens = cfg.max_tokens;

  let res;
  try {
    res = await fetch(`${cfg.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeout_ms),
    });
  } catch (err) {
    throw new OllamaError(`ollama unreachable at ${cfg.endpoint}`, err);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OllamaError(`ollama ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new OllamaError("ollama returned an empty message");
  }
  return content.trim();
}
