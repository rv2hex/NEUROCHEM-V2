/**
 * SOUL parser — voice profile from SOUL.md / SOUL.txt.
 *
 * The SOUL file IS the accent: dialect, slang density, formality, warmth,
 * verbosity, swearing, cadence. Change the SOUL → candidates change accent.
 *
 * Format:
 *   ---
 *   name: Chole
 *   speech.dialect: night-city
 *   speech.slang: 0.75
 *   speech.formality: 0.25
 *   speech.warmth: 0.55
 *   traits.openness: 0.8
 *   likes: rain, chrome, chooms        — topics that RAISE this soul's energy
 *   dislikes: corpo, trauma team       — topics that COST it
 *   ---
 *   Freeform prose: who they are. First-person lines are used as accent samples.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VOICE_DEFAULTS = {
  name: "stranger",
  dialect: "night-city",
  slang: 0.5,
  formality: 0.3,
  warmth: 0.5,
  verbosity: 0.5,
  swearing: 0.4,
  hedging: 0.3,
  disfluency: 0.3,
  warmthLabel: "even",
  prose: "",
  sample: "",        // a first-person line from the SOUL prose (accent exemplar)
  // Topic preferences — things THIS soul cares about. Matching input raises
  // or spends energy, so personality changes metabolism, not just wording.
  likes: [],
  dislikes: [],
};

/**
 * Parse a SOUL file into a voice profile.
 * @param {string} root project root (looks for SOUL.md / SOUL.txt)
 * @param {string|null} explicitPath
 * @returns {object} voice profile
 */
export function loadSoul(root, explicitPath = null) {
  const candidates = explicitPath
    ? [explicitPath]
    : [join(root, "SOUL.md"), join(root, "SOUL.txt"), join(root, "src", "personality", "SOUL.md")];

  let raw = null;
  let source = "baseline";
  for (const p of candidates) {
    if (existsSync(p)) {
      raw = readFileSync(p, "utf8");
      source = p;
      break;
    }
  }
  if (raw === null && explicitPath) throw new Error(`SOUL file not found: ${explicitPath}`);
  if (raw === null) return { ...VOICE_DEFAULTS, likes: [], dislikes: [], source };

  return parseSoulText(raw, source);
}

export function parseSoulText(raw, source = "inline") {
  // Fresh arrays: `{...VOICE_DEFAULTS}` shares VOICE_DEFAULTS' arrays, and
  // pushing a like onto them would leak across every soul loaded later.
  const voice = { ...VOICE_DEFAULTS, likes: [], dislikes: [], source };

  let body = raw;
  // Frontmatter
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^([\w.]+):\s*(.+)$/);
      if (!m) continue;
      const key = m[1].trim();
      let val = m[2].trim();
      const num = Number(val);
      if (key === "name") voice.name = val;
      else if (key === "speech.dialect") voice.dialect = val;
      else if (key === "speech.slang") voice.slang = clamp01(num);
      else if (key === "speech.formality") voice.formality = clamp01(num);
      else if (key === "speech.warmth") voice.warmth = clamp01(num);
      else if (key === "speech.verbosity") voice.verbosity = clamp01(num);
      else if (key === "speech.hedging") voice.hedging = clamp01(num);
      else if (key === "speech.disfluency") voice.disfluency = clamp01(num);
      else if (key === "speech.swearing") voice.swearing = clamp01(num);
      else if (key === "speech.swear") voice.swearing = clamp01(num);
      else if (key === "likes" || key === "dislikes") {
        // `likes: night rain, chrome` — comma-separated, quotes optional.
        for (const term of splitTerms(val)) {
          if (!voice[key].includes(term)) voice[key].push(term);
        }
      }
    }
  }

  voice.prose = body.trim();

  // Accent sample: first first-person sentence from the prose
  voice.sample = firstPersonLine(voice.prose) || "";

  // Warmth label for prompt-facing use
  voice.warmthLabel = voice.warmth > 0.65 ? "open and warm" : voice.warmth > 0.4 ? "warm underneath" : "cold, guarded";

  return voice;
}

