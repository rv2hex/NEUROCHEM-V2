import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { createCognitiveCycle } from "../src/cognitive/cycle.js";
import { createDaemon } from "../src/daemon/index.js";
import { createConversation } from "../src/interface/converse.js";
import { validateReply } from "../src/interface/validate.js";
import { createPhraseEngine } from "../src/phrase/engine.js";
import { parseSoulText, buildAccentPack } from "../src/personality/soul.js";
import { createNeurochemEngine } from "../src/neurochem/engine.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slang = JSON.parse(readFileSync(join(ROOT, "config", "slang.json"), "utf8"));

// ==================== ERA / DYNAMIC SLANG ====================

test("slang is era-gated: dead words drop out as the year advances", () => {
  const voice = parseSoulText(
    "---\nname: Chole\nspeech.dialect: night-city\nspeech.slang: 0.8\n---\nI talk fast.",
    "inline"
  );
  const pack = slang.dialects["night-city"];

  const y2018 = buildAccentPack(voice, pack, 2018);
  const y2025 = buildAccentPack(voice, pack, 2025);
  const y2077 = buildAccentPack(voice, pack, 2077);

  // Words coined after the era must be unavailable
  assert.ok(!y2018.dialectWords.includes("choom"), "choom not invented in 2018");
  assert.ok(y2018.unreachedWords.includes("choom"), "choom listed as unreached");
  assert.ok(y2077.dialectWords.includes("choom"), "choom is live in 2077");

  // bussin: coined 2021, died 2040 — alive only in the middle era
  assert.ok(y2018.unreachedWords.includes("bussin"), "bussin not yet coined in 2018");
  assert.ok(y2025.dialectWords.includes("bussin"), "bussin alive in 2025");
  assert.ok(y2077.datedWords.includes("bussin"), "bussin dead by 2077");
  assert.ok(!y2077.dialectWords.includes("bussin"), "bussin unavailable in 2077");

  // Overlap: both eras share the evergreen words
  assert.ok(y2018.dialectWords.includes("gonk") && y2077.dialectWords.includes("gonk"));
});

test("era never overlaps: live ∩ (dated ∪ unreached) = ∅", () => {
  const voice = parseSoulText("---\nspeech.dialect: night-city\n---\nI talk.", "inline");
  const pack = slang.dialects["night-city"];
  for (const y of [2010, 2035, 2060, 2077, 2100]) {
    const a = buildAccentPack(voice, pack, y);
    const live = new Set(a.dialectWords);
    for (const w of a.datedWords) assert.ok(!live.has(w), `${w} live AND dated at ${y}`);
    for (const w of a.unreachedWords) assert.ok(!live.has(w), `${w} live AND unreached at ${y}`);
    assert.equal(live.size, a.dialectWords.length);
  }
});

test("engine setEra() re-derives the accent", () => {
  const pe = createPhraseEngine({ seed: 1, root: ROOT, dialectPack: slang });
  assert.equal(pe.era, 2077, "defaults to the pack's era");
  assert.ok(pe.accent.dialectWords.includes("choom"));

  pe.setEra(2025);
  assert.equal(pe.era, 2025);
  assert.ok(!pe.accent.dialectWords.includes("choom"), "choom unreachable in 2025");
  assert.ok(pe.accent.unreachedWords.includes("choom"), "choom parked as unreached");
  assert.ok(pe.accent.dialectWords.includes("bussin"), "bussin alive in 2025");
  assert.ok(pe.accent.dialectWords.length > 0);
});

// ==================== COGNITIVE CYCLE ====================

test("cognitive cycle runs productions and advances", () => {
  const cy = createCognitiveCycle({ seed: 1 });
  const r1 = cy.cycle({ mode: "wake" });
  const r2 = cy.cycle({ mode: "wake" });
  assert.ok(r2.cycle > r1.cycle, "cycle count advances");
  assert.equal(typeof r1.matched, "number");
  assert.ok(r1.buffers, "exposes buffers");
  assert.ok("interoceptive" in r1.buffers || "affective" in r1.buffers);
});

