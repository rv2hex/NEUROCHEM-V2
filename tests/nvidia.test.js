/**
 * NVIDIA NIM engine — client contract (mocked) + live Nemotron turns.
 *
 * Covers src/engine/nvidia.js, which nothing else imports yet.
 * Order per testing skill: happy path → edge cases → error cases → integration.
 *
 * Setup: live tests need NVIDIA_API_KEY in the environment and skip
 * automatically without it, so `npm test` stays green on a cold box.
 * Model/entitlement note (probed 2026-10-08): small models (granite-3b,
 * gemma-2b/4b, mistral-7b, zamba2-7b) return 404 "not found for account" on a
 * 7-day key, llama-3.1-8b is EOL (410), deepseek-v4.1-flash stalls. The
 * smallest model that actually answers is nvidia/nemotron-3-super-120b-a12b.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createConversation } from "../src/interface/converse.js";
import { validateReply } from "../src/interface/validate.js";
import { chat, chatStream, nvidiaUp, NVIDIA_DEFAULTS, NvidiaError } from "../src/engine/nvidia.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slang = JSON.parse(readFileSync(join(ROOT, "config", "slang.json"), "utf8"));

const MODEL = process.env.NVIDIA_MODEL || NVIDIA_DEFAULTS.model;
const LIVE_KEY = process.env.NVIDIA_API_KEY || null;

/** Probe once at load: without a key (or a down endpoint) live tests skip. */
const live = await nvidiaUp(NVIDIA_DEFAULTS.endpoint, LIVE_KEY);
const SKIP_LIVE = live ? false : "nvidia not reachable (NVIDIA_API_KEY missing or endpoint down)";

const withNvidia = {
  engine: { chat },
  model: MODEL,
  timeout_ms: 180000,
  max_tokens: 2048,
};

// ==================== HAPPY PATH (mocked fetch) ====================

test("nvidia chat() trims content and posts model + budget + auth header", async () => {
  const real = globalThis.fetch;
  const seen = {};
  try {
    globalThis.fetch = async (url, opts) => {
      seen.url = url;
      seen.headers = opts.headers;
      seen.body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "  yo choom  " } }] }) };
    };
    const out = await chat([{ role: "user", content: "hi" }], { apiKey: "k-test" });
    assert.equal(out, "yo choom");
    assert.ok(seen.url.endsWith("/v1/chat/completions"), `url: ${seen.url}`);
    assert.equal(seen.headers.authorization, "Bearer k-test");
    assert.equal(seen.body.model, NVIDIA_DEFAULTS.model, "default model sent");
    assert.equal(seen.body.max_tokens, 2048, "reasoning-sized budget sent");
    assert.equal(seen.body.stream, false);
    assert.equal(seen.body.presence_penalty, 0.6, "anti-filler pressure sent");
    assert.equal(seen.body.frequency_penalty, 0.3, "repetition pressure sent");
  } finally {
    globalThis.fetch = real;
  }
});

// ==================== EDGE CASES ====================

test("nvidia chat() sends seed only when finite, honors overrides", async () => {
  const real = globalThis.fetch;
  const bodies = [];
  try {
    globalThis.fetch = async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    };
    await chat([{ role: "user", content: "hi" }], { apiKey: "k", seed: 7, model: "m/custom", max_tokens: 64 });
    assert.equal(bodies.at(-1).seed, 7, "finite seed sent");
    assert.equal(bodies.at(-1).model, "m/custom", "model override sent");
    assert.equal(bodies.at(-1).max_tokens, 64, "budget override sent");
    await chat([{ role: "user", content: "hi" }], { apiKey: "k", seed: NaN });
    assert.ok(!("seed" in bodies.at(-1)), "non-finite seed omitted");
  } finally {
    globalThis.fetch = real;
  }
});

