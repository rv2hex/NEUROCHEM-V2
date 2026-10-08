/**
 * PhraseEngine — primary neuro→token generator (promoted from Layer 7).
 *
 * CANDIDATES ARE NOT SENTENCES. Each candidate is a word-skeleton:
 *
 *   {
 *     frame: "ack_followup",               // move structure (what slots to fill)
 *     slots: ["exclam", "ack", "followup"],
 *     words: { exclam: "Damn", ack: "solid", followup: "How'd it go?" },
 *     carry: "militech",                   // OPTIONAL: subject carried over from
 *                                          // an earlier exchange. Absent when
 *                                          // nothing was remembered — it is NOT
 *                                          // a slot, so the LLM may use it or
 *                                          // ignore it.
 *     accent: { dialect, cadence, sample, density },   // from SOUL.md
 *     confidence, prosody, disfluency, hint
 *   }
 *
 * The LLM fills the frame into a real sentence in SOUL's accent.
 * Change the SOUL → dialect, density, cadence, sample all change →
 * candidates come out in a different accent.
 *
 * Word pools come from the SOUL-selected dialect pack (config/slang.json),
 * filtered by state: formality gates swearing, warmth gates softness,
 * neurochem gates exclamation/followup words.
 */

import { clamp01, mulberry32, softmax, weightedPick } from "../utils/math.js";
import { loadSoul, buildAccentPack } from "../personality/soul.js";

/** Frame inventory: the move structures a reply can take. */
const FRAMES = {
  // greet/farewell used to be single-frame, so a repeat-aware picker had
  // nothing to rotate to and every opening and closing came out identically.
  // The `_alt` frames add a second structure without renaming the originals.
  greet: ["greeting"],
  greet_alt: ["greeting", "filler"],
  farewell: ["parting"],
  farewell_alt: ["parting", "filler"],
  ack_only: ["exclam", "ack"],
  ack_followup: ["exclam", "ack", "followup"],
  comfort_plain: ["exclam", "soften"],
  comfort_ask: ["exclam", "soften", "care"],
  answer: ["lead", "answer"],
  answer_bare: ["answer"],
  statement_react: ["react", "opinion"],
  statement_share: ["react", "share_word", "followup"],
  self_state: ["state_word", "state_detail"],
  refuse: ["refusal"],
  brush: ["dismissal"],
  suggest: ["suggest_lead", "option"],
  phatic: ["filler", "turn_take"],
  uncertain: ["hedge", "stance"],
  idk: ["idk_word"],
  threat: ["threat_word", "condition"],
  flirt: ["flirt_open", "flirt_core"],
  question_back: ["wh", "back"],
};

/** Slot pools per state dimension — base words before accent filtering. */
const SLOT_POOLS = {
  exclam: {
    low: ["Damn", "Hell", "Shit", "Fuck", "Hell's"],
    mid: ["Yeah", "Right", "Okay", "Aye"],
    high: ["No way", "Holy shit", "Fuck yes", "Nova"],
  },
  greeting: ["Yo", "Hey", "Sup", "Hello", "Howdy"],
  parting: ["Later", "Catch you", "See ya", "Take care", "Goodbye"],
  ack: {
    pos: ["solid", "nice", "good for you", "there you go", "chuffed"],
    neg: ["rough", "brutal", "tough", "hard", "cruel"],
    neu: ["right", "yeah", "okay", "fair"],
  },
  soften: ["hey", "look", "breathe", "listen", "steady"],
  care: ["You good?", "How you holding up?", "You okay?", "What happened?"],
  followup: ["What happened next?", "How'd it go?", "And then?", "Tell me more."],
  lead: ["Look", "Straight up", "Honestly", "Simple"],
  answer: ["Six districts", "yeah", "no", "depends"],
  react: ["Damn", "Huh", "Right", "Wait"],
  opinion: ["figures", "that's how it goes", "called it", "no surprise"],
  share_word: ["same", "been there", "felt that", "heard"],
  state_word: ["tired", "wired", "flat", "fine", "here", "wound up"],
  state_detail: ["long day", "too much noise", "running on fumes", "steady", "not much"],
  refusal: ["No.", "Nah.", "Not happening.", "Pass."],
  dismissal: ["Says you.", "Whatever.", "Sure thing.", "If you like."],
  suggest_lead: ["Try", "Hit", "Go with", "Your move"],
  option: ["the Afterlife", "a ripperdoc", "Kabuki", "the Badlands"],
  filler: ["Same as always", "Not much", "You know me"],
  turn_take: ["You?", "What about you?", "And you?"],
  hedge: ["I figure", "I guess", "Last I heard", "Could be"],
  stance: ["that's how it is", "don't know more", "shaky ground"],
  idk_word: ["dunno", "no idea", "beats me", "search me", "your guess"],
  threat_word: ["Back off", "Try me", "Don't"],
  condition: ["you push it", "you come near", "it happens again"],
  flirt_open: ["Hey", "Look at you", "There you are"],
  flirt_core: ["not bad", "you look good", "missed this"],
  wh: ["What", "Why", "How", "When"],
  back: ["you think?", "your call", "what about you"],
};

