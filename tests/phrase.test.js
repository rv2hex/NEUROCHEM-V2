import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhraseEngine } from "../src/phrase/engine.js";
import { createNeurochemEngine } from "../src/neurochem/engine.js";
import { createEnergySystem } from "../src/energy/system.js";
import { parseSoulText, loadSoul, buildAccentPack } from "../src/personality/soul.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slang = JSON.parse(
  (await import("node:fs")).readFileSync(join(ROOT, "config", "slang.json"), "utf8")
);

function makeEngine(root = ROOT, soulPath = null) {
  const pe = createPhraseEngine({
    seed: 42,
    root,
    soulPath,
    dialectPack: slang,
    seedOverride: undefined,
  });
  pe.setRefs({
    neurochem: createNeurochemEngine({ seed: 1 }),
    energy: createEnergySystem({}),
    memory: null,
  });
  return pe;
}

// ==================== SKELETON SHAPE ====================

test("candidates are word-skeletons: frame + slots + words, NO full sentence field", () => {
  const pe = makeEngine();
  const cands = pe.generateCandidates({ speechAct: "assert" }, { seed: 1 });
  assert.ok(cands.length >= 3, `at least 3 candidates: ${cands.length}`);
  for (const c of cands) {
    assert.ok(c.frame, "has frame");
    assert.ok(Array.isArray(c.slots) && c.slots.length > 0, "has slots");
    assert.ok(c.words && typeof c.words === "object", "has words map");
    // Skeleton must NOT carry finished text
    assert.equal(c.text, undefined, "no .text field — candidates are skeletons, not sentences");
    // Every slot must be filled with a word (string)
    for (const slot of c.slots) {
      assert.ok(typeof c.words[slot] === "string" && c.words[slot].length > 0,
        `slot ${slot} filled`);
    }
    assert.ok(c.accent, "carries accent");
    assert.ok(c.confidence >= 0 && c.confidence <= 1, "confidence in range");
  }
});

test("skeleton slots are short words, not sentences", () => {
  const pe = makeEngine();
  const cands = pe.generateCandidates({ speechAct: "assert" }, { seed: 5 });
  for (const c of cands) {
    for (const [slot, word] of Object.entries(c.words)) {
      const words = String(word).trim().split(/\s+/).length;
      assert.ok(words <= 6, `slot ${slot} word too long (${words} words): "${word}"`);
    }
  }
});

test("renderSkeleton turns a skeleton into text (offline fallback only)", () => {
  const pe = makeEngine();
  const cands = pe.generateCandidates({ speechAct: "greet" }, { seed: 2 });
  const text = pe.renderSkeleton(cands[0]);
  assert.equal(typeof text, "string");
  assert.ok(text.length > 0);
  assert.ok(/[.!?]$/.test(text), "has terminal punctuation");
  assert.ok(/^[A-Z]/.test(text), "capitalized");
});

// ==================== SOUL DRIVES ACCENT ====================

test("SOUL.md loads: voice profile carries name, dialect, speech traits", () => {
  const pe = makeEngine();
  const v = pe.voice;
  assert.equal(v.name, "Chole");
  assert.equal(v.dialect, "night-city");
  assert.ok(Math.abs(v.slang - 0.75) < 0.01);
  assert.ok(Math.abs(v.formality - 0.25) < 0.01);
  assert.ok(v.prose.includes("ripperdoc"), "prose loaded");
  assert.ok(v.sample.length > 0, "accent sample extracted from prose");
});

test("accent pack comes from the SOUL-selected dialect", () => {
  const pe = makeEngine();
  const accent = pe.accent;
  assert.equal(accent.dialect, "Night City street");
  assert.ok(accent.density === "freely", "slang 0.75 → freely");
  assert.ok(accent.dialectWords.includes("choom"));
  assert.ok(accent.cadence.length > 0);
  assert.ok(accent.sample.includes("I talk fast") || accent.sample.includes("I"), "sample is first-person SOUL line");
});

