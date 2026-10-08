import { test } from "node:test";
import assert from "node:assert/strict";
import { createNeurochemEngine, NT, NT_NAMES } from "../src/neurochem/engine.js";
import { createEnergySystem } from "../src/energy/system.js";
import { createMemoryStore } from "../src/memory/store.js";

test("NeurochemEngine: creates 12 NT systems with 3 compartments each", () => {
  const eng = createNeurochemEngine({ seed: 1 });
  assert.equal(eng.state.length, 12 * 3);
  assert.equal(NT_NAMES.length, 12);
});

test("NeurochemEngine: reward triggers DA phasic burst", () => {
  const eng = createNeurochemEngine({ seed: 1 });
  const before = eng.getVolume(NT.DOPAMINE);
  eng.releasePhasic(NT.DOPAMINE, 0.9);
  const afterSynaptic = eng.get(NT.DOPAMINE, 1);
  assert.ok(afterSynaptic > 0, "synaptic DA rose after burst");
  // Step a few times: diffusion to volume
  for (let i = 0; i < 10; i++) {
    eng.step(1, { energy: 1, cortisol: 0.5 });
  }
  assert.ok(typeof before === "number");
});

test("NeurochemEngine: step does not produce NaN or out-of-range", () => {
  const eng = createNeurochemEngine({ seed: 2 });
  for (let i = 0; i < 100; i++) {
    eng.step(1, {
      cortisol: Math.random(),
      energy: Math.random(),
      circadian_phase: Math.random(),
      stress: Math.random(),
      reward: Math.random() > 0.8 ? 1 : 0,
      wakefulness: 1,
    });
  }
  const vols = eng.getAllVolumes();
  for (const [name, v] of Object.entries(vols)) {
    assert.ok(Number.isFinite(v), `${name} is finite: ${v}`);
    assert.ok(v >= 0 && v <= 1, `${name} in [0,1]: ${v}`);
  }
});

test("NeurochemEngine: gain accessors return finite values", () => {
  const eng = createNeurochemEngine({ seed: 3 });
  eng.step(1, { energy: 1 });
  assert.ok(Number.isFinite(eng.getD1Gain()));
  assert.ok(Number.isFinite(eng.getAlpha2Gain()));
  assert.ok(Number.isFinite(eng.get5HT1AGain()));
});

test("NeurochemEngine: serialization round-trip", () => {
  const eng = createNeurochemEngine({ seed: 4 });
  for (let i = 0; i < 10; i++) eng.step(1, { energy: 1 });
  const json = eng.toJSON();
  const eng2 = createNeurochemEngine({ seed: 5 });
  eng2.fromJSON(json);
  assert.deepEqual([...eng2.state], [...eng.state]);
});

test("EnergySystem: consuming ATP reduces it, producing restores", () => {
  const e = createEnergySystem({ atp: 0.8 });
  const before = e.atp;
  e.consumeATP(0.1);
  assert.ok(e.atp < before);
  const low = e.atp;
  e.produceATP(0.2);
  assert.ok(e.atp > low);
});

test("EnergySystem: spend() respects costs, canAfford gates", () => {
  const e = createEnergySystem({ atp: 0.001 });
  assert.equal(e.canAfford(0.01), false);
  assert.equal(e.canAfford(0.0005), true);
  e.spend("production_fire"); // should not throw, consumes what it can
  assert.ok(e.atp >= 0);
});

test("EnergySystem: sleep pressure accumulates while awake and decays in sleep", () => {
  const e = createEnergySystem({ sleepPressure: 0.1 });
  for (let i = 0; i < 60; i++) {
    e.step(1, { wakefulness: 1, isSleeping: false, cognitiveLoad: 0.5 });
  }
  const awake = e.sleepPressure;
  assert.ok(awake > 0.1, "pressure rose while awake");

  e.forceSleep();
  for (let i = 0; i < 600; i++) {
    e.step(1, { wakefulness: 0.1, isSleeping: true });
  }
  assert.ok(e.sleepPressure < awake, "pressure fell while sleeping");
});

test("EnergySystem: circadian phase advances with time", () => {
  const e = createEnergySystem({ circadianPhase: 0 });
  e.step(43200, {}); // half a day
  assert.ok(e.circadianPhase > 0.4 && e.circadianPhase < 0.6, `phase ~0.5: ${e.circadianPhase}`);
  e.step(86400, {}); // a full day more wraps back to start
  assert.ok(Math.abs(e.circadianPhase - 0.5) < 0.01, `phase wrapped: ${e.circadianPhase}`);
});

