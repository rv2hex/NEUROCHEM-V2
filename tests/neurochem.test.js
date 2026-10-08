import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createNeurochemEngine,
  NT,
  NT_NAMES,
} from "../src/neurochem/engine.js";
import { createEnergySystem } from "../src/energy/system.js";
import { createDaemon } from "../src/daemon/index.js";
import { parseSoulText, matchPreferences } from "../src/personality/soul.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slang = JSON.parse(readFileSync(join(ROOT, "config", "slang.json"), "utf8"));

const rest = (i = 0) => ({
  energy: 1,
  cortisol: 0.5,
  stress: 0,
  wakefulness: 1,
  circadian_phase: (i % 240) / 240,
});

// ==================== A — reserve collapse ====================

test("A: vesicular reserve survives 30 simulated minutes at rest", () => {
  const eng = createNeurochemEngine();
  for (let i = 0; i < 1800; i++) eng.step(1, rest(i));
  for (const [name, v] of Object.entries(eng.getSnapshot().somas)) {
    assert.ok(v >= 0.95, `${name} reserve held: ${v}`);
  }
});

test("A: a punishment burst is as large at hour 30 as it was at t=0", () => {
  const t0 = createNeurochemEngine();
  const base0 = t0.getTone(NT.SEROTONIN);
  t0.releasePhasic(NT.SEROTONIN, 1);
  const delta0 = t0.getTone(NT.SEROTONIN) - base0;

  const late = createNeurochemEngine();
  for (let i = 0; i < 1800; i++) late.step(1, rest(i));
  const baseLate = late.getTone(NT.SEROTONIN);
  late.releasePhasic(NT.SEROTONIN, 1);
  const deltaLate = late.getTone(NT.SEROTONIN) - baseLate;

  assert.ok(delta0 > 0.01, "burst moves the tone at all");
  assert.ok(
    deltaLate >= delta0 * 0.85,
    `burst decayed: ${deltaLate.toFixed(4)} vs ${delta0.toFixed(4)}`
  );
});

test("A: the autoreceptor brakes release instead of draining the pool", () => {
  const eng = createNeurochemEngine();
  const somaBefore = eng.getSnapshot().somas.serotonin;
  eng.releasePhasic(NT.SEROTONIN, 1);
  const somaAfter = eng.getSnapshot().somas.serotonin;
  assert.ok(somaAfter > somaBefore - 0.5, "one burst draws down the pool at most");
  // A resting soma is never touched by tonic volume.
  for (let i = 0; i < 600; i++) eng.step(1, rest(i));
  assert.ok(eng.getSnapshot().somas.serotonin > 0.95, "soma not drained by tonic tone");
});

// ==================== B — phasic buffer leak ====================

test("B: zero-reuptake systems clear their phasic buffer instead of leaking", () => {
  const eng = createNeurochemEngine();
  for (let i = 0; i < 600; i++) {
    eng.step(1, { energy: 1 });
    eng.releasePhasic(NT.OXYTOCIN, 0.5); // no OXTR reuptake transporter
  }
  const buffers = eng.getSnapshot().phasicBuffers;
  for (let nt = 0; nt < NT_NAMES.length; nt++) {
    assert.ok(
      Number.isFinite(buffers[nt]) && buffers[nt] >= 0 && buffers[nt] < 1,
      `${NT_NAMES[nt]} buffer bounded: ${buffers[nt]}`
    );
  }
  assert.ok(buffers[NT.OXYTOCIN] < 0.5, `OXT buffer cleared: ${buffers[NT.OXYTOCIN]}`);
});

test("B: every system's buffer clearance floor is strictly positive", () => {
  const eng = createNeurochemEngine();
  // A buffer of 0.4 left alone for 60 simulated seconds must be mostly gone.
  const zeros = [NT.OXYTOCIN, NT.ACETYLCHOLINE, NT.HISTAMINE, NT.MELATONIN];
  for (const nt of zeros) eng.schedulePhasic(nt, 1, 0);
  for (let i = 0; i < 60; i++) eng.step(1, { energy: 1 });
  const buffers = eng.getSnapshot().phasicBuffers;
  for (const nt of zeros) {
    assert.ok(buffers[nt] < 0.05, `${NT_NAMES[nt]} cleared: ${buffers[nt]}`);
  }
});

