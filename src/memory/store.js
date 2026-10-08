/**
 * MemoryStore — Unified event log with 4 access modes (indices).
 * 
 * Single source of truth: append-only event log.
 * Indices built on demand / maintained incrementally:
 *   - Episodic: timestamped, valence-tagged, importance-weighted
 *   - Semantic: concept graph extracted from episodic (consolidation during sleep)
 *   - Procedural: production rules with utility = f(success, neurochem gate)
 *   - Social: per-person models (attachment, trust, shared history)
 */

import { clamp01, mulberry32, sigmoid } from "../utils/math.js";

export function createMemoryStore(config = {}) {
  // Single append-only event log
  const eventLog = [];
  let eventSeq = 0;

  // Indices (derived views)
  const episodicIndex = new Map();      // eventId -> episodic metadata
  const semanticGraph = new Map();      // conceptId -> { label, properties, links, strength }
  const proceduralIndex = new Map();    // productionId -> { condition, action, utility, successCount, ... }
  const socialIndex = new Map();        // personId -> { attachment, trust, history[], insideVocab, ... }

  // Consolidation state
  let lastConsolidation = 0;
  // Milliseconds — the one unit all callers share: Date.now(), the daemon's
  // simTime (TICK is 1000ms), and the /3600000 hour math inside consolidate().
  // `??` rather than `||`, so an explicit 0 (consolidate on every call) is
  // honoured instead of being silently replaced by an hour.
  const consolidationInterval = config.consolidationInterval ?? 3_600_000; // 1 hour simulated

  // RNG for stochastic retrieval
  const rng = mulberry32(config.seed || Date.now());

  // Episode decay parameters
  const DECAY = {
    episodic: 0.995,      // per hour (exponential)
    semantic: 0.9999,     // very slow
    procedural: 0.999,    // slow utility decay
    social: 0.998,        // relationship decay
  };

  function addEvent(event) {
    const id = `evt_${++eventSeq}_${Date.now()}`;
    const fullEvent = {
      id,
      timestamp: Date.now(),
      seq: eventSeq,
      ...event,
    };
    eventLog.push(fullEvent);
    
    // Auto-index based on event type
    if (event.type === "episodic") indexEpisodic(fullEvent);
    else if (event.type === "semantic") indexSemantic(fullEvent);
    else if (event.type === "procedural") indexProcedural(fullEvent);
    else if (event.type === "social") indexSocial(fullEvent);
    
    return id;
  }

  function indexEpisodic(event) {
    episodicIndex.set(event.id, {
      id: event.id,
      timestamp: event.timestamp,
      content: event.content,
      valence: event.valence ?? 0,
      arousal: event.arousal ?? 0.5,
      importance: event.importance ?? 3,
      tags: event.tags || [],
      person: event.person || null,
      context: event.context || {},
      activation: computeInitialActivation(event),
    });
  }

  function indexSemantic(event) {
    // Extract concepts from event content, plus any explicitly declared concept
    const concepts = extractConcepts(event.content);
    if (event.concept && event.concept.id && !concepts.some((c) => c.id === event.concept.id)) {
      concepts.push({
        id: event.concept.id,
        label: event.concept.label || event.concept.id,
        properties: event.concept.properties || { type: "entity" },
      });
    }
    for (const concept of concepts) {
      if (!semanticGraph.has(concept.id)) {
        semanticGraph.set(concept.id, {
          id: concept.id,
          label: concept.label,
          properties: concept.properties || {},
          links: new Map(), // conceptId -> strength
          strength: 0.5,
          sourceEvents: [],
        });
      }
      const node = semanticGraph.get(concept.id);
      node.sourceEvents.push(event.id);
      node.strength = clamp01(node.strength + 0.05);
      
      // Build links between co-occurring concepts
      for (const other of concepts) {
        if (other.id !== concept.id) {
          const current = node.links.get(other.id) || 0;
          node.links.set(other.id, clamp01(current + 0.1));
        }
      }
    }
  }

  function indexProcedural(event) {
    if (!event.productionId) return;
    const existing = proceduralIndex.get(event.productionId);
    if (existing) {
      existing.successCount = (existing.successCount || 0) + (event.success ? 1 : 0);
      existing.attemptCount = (existing.attemptCount || 0) + 1;
      existing.lastUsed = event.timestamp;
      // Keep the stored spec re-loadable: refresh whichever fields the event
      // carries so a later retrieve → load round-trip still has a condition.
      if (event.condition !== undefined) existing.condition = event.condition;
      if (event.action !== undefined) existing.action = event.action;
      if (event.neurochemGate !== undefined) existing.neurochemGate = event.neurochemGate;
      if (event.neurochemGain !== undefined) existing.neurochemGain = event.neurochemGain;
      // Utility = P(success) * value - cost
      const pSuccess = existing.successCount / existing.attemptCount;
      existing.utility = pSuccess * (existing.value || 1) - (existing.cost || 0);
    } else {
      // Same formula as the update branch above — the first observation used
      // to leave utility pinned at the 0.5 default while successCount said 1/1,
      // so a production's initial outcome was recorded but never learned from.
      const wins = event.success ? 1 : 0;
      const learned = wins * (event.value || 1) - (event.cost || 0);
      proceduralIndex.set(event.productionId, {
        id: event.productionId,
        condition: event.condition,
        action: event.action,
        utility: event.utility ?? (event.success === undefined ? 0.5 : learned),
        value: event.value || 1,
        cost: event.cost || 0,
        successCount: wins,
        attemptCount: 1,
        lastUsed: event.timestamp,
        neurochemGate: event.neurochemGate || {},
        neurochemGain: event.neurochemGain || {},
      });
    }
  }

  function indexSocial(event) {
    const personId = event.personId;
    if (!personId) return;
    
    let model = socialIndex.get(personId);
    if (!model) {
      model = {
        personId,
        attachment: { anxiety: 0.3, avoidance: 0.2 },
        trust: 0.5,
        affinity: 0,
        sharedHistory: [],
        insideVocab: new Set(),
        conflictCount: 0,
        positiveCount: 0,
        lastInteraction: event.timestamp,
        firstInteraction: event.timestamp,
      };
      socialIndex.set(personId, model);
    }
    
    model.lastInteraction = event.timestamp;
    model.sharedHistory.push(event.id);
    
    if (event.valence > 0.3) model.positiveCount++;
    if (event.valence < -0.3) model.conflictCount++;
    
    // Update trust (simple model)
    const total = model.positiveCount + model.conflictCount + 1;
    model.trust = clamp01(model.positiveCount / total);
    
    // Extract inside vocabulary
    if (event.vocab) {
      for (const w of event.vocab) model.insideVocab.add(w);
    }

    // Identity: a claimed name sticks to the per-person model so a later
    // "do you remember me?" has something true to reach for. Plain string,
    // so it survives the toJSON/fromJSON round-trip untouched.
    if (typeof event.name === "string" && event.name.trim()) {
      model.name = event.name.trim().slice(0, 24);
    }
  }

  function computeInitialActivation(event) {
    // Base activation from importance and recency
    const importance = event.importance || 3;
    const valenceBoost = Math.abs(event.valence || 0) * 2;
    return clamp01((importance / 10) * 0.7 + valenceBoost * 0.3);
  }

  function extractConcepts(content) {
    // Simple concept extraction from content
    // In production, this would be more sophisticated
    const concepts = [];
    if (typeof content === "string") {
      // Extract capitalized words as potential concepts
      const words = content.match(/\b[A-Z][a-z]+\b/g) || [];
      for (const word of words) {
        concepts.push({
          id: `concept_${word.toLowerCase()}`,
          label: word,
          properties: { type: "entity" },
        });
      }
    } else if (content && typeof content === "object") {
      if (content.concept) {
        concepts.push({
          id: content.concept.id || `concept_${Date.now()}`,
          label: content.concept.label || "unknown",
          properties: content.concept.properties || {},
        });
      }
    }
    return concepts;
  }

  // ==================== RETRIEVAL ====================

  function retrieveEpisodic(cue = {}, options = {}) {
    const {
      limit = 10,
      minActivation = -10,
      valence = null,      // filter by valence sign
      person = null,       // filter by person
      tags = null,         // filter by tags
      recencyWeight = 0.5,
      importanceWeight = 0.3,
      valenceWeight = 0.2,
    } = options;

    let results = [];
    
    for (const [id, ep] of episodicIndex) {
      if (ep.activation < minActivation) continue;
      if (valence !== null && Math.sign(ep.valence) !== Math.sign(valence)) continue;
      if (person && ep.person !== person) continue;
      if (tags && tags.length && !tags.some(t => ep.tags.includes(t))) continue;

      // Cue matching
      let cueMatch = 0;
      if (cue.content && ep.content) {
        const cueWords = String(cue.content).toLowerCase().split(/\W+/);
        const epWords = String(ep.content).toLowerCase().split(/\W+/);
        cueMatch = cueWords.filter(w => w.length > 2 && epWords.includes(w)).length;
      }

      // Activation = base + cue match + recency + importance + valence
      const hoursAgo = (Date.now() - ep.timestamp) / 3600000;
      const recency = Math.exp(-hoursAgo * 0.1);
      const importance = ep.importance / 10;
      const valenceStrength = Math.abs(ep.valence);
      
      const activation = ep.activation 
        + cueMatch * 2 
        + recency * recencyWeight 
        + importance * importanceWeight 
        + valenceStrength * valenceWeight
        + rng() * 0.5; // noise for variability

      results.push({ ...ep, activation, cueMatch });
    }

    results.sort((a, b) => b.activation - a.activation);
    return results.slice(0, limit);
  }

  /** Accept "concept_arasaka", "arasaka", or "Arasaka" as a seed. */
  function resolveConceptId(seed) {
    if (!seed) return null;
    if (semanticGraph.has(seed)) return seed;
    const prefixed = `concept_${String(seed).toLowerCase()}`;
    if (semanticGraph.has(prefixed)) return prefixed;
    for (const [id, node] of semanticGraph) {
      if (String(node.label).toLowerCase() === String(seed).toLowerCase()) return id;
    }
    return null;
  }

  function retrieveSemantic(seeds = [], options = {}) {
    const { limit = 10, spreadDepth = 2, minStrength = 0.1 } = options;
    
    let activated = new Map();
    
    // Seed activation — accept raw id, bare name, or label
    for (const seed of seeds) {
      const id = resolveConceptId(seed);
      if (id) activated.set(id, 1.0);
    }
    
    // Spreading activation
    for (let depth = 0; depth < spreadDepth; depth++) {
      const newActivated = new Map();
      for (const [conceptId, activation] of activated) {
        const node = semanticGraph.get(conceptId);
        if (!node) continue;
        
        for (const [linkedId, linkStrength] of node.links) {
          const spread = activation * linkStrength * 0.5;
          if (spread > minStrength) {
            const current = newActivated.get(linkedId) || 0;
            newActivated.set(linkedId, Math.max(current, spread));
          }
        }
      }
      for (const [id, act] of newActivated) {
        if (!activated.has(id) || act > activated.get(id)) {
          activated.set(id, act);
        }
      }
    }
    
    const results = [];
    for (const [id, activation] of activated) {
      const node = semanticGraph.get(id);
      if (node && node.strength >= minStrength) {
        results.push({ ...node, activation });
      }
    }
    
    results.sort((a, b) => b.activation - a.activation);
    return results.slice(0, limit);
  }

  function retrieveProcedural(context = {}, neurochem = {}) {
    const { limit = 5, minUtility = 0 } = context;
    
    const results = [];
    for (const [id, prod] of proceduralIndex) {
      if (prod.utility < minUtility) continue;
      
      // Check condition match (simplified)
      let matches = true;
      if (prod.condition) {
        // In production: evaluate condition against context
        matches = evaluateCondition(prod.condition, context);
      }
      if (!matches) continue;
      
      // Neurochem gating
      let gate = 1;
      if (prod.neurochemGate) {
        for (const [nt, required] of Object.entries(prod.neurochemGate)) {
          const available = neurochem[nt] || 0.5;
          gate *= clamp01(available / required);
        }
      }
      
      const effectiveUtility = prod.utility * gate;
      results.push({ ...prod, effectiveUtility, gate });
    }
    
    results.sort((a, b) => b.effectiveUtility - a.effectiveUtility);
    return results.slice(0, limit);
  }

  function evaluateCondition(condition, context) {
    // Simple condition evaluation
    if (typeof condition === "function") return condition(context);
    if (typeof condition === "object") {
      for (const [key, value] of Object.entries(condition)) {
        if (context[key] !== value) return false;
      }
      return true;
    }
    return true;
  }

  function retrieveSocial(personId = null) {
    if (personId) {
      return socialIndex.get(personId) || null;
    }
    // Return all, sorted by recency
    return [...socialIndex.values()].sort((a, b) => b.lastInteraction - a.lastInteraction);
  }

  // ==================== CONSOLIDATION (Sleep) ====================

  function consolidate(now = Date.now()) {
    if (now - lastConsolidation < consolidationInterval) return;
    lastConsolidation = now;
    
    // 1. Episodic → Semantic: extract concepts from high-importance episodes
    for (const [id, ep] of episodicIndex) {
      if (ep.importance >= 7 && ep.activation > 0.3) {
        // Already indexed in semantic, but strengthen
        const concepts = extractConcepts(ep.content);
        for (const c of concepts) {
          if (semanticGraph.has(c.id)) {
            semanticGraph.get(c.id).strength = clamp01(semanticGraph.get(c.id).strength + 0.1);
          }
        }
      }
    }
    
    // 2. Procedural utility decay (forgetting unused skills)
    for (const [id, prod] of proceduralIndex) {
      const hoursSinceUse = (now - prod.lastUsed) / 3600000;
      if (hoursSinceUse > 168) { // 1 week
        prod.utility *= Math.pow(DECAY.procedural, hoursSinceUse / 168);
      }
    }
    
    // 3. Social relationship decay
    for (const [id, model] of socialIndex) {
      const hoursSinceContact = (now - model.lastInteraction) / 3600000;
      if (hoursSinceContact > 24) {
        model.trust *= Math.pow(DECAY.social, hoursSinceContact / 24);
        model.affinity *= Math.pow(DECAY.social, hoursSinceContact / 24);
      }
    }
    
    // 4. Episodic activation decay (handled in retrieval via time)
    // 5. Prune very old, low-activation episodes (keep last 5000)
    if (eventLog.length > 5000) {
      const cutoff = eventLog.length - 5000;
      eventLog.splice(0, cutoff);
    }
    
    return {
      episodicCount: episodicIndex.size,
      semanticCount: semanticGraph.size,
      proceduralCount: proceduralIndex.size,
      socialCount: socialIndex.size,
    };
  }

  // ==================== UTILITIES ====================

  // Verbatim specs — exact-text artifacts (boilerplates, addresses, vows).
  // Soul chapters are prose summaries and drift on recall; specs are
  // byte-exact and only surface on exact tasks (code mode, "word for
  // word"). Capped count, newest wins; persisted with the checkpoint.
  const specIndex = new Map(); // name(lower) -> { name, text, at }
  const SPEC_MAX = 30;

  /**
   * Store an exact spec. Overwrites same-name specs — there is exactly one
   * truth per name, never two competing versions.
   */
  function rememberSpec(name, text) {
    const cleanName = String(name || "").trim().slice(0, 60);
    const cleanText = String(text || "").trim().slice(0, 2000);
    if (!cleanName || !cleanText) return null;
    specIndex.set(cleanName.toLowerCase(), { name: cleanName, text: cleanText, at: Date.now() });
    while (specIndex.size > SPEC_MAX) {
      specIndex.delete(specIndex.keys().next().value); // oldest first out
    }
    return cleanName;
  }

  /** Exact lookup, then substring, then shared-word overlap as a last
   * resort ("grape midnight boilerplate please" still means the grape
   * boilerplate spec). One shared content word (≥4 chars) suffices. */
  function recallSpec(query) {
    const q = String(query || "").toLowerCase().trim();
    if (!q) return null;
    if (specIndex.has(q)) return specIndex.get(q);
    for (const [key, spec] of specIndex) {
      if (key.includes(q) || q.includes(key)) return spec;
    }
    const qwords = new Set(q.split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
    if (!qwords.size) return null;
    for (const [key, spec] of specIndex) {
      const kwords = key.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
      if (kwords.some((w) => qwords.has(w))) return spec;
    }
    return null;
  }

  function getStats() {
    return {
      totalEvents: eventLog.length,
      episodic: episodicIndex.size,
      semantic: semanticGraph.size,
      procedural: proceduralIndex.size,
      social: socialIndex.size,
      specs: specIndex.size,
      lastConsolidation,
    };
  }

  function toJSON() {
    return {
      eventLog: eventLog.slice(-1000), // Only persist recent
      eventSeq,
      episodicIndex: Object.fromEntries(episodicIndex),
      semanticGraph: Object.fromEntries(
        [...semanticGraph.entries()].map(([k, v]) => [k, { ...v, links: Object.fromEntries(v.links) }])
      ),
      proceduralIndex: Object.fromEntries(proceduralIndex),
      socialIndex: Object.fromEntries(
        [...socialIndex.entries()].map(([k, v]) => [k, { ...v, insideVocab: [...v.insideVocab] }])
      ),
      specIndex: Object.fromEntries(specIndex),
      lastConsolidation,
    };
  }

  function fromJSON(data) {
    if (!data) return;
    eventLog.length = 0;
    if (data.eventLog) eventLog.push(...data.eventLog);
    eventSeq = data.eventSeq || 0;
    
    episodicIndex.clear();
    if (data.episodicIndex) {
      for (const [k, v] of Object.entries(data.episodicIndex)) episodicIndex.set(k, v);
    }
    
    semanticGraph.clear();
    if (data.semanticGraph) {
      for (const [k, v] of Object.entries(data.semanticGraph)) {
        semanticGraph.set(k, { ...v, links: new Map(Object.entries(v.links || {})) });
      }
    }
    
    proceduralIndex.clear();
    if (data.proceduralIndex) {
      for (const [k, v] of Object.entries(data.proceduralIndex)) proceduralIndex.set(k, v);
    }
    
    socialIndex.clear();
    if (data.socialIndex) {
      for (const [k, v] of Object.entries(data.socialIndex)) {
        socialIndex.set(k, { ...v, insideVocab: new Set(v.insideVocab || []) });
      }
    }

    specIndex.clear();
    if (data.specIndex) {
      for (const [k, v] of Object.entries(data.specIndex)) specIndex.set(k, v);
    }

    lastConsolidation = data.lastConsolidation || 0;
  }

  return {
    addEvent,
    rememberSpec,
    recallSpec,
    retrieveEpisodic,
    retrieveSemantic,
    retrieveProcedural,
    retrieveSocial,
    consolidate,
    getStats,
    toJSON,
    fromJSON,
    // Direct access for debugging
    _eventLog: eventLog,
    _episodicIndex: episodicIndex,
    _semanticGraph: semanticGraph,
    _proceduralIndex: proceduralIndex,
    _socialIndex: socialIndex,
  };
}