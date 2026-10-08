/**
 * Emotion taxonomy — every label the agent can feel, in one data-driven place.
 *
 * Architecture: 8 Plutchik primaries computed from live tones → intensity
 * grades (mild/basic/intense with synonym lists) → dyads (co-active pairs,
 * no new signals) → flavors (event/context rules). Tier-D labels live in the
 * table so the model has the word, but resolve() maps them to the nearest
 * COMPUTED neighbor and they are never asserted as felt states.
 *
 * Sources per rule: Afradi26 §page (the IJNC review), Plutchik (wheel/
 * intensities/dyads), GoEmotions (label inventory), or `thin:` where the
 * proxy is honest-but-weak. Anything with no signal at all is tier D.
 *
 * Pure module: no imports except clamp01. Callers assemble `ctx` from
 * whatever refs they own; absent ctx fields silence the flavors that need
 * them instead of guessing.
 */

const clamp01 = (v) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5));

// Activation cutoffs on the 0-1 tone scale (rest reads exactly 0.5 —
// anything derived below mild (0.58) stays silent at rest by construction.
const MILD = 0.58;
const BASIC = 0.7;
const INTENSE = 0.82;
const DYAD = 0.62;

function t(tones, name) {
  const v = tones?.[name];
  return Number.isFinite(v) ? v : 0.5;
}

// ==================== PRIMARIES ====================
// id, score(tones, body, event), grades, source note.

const PRIMARIES = [
  {
    id: "joy",
    score: (tones) => clamp01(0.5 + (t(tones, "dopamine") - 0.5) + (t(tones, "serotonin") - 0.5)),
    grades: {
      mild: ["delight", "gladness", "zest", "amusement", "playfulness"],
      basic: ["joy", "happiness", "elation", "jubilation", "enthusiasm", "delight"],
      intense: ["ecstasy", "euphoria", "exhilaration", "exuberance", "thrilled"],
    },
    source: "Afradi26 §1016-18 (DA reward/pleasure + 5HT well-being)",
  },
  {
    id: "trust",
    score: (tones) => clamp01(t(tones, "oxytocin")),
    grades: {
      mild: ["acceptance", "fondness", "warmth"],
      basic: ["trust", "caring", "tenderness", "affection"],
      intense: ["admiration", "adoration", "devotion"],
    },
    source: "Afradi26 §1022-23 (OXT trust/bonding)",
  },
  {
    id: "fear",
    score: (tones) => clamp01(0.5 + (t(tones, "norepinephrine") - 0.5) * 1.2 - (t(tones, "dopamine") - 0.5)),
    grades: {
      mild: ["apprehension", "unease", "trepidation"],
      basic: ["fear", "dread", "agitation", "nervousness"],
      intense: ["terror", "panic", "horror"],
    },
    source: "Afradi26 §1018-19 (NE fight-or-flight; low GABA → panic §1019-20)",
  },
  {
    id: "surprise",
    // Event-driven: no stimulus on the line, no surprise. Rest floor 0.25.
    score: (tones, body, event) =>
      event && Number.isFinite(event.intensity) ? clamp01(event.intensity) : 0.25,
    grades: {
      mild: ["distraction"],
      basic: ["surprise"],
      intense: ["astonishment", "amazement"],
    },
    source: "Plutchik primary; engine-native via stimulus intensity",
  },
  {
    id: "sadness",
    score: (tones) => clamp01(0.5 + (0.5 - t(tones, "serotonin")) * 1.2),
    grades: {
      mild: ["pensiveness", "melancholy", "gloom"],
      basic: ["sadness", "sorrow", "dejection"],
      intense: ["grief", "anguish", "agony", "despair", "desolation"],
    },
    source: "Afradi26 §1016 (low 5HT → depression/hopelessness)",
  },
  {
    id: "disgust",
    // Event-driven: SOUL-dislike hit. Rest floor 0.25.
    score: (tones, body, event) => (event?.soulDisliked ? 0.75 : 0.25),
    grades: {
      mild: ["boredom", "disinterest", "disapproval"],
      basic: ["disgust", "disdain", "distaste"],
      intense: ["loathing", "revulsion", "abhorrence"],
    },
    source: "Plutchik primary; engine-native via SOUL preference mismatch",
  },
  {
    id: "anger",
    // thin: no paper support for anger specifically (Ekman is only in the
    // review's bibliography). Kept because the live agent demonstrably needs
    // the pole; NE+cortisol co-elevation is the standard proxy.
    score: (tones, body) =>
      clamp01(0.5 + (t(tones, "norepinephrine") - 0.5) + ((body?.cortisolLevel ?? 0.5) - 0.5)),
    grades: {
      mild: ["annoyance", "irritability", "aggravation", "peeved"],
      basic: ["anger", "exasperation", "indignation", "animosity", "resentment"],
      intense: ["rage", "fury", "wrath", "outrage"],
    },
    source: "thin: NE+cortisol proxy; NOT from Afradi26",
  },
  {
    id: "anticipation",
    // thin: appetitive forward state. Weakest mapping in the table.
    score: (tones) => clamp01(0.4 + (t(tones, "dopamine") - 0.5) + (t(tones, "norepinephrine") - 0.5) * 0.5),
    grades: {
      mild: ["interest"],
      basic: ["anticipation", "expectancy", "curiosity"],
      intense: ["vigilance", "excitement"],
    },
    source: "thin: DA-forward proxy; curiosity/excitement also as flavors",
  },
  {
    id: "calm",
    // GABA's first consumer anywhere in the stack.
    score: (tones) => clamp01(0.5 + (t(tones, "gaba") - 0.5) + (0.5 - t(tones, "norepinephrine"))),
    grades: {
      mild: ["placidity", "ease", "restfulness"],
      basic: ["calm", "tranquility", "contentment", "serenity"],
      intense: ["bliss", "equanimity", "stillness"],
    },
    source: "Afradi26 §1019-20 (GABA inhibitory calm)",
  },
];