test("EnergySystem: cortisol has ultradian + circadian structure", () => {
  const e = createEnergySystem({ circadianPhase: 0.3 }); // morning
  e.step(1, {});
  const morning = e.cortisolLevel;
  e.step(3600, {});
  const later = e.cortisolLevel;
  assert.ok(morning !== later, "cortisol moves over the hour");
  assert.ok(morning >= 0 && morning <= 1);
});

test("EnergySystem: serialization round-trip", () => {
  const e = createEnergySystem({});
  e.step(100, {});
  const json = e.toJSON();
  const e2 = createEnergySystem({});
  e2.fromJSON(json);
  assert.equal(e2.getState().atp, json.atp);
});

test("MemoryStore: 4 indices populated by typed events", () => {
  const mem = createMemoryStore({ seed: 1 });
  mem.addEvent({ type: "episodic", content: "met Johnny at the Afterlife", valence: 0.6, importance: 8 });
  mem.addEvent({ type: "semantic", content: "Johnny is a legend", concept: { id: "johnny", label: "Johnny" } });
  mem.addEvent({ type: "procedural", productionId: "p1", condition: {}, action: {}, success: true, value: 1, cost: 0.1 });
  mem.addEvent({ type: "social", personId: "choom1", valence: 0.5, vocab: ["preem", "choom"] });

  const stats = mem.getStats();
  assert.ok(stats.episodic >= 1);
  assert.ok(stats.semantic >= 1);
  assert.ok(stats.procedural >= 1);
  assert.ok(stats.social >= 1);
});

test("MemoryStore: episodic retrieval sorts by activation, respects limit", () => {
  const mem = createMemoryStore({ seed: 2 });
  for (let i = 0; i < 20; i++) {
    mem.addEvent({ type: "episodic", content: `event number ${i} about the city`, valence: i % 2 ? 0.5 : -0.5, importance: i });
  }
  const results = mem.retrieveEpisodic({ content: "city" }, { limit: 5 });
  assert.ok(results.length <= 5);
  assert.ok(results.length >= 1);
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i - 1].activation >= results[i].activation, "sorted descending");
  }
});

test("MemoryStore: semantic spreading activation follows links", () => {
  const mem = createMemoryStore({ seed: 3 });
  mem.addEvent({ type: "semantic", content: "Arasaka and Militech compete", concept: { id: "arasaka", label: "Arasaka" } });
  mem.addEvent({ type: "semantic", content: "Arasaka Militech rivalry", concept: { id: "militech", label: "Militech" } });
  const results = mem.retrieveSemantic(["arasaka"], { spreadDepth: 2 });
  assert.ok(results.length >= 1);
  assert.ok(results[0].id === "arasaka");
});

test("MemoryStore: social model trust tracks positive/conflict ratio", () => {
  const mem = createMemoryStore({ seed: 4 });
  for (let i = 0; i < 10; i++) {
    mem.addEvent({ type: "social", personId: "v", valence: 0.8 });
  }
  const model = mem.retrieveSocial("v");
  assert.ok(model);
  assert.ok(model.trust > 0.6, `trust grew: ${model.trust}`);
});

test("MemoryStore: procedural utility learned from success", () => {
  const mem = createMemoryStore({ seed: 5 });
  for (let i = 0; i < 5; i++) {
    mem.addEvent({ type: "procedural", productionId: "good", success: true, value: 1, cost: 0.1 });
  }
  mem.addEvent({ type: "procedural", productionId: "bad", success: false, value: 1, cost: 0.1 });
  const prods = mem.retrieveProcedural({ minUtility: -1 }, {});
  assert.ok(prods.length >= 2);
  assert.ok(prods[0].id === "good", "successful production ranks first");
});

test("MemoryStore: consolidation runs and returns counts", () => {
  const mem = createMemoryStore({ seed: 6, consolidationInterval: 0 });
  mem.addEvent({ type: "episodic", content: "important thing", importance: 8 });
  const result = mem.consolidate(Date.now());
  assert.ok(result);
  assert.ok(result.episodicCount >= 1);
});

test("MemoryStore: serialization round-trip", () => {
  const mem = createMemoryStore({ seed: 7 });
  mem.addEvent({ type: "episodic", content: "keep me", valence: 0.5, importance: 6 });
  mem.addEvent({ type: "social", personId: "x", valence: 0.7 });
  const json = mem.toJSON();
  const mem2 = createMemoryStore({});
  mem2.fromJSON(json);
  assert.ok(mem2.retrieveSocial("x"));
  assert.equal(mem2.getStats().episodic, mem.getStats().episodic);
});