// ==================== D — melatonin tone scale ====================

test("D: melatonin reads on the tone scale at midnight, not as raw concentration", () => {
  const eng = createNeurochemEngine();
  assert.ok(
    Math.abs(eng.getToneRef(NT.MELATONIN) - 0.2) < 1e-6,
    "melatonin has a night target, not baseline_tonic 0"
  );

  for (let i = 0; i < 3600; i++) eng.step(1, { energy: 1, circadian_phase: 0, wakefulness: 0 });
  const tone = eng.getTone(NT.MELATONIN);
  assert.ok(Math.abs(tone - 0.5) < 0.1, `midnight melatonin tone is neutral: ${tone}`);
});

test("D: melatonin tone collapses across the day", () => {
  const eng = createNeurochemEngine();
  for (let i = 0; i < 3600; i++) eng.step(1, { energy: 1, circadian_phase: 0.5, wakefulness: 1 });
  assert.ok(eng.getTone(NT.MELATONIN) < 0.1, `daytime tone: ${eng.getTone(NT.MELATONIN)}`);
});

// ==================== F — dead / contradictory code ====================

test("F: phantom phasic context keys are inert (they used to be an unbounded burst train)", () => {
  const clean = createNeurochemEngine();
  const noisy = createNeurochemEngine();
  for (let i = 0; i < 600; i++) {
    clean.step(1, { energy: 1, stress: 0.3 });
    noisy.step(1, {
      energy: 1,
      stress: 0.3,
      reward: 1,
      punishment: 1,
      novelty: 1,
      social_contact: 1,
    });
  }
  assert.deepEqual(noisy.toJSON(), clean.toJSON(), "reward/punishment/novelty/social_contact are events, not step() input");
});

test("F: a burst spills into the volume compartment the tone reads", () => {
  const eng = createNeurochemEngine();
  const before = eng.getVolume(NT.DOPAMINE);
  eng.releasePhasic(NT.DOPAMINE, 1);
  assert.ok(eng.getVolume(NT.DOPAMINE) > before, "volume_spill promoted from an unreachable default");
});

test("F: cortisol slows DA supply and tonic level in the same direction", () => {
  const calm = createNeurochemEngine();
  const loaded = createNeurochemEngine();
  for (let i = 0; i < 1800; i++) {
    calm.step(1, { ...rest(i), cortisol: 0.5 });
    loaded.step(1, { ...rest(i), cortisol: 1.0 });
  }
  assert.ok(
    loaded.getVolume(NT.DOPAMINE) < calm.getVolume(NT.DOPAMINE),
    `high cortisol lowers tonic DA: ${loaded.getVolume(NT.DOPAMINE)} vs ${calm.getVolume(NT.DOPAMINE)}`
  );
  assert.ok(
    loaded.getSnapshot().somas.dopamine <= calm.getSnapshot().somas.dopamine,
    "and it does not refill the reserve faster than the calm one"
  );
});

test("F: params survive a checkpoint round-trip and re-derive the calibration", () => {
  const custom = createNeurochemEngine({ params: { 0: { synthesis_rate: 0.09, baseline_tonic: 0.24 } } });
  const wire = JSON.parse(JSON.stringify(custom.toJSON()));

  const restored = createNeurochemEngine();
  restored.fromJSON(wire);

  assert.equal(restored.params[NT.DOPAMINE].synthesis_rate, 0.09);
  assert.equal(restored.params[NT.DOPAMINE].baseline_tonic, 0.24);
  assert.ok(
    Math.abs(restored.getToneRef(NT.DOPAMINE) - 0.24) < 1e-6,
    "toneRef re-derived from restored params"
  );
  assert.ok(Math.abs(restored.getVolume(NT.DOPAMINE) - 0.24) < 1e-6, "state restored");
  // And an untouched system must not have picked up the override.
  assert.equal(restored.params[NT.SEROTONIN].baseline_tonic, 0.1);
});