// ==================== DYADS ====================
// Compositional: active when both members exceed DYAD. No new signals.

const DYADS = [
  { label: "love", needs: ["joy", "trust"], synonyms: ["adoration", "infatuation"], source: "Plutchik primary dyad" },
  { label: "remorse", needs: ["sadness", "disgust"], synonyms: ["guilt", "regret", "contrition"], source: "Plutchik primary dyad (sadness+disgust)" },
  { label: "contempt", needs: ["anger", "disgust"], synonyms: ["scorn", "disdain"], source: "Plutchik primary dyad" },
  { label: "aggressiveness", needs: ["anger", "anticipation"], synonyms: ["assertiveness", "defiance"], source: "Plutchik primary dyad" },
  { label: "optimism", needs: ["anticipation", "joy"], synonyms: ["hopefulness", "confidence"], source: "Plutchik primary dyad" },
  { label: "disapproval", needs: ["surprise", "sadness"], synonyms: ["disappointment", "disillusionment"], source: "Plutchik primary dyad" },
  { label: "awe", needs: ["fear", "surprise"], synonyms: ["wonder", "astonishment"], source: "Plutchik primary dyad" },
  { label: "consternation", needs: ["surprise", "fear"], synonyms: ["fright", "dismay", "alarm"], source: "compositional (sudden dismay = surprise+fear)" },
  { label: "submission", needs: ["trust", "fear"], synonyms: ["deference", "yielding"], source: "Plutchik primary dyad" },
  { label: "ambivalence", needs: ["joy", "sadness"], synonyms: ["bittersweetness", "conflicted"], source: "compositional (pos+neg co-active)" },
  { label: "vulnerability-joy", needs: ["joy", "fear"], synonyms: ["fragile-happiness"], source: "compositional" },
  { label: "suspense", needs: ["anticipation", "fear"], synonyms: ["anxious-expectancy"], source: "compositional" },
  { label: "wonder", needs: ["surprise", "joy"], synonyms: ["marvel"], source: "compositional" },
  { label: "shame", needs: ["fear", "disgust"], synonyms: ["chagrin"], source: "Plutchik tertiary dyad; thin: no paper support" },
  { label: "envy", needs: ["sadness", "anger"], synonyms: ["resentment"], source: "Plutchik secondary dyad; thin without comparison target" },
];