export function createPhraseEngine(config = {}) {
  const rng = mulberry32(config.seed || 42);

  // SOUL voice profile (the accent source)
  let voice = loadSoul(config.root || process.cwd(), config.soulPath || null);
  let accent = null;
  let dialectPack = null;
  // Calendar year for slang age-gating (coined/dies). Override with config.era.
  let era = Number.isFinite(config.era) ? config.era : null;
  loadDialect();

  // Refs
  let neurochemRef = null;
  let memoryRef = null;
  let energyRef = null;

  // Anti-repeat
  let recentFrames = [];
  let recentWords = [];
  const RECENT_MAX = 30;

  function loadDialect() {
    dialectPack = config.dialectPack || dialectPack || null;
    const pack = dialectPack?.dialects?.[voice.dialect]
      || dialectPack?.dialects?.[dialectPack?.default]
      || null;
    if (era === null) era = Number.isFinite(dialectPack?.era) ? dialectPack.era : null;
    accent = buildAccentPack(voice, pack, era);
  }

  /** Move the calendar year → dead slang drops out, new slang appears. */
  function setEra(year) {
    era = Number.isFinite(year) ? year : null;
    loadDialect();
    recentWords = [];
    return era;
  }

  /** Reload SOUL → new accent. This is the "soul changes → accent changes" hook. */
  function setSoul(rootOrPath, isPath = false) {
    if (isPath) {
      voice = loadSoul("", rootOrPath);
    } else {
      voice = loadSoul(rootOrPath);
    }
    loadDialect();
    recentFrames = [];
    recentWords = [];
    return voice;
  }

  function setDialectPack(pack) {
    dialectPack = pack;
    loadDialect();
  }

  function setRefs(refs) {
    neurochemRef = refs.neurochem;
    memoryRef = refs.memory;
    energyRef = refs.energy;
  }

  // ==================== STATE READS ====================

  /**
   * Neurochem on the EFFECT scale. Raw volume compartments are concentrations
   * (DA rests at ~0.12), so reading them against 0-1 makes everything look
   * depleted. Tones put baseline at 0.5.
   */
  function readTones() {
    if (!neurochemRef) return {};
    return neurochemRef.getAllTones ? neurochemRef.getAllTones() : {};
  }

  function actionTendencies() {
    const n = readTones();
    const e = energyRef ? energyRef.getState() : {};
    const da = n.dopamine ?? 0.5;
    const ht = n.serotonin ?? 0.5;
    const ne = n.norepinephrine ?? 0.5;
    const cort = e.cortisolLevel ?? 0.5;
    const oxt = n.oxytocin ?? 0.3;
    const energy = e.atp ?? 1;
    const amyg = clamp01(cort * 0.7 + ne * 0.3);

    const approach = clamp01(da * 0.7 + oxt * 0.3 - amyg * 0.4);
    const verbose = clamp01(da * 0.5 + energy * 0.3 + (e.sleepPressure < 0.4 ? 0.2 : 0) - cort * 0.3 + voice.verbosity * 0.3 - 0.15);
    const warm = clamp01(oxt * 0.6 + ht * 0.4 - amyg * 0.3 + voice.warmth * 0.4 - 0.2);
    const impulsive = clamp01(da * 0.5 + ne * 0.3 - ht * 0.2);
    const certain = clamp01(ne * 0.4 + da * 0.4 - (e.sleepPressure * 0.3) - (1 - energy) * 0.3 + (1 - voice.hedging) * 0.2 - 0.1);
    const dominant = clamp01(ne * 0.5 + da * 0.3 - amyg * 0.2);

    return {
      approach: +approach.toFixed(2),
      avoid: +(1 - approach).toFixed(2),
      verbose: +verbose.toFixed(2),
      terse: +(1 - verbose).toFixed(2),
      warm: +warm.toFixed(2),
      guarded: +(1 - warm).toFixed(2),
      impulsive: +impulsive.toFixed(2),
      deliberate: +(1 - impulsive).toFixed(2),
      certain: +certain.toFixed(2),
      uncertain: +(1 - certain).toFixed(2),
      dominant: +dominant.toFixed(2),
      submissive: +(1 - dominant).toFixed(2),
    };
  }

  function stateNarrative() {
    const n = neurochemRef ? readTones() : {};
    const e = energyRef ? energyRef.getState() : {};
    const lines = [];
    const energy = e.atp ?? 1;
    const pressure = e.sleepPressure ?? 0;
    const cort = e.cortisolLevel ?? 0.5;
    const da = n.dopamine ?? 0.5;
    const ht = n.serotonin ?? 0.5;
    const oxt = n.oxytocin ?? 0.3;
    const ne = n.norepinephrine ?? 0.5;
    const gaba = n.gaba ?? 0.5;

    if (energy < 0.35 || pressure > 0.7) lines.push("Your eyelids sit heavy. Every thought drags itself out slower than you want.");
    else if (energy > 0.75 && da > 0.6) lines.push("You're running warm and wired — thoughts come fast, words come faster.");

    if (cort > 0.65) lines.push("Chest tight, jaw set. Everything's a little too loud, a little too close.");
    else if (cort < 0.35) lines.push("Shoulders down, breath easy. Nothing's pushing.");

    if (da < 0.4 && ht < 0.45) lines.push("Flat. Not sad — just nothing much reaching you.");
    else if (da > 0.65 && oxt > 0.55) lines.push("Warmth sitting behind the sternum. You want to reach out.");
    // Paper-mapped poles the narrative lacked: high-5HT happiness (there was
    // no positive-calm pole at all), GABA calm (distinct from flat — settled,
    // not empty), deep OXT bondedness, and grief below the flat band.
    if (ht > 0.65) lines.push("Something warm humming under everything. World's treating you right today.");
    if (gaba > 0.6 && ne < 0.55) lines.push("Settled. Nothing buzzing under the skin for once.");
    if (oxt > 0.7) lines.push("People feel close. You'd cross the street for yours right now.");
    if (ht < 0.3) lines.push("Ache sitting low and steady, like weather that won't lift.");

    if (ne > 0.68) lines.push("Eyes keep flicking. Small sounds land too hard.");
    if (oxt < 0.25) lines.push("Guard up, arms crossed without noticing.");

    if (lines.length === 0) lines.push("Level. Neither up nor down. You're here, that's all.");
    return lines.join(" ");
  }

  function behavioralGuidance(move, t = actionTendencies()) {
    const effects = [];
    effects.push(`sentence count: ${t.terse > 0.7 ? "1-2 max (clipped)" : t.verbose > 0.7 ? "3 allowed (elaborate)" : "1-2"}`);
    effects.push(`syntax: ${t.deliberate > 0.65 ? "complex ok (embedded clauses)" : "simple, paratactic"}`);
    effects.push(`accent: ${accent.dialectKey || voice.dialect} (${accent.dialect}) — ${accent.cadence} (say it like: "${accent.sample}")`);
    effects.push(`slang: use ${accent.density}`);
    effects.push(`swearing: ${voice.swearing > 0.5 ? "yes, when it lands" : voice.swearing > 0.3 ? "sparingly" : "no"}`);
    effects.push(`pace: ${t.impulsive > 0.7 ? "fast, runs on" : t.deliberate > 0.7 ? "measured, pauses planned" : "natural"}`);
    if (t.uncertain > 0.65) effects.push("hedging: yes — 'I think', 'maybe', 'not sure'");
    if (t.terse > 0.75) effects.push("avoid: questions, topic shifts, humor");

    return { move, behavioral_effects: effects, tendencies: t, accent: accentBlock() };
  }

  function accentBlock() {
    return {
      dialect: accent.dialect,
      dialectKey: accent.dialectKey,
      density: accent.density,
      cadence: accent.cadence,
      sample: accent.sample,
      name: voice.name,
    };
  }

  // ==================== CANDIDATE GENERATION ====================

  /**
   * Generate word-skeleton candidates. The LLM fills them.
   * @param {object} move    { speechAct, topic, content }
   * @param {object} ctx     { seed, userText }
   * @returns {Array} word-skeleton candidates
   */
  function generateCandidates(move = {}, ctx = {}) {
    const seed = (Number(ctx.seed) || 0) >>> 0;
    const localRng = mulberry32(seed ^ 0x51ed270b);
    const t = actionTendencies();
    const n = neurochemRef ? readTones() : {};
    const e = energyRef ? energyRef.getState() : {};

    // Candidate count: stressed/worn → fewer options
    const count = t.uncertain > 0.7 || (e.sleepPressure ?? 0) > 0.8 ? 3 : 5;

    // Pick frames compatible with the speech act, then rank by
    // state fit + how well the frame answers THIS message
    const frameIds = framesForAct(move.speechAct || ctx.speechAct || "assert", t);

    /**
     * Anti-repeat is a preference, never a veto.
     *
     * Every act's frame pool (greet/farewell 2, comfort 2, question 2-3,
     * assert 4) is
     * SMALLER than the number of candidates a single call emits, so a hard
     * "skip anything used recently" filter spent the entire pool on turn 1 and
     * every later turn fell through to the lone `phatic` fallback — forever,
     * for every speech act. Prefer frames not used yet; once the pool is
     * spent, reuse the least-recent ones rather than offer nothing.
     */
    const fresh = frameIds.filter((id) => !recentFrames.includes(id));
    const pool = fresh.length
      ? fresh
      : [...frameIds].sort(
          (a, b) => recentFrames.lastIndexOf(a) - recentFrames.lastIndexOf(b)
        );

    const remembered = rememberedTopic(move, ctx);
    const recalled = recallLine(move, ctx);

    const scored = pool.map((id) => ({
      id,
      fit: frameFit(id, t, n) + moveAffinity(id, move, t) + memoryAffinity(id, recalled, remembered) + localRng() * 0.3,
    }));
    scored.sort((a, b) => b.fit - a.fit);

    const candidates = [];
    const used = new Set();
    let deferred = null; // dropped only for word-repeat; kept as last resort

    const emit = (frameId, slots, words) => {
      candidates.push({
        frame: frameId,
        slots,
        words,
        // Optional: the subject carried over from an earlier exchange. It is
        // deliberately NOT a slot — the LLM may weave it in or ignore it, and
        // with no memory the key is absent rather than filled with a
        // placeholder that would read as a remembered subject. Same for the
        // recall line: what was actually said before, for answers to build on.
        ...(remembered ? { carry: remembered } : {}),
        ...(recalled ? { recall: recalled } : {}),
        accent: accentBlock(),
        confidence: clamp01(
          0.5 +
            (frameFit(frameId, t, n) - 0.5) * 0.4 +
            moveAffinity(frameId, move, t) * 0.5 +
            scoreFit(slots, t) * 0.25 +
            localRng() * 0.05
        ),
        prosody: planProsody(t, n, e),
        disfluency: planDisfluency(t, n, e, localRng),
        hint: frameHint(frameId, move),
      });
      recentFrames.push(frameId);
      recentWords.push(Object.values(words).join("|"));
    };

    for (const { id: frameId } of scored) {
      if (candidates.length >= count) break;
      if (used.has(frameId)) continue;
      used.add(frameId);

      const slots = FRAMES[frameId];
      const words = {};
      let ok = true;
      for (const slot of slots) {
        const w = pickSlotWord(slot, move, t, n, localRng);
        if (w === null) { ok = false; break; }
        words[slot] = w;
      }
      if (!ok) continue;

      // Anti-repeat exact word combos — deferred rather than discarded, so a
      // small pool can never leave the agent with nothing to say.
      if (recentWords.includes(Object.values(words).join("|"))) {
        deferred ??= { frameId, slots, words };
        continue;
      }

      emit(frameId, slots, words);
    }

    if (candidates.length === 0 && deferred) {
      emit(deferred.frameId, deferred.slots, deferred.words);
    }

    // Always one fallback skeleton
    if (candidates.length === 0) {
      const frameId = move.speechAct === "question" ? "answer_bare" : "phatic";
      candidates.push({
        frame: frameId,
        slots: FRAMES[frameId],
        words: buildFallbackWords(frameId, t),
        ...(remembered ? { carry: remembered } : {}),
        ...(recalled ? { recall: recalled } : {}),
        accent: accentBlock(),
        confidence: 0.5,
        prosody: planProsody(t, n, e),
        disfluency: { filledPauses: 0, repetitions: 0, corrections: 0 },
        hint: frameHint(frameId, move),
      });
    }

    if (recentFrames.length > RECENT_MAX) recentFrames = recentFrames.slice(-RECENT_MAX);
    if (recentWords.length > RECENT_MAX) recentWords = recentWords.slice(-RECENT_MAX);

    return candidates;
  }

  /** Slot-level state gates, lifted so frame selection and slot filling agree. */
const FRAME_GATES = {
  comfort_ask: (t) => t.warm >= 0.45,     // `care` slot — won't ask if you're cold
  ack_followup: (t) => t.terse <= 0.75,    // `followup` slot
  statement_share: (t) => t.terse <= 0.75, // `followup` slot
  idk: (t) => t.uncertain >= 0.5,          // `idk_word` slot
};

function framesForAct(act, t) {
    const map = {
      greet: ["greet", "greet_alt"],
      farewell: ["farewell", "farewell_alt"],
      comfort: t.warm > 0.5 ? ["comfort_ask", "comfort_plain"] : ["comfort_plain", "comfort_ask"],
      question: t.uncertain > 0.65 ? ["idk", "answer_bare", "answer"] : ["answer", "answer_bare"],
      // Code artifacts are written from recall, not slots — but the frames
      // still carry confidence + recall, and answer frames get the recall
      // bonus in memoryAffinity, so the offered set stays anchored.
      code: ["answer", "answer_bare"],
      assert: t.warm > 0.6
        ? ["ack_followup", "statement_react", "ack_only", "statement_share"]
        : t.terse > 0.7
          ? ["ack_only", "statement_react", "phatic"]
          : ["statement_react", "ack_followup", "statement_share", "ack_only"],
      refuse: ["refuse", "brush"],
      command: ["refuse", "threat"],
      threat: ["threat"],
      flirt: ["flirt"],
      suggest: ["suggest"],
      inform: ["answer", "statement_react"],
      meta: ["statement_react"],
      distress: ["comfort_plain", "comfort_ask"],
    };
    let frames = map[act] || map.assert;
    // Uncertainty: hedge variants fit statements; "I don't know" only ever
    // answers a question — never a greeting, comfort, or good news.
    if (t.uncertain > 0.6 && ["assert", "inform", "meta", "suggest"].includes(act)) {
      frames = ["uncertain", ...frames];
    }
    if (t.uncertain > 0.7 && ["question", "inform"].includes(act)) {
      frames = ["idk", ...frames];
    }
    // Offer only frames whose slots can actually be FILLED in this state.
    // pickSlotWord vetoes `care` when cold, `followup` when terse and
    // `idk_word` when certain — but nothing stopped framesForAct from
    // offering them, so a cold agent got comfort_ask, the slot failed, and
    // the one frame that could fill was already anti-repeated away: every
    // later turn collapsed to the lone phatic fallback. Same rules, one place.
    const fillable = frames.filter((id) => !FRAME_GATES[id] || FRAME_GATES[id](t));
    return fillable.length ? fillable : frames;
  }

  /**
   * How well a frame answers THIS specific message (as opposed to the state).
   * Positive news → acknowledge and ask back. Bad news → steady them.
   * A question → answer it (or admit you don't know).
   */
  function moveAffinity(frameId, move, t) {
    const valence = move?.content?.valence ?? 0;
    let a = 0;

    if (valence > 0.2) {
      if (frameId === "ack_followup") a += 0.5;
      else if (frameId === "statement_share") a += 0.45;
      else if (frameId === "ack_only") a += 0.35;
      else if (frameId === "statement_react") a += 0.15;
      if (frameId === "idk" || frameId === "uncertain") a -= 0.45;
      if (frameId === "comfort_plain" || frameId === "comfort_ask") a -= 0.3;
    } else if (valence < -0.2) {
      if (frameId === "comfort_plain" || frameId === "comfort_ask") a += 0.5;
      else if (frameId === "ack_only" || frameId === "ack_followup") a += 0.2;
      if (frameId === "idk") a -= 0.3;
      if (frameId === "flirt") a -= 0.5;
    }

    const act = move?.speechAct;
    if (act === "question") {
      if (frameId === "answer" || frameId === "answer_bare") a += 0.5;
      if (frameId === "idk") a += t.uncertain > 0.7 ? 0.45 : -0.4;
      if (frameId === "ack_followup" || frameId === "statement_share") a -= 0.3;
    }
    if (act === "greet" && frameId === "greet") a += 0.6;
    if (act === "farewell" && frameId === "farewell") a += 0.6;
    if (act === "comfort" && (frameId === "comfort_plain" || frameId === "comfort_ask")) a += 0.6;
    if (act === "refuse" && (frameId === "refuse" || frameId === "brush")) a += 0.6;

    return a;
  }

  /**
   * Frames that can USE a memory outrank bare ones when one exists.
   * Without this, `answer_bare` ("no") and `ack_only` score identically to
   * frames with follow-ups and asides, so the model picks the shrug and a
   * question gets a one-word district count. Recall answers questions;
   * carry-over feeds follow-ups and shared asides.
   */
  function memoryAffinity(frameId, recalled, remembered) {
    let a = 0;
    if (recalled) {
      if (frameId === "answer" || frameId === "answer_bare") a += 0.35;
      else if (frameId === "ack_followup" || frameId === "statement_share") a += 0.25;
      else if (frameId === "question_back") a += 0.15;
    } else if (remembered) {
      if (frameId === "ack_followup" || frameId === "statement_share") a += 0.2;
    }
    return a;
  }

  function frameFit(frameId, t, n) {
    let fit = 0.5;
    if (frameId === "ack_followup" && t.warm > 0.55) fit += 0.3;
    if (frameId === "statement_share" && t.warm > 0.6) fit += 0.25;
    if (frameId === "phatic" && t.terse > 0.65) fit += 0.3;
    if (frameId === "ack_only" && t.terse > 0.6) fit += 0.25;
    if (frameId === "uncertain" && t.uncertain > 0.65) fit += 0.35;
    if (frameId === "idk" && t.uncertain > 0.75) fit += 0.4;
    if (frameId === "threat" && t.dominant > 0.7) fit += 0.3;
    if (frameId === "refuse" && t.dominant > 0.6) fit += 0.2;
    if (frameId === "comfort_ask" && t.warm > 0.65) fit += 0.3;
    if (frameId === "flirt" && (n.oxytocin ?? 0) > 0.5) fit += 0.3;
    if (frameId === "question_back" && t.dominant > 0.65) fit += 0.15;
    return fit;
  }

  function scoreFit(slots, t) {
    let s = 0;
    if (slots.includes("followup") && t.warm > 0.55) s += 0.3;
    if (slots.includes("hedge") && t.uncertain > 0.6) s += 0.3;
    if (slots.includes("idk_word") && t.uncertain > 0.7) s += 0.3;
    if (slots.includes("soften") && t.warm > 0.6) s += 0.25;
    if (slots.includes("dismissal") && t.guarded > 0.65) s += 0.2;
    return s;
  }

  /**
   * Subject carried over from an earlier exchange, reduced to one short word
   * ("i got the job at militech" -> "militech").
   *
   * Three sources, most-authoritative first:
   *   ctx.remembered     — the caller passes the literal previous line
   *   move.content.text  — the episodic cue converse already fetched
   *   memoryRef          — the store itself, so the engine works standalone
   *
   * Returns null when nothing was remembered — and the caller then simply
   * omits `carry`. There is no generic placeholder: an invented subject would
   * read as a real one.
   */
  const TOPIC_STOP = new Set([
    "the", "and", "for", "you", "your", "that", "this", "with", "from", "have", "has", "had",
    "was", "were", "are", "not", "but", "all", "out", "get", "got", "its", "she", "him", "her",
    "his", "them", "they", "what", "when", "where", "which", "while", "would", "could", "should",
    "will", "just", "like", "about", "into", "over", "than", "then", "too", "very", "can",
    "been", "being", "does", "did", "why", "how", "who", "our", "ours", "mine", "me", "my",
    "i", "a", "an", "is", "in", "on", "at", "to", "of", "we", "us", "it", "so", "up", "down",
    "now", "still", "here", "there", "one", "two", "back", "said", "tell", "asked", "told",
    // degree / time / generic — never the subject of a conversation
    "really", "much", "more", "most", "best", "worst", "great", "good", "bad", "nice", "huge",
    "whole", "own", "last", "next", "other", "another", "same", "different", "tonight",
    "morning", "evening", "afternoon", "yesterday", "today", "tomorrow", "never", "always",
    "ever", "maybe", "something", "anything", "everything", "things",
    // greetings and filler — naming them back is noise, not a remembered subject
    "hey", "hi", "yo", "hello", "sup", "please", "thanks", "thank", "ok", "okay",
    "yeah", "yep", "nah", "nope", "dude", "man", "bro",
  ]);

  /**
   * The persona's own name must never come back as a subject. A greeting like
   * "hey johnny" is the listener hailing them; carrying that name back would
   * put their own name in front of the model as a word to weave in.
   */
  function personaNames() {
    const full = String(voice?.name || "").toLowerCase().trim();
    if (!full) return null;
    const set = new Set([full]);
    for (const part of full.split(/\s+/)) if (part) set.add(part);
    return set;
  }

  function rememberTopic(text) {
    const banned = personaNames();
    const cleaned = String(text || "")
      // Exchange episodes carry both sides (`you said: X || you replied: Y`)
      // — the topic is what THEY said, never the agent's own wording.
      .split(/\s*\|\|\s*/)[0]
      .replace(/^\s*you said:\s*/i, "")
      .replace(/["“”]/g, "");
    const words = cleaned
      .toLowerCase()
      .replace(/[^a-z\s']/g, " ")
      .split(/\s+/)
      .filter(
        (w) =>
          w.length >= 3 &&
          !TOPIC_STOP.has(w.replace(/'s$/, "")) &&
          !(banned && banned.has(w.replace(/'s$/, "")))
      );
    if (words.length === 0) return null;
    // Longest content word: "job at militech" -> militech, not "at".
    return words.reduce((a, b) => (b.length > a.length ? b : a));
  }

  function rememberedTopic(move, ctx) {
    const explicit = rememberTopic(ctx.remembered);
    if (explicit) return explicit;
    const viaCue = rememberTopic(move?.content?.text);
    if (viaCue) return viaCue;
    if (memoryRef && ctx.userText) {
      const hit = memoryRef.retrieveEpisodic({ content: ctx.userText }, { limit: 1, minActivation: -5 });
      if (hit.length) return rememberTopic(hit[0].content);
    }
    return null;
  }

  /**
   * A short quote of something said BEFORE this turn — the recall half of
   * item 3. The topic word tells the model WHAT is still in play; the recall
   * tells it WHAT WAS ACTUALLY SAID, so an answer has material beyond the
   * static slot pools ("yeah" / "no" / "Six districts" emitted verbatim is
   * how "wanna fuck?" got answered with a district count).
   *
   * Guards: skips the current line itself (it is already stored as an
   * episode by the time candidates generate, both raw and `you said:`-prefixed,
   * so equality is tested both ways), skips substance-free hits, caps at 10
   * words so a quote can never trip the 8-word echo-run rule on its own.
   * The validator stays the backstop: if the model quotes instead of
   * rewording, the echo rule rejects and repair tells it to reword.
   */
  function recallLine(move, ctx) {
    if (!memoryRef || !ctx.userText) return null;
    const cur = String(ctx.userText).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const hits = memoryRef.retrieveEpisodic({ content: ctx.userText }, { limit: 3, minActivation: -5 });
    for (const hit of hits) {
      const cleaned = String(hit.content || "")
        .split(/\s*\|\|\s*/)[0] // user side only — see rememberTopic
        .replace(/^\s*you said:\s*/i, "")
        .replace(/["“”]/g, "")
        .trim();
      if (!cleaned) continue;
      const norm = cleaned.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      if (!norm || norm === cur || cur.includes(norm)) continue; // the current line, not a memory
      const words = cleaned.split(/\s+/);
      if (words.length < 4) continue; // no substance to recall
      return words.slice(0, 10).join(" ");
    }
    return null;
  }

  /** Pick ONE word for a slot — state + SOUL accent filtered. */
  function pickSlotWord(slot, move, t, n, localRng) {
    // Try accent-specific pools first (dialect phrases), then base pools
    const dialectPhrases = accent.phrases || {};

    // Map slot → dialect phrase key
    const dialectKey = {
      exclam: "exclaim",
      greeting: "greet",
      parting: "part",
      refusal: "cold",
      dismissal: "cold",
      soften: t.warm > 0.5 ? "warm" : "cold",
      // NOTE: no idk_word here — dialect "fragment" pools carry affirmatives
      // ("of course", "figures"), which would contradict "I don't know".
      ack: null, // handled below with stance
    }[slot];

    // Dialect word injection: slang density gates whether dialect words appear
    const allowDialect = localRng() < voice.slang * 0.6;

    if (slot === "ack") {
      const stance = move.content?.valence > 0.2 ? "pos" : move.content?.valence < -0.2 ? "neg" : "neu";
      const pool = poolFor(SLOT_POOLS.ack[stance]);
      if (allowDialect && dialectPhrases[stance === "pos" ? "ack_good" : "neg" ? "ack_bad" : "agree"]) {
        const dp = dialectPhrases[stance === "pos" ? "ack_good" : "neg" ? "ack_bad" : "agree"];
        return weightedPick(localRng, [...pool, ...dp], [...pool.map(() => 1), ...dp.map(() => 1.2)]);
      }
      return pick(pool, localRng);
    }

    if (allowDialect && dialectKey && dialectPhrases[dialectKey]?.length) {
      const dp = dialectPhrases[dialectKey];
      return pick(dp, localRng);
    }

    // Era-filtered slang injection. accent.dialectWords is already year-gated
    // (coined <= era < dies), so a 2077 persona can say "preem" but never
    // "bussin" or "sick" — those are in datedWords/unreachedWords instead.
    //
    // Only slots that are a complete thought on their own take a bare slang
    // word. Slots needing a grammatical lead-in ("Look", "Honestly") never do
    // — otherwise you get "Cringe. Six districts."
    const SLANG_SLOTS = new Set(["opinion", "filler", "stance"]);
    if (allowDialect && SLANG_SLOTS.has(slot) && accent.bareWords?.length) {
      const w = pick(accent.bareWords, localRng);
      if (w) return w;
    }

    // Base pool with state selection
    const p = SLOT_POOLS[slot];
    if (p === undefined) return null;

    if (p && typeof p === "object" && !Array.isArray(p)) {
      // State-keyed sub-pool
      const level = stateLevel(slot, t, n);
      const pool = poolFor(p[level]);
      if (!pool || pool.length === 0) return null;
      // Swearing filter: low-formality pools contain swears — voice gates them
      const filtered = voice.swearing < 0.3
        ? pool.filter((w) => !/fuck|shit|damn|hell/i.test(w))
        : pool;
      return pick(filtered.length ? filtered : pool, localRng);
    }

    const pool = poolFor(p);
    if (!pool || pool.length === 0) return null;

    // Followup frame slot: terse states drop it (caller should not use this frame)
    if (slot === "followup" && t.terse > 0.75) return null;
    if (slot === "care" && t.warm < 0.45) return null;
    if (slot === "idk_word" && t.uncertain < 0.5) return null;

    return pick(pool, localRng);
  }

  function stateLevel(slot, t, n) {
    if (slot === "exclam") {
      const da = n.dopamine ?? 0.5;
      return da > 0.65 ? "high" : da > 0.45 ? "mid" : "low";
    }
    if (slot === "state_word" || slot === "state_detail") {
      const e = energyRef ? energyRef.getState() : {};
      if ((e.atp ?? 1) < 0.4 || (e.sleepPressure ?? 0) > 0.7) return "low";
      if ((n.dopamine ?? 0.5) > 0.65) return "high";
      return "mid";
    }
    if (slot === "hedge") return t.uncertain > 0.75 ? "high" : "low";
    return "mid";
  }

  function poolFor(p) {
    if (!p) return [];
    if (Array.isArray(p)) return p;
    if (typeof p === "object") return p.mid || p.low || p.high || Object.values(p)[0] || [];
    return [p];
  }

  function pick(arr, localRng) {
    if (!arr || arr.length === 0) return null;
    return arr[Math.floor(localRng() * arr.length)];
  }

  function buildFallbackWords(frameId, t) {
    const slots = FRAMES[frameId];
    const words = {};
    for (const slot of slots) {
      const pool = poolFor(SLOT_POOLS[slot]);
      words[slot] = pick(pool, mulberry32(7)) ?? "…";
    }
    return words;
  }

  function frameHint(frameId, move) {
    const hints = {
      greet: "greet back in their register",
      greet_alt: "greet them, then land one line of small talk",
      farewell: "part — warm or curt per state",
      farewell_alt: "part, then one last line of small talk",
      ack_only: "acknowledge their line, that's it",
      ack_followup: "acknowledge, then ask back about what they said",
      comfort_plain: "steady them, one line, no new subjects",
      comfort_ask: "steady them, then ask how they're holding up",
      answer: "answer what they asked directly, plainly",
      answer_bare: "give the answer, nothing extra",
      statement_react: "react to what they said as yourself",
      statement_share: "react, add one thing from your own life, ask back",
      self_state: "say your state first person — match STATE",
      refuse: "refuse flat, no essay",
      brush: "brush it off dry, unbothered",
      suggest: "one concrete option",
      phatic: "small talk, answer the phatic, don't lecture",
      uncertain: "say it with hedging — you're not sure",
      idk: "you don't know it: say so plainly, don't invent",
      threat: "short and mean it",
      flirt: "flirt back in your register",
      question_back: "turn it back at them as a question",
    };
    const base = hints[frameId] || "reply naturally to what they said";
    return base;
  }

  // ==================== PROSODY / DISFLUENCY ====================

  function planProsody(t, n, e) {
    const da = n.dopamine ?? 0.5;
    const ne = n.norepinephrine ?? 0.5;
    const cort = e.cortisolLevel ?? 0.5;
    const ht = n.serotonin ?? 0.5;

    return {
      rate: t.impulsive > 0.7 || ne > 0.7 ? "fast" : t.deliberate > 0.7 || (e.sleepPressure ?? 0) > 0.6 ? "slow" : "normal",
      pitch: cort > 0.65 || ne > 0.7 ? "high-var" : ht > 0.65 ? "low-flat" : "normal",
      pauseAfter: t.uncertain > 0.65 || t.terse > 0.7 ? "long" : t.impulsive > 0.7 ? "short" : "normal",
      intensity: da > 0.7 ? "strong" : (e.atp ?? 1) < 0.4 ? "weak" : "normal",
      f0Hz: 110 + Math.round(da * 40 - cort * 15),
    };
  }

  function planDisfluency(t, n, e, localRng) {
    const ne = n.norepinephrine ?? 0.5;
    const da = n.dopamine ?? 0.5;
    const cort = e.cortisolLevel ?? 0.5;
    const pressure = e.sleepPressure ?? 0;

    const filledPauseRate = clamp01(((ne - 0.5) * 0.4 + (1 - da) * 0.3 + (pressure > 0.7 ? 0.3 : 0)) * (0.5 + voice.disfluency));
    const repetitionRate = clamp01(cort * 0.3 + (pressure > 0.6 ? 0.2 : 0));
    const correctionRate = clamp01(t.uncertain * 0.3 + (1 - da) * 0.2);

    return {
      filledPauses: localRng() < filledPauseRate ? 1 : 0,
      repetitions: localRng() < repetitionRate ? 1 : 0,
      corrections: localRng() < correctionRate ? 1 : 0,
      plan: { filledPauseRate, repetitionRate, correctionRate },
    };
  }

  /**
   * Render a skeleton into rough text — OFFLINE FALLBACK ONLY.
   *
   * The LLM normally fills the frame into real speech; this just glues the
   * slot words together with enough punctuation to be readable, so the
   * candidate path still produces something sayable with no engine.
   */
  function renderSkeleton(cand) {
    const parts = cand.slots.map((s) => cand.words[s]).filter(Boolean);
    if (parts.length === 0) return "…";

    // Slots that already end a thought — keep their own punctuation.
    const TERMINAL = /^(answer|followup|care|condition|back|idk_word|refusal|dismissal|turn_take)$/;
    let text = "";
    for (const slot of cand.slots) {
      const w = cand.words[slot];
      if (!w) continue;
      if (!text) {
        text = w;
      } else if (TERMINAL.test(slot)) {
        text = /[.!?]$/.test(text) ? `${text} ${w}` : `${text}. ${w}`;
      } else {
        text = /[.!?,]$/.test(text) ? `${text} ${w}` : `${text}, ${w}`;
      }
    }
    text = text.charAt(0).toUpperCase() + text.slice(1);
    if (!/[.!?…]$/.test(text)) text += ".";
    return text;
  }

  function applyDisfluency(cand) {
    let text = typeof cand === "string" ? cand : renderSkeleton(cand);
    const d = typeof cand === "string" ? {} : cand.disfluency || {};
    if (d.filledPauses > 0) {
      const words = text.split(" ");
      words.splice(Math.min(2, words.length - 1), 0, "uh");
      text = words.join(" ");
    }
    if (d.corrections > 0) {
      const words = text.split(" ");
      if (words.length > 2) words.splice(1, 0, "I mean");
      text = words.join(" ");
    }
    return text;
  }

  function exportTrainingLog() {
    return recentFrames.map((f) => ({ frame: f }));
  }

  /**
   * Diary chapters: `##`-headed sections appended to the SOUL prose AFTER
   * the identity body. The `# Title` line is identity, never diary. Capped
   * from the TAIL so the newest chapters survive as the book grows; empty
   * string when the soul keeps no diary (old souls stay byte-identical).
   */
  function diary(maxChars = 800) {
    // Identity-first budgets: manual backstory and auto-chapters split the
    // cap 60/40, so a growing auto-memory region can never crowd the
    // authored past out of context (the dilution worry). Without markers
    // everything counts as manual and behavior is unchanged.
    const manual = [];
    const auto = [];
    let inAuto = false;
    for (const l of String(voice.prose || "").split("\n")) {
      if (/auto-memories:start/.test(l)) { inAuto = true; continue; }
      if (/auto-memories:end/.test(l)) { inAuto = false; continue; }
      (inAuto ? auto : manual).push(l);
    }
    const collect = (text) => {
      const sections = [];
      for (const part of text.split(/^##\s+/m).slice(1)) {
        const nl = part.indexOf("\n");
        const title = (nl < 0 ? part : part.slice(0, nl)).trim();
        const t = (nl < 0 ? "" : part.slice(nl + 1)).trim();
        if (t) sections.push(`${title}: ${t}`);
      }
      return sections;
    };
    const mSecs = collect(manual.join("\n"));
    const aSecs = collect(auto.join("\n"));
    // One-sided souls keep the old exact behavior (full budget, tail-capped).
    if (!aSecs.length) return mSecs.join("\n").slice(-maxChars);
    if (!mSecs.length) return aSecs.join("\n").slice(-maxChars);
    const mBudget = Math.ceil(maxChars * 0.6);
    const mOut = mSecs.join("\n").slice(-mBudget);
    const aOut = aSecs.join("\n").slice(-(maxChars - mBudget));
    return [mOut, aOut].filter(Boolean).join("\n");
  }

  function clearRecent() {
    recentFrames = [];
    recentWords = [];
  }

  function toJSON() {
    return { recentFrames, recentWords, voice };
  }

  function fromJSON(data) {
    if (!data) return;
    recentFrames = data.recentFrames || [];
    recentWords = data.recentWords || [];
    if (data.voice) voice = { ...voice, ...data.voice };
  }

  return {
    FRAMES,
    SLOT_POOLS,
    setRefs,
    setSoul,
    setDialectPack,
    setEra,
    get era() { return era; },
    actionTendencies,
    stateNarrative,
    behavioralGuidance,
    generateCandidates,
    renderSkeleton,
    applyDisfluency,
    planProsody,
    planDisfluency,
    clearRecent,
    diary,
    toJSON,
    fromJSON,
    get voice() { return voice; },
    get accent() { return accent; },
  };
}