test("F: resting occupancy is non-zero before the first step", () => {
  const eng = createNeurochemEngine();
  assert.ok(eng.getD1Gain() > 0, `D1 gain at t=0: ${eng.getD1Gain()}`);
  assert.ok(eng.getOXTRGain() > 0, `OXTR gain at t=0: ${eng.getOXTRGain()}`);
  assert.ok(eng.getCB1Gain() > 0, `CB1 gain at t=0: ${eng.getCB1Gain()}`);
});

test("F: applyReceptorHomeostasis writes into the engine (it used to edit a copy)", () => {
  const eng = createNeurochemEngine();
  for (let i = 0; i < 3000; i++) eng.step(1, { ...rest(i), circadian_phase: 0.5 });

  const drifted = eng.getReceptorDensity()[NT.MELATONIN];
  assert.ok(drifted > 1.05, `chronic daytime silence upregulates: ${drifted}`);

  eng.applyReceptorHomeostasis(1);
  const after = eng.getReceptorDensity();
  for (let nt = 0; nt < NT_NAMES.length; nt++) {
    assert.ok(Math.abs(after[nt] - 1) < 0.05, `${NT_NAMES[nt]} density restored: ${after[nt]}`);
  }
  // It has to still be there after another step — i.e. it was real state.
  eng.step(1, rest());
  assert.ok(Math.abs(eng.getReceptorDensity()[NT.MELATONIN] - 1) < 0.1);
});

test("F: sustained stress is a tonic NE level, and it is not railed at 1.0", () => {
  const calm = createNeurochemEngine();
  const loaded = createNeurochemEngine();
  for (let i = 0; i < 1200; i++) {
    calm.step(1, { ...rest(i), stress: 0 });
    loaded.step(1, { ...rest(i), stress: 1 });
  }
  const calmTone = calm.getTone(NT.NOREPINEPHRINE);
  const loadTone = loaded.getTone(NT.NOREPINEPHRINE);
  assert.ok(loadTone > calmTone + 0.1, `stress raises NE: ${calmTone} → ${loadTone}`);
  assert.ok(loadTone < 0.9, `headroom left for a real event: ${loadTone}`);
});

// ==================== G — concentration-scale reads ====================

test("G: resting DA is a concentration well below any tone threshold", () => {
  const eng = createNeurochemEngine();
  for (let i = 0; i < 600; i++) eng.step(1, rest(i));
  const volume = eng.getVolume(NT.DOPAMINE);
  const tone = eng.getTone(NT.DOPAMINE);
  assert.ok(volume < 0.15, `raw DA sits at ${volume}, so a \`> 0.15\` gate is always closed`);
  assert.ok(Math.abs(tone - 0.5) < 0.05, `tone at rest is neutral: ${tone}`);
});

test("G: getToneByName keys off names (getVolume keyed off strings and returned NaN)", () => {
  const eng = createNeurochemEngine();
  for (let i = 0; i < 600; i++) eng.step(1, rest(i));
  assert.ok(Math.abs(eng.getToneByName("dopamine") - eng.getTone(NT.DOPAMINE)) < 1e-9);
  assert.equal(eng.getToneByName("not-a-system"), 0.5, "unknown names fall back to neutral, not NaN");
});

test("G: snapshot exposes tones alongside volumes", () => {
  const eng = createNeurochemEngine();
  const snap = eng.getSnapshot();
  assert.ok(snap.tones && !Array.isArray(snap.tones));
  for (const name of NT_NAMES) {
    assert.ok(Number.isFinite(snap.tones[name]), `${name} tone finite`);
    assert.ok(snap.tones[name] >= 0 && snap.tones[name] <= 1, `${name} tone in [0,1]`);
    assert.ok(typeof snap.volumes[name] === "number", `${name} volume still present`);
  }
});

// ==================== Determinism ====================

test("the integration is deterministic — same context, byte-identical state", () => {
  const a = createNeurochemEngine();
  const b = createNeurochemEngine();
  for (let i = 0; i < 500; i++) {
    const ctx = { energy: 0.7, stress: 0.4, cortisol: (i % 90) / 90, circadian_phase: (i % 240) / 240 };
    a.step(1, ctx);
    b.step(1, { ...ctx });
  }
  assert.deepEqual(a.toJSON(), b.toJSON());
});

// ==================== Energy ↔ tone ====================