test("cognitive cycle reads TONES not raw concentrations", () => {
  const nc = createNeurochemEngine({ seed: 5 });
  const cy = createCognitiveCycle({ seed: 5 });
  cy.setRefs?.({ neurochem: nc, energy: null, memory: null });

  const out = cy.cycle({ mode: "wake" });
  if (out.buffers?.affective) {
    const a = out.buffers.affective.content;
    assert.ok(a, "affective buffer carries content");
    for (const k of ["valence", "arousal", "dominance"]) {
      assert.ok(Number.isFinite(a[k]), `${k} finite`);
    }
    // valence spans [-1, 1]; arousal/dominance are [0, 1]
    assert.ok(a.valence >= -1 && a.valence <= 1, `valence in -1..1: ${a.valence}`);
    for (const k of ["arousal", "dominance"]) {
      assert.ok(a[k] >= 0 && a[k] <= 1, `${k} in 0-1: ${a[k]}`);
    }
    // Resting DA tone = 0.5 → dominance should not collapse to ~0
    assert.ok(a.dominance > 0.1, `dominance not floored: ${a.dominance}`);
  }
});

test("cognitive cycle: conflict resolution reads receptor-aware gain, not raw tone", () => {
  const cy = createCognitiveCycle({ seed: 11 });
  const calls = [];
  cy.setRefs({
    neurochem: {
      getToneByName: (n) => { calls.push(`tone:${n}`); return 0.5; },
      getGainByName: (n) => { calls.push(`gain:${n}`); return 0.5; },
    },
    energy: null,
    memory: null,
  });
  cy.loadProductions(
    new Map([
      ["a", { id: "a", condition: {}, action: {}, utility: 0.5, neurochemGain: { dopamine: 0.5 } }],
      ["b", { id: "b", condition: {}, action: {}, utility: 0.5, neurochemGain: { dopamine: 0.5 } }],
    ])
  );

  // Two productions, because resolveConflict short-circuits on a single match
  // and never reaches the modulation at all.
  const matched = cy.matchProductions();
  assert.equal(matched.length, 2, `both must match: ${matched.length}`);
  cy.resolveConflict(matched);

  assert.ok(
    calls.some((c) => c.startsWith("gain:")),
    `the resolver must read getGainByName — it saw ${JSON.stringify(calls)}`
  );
  assert.ok(
    !calls.some((c) => c.startsWith("tone:")),
    `gain is available, so it must not fall back to raw tone: ${JSON.stringify(calls)}`
  );
});

test("cognitive cycle: an engine without gain still modulates on the plain tone", () => {
  const cy = createCognitiveCycle({ seed: 12 });
  const calls = [];
  cy.setRefs({
    neurochem: { getToneByName: (n) => { calls.push(`tone:${n}`); return 1; } },
    energy: null,
    memory: null,
  });
  cy.loadProductions(
    new Map([
      ["a", { id: "a", condition: {}, action: {}, utility: 0.5, neurochemGain: { dopamine: 0.5 } }],
      ["b", { id: "b", condition: {}, action: {}, utility: 0.5, neurochemGain: { dopamine: 0.5 } }],
    ])
  );
  const matched = cy.matchProductions();
  assert.equal(matched.length, 2, "both must match");
  const sel = cy.resolveConflict(matched);

  assert.ok(sel && sel.id, "a production is still chosen");
  assert.ok(calls.some((c) => c.startsWith("tone:")),
    `the tone fallback must still work: ${JSON.stringify(calls)}`);
});

test("cognitive cycle serialization round-trip", () => {
  const cy = createCognitiveCycle({ seed: 2 });
  cy.cycle({ mode: "wake" });
  const json = cy.toJSON();
  const cy2 = createCognitiveCycle({ seed: 3 });
  cy2.fromJSON(json);
  assert.deepEqual(cy2.toJSON(), json);
});

// ==================== DAEMON ====================

test("daemon: tickFor advances tick count and time", () => {
  const d = createDaemon({ seed: 1, root: ROOT, dialectPack: slang });
  const t0 = d.tickCount;
  d.tickFor(25);
  assert.equal(d.tickCount, t0 + 25);
});

test("daemon: snapshot exposes all five bridge channels", () => {
  const d = createDaemon({ seed: 2, root: ROOT, dialectPack: slang });
  d.tickFor(5);
  const s = d.snapshot();

  // 1. neurochem  2. energy  3. tendencies  4. narrative  5. accent
  assert.ok(s.neurochem && typeof s.neurochem.dopamine === "number");
  assert.ok(s.energy && typeof s.energy.atp === "number");
  assert.ok(s.tendencies && typeof s.tendencies.warm === "number");
  assert.ok(typeof s.narrative === "string" && s.narrative.length > 0);
  assert.ok(s.accent && s.accent.dialect, "accent channel present");
  assert.ok(Array.isArray(s.monologue));
});