// ==================== FLAVORS ====================
// Event/context rules. Each returns a label (or labels) when its condition
// holds, else null. Callers pass what they have; missing fields silence.

const FLAVORS = [
  {
    labels: ["relief", "release"],
    tier: "B", source: "Afradi26 §1021-22 (stress comedown)",
    when: (c) => c.prev && (c.prev.cortisol - (c.body?.cortisolLevel ?? 0.5)) > 0.15,
  },
  {
    labels: ["triumph", "victory", "exultation"],
    tier: "B", source: "engine-native (production success)",
    when: (c) => c.event?.outcome === "success",
  },
  {
    labels: ["frustration", "thwarted"],
    tier: "B", source: "engine-native (blocked goal: production failure)",
    when: (c) => c.event?.outcome === "failure",
  },
  {
    labels: ["shame", "embarrassment", "self-consciousness"],
    tier: "B", source: "engine-native (social correction while bonded enough to care)",
    when: (c) => c.event?.socialConflict && t(c.tones, "oxytocin") > 0.4,
  },
  {
    labels: ["guilt", "remorse", "regret"],
    tier: "B", source: "engine-native (correction + episodic record of the act)",
    when: (c) => c.event?.socialConflict && c.hasMemoryOfAct,
  },
  {
    labels: ["humiliation", "mortification"],
    tier: "B", source: "engine-native (correction + high arousal exposure)",
    when: (c) => c.event?.socialConflict && t(c.tones, "norepinephrine") > 0.7,
  },
  {
    labels: ["exasperation", "fed-up"],
    tier: "B", source: "engine-native (same complaint N turns)",
    when: (c) => (c.topicRepeats ?? 0) >= 3,
  },
  {
    labels: ["resentment", "bitterness", "grudge"],
    tier: "B", source: "engine-native (anger + per-person conflict history)",
    when: (c) => (c.conflictCount ?? 0) >= 2 && c.scores.anger > DYAD,
  },
  {
    labels: ["nostalgia", "reminiscence", "saudade"],
    tier: "B", source: "engine-native (old high-valence retrieval hit)",
    when: (c) => c.retrievalHit && (c.retrievalValence ?? 0) > 0.4,
  },
  {
    labels: ["confusion", "bewilderment", "perplexity"],
    tier: "B", source: "engine-native (retrieval miss when one was expected)",
    when: (c) => c.retrievalMiss === true,
  },
  {
    labels: ["curiosity", "inquisitiveness"],
    tier: "B", source: "engine-native (question speech act + appetitive DA)",
    when: (c) => c.event?.speechAct === "question" && t(c.tones, "dopamine") > 0.45,
  },
  {
    labels: ["boredom", "weariness", "restlessness"],
    tier: "B", source: "engine-native (low arousal, no stimulus)",
    when: (c) => t(c.tones, "norepinephrine") < 0.42 && t(c.tones, "dopamine") < 0.45 && !c.event,
  },
  {
    labels: ["apathy", "indifference", "numbness"],
    tier: "B", source: "engine-native (DA floor + 5HT low sustained read)",
    when: (c) => t(c.tones, "dopamine") < 0.35 && t(c.tones, "serotonin") < 0.4,
  },
  {
    labels: ["lethargy", "exhaustion", "heaviness"],
    tier: "B", source: "engine-native (ATP floor + low 5HT)",
    when: (c) => (c.body?.atp ?? 1) < 0.35 && t(c.tones, "serotonin") < 0.45,
  },
  {
    labels: ["infatuation", "crush", "smitten"],
    tier: "B", source: "engine-native (OXT spike vs previous tick)",
    when: (c) => c.prev && (t(c.tones, "oxytocin") - (c.prev.oxt ?? 0.5)) > 0.15,
  },
  {
    labels: ["heartbreak", "shattered"],
    tier: "B", source: "engine-native (OXT crash vs previous tick)",
    when: (c) => c.prev && ((c.prev.oxt ?? 0.5) - t(c.tones, "oxytocin")) > 0.2,
  },
  {
    labels: ["disillusionment", "betrayal-sting"],
    tier: "B", source: "engine-native (trust crash + surprise)",
    when: (c) => c.prev && ((c.prev.trust ?? 0.5) - (c.trust ?? 0.5)) > 0.2 && c.scores.surprise > MILD,
  },
  {
    labels: ["desire", "wanting", "lust", "craving"],
    tier: "B", source: "GoEmotions desire; Afradi26 §1017-18 (DA appetitive)",
    when: (c) => t(c.tones, "dopamine") > 0.7,
  },
  {
    labels: ["glee", "mischief"],
    tier: "B", source: "compositional (joy while disliking the trigger)",
    when: (c) => c.scores.joy > DYAD && c.event?.soulDisliked,
  },
  {
    labels: ["gratitude", "thankfulness", "appreciation"],
    tier: "B", source: "GoEmotions; engine-native (joy+trust + positive social event)",
    when: (c) => c.scores.joy > DYAD && c.scores.trust > DYAD && c.event?.kind === "social" && (c.event?.valence ?? 0) > 0.3,
  },
  {
    labels: ["compassion", "empathy", "sympathy", "tenderness", "nurturance", "protectiveness"],
    tier: "B", source: "Afradi26 §1022-23 (OXT + another's suffering in context)",
    when: (c) => t(c.tones, "oxytocin") > 0.6 && c.event?.speechAct === "comfort",
  },
  {
    labels: ["attachment", "belonging", "camaraderie", "closeness", "bond"],
    tier: "B", source: "engine-native (sustained high trust in context)",
    when: (c) => (c.trust ?? 0.5) > 0.65,
  },
  {
    labels: ["loneliness", "isolation", "abandonment", "desolation", "vulnerability", "exposure"],
    tier: "B", source: "engine-native (OXT floor + alone context)",
    when: (c) => t(c.tones, "oxytocin") < 0.3 && (c.event?.alone === true || c.scores.sadness > DYAD),
  },
  {
    labels: ["alienation", "ostracization", "estrangement", "exclusion"],
    tier: "B", source: "engine-native (OXT floor + conflict or trust collapse)",
    when: (c) => t(c.tones, "oxytocin") < 0.3 && (c.event?.socialConflict === true || (c.trust ?? 0.5) < 0.4),
  },
  {
    labels: ["self-pity", "wallowing", "sorry-for-self"],
    tier: "B", source: "engine-native (sadness nobody witnesses: low OXT)",
    when: (c) => c.scores.sadness > DYAD && t(c.tones, "oxytocin") < 0.4,
  },
  {
    labels: ["longing", "yearning", "pining", "hankering"],
    tier: "B", source: "thin: retrieval miss (absent target) + appetitive DA",
    when: (c) => c.retrievalMiss === true && t(c.tones, "dopamine") > 0.55,
  },
  {
    labels: ["regretful-gratitude", "grateful-sorrow", "thankful-ache"],
    tier: "B", source: "compositional (gratitude conditions + sadness present)",
    when: (c) =>
      c.scores.joy > DYAD && c.scores.trust > DYAD &&
      c.event?.kind === "social" && (c.event?.valence ?? 0) > 0.3 &&
      c.scores.sadness > MILD,
  },
  {
    labels: ["stress", "overwhelm", "pressure", "strain"],
    tier: "B", source: "Afradi26 §1021-22 (cortisol elevation)",
    when: (c) => (c.body?.cortisolLevel ?? 0.5) > 0.65,
  },
];