test("energy bills arousal on the tone scale, not on concentration", () => {
  const hot = createEnergySystem();
  const flat = createEnergySystem();
  const tones = (v) => ({ dopamine: v, norepinephrine: v, orexin: v });

  hot.step(100, { neurochem: tones(0.9), wakefulness: 1, cognitiveLoad: 0 });
  flat.step(100, { neurochem: tones(0.5), wakefulness: 1, cognitiveLoad: 0 });

  assert.ok(
    hot.getState().atp < flat.getState().atp,
    `hot system cost more ATP: ${hot.getState().atp} vs ${flat.getState().atp}`
  );
});

test("arousal is free while asleep", () => {
  const hot = createEnergySystem();
  const flat = createEnergySystem();
  const tones = (v) => ({ dopamine: v, norepinephrine: v, orexin: v });

  hot.step(100, { neurochem: tones(0.9), wakefulness: 0, isSleeping: true });
  flat.step(100, { neurochem: tones(0.5), wakefulness: 0, isSleeping: true });

  assert.equal(hot.getState().atp, flat.getState().atp);
});

// ==================== SOUL preferences → energy ====================

test("matchPreferences fires on word boundaries only", () => {
  const voice = parseSoulText(
    "---\nname: Test\nlikes: rain, night market\ndislikes: corpo\n---\nI talk fast.",
    "inline"
  );
  assert.deepEqual(matchPreferences(voice, "the rain is coming down"), { liked: "rain", disliked: null });
  assert.deepEqual(matchPreferences(voice, "a corpo offer"), { liked: null, disliked: "corpo" });
  assert.equal(matchPreferences(voice, "tonight is bright"), null, "'night' must not match inside 'tonight'");
  assert.equal(matchPreferences(voice, "the brain is fine"), null, "'rain' must not match inside 'brain'");
  assert.deepEqual(
    matchPreferences(voice, "rain on the corpo board"),
    { liked: "rain", disliked: "corpo" },
    "both reported so aversion can win"
  );
});

test("a SOUL like raises energy; a dislike spends it", () => {
  const d = createDaemon({ seed: 11, root: ROOT, dialectPack: slang });

  d.energy.consumeATP(0.5);
  const drained = d.energy.atp;
  d.onStimulus({ type: "neutral", intensity: 0.3, valence: 0, text: "the rain tonight is unreal" });
  assert.ok(d.energy.atp > drained, `like refuels: ${drained} → ${d.energy.atp}`);

  const beforeDislike = d.energy.atp;
  d.onStimulus({ type: "neutral", intensity: 0.3, valence: 0, text: "a corpo offer came through" });
  assert.ok(d.energy.atp < beforeDislike, `dislike costs: ${beforeDislike} → ${d.energy.atp}`);

  const beforeNeutral = d.energy.atp;
  d.onStimulus({ type: "neutral", intensity: 0.3, valence: 0, text: "the tram ran late again" });
  assert.equal(d.energy.atp, beforeNeutral, "an indifferent line moves neither way");
});

test("the daemon reports tones, and DA's tone is what the spontaneity gate sees", () => {
  const d = createDaemon({ seed: 12, root: ROOT, dialectPack: slang });
  // 90 ticks: nine cognitive cycles but no 0.01 Hz hormonal step yet, so this
  // reads the resting chemistry before 200 awake ticks honestly burn ATP and
  // sag the drive (metabolic drain is covered in atp.test.js and gaps.test.js).
  d.tickFor(90);

  const snap = d.snapshot();
  assert.ok(snap.tones, "daemon snapshot carries tones");
  for (const name of NT_NAMES) assert.ok(Number.isFinite(snap.tones[name]), `${name} tone`);

  // A resting DA tone is ~0.5 — above the old concentration gate (0.15) would
  // have been false, and the new tone gate (0.6) correctly stays closed.
  assert.ok(Math.abs(snap.tones.dopamine - 0.5) < 0.1, `resting DA tone: ${snap.tones.dopamine}`);
  assert.ok(snap.tones.dopamine <= 0.6, "no spontaneous thought at rest");

  // Push DA up and the gate opens on the tone scale.
  d.neurochem.releasePhasic(NT.DOPAMINE, 10);
  d.tickFor(1);
  assert.ok(d.neurochem.getTone(NT.DOPAMINE) > 0.6, "a real reward opens the gate");
});