test("daemon: tendencies are neutral-ish at rest (tone scale, not concentrations)", () => {
  const d = createDaemon({ seed: 3, root: ROOT, dialectPack: slang });
  const t = d.snapshot().tendencies;
  // With raw concentrations every tendency pinned to ~0. Rest must be mid-range.
  for (const k of ["approach", "warm", "certain", "verbose", "impulsive", "dominant"]) {
    assert.ok(t[k] > 0.05 && t[k] < 0.95, `${k} = ${t[k]} not pinned to a rail`);
  }
});

test("daemon: stimulus changes state (reward raises approach tendency)", () => {
  const d = createDaemon({ seed: 4, root: ROOT, dialectPack: slang });
  const before = d.snapshot().tendencies.approach;
  d.onStimulus({ type: "reward", intensity: 1, valence: 0.9, text: "great news", personId: "x" });
  d.tickFor(3);
  const after = d.snapshot().tendencies.approach;
  assert.ok(after >= before, `approach ${before} → ${after}`);
});

test("daemon: checkpoint round-trip preserves the simulation", () => {
  const dir = mkdtempSync(join(tmpdir(), "ncn-ckpt-"));
  const file = join(dir, "state.json");

  const d1 = createDaemon({ seed: 5, root: ROOT, dialectPack: slang });
  d1.tickFor(40);
  d1.memory.addEvent({ type: "episodic", content: "saved across restarts", importance: 9 });
  d1.saveCheckpoint(file);
  const ticks = d1.tickCount;

  const d2 = createDaemon({ seed: 6, root: ROOT, dialectPack: slang });
  assert.ok(d2.loadCheckpoint(file), "checkpoint loads");
  assert.equal(d2.tickCount, ticks, "tick count restored");
  assert.ok(d2.memory.retrieveEpisodic({ content: "restarts" }, { limit: 1 }).length >= 1,
    "memories restored");
  assert.deepEqual(d2.toJSON().neurochem, d1.toJSON().neurochem, "neurochem restored");
});

test("daemon: loadCheckpoint on a missing file returns false (no throw)", () => {
  const d = createDaemon({ seed: 7, root: ROOT, dialectPack: slang });
  assert.equal(d.loadCheckpoint("/tmp/definitely-not-here-ncn.json"), false);
});

