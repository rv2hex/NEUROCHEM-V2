/**
 * ATP power levels — the energy currency itself, the thresholds that gate it,
 * and what the LEVEL does to behaviour (cognition, skeleton count, speech).
 *
 * `atp` is a 0-1 scale where 1 is fully charged. Everything below is about
 * the level, not the plumbing: what it costs, where it clamps, which thresholds
 * fire, and how a drained agent differs from a rested one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnergySystem } from "../src/energy/system.js";
import { createPhraseEngine } from "../src/phrase/engine.js";
import { createNeurochemEngine } from "../src/neurochem/engine.js";
import { createCognitiveCycle } from "../src/cognitive/cycle.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slang = JSON.parse(fs.readFileSync(join(ROOT, "config", "slang.json"), "utf8"));

function makePhrase(atp, extra = {}) {
  const pe = createPhraseEngine({ seed: 42, root: ROOT, dialectPack: slang });
  pe.setRefs({
    neurochem: createNeurochemEngine({ seed: 1 }),
    energy: createEnergySystem({ atp, glycogen: 0, ...extra }),
    memory: null,
  });
  return pe;
}

const HOT = { dopamine: 0.9, norepinephrine: 0.9, orexin: 0.9 };
const NEUTRAL = { dopamine: 0.5, norepinephrine: 0.5, orexin: 0.5 };

// ==================== BOUNDS ====================

test("ATP clamps: draining past empty floors at 0, refilling past full caps at 1", () => {
  const e = createEnergySystem({ atp: 0.6 });
  e.consumeATP(5);
  assert.equal(e.atp, 0, "never goes negative");
  assert.ok(e.atp >= 0, "floor holds");

  e.produceATP(5);
  assert.equal(e.atp, 1, "never exceeds full");
  assert.ok(e.atp <= 1, "ceiling holds");
});

test("ATP never rises from spending — the renormalization bug must not return", () => {
  const e = createEnergySystem({ atp: 1 });
  let spends = 0;
  for (let i = 0; i < 300; i++) {
    const before = e.atp;
    const paid = e.consumeATP(0.05);
    assert.ok(e.atp <= before, `ATP ROSE on spend #${i}: ${before} -> ${e.atp}`);
    assert.ok(paid >= 0 && paid <= 0.05, `charged more than the cost: ${paid}`);
    if (paid > 0) spends++;
  }
  assert.ok(spends > 0, "the loop actually spent something");
  assert.equal(e.atp, 0, "drained to empty and stopped there");
});

test("ATP stays inside [0,1] under 2000 mixed steps", () => {
  const e = createEnergySystem({ atp: 0.5, glycogen: 0.5 });
  let worst = -Infinity;
  let best = Infinity;
  for (let i = 0; i < 2000; i++) {
    e.step(1, {
      neurochem: i % 2 ? HOT : NEUTRAL,
      wakefulness: i % 3 === 0 ? 0 : 1,
      cognitiveLoad: (i % 7) / 7,
      isSleeping: i % 5 === 0,
    });
    const a = e.getState().atp;
    worst = Math.max(worst, a);
    best = Math.min(best, a);
    assert.ok(Number.isFinite(a), `ATP went non-finite at step ${i}`);
  }
  assert.ok(best >= 0 && worst <= 1, `out of bounds: ${best} .. ${worst}`);
});

// ==================== PRICES AND THE AFFORDABILITY GATE ====================

test("canAfford gates exactly at the price", () => {
  const e = createEnergySystem({ atp: 0.5 });
  assert.ok(e.canAfford(0.5), "exactly affordable");
  assert.ok(!e.canAfford(0.5000001), "one micro-unit too far is refused");
  assert.ok(!e.canAfford(1), "cannot afford what it does not have");
});

test("a named spend draws exactly its price, and a batch sums them", () => {
  const e = createEnergySystem({ atp: 1 });
  const before = e.atp;
  e.spend("retrieval");
  assert.ok(
    Math.abs(before - e.atp - e.COSTS.retrieval) < 1e-12,
    `charged ${before - e.atp} for a ${e.COSTS.retrieval} retrieval`
  );

  const two = createEnergySystem({ atp: 1 });
  const b2 = two.atp;
  two.spendMultiple({ encoding: 1, attention_shift: 2 });
  const expected = e.COSTS.encoding + e.COSTS.attention_shift * 2;
  assert.ok(Math.abs(b2 - two.atp - expected) < 1e-12, `batch charged ${b2 - two.atp} vs ${expected}`);
});

test("an unknown cost name is free rather than throwing", () => {
  const e = createEnergySystem({ atp: 0.5 });
  const before = e.atp;
  const paid = e.spend("not_a_real_cost");
  assert.equal(paid, 0);
  assert.equal(e.atp, before, "no silent charge for a typo");
});

// ==================== LEVEL DYNAMICS ====================

test("ATP falls across a waking stretch", () => {
  const e = createEnergySystem({ atp: 1, glycogen: 0.6 });
  const start = e.atp;
  for (let i = 0; i < 600; i++) {
    e.step(1, { wakefulness: 1, cognitiveLoad: 0.5, isSleeping: false });
  }
  assert.ok(e.atp < start, `did not drain: ${start} -> ${e.atp}`);
  assert.ok(e.atp >= 0, "did not go negative");
});

test("ATP climbs during sleep and still cannot pass full", () => {
  const e = createEnergySystem({ atp: 0.3, glycogen: 0.9, sleepPressure: 0.6 });
  e.forceSleep();
  const before = e.atp;
  for (let i = 0; i < 400; i++) {
    e.step(60, { isSleeping: true, wakefulness: 0 });
  }
  assert.ok(e.atp > before, `sleep did not restore ATP: ${before} -> ${e.atp}`);
  assert.ok(e.atp <= 1, `overfull after sleep: ${e.atp}`);
  assert.ok(e.getState().sleepDebt < 0.5, `sleep did not pay down debt: ${e.getState().sleepDebt}`);
});

test("threshold: below 0.4 ATP, glycogen is drawn on to rescue it", () => {
  const e = createEnergySystem({ atp: 0.2, glycogen: 1.0 });
  e.step(10, { wakefulness: 1, isSleeping: false });
  const s = e.getState();
  assert.ok(s.glycogen < 1.0, `glycogen was not touched below the threshold: ${s.glycogen}`);
  assert.ok(e.atp > 0.2, `ATP was not rescued: ${e.atp}`);
});

test("threshold: above 0.8 ATP, the surplus is stored as glycogen instead", () => {
  const e = createEnergySystem({ atp: 0.9, glycogen: 0.5 });
  e.step(10, { wakefulness: 1, isSleeping: false });
  const s = e.getState();
  assert.ok(s.glycogen > 0.5, `surplus was not stored: ${s.glycogen}`);
  assert.ok(e.atp <= 0.9, `ATP did not give any up: ${e.atp}`);
});

test("threshold: glycogen only rescues while any remains", () => {
  const e = createEnergySystem({ atp: 0.1, glycogen: 0.05 });
  const g0 = e.getState().glycogen;
  e.step(10, { wakefulness: 1, isSleeping: false });
  assert.equal(e.getState().glycogen, g0, "nothing left to burn, so nothing was burnt");
});

// ==================== LEVEL -> STATE SENSOR ====================

test("AMPK tracks the ATP level: a drained cell reads catabolic, a charged one anabolic", () => {
  const high = createEnergySystem({ atp: 1.0, adp: 0.1, amp: 0.02, glycogen: 0.9 });
  const low = createEnergySystem({ atp: 0.05, adp: 0.5, amp: 0.2, glycogen: 0.05 });
  for (let i = 0; i < 60; i++) {
    high.step(1, { wakefulness: 1, isSleeping: false });
    low.step(1, { wakefulness: 1, isSleeping: false });
  }
  const hs = high.getState();
  const ls = low.getState();

  assert.ok(ls.ampk > hs.ampk, `AMPK ignored the level: low=${ls.ampk} high=${hs.ampk}`);
  assert.ok(ls.ampk > 0.5, `drained state did not read catabolic: ${ls.ampk}`);
  assert.ok(ls.mtor < hs.mtor, `mTOR did not fall when AMPK rose: low=${ls.mtor} high=${hs.mtor}`);
  assert.ok(ls.energyRatio < hs.energyRatio, "energy ratio follows ATP");
});

// ==================== LEVEL -> BILLING ====================

test("neutral tones cost exactly the basal rate — arousal is not charged for free or twice", () => {
  const withNeutral = createEnergySystem({ atp: 1, glycogen: 0.3 });
  const withNothing = createEnergySystem({ atp: 1, glycogen: 0.3 });
  for (let i = 0; i < 300; i++) {
    withNeutral.step(1, { neurochem: NEUTRAL, wakefulness: 1, isSleeping: false });
    withNothing.step(1, { wakefulness: 1, isSleeping: false });
  }
  assert.ok(
    Math.abs(withNeutral.atp - withNothing.atp) < 1e-12,
    `neutral tones should bill the basal rate: ${withNeutral.atp} vs ${withNothing.atp}`
  );
});

test("arousal is billed only while awake", () => {
  const awake = createEnergySystem({ atp: 1, glycogen: 0.3 });
  const asleepish = createEnergySystem({ atp: 1, glycogen: 0.3 });
  for (let i = 0; i < 300; i++) {
    awake.step(1, { neurochem: HOT, wakefulness: 1, isSleeping: false });
    asleepish.step(1, { neurochem: HOT, wakefulness: 0, isSleeping: false });
  }
  assert.ok(
    awake.atp < asleepish.atp,
    `wakefulness multiplier did not apply: awake=${awake.atp} resting=${asleepish.atp}`
  );
});

// ==================== LEVEL -> BEHAVIOUR ====================

test("too broke to think: an unaffordable production never matches", () => {
  const energy = createEnergySystem({ atp: 0.02, glycogen: 0 });
  const cy = createCognitiveCycle({ seed: 1 });
  cy.setRefs({ neurochem: null, energy, memory: null });
  cy.loadProductions(
    new Map([["speak", { id: "speak", condition: {}, action: {}, utility: 0.9, cost: 0.05 }]])
  );

  assert.equal(cy.matchProductions().length, 0, "cost 0.05 with 0.02 ATP must not fire");

  energy.produceATP(0.5);
  assert.equal(cy.matchProductions().length, 1, "once funded, the same production fires");
});

test("low ATP thins out the skeletons offered", () => {
  const rested = makePhrase(1).generateCandidates(
    { speechAct: "assert", content: { valence: 0 } },
    { seed: 1 }
  );
  const exhausted = makePhrase(0.5, { sleepPressure: 0.9 }).generateCandidates(
    { speechAct: "assert", content: { valence: 0 } },
    { seed: 1 }
  );

  assert.ok(rested.length >= 4, `rested offers a full set: ${rested.length}`);
  assert.ok(
    exhausted.length < rested.length,
    `a drained agent offers fewer skeletons: ${exhausted.length} vs ${rested.length}`
  );
  assert.ok(exhausted.length >= 1, "but never none");
});

test("low ATP makes the agent quieter and less certain in its tendencies", () => {
  const rested = makePhrase(1).actionTendencies();
  const drained = makePhrase(0.1).actionTendencies();

  assert.ok(
    drained.verbose < rested.verbose,
    `verbosity ignored the level: ${drained.verbose} vs ${rested.verbose}`
  );
  assert.ok(
    drained.terse > rested.terse,
    `terse did not rise when drained: ${drained.terse} vs ${rested.verbose}`
  );
  assert.ok(
    drained.certain < rested.certain,
    `certainty ignored the level: ${drained.certain} vs ${rested.certain}`
  );
  assert.ok(
    drained.uncertain > rested.uncertain,
    `uncertainty did not rise when drained: ${drained.uncertain} vs ${rested.uncertain}`
  );
});

test("stateNarrative describes a drained body, not a rested one", () => {
  const drained = makePhrase(0.1).stateNarrative();
  const rested = makePhrase(1).stateNarrative();
  assert.match(drained, /eyelid|drag|heavy/i, `drained narrative: ${drained}`);
  assert.notEqual(drained, rested, "narrative must move with the level");
});

// ==================== PERSISTENCE ====================

test("the ATP level survives a checkpoint round-trip", () => {
  const e = createEnergySystem({ atp: 0.42, glycogen: 0.33, sleepPressure: 0.61 });
  const restored = createEnergySystem({});
  restored.fromJSON(JSON.parse(JSON.stringify(e.toJSON())));

  assert.equal(restored.atp, 0.42, "ATP preserved exactly");
  assert.equal(restored.getState().glycogen, 0.33, "glycogen preserved exactly");
  assert.equal(restored.sleepPressure, 0.61, "sleep pressure preserved exactly");
});