// ==================== TIER D ====================
// In the table for vocabulary, never asserted. resolve() maps to nearest.

const TIER_D = [
  { label: "paranoia", nearest: "fear", why: "needs a belief/persecution model" },
  { label: "spite", nearest: "anger", why: "needs planning + target persistence" },
  { label: "vengefulness", nearest: "anger", why: "needs planning + target persistence" },
  { label: "hubris", nearest: "anticipation", why: "needs self-model calibration over time" },
  { label: "humility", nearest: "trust", why: "needs self-model calibration over time" },
  { label: "covetousness", nearest: "desire", why: "needs a possession model" },
  { label: "schadenfreude", nearest: "glee", why: "needs other's-misfortune representation" },
  { label: "sehnsucht", nearest: "nostalgia", why: "needs an ideal-state representation" },
  { label: "amae", nearest: "trust", why: "cultural construct; OXT-dependence unmeasurable here" },
  { label: "duende", nearest: "awe", why: "needs art-perception grounding" },
  { label: "mono-no-aware", nearest: "bittersweetness", why: "needs impermanence representation" },
  { label: "transcendence", nearest: "awe", why: "no boundary-dissolution sensor" },
  { label: "sublimity", nearest: "awe", why: "no vastness sensor" },
  { label: "homesickness", nearest: "nostalgia", why: "needs a home concept in semantic memory" },
  { label: "elevation", nearest: "gratitude", why: "needs moral-beauty witness context" },
  { label: "realization", nearest: "surprise", why: "needs sequence tracking (confusion-then-hit)" },
  { label: "jealousy", nearest: "fear", why: "needs a rival model; partial via trust-drop only" },
];