test("daemon: cognitive loop fires seeded productions and bills ATP", () => {
  const d = createDaemon({ seed: 8, root: ROOT, dialectPack: slang });
  assert.equal(d.cognitive.matchProductions().length, 2, "seeded table matches out of the box");

  const before = d.energy.atp;
  d.tickFor(10); // exactly one cognitive tick (period 10)
  const price = d.energy.COSTS.production_fire;
  assert.ok(
    Math.abs(before - d.energy.atp - price) < 1e-9,
    `one firing bills exactly its price: ${before} -> ${d.energy.atp} (price ${price})`
  );

  // The firing is learned from AND re-loadable (condition + gain survive).
  assert.ok(d.memory.getStats().procedural >= 1, "firing recorded a procedural event");
  const rec = d.memory.retrieveProcedural({}, {})[0];
  assert.ok(rec && rec.condition !== undefined, "recorded production keeps its condition");
  assert.ok(rec && rec.neurochemGain !== undefined, "recorded production keeps its gain term");

  // The table itself survives a serialization round-trip.
  const json = d.cognitive.toJSON();
  assert.equal(json.productions.length, 2, "table persisted");
  const cy2 = createCognitiveCycle({ seed: 9 });
  cy2.fromJSON(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(cy2.toJSON().productions, json.productions, "table restored");

  // An explicitly empty table still builds the old dead-path daemon.
  const dead = createDaemon({ seed: 8, root: ROOT, dialectPack: slang, productions: new Map() });
  assert.equal(dead.cognitive.matchProductions().length, 0, "explicit empty means no firing");
});

// ==================== INTERFACE ====================

test("conversation: a turn works with no LLM engine (candidate path)", async () => {
  const conv = await createConversation({ seed: 1, root: ROOT, dialectPack: slang });
  const r = await conv.converse("hey chole");
  assert.ok(r.reply && r.reply.length > 0, "has a reply");
  assert.ok(["candidate", "candidates-only"].includes(r.source), `source: ${r.source}`);
  assert.ok(Array.isArray(r.candidates) && r.candidates.length >= 1);
  assert.ok(r.tendencies && typeof r.tendencies.warm === "number");
  assert.ok(typeof r.narrative === "string");
  assert.ok(r.guidance && Array.isArray(r.guidance.behavioral_effects));
});

test("conversation: prompt carries all 5 bridge channels", async () => {
  const conv = await createConversation({ seed: 2, root: ROOT, dialectPack: slang });
  const r = await conv.converse("i got the job");
  const sys = r.prompt;
  assert.ok(sys, "prompt debug present");
  assert.ok(sys.tokens > 0, "token estimate");

  // Rebuild the prompt to inspect channel presence
  const debug = sys.channels;
  for (const ch of ["directive", "narrative", "tendencies", "candidates", "memories"]) {
    assert.ok(debug.includes(ch), `channel ${ch} declared`);
  }
  assert.equal(sys.candidateCount, r.candidates.length);
});

test("conversation: positive news gets acknowledged + asked back, not ignored", async () => {
  const conv = await createConversation({ seed: 3, root: ROOT, dialectPack: slang });
  const r = await conv.converse("i got the job at militech");
  const frames = r.candidates.map((c) => c.frame);
  const ackFrames = ["ack_followup", "ack_only", "statement_share", "statement_react"];
  assert.ok(frames.some((f) => ackFrames.includes(f)),
    `good news → an ack frame, got: ${frames.join(",")}`);
  // and it should NOT top-rank an "I don't know" frame
  const top = [...r.candidates].sort((a, b) => b.confidence - a.confidence)[0];
  assert.notEqual(top.frame, "idk", "idk must not win on good news");
});

test("conversation: bad news routes to comfort frames", async () => {
  const conv = await createConversation({ seed: 4, root: ROOT, dialectPack: slang });
  const r = await conv.converse("my best friend died last night");
  const frames = r.candidates.map((c) => c.frame);
  assert.ok(frames.includes("comfort_plain") || frames.includes("comfort_ask"),
    `bad news → comfort, got: ${frames.join(",")}`);
});

test("conversation: a question routes to answer frames", async () => {
  const conv = await createConversation({ seed: 5, root: ROOT, dialectPack: slang });
  const r = await conv.converse("what district are we in?");
  const frames = r.candidates.map((c) => c.frame);
  assert.ok(frames.some((f) => f.startsWith("answer") || f === "idk"),
    `question → answer/idk, got: ${frames.join(",")}`);
});

test("conversation: history and training log accumulate", async () => {
  const conv = await createConversation({ seed: 6, root: ROOT, dialectPack: slang });
  await conv.converse("hey");
  await conv.converse("whats good");
  assert.equal(conv.turn, 2);
  assert.equal(conv.history.length, 2);
  const log = conv.trainingData();
  assert.equal(log.length, 2, "adapter dataset logged per turn");
  for (const entry of log) {
    assert.ok(entry.neurochem && entry.tendencies && entry.candidates && entry.chosen);
  }
});

test("conversation: engine failure falls back to a candidate (never throws)", async () => {
  const conv = await createConversation({ seed: 7, root: ROOT, dialectPack: slang });
  const r = await conv.converse("hello there", {
    engine: { chat: async () => { throw new Error("ollama down"); } },
  });
  assert.ok(r.reply.length > 0);
  assert.ok(["engine-down", "candidate-fallback"].includes(r.source), `source: ${r.source}`);
});

test("conversation: a breakup moves trust down (leave-vocabulary scores sad)", async () => {
  const conv = await createConversation({ seed: 22, root: ROOT, dialectPack: slang });
  let n = 0;
  const engine = { chat: async () => `noted ${++n}, choom` };
  const opts = { engine, personId: "t" };

  await conv.converse("i love you", opts);
  // Snapshot the NUMBER — retrieveSocial returns the live model object,
  // so holding the reference would watch it mutate under the next turn.
  const lovedTrust = conv.daemon.memory.retrieveSocial("t")?.trust ?? 0;
  assert.ok(lovedTrust > 0, `love builds trust: ${lovedTrust}`);

  await conv.converse("i'm breaking up with you", opts);
  const left = conv.daemon.memory.retrieveSocial("t");
  assert.ok(left.trust < lovedTrust, `breakup costs trust: ${lovedTrust} -> ${left.trust}`);

  const eps = conv.daemon.memory.retrieveEpisodic({ content: "breaking up" }, { limit: 1 });
  assert.ok(eps.length && eps[0].valence < 0, `breakup episode stored sad: ${eps[0]?.valence}`);

  // ...while a workday farewell stays neutral.
  await conv.converse("leaving for work, back soon", opts);
  const back = conv.daemon.memory.retrieveSocial("t");
  assert.equal(back.trust, left.trust, "bare leaving must not touch trust");
});

test("conversation: a reply quoting an EARLIER line repairs instead of passing", async () => {
  const conv = await createConversation({ seed: 23, root: ROOT, dialectPack: slang });
  const sent = [];
  const script = [
    "Got you, choom. I'm here.",
    "I never stopped thinking about you. It's good to be back.",
    "Water under the bridge, choom.",
  ];
  let calls = 0;
  const engine = {
    chat: async (msgs) => {
      sent.push(msgs);
      return script[Math.min(calls++, script.length - 1)];
    },
  };

  const first = await conv.converse("i never stopped thinking about you", { engine });
  assert.equal(first.source, "llm", `turn 1 clean: ${first.source}`);

  const second = await conv.converse("thanks for hearing me out", { engine });
  assert.equal(second.source, "llm-repaired", `history echo must repair, not pass: ${second.source}`);
  const repair = sent.at(-1).filter((m) => m.role === "user").at(-1).content;
  assert.ok(
    repair.includes('you repeated "i never stopped thinking about you"'),
    `repair must name the history run: ${repair.slice(0, 160)}`
  );
});

test("conversation: the prompt carries the SOUL diary ahead of the context", async () => {
  const conv = await createConversation({ seed: 24, root: ROOT, dialectPack: slang });
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return "Yo."; } };
  await conv.converse("hey chole", { engine });
  const user = sent[0].filter((m) => m.role === "user").at(-1).content;
  assert.ok(user.includes("# YOUR DIARY"), "diary block present");
  assert.ok(user.includes("Arasaka"), "chapter content rides along");
  // ...and it sits BEFORE the live line, far from the recency slot.
  assert.ok(
    user.indexOf("# YOUR DIARY") < user.indexOf("# THEY JUST SAID THIS"),
    "diary precedes the current line"
  );
});