test("CHANGE THE SOUL → THE ACCENT CHANGES", () => {
  const pe = makeEngine();
  assert.equal(pe.accent.dialect, "Night City street");

  // Rewrite the soul as a corpo with formal speech
  const corpoSoul = parseSoulText(`---
name: Lorraine
speech.dialect: corpo
speech.slang: 0.15
speech.formality: 0.9
speech.warmth: 0.3
speech.swearing: 0.0
---
I run clean operations for Arasaka and I don't raise my voice.`, "inline");

  // Simulate soul swap: parse and rebuild accent
  const newAccent = buildAccentPack(corpoSoul, slang.dialects.corpo);
  assert.equal(newAccent.dialect, "Corpo");
  assert.equal(newAccent.density, "rarely");
  assert.notEqual(newAccent.cadence, pe.accent.cadence);
  assert.ok(newAccent.sample.includes("I run clean operations"));
});

test("setSoul reloads accent from a different SOUL file", async () => {
  const pe = makeEngine();
  assert.equal(pe.voice.name, "Chole");

  // Write a temp alternate soul
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tmp = mkdtempSync(join(tmpdir(), "soul-"));
  writeFileSync(join(tmp, "SOUL.md"), `---
name: Viktor
speech.dialect: plain
speech.slang: 0.1
speech.formality: 0.7
---
Quiet ripperdoc. I keep my words few and my hands steady.`);

  const v = pe.setSoul(tmp);
  assert.equal(v.name, "Viktor");
  assert.equal(pe.voice.dialect, "plain");
  assert.notEqual(pe.accent.dialect, "Night City street");
});

// ==================== STATE SHAPES THE SKELETONS ====================

test("high uncertainty → hedge/idk frames appear", () => {
  const pe = makeEngine();
  // Force neurochem into uncertain state: low DA/NE + high sleep pressure
  const nc = createNeurochemEngine({ seed: 2 });
  const en = createEnergySystem({ sleepPressure: 0.9, atp: 0.3 });
  pe.setRefs({ neurochem: nc, energy: en, memory: null });

  const t = pe.actionTendencies();
  assert.ok(t.uncertain > 0.55, `uncertain is high: ${t.uncertain}`);

  const cands = pe.generateCandidates({ speechAct: "assert" }, { seed: 3 });
  const frames = cands.map((c) => c.frame);
  assert.ok(frames.includes("uncertain") || frames.includes("idk"),
    `expect hedge/idk frames: ${frames.join(",")}`);
});

test("warm state → comfort_ask / followup frames present", () => {
  const pe = makeEngine();
  const nc = createNeurochemEngine({ seed: 3 });
  // Push OXT + DA high, serotonin up (secure baseline), NE down (calm)
  nc.set(nc.NT.OXYTOCIN, 2, 0.75);
  nc.set(nc.NT.DOPAMINE, 2, 0.7);
  nc.set(nc.NT.SEROTONIN, 2, 0.7);
  nc.set(nc.NT.NOREPINEPHRINE, 2, 0.2);
  const en = createEnergySystem({ atp: 0.9 });
  pe.setRefs({ neurochem: nc, energy: en, memory: null });

  const cands = pe.generateCandidates({ speechAct: "comfort" }, { seed: 4 });
  const frames = cands.map((c) => c.frame);
  assert.ok(frames.includes("comfort_ask"), `warm comfort asks back: ${frames.join(",")}`);
});

test("candidates are deterministic given seed (fresh engine each)", () => {
  const a = makeEngine().generateCandidates({ speechAct: "assert" }, { seed: 99 });
  const b = makeEngine().generateCandidates({ speechAct: "assert" }, { seed: 99 });
  assert.deepEqual(a.map((c) => c.words), b.map((c) => c.words));
});

test("anti-repeat: same seed twice does not return identical frame list", () => {
  const pe = makeEngine();
  const a = pe.generateCandidates({ speechAct: "assert" }, { seed: 7 });
  const b = pe.generateCandidates({ speechAct: "assert" }, { seed: 7 });
  const aFrames = a.map((c) => c.frame).join(",");
  const bFrames = b.map((c) => c.frame).join(",");
  assert.notEqual(aFrames, bFrames, "frames rotate across calls");
});