// ==================== RECEPTORS ACTUALLY DRIVE THE GAIN ====================

test("gain: chronic high dopamine damps the modulation, homeostasis restores it", () => {
  const VOLUME = 2; // compartment index inside the engine's 3-wide state
  const fresh = createNeurochemEngine({ seed: 4 });
  const chronic = createNeurochemEngine({ seed: 4 });

  // Hold DA at saturation long enough for the receptor population to respond.
  // targetDensity = 1 + (0.5 - tone) * 0.6, relaxed at 0.005/step.
  for (let i = 0; i < 200; i++) {
    chronic.set(NT.DOPAMINE, VOLUME, 1);
    chronic.step(1);
  }

  // Both sides read the SAME tone, so any gain difference is receptors alone.
  fresh.set(NT.DOPAMINE, VOLUME, 1);
  chronic.set(NT.DOPAMINE, VOLUME, 1);

  const toneFresh = fresh.getToneByName("dopamine");
  const toneChronic = chronic.getToneByName("dopamine");
  assert.ok(toneChronic >= 0.95, `DA saturated on the chronic side: ${toneChronic}`);
  assert.ok(
    Math.abs(toneFresh - toneChronic) < 1e-6,
    `the comparison must hold tone constant: ${toneFresh} vs ${toneChronic}`
  );

  const density = chronic.getReceptorDensity()[NT.DOPAMINE];
  assert.ok(density < 1, `sustained high tone must downregulate: density=${density}`);

  const gFresh = fresh.getGainByName("dopamine");
  const gChronic = chronic.getGainByName("dopamine");
  assert.ok(gChronic < gFresh, `a habituated system feels less: fresh=${gFresh} chronic=${gChronic}`);

  // ...so the same production gain moves utility less. This is the formula
  // cognitive/cycle.js applies per neurochemGain entry.
  const utility = (level) => Math.min(1, Math.max(0, 0.5 * (1 + 0.5 * (level - 0.5))));
  assert.ok(
    utility(gChronic) < utility(gFresh),
    `chronic moves utility less: ${utility(gChronic)} vs ${utility(gFresh)}`
  );

  // Sleep puts the receptors back, and the SAME input then moves utility the
  // same amount as it does in a brand new engine.
  chronic.applyReceptorHomeostasis(1);
  const gReset = chronic.getGainByName("dopamine");
  assert.ok(
    Math.abs(gReset - gFresh) < 1e-6,
    `homeostasis returns the gain to fresh: ${gReset} vs ${gFresh}`
  );
  assert.ok(Math.abs(utility(gReset) - utility(gFresh)) < 1e-9, "utility follows the gain back");

  // Bounded to the tone scale either way — never the 0.4-1.6 swing of
  // `tone * density`.
  for (const g of [gFresh, gChronic, gReset]) {
    assert.ok(g >= 0 && g <= 1, `gain stays on the tone scale: ${g}`);
  }
});

test("gain: receptor drift never invents a signal out of a neutral tone", () => {
  const nc = createNeurochemEngine({ seed: 6 });
  const VOLUME = 2;
  const ref = nc.getToneRef(NT.DOPAMINE);

  // Downregulate hard with sustained high tone...
  for (let i = 0; i < 200; i++) {
    nc.set(NT.DOPAMINE, VOLUME, 1);
    nc.step(1);
  }
  const density = nc.getReceptorDensity()[NT.DOPAMINE];
  assert.ok(density < 1, `the receptor population must actually have moved: ${density}`);

  // ...then drop the chemistry back to rest. The receptors are STILL down at
  // this point, and a neutral tone must still read neutral: drift on a system
  // at rest cannot fabricate a signal.
  nc.set(NT.DOPAMINE, VOLUME, ref);
  assert.ok(Math.abs(nc.getTone(NT.DOPAMINE) - 0.5) < 1e-6, "neutral by construction");
  assert.ok(
    Math.abs(nc.getGainByName("dopamine") - 0.5) < 1e-6,
    `neutral tone stays neutral despite density ${density}: ${nc.getGainByName("dopamine")}`
  );

  // Unknown names resolve to neutral rather than NaN.
  assert.equal(nc.getGainByName("not-a-system"), 0.5, "unknown system reads neutral");
});

