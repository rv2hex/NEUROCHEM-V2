/**
 * Daemon — the main process. Continuous multi-timescale simulation.
 * Conversation is just one input modality; this loop runs regardless.
 *
 * Timescales:
 *   1 Hz      neurochem volume transmission
 *   0.1 Hz    energy / cognitive cycle checks
 *   event     appraisal (on stimulus)
 *   0.01 Hz   hormonal/circadian (energy system)
 *   daily     consolidation (sleep-gated)
 *
 * States: wake | idle | sleeping
 */

import { createNeurochemEngine } from "../neurochem/engine.js";
import { createEnergySystem } from "../energy/system.js";
import { createMemoryStore } from "../memory/store.js";
import { createCognitiveCycle } from "../cognitive/cycle.js";
import { createPhraseEngine } from "../phrase/engine.js";
import { matchPreferences } from "../personality/soul.js";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TICK = 1000; // ms — 1 Hz master loop
const COGNITIVE_PERIOD = 10; // run cognitive cycle every 10 ticks (0.1 Hz)
const HORMONAL_PERIOD = 100; // energy step every 100 ticks (0.01 Hz)
const CONSOLIDATE_PERIOD = 6000; // every 100 min simulated

/**
 * Seeded production table (A1). Two neutral, empty-condition productions so
 * they match with empty buffers: the cognitive loop actually fires in the
 * live daemon instead of idling on an empty Map. `attend` carries a dopamine
 * gain term so the receptor-aware W6 branch is reachable outside tests;
 * `idle-rest` is the gain-free baseline softmax explores against. Actions
 * stay empty on purpose — no buffer writes, so the speech path is untouched.
 */
const DEFAULT_PRODUCTIONS = new Map([
  ["attend", { id: "attend", condition: {}, action: {}, utility: 0.5, value: 1, cost: 0.008, neurochemGain: { dopamine: 0.5 } }],
  ["idle-rest", { id: "idle-rest", condition: {}, action: {}, utility: 0.5, value: 1, cost: 0.008 }],
]);

/** Accept a Map, an entries array, a prod-object array, or a plain object. */
function normalizeProductions(src) {
  if (src instanceof Map) return new Map(src);
  if (Array.isArray(src)) {
    if (src.length && Array.isArray(src[0])) return new Map(src);
    return new Map(src.map((p) => [p.id, p]));
  }
  if (src && typeof src === "object") return new Map(Object.entries(src));
  return new Map();
}

/** Load config/slang.json (dialect packs) — the accent lexicon source. */
function loadDialectPack(root) {
  try {
    const path = join(root, "config", "slang.json");
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  } catch { /* fall through */ }
  return null;
}

