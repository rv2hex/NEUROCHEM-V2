/**
 * Memory — all four access modes, plus the wiring that has to make them
 * matter: the conversation writing episodes, the prompt showing them, and the
 * SKELETON carrying the previous exchange.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../src/memory/store.js";
import { createPhraseEngine } from "../src/phrase/engine.js";
import { createNeurochemEngine } from "../src/neurochem/engine.js";
import { createEnergySystem } from "../src/energy/system.js";
import { createConversation } from "../src/interface/converse.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slang = JSON.parse(fs.readFileSync(join(ROOT, "config", "slang.json"), "utf8"));

function makePhrase(memory = null) {
  const pe = createPhraseEngine({ seed: 42, root: ROOT, dialectPack: slang });
  pe.setRefs({
    neurochem: createNeurochemEngine({ seed: 1 }),
    energy: createEnergySystem({}),
    memory,
  });
  return pe;
}

// ==================== EPISODIC ====================

test("episodic: the conversation stores every exchange and it comes back", async () => {
  const conv = await createConversation({ seed: 11, root: ROOT, dialectPack: slang });
  await conv.converse("i got the job at militech");
  await conv.converse("my best friend died last night");

  assert.equal(conv.turn, 2, "two turns ran");
  const stats = conv.daemon.memory.getStats();
  assert.ok(stats.episodic >= 2, `episodes stored: ${stats.episodic}`);

  const back = conv.daemon.memory.retrieveEpisodic(
    { content: "militech job" },
    { limit: 10, minActivation: -5 }
  );
  assert.ok(
    back.some((e) => e.content.includes("militech")),
    `first line retrievable later: ${JSON.stringify(back.map((e) => e.content))}`
  );
});

test("episodic: a cue pulls the matching episode to the front", () => {
  const store = createMemoryStore({ seed: 1 });
  store.addEvent({ type: "episodic", content: "you said: the rain tonight is unreal", valence: 0.2 });
  store.addEvent({ type: "episodic", content: "you said: i quit militech for good", valence: -0.4 });

  const hits = store.retrieveEpisodic({ content: "how unreal was that rain" }, { limit: 2 });
  assert.ok(hits.length >= 2, "both retrievable");
  assert.match(hits[0].content, /rain/, `cue should surface the rain episode: ${hits[0].content}`);
});

test("episodic: valence filter keeps the opposite sign out", () => {
  const store = createMemoryStore({ seed: 2 });
  store.addEvent({ type: "episodic", content: "good news day", valence: 0.8, importance: 6 });
  store.addEvent({ type: "episodic", content: "bad news day", valence: -0.8, importance: 6 });

  const neg = store.retrieveEpisodic({}, { valence: -1, minActivation: -5 });
  assert.ok(neg.length > 0, "negative episodes returned");
  assert.ok(neg.every((e) => e.valence < 0), "no positive episode leaked through");
});

// ==================== SKELETON REMEMBERS THE LAST CHAT ====================

test("skeleton: an optional carry tag holds the remembered subject", () => {
  const store = createMemoryStore({ seed: 3 });
  const carried = (cs) => [...new Set(cs.map((c) => c.carry))];

  // 1. literal previous line passed by the caller (converse does this)
  const viaHistory = makePhrase().generateCandidates(
    { speechAct: "assert", content: { text: "", valence: 0 } },
    { seed: 1, remembered: "my best friend died last night" }
  );
  assert.ok(viaHistory.length >= 1, "candidates produced");
  assert.deepEqual(carried(viaHistory), ["friend"], "longest content word kept");

  // 2. the episodic cue converse already fetched (move.content.text)
  const viaCue = makePhrase().generateCandidates(
    { speechAct: "assert", content: { text: "you said: i got the job at militech", valence: 0 } },
    { seed: 1 }
  );
  assert.deepEqual(carried(viaCue), ["militech"], "remembered from episodic");

  // 3. the store itself — no cue handed in, the engine looks it up
  store.addEvent({ type: "episodic", content: "you said: what district are we in" });
  const viaStore = makePhrase(store).generateCandidates(
    { speechAct: "assert", content: { text: "", valence: 0 } },
    { seed: 1, userText: "which district then?" }
  );
  assert.deepEqual(carried(viaStore), ["district"], "remembered via memoryRef");

  // The carry tag must never be dressed up as a required slot word.
  for (const cs of [viaHistory, viaCue, viaStore]) {
    for (const c of cs) {
      assert.ok(!c.slots.includes("topic"), "carry is not a slot");
      assert.ok(!("topic" in c.words), "carry does not sit inside words");
    }
  }
});

test("skeleton: with nothing remembered there is no carry tag and no invented subject", () => {
  const cs = makePhrase().generateCandidates(
    { speechAct: "assert", content: { text: "", valence: 0 } },
    { seed: 1 }
  );
  assert.ok(cs.length >= 1, `turn 1 still produces candidates: ${JSON.stringify(cs.map((c) => c.frame))}`);
  for (const c of cs) {
    assert.ok(!("carry" in c), `turn 1 must not claim a subject, got ${JSON.stringify(c.carry)}`);
    assert.ok(!c.slots.includes("topic"), "no topic slot exists any more");
    assert.ok(!c.hint.includes("still on"), `hint must not claim a subject: ${c.hint}`);
  }
});

test("skeleton: the carry tag reaches EVERY frame, not just the assert family", () => {
  for (const act of ["greet", "farewell", "comfort"]) {
    const cs = makePhrase().generateCandidates(
      { speechAct: act, content: { text: "", valence: 0 } },
      { seed: 1, remembered: "i got the job at militech" }
    );
    assert.ok(cs.length >= 1, `${act} produces a skeleton`);
    for (const c of cs) {
      assert.equal(c.carry, "militech", `${act}/${c.frame} forgot the last chat`);
      assert.ok(!c.hint.includes("still on"), `hint must stay a plain instruction: ${c.hint}`);
    }
  }
});

test("skeleton: the persona's own name is never a remembered subject", () => {
  // "hey johnny" is the listener greeting him. Nothing survives once "johnny"
  // is banned and "hey" is filler, so there must be NO carry tag at all —
  // otherwise the prompt would tell the model to weave in the very word the
  // contract forbids it from saying.
  const greeted = makePhrase().generateCandidates(
    { speechAct: "greet", content: { text: "", valence: 0 } },
    { seed: 1, remembered: "hey johnny" }
  );
  assert.ok(greeted.length >= 1, "greeting still produces a skeleton");
  for (const c of greeted) {
    assert.ok(
      !("carry" in c),
      `must not carry the agent's own name, got ${JSON.stringify(c.carry)}`
    );
  }

  // ...and when her name sits mid-sentence it is simply dropped, leaving the
  // real subject standing.
  const embedded = makePhrase().generateCandidates(
    { speechAct: "assert", content: { text: "", valence: 0 } },
    { seed: 1, remembered: "i saw johnny at militech" }
  );
  assert.deepEqual(
    [...new Set(embedded.map((c) => c.carry))],
    ["militech"],
    "her name is dropped, the actual subject survives"
  );
});

test("skeleton: the next turn remembers the ACTUAL previous line, not a guess", async () => {
  const conv = await createConversation({ seed: 12, root: ROOT, dialectPack: slang });
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return `right, noted ${sent.length}`; } };

  await conv.converse("i got the job at militech", { engine });
  const second = await conv.converse("they said i start monday", { engine });

  assert.ok(second.candidates.length >= 1, "turn 2 produced skeletons");
  assert.deepEqual(
    [...new Set(second.candidates.map((c) => c.carry))],
    ["militech"],
    `skeleton remembered the previous line: ${JSON.stringify(second.candidates.map((c) => c.frame))}`
  );

  // The prompt must present it as something the model may decline.
  const system = sent.at(-1).find((m) => m.role === "system").content;
  assert.match(system, /carry-over \(optional/, "prompt marks carry-over as optional");
  assert.match(system, /OPTIONAL: weave it in if it lands naturally/, "contract says it is skippable");
});

test("skeleton: later turns keep offering state-fit candidates (anti-repeat must not starve)", () => {
  for (const act of ["assert", "question", "comfort", "refuse"]) {
    const pe = makePhrase();
    const perTurn = [];
    for (let i = 1; i <= 6; i++) {
      perTurn.push(
        pe.generateCandidates({ speechAct: act, content: { valence: 0 } }, { seed: i })
      );
    }
    const total = perTurn.reduce((s, cs) => s + cs.length, 0);
    assert.ok(total >= 6, `${act}: only ${total} candidates across 6 turns`);

    // The old bug: turn 1 consumed the whole frame pool, so turns 2..6 each
    // returned the lone `phatic` fallback forever.
    const starved = perTurn
      .slice(1)
      .every((cs) => cs.length === 1 && cs[0].frame === "phatic");
    assert.ok(!starved, `${act}: collapsed to the lone phatic fallback`);

    if (act === "assert") {
      assert.ok(
        perTurn.every((cs) => cs.length >= 3),
        `assert offered ${perTurn.map((cs) => cs.length).join(",")}`
      );
    }
  }
});

test("skeleton: anti-repeat still rotates the frames across calls", () => {
  const pe = makePhrase();
  const a = pe.generateCandidates({ speechAct: "assert" }, { seed: 7 });
  const b = pe.generateCandidates({ speechAct: "assert" }, { seed: 7 });
  assert.notEqual(
    a.map((c) => c.frame).join(","),
    b.map((c) => c.frame).join(","),
    "frames rotate"
  );
});

// ==================== PROMPT WIRING ====================

test("prompt: the model is shown the previous exchange AND answered on the current line", async () => {
  const conv = await createConversation({ seed: 13, root: ROOT, dialectPack: slang });
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return `Okay. Noted that one down ${sent.length}.`; } };

  await conv.converse("i got the job at militech", { engine });
  await conv.converse("my best friend died last night", { engine });

  assert.equal(sent.length, 2, "one call per turn");
  const user = sent[1].find((m) => m.role === "user").content;
  const system = sent[1].find((m) => m.role === "system").content;

  assert.match(user, /# RECENT/, "history block present");
  assert.match(user, /# MEMORIES/, "retrieved episodes present");
  assert.ok(user.includes("i got the job at militech"), "previous line shown");
  assert.ok(user.includes("my best friend died last night"), "current line shown");
  // Recency: the line to answer must be the last thing before generation.
  assert.ok(
    user.lastIndexOf("they said") > user.lastIndexOf("# RECENT"),
    "current line comes after the history, not before it"
  );
  assert.match(system, /# SKELETONS/, "skeletons reach the model");
  assert.match(system, /# OUTPUT CONTRACT/, "contract reaches the model");
});

// ==================== SEMANTIC ====================

test("semantic: a bare name resolves to its concept", () => {
  const store = createMemoryStore({ seed: 4 });
  store.addEvent({ type: "semantic", content: "Arasaka tower runs the district" });

  const hits = store.retrieveSemantic(["arasaka"], { spreadDepth: 0 });
  assert.equal(hits.length, 1, `bare name resolved: ${JSON.stringify(hits.map((h) => h.id))}`);
  assert.equal(hits[0].id, "concept_arasaka");
  assert.equal(hits[0].label, "Arasaka");
});

test("semantic: consolidation strengthens a concept recalled by a later episode", () => {
  const store = createMemoryStore({ seed: 5 });
  store.addEvent({ type: "semantic", content: "Arasaka tower runs the district" });
  const before = store.retrieveSemantic(["Arasaka"], { spreadDepth: 0 })[0].strength;

  store.addEvent({
    type: "episodic",
    content: "Arasaka offered me a contract",
    importance: 9,
    valence: 0.4,
  });
  const summary = store.consolidate(Date.now() + 3600 * 1000);
  assert.ok(summary.semanticCount >= 1, "graph still populated");

  const after = store.retrieveSemantic(["Arasaka"], { spreadDepth: 0 })[0].strength;
  assert.ok(after > before, `strength grew: ${before} -> ${after}`);
  assert.ok(after <= 1, "strength stays clamped");
});

// ==================== PROCEDURAL ====================

test("procedural: neurochem gating scales the effective utility", () => {
  const store = createMemoryStore({ seed: 6 });
  store.addEvent({
    type: "procedural",
    productionId: "speak_up",
    condition: {},
    action: { type: "speak" },
    utility: 0.8,
    neurochemGate: { dopamine: 0.9 },
  });

  const funded = store.retrieveProcedural({}, { dopamine: 0.9 })[0];
  const starved = store.retrieveProcedural({}, { dopamine: 0.45 })[0];
  assert.ok(funded && starved, "production retrievable in both states");
  assert.ok(
    starved.effectiveUtility < funded.effectiveUtility,
    `low DA must cost it: ${starved.effectiveUtility} vs ${funded.effectiveUtility}`
  );
  assert.equal(funded.gate, 1, "at threshold the gate is fully open");
  assert.ok(starved.gate < 1, "below threshold the gate closes");
});

test("procedural: a condition that does not match the context is not offered", () => {
  const store = createMemoryStore({ seed: 7 });
  store.addEvent({
    type: "procedural",
    productionId: "wake_only",
    condition: { mode: "wake" },
    action: { type: "scan" },
    utility: 0.9,
  });

  const awake = store.retrieveProcedural({ mode: "wake" }, {});
  const asleep = store.retrieveProcedural({ mode: "sleep" }, {});
  assert.equal(awake.length, 1, "matches when the condition holds");
  assert.equal(asleep.length, 0, "excluded when it does not");
});

test("procedural: utility tracks success and then decays under failure", () => {
  const store = createMemoryStore({ seed: 8 });
  const base = { type: "procedural", productionId: "greet_warm", condition: {}, value: 1, cost: 0 };

  store.addEvent({ ...base, success: true });
  const afterWin = store.retrieveProcedural({}, {})[0];
  assert.equal(afterWin.attemptCount, 1);
  assert.ok(afterWin.utility > 0.9, `a clean success scores high: ${afterWin.utility}`);

  store.addEvent({ ...base, success: false });
  const afterLoss = store.retrieveProcedural({}, {})[0];
  assert.equal(afterLoss.attemptCount, 2, "attempts accumulate");
  assert.ok(
    afterLoss.utility < afterWin.utility,
    `failure must cost it: ${afterLoss.utility} < ${afterWin.utility}`
  );
});

// ==================== SOCIAL ====================

test("social: people are modelled separately — trust and history do not leak", () => {
  const store = createMemoryStore({ seed: 9 });
  store.addEvent({ type: "social", personId: "maya", valence: 0.9, vocab: ["choom", "preem"] });
  store.addEvent({ type: "social", personId: "maya", valence: 0.8 });
  store.addEvent({ type: "social", personId: "takemura", valence: -0.9 });

  const maya = store.retrieveSocial("maya");
  const taka = store.retrieveSocial("takemura");
  assert.ok(maya && taka, "both people modelled");
  assert.ok(maya.trust > taka.trust, `trust differs: ${maya.trust} vs ${taka.trust}`);
  assert.equal(maya.sharedHistory.length, 2, "her own history only");
  assert.equal(taka.sharedHistory.length, 1, "his own history only");
  assert.ok(maya.insideVocab.has("choom"), "inside words remembered");
  assert.ok(!taka.insideVocab.has("choom"), "vocab is per person, not global");
});

test("social: unknown person returns null instead of inventing one", () => {
  const store = createMemoryStore({ seed: 10 });
  store.addEvent({ type: "social", personId: "maya", valence: 0.5 });
  assert.equal(store.retrieveSocial("nobody"), null);
  assert.equal(store.retrieveSocial().length, 1, "listing still works");
});

// ==================== ALL FOUR TOGETHER ====================

test("all four indices survive a serialization round-trip", () => {
  const store = createMemoryStore({ seed: 12 });
  store.addEvent({ type: "episodic", content: "you said: the rain tonight is unreal", valence: 0.3 });
  store.addEvent({ type: "semantic", content: "Arasaka tower runs the district" });
  store.addEvent({ type: "procedural", productionId: "p1", condition: { mode: "wake" }, utility: 0.7 });
  store.addEvent({ type: "social", personId: "maya", valence: 0.9, vocab: ["choom"] });

  const before = store.getStats();
  const json = JSON.parse(JSON.stringify(store.toJSON()));
  const restored = createMemoryStore({ seed: 13 });
  restored.fromJSON(json);
  const after = restored.getStats();

  for (const key of ["episodic", "semantic", "procedural", "social"]) {
    assert.equal(after[key], before[key], `${key} count preserved`);
  }

  // ...and they still WORK after the trip
  assert.ok(
    restored.retrieveEpisodic({ content: "rain unreal" }, { limit: 1 }).length === 1,
    "episodic still retrieves"
  );
  assert.equal(restored.retrieveSemantic(["arasaka"], { spreadDepth: 0 }).length, 1, "semantic still resolves");
  assert.equal(restored.retrieveProcedural({ mode: "wake" }, {}).length, 1, "procedural still conditions");
  assert.ok(restored.retrieveSocial("maya").insideVocab.has("choom"), "social vocab survives (a Set)");
});

// ==================== CONSOLIDATION WINDOW ====================

test("consolidation: the interval gate is milliseconds and actually holds", () => {
  const store = createMemoryStore({ seed: 5 });
  const t0 = Date.now() + 3_600_000; // lastConsolidation starts at 0, so this runs

  const first = store.consolidate(t0);
  assert.ok(first && typeof first === "object", "first call consolidates");
  assert.ok("episodicCount" in first, `expected a summary, got ${JSON.stringify(first)}`);

  // The default window is ONE HOUR. This is the assertion that fails when the
  // interval is left at 3600 — i.e. 3.6 seconds — because at +10 minutes the
  // gate has long since reopened and the second call runs anyway.
  assert.equal(
    store.consolidate(t0 + 600_000),
    undefined,
    "no-op well inside the window"
  );
  assert.equal(
    store.consolidate(t0 + 3_599_999),
    undefined,
    "still a no-op one millisecond before the window closes"
  );

  const again = store.consolidate(t0 + 3_600_000);
  assert.ok(again && typeof again === "object", "consolidates again the moment the window closes");
});

test("consolidation: a configured window wins, and 0 means every call", () => {
  const short = createMemoryStore({ seed: 6, consolidationInterval: 5_000 });
  assert.ok(short.consolidate(1_000_000), "first call runs");
  assert.equal(short.consolidate(1_004_999), undefined, "inside a 5s window");
  assert.ok(short.consolidate(1_005_000), "window closed");

  // `??` not `||` — an explicit 0 must reach the gate instead of being
  // replaced by the default hour.
  const every = createMemoryStore({ seed: 7, consolidationInterval: 0 });
  assert.ok(every.consolidate(1_000_000), "0 means consolidate");
  assert.ok(every.consolidate(1_000_001), "0 means consolidate on the very next call");
});