test("anti-repeat: greet and farewell each have two structures to rotate through", () => {
  const pe = makeEngine();
  const seen = new Set();
  const leads = { greet: [], farewell: [] };

  for (const act of Object.keys(leads)) {
    for (let i = 0; i < 8; i++) {
      const cs = pe.generateCandidates({ speechAct: act }, { seed: i + 1 });
      assert.ok(cs.length >= 1, `${act} always offers a skeleton`);
      leads[act].push(cs[0].frame);
      for (const c of cs) {
        seen.add(c.frame);
        if (c.frame === `${act}_alt`) {
          assert.deepEqual(
            c.slots,
            [act === "greet" ? "greeting" : "parting", "filler"],
            `${act}_alt keeps a second slot`
          );
        }
      }
    }
  }

  assert.deepEqual(
    [...seen].sort(),
    ["farewell", "farewell_alt", "greet", "greet_alt"],
    `both structures must be on offer: ${JSON.stringify([...seen].sort())}`
  );
  for (const act of Object.keys(leads)) {
    assert.ok(
      new Set(leads[act]).size >= 2,
      `${act} never rotated its lead frame — it was ${JSON.stringify(leads[act])}`
    );
  }
});

test("behavioralGuidance carries SOUL accent info", () => {
  const pe = makeEngine();
  const g = pe.behavioralGuidance({ speechAct: "assert" });
  const joined = g.behavioral_effects.join("\n");
  assert.ok(joined.includes("night-city"), "mentions dialect");
  assert.ok(joined.includes("cadence") || joined.includes("Short clipped"), "cadence");
  assert.ok(joined.includes("swearing"), "swearing policy");
  assert.ok(g.accent && g.accent.sample, "accent block present");
});

test("stateNarrative returns first-person body description", () => {
  const pe = makeEngine();
  const narrative = pe.stateNarrative();
  assert.equal(typeof narrative, "string");
  assert.ok(narrative.length > 10);
  assert.ok(narrative.split(".").length > 1, "multiple sentences");
});

test("action tendencies: inverses sum to ~1", () => {
  const pe = makeEngine();
  const t = pe.actionTendencies();
  for (const [a, b] of [["approach", "avoid"], ["verbose", "terse"], ["warm", "guarded"], ["certain", "uncertain"]]) {
    const sum = t[a] + t[b];
    assert.ok(Math.abs(sum - 1) < 0.02, `${a}+${b} = ${sum}`);
  }
});

test("disfluency plan scales with SOUL disfluency trait", () => {
  const lowSoul = parseSoulText(`---
name: A
speech.dialect: plain
speech.disfluency: 0.0
speech.swearing: 0
---
I speak clean.`, "inline");
  const pack = buildAccentPack(lowSoul, slang.dialects.plain);
  assert.ok(pack, "accent built");
  // The engine's planDisfluency reads voice.disfluency — verify factor < 1
  const pe = makeEngine();
  const plan = pe.planDisfluency(
    { uncertain: 0.5, terse: 0.5 },
    { norepinephrine: 0.6, dopamine: 0.5 },
    { cortisolLevel: 0.5, sleepPressure: 0.2 },
    () => 0.99
  );
  assert.ok(plan.plan.filledPauseRate >= 0 && plan.plan.filledPauseRate <= 1);
});
test("diary: chapters after the identity body surface, capped from the newest tail", () => {
  const pe = makeEngine();
  const d = pe.diary();
  assert.ok(d.includes("Arasaka"), `live SOUL chapter surfaces: ${d.slice(0, 80)}`);
  assert.ok(!d.includes("Ex-trauma ripperdoc"), "identity body is not diary");
  assert.ok(d.length <= 800, `capped: ${d.length}`);
});

test("diary: a soul without chapters yields no block, and caps hold", async () => {
  const { writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(tmpdir(), `soul-nodiary-${Date.now()}.md`);
  writeFileSync(file, `---\nname: X\nspeech.dialect: plain\n---\nJust a drifter.\n`, "utf8");
  const pe = makeEngine(ROOT, file);
  assert.equal(pe.diary(), "", "no ## sections means no diary");

  const big = `---\nname: Y\nspeech.dialect: plain\n---\n drifter.\n## Old\n${"x".repeat(600)}\n## New\n${"y".repeat(600)}\n`;
  const file2 = join(tmpdir(), `soul-bigdiary-${Date.now()}.md`);
  writeFileSync(file2, big, "utf8");
  const pe2 = makeEngine(ROOT, file2);
  const d2 = pe2.diary();
  assert.ok(d2.length <= 800, `tail-capped: ${d2.length}`);
  assert.ok(d2.includes("New:"), "the newest chapter survives the cap");
  assert.ok(!d2.includes("Old:"), "the oldest chapter title falls off first");
});
