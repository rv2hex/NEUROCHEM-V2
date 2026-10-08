#!/usr/bin/env node
/**
 * Soul maker — interactive wizard that writes a complete SOUL.md the agent
 * understands: voice frontmatter, accent-tied dialect, backstory, family and
 * friends as ## chapters, likes/dislikes (metabolism hooks), an optional
 * opening diary seed, and a baseline chapter for starting state.
 *
 *   npm run soul                  → walk the questions, write ./SOUL.new.md
 *   npm run soul -- --out path    → write somewhere else
 *   npm run soul -- --force       → allow overwriting an existing file
 *
 * The pure buildSoulMarkdown() below is what the tests pin: every field it
 * emits round-trips through parseSoulText() and builds a working accent
 * pack, so a generated soul is guaranteed agent-legible.
 */

import readline from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSoulText, buildAccentPack } from "../personality/soul.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadDialects() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "config", "slang.json"), "utf8")).dialects || {};
  } catch {
    return {};
  }
}

const clamp01 = (v, fb) => {
  const n = Number(v);
  if (v === "" || v === undefined || !Number.isFinite(n)) return fb;
  return Math.min(1, Math.max(0, n));
};

const splitList = (s) =>
  String(s || "")
    .split(",")
    .map((x) => x.trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);

/**
 * Render a complete SOUL.md from answers. Unknown dialects fall back to the
 * pack default (reported in `warnings`); every number is clamped.
 */
export function buildSoulMarkdown(a = {}) {
  const warnings = [];
  const dialects = a.dialects || loadDialects();
  const keys = Object.keys(dialects);
  let dialect = String(a.dialect || "night-city").trim();
  if (!dialects[dialect]) {
    warnings.push(`unknown dialect "${dialect}" — falling back to "${dialects ? keys[0] : "night-city"}"`);
    dialect = keys[0] || "night-city";
  }
  const num = (v, fb) => clamp01(v, fb);
  const name = String(a.name || "").trim() || "Vex";
  const likes = [...new Set(splitList(a.likes))];
  const dislikes = [...new Set(splitList(a.dislikes))];
  const people = (a.people || []).filter((p) => p && p.name);

  const fm = [
    "---",
    `name: ${name}`,
    `speech.dialect: ${dialect}`,
    `speech.slang: ${num(a.slang, 0.6)}`,
    `speech.formality: ${num(a.formality, 0.3)}`,
    `speech.warmth: ${num(a.warmth, 0.55)}`,
    `speech.verbosity: ${num(a.verbosity, 0.5)}`,
    `speech.hedging: ${num(a.hedging, 0.25)}`,
    `speech.disfluency: ${num(a.disfluency, 0.35)}`,
    `speech.swearing: ${num(a.swearing, 0.5)}`,
    `traits.openness: ${num(a.openness, 0.6)}`,
    `traits.extraversion: ${num(a.extraversion, 0.55)}`,
    `traits.conscientiousness: ${num(a.conscientiousness, 0.5)}`,
    `traits.agreeableness: ${num(a.agreeableness, 0.45)}`,
    `traits.neuroticism: ${num(a.neuroticism, 0.5)}`,
    ...(likes.length ? [`likes: ${likes.join(", ")}`] : []),
    ...(dislikes.length ? [`dislikes: ${dislikes.join(", ")}`] : []),
    "---",
  ];

  const body = [`# ${name}`, "", String(a.backstory || "New in Night City. Still deciding who to be.").trim(), ""];
  if (a.baseline) body.push("## Baseline", "", String(a.baseline).trim(), "");
  for (const p of people) {
    body.push(`## ${String(p.name).trim()}`, "", String(p.note || "Someone from before.").trim(), "");
  }
  if (a.diarySeed) body.push("## First entry", "", String(a.diarySeed).trim(), "");

  return { markdown: fm.join("\n") + "\n\n" + body.join("\n").trimEnd() + "\n", warnings, dialect };
}

