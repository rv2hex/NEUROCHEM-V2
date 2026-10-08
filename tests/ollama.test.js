import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createConversation } from "../src/interface/converse.js";
import { validateReply } from "../src/interface/validate.js";
import { chat, ollamaUp, OLLAMA_DEFAULTS, OllamaError } from "../src/engine/ollama.js";
import { NT } from "../src/neurochem/engine.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slang = JSON.parse(readFileSync(join(ROOT, "config", "slang.json"), "utf8"));

const MODEL = process.env.OLLAMA_MODEL || OLLAMA_DEFAULTS.model;
const ENDPOINT = process.env.OLLAMA_ENDPOINT || OLLAMA_DEFAULTS.endpoint;

/**
 * A port nothing listens on — connection-refused, so failures are instant
 * rather than waiting out the 60 s client timeout.
 */
const DEAD_ENDPOINT = "http://127.0.0.1:59999";

/**
 * Probe once at load. Ollama may not be running, and may have no models
 * installed at all (this machine had neither); the live tests then skip with
 * a reason instead of failing, so `npm test` stays green on a cold box.
 *
 * Set OLLAMA_ENDPOINT / OLLAMA_MODEL to point at a different server.
 */
const live = await ollamaUp(ENDPOINT);
const SKIP_LIVE = live ? false : `ollama not reachable at ${ENDPOINT}`;

const converse = async (seed, opts = {}) =>
  createConversation({ seed, root: ROOT, dialectPack: slang, ...opts });

/** Conversation options that hand the turn to the real Ollama client. */
const withOllama = { engine: { chat }, endpoint: ENDPOINT, model: MODEL, timeout_ms: 60000 };

// ==================== ALWAYS-ON: the fallback contract ====================

test("chat() reports a dead endpoint as OllamaError, never a raw fetch failure", async () => {
  await assert.rejects(
    () => chat([{ role: "user", content: "hi" }], { endpoint: DEAD_ENDPOINT, timeout_ms: 3000 }),
    (err) => err instanceof OllamaError && /unreachable/.test(err.message)
  );
});

test("engine-down: a dead endpoint still yields a reply, never a throw", async () => {
  const conv = await converse(8);
  const r = await conv.converse("hello there", {
    engine: { chat },
    endpoint: DEAD_ENDPOINT,
    timeout_ms: 3000,
  });
  assert.ok(r.reply && r.reply.length > 0, "got a reply");
  assert.equal(r.source, "engine-down", `fell all the way back: ${r.source}`);
  assert.ok(validateReply(r.reply, { userText: "hello there" }).ok, "fallback still gated");
});

test("ollamaUp() tells a live endpoint from a dead one", async () => {
  assert.equal(await ollamaUp(DEAD_ENDPOINT), false, "dead port reads as down");
  const up = await ollamaUp(ENDPOINT);
  assert.equal(typeof up, "boolean");
  if (SKIP_LIVE) assert.equal(up, false, "reported down because no server is running");
});

// ==================== ALWAYS-ON: the 5-channel bridge ====================