test("conversation: a soul without diary chapters sends no diary block", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ncn-soul-"));
  const file = join(dir, "SOUL.md");
  writeFileSync(file, `---\nname: Z\nspeech.dialect: night-city\n---\nJust passing through.\n`, "utf8");
  const conv = await createConversation({ seed: 25, root: ROOT, soulPath: file, dialectPack: slang });
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return "Yo."; } };
  await conv.converse("hey chole", { engine });
  const user = sent[0].filter((m) => m.role === "user").at(-1).content;
  assert.ok(!user.includes("# YOUR DIARY"), "no chapters means no block");
});

test("conversation: echo repair names the repeated run (truncated past 6 words)", async () => {
  for (const [line, echo, expected] of [
    ["the rain tonight is unreal", "the rain tonight is unreal and I love it so much", '"the rain tonight is unreal"'],
    ["i got the job at militech today", "i got the job at militech today and it feels amazing", '"i got the job at militech …"'],
  ]) {
    const conv = await createConversation({ seed: 21, root: ROOT, dialectPack: slang });
    const sent = [];
    let calls = 0;
    const engine = {
      chat: async (msgs) => {
        sent.push(msgs);
        calls++;
        return calls === 1 ? echo : "Finally caught a break, choom. Feels unreal.";
      },
    };
    const r = await conv.converse(line, { engine });
    assert.equal(r.source, "llm-repaired", `echo must repair, not fall back: ${r.source}`);
    const repair = sent[1].filter((m) => m.role === "user").at(-1).content;
    assert.ok(
      repair.includes(`you repeated ${expected}`),
      `repair must name the run for ${JSON.stringify(line)}: ${repair.slice(0, 160)}`
    );
  }
});

// ==================== VALIDATOR ====================

test("validate: accepts a clean short reply", () => {
  const v = validateReply("Solid. How'd it go?", { userText: "i got the job" });
  assert.ok(v.ok, JSON.stringify(v));
});

test("validate: rejects empty, over-long, or meta replies", () => {
  assert.equal(validateReply("", {}).ok, false);
  assert.equal(validateReply("   ", {}).ok, false);
  assert.equal(
    validateReply("As an AI language model, I must inform you that " + "blah ".repeat(200), {}).ok,
    false
  );
  assert.equal(validateReply("Sure! Here is my reply:", { userText: "hi" }).ok, false);
  // ...but a natural reply that happens to start with a warm word passes
  assert.equal(validateReply("Of course. You know me.", { userText: "you got me?" }).ok, true);
});

test("validate: rejects echoing the user's line back", () => {
  const line = "i got the job at militech today";
  const v = validateReply(line, { userText: line });
  assert.equal(v.ok, false);
});
