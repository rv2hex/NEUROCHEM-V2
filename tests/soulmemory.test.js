/**
 * Soul memories — learning that travels with SOUL.md (items: forever-memory).
 *
 * Covers the owned auto-memory region in src/personality/soul.js plus the
 * converse wiring (rememberFact / promoteMemories / memory-seeking pull).
 * Order per testing skill: happy path → edge cases → error cases → integration.
 *
 * Rule: only distilled facts reach the file (identity, explicit "remember
 * this", importance-≥9). Raw episodes never do — the soul is always fully
 * in context, so it gets no retrieval, no decay, and no forgiveness.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createConversation } from "../src/interface/converse.js";
import {
  readSoulMemories,
  writeSoulMemories,
  upsertSoulMemory,
  SOUL_MEMORY_START,
  SOUL_MEMORY_BUDGET,
} from "../src/personality/soul.js";
import { createMemoryStore } from "../src/memory/store.js";
import { buildSoulMarkdown, validateSoul } from "../src/cli/make-soul.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slang = JSON.parse(readFileSync(join(ROOT, "config", "slang.json"), "utf8"));

const BASE_SOUL = `---
name: TestSoul
speech.dialect: plain
---
Just a drifter passing through.

## Old Chapter
Something that happened long ago.
`;

function tmpSoul(content = BASE_SOUL) {
  const dir = mkdtempSync(join(tmpdir(), "soulmem-"));
  const file = join(dir, "SOUL.md");
  writeFileSync(file, content, "utf8");
  return file;
}

const converseOn = (soulPath, extra = {}) =>
  createConversation({ seed: 11, root: ROOT, soulPath, dialectPack: slang, ...extra });

// ==================== HAPPY PATH ====================

test("soulmem: upsert creates the owned region, manual prose byte-identical", () => {
  const out = upsertSoulMemory(BASE_SOUL, "About test_hex", "Their name is test_hex.");
  assert.ok(out.includes(SOUL_MEMORY_START), "markers present");
  assert.ok(out.includes("## About test_hex"), "chapter written");
  assert.ok(out.startsWith(BASE_SOUL.replace(/\s+$/, "")), "manual prose untouched up front");
  assert.ok(out.includes("## Old Chapter\nSomething that happened long ago."), "manual chapter intact");
  assert.deepEqual(readSoulMemories(out), [{ title: "About test_hex", text: "Their name is test_hex." }]);
});

test("soulmem: same title updates in place, never duplicates", () => {
  const once = upsertSoulMemory(BASE_SOUL, "About test_hex", "Their name is test_hex.");
  const twice = upsertSoulMemory(once, "About test_hex", "Their name is test_hex, choom of mine.");
  const matches = twice.match(/## About test_hex/g) || [];
  assert.equal(matches.length, 1, "exactly one chapter");
  assert.ok(twice.includes("choom of mine"), "new text wins");
  assert.ok(!twice.includes("Their name is test_hex.\n"), "old text gone");
});

test("soulmem: diary surfaces auto-chapters with no marker leakage", async () => {
  const file = tmpSoul();
  const conv = converseOn(file);
  const r = conv.rememberFact("About test_hex", "Their name is test_hex.");
  assert.ok(r.ok, JSON.stringify(r));
  const diary = conv.daemon.phrase.diary();
  assert.match(diary, /About test_hex/, "chapter reaches the prompt");
  assert.ok(!diary.includes("auto-memories"), "markers never reach the model");
});

test("soulmem: rememberFact reports its path", () => {
  const file = tmpSoul();
  const conv = converseOn(file);
  const r = conv.rememberFact("Grape Boilerplate", "Pages open with <zorpdoctype snack>.");
  assert.equal(r.ok, true);
  assert.equal(r.path, file);
  assert.ok(readFileSync(file, "utf8").includes("<zorpdoctype snack>"), "on disk");
});

// ==================== EDGE CASES ====================

test("soulmem: the region is budget-capped, newest survive", () => {
  let entries = [];
  for (let i = 0; i < 40; i++) {
    entries.push({ title: `Fact ${i}`, text: `Detail number ${i} `.repeat(20).trim() });
  }
  const out = writeSoulMemories(BASE_SOUL, entries);
  const region = out.slice(out.indexOf(SOUL_MEMORY_START));
  assert.ok(region.length <= SOUL_MEMORY_BUDGET + 200, `capped: ${region.length}`);
  assert.ok(region.includes("## Fact 39"), "newest kept");
  assert.ok(!region.includes("## Fact 0"), "oldest rotated out");
  assert.ok(out.includes("## Old Chapter"), "manual prose never capped");
});

test("soulmem: empty text writes nothing, missing region reads empty", () => {
  assert.equal(upsertSoulMemory(BASE_SOUL, "Empty", "   "), BASE_SOUL, "blank fact refused");
  assert.deepEqual(readSoulMemories(BASE_SOUL), [], "no region, no chapters");
  assert.deepEqual(readSoulMemories("## A\nx"), [], "markers required, chapters alone ignored");
});

test("soulmem: auto-identity writes only when soulPersist is on", async () => {
  const file = tmpSoul();
  const quiet = converseOn(file); // flag off
  await quiet.converse("call me test_hex");
  assert.ok(!readFileSync(file, "utf8").includes("About test_hex"), "tests never graffiti");

  const loud = converseOn(file, { soulPersist: true });
  await loud.converse("call me test_hex");
  assert.ok(readFileSync(file, "utf8").includes("## About test_hex"), "enabled session persists");
});

test("soulmem: promote distills identity, explicit notes and big events — once", async () => {
  const file = tmpSoul();
  const conv = converseOn(file);
  await conv.converse("call me test_hex"); // identity episode, auto-write OFF
  conv.daemon.memory.addEvent({
    type: "episodic", content: "remember this: my blade is called whisper",
    valence: 0.2, importance: 4,
  });
  conv.daemon.memory.addEvent({
    type: "episodic", content: "Arasaka burned the docks to the ground tonight",
    valence: -0.8, importance: 9,
  });
  const first = conv.promoteMemories();
  assert.equal(first.added, 3, JSON.stringify(first));
  const raw = readFileSync(file, "utf8");
  assert.ok(raw.includes("## About test_hex"), "identity promoted");
  assert.ok(raw.includes("whisper"), "explicit note promoted");
  assert.ok(raw.includes("Arasaka burned"), "major event promoted");
  assert.equal(conv.promoteMemories().added, 0, "second run adds nothing");
});

// ==================== ERROR CASES ====================

test("soulmem: no soul file means a clean refusal, never a throw", async () => {
  const empty = mkdtempSync(join(tmpdir(), "soulmem-nofile-"));
  const conv = createConversation({ seed: 12, root: empty, dialectPack: slang });
  const r = conv.rememberFact("Anything", "Something true.");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no soul file/);
  assert.equal(conv.promoteMemories().added, 0, "nothing to write to");
});

// ==================== INTEGRATION ====================

test("soulmem: a memory-seeking line pulls double-width retrieval", async () => {
  const conv = converseOn(tmpSoul());
  const lines = [
    "the tram ran late again",
    "rain on the windows tonight",
    "chrome prices up at the market",
    "a choom owes me eddies",
    "the afterlife was packed",
    "saw a trauma team van scream past",
    "noodles taste better in the rain",
    "kabuki lights never sleep",
  ];
  for (const line of lines) await conv.converse(line);
  const countMemories = (content) => {
    const block = content.split("# MEMORIES")[1]?.split("# RECENT")[0] || "";
    return block.split("\n").filter((l) => l.startsWith("- ")).length;
  };
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return "Okay. Noted that down."; } };
  await conv.converse("the dispensary shorted my change", { engine });
  await conv.converse("do you remember the tram", { engine });
  const normal = countMemories(sent[0].find((m) => m.role === "user").content);
  const seeking = countMemories(sent[1].find((m) => m.role === "user").content);
  assert.equal(normal, 5, "default width");
  assert.ok(seeking > normal, `seeking pulls more: ${seeking} vs ${normal}`);
});

// ==================== SPECS (verbatim tier) ====================

test("specs: exact store, substring recall, overwrite, cap", () => {
  const m = createMemoryStore({ seed: 21 });
  assert.equal(m.rememberSpec("grape boilerplate", "<zorpdoctype snack>"), "grape boilerplate");
  assert.equal(m.recallSpec("Grape Boilerplate").text, "<zorpdoctype snack>", "case-insensitive exact");
  assert.equal(m.recallSpec("boilerplate").text, "<zorpdoctype snack>", "substring either way");
  assert.equal(m.recallSpec("grape midnight boilerplate please").text, "<zorpdoctype snack>", "query contains name");
  assert.equal(m.recallSpec("nope"), null, "unknown is null, not invented");
  assert.equal(m.rememberSpec("grape boilerplate", "<v2>"), "grape boilerplate", "overwrite returns name");
  assert.equal(m.recallSpec("boilerplate").text, "<v2>", "one truth per name");
  assert.equal(m.rememberSpec("", "x"), null, "empty name refused");
  assert.equal(m.rememberSpec("y", "  "), null, "empty text refused");
  m.rememberSpec("uniquesnowflake", "one-off");
  for (let i = 0; i < 35; i++) m.rememberSpec(`spec-${i}`, `text-${i}`);
  assert.equal(m.getStats().specs, 30, "capped");
  assert.ok(m.recallSpec("spec-34"), "newest survives");
  assert.equal(m.recallSpec("uniquesnowflake"), null, "oldest rotated out");
});

test("specs: round-trip through checkpoints", () => {
  const m = createMemoryStore({ seed: 22 });
  m.rememberSpec("grape boilerplate", "<zorpdoctype snack>");
  const wire = JSON.parse(JSON.stringify(m.toJSON()));
  const r = createMemoryStore({ seed: 23 });
  r.fromJSON(wire);
  assert.equal(r.recallSpec("boilerplate").text, "<zorpdoctype snack>");
  const empty = createMemoryStore({ seed: 24 });
  empty.fromJSON({}); // old checkpoints predate specs
  assert.equal(empty.recallSpec("boilerplate"), null);
});

test("specs: a code turn injects the matching spec byte-for-byte", async () => {
  const conv = converseOn(tmpSoul());
  conv.rememberSpec("grape midnight boilerplate", "<zorpdoctype snack>\n<htmlish flavor=grape>");
  const sent = [];
  const engine = {
    chat: async (msgs) => {
      sent.push(msgs);
      return "Done.\n```html\n<zorpdoctype snack>\n```";
    },
  };
  const r = await conv.converse("code my boilerplate page", { engine });
  assert.equal(r.source, "llm");
  const system = sent.at(-1).find((m) => m.role === "system").content;
  assert.match(system, /# EXACT SPEC/, "spec block present");
  assert.match(system, /grape midnight boilerplate/, "named");
  assert.ok(system.includes("<zorpdoctype snack>\n<htmlish flavor=grape>"), "verbatim, not paraphrased");
});

// ==================== DIARY SPLIT (anti-dilution) ====================

test("diary: manual backstory survives a full auto region", async () => {
  const file = tmpSoul();
  const entries = [];
  for (let i = 0; i < 30; i++) {
    entries.push({ title: `Auto ${i}`, text: `auto memory detail number ${i} `.repeat(15).trim() });
  }
  writeFileSync(file, writeSoulMemories(BASE_SOUL, entries), "utf8");
  const conv = converseOn(file);
  const diary = conv.daemon.phrase.diary();
  assert.match(diary, /Old Chapter/, "authored past never crowded out");
  // Tail-capping slices mid-title by design (char budget, not chapters), so
  // assert the newest CONTENT rather than its severed title.
  assert.match(diary, /auto memory detail number 29/, "newest auto memory present");
  assert.ok(!diary.includes("Auto 0"), "oldest rotated out of the read window");
});

// ==================== SOUL MAKER ====================

const MAKER_ANSWERS = {
  name: "Vex",
  dialect: "night-city",
  slang: 0.8,
  formality: 0.2,
  warmth: 0.6,
  verbosity: 0.5,
  hedging: 0.2,
  disfluency: 0.4,
  swearing: 0.7,
  likes: "rain, chrome",
  dislikes: "corpo",
  backstory: "I run packages across Night City and I talk fast.",
  baseline: "Level. New soul, no history yet.",
  people: [{ name: "Mama Wells", note: "Ran the bar that raised me." }],
  diarySeed: "First night out alone went fine.",
};

test("maker: every field round-trips through the parser", () => {
  const { markdown, warnings } = buildSoulMarkdown({ ...MAKER_ANSWERS, dialects: slang.dialects });
  assert.deepEqual(warnings, [], JSON.stringify(warnings));
  const { voice, accent } = validateSoul(markdown, slang.dialects);
  assert.equal(voice.name, "Vex");
  assert.equal(voice.dialect, "night-city");
  assert.equal(voice.swearing, 0.7);
  assert.deepEqual(voice.likes, ["rain", "chrome"]);
  assert.deepEqual(voice.dislikes, ["corpo"]);
  assert.ok(voice.prose.includes("Mama Wells"), "people become chapters");
  assert.ok(voice.prose.includes("## Baseline"), "baseline chapter present");
  assert.ok(voice.prose.includes("## First entry"), "diary seed present");
  assert.equal(accent.dialect, "Night City street", "accent ties to the soul dialect");
  assert.ok(voice.sample.length > 0, "accent sample extracted");
});

test("maker: unknown dialect falls back with a warning, numbers clamp", () => {
  const { markdown, warnings, dialect } = buildSoulMarkdown({
    ...MAKER_ANSWERS, dialect: "mars-olympus", slang: 99, warmth: -3, dialects: slang.dialects,
  });
  assert.equal(warnings.length, 1, "one warning");
  assert.equal(dialect, Object.keys(slang.dialects)[0], "first pack wins");
  const { voice } = validateSoul(markdown, slang.dialects);
  assert.equal(voice.slang, 1, "overflow clamps");
  assert.equal(voice.warmth, 0, "underflow clamps");
});
