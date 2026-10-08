/**
 * EnergySystem — ATP/ADP/AMP currency, glycogen, AMPK/mTOR, sleep pressure, circadian.
 * 
 * Every computation costs ATP. Sleep = mandatory ATP replenishment + receptor homeostasis.
 * Integrates with NeurochemEngine: cortisol, melatonin, orexin drive energy state.
 */

import { clamp01, relax, sigmoid } from "../utils/math.js";

export function createEnergySystem(config = {}) {
  // State
  let atp = config.atp ?? 1.0;        // 0-1, immediate energy currency
  let adp = config.adp ?? 0.2;
  let amp = config.amp ?? 0.05;
  let glycogen = config.glycogen ?? 0.8; // 0-1, stored energy
  let sleepPressure = config.sleepPressure ?? 0.2; // 0-1, adenosine proxy
  let circadianPhase = config.circadianPhase ?? 0.5; // 0-1, 0=midnight, 0.5=noon
  let ampk = config.ampk ?? 0.3;      // catabolic (energy depletion sensor)
  let mtor = config.mtor ?? 0.6;      // anabolic (growth/repair)
  
  // Ultradian cortisol rhythm (approximate)
  let cortisolPhase = 0;
  let cortisolLevel = 0.5;

  // Costs (ATP units per operation)
  const COSTS = {
    // Memory operations
    retrieval: 0.005,
    encoding: 0.01,
    consolidation: 0.02,
    // Cognitive operations
    production_fire: 0.008,
    working_memory_maintain: 0.002, // per item per second
    attention_shift: 0.003,
    // Neurochemical operations
    nt_synthesis: 0.001, // per NT per second (handled in NeurochemEngine)
    receptor_trafficking: 0.0005,
    // Language
    phrase_generation: 0.004,
    disfluency_injection: 0.001,
    // Baseline metabolism
    basal_metabolic: 0.0008, // per second
  };

  // Sleep architecture
  const SLEEP = {
    stages: ["wake", "N1", "N2", "N3", "REM"],
    stageDurations: [0, 10, 20, 40, 20], // minutes typical
    atpReplenishRate: {
      wake: 0.0001,
      N1: 0.0005,
      N2: 0.001,
      N3: 0.003,  // deep sleep = max ATP restoration
      REM: 0.0008,
    },
    glycogenReplenishRate: {
      wake: -0.00002, // slow depletion
      N1: 0.0001,
      N2: 0.0003,
      N3: 0.0008,
      REM: 0.0002,
    },
    sleepPressureDecay: {
      wake: 0.00005,  // accumulates
      N1: -0.0002,
      N2: -0.0005,
      N3: -0.0015,    // clears adenosine fastest
      REM: -0.0003,
    },
    receptorHomeostasisRate: {
      wake: 0,
      N1: 0.0001,
      N2: 0.0002,
      N3: 0.0005,     // receptor up/downregulation normalization
      REM: 0.0003,
    },
  };

  let currentSleepStage = "wake";
  let timeInStage = 0;
  let sleepDebt = 0;

  function updateCircadian(dt) {
    // 24-hour cycle, dt in seconds
    circadianPhase = (circadianPhase + dt / 86400) % 1;
    
    // Cortisol ultradian (~hourly pulses) + circadian (peak at wake)
    cortisolPhase = (cortisolPhase + dt / 3600) % 1;
    const circadianCortisol = 0.3 + 0.4 * Math.max(0, Math.sin((circadianPhase - 0.25) * 2 * Math.PI));
    const ultradianCortisol = 0.1 * Math.sin(cortisolPhase * 2 * Math.PI);
    cortisolLevel = clamp01(circadianCortisol + ultradianCortisol);
  }

  function updateAmpkMtor() {
    // AMPK activated by high AMP/ATP ratio
    const energyRatio = atp / (adp + amp + 0.01);
    const targetAmpk = sigmoid(1 / energyRatio - 2, 5);
    ampk = relax(ampk, targetAmpk, 0.1);
    
    // mTOR inhibited by AMPK, activated by energy surplus
    const targetMtor = clamp01(1 - ampk * 0.7 + atp * 0.3);
    mtor = relax(mtor, targetMtor, 0.05);
  }

  function consumeATP(amount) {
    const actual = Math.min(atp, amount);
    atp -= actual;
    adp = clamp01(adp + actual * 0.8);
    amp = clamp01(amp + actual * 0.2);
    // Keep the ADP:AMP split proportional without ever touching ATP. This
    // used to renormalize all three by a pool the cost had just shrunk, and
    // because the split was weighted 0.9 / 0.1, spending could hand back
    // MORE ATP than it took out — a dislike literally raised the energy it
    // was supposed to cost.
    const rest = adp + amp;
    if (rest > 1) {
      adp /= rest;
      amp /= rest;
    }
    return actual;
  }

  function produceATP(amount) {
    atp = clamp01(atp + amount);
    // Shift from ADP/AMP
    adp = clamp01(adp - amount * 0.5);
    amp = clamp01(amp - amount * 0.5);
  }

  function canAfford(cost) {
    return atp >= cost;
  }

  function spend(costName, multiplier = 1) {
    const cost = (COSTS[costName] || 0) * multiplier;
    return consumeATP(cost);
  }

  function spendMultiple(costs) {
    let total = 0;
    for (const [name, mult] of Object.entries(costs)) {
      total += (COSTS[name] || 0) * (mult || 1);
    }
    return consumeATP(total);
  }

  function step(dt, context = {}) {
    const {
      neurochem = {},
      wakefulness = 1,
      cognitiveLoad = 0, // 0-1
      isSleeping = false,
    } = context;

    updateCircadian(dt);
    updateAmpkMtor();

    /**
     * Arousal cost — running a hot monoamine system costs ATP. The caller
     * passes TONES (0-1 effect scale, neutral = 0.5); raw concentrations
     * would make OXT at 0.02 read as "free" and DA at 0.12 as "cheap",
     * which is the scale mismatch that used to make arousal free. Measured
     * above the neutral point, so a flat system adds nothing and only
     * genuine arousal is billed — and only while awake.
     */
    const tone = (name) => (Number.isFinite(neurochem[name]) ? neurochem[name] : 0.5);
    const arousal =
      (tone("dopamine") + tone("norepinephrine") + tone("orexin")) / 3;
    const arousalCost = Math.max(0, arousal - 0.5) * 2 * wakefulness; // 0..1

    // Basal metabolic cost
    consumeATP(COSTS.basal_metabolic * dt * (1 + cognitiveLoad * 0.5 + arousalCost));

    // Glycogen ↔ ATP buffering
    if (atp < 0.4 && glycogen > 0.1) {
      const transfer = Math.min(0.01 * dt, glycogen, 0.4 - atp);
      glycogen -= transfer;
      produceATP(transfer * 2); // glycogen → 2 ATP (simplified)
    } else if (atp > 0.8 && glycogen < 1.0) {
      const transfer = Math.min(0.005 * dt, 1.0 - glycogen);
      glycogen += transfer;
      consumeATP(transfer); // ATP → glycogen
    }

    // Sleep pressure (adenosine accumulation)
    if (!isSleeping) {
      sleepPressure = clamp01(sleepPressure + 0.00003 * dt * (1 + cognitiveLoad));
      sleepDebt += dt;
    }

    // Sleep stage progression
    if (isSleeping) {
      timeInStage += dt / 60; // minutes
      const stageIdx = SLEEP.stages.indexOf(currentSleepStage);
      const stageDuration = SLEEP.stageDurations[stageIdx];
      
      if (timeInStage >= stageDuration && stageIdx < SLEEP.stages.length - 1) {
        currentSleepStage = SLEEP.stages[stageIdx + 1];
        timeInStage = 0;
      }

      // ATP replenishment during sleep
      const atpRate = SLEEP.atpReplenishRate[currentSleepStage] || 0;
      const glycogenRate = SLEEP.glycogenReplenishRate[currentSleepStage] || 0;
      const pressureDecay = SLEEP.sleepPressureDecay[currentSleepStage] || 0;
      const receptorRate = SLEEP.receptorHomeostasisRate[currentSleepStage] || 0;

      produceATP(atpRate * dt);
      glycogen = clamp01(glycogen + glycogenRate * dt);
      sleepPressure = clamp01(sleepPressure + pressureDecay * dt);
      sleepDebt = Math.max(0, sleepDebt - dt * 2); // sleep pays 2x debt

      return { receptorHomeostasis: receptorRate };
    } else {
      currentSleepStage = "wake";
      timeInStage = 0;
      return { receptorHomeostasis: 0 };
    }
  }

  function forceSleep() {
    if (currentSleepStage === "wake") {
      currentSleepStage = "N1";
      timeInStage = 0;
    }
  }

  function forceWake() {
    currentSleepStage = "wake";
    timeInStage = 0;
  }

  function shouldSleep() {
    return sleepPressure > 0.7 || circadianPhase > 0.75 && circadianPhase < 0.95;
  }

  function getState() {
    return {
      atp: clamp01(atp),
      adp: clamp01(adp),
      amp: clamp01(amp),
      glycogen: clamp01(glycogen),
      sleepPressure: clamp01(sleepPressure),
      circadianPhase,
      cortisolLevel,
      ampk,
      mtor,
      sleepStage: currentSleepStage,
      sleepDebt,
      energyRatio: atp / (adp + amp + 0.01),
    };
  }

  function toJSON() {
    return {
      atp, adp, amp, glycogen, sleepPressure, circadianPhase,
      cortisolPhase, cortisolLevel, ampk, mtor,
      currentSleepStage, timeInStage, sleepDebt,
    };
  }

  function fromJSON(data) {
    if (!data) return;
    atp = data.atp ?? atp;
    adp = data.adp ?? adp;
    amp = data.amp ?? amp;
    glycogen = data.glycogen ?? glycogen;
    sleepPressure = data.sleepPressure ?? sleepPressure;
    circadianPhase = data.circadianPhase ?? circadianPhase;
    cortisolPhase = data.cortisolPhase ?? cortisolPhase;
    cortisolLevel = data.cortisolLevel ?? cortisolLevel;
    ampk = data.ampk ?? ampk;
    mtor = data.mtor ?? mtor;
    currentSleepStage = data.currentSleepStage ?? currentSleepStage;
    timeInStage = data.timeInStage ?? timeInStage;
    sleepDebt = data.sleepDebt ?? sleepDebt;
  }

  return {
    COSTS,
    SLEEP,
    step,
    consumeATP,
    produceATP,
    canAfford,
    spend,
    spendMultiple,
    forceSleep,
    forceWake,
    shouldSleep,
    getState,
    toJSON,
    fromJSON,
    // Direct accessors
    get atp() { return atp; },
    get sleepPressure() { return sleepPressure; },
    get circadianPhase() { return circadianPhase; },
    get cortisolLevel() { return cortisolLevel; },
    get sleepStage() { return currentSleepStage; },
  };
}