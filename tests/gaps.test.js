/**
 * Gap-fill coverage — branches the feature suites never touch.
 *
 * Framework: node:test (see package.json test script).
 * Order per testing skill: happy path → edge cases → error cases → integration.
 *
 * What is covered here (and nowhere else):
 *  - soul: loadSoul baseline/throw, parseSoulText variants, buildAccentPack
 *    density/era, matchPreferences null/empty
 *  - validate: sentences/normalize/longestRun helpers, every hard rule,
 *    soft-vs-hard sentence boundary, stripWrappingQuotes mismatch
 *  - energy: shouldSleep gate, forceSleep/Wake idempotency, spendMultiple
 *    defaults, fromJSON(null), energyRatio
 *  - memory: object-concept extraction, person/tag/minActivation filters,
 *    semantic minStrength, function conditions, consolidation decay + prune,
 *    unknown event types, fromJSON(null)
 *  - cognitive cycle: loadProductions shapes, unknown buffers, function
 *    conditions, retrieval/motor/clear actions, runToOutput, updateUtility,
 *    fromJSON(null)
 *  - neurochem: set/get clamp, schedules with delay, all gain accessors
 *  - phrase: setEra/setDialectPack/clearRecent/toJSON, string disfluency,
 *    empty skeleton render, stopword-only topics
 *  - daemon: threat/punishment/default stimuli, sleep wake-up, idle mode,
 *    proactive subscription, tickFor return
 *  - converse: empty-text throw, all speech acts, valence polarities,
 *    every repair-guidance branch, triple-failure fallback, history cap
 *  - ollama: non-ok status, empty message, body shape (seed/max_tokens)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { loadSoul, parseSoulText, matchPreferences, buildAccentPack, VOICE_DEFAULTS } from "../src/personality/soul.js";
import { validateReply, stripWrappingQuotes, sentences, normalize, longestRun, longestRunWords, ECHO_RUN_WORDS } from "../src/interface/validate.js";
import { createEnergySystem } from "../src/energy/system.js";
import { createMemoryStore } from "../src/memory/store.js";
import { createCognitiveCycle } from "../src/cognitive/cycle.js";
import { createNeurochemEngine, NT, NT_NAMES } from "../src/neurochem/engine.js";
import { createPhraseEngine } from "../src/phrase/engine.js";
import { createDaemon } from "../src/daemon/index.js";
import { createConversation } from "../src/interface/converse.js";
import { chat, OllamaError } from "../src/engine/ollama.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slang = JSON.parse(readFileSync(join(ROOT, "config", "slang.json"), "utf8"));

const accept = (text, ctx = {}) => {
  const v = validateReply(text, ctx);
  assert.ok(v.ok, `expected pass, got ${JSON.stringify(v.hard)}: ${JSON.stringify(text)}`);
  return v;
};
const reject = (text, ctx = {}) => {
  const v = validateReply(text, ctx);
  assert.equal(v.ok, false, `expected rejection, got pass: ${JSON.stringify(text)}`);
  return v;
};
const has = (v, rule) => assert.ok(v.hard.includes(rule), `missing "${rule}" in ${JSON.stringify(v.hard)}`);

// ==================== HAPPY PATH ====================

test("gaps happy: loadSoul falls back to baseline when no SOUL file exists", () => {
  const v = loadSoul(join(tmpdir(), `ncn-empty-${Date.now()}`));
  assert.equal(v.name, VOICE_DEFAULTS.name);
  assert.deepEqual(v.likes, []);
  assert.equal(v.source, "baseline");
});

test("gaps happy: parseSoulText reads prose with no frontmatter", () => {
  const v = parseSoulText("Just a drifter passing through town.", "inline");
  assert.equal(v.name, "stranger");
  assert.ok(v.prose.includes("drifter"));
  assert.ok(v.sample.length > 0, "falls back to a substantive sentence");
});

test("gaps happy: buildAccentPack density follows slang (freely/sometimes/rarely)", () => {
  const pack = slang.dialects["night-city"];
  const voice = (s) => parseSoulText(`---\nname: X\nspeech.dialect: night-city\nspeech.slang: ${s}\n---\nI talk.`, "inline");
  assert.equal(buildAccentPack(voice(0.8), pack).density, "freely");
  assert.equal(buildAccentPack(voice(0.5), pack).density, "sometimes");
  assert.equal(buildAccentPack(voice(0.1), pack).density, "rarely");
});

test("gaps happy: validate helpers split, normalize and measure runs", () => {
  assert.deepEqual(sentences("One. Two? Three!"), ["One.", "Two?", "Three!"]);
  assert.deepEqual(sentences(""), []);
  assert.equal(normalize("  Hello, WORLD!  "), "hello world");
  assert.equal(longestRun(["a", "b", "c", "d"], ["x", "b", "c", "y"]), 2);
  assert.deepEqual(longestRunWords(["a", "b", "c"], ["b", "c", "d"]), ["b", "c"]);
  assert.equal(ECHO_RUN_WORDS, 8);
  assert.equal(stripWrappingQuotes('"unbalanced'), '"unbalanced', "mismatched quotes stay");
  // A fully-wrapped pair unwraps even when inner quotes remain — the VALIDATOR
  // is what keeps `"damn" and "hell"` legal (it only flags a wrap whose
  // remainder has no quotes left).
  assert.equal(stripWrappingQuotes('"damn" and "hell"'), 'damn" and "hell');
  assert.ok(accept('"damn" and "hell"', { userText: "something else entirely" }).ok);
});

test("gaps happy: energy shouldSleep fires on pressure or night phase", () => {
  assert.equal(createEnergySystem({ sleepPressure: 0.8 }).shouldSleep(), true, "pressure alone");
  assert.equal(createEnergySystem({ sleepPressure: 0.1, circadianPhase: 0.8 }).shouldSleep(), true, "night phase");
  assert.equal(createEnergySystem({ sleepPressure: 0.1, circadianPhase: 0.5 }).shouldSleep(), false, "rest is awake");
});

test("gaps happy: memory extracts object concepts and spreads activation", () => {
  const m = createMemoryStore({ seed: 1 });
  m.addEvent({ type: "semantic", content: { concept: { id: "c1", label: "C1" } } });
  assert.ok(m.retrieveSemantic(["c1"], { spreadDepth: 0 }).length >= 1);
  m.addEvent({ type: "semantic", content: "Arasaka Militech rivalry" });
  const spread = m.retrieveSemantic(["concept_arasaka"], { spreadDepth: 2, minStrength: 0.01 });
  assert.ok(spread.length >= 2, `links followed: ${spread.map((s) => s.id)}`);
  assert.equal(m.retrieveSemantic(["concept_arasaka"], { spreadDepth: 0, minStrength: 0.99 }).length, 0, "minStrength filters");
});

test("gaps happy: cycle loads every production-table shape", () => {
  const prod = { id: "p", condition: {}, action: {}, utility: 0.5 };
  const cy = createCognitiveCycle({ seed: 1 });
  cy.loadProductions(new Map([["p", prod]]));
  assert.equal(cy.matchProductions().length, 1, "Map");
  cy.loadProductions([["p", prod]]);
  assert.equal(cy.matchProductions().length, 1, "entries array");
  cy.loadProductions([prod]);
  assert.equal(cy.matchProductions().length, 1, "object array");
  cy.loadProductions({ p: prod });
  assert.equal(cy.matchProductions().length, 1, "plain object");
  cy.loadProductions(null);
  assert.equal(cy.matchProductions().length, 0, "null clears");
});

test("gaps happy: neurochem set clamps, schedules fire after their delay", () => {
  const e = createNeurochemEngine({ seed: 1 });
  e.set(NT.DOPAMINE, 2, 99);
  assert.equal(e.get(NT.DOPAMINE, 2), 1, "set clamps to [0,1]");
  assert.ok(e.getAllSomas().dopamine !== undefined && e.getAllSynaptics().dopamine !== undefined);
  e.schedulePhasic(NT.DOPAMINE, 0.8, 2);
  e.step(1, { energy: 1 });
  assert.equal(e.getSnapshot().phasicBuffers[NT.DOPAMINE], 0, "delayed burst has not fired yet");
  e.step(1, { energy: 1 });
  assert.ok(e.getSnapshot().phasicBuffers[NT.DOPAMINE] > 0, "delayed burst fired");
  for (const g of ["getD2Gain", "getAlpha1Gain", "get5HT2AGain", "getM1Gain", "getMuOpioidGain"]) {
    assert.ok(Number.isFinite(e[g]()), `${g} finite`);
  }
});

test("gaps happy: phrase engine era/pack/recent round-trips", () => {
  const pe = createPhraseEngine({ seed: 1, root: ROOT, dialectPack: slang });
  assert.equal(pe.setEra(2025), 2025);
  assert.ok(!pe.accent.dialectWords.includes("choom"), "era applied");
  pe.setDialectPack(slang);
  assert.ok(pe.accent.dialectWords.length > 0, "pack reloaded");
  pe.generateCandidates({ speechAct: "assert" }, { seed: 1 });
  pe.clearRecent();
  assert.deepEqual(pe.toJSON().recentFrames, [], "recent cleared");
  const wire = JSON.parse(JSON.stringify(pe.toJSON()));
  pe.fromJSON(wire);
  assert.ok(pe.applyDisfluency("hello world") === "hello world", "string input passes through");
});

test("gaps happy: converse classifies every speech act", async () => {
  const cases = [
    ["hey there choom", "greet"],
    ["goodbye friend, take care", "farewell"],
    ["what time is it?", "question"],
    ["my friend died last night", "comfort"],
    ["thanks so much for that", "comfort"],
    ["shut up right now", "refuse"],
    ["the sky is oddly blue", "assert"],
  ];
  for (const [line, act] of cases) {
    const conv = createConversation({ seed: 1, root: ROOT, dialectPack: slang });
    await conv.converse(line);
    assert.equal(conv.trainingData()[0].move.speechAct, act, `${line} -> ${act}`);
  }
});

test("gaps happy: converse stores valence polarity per line", async () => {
  const pos = createConversation({ seed: 2, root: ROOT, dialectPack: slang });
  await pos.converse("i love this, it is awesome");
  const pe = pos.daemon.memory.retrieveEpisodic({ content: "awesome" }, { limit: 1 })[0];
  assert.ok(pe.valence > 0, `positive stored: ${pe.valence}`);

  const neg = createConversation({ seed: 3, root: ROOT, dialectPack: slang });
  await neg.converse("i hate this, it is awful and sad");
  const ne = neg.daemon.memory.retrieveEpisodic({ content: "awful" }, { limit: 5 })[0];
  assert.ok(ne.valence < 0, `negative stored: ${ne.valence}`);

  const mixed = createConversation({ seed: 4, root: ROOT, dialectPack: slang });
  await mixed.converse("good but also bad today");
  const me = mixed.daemon.memory.retrieveEpisodic({ content: "good but" }, { limit: 5 })[0];
  assert.equal(me.valence, 0, "mixed reads neutral");
});

// ==================== EDGE CASES ====================

test("gaps edge: soul parsing tolerates aliases, bad numbers, dupes and quotes", () => {
  const v = parseSoulText(
    '---\nname: X\nspeech.swear: 0.9\nspeech.slang: nonsense\nspeech.warmth: 99\nlikes: "night rain", chrome, chrome\ndislikes: corpo\n---\nDrifting.',
    "inline"
  );
  assert.equal(v.swearing, 0.9, "swear alias");
  assert.equal(v.slang, 0.5, "non-numeric clamps to neutral");
  assert.equal(v.warmth, 1, "overflow clamps to 1");
  assert.deepEqual(v.likes, ["night rain", "chrome"], "quotes stripped, dupes dropped");
  assert.equal(matchPreferences(v, ""), null, "empty text is indifferent");
  assert.equal(matchPreferences(null, "rain"), null, "null voice is indifferent");
  assert.equal(matchPreferences({ likes: [], dislikes: [] }, "rain"), null, "empty lists indifferent");
});

test("gaps edge: buildAccentPack with no pack and no era stays usable", () => {
  const voice = parseSoulText("---\nname: Z\nspeech.dialect: plain\n---\nI talk.", "inline");
  const a = buildAccentPack(voice, null, null);
  assert.equal(a.dialect, "plain", "falls back to the voice dialect");
  assert.deepEqual(a.dialectWords, []);
  assert.deepEqual(a.bareWords, []);
  assert.deepEqual(a.datedWords, []);
  assert.deepEqual(a.unreachedWords, []);
});

test("gaps edge: four sentences is a soft nudge, five is a hard reject", () => {
  const four = "One here. Two here. Three here. Four here.";
  const v4 = validateReply(four, { userText: "hello there friend" });
  assert.equal(v4.ok, true, JSON.stringify(v4.hard));
  assert.ok(v4.soft.includes("target ≤3 sentences"), "soft guidance present");
  const five = `${four} Five here.`;
  has(reject(five, { userText: "hello there friend" }), "5 sentences");
});

test("gaps edge: every hard rule fires on its canonical fixture", () => {
  has(reject("**solid** work"), "markdown");
  has(reject("damn that was 🔥"), "emoji");
  has(reject("hello hello friend"), "stutter", "repeated word");
  has(reject("helloooo friend", { userText: "something else entirely" }), "stutter", "repeated letter");
  has(reject("fyi guys listen", { userText: "something else entirely" }), "FYI/AI tic");
  has(reject("line one\\nline two", { userText: "something else entirely" }), "literal escape");
  has(reject("Sure! Here is my reply:", { userText: "hi" }), "assistant framing");
  has(reject('answer="Six districts"'), "raw key=value, not speech");
  has(reject('{"frame": "greet"}'), "json blob, not speech");
  has(reject('ack_followup "damn words here"'), "frame label, not speech");
  has(reject("I'm sorry, but I cannot fulfill that"), "refusal, not speech");
  has(reject("Greeting in my street slang, just back at it."), "instruction, not speech");
  accept("Of course. You know me.", { userText: "you got me?" }, "warm opener still passes");
  accept("Solid.\nHow'd it go?", { userText: "i got the job" }, "single newline is a wrap artefact");
});

test("gaps edge: counter-ask only applies to a question asked", () => {
  has(
    reject("Is that so?", { userText: "did you hear about the docks?" }),
    "counter-asked instead of answering"
  );
  accept("Is that so?", { userText: "did you hear about the docks" }, "no question mark, no rule");
});

test("gaps edge: Chole vocatives fail, self-reference passes", () => {
  has(reject("Right, Chole — we both know."), "used your name for them");
  has(reject("damn, Chole, that's rough"), "used your name for them");
  accept("Chole here — what do you need?");
  accept("Call me whatever you like, I answer anyway.");
});

test("gaps edge: energy spendMultiple defaults a missing multiplier to 1", () => {
  const e = createEnergySystem({ atp: 1, glycogen: 0 });
  const before = e.atp;
  e.spendMultiple({ retrieval: 0 }); // 0 is falsy -> (mult || 1)
  assert.ok(Math.abs(before - e.atp - e.COSTS.retrieval) < 1e-12);
  assert.ok(Number.isFinite(e.getState().energyRatio));
  e.fromJSON(null); // no-op, never throws
  assert.equal(e.atp, before - e.COSTS.retrieval);
  e.forceSleep(); e.forceSleep(); // second call is a no-op, stays N1
  assert.equal(e.sleepStage, "N1");
  e.forceWake();
  assert.equal(e.sleepStage, "wake");
});

test("gaps edge: memory filters (person/tags/activation) and unknown types", () => {
  const m = createMemoryStore({ seed: 5 });
  m.addEvent({ type: "episodic", content: "rain story", person: "maya", tags: ["x"], importance: 9 });
  m.addEvent({ type: "episodic", content: "other story", person: "v", tags: ["y"], importance: 9 });
  assert.ok(m.retrieveEpisodic({}, { person: "maya", minActivation: -5 }).every((e) => e.person === "maya"));
  assert.ok(m.retrieveEpisodic({}, { tags: ["y"], minActivation: -5 }).every((e) => e.tags.includes("y")));
  assert.equal(m.retrieveEpisodic({}, { minActivation: 99 }).length, 0, "impossible threshold empties");
  const id = m.addEvent({ type: "mystery", content: "untyped" });
  assert.ok(id, "unknown types still log without indexing");
  assert.equal(m.retrieveEpisodic({}, { valence: 1, minActivation: -5 }).filter((e) => e.valence === 0).length, 0);
  m.fromJSON(null); // no-op
});

test("gaps edge: cycle ignores unknown buffers and evaluates any condition shape", () => {
  const cy = createCognitiveCycle({ seed: 6 });
  cy.setBuffer("nope", { x: 1 }); // no throw
  assert.equal(cy.getBuffer("nope"), undefined);
  cy.clearBuffer("nope"); // no throw
  cy.loadProductions(new Map([
    ["fn", { id: "fn", condition: { goal: (c) => c.x === 1 }, action: {}, utility: 0.9 }],
  ]));
  cy.setBuffer("goal", { x: 2 });
  assert.equal(cy.matchProductions().length, 0, "function condition rejects");
  cy.setBuffer("goal", { x: 1 });
  assert.equal(cy.matchProductions().length, 1, "function condition accepts");
  cy.loadProductions(new Map([["prim", { id: "prim", condition: "anything", action: {}, utility: 0.5 }]]));
  assert.equal(cy.matchProductions().length, 1, "a truthy primitive has no buffer keys to fail");
  cy.loadProductions(new Map([["nocond", { id: "nocond", action: {}, utility: 0.5 }]]));
  assert.equal(cy.matchProductions().length, 0, "falsy (missing) condition never matches");
  cy.fromJSON(null); // no-op
});

test("gaps edge: phrase handles stopword-only topics and empty skeletons", () => {
  const pe = createPhraseEngine({ seed: 9, root: ROOT, dialectPack: slang });
  pe.setRefs({ neurochem: createNeurochemEngine({ seed: 1 }), energy: createEnergySystem({}), memory: null });
  const cs = pe.generateCandidates(
    { speechAct: "assert", content: { text: "", valence: 0 } },
    { seed: 1, remembered: "the and of a to" }
  );
  assert.ok(cs.every((c) => !("carry" in c)), "stopwords leave no carry tag");
  assert.equal(pe.renderSkeleton({ slots: [], words: {} }), "…", "empty skeleton renders an ellipsis");
  assert.equal(pe.setEra(NaN), 2077, "non-finite era falls back to the pack year");
});

test("gaps edge: daemon stimulus variants all encode without throwing", () => {
  for (const type of ["threat", "reward", "social", "punishment", "neutral", "weird"]) {
    const d = createDaemon({ seed: 1, root: ROOT, dialectPack: slang });
    d.onStimulus({ type, intensity: 0.5, valence: type === "social" ? 0.5 : 0, text: `${type} probe`, personId: "p" });
    d.tickFor(2);
    assert.ok(d.memory.getStats().episodic >= 1, `${type} encoded`);
  }
  const d = createDaemon({ seed: 2, root: ROOT, dialectPack: slang });
  const off = d.onProactive(() => {});
  off(); // unsubscribe never throws
  assert.deepEqual(d.drainProactive(), [], "empty queue drains to []");
  assert.ok(d.tickFor(0) === null || d.tickFor(0) === undefined, "zero ticks is a no-op");
});

// ==================== ERROR CASES ====================

test("gaps error: loadSoul with an explicit missing path throws", () => {
  assert.throws(() => loadSoul("", "/tmp/ncn-no-such-soul-12345.md"), /SOUL file not found/);
});

test("gaps error: converse with empty text throws instead of hallucinating", async () => {
  const conv = createConversation({ seed: 1, root: ROOT, dialectPack: slang });
  await assert.rejects(() => conv.converse(""), /text is required/);
  await assert.rejects(() => conv.converse("   "), /text is required/);
});

test("gaps error: cycle updateUtility on unknown ids is a silent no-op", () => {
  const cy = createCognitiveCycle({ seed: 7 });
  cy.updateUtility("ghost", true); // must not throw
  cy.loadProductions(new Map([["p", { id: "p", condition: {}, action: {}, utility: 0.5, value: 1, cost: 0.1 }]]));
  cy.updateUtility("p", true);
  assert.ok(Math.abs(cy.toJSON().productions[0][1].utility - 0.9) < 1e-12, "win: 1*1-0.1");
  cy.updateUtility("p", false);
  assert.ok(Math.abs(cy.toJSON().productions[0][1].utility - 0.4) < 1e-12, "loss: 0.5*1-0.1");
});

test("gaps error: ollama reports HTTP failures as OllamaError", async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
    await assert.rejects(() => chat([{ role: "user", content: "hi" }]), (e) => e instanceof OllamaError && /ollama 500/.test(e.message));
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [] }) });
    await assert.rejects(() => chat([{ role: "user", content: "hi" }]), (e) => e instanceof OllamaError && /empty/.test(e.message));
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "  yo  " } }] }) });
    assert.equal(await chat([{ role: "user", content: "hi" }]), "yo", "trims the content");
  } finally {
    globalThis.fetch = real;
  }
});

test("gaps error: ollama sends seed and max_tokens only when finite", async () => {
  const real = globalThis.fetch;
  const bodies = [];
  try {
    globalThis.fetch = async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    };
    await chat([{ role: "user", content: "hi" }], { seed: 7 });
    assert.equal(bodies.at(-1).seed, 7, "finite seed sent");
    assert.equal(bodies.at(-1).max_tokens, 160, "default cap sent");
    await chat([{ role: "user", content: "hi" }], { seed: NaN });
    assert.ok(!("seed" in bodies.at(-1)), "non-finite seed omitted");
  } finally {
    globalThis.fetch = real;
  }
});

test("gaps error: triple engine failure falls back to a candidate, never throws", async () => {
  const conv = createConversation({ seed: 8, root: ROOT, dialectPack: slang });
  const r = await conv.converse("hello there", { engine: { chat: async () => "" } });
  assert.equal(r.source, "candidate-fallback");
  assert.ok(r.reply.length > 0);
  assert.ok(accept(r.reply, { userText: "hello there" }).ok, "fallback still gated");
});

// ==================== INTEGRATION ====================

test("gaps integration: threat while asleep wakes the daemon", () => {
  const d = createDaemon({ seed: 3, root: ROOT, dialectPack: slang });
  d.forceSleep();
  assert.equal(d.mode, "sleeping");
  d.onStimulus({ type: "threat", intensity: 0.9, valence: -0.5, text: "attack now" });
  assert.equal(d.mode, "wake", "high-intensity threat wakes");
});

test("gaps integration: idle mode engages after silence, sleep needs pressure", () => {
  const d = createDaemon({ seed: 4, root: ROOT, dialectPack: slang });
  d.fromJSON({ ...d.toJSON(), lastInputAt: Date.now() - 40_000 });
  d.tick();
  assert.equal(d.mode, "idle", "40s of silence idles");
  d.forceSleep();
  d.tickFor(3);
  assert.equal(d.mode, "sleeping", "sleep holds across ticks");
  d.forceWake();
  assert.equal(d.mode, "wake");
});

test("gaps integration: cycle retrieval + motor + clear actions run end to end", () => {
  const mem = createMemoryStore({ seed: 11 });
  mem.addEvent({ type: "episodic", content: "the rain tonight is unreal", valence: 0.2, importance: 8 });
  const cy = createCognitiveCycle({ seed: 12 });
  cy.setRefs({ neurochem: null, energy: null, memory: mem });
  cy.loadProductions(new Map([
    ["fetch", { id: "fetch", condition: {}, action: { retrieval: { request: { cue: { content: "rain" }, options: { limit: 1 } } } }, utility: 0.9 }],
  ]));
  cy.cycle({});
  assert.match(cy.getBuffer("retrieval")?.content || "", /rain/, "retrieval filled from memory");

  const cy2 = createCognitiveCycle({ seed: 13 });
  cy2.setRefs({ neurochem: null, energy: null, memory: null });
  cy2.setBuffer("goal", { x: 1 });
  cy2.loadProductions(new Map([
    ["say", { id: "say", condition: {}, action: { motor: { set: { text: "hi" } }, clear: ["goal"] }, utility: 0.9 }],
  ]));
  const out = cy2.runToOutput(5);
  assert.ok(out.output?.text === "hi", "motor output returned");
  assert.equal(cy2.getBuffer("goal"), null, "clear action ran");

  const cy3 = createCognitiveCycle({ seed: 14 });
  cy3.setRefs({ neurochem: null, energy: null, memory: null });
  cy3.loadProductions(new Map());
  assert.equal(cy3.runToOutput(3).output, null, "no production means no output");
});

test("gaps integration: consolidation decays stale skills and trims the log", () => {
  const m = createMemoryStore({ seed: 20, consolidationInterval: 0 });
  const old = Date.now() - 200 * 3600 * 1000; // ~8 days ago
  m.addEvent({ type: "procedural", productionId: "rusty", condition: {}, value: 1, cost: 0, success: true, timestamp: old });
  m.addEvent({ type: "social", personId: "ghost", valence: 0.9, timestamp: old });
  const beforeP = m.retrieveProcedural({}, {})[0].utility;
  const beforeT = m.retrieveSocial("ghost").trust;
  m.consolidate(Date.now());
  assert.ok(m.retrieveProcedural({}, {})[0].utility < beforeP, "stale skill decayed");
  assert.ok(m.retrieveSocial("ghost").trust < beforeT, "stale bond decayed");
  for (let i = 0; i < 10; i++) m.addEvent({ type: "episodic", content: `filler ${i}`, importance: 1 });
  m._eventLog.push(...Array(6000).fill({ id: "pad" }));
  m.consolidate(Date.now() + 10_000);
  assert.ok(m._eventLog.length <= 5000, `log pruned: ${m._eventLog.length}`);
});

test("gaps integration: every repair rule produces actionable guidance", async () => {
  const cases = [
    ["hello there", 'ack_followup "damn words here"', "drop the label"],
    ["hello there", '"Same as always."', "no quotes"],
    ["hello there", "(say it in your accent)", "brackets"],
    ["hello there", "Hey Johnny, what's good?", "never use your own name"],
    ["what time is it?", "Is that so?", "answer it plainly"],
    ["hello there", "Acknowledge their line and ask back.", "speak plainly"],
    ["hello there", "**solid** work", "fix: markdown"],
  ];
  for (const [line, bad, hint] of cases) {
    const conv = createConversation({ seed: 30, root: ROOT, dialectPack: slang });
    const sent = [];
    let n = 0;
    const engine = { chat: async (msgs) => { sent.push(msgs); return n++ === 0 ? bad : "Yo. Noted."; } };
    const r = await conv.converse(line, { engine });
    assert.equal(r.source, "llm-repaired", `${bad} must repair, got ${r.source}`);
    const repair = sent[1].filter((m) => m.role === "user").at(-1).content;
    assert.ok(repair.toLowerCase().includes(hint.split(" ")[0].toLowerCase()), `${bad} -> ${repair.slice(0, 120)}`);
  }
});

test("gaps integration: history caps at 12 while the turn counter keeps climbing", async () => {
  const conv = createConversation({ seed: 40, root: ROOT, dialectPack: slang });
  for (let i = 0; i < 13; i++) await conv.converse(`line number ${i} here friend`);
  assert.equal(conv.turn, 13);
  assert.equal(conv.history.length, 12, "history window capped");
  assert.equal(conv.trainingData().length, 13, "adapter log keeps every turn");
  assert.ok(conv.snapshot().tick >= 39, "daemon advanced 3 ticks per turn");
  assert.deepEqual(conv.drainProactive(), [], "drain is safe when idle");
});

test("gaps integration: a production can gate on every buffer at once", () => {
  const cy = createCognitiveCycle({ seed: 50 });
  cy.setRefs({ neurochem: null, energy: null, memory: null });
  const cond = {
    goal: { x: 1 }, retrieval: { y: 2 }, imaginal: { z: 3 }, perceptual: { p: 4 },
    interoceptive: { i: 5 }, affective: { a: 6 }, social: { s: 7 },
  };
  cy.loadProductions(new Map([["all", { id: "all", condition: cond, action: {}, utility: 0.9 }]]));
  for (const [buf, chunk] of [["goal", { x: 1 }], ["retrieval", { y: 2 }], ["imaginal", { z: 3 }], ["perceptual", { p: 4 }], ["interoceptive", { i: 5 }], ["affective", { a: 6 }], ["social", { s: 7 }]]) {
    cy.setBuffer(buf, chunk);
  }
  assert.equal(cy.matchProductions().length, 1, "all seven buffer gates hold");
  cy.setBuffer("social", { s: 999 });
  assert.equal(cy.matchProductions().length, 0, "one failed gate vetoes the production");
});

test("gaps integration: a hundred ticks reach the hormonal path and sleep restores", () => {
  const d = createDaemon({ seed: 51, root: ROOT, dialectPack: slang });
  const phase0 = d.energy.getState().circadianPhase;
  d.tickFor(100); // exactly one 0.01 Hz energy step
  assert.notEqual(d.energy.getState().circadianPhase, phase0, "circadian clock advanced");

  d.energy.consumeATP(0.5);
  const drained = d.energy.atp;
  d.forceSleep();
  d.tickFor(100);
  assert.equal(d.mode, "sleeping", "sleep holds");
  assert.ok(d.energy.atp > drained, `sleep restored ATP: ${drained} -> ${d.energy.atp}`);
});