// ==================== E — REWARD SATURATION ====================

test("E: two rewards at saturation are distinguishable, not both railed at 1.0", () => {
  const nc = createNeurochemEngine({ seed: 3 });
  const VOLUME = 2;
  const ref = nc.getToneRef(NT.DOPAMINE);

  // Well past 2x ref — the point where the old linear read clipped to 1.0.
  nc.set(NT.DOPAMINE, VOLUME, ref * 3);
  const before = nc.getTone(NT.DOPAMINE);
  assert.ok(before > 0.85, `loaded system reads high: ${before}`);
  assert.ok(before < 1, `headroom left before the reward even lands: ${before}`);

  nc.releasePhasic(NT.DOPAMINE, 10);
  const after = nc.getTone(NT.DOPAMINE);
  assert.ok(after > before, `a reward still moves a saturated system: ${before} → ${after}`);
  assert.ok(after <= 1, "and never leaves the scale");
});

test("E: successive rewards keep registering — they habituate, they do not switch off", () => {
  const nc = createNeurochemEngine({ seed: 5 });
  const ref = nc.getToneRef(NT.DOPAMINE);
  const shifts = [];
  const volumes = [];
  for (let i = 0; i < 5; i++) {
    for (let k = 0; k < 5; k++) nc.step(1); // refill the soma, clear the cleft
    const before = nc.getTone(NT.DOPAMINE);
    nc.releasePhasic(NT.DOPAMINE, 10);
    shifts.push(Number((nc.getTone(NT.DOPAMINE) - before).toFixed(4)));
    volumes.push(nc.getVolume(NT.DOPAMINE));
  }

  // Rewards arriving faster than the system clears them — the loaded case,
  // and every one of these sits above the point the old linear read clipped.
  assert.ok(
    volumes.every((v) => v / ref > 2),
    `the system must stay above the old clip point: ${JSON.stringify(volumes)}`
  );

  // Under the old read each of these was railed at exactly 1.0, so every
  // shift after the first came out as 0 — the reward channel reporting no
  // effect at all while it was still being flooded.
  assert.ok(
    shifts.every((s) => s > 0),
    `no reward may read as no effect: ${JSON.stringify(shifts)}`
  );

  // Habituation rather than a switch: the first reward from rest lands far
  // harder than the ones that follow, and the later ones stay damped — but
  // they never stop registering.
  assert.ok(shifts[0] > shifts[1], `first reward lands hardest: ${JSON.stringify(shifts)}`);
  assert.ok(
    shifts[shifts.length - 1] < shifts[0] * 0.5,
    `later rewards stay damped rather than going dark: ${JSON.stringify(shifts)}`
  );
});

test("E: the autoreceptor brake damps a saturated system instead of closing on it", () => {
  const override = { [NT.DOPAMINE]: { autoreceptor_sensitivity: 0.6 } };

  const satur = createNeurochemEngine({ seed: 1, params: override });
  satur.set(NT.DOPAMINE, 2, 1); // as full as the compartment gets
  const raw = 1 - satur.getTone(NT.DOPAMINE) * 0.6 * 2;
  assert.ok(
    raw < 0,
    `the unfloored brake is negative here (${raw}) — release would be exactly 0`
  );

  const quiet = satur.getAllSynaptics().dopamine;
  satur.releasePhasic(NT.DOPAMINE, 10);
  const saturatedRelease = satur.getAllSynaptics().dopamine - quiet;
  assert.ok(saturatedRelease > 0, `a saturated system still releases: ${saturatedRelease}`);

  // ...but the brake is still doing its job: far less than at neutral tone.
  const calm = createNeurochemEngine({ seed: 1, params: override });
  calm.set(NT.DOPAMINE, 2, calm.getToneRef(NT.DOPAMINE));
  const calmBefore = calm.getAllSynaptics().dopamine;
  calm.releasePhasic(NT.DOPAMINE, 10);
  const calmRelease = calm.getAllSynaptics().dopamine - calmBefore;

  assert.ok(
    saturatedRelease < calmRelease,
    `braking must still discriminate: saturated=${saturatedRelease} neutral=${calmRelease}`
  );
});