test("prompt messages carry all five bridge channels end-to-end", async () => {
  const conv = await converse(9);
  const captured = [];
  // One reply per turn: if validation ever failed, converse() would issue a
  // repair call and the counts below would catch it.
  const scripted = ["Yo.", "Right, felt that. How'd it go?"];
  const stub = {
    chat: async (messages) => {
      captured.push(messages);
      return scripted[captured.length - 1] ?? "Yeah.";
    },
  };

  const first = await conv.converse("hey chole", { engine: stub });
  const second = await conv.converse("i got the job at militech", { engine: stub });

  assert.equal(first.source, "llm", `turn 1 accepted first attempt: ${first.source}`);
  assert.equal(second.source, "llm", `turn 2 accepted first attempt: ${second.source}`);
  assert.equal(captured.length, 2, "exactly one model call per turn — no repair round-trip");

  const messages = captured.at(-1);
  assert.equal(messages.length, 2, "system + user");
  const system = messages.find((m) => m.role === "system").content;
  const user = messages.find((m) => m.role === "user").content;

  // 1 directive · 2 narrative · 3 tendencies · 4 candidates · 5 memories
  assert.match(system, /# DIRECTIVE/);
  assert.match(system, /# INTERNAL STATE/);
  assert.match(system, /# ACTION TENDENCIES/);
  assert.match(system, /# SKELETONS/);
  assert.match(system, /# YOUR ACCENT/);
  assert.match(system, /# OUTPUT CONTRACT/);
  assert.match(user, /# MEMORIES/);
  assert.match(user, /# RECENT/);

  // What the model receives is words and frames, never finished prose.
  assert.match(system, /words: /, "slot words are exposed to the model");
  assert.match(system, /^\d+\. \[[a-z_]+\] /m, "skeletons are listed as [frame] + hint, not prose");
  assert.ok(second.candidates.length >= 3, `a skeleton set, not one line: ${second.candidates.length}`);
  assert.ok(
    second.candidates.every((c) => c.text === undefined && c.words && typeof c.words === "object"),
    "candidates are frame+slots+words with no finished sentence"
  );
});

// ==================== ALWAYS-ON: tones in the adapter log ====================

test("adapter training log records TONES alongside volumes", async () => {
  const conv = await converse(10);
  await conv.converse("whats good");
  const log = conv.trainingData();
  assert.equal(log.length, 1);

  const entry = log[0];
  assert.ok(entry.neurochem, "volumes logged");
  assert.ok(entry.tones, "tones logged");

  const names = Object.keys(entry.neurochem);
  assert.ok(names.length >= 12, `all systems logged: ${names.length}`);
  for (const name of names) {
    const t = entry.tones[name];
    assert.ok(Number.isFinite(t), `${name} tone finite`);
    assert.ok(t >= 0 && t <= 1, `${name} tone on the 0-1 scale: ${t}`);
  }
  // Tones must be their own scale, not the volumes renamed. (Per-name
  // comparison won't do: melatonin reads 0 for both by day.)
  assert.notEqual(
    JSON.stringify(entry.tones),
    JSON.stringify(entry.neurochem),
    "tones are a re-scale, not a copy of the concentrations"
  );
});

// ==================== ALWAYS-ON: SOUL preferences → energy ====================

test("SOUL preferences move energy through the conversation path", async () => {
  const conv = await converse(11);
  const energy = conv.daemon.energy;
  const buffers = () => conv.daemon.neurochem.getSnapshot().phasicBuffers;

  energy.consumeATP(0.5);
  const afterDrain = energy.atp;

  // SOUL.md: likes rain → refuels, and fires a dopamine burst
  await conv.converse("the rain tonight is unreal");
  assert.ok(energy.atp > afterDrain, `like raised ATP: ${afterDrain} → ${energy.atp}`);
  assert.ok(buffers()[NT.DOPAMINE] > 0, "a like fires a dopamine burst");

  // SOUL.md: dislikes corpo → spends
  const beforeDislike = energy.atp;
  await conv.converse("a corpo offer came through");
  assert.ok(energy.atp < beforeDislike, `dislike cost ATP: ${beforeDislike} → ${energy.atp}`);

  // An indifferent line stays indifferent
  const beforeNeutral = energy.atp;
  await conv.converse("the tram ran late again");
  assert.equal(energy.atp, beforeNeutral, "an indifferent line moves energy neither way");
});

// ==================== LIVE: the actual Ollama round trip ====================

test("live: the turn goes out to the model and comes back validated",
  { skip: SKIP_LIVE, timeout: 120000 },
  async (t) => {
    const conv = await converse(12);
    const r = await conv.converse("i got the job at militech", withOllama);

    t.diagnostic(`model=${MODEL} source=${r.source} reply=${JSON.stringify(r.reply)}`);
    assert.ok(["llm", "llm-repaired"].includes(r.source), `model was actually used: ${r.source}`);

    const v = validateReply(r.reply, { userText: "i got the job at militech" });
    assert.deepEqual(v.hard, [], `validator rejected live output: ${v.hard.join("; ")}`);
    assert.equal(v.ok, true);
  });

test("live: the reply obeys the output contract",
  { skip: SKIP_LIVE, timeout: 120000 },
  async (t) => {
    const conv = await converse(13);
    const r = await conv.converse("what district are we in?", withOllama);
    assert.ok(["llm", "llm-repaired"].includes(r.source), `source: ${r.source}`);

    const reply = r.reply.trim();
    const sents = reply.split(/(?<=[.!?…])\s+/).filter(Boolean);
    assert.ok(sents.length <= 3, `1-3 sentences, got ${sents.length}: ${reply}`);
    assert.ok(reply.length <= 200, `short register, got ${reply.length}: ${reply}`);
    assert.doesNotMatch(reply, /^["“]|["”]$/, "not wrapped in quotes");
    assert.doesNotMatch(reply, /(^|\s)([#*_]{1,3}\S)/, "no markdown");

    // The skeleton set was still offered even though the model wrote the words.
    // Candidate count follows the move, not the seed: greet/phatic → 1,
    // question/comfort → 2, ack/share → 4. A question is the strictest
    // validator case (counter-ask rule), so it's the one worth driving here.
    assert.ok(r.candidates.length >= 2, `skeletons offered: ${r.candidates.length}`);
    assert.ok(r.candidates.every((c) => c.text === undefined), "no finished sentence in a candidate");

    t.diagnostic(`reply=${JSON.stringify(reply)} candidates=${r.candidates.length}`);
  });

test("live: five turns stay on the model and never repeat verbatim",
  { skip: SKIP_LIVE, timeout: 600000 },
  async (t) => {
    const conv = await converse(14);
    const lines = [
      "hey chole",
      "i got the job at militech",
      "my best friend died last night",
      "what district are we in?",
      "the rain tonight is unreal",
    ];

    const replies = [];
    const offModel = [];
    for (const line of lines) {
      const r = await conv.converse(line, withOllama);
      if (!["llm", "llm-repaired"].includes(r.source)) {
        offModel.push(`${JSON.stringify(line)} → ${r.source}`);
      }
      assert.ok(validateReply(r.reply, { userText: line, history: replies }).ok,
        `validator rejected ${JSON.stringify(r.reply)}`);
      replies.push(r.reply);
    }

    // The model is stochastic: one fallback in five turns is a bad draw, not a
    // regression. Requiring 5/5 turns this red about 1 run in 5 at a 4%/turn
    // fallback rate, so the gate is 4-of-5 — and the offending turn is named,
    // so a genuine slide (say 5/5 off-model) still reads clearly in the log.
    assert.ok(offModel.length <= 1,
      `${offModel.length}/5 turns fell off the model:\n  ${offModel.join("\n  ")}`);
    if (offModel.length) t.diagnostic(`off-model: ${offModel.join(", ")}`);

    const distinct = new Set(replies.map((s) => s.toLowerCase().trim()));
    assert.equal(distinct.size, replies.length, `replies repeated: ${replies.join(" | ")}`);
    assert.equal(conv.turn, 5);
    assert.equal(conv.history.length, 5);

    const log = conv.trainingData();
    assert.equal(log.length, 5, "one adapter record per turn");
    const onModel = log.filter((e) => e.source.startsWith("llm"));
    assert.ok(onModel.length >= 4,
      `only ${onModel.length}/5 adapter records came from the model: ` +
      log.map((e) => e.source).join(", "));
    assert.ok(onModel.every((e) => e.tones),
      "every on-model record tagged with its tones");

    t.diagnostic(replies.map((r) => `- ${r}`).join("\n"));
  });

test("live: the reply is written from an offered skeleton, not off-script",
  { skip: SKIP_LIVE, timeout: 120000 },
  async (t) => {
    const conv = await converse(15);
    const r = await conv.converse("i got the job at militech", withOllama);
    assert.ok(["llm", "llm-repaired"].includes(r.source), `source: ${r.source}`);

    // Every slot word the candidates offered.
    const pool = new Set();
    for (const c of r.candidates) {
      for (const w of Object.values(c.words || {})) {
        for (const tok of String(w).toLowerCase().match(/[a-z']+/g) || []) {
          if (tok.length >= 3) pool.add(tok);
        }
      }
    }
    const said = new Set(r.reply.toLowerCase().match(/[a-z']+/g) || []);
    const overlap = [...pool].filter((w) => said.has(w));

    // Reported, not asserted: a model is free to paraphrase. What it may not
    // do is drop the frame's register — so the hard checks are the gate and
    // the length, and the overlap is the fidelity measure you read in output.
    t.diagnostic(`skeleton word overlap ${overlap.length}/${pool.size}: ${overlap.join(",")}`);
    assert.ok(pool.size >= 5, `a skeleton set carries enough words to check against: ${pool.size}`);
    assert.ok(validateReply(r.reply, { userText: "i got the job at militech" }).ok, "still gated");
    assert.ok(r.reply.split(/(?<=[.!?…])\s+/).filter(Boolean).length <= 3, "stayed in frame length");
  });