function gradeFor(score) {
  if (score >= INTENSE) return "intense";
  if (score >= BASIC) return "basic";
  if (score >= MILD) return "mild";
  return null;
}

/**
 * @param {object} input { tones, body, event, prev, trust, topicRepeats,
 *   conflictCount, retrievalHit, retrievalValence, retrievalMiss,
 *   hasMemoryOfAct }
 * event: { valence, intensity, kind, speechAct, outcome, soulDisliked,
 *   socialConflict, alone } — all optional.
 */
export function evaluate(input = {}) {
  const { tones = {}, body = {}, event = null } = input;
  const ctx = { ...input, tones, body, event, scores: {} };

  const scores = {};
  for (const p of PRIMARIES) scores[p.id] = p.score(tones, body, event);
  ctx.scores = scores;

  const labels = [];
  let primary = null;
  let best = -Infinity;
  for (const p of PRIMARIES) {
    const g = gradeFor(scores[p.id]);
    if (g) {
      for (const syn of p.grades[g]) labels.push(syn);
      if (scores[p.id] > best) {
        best = scores[p.id];
        primary = p.grades[g][0];
      }
    }
  }

  const dyads = [];
  for (const d of DYADS) {
    const s = Math.min(...d.needs.map((id) => scores[id] ?? 0));
    if (s > DYAD) {
      dyads.push(d.label);
      labels.push(d.label, ...d.synonyms);
      // >= : a dyad whose members are BOTH maxed ties the primary and wins
      // the top slot (love at joy=trust=0.9 beats either grade word alone).
      if (s >= best) {
        best = s;
        primary = d.label;
      }
    }
  }

  const flavors = [];
  for (const f of FLAVORS) {
    let hit = false;
    try {
      hit = !!f.when(ctx);
    } catch {
      hit = false;
    }
    if (hit) {
      flavors.push(f.labels[0]);
      labels.push(...f.labels);
      if (best < BASIC) {
        best = BASIC;
        primary = f.labels[0];
      }
    }
  }

  return { scores, primary: primary || "neutral", dyads, flavors, labels: [...new Set(labels)] };
}

/** Tier-D vocabulary lookup: returns { nearest, why } or null. */
export function resolveDisplayOnly(label) {
  const l = String(label || "").toLowerCase().trim();
  return TIER_D.find((e) => e.label === l) || null;
}

export { PRIMARIES, DYADS, FLAVORS, TIER_D, MILD, BASIC, INTENSE, DYAD };