export function createDaemon(config = {}) {
  const root = config.root || join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  // ---- Core subsystems ----
  const neurochem = createNeurochemEngine({ seed: config.seed });
  const energy = createEnergySystem({});
  const memory = createMemoryStore({ seed: config.seed });
  const cognitive = createCognitiveCycle({ seed: config.seed });
  const phrase = createPhraseEngine({
    seed: config.seed,
    root,
    soulPath: config.soulPath || null,
    dialectPack: config.dialectPack || loadDialectPack(root),
    era: config.era,
  });

  cognitive.setRefs({ neurochem, energy, memory });
  phrase.setRefs({ neurochem, energy, memory });

  // Seed the production table. Explicitly-provided tables (even empty ones)
  // are respected as-is so tests can still construct the dead-path daemon;
  // only an absent/null config falls back to the live defaults.
  cognitive.loadProductions(
    config.productions === undefined || config.productions === null
      ? DEFAULT_PRODUCTIONS
      : normalizeProductions(config.productions)
  );

  // ---- Simulation state ----
  let running = false;
  let tickCount = 0;
  let intervalId = null;
  let mode = "wake"; // wake | idle | sleeping
  let lastInputAt = Date.now();
  let queuedProactive = []; // daemon-generated utterance candidates
  let monologue = [];       // internal intrusive thoughts
  const listeners = [];

  // Simulated clock (acceleration: 1 real second = 1 simulated second by default)
  let simTime = Date.now();
  const timeScale = config.timeScale || 1;

  // ---- Input events (from conversation) ----
  function onStimulus(stimulus) {
    // Appraisal (Layer-4-equivalent): immediate neurochem response
    lastInputAt = Date.now();

    const {
      type = "neutral",      // threat | reward | social | neutral | query
      intensity = 0.5,
      valence = 0,
      text = "",
      personId = null,
    } = stimulus;

    switch (type) {
      case "threat":
        neurochem.schedulePhasic(neurochem.NT.NOREPINEPHRINE, intensity * 0.8, 0);
        neurochem.schedulePhasic(neurochem.NT.SEROTONIN, intensity * 0.3, 2);
        break;
      case "reward":
        neurochem.schedulePhasic(neurochem.NT.DOPAMINE, intensity * 0.9, 0);
        break;
      case "social":
        neurochem.schedulePhasic(neurochem.NT.OXYTOCIN, intensity * 0.7, 0);
        if (valence > 0) neurochem.schedulePhasic(neurochem.NT.DOPAMINE, intensity * 0.4, 1);
        break;
      case "punishment":
        neurochem.schedulePhasic(neurochem.NT.SEROTONIN, intensity * 0.6, 0);
        break;
      default:
        neurochem.schedulePhasic(neurochem.NT.NOREPINEPHRINE, intensity * 0.3, 0);
    }

    // Memory: encode the episode
    if (text) {
      memory.addEvent({
        type: "episodic",
        content: text,
        valence,
        arousal: intensity,
        importance: 4 + Math.round(intensity * 4),
        person: personId,
        tags: [type],
      });
      if (personId) {
        memory.addEvent({
          type: "social",
          personId,
          valence,
          vocab: extractWords(text),
        });
      }
    }

    // SOUL preferences → metabolism. Two souls running identical logic end up
    // at different baselines because the topics they care about are not
    // neutral input: a like refuels them, a dislike costs them.
    const pref = matchPreferences(phrase.voice, text);
    if (pref) {
      if (pref.disliked) {
        energy.consumeATP(0.04);
        neurochem.schedulePhasic(neurochem.NT.NOREPINEPHRINE, 0.5, 0);
      } else if (pref.liked) {
        energy.produceATP(0.06);
        neurochem.schedulePhasic(neurochem.NT.DOPAMINE, 0.6, 0);
      }
    }

    // A high-intensity threat wakes the sleeper; anything else registers
    // without waking. The threat check must come first — an early return for
    // sleeping would make it unreachable.
    if (type === "threat" && intensity > 0.7) {
      forceWake();
    }
    if (mode === "sleeping") return; // stimuli can still register but no wake-up
  }

  function extractWords(text) {
    return String(text).toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 3);
  }

  // ---- Tick ----
  function tick() {
    tickCount++;
    simTime += TICK * timeScale;
    const now = Date.now();

    // Determine mode
    if (mode !== "sleeping") {
      const idleFor = (now - lastInputAt) / 1000;
      if (energy.shouldSleep() && idleFor > 60) {
        enterSleep();
      } else if (idleFor > 30) {
        mode = "idle";
      } else {
        mode = "wake";
      }
    }

    const isSleeping = mode === "sleeping";

    // 1 Hz: neurochem
    const stepContext = {
      cortisol: energy.cortisolLevel,
      energy: energy.atp,
      circadian_phase: energy.circadianPhase,
      // Sustained load → tonic LC (NE) drive: a LEVEL, not a burst. Mapped
      // from cortisol's excess over its daytime midpoint plus a small waking
      // floor — the unclamped per-tick burst this replaced railed NE tone at
      // 1.000, leaving it nowhere to go when something real happened.
      stress: isSleeping
        ? 0
        : Math.min(1, 0.15 + Math.max(0, ((energy.cortisolLevel ?? 0.5) - 0.45) / 0.35)),
      wakefulness: isSleeping ? 0.1 : 1,
    };
    neurochem.step(1 * timeScale, stepContext);

    // 0.1 Hz: cognitive cycle (only when awake/idle). No early return here:
    // HORMONAL_PERIOD is a multiple of COGNITIVE_PERIOD, so every hormonal
    // tick is also a cognitive tick — returning first would starve the
    // 0.01 Hz path (no basal metabolism, no circadian, no sleep pressure)
    // for as long as the daemon stays awake.
    let cognitiveResult = null;
    if (!isSleeping && tickCount % COGNITIVE_PERIOD === 0) {
      cognitiveResult = cognitive.cycle({ mode });
      // Idle → intrusive thought generation
      if (mode === "idle" && (tickCount / COGNITIVE_PERIOD) % 6 === 0) {
        generateIntrusiveThought();
      }
    }

    // 0.01 Hz: energy/hormonal
    if (tickCount % HORMONAL_PERIOD === 0) {
      const sleepResult = energy.step(HORMONAL_PERIOD * timeScale, {
        // TONES, not concentrations: arousal is billed on the 0-1 effect
        // scale so a hot DA system costs more than a resting one.
        neurochem: neurochem.getAllTones(),
        wakefulness: isSleeping ? 0.1 : 1,
        cognitiveLoad: mode === "wake" ? 0.4 : 0.1,
        isSleeping,
      });
      // Sleep-time receptor homeostasis — delegated to the engine, which owns
      // receptorDensity. The version that used to live here walked a COPY of
      // the snapshot and wrote to it, so it never reached the engine at all.
      if (isSleeping && sleepResult.receptorHomeostasis > 0) {
        neurochem.applyReceptorHomeostasis(sleepResult.receptorHomeostasis);
      }
      // Daily consolidation. simTime is ALREADY milliseconds (TICK is 1000ms)
      // and store.consolidate() gates on milliseconds too — converting it
      // would push every call an hour into the future and never consolidate.
      if (tickCount % CONSOLIDATE_PERIOD === 0 && isSleeping) {
        memory.consolidate(simTime);
      }
    }

    // Spontaneity check: high DA + idle + long enough → queue proactive thought
    if (mode === "idle" && tickCount % (COGNITIVE_PERIOD * 30) === 0) {
      // TONE, not concentration. DA sits at ~0.12 at rest, so the `> 0.15`
      // gate this replaced was closed at baseline and only opened after a
      // burst had already railed it — spontaneity was effectively random.
      const daTone = neurochem.getTone(neurochem.NT.DOPAMINE);
      if (daTone > 0.6 && queuedProactive.length < 3) {
        const candidates = phrase.generateCandidates(
          { speechAct: "assert", content: { text: monologue[monologue.length - 1] || "" } },
          { seed: tickCount }
        );
        queuedProactive.push({
          candidates,
          at: simTime,
          trigger: "idle-spontaneity",
        });
      }
    }

    return cognitiveResult;
  }

  function generateIntrusiveThought() {
    // Sample from: unfinished goals, high-valence episodes, social wondering, somatic
    const sources = [];

    const strongEpisodes = memory.retrieveEpisodic({}, { limit: 3, minActivation: 0.4 });
    for (const ep of strongEpisodes) {
      if (Math.abs(ep.valence) > 0.4) {
        sources.push({ kind: "memory", text: `That thing with ${ep.content}` });
      }
    }

    const people = memory.retrieveSocial();
    if (people.length > 0) {
      const leastRecent = people[people.length - 1];
      const daysSince = (simTime - leastRecent.lastInteraction) / 86400000;
      if (daysSince > 2) {
        sources.push({ kind: "social", text: `Wonder how ${leastRecent.personId} is doing.` });
      }
    }

    const e = energy.getState();
    if (e.sleepPressure > 0.6) {
      sources.push({ kind: "somatic", text: "So tired. Should sleep." });
    } else if (e.atp < 0.4) {
      sources.push({ kind: "somatic", text: "Need food. Running low." });
    }

    if (sources.length > 0) {
      const thought = sources[Math.floor(Math.random() * sources.length)];
      monologue.push(thought.text);
      if (monologue.length > 50) monologue.shift();
      // High importance intrusive thoughts surface as proactive candidates
      if (thought.kind === "social" || thought.kind === "memory") {
        emitProactive(thought.text, "intrusive");
      }
    }
  }

  function emitProactive(text, trigger) {
    const candidates = phrase.generateCandidates(
      { speechAct: "assert", content: { text } },
      { seed: tickCount }
    );
    queuedProactive.push({ candidates, trigger, at: simTime });
    for (const fn of listeners) {
      fn({ type: "proactive", candidates, trigger });
    }
  }

  // ---- Control ----
  function start() {
    if (running) return;
    running = true;
    intervalId = setInterval(tick, TICK / timeScale);
  }

  function stop() {
    running = false;
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
  }

  function forceSleep() {
    enterSleep();
  }

  function enterSleep() {
    mode = "sleeping";
    energy.forceSleep();
    // Nightly: positive memory replay affects next-day mood (simplified)
    const strongPos = memory.retrieveEpisodic({}, { limit: 5, valence: 1, minActivation: 0.3 });
    if (strongPos.length > 0) {
      neurochem.schedulePhasic(neurochem.NT.DOPAMINE, 0.3, 30);
    }
  }

  function forceWake() {
    mode = "wake";
    energy.forceWake();
    lastInputAt = Date.now();
    // Cortisol awakening response
    neurochem.schedulePhasic(neurochem.NT.NOREPINEPHRINE, 0.5, 0);
  }

  function drainProactive() {
    const out = queuedProactive;
    queuedProactive = [];
    return out;
  }

  function onProactive(fn) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /** Run N ticks synchronously (for tests / accelerated simulation). */
  function tickFor(n) {
    let last = null;
    for (let i = 0; i < n; i++) last = tick();
    return last;
  }

  /** Full snapshot for conversation / checkpoint. */
  function snapshot() {
    const e = energy.getState();
    return {
      mode,
      tick: tickCount,
      simTime,
      energy: e,
      // Volumes are concentrations; tones are the 0-1 effect scale everything
      // downstream (tendencies, narrative, spontaneity) actually reads.
      neurochem: neurochem.getAllVolumes(),
      tones: neurochem.getAllTones(),
      actionTendencies: phrase.actionTendencies(),
      stateNarrative: phrase.stateNarrative(),
      // Short aliases (same objects — convenient for prompts/tests)
      tendencies: phrase.actionTendencies(),
      narrative: phrase.stateNarrative(),
      accent: phrase.accent,
      monologue: monologue.slice(-10),
      memory: memory.getStats(),
      queuedProactive: queuedProactive.length,
    };
  }

  function toJSON() {
    return {
      running: false, // never auto-start from checkpoint
      tickCount,
      mode,
      simTime,
      lastInputAt,
      neurochem: neurochem.toJSON(),
      energy: energy.toJSON(),
      memory: memory.toJSON(),
      cognitive: cognitive.toJSON(),
      phrase: phrase.toJSON(),
      monologue: [...monologue],
    };
  }

  function fromJSON(data) {
    if (!data) return;
    tickCount = data.tickCount || 0;
    mode = data.mode || "wake";
    simTime = data.simTime || Date.now();
    lastInputAt = data.lastInputAt || Date.now();
    neurochem.fromJSON(data.neurochem);
    energy.fromJSON(data.energy);
    memory.fromJSON(data.memory);
    cognitive.fromJSON(data.cognitive);
    phrase.fromJSON(data.phrase);
    monologue = data.monologue || [];
  }

  // ---- Checkpoint persistence (continuous existence across restarts) ----
  function saveCheckpoint(filePath) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(toJSON()), "utf8");
    return filePath;
  }

  function loadCheckpoint(filePath) {
    if (!existsSync(filePath)) return false;
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    fromJSON(data);
    return true;
  }

  return {
    // Subsystems
    neurochem, energy, memory, cognitive, phrase,
    // Lifecycle
    start, stop, tick, tickFor,
    // Mode
    forceSleep, forceWake, enterSleep,
    // I/O
    onStimulus, onProactive, drainProactive,
    // State
    snapshot, toJSON, fromJSON,
    // Persistence
    saveCheckpoint, loadCheckpoint,
    // Helpers
    get running() { return running; },
    get mode() { return mode; },
    get tickCount() { return tickCount; },
    get simTime() { return simTime; },
    get queuedProactive() { return queuedProactive; },
  };
}

// ---- Direct run: `npm run daemon` ----
const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const checkpoint = process.env.NC_CHECKPOINT || null;
  const daemon = createDaemon({ root: process.cwd() });
  if (checkpoint) {
    const ok = daemon.loadCheckpoint(checkpoint);
    console.log(ok ? `resumed from ${checkpoint}` : `no checkpoint at ${checkpoint} — starting fresh`);
  }
  daemon.start();
  console.log("daemon running — 1 Hz tick, Ctrl-C to stop");

  const shutdown = () => {
    daemon.stop();
    if (checkpoint) {
      daemon.saveCheckpoint(checkpoint);
      console.log(`\ncheckpoint saved → ${checkpoint}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}