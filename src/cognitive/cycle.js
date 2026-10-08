/**
 * CognitiveCycle — ACT-R style production system gated by neurochem + energy.
 * 
 * 50ms central cycle. Productions fire serially, utility = P(success)·value - cost.
 * Neurochem provides gain modulation on production selection.
 * Energy (ATP) gates whether productions can fire at all.
 */

import { clamp01, mulberry32, softmax, weightedPick } from "../utils/math.js";
import { evaluate as evaluateEmotion } from "./emotion.js";

export function createCognitiveCycle(config = {}) {
  // Production memory (from MemoryStore procedural index)
  let productions = new Map();
  
  // Buffers (ACT-R style)
  const buffers = {
    goal: null,           // Current goal chunk
    retrieval: null,      // Retrieved declarative chunk
    imaginal: null,       // Mental simulation / planning
    perceptual: null,     // Perceptual input
    motor: null,          // Motor output (speech plan)
    interoceptive: null,  // Body state
    affective: null,      // Emotional state
    social: null,         // Addressee model
  };
  
  // Buffer states
  const bufferStates = {
    goal: { busy: false, content: null },
    retrieval: { busy: false, content: null, latency: 0 },
    imaginal: { busy: false, content: null },
    perceptual: { busy: false, content: null },
    motor: { busy: false, content: null },
    interoceptive: { busy: false, content: null },
    affective: { busy: false, content: null },
    social: { busy: false, content: null },
  };
  
  // Cycle timing
  const CYCLE_TIME = 0.05; // 50ms
  let cycleCount = 0;
  let currentTime = 0;
  
  // RNG for stochastic selection
  const rng = mulberry32(config.seed || Date.now());
  
  // Neurochem + energy refs (set externally)
  let neurochemRef = null;
  let energyRef = null;
  let memoryRef = null;
  
  // Conflict resolution trace
  let lastConflictSet = [];
  let lastSelectedProduction = null;

  // Previous-tick affect snapshot for temporal flavors (relief = cortisol
  // drop, infatuation/heartbreak = OXT slope). Null on the first cycle, so
  // no phantom deltas before any history exists.
  let prevAffect = null;
  
  function setRefs(refs) {
    neurochemRef = refs.neurochem;
    energyRef = refs.energy;
    memoryRef = refs.memory;
  }
  
  function loadProductions(procMap) {
    if (!procMap) {
      productions = new Map();
      return;
    }
    if (procMap instanceof Map) {
      productions = new Map(procMap);
      return;
    }
    if (Array.isArray(procMap)) {
      // [[id, prod], ...] or [{ id, ... }, ...]
      if (procMap.length && Array.isArray(procMap[0])) productions = new Map(procMap);
      else productions = new Map(procMap.map((p) => [p.id, p]));
      return;
    }
    productions = new Map(Object.entries(procMap));
  }
  
  function setBuffer(name, content) {
    if (buffers.hasOwnProperty(name)) {
      buffers[name] = content;
      bufferStates[name].content = content;
      bufferStates[name].busy = false;
    }
  }
  
  function getBuffer(name) {
    return buffers[name];
  }
  
  function clearBuffer(name) {
    if (buffers.hasOwnProperty(name)) {
      buffers[name] = null;
      bufferStates[name].content = null;
      bufferStates[name].busy = false;
    }
  }
  
  // Production matching
  function matchProductions() {
    const matched = [];
    
    for (const [id, prod] of productions) {
      if (!prod.condition) continue;
      
      let matches = true;
      const condition = prod.condition;
      
      // Check buffer conditions
      if (condition.goal && buffers.goal) {
        matches = matches && matchChunk(condition.goal, buffers.goal);
      }
      if (condition.retrieval && buffers.retrieval) {
        matches = matches && matchChunk(condition.retrieval, buffers.retrieval);
      }
      if (condition.imaginal && buffers.imaginal) {
        matches = matches && matchChunk(condition.imaginal, buffers.imaginal);
      }
      if (condition.perceptual && buffers.perceptual) {
        matches = matches && matchChunk(condition.perceptual, buffers.perceptual);
      }
      if (condition.interoceptive && buffers.interoceptive) {
        matches = matches && matchChunk(condition.interoceptive, buffers.interoceptive);
      }
      if (condition.affective && buffers.affective) {
        matches = matches && matchChunk(condition.affective, buffers.affective);
      }
      if (condition.social && buffers.social) {
        matches = matches && matchChunk(condition.social, buffers.social);
      }
      
      // Check neurochem gate. Keys are NT NAMES ("dopamine"), and the gate is
      // written on the 0-1 tone scale — getVolume("dopamine") returned NaN,
      // the `|| 0.5` swallowed it, and every gate silently evaluated the same
      // constant regardless of state.
      if (matches && prod.neurochemGate && neurochemRef) {
        for (const [nt, threshold] of Object.entries(prod.neurochemGate)) {
          const level = neurochemRef.getToneByName?.(nt) ?? 0.5;
          if (level < threshold) {
            matches = false;
            break;
          }
        }
      }
      
      // Check energy gate
      if (matches && energyRef) {
        const cost = prod.cost || 0.01;
        if (!energyRef.canAfford(cost)) {
          matches = false;
        }
      }
      
      if (matches) {
        matched.push({ id, production: prod });
      }
    }
    
    return matched;
  }
  
  function matchChunk(pattern, chunk) {
    if (!chunk) return false;
    if (typeof pattern === "function") return pattern(chunk);
    if (typeof pattern === "object") {
      for (const [key, value] of Object.entries(pattern)) {
        if (chunk[key] !== value) return false;
      }
      return true;
    }
    return true;
  }
  
  // Conflict resolution: softmax over utility * neurochem gain
  function resolveConflict(matched) {
    if (matched.length === 0) return null;
    if (matched.length === 1) return matched[0];
    
    lastConflictSet = matched.map(m => m.id);
    
    // Compute effective utilities
    const utilities = matched.map(m => {
      let utility = m.production.utility || 0.5;
      
      // Neurochem modulation — on the tone scale, where 0.5 is neutral and
      // `(level - 0.5)` is a signed deviation. Reading raw concentration here
      // made the term ~0 for every system (DA sits at 0.12), so
      // neurochemGain never moved a utility at all.
      //
      // getGain is the receptor-AWARE form of that same tone: a system that has
      // chronically downregulated reports a smaller deviation for identical
      // chemistry, so a habituated production is pushed less hard — and sleep
      // puts it back. Engines without it still fall back to the plain tone.
      if (m.production.neurochemGain && neurochemRef) {
        for (const [nt, gain] of Object.entries(m.production.neurochemGain)) {
          const level =
            neurochemRef.getGainByName?.(nt) ??
            neurochemRef.getToneByName?.(nt) ??
            0.5;
          utility *= (1 + gain * (level - 0.5));
        }
      }
      
      // Affective modulation
      if (buffers.affective && m.production.affectiveBias) {
        const valence = buffers.affective.valence || 0;
        utility *= (1 + m.production.affectiveBias * valence);
      }
      
      return clamp01(utility);
    });
    
    // Softmax selection (temperature = 0.3 for some exploration)
    const probs = softmax(utilities, 0.3);
    const selectedIdx = weightedPick(rng, matched, probs);
    
    lastSelectedProduction = selectedIdx.id;
    return selectedIdx;
  }
  
  // Fire production: execute actions, modify buffers
  function fireProduction(selected) {
    const prod = selected.production;
    const actions = prod.action || {};
    
    // Energy cost
    if (energyRef) {
      energyRef.spend("production_fire");
    }
    
    // Execute actions
    for (const [bufferName, action] of Object.entries(actions)) {
      if (bufferName === "retrieval" && action.request) {
        // Request declarative retrieval
        bufferStates.retrieval.busy = true;
        // In real impl: async, sets retrieval after latency
        // For now: synchronous via memory
        if (memoryRef && action.request.cue) {
          const results = memoryRef.retrieveEpisodic(action.request.cue, action.request.options);
          if (results.length > 0) {
            buffers.retrieval = results[0];
            bufferStates.retrieval.content = results[0];
            bufferStates.retrieval.latency = 0.05; // 50ms
          }
        }
      } else if (bufferName === "goal" && action.set) {
        buffers.goal = action.set;
        bufferStates.goal.content = action.set;
      } else if (bufferName === "imaginal" && action.set) {
        buffers.imaginal = action.set;
        bufferStates.imaginal.content = action.set;
      } else if (bufferName === "motor" && action.set) {
        buffers.motor = action.set;
        bufferStates.motor.content = action.set;
      } else if (bufferName === "clear") {
        for (const bn of action) clearBuffer(bn);
      }
    }
    
    // Record production firing for learning. The full spec rides along so
    // the memory index stays re-loadable: a record with only productionId
    // would come back with condition/action undefined, and matchProductions
    // skips condition-less entries — the outcome would be learned from but
    // never firable again.
    if (memoryRef) {
      memoryRef.addEvent({
        type: "procedural",
        productionId: selected.id,
        condition: prod.condition,
        action: prod.action,
        utility: prod.utility,
        value: prod.value,
        cost: prod.cost,
        neurochemGate: prod.neurochemGate,
        neurochemGain: prod.neurochemGain,
        success: true, // updated later via feedback
        timestamp: Date.now(),
      });
    }
    
    return prod;
  }
  
  // Single cognitive cycle (50ms)
  function cycle(context = {}) {
    currentTime += CYCLE_TIME;
    cycleCount++;
    
    // Update interoceptive/affective from neurochem
    if (neurochemRef) {
      updateInternalState();
    }
    
    // 1. Match productions
    const matched = matchProductions();
    
    // 2. Conflict resolution
    const selected = resolveConflict(matched);
    
    // 3. Fire selected production
    if (selected) {
      fireProduction(selected);
    }
    
    // 4. Buffer decay / maintenance
    maintainBuffers();
    
    return {
      cycle: cycleCount,
      time: currentTime,
      matched: matched.length,
      selected: selected?.id || null,
      conflictSet: lastConflictSet,
      buffers: getBufferSnapshot(),
    };
  }
  
  function updateInternalState() {
    // Tones, not raw concentrations — see NeurochemEngine.getTone
    const vols = neurochemRef.getAllTones?.() || neurochemRef.getAllVolumes?.() || {};

    // Interoceptive: energy, homeostatic state
    setBuffer("interoceptive", {
      energy: energyRef?.atp || 1,
      sleepPressure: energyRef?.sleepPressure || 0,
      cortisol: vols.norepinephrine || 0.5,
      arousal: vols.norepinephrine || 0.5,
      valence: computeValence(vols),
    });

    // Affective: emotional state from neurochem
    setBuffer("affective", {
      valence: computeValence(vols),
      arousal: clamp01((vols.norepinephrine || 0.5) * 0.6 + (vols.dopamine || 0.5) * 0.4),
      dominance: clamp01((vols.dopamine || 0.5) * 0.7 - (vols.serotonin || 0.5) * 0.3),
      primaryEmotion: inferPrimaryEmotion(vols),
    });
  }
  
  function computeValence(vols) {
    const da = vols.dopamine || 0.5;
    const oxt = vols.oxytocin || 0.5;
    const cortisol = vols.norepinephrine || 0.5; // proxy
    const ht = vols.serotonin || 0.5;
    return clamp01(0.5 + (da - 0.5) * 1.2 + (oxt - 0.5) * 0.6 - (cortisol - 0.5) - (0.5 - ht) * 0.5) * 2 - 1;
  }
  
  function inferPrimaryEmotion(vols) {
    // Delegates to the shared taxonomy: same formulas the phrase engine
    // reads for narrative copy, so buffers and speech can never disagree
    // about what she feels.
    const body = {
      cortisolLevel: energyRef?.cortisolLevel ?? 0.5,
      atp: energyRef?.atp ?? 1,
    };
    const out = evaluateEmotion({ tones: vols, body, prev: prevAffect });
    prevAffect = {
      cortisol: body.cortisolLevel,
      oxt: vols.oxytocin ?? vols.oxt ?? 0.5,
    };
    return out.primary;
  }
  
  function maintainBuffers() {
    // Retrieval buffer clears after use
    if (bufferStates.retrieval.content && !bufferStates.retrieval.busy) {
      // Keep for a few cycles
    }
    
    // Motor buffer clears after output
    if (buffers.motor && buffers.motor.executed) {
      clearBuffer("motor");
    }
  }
  
  function getBufferSnapshot() {
    const snap = {};
    for (const [name, state] of Object.entries(bufferStates)) {
      snap[name] = { busy: state.busy, hasContent: !!state.content };
      // State channels (interoceptive/affective/social) carry live values the
      // conversation bridge reads — don't collapse them to a boolean.
      if (state.content && typeof state.content === "object") {
        snap[name].content = state.content;
      }
    }
    return snap;
  }
  
  // High-level: run until motor output or max cycles
  function runToOutput(maxCycles = 20, context = {}) {
    for (let i = 0; i < maxCycles; i++) {
      const result = cycle(context);
      if (buffers.motor) {
        return { ...result, output: buffers.motor };
      }
    }
    return { cycle: cycleCount, time: currentTime, output: null };
  }
  
  // Learning: update production utility from feedback
  function updateUtility(productionId, success, reward = 1) {
    const prod = productions.get(productionId);
    if (!prod) return;
    
    prod.successCount = (prod.successCount || 0) + (success ? 1 : 0);
    prod.attemptCount = (prod.attemptCount || 0) + 1;
    prod.lastUsed = Date.now();
    
    const pSuccess = prod.successCount / prod.attemptCount;
    prod.utility = pSuccess * (prod.value || reward) - (prod.cost || 0);
    prod.utility = clamp01(prod.utility);
  }
  
  function toJSON() {
    return {
      cycleCount,
      currentTime,
      buffers: Object.fromEntries(
        Object.entries(buffers).map(([k, v]) => [k, v])
      ),
      productions: [...productions.entries()],
      lastSelectedProduction,
      lastConflictSet,
    };
  }
  
  function fromJSON(data) {
    if (!data) return;
    cycleCount = data.cycleCount || 0;
    currentTime = data.currentTime || 0;
    lastSelectedProduction = data.lastSelectedProduction;
    lastConflictSet = data.lastConflictSet || [];
    // A table saved by toJSON above. Old checkpoints predate the field —
    // leave the seeded table alone rather than wiping it.
    if (data.productions) productions = new Map(data.productions);
    // Buffers restored by reference
  }
  
  return {
    CYCLE_TIME,
    setRefs,
    loadProductions,
    setBuffer,
    getBuffer,
    clearBuffer,
    cycle,
    runToOutput,
    updateUtility,
    matchProductions,
    resolveConflict,
    getBufferSnapshot,
    toJSON,
    fromJSON,
    // Direct access
    get buffers() { return buffers; },
    get cycleCount() { return cycleCount; },
  };
}