/** Prove the generated soul is agent-legible: parses + builds an accent. */
export function validateSoul(markdown, dialects) {
  const voice = parseSoulText(markdown, "generated");
  const pack = dialects[voice.dialect] || dialects[Object.keys(dialects)[0]];
  const accent = buildAccentPack(voice, pack);
  return { voice, accent };
}

// ==================== interactive wizard ====================
// readline is created inside main(), never at import: this module is also
// imported by the test suite, and a top-level stdin handle would hold the
// event loop open forever after the run.

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // rl.question() stalls on piped stdin after the first answer (the input
  // stream ends beneath it), so prompt over the `line` event with a queue —
  // the same pattern src/cli/chat.js uses. EOF yields defaults for the rest.
  const lineQueue = [];
  let eof = false;
  rl.on("line", (line) => lineQueue.push(line));
  rl.on("close", () => { eof = true; });
  const ask = (q, def) =>
    new Promise((resolve) => {
      const hint = def !== undefined && def !== "" ? ` [${def}]` : "";
      process.stdout.write(`${q}${hint}: `);
      const poll = () => {
        if (lineQueue.length) {
          const a = lineQueue.shift().trim();
          resolve(a === "" ? def : a);
        } else if (eof) {
          resolve(def);
        } else {
          setImmediate(poll);
        }
      };
      poll();
    });
  const args = process.argv.slice(2);
  const outArg = args[args.indexOf("--out") + 1];
  const force = args.includes("--force");
  const dialects = loadDialects();
  const keys = Object.keys(dialects);

  console.log("SOUL MAKER — answer, empty accepts the default in [brackets].");
  console.log(`Dialects that exist: ${keys.map((k) => `${k} (“${dialects[k].label}”)`).join(", ")}`);

  const a = {};
  a.name = await ask("Name", "Vex");
  a.dialect = await ask("Dialect key", "night-city");
  a.slang = await ask("Slang 0-1 (how much street in the mouth)", "0.6");
  a.formality = await ask("Formality 0-1", "0.3");
  a.warmth = await ask("Warmth 0-1", "0.55");
  a.verbosity = await ask("Verbosity 0-1", "0.5");
  a.hedging = await ask("Hedging 0-1", "0.25");
  a.disfluency = await ask("Disfluency 0-1", "0.35");
  a.swearing = await ask("Swearing 0-1", "0.5");
  a.likes = await ask("Likes, comma-separated (raise energy)", "");
  a.dislikes = await ask("Dislikes, comma-separated (cost energy)", "");
  a.openness = await ask("Baseline openness 0-1", "0.6");
  a.extraversion = await ask("Baseline extraversion 0-1", "0.55");
  a.conscientiousness = await ask("Baseline conscientiousness 0-1", "0.5");
  a.agreeableness = await ask("Baseline agreeableness 0-1", "0.45");
  a.neuroticism = await ask("Baseline neuroticism 0-1", "0.5");
  a.backstory = await ask("Backstory, one breath");
  a.baseline = await ask("Baseline — where are they starting right now", "Level. New soul, no history yet.");

  a.people = [];
  for (;;) {
    const who = await ask("Family/friend name (empty finishes)", "");
    if (!who) break;
    const note = await ask(`One line about ${who}`, "");
    a.people.push({ name: who, note });
  }
  a.diarySeed = await ask("Opening diary line (optional)", "");

  const { markdown, warnings, dialect } = buildSoulMarkdown({ ...a, dialects });
  for (const w of warnings) console.log(`! ${w}`);
  const { voice, accent } = validateSoul(markdown, dialects);
  console.log(`\nParsed: ${voice.name} · ${accent.dialect} · slang ${accent.density} · "${accent.cadence}"`);
  console.log(`Sample line: "${accent.sample}"`);

  const out = outArg || join(process.cwd(), "SOUL.new.md");
  if (existsSync(out) && !force) {
    console.log(`Refusing to overwrite ${out} — rerun with --force.`);
    rl.close();
    return;
  }
  writeFileSync(out, markdown, "utf8");
  console.log(`Wrote ${out} (${markdown.length} chars, dialect ${dialect}).`);
  console.log("Point the agent at it: /soul <path> — or replace SOUL.md.");
  rl.close();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