function firstPersonLine(prose) {
  if (!prose) return "";
  // Split into sentences, find one starting with "I "
  const sentences = prose.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  const first = sentences.find((s) => /^I\s/i.test(s));
  if (first) return first.trim();
  // Fallback: any substantive sentence (≤140 chars)
  const alt = sentences.find((s) => s.length > 20 && s.length <= 140);
  return alt ? alt.trim() : sentences[0]?.trim() || "";
}

/** `"night rain", chrome` → ["night rain", "chrome"] */
function splitTerms(value) {
  return String(value)
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}

/**
 * Does this line of input touch something the SOUL cares about?
 *
 * Word-boundary match, so "night" doesn't fire on "tonight" and "rain"
 * doesn't fire on "brain". Returns the matched terms so the caller can
 * charge or refund energy; null when the soul is indifferent.
 *
 * A dislike is reported alongside a like so the caller can let aversion win
 * — being talked at about something you hate should not also feel good.
 *
 * @param {object} voice  SOUL profile (likes / dislikes)
 * @param {string} text   incoming stimulus
 * @returns {{liked: string|null, disliked: string|null}|null}
 */
export function matchPreferences(voice, text) {
  const hay = String(text || "").toLowerCase();
  if (!hay) return null;

  const hit = (list) => {
    for (const term of list || []) {
      const t = String(term).toLowerCase();
      if (!t) continue;
      const idx = hay.indexOf(t);
      if (idx < 0) continue;
      const before = hay[idx - 1];
      const after = hay[idx + t.length];
      const leftOk = idx === 0 || /[^a-z0-9]/.test(before);
      const rightOk = idx + t.length >= hay.length || /[^a-z0-9]/.test(after);
      if (leftOk && rightOk) return term;
    }
    return null;
  };

  const liked = hit(voice?.likes);
  const disliked = hit(voice?.dislikes);
  if (!liked && !disliked) return null;
  return { liked, disliked };
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0.5;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ==================== SOUL MEMORIES (lived life, travels with the file) ====================
// Everything outside the owned markers is the author's hand-written prose and
// is never touched: the writer only replaces the fenced region, so deleting
// the block gives her amnesia and hand edits elsewhere always survive.
// Chapters use the same `## Title` shape as diary entries, so the existing
// diary() reader surfaces them with no changes on the read path.

export const SOUL_MEMORY_START = "<!-- auto-memories:start -->";
export const SOUL_MEMORY_END = "<!-- auto-memories:end -->";

/** Total chars of auto-chapters kept — newest survive, oldest rotate out. */
export const SOUL_MEMORY_BUDGET = 3000;

/** Parse the owned region into [{ title, text }]. Empty when absent. */
export function readSoulMemories(raw) {
  const text = String(raw || "");
  const si = text.indexOf(SOUL_MEMORY_START);
  const ei = text.indexOf(SOUL_MEMORY_END);
  if (si < 0 || ei < 0 || ei < si) return [];
  const body = text.slice(si + SOUL_MEMORY_START.length, ei);
  const out = [];
  for (const part of body.split(/^##\s+/m).slice(1)) {
    const nl = part.indexOf("\n");
    const title = (nl < 0 ? part : part.slice(0, nl)).trim();
    const entry = (nl < 0 ? "" : part.slice(nl + 1)).trim();
    if (title && entry) out.push({ title, text: entry });
  }
  return out;
}

/**
 * Replace the owned region with `entries` ([{ title, text }]), creating it
 * at end-of-file when missing. Same title updates in place (no duplicates);
 * the whole region is capped at SOUL_MEMORY_BUDGET chars, oldest first out
 * (at least the newest entry always survives).
 */
export function writeSoulMemories(raw, entries) {
  const text = String(raw || "");
  const kept = enforceSoulBudget(entries);
  const block = [SOUL_MEMORY_START, ...kept.flatMap((e) => [`## ${e.title}`, e.text]), SOUL_MEMORY_END].join("\n");
  const si = text.indexOf(SOUL_MEMORY_START);
  const ei = text.indexOf(SOUL_MEMORY_END);
  if (si >= 0 && ei > si) {
    return text.slice(0, si) + block + text.slice(ei + SOUL_MEMORY_END.length);
  }
  const trimmed = text.replace(/\s+$/, "");
  return `${trimmed}\n\n${block}\n`;
}

/** Upsert one entry by title into raw soul text. */
export function upsertSoulMemory(raw, title, entryText) {
  const cleanTitle = String(title || "").trim().slice(0, 60) || "Noted";
  const cleanText = String(entryText || "").trim().slice(0, 400);
  if (!cleanText) return String(raw || "");
  const entries = readSoulMemories(raw).filter((e) => e.title !== cleanTitle);
  entries.push({ title: cleanTitle, text: cleanText });
  return writeSoulMemories(raw, entries);
}

function enforceSoulBudget(entries) {
  const size = (list) => list.reduce((n, e) => n + e.title.length + e.text.length + 4, 0);
  const list = [...entries];
  while (list.length > 1 && size(list) > SOUL_MEMORY_BUDGET) {
    list.shift(); // oldest first out
  }
  return list.slice(-50); // hard cap on chapter count regardless of size
}

/**
 * Accent pack: dialect lexicon from config/slang.json filtered/scaled by voice.
 * The returned structure is what the PhraseEngine picks slot-words from.
 *
 * @param {object} voice   SOUL profile
 * @param {object} dialectPack  one entry from slang.json dialects
 * @param {number|null} era  calendar year — words are age-gated:
 *   coined > era  → not yet invented (unavailable)
 *   dies  <= era  → dead slang (unavailable, or "old-timer" register)
 */
export function buildAccentPack(voice, dialectPack, era = null) {
  const allWords = dialectPack?.words || [];
  const phrases = dialectPack?.phrases || {};
  const year = Number.isFinite(era) ? era : null;

  const isLive = (w) =>
    year === null ||
    ((w.coined == null || w.coined <= year) && (w.dies == null || year < w.dies));

  const live = allWords.filter(isLive);
  const dead = year === null ? [] : allWords.filter((w) => w.coined != null && w.dies != null && w.dies <= year);
  const future = year === null ? [] : allWords.filter((w) => w.coined != null && w.coined > year);

  // Slang density: how many dialect words a candidate may carry
  const density =
    voice.slang >= 0.7 ? "freely" :
    voice.slang >= 0.4 ? "sometimes" : "rarely";

  return {
    name: voice.name,
    dialectKey: voice.dialect,
    dialect: dialectPack?.label || voice.dialect,
    density,
    era: year,
    slang: voice.slang,
    formality: voice.formality,
    warmth: voice.warmth,
    swearing: voice.swearing,
    verbosity: voice.verbosity,
    cadence: dialectPack?.cadence || "natural spoken register",
    sample: voice.sample || dialectPack?.sample || "",
    dialectWords: live.map((w) => w.word),
    dialectGlosses: Object.fromEntries(live.map((w) => [w.word, w.gloss])),
    // Subset that reads as a whole utterance ("preem.", "no cap.") — safe to
    // drop into a bare slot. Nouns like "eddies"/"chrome" are not.
    bareWords: live.filter((w) => w.bare === true).map((w) => w.word),
    // Words that exist in the pack but are out of era — usable deliberately
    // as "old-timer" register, never by default.
    datedWords: dead.map((w) => w.word),
    unreachedWords: future.map((w) => w.word),
    phrases,
    nostalgiaPhrases: dialectPack?.nostalgia || [],
  };
}