test("nvidiaUp() returns false with no key and boolean otherwise", async () => {
  assert.equal(await nvidiaUp(NVIDIA_DEFAULTS.endpoint, null), false, "no key reads as down");
  assert.equal(await nvidiaUp(NVIDIA_DEFAULTS.endpoint, ""), false, "empty key reads as down");
  const up = await nvidiaUp(NVIDIA_DEFAULTS.endpoint, "k-dead");
  assert.equal(typeof up, "boolean");
});

// ==================== ERROR CASES ====================

test("nvidia chat() without a key fails fast as NvidiaError", async () => {
  const saved = process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  try {
    await assert.rejects(() => chat([{ role: "user", content: "hi" }], { apiKey: undefined }),
      (e) => e instanceof NvidiaError && /NVIDIA_API_KEY is not set/.test(e.message));
  } finally {
    if (saved !== undefined) process.env.NVIDIA_API_KEY = saved;
  }
});

test("nvidia chat() reports HTTP failures and empty messages as NvidiaError", async () => {
  const real = globalThis.fetch;
  try {
    // Transient blip heals on immediate retry (called twice, answers once).
    let calls = 0;
    globalThis.fetch = async () => {
      if (++calls === 1) throw new Error("reset");
      return { ok: true, json: async () => ({ choices: [{ message: { content: "healed" } }] }) };
    };
    assert.equal(await chat([{ role: "user", content: "hi" }], { apiKey: "k" }), "healed");
    assert.equal(calls, 2, "retried once after a network throw");

    // Timeouts never retry — doubling the worst case helps nobody.
    let timeoutCalls = 0;
    const abort = new Error("timed out");
    abort.name = "AbortError";
    globalThis.fetch = async () => { timeoutCalls++; throw abort; };
    await assert.rejects(() => chat([{ role: "user", content: "hi" }], { apiKey: "k", timeout_ms: 10 }),
      (e) => e instanceof NvidiaError && /unreachable/.test(e.message));
    assert.equal(timeoutCalls, 1, "no retry after AbortError");

    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "invalid key" });
    await assert.rejects(() => chat([{ role: "user", content: "hi" }], { apiKey: "k" }),
      (e) => e instanceof NvidiaError && /nvidia 401/.test(e.message));

    // Reasoning budget exhausted: content null, reasoning only.
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: null, reasoning_content: "..." } }] }),
    });
    await assert.rejects(() => chat([{ role: "user", content: "hi" }], { apiKey: "k" }),
      (e) => e instanceof NvidiaError && /empty/.test(e.message));
  } finally {
    globalThis.fetch = real;
  }
});

// ==================== INTEGRATION (live, skip-gated) ====================

test("live: Nemotron turn comes back validated through the full bridge",
  { skip: SKIP_LIVE, timeout: 300000 },
  async (t) => {
    const conv = createConversation({ seed: 61, root: ROOT, dialectPack: slang });
    const r = await conv.converse("i got the job at militech", withNvidia);

    t.diagnostic(`model=${MODEL} source=${r.source} reply=${JSON.stringify(r.reply)}`);
    assert.ok(["llm", "llm-repaired"].includes(r.source), `model was actually used: ${r.source}`);

    const v = validateReply(r.reply, { userText: "i got the job at militech" });
    assert.deepEqual(v.hard, [], `validator rejected live output: ${v.hard.join("; ")}`);
    assert.ok(r.candidates.length >= 3, `skeleton set offered: ${r.candidates.length}`);
    assert.ok(r.candidates.every((c) => c.text === undefined), "no finished sentence in a candidate");
  });

test("live: two turns stay on-model with no verbatim repeat",
  { skip: SKIP_LIVE, timeout: 600000 },
  async (t) => {
    const conv = createConversation({ seed: 62, root: ROOT, dialectPack: slang });
    const lines = ["hey chole", "i got the job at militech"];
    const replies = [];
    for (const line of lines) {
      const r = await conv.converse(line, withNvidia);
      t.diagnostic(`${JSON.stringify(line)} -> [${r.source}] ${JSON.stringify(r.reply)}`);
      assert.ok(["llm", "llm-repaired"].includes(r.source), `${line} fell off-model: ${r.source}`);
      assert.ok(validateReply(r.reply, { userText: line, history: replies }).ok,
        `validator rejected ${JSON.stringify(r.reply)}`);
      replies.push(r.reply);
    }
    assert.equal(new Set(replies.map((s) => s.toLowerCase().trim())).size, replies.length, "replies distinct");
    assert.equal(conv.turn, 2);
    const onModel = conv.trainingData().filter((e) => e.source.startsWith("llm"));
    assert.equal(onModel.length, 2, "both adapter records came from the model");
    assert.ok(onModel.every((e) => e.tones), "records tagged with tones");
  });

// ==================== STREAMING (mocked SSE) ====================

function sseResponse(chunks) {
  const enc = new TextEncoder();
  const queue = chunks.map((c) => enc.encode(c));
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true, value: undefined }),
        };
      },
    },
  };
}

const sse = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

test("nvidia chatStream() concatenates deltas across split segments", async () => {
  const real = globalThis.fetch;
  const seen = {};
  try {
    // Second chunk split mid-JSON, as TCP loves to do.
    const raw = sse("Hel") + sse("lo, ").slice(0, 20);
    const rest = sse("lo, ").slice(20) + sse("choom.") + "data: [DONE]\n\n";
    globalThis.fetch = async (url, opts) => {
      seen.body = JSON.parse(opts.body);
      seen.accept = opts.headers.accept;
      return sseResponse([raw, rest]);
    };
    const heard = [];
    const out = await chatStream([{ role: "user", content: "hi" }], { apiKey: "k" }, (c) => heard.push(c));
    assert.equal(out, "Hello, choom.");
    assert.deepEqual(heard, ["Hel", "lo, ", "choom."]);
    assert.equal(seen.body.stream, true, "stream flag sent");
    assert.equal(seen.body.presence_penalty, 0.6, "penalties ride along");
    assert.match(seen.accept, /event-stream/);
  } finally {
    globalThis.fetch = real;
  }
});

test("nvidia chatStream() failures throw NvidiaError", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => "busy" });
    await assert.rejects(() => chatStream([{ role: "user", content: "hi" }], { apiKey: "k" }),
      (e) => e instanceof NvidiaError && /nvidia 429/.test(e.message));
    // Reasoning-only deltas carry no content: still an empty message.
    globalThis.fetch = async () => sseResponse([sse(""), "data: [DONE]\n\n"]);
    await assert.rejects(() => chatStream([{ role: "user", content: "hi" }], { apiKey: "k" }),
      (e) => e instanceof NvidiaError && /empty/.test(e.message));
    await assert.rejects(() => chatStream([{ role: "user", content: "hi" }], { apiKey: undefined }),
      (e) => e instanceof NvidiaError && /NVIDIA_API_KEY is not set/.test(e.message));
  } finally {
    globalThis.fetch = real;
  }
});

test("converse streams tokens with attempt index when the engine can", async () => {
  const conv = createConversation({ seed: 71, root: ROOT, dialectPack: slang });
  const heard = [];
  const engine = {
    chatStream: async (msgs, opts, cb) => {
      cb("Hel");
      cb("lo.");
      return "Hello.";
    },
  };
  const r = await conv.converse("hey chole", {
    engine,
    onToken: (tok, attempt) => heard.push([tok, attempt]),
  });
  assert.equal(r.source, "llm");
  assert.equal(r.reply, "Hello.");
  assert.deepEqual(heard, [["Hel", 0], ["lo.", 0]]);
  assert.equal(r.streamed, true);
});

test("converse without chatStream ignores onToken and reports unstreamed", async () => {
  const conv = createConversation({ seed: 72, root: ROOT, dialectPack: slang });
  let called = 0;
  const r = await conv.converse("hey chole", {
    engine: { chat: async () => "Yo." },
    onToken: () => { called++; },
  });
  assert.equal(r.source, "llm");
  assert.equal(called, 0, "classic engines never see tokens");
  assert.equal(r.streamed, false);
});
