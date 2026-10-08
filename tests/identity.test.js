/**
 * Identity + substance — the agent must beat a bare LLM at being someone
 * who knows you (items 1-4):
 *
 *  1. Identity persistence: a claimed name ("call me test_hex") sticks to the
 *     per-person model and rides the prompt as KNOWN FACTS.
 *  2. Anti-grunt: single-word replies to real questions are repaired into
 *     sentences instead of passing ("u know my name?" → "Honestly, no.").
 *  3. Recall + both-sides memory: episodes store the full exchange, MEMORIES
 *     renders them:/you: pairs, and candidates carry a recall line.
 *  4. Fallback observability: every failed engine attempt is logged on the
 *     result and the training record instead of vanishing.
 *
 * Order per testing skill: happy path → edge cases → error cases → integration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createConversation } from "../src/interface/converse.js";
import { validateReply } from "../src/interface/validate.js";
import { createPhraseEngine } from "../src/phrase/engine.js";
import { createMemoryStore } from "../src/memory/store.js";
import { createNeurochemEngine } from "../src/neurochem/engine.js";
import { createEnergySystem } from "../src/energy/system.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slang = JSON.parse(readFileSync(join(ROOT, "config", "slang.json"), "utf8"));

const converse = (seed = 1, extra = {}) =>
  createConversation({ seed, root: ROOT, dialectPack: slang, ...extra });

// ==================== 1. IDENTITY — HAPPY PATH ====================

test("identity: a claimed handle sticks to the person model", async () => {
  const conv = converse();
  await conv.converse("call me test_hex");
  assert.equal(conv.daemon.memory.retrieveSocial("default")?.name, "test_hex");
});

test("identity: the next prompt carries KNOWN FACTS with the name", async () => {
  const conv = converse();
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return "Okay. Noted that down."; } };
  await conv.converse("call me test_hex", { engine });
  await conv.converse("do you remember anything at all", { engine });
  const user = sent.at(-1).find((m) => m.role === "user").content;
  assert.match(user, /# KNOWN FACTS ABOUT THEM/, "facts block present");
  assert.match(user, /their name: test_hex/, "name rides along");
});

test("identity: a cooperating model answers with the name and passes clean", async () => {
  const conv = converse();
  const stub = { chat: async () => "Okay. Noted that down." };
  await conv.converse("call me test_hex", { engine: stub });
  const r = await conv.converse("do you know my name", {
    engine: { chat: async () => "Yeah, test_hex. What's good?" },
  });
  assert.equal(r.source, "llm");
  assert.match(r.reply, /test_hex/);
});

test("identity: the soul-given listener is known from turn one, nothing invented", async () => {
  const conv = converse();
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return "Okay. Noted that down."; } };
  await conv.converse("hello there friend", { engine });
  const user = sent.at(-1).find((m) => m.role === "user").content;
  assert.match(user, /their name: V/, "soul says the listener is V");
  assert.ok(!user.includes("their name: test_hex"), "no unclaimed name appears");
});

test("identity: a newer claim overwrites, and survives serialization", async () => {
  const conv = converse();
  await conv.converse("call me test_hex");
  await conv.converse("actually call me neo");
  assert.equal(conv.daemon.memory.retrieveSocial("default")?.name, "neo");
  const wire = JSON.parse(JSON.stringify(conv.daemon.memory.toJSON()));
  const { createMemoryStore } = await import("../src/memory/store.js");
  const restored = createMemoryStore({ seed: 2 });
  restored.fromJSON(wire);
  assert.equal(restored.retrieveSocial("default")?.name, "neo", "name round-trips");
});

// ==================== 1. IDENTITY — EDGE CASES ====================

test("identity: states and generic addresses are not names", async () => {
  for (const line of ["i'm breaking up with you", "call me maybe", "call me dude", "i am so tired"]) {
    const conv = converse();
    await conv.converse(line);
    assert.equal(conv.daemon.memory.retrieveSocial("default")?.name ?? null, null, `${line} stored a name`);
  }
});

test("identity: i'm / my-name-is forms all claim", async () => {
  for (const [line, name] of [
    ["hey, i'm V", "V"],
    ["my name is Judy", "Judy"],
    ["u dont know who i m test_hex", "test_hex"],
  ]) {
    const conv = converse();
    await conv.converse(line);
    assert.equal(conv.daemon.memory.retrieveSocial("default")?.name, name, line);
  }
});

// ==================== 2. ANTI-GRUNT ====================

test("grunt: the rule fires only with a move in context", () => {
  const ctx = { userText: "u know my name?", move: { speechAct: "question" }, terse: 0.5 };
  const v = validateReply("No.", ctx);
  assert.equal(v.ok, false);
  assert.ok(v.hard.includes("grunt, not speech"), JSON.stringify(v.hard));

  // ...while bare validateReply calls keep their old behavior.
  assert.ok(validateReply("No.", { userText: "u know my name?" }).ok, "no move, no rule");
});

test("grunt: greetings, questions, substance and true terseness stay legal", () => {
  const q = { userText: "u know my name?", move: { speechAct: "question" }, terse: 0.5 };
  assert.ok(validateReply("Yo.", { userText: "hey chole", move: { speechAct: "greet" }, terse: 0.5 }).ok, "greeting grunt");
  // A lone question mark-word is exempt from the grunt rule — but answering a
  // QUESTION with only a question is still counter-asking, so test it off one.
  assert.ok(validateReply("Yeah?", { userText: "tell me something", move: { speechAct: "assert" }, terse: 0.5 }).ok, "short question");
  assert.ok(validateReply("Yeah, the rain is unreal tonight.", q).ok, "five words");
  assert.ok(validateReply("No. Not tonight, choom.", q).ok, "two sentences");
  assert.ok(validateReply("No.", { ...q, terse: 0.9 }).ok, "truly clipped state may grunt");
});

test("grunt: a grunt answer is repaired into a sentence, not passed", async () => {
  const conv = converse();
  const sent = [];
  let n = 0;
  const engine = {
    chat: async (msgs) => {
      sent.push(msgs);
      return n++ === 0 ? "No." : "Honestly? No idea, choom.";
    },
  };
  const r = await conv.converse("u know my name?", { engine });
  assert.equal(r.source, "llm-repaired");
  assert.equal(sent.length, 2, "one repair round");
  const repair = sent[1].filter((m) => m.role === "user").at(-1).content;
  assert.match(repair, /full sentence/, "guidance asks for a sentence");
});

test("grunt: a clean greeting still passes first try", async () => {
  const conv = converse();
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return "Yo."; } };
  const r = await conv.converse("hey chole", { engine });
  assert.equal(r.source, "llm");
  assert.equal(sent.length, 1, "no repair round");
});

// ==================== 3. RECALL + BOTH SIDES ====================

test("memory: exchanges store both sides and MEMORIES shows the pair", async () => {
  const conv = converse();
  await conv.converse("i got the job at militech");
  const eps = conv.daemon.memory.retrieveEpisodic({ content: "militech" }, { limit: 5, minActivation: -5 });
  assert.ok(eps.some((e) => e.content.includes("|| you replied:")), "agent half stored");

  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return "Okay. Noted that down."; } };
  await conv.converse("anything new with work lately", { engine });
  const user = sent.at(-1).find((m) => m.role === "user").content;
  assert.match(user, /them: i got the job at militech \/ you:/, "pair renders in MEMORIES");
});

test("recall: candidates carry a capped quote of what was said before", async () => {
  const conv = converse();
  await conv.converse("i got the job at militech");
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return "Okay. Noted that down."; } };
  const r = await conv.converse("what was my news choom tell me", { engine });
  assert.ok(r.candidates.length >= 1);
  assert.ok(r.candidates.every((c) => typeof c.recall === "string" && c.recall.includes("militech")),
    `recall on every skeleton: ${JSON.stringify(r.candidates.map((c) => c.recall))}`);
  for (const c of r.candidates) {
    assert.ok(c.recall.split(/\s+/).length <= 10, `capped: ${c.recall}`);
  }
  const system = sent.at(-1).find((m) => m.role === "system").content;
  assert.match(system, /recall \(optional/, "recall reaches the model");
});

test("recall: the current line itself is never recalled", async () => {
  const conv = converse();
  await conv.converse("i got the job at militech");
  const r = await conv.converse("i got the job at militech", {});
  for (const c of r.candidates) {
    assert.ok(!("recall" in c) || c.recall !== "i got the job at militech", "no self-quote");
  }
});

// ==================== 4. REJECTION LOG ====================

test("rejected: triple failure keeps all three attempts on the record", async () => {
  const conv = converse();
  const r = await conv.converse("u know my name?", { engine: { chat: async () => "No." } });
  assert.equal(r.source, "candidate-fallback");
  assert.equal(r.rejected.length, 3, "one entry per attempt");
  for (const entry of r.rejected) {
    assert.ok(entry.problems.includes("grunt, not speech"), JSON.stringify(entry));
    assert.equal(entry.output, "No.");
  }
  assert.equal(conv.trainingData().at(-1).rejected.length, 3, "training log keeps them too");
});

test("rejected: an engine throw is logged as engine-down, not silence", async () => {
  const conv = converse();
  const r = await conv.converse("hello there", {
    engine: { chat: async () => { throw new Error("down"); } },
  });
  assert.equal(r.source, "engine-down");
  assert.deepEqual(r.rejected, [{ attempt: 0, problems: ["engine error"], output: null }]);
});

test("rejected: clean turns log an empty rejection list", async () => {
  const conv = converse();
  const r = await conv.converse("hey chole", { engine: { chat: async () => "Yo." } });
  assert.equal(r.source, "llm");
  assert.deepEqual(r.rejected, []);
});

test("fallback: engine-down answers with substance, never a grunt", async () => {
  const conv = converse();
  await conv.converse("i got the job at militech"); // seeds memory (recall + carry)
  const r = await conv.converse("and then what happened", {
    engine: { chat: async () => { throw new Error("down"); } },
  });
  assert.equal(r.source, "engine-down");
  const words = r.reply.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const sents = r.reply.split(/(?<=[.!?…])\s+/).filter(Boolean);
  assert.ok(sents.length > 1 || words.length > 4, `fallback has substance: ${JSON.stringify(r.reply)}`);
});

// ==================== 5. FEELING + ACCEPTANCE PROBE ====================

test("ranking: a usable recall promotes answer frames over idk under uncertainty", () => {
  const mk = (mem) => {
    const pe = createPhraseEngine({ seed: 42, root: ROOT, dialectPack: slang });
    pe.setRefs({
      neurochem: createNeurochemEngine({ seed: 1 }),
      energy: createEnergySystem({ sleepPressure: 0.9, atp: 0.2 }),
      memory: mem,
    });
    return pe;
  };
  const mem = createMemoryStore({ seed: 3 });
  mem.addEvent({ type: "episodic", content: "i got the job at militech", valence: 0.6, importance: 8 });
  const move = { speechAct: "question", content: { text: "", valence: 0 } };
  const ctx = { seed: 3, userText: "what district are we in" };
  const withMem = mk(mem).generateCandidates(move, ctx);
  const noMem = mk(null).generateCandidates(move, ctx);
  assert.ok(withMem[0].recall, "recall present");
  assert.match(withMem[0].frame, /^answer/, `memory answers instead of shrugging: ${withMem[0].frame}`);
  assert.equal(noMem[0].frame, "idk", "with nothing to draw on, honesty wins");
});

test("feeling: a hot neurochemical state writes a prescriptive FEELING block", async () => {
  const conv = converse();
  const NT = conv.daemon.neurochem.NT;
  conv.daemon.neurochem.set(NT.DOPAMINE, 2, 0.8);
  conv.daemon.neurochem.set(NT.SEROTONIN, 2, 0.8);
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return "Okay. Noted that down."; } };
  await conv.converse("hey there friend", { engine });
  const system = sent.at(-1).find((m) => m.role === "system").content;
  assert.match(system, /# FEELING/, "feeling block present when hot");
  assert.match(system, /ecstasy|joy|desire/i, "names the felt state");
});

test("feeling: true rest leaves the prompt uncluttered", async () => {
  const conv = converse();
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return "Okay. Noted that down."; } };
  // Deliberately indifferent line: no social burst, no valence, no question.
  await conv.converse("the tram ran late again", { engine });
  const system = sent.at(-1).find((m) => m.role === "system").content;
  assert.ok(!system.includes("# FEELING"), "no feeling block at rest");
});

test("prompt: skeletons render words and frames, never tuning numbers", async () => {
  const conv = converse();
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return "Okay. Noted that down."; } };
  await conv.converse("i got the job at militech", { engine });
  const system = sent.at(-1).find((m) => m.role === "system").content;
  assert.match(system, /words: /, "slot words exposed");
  assert.match(system, /^\d+\. \[[a-z_]+\] /m, "frames listed as [frame] + hint");
  assert.ok(!system.includes("(confidence"), "no confidence parenthetical for the model to read as doubt");
  assert.ok(!system.includes("rate="), "no prosody telemetry in the prompt");
});

test("probe: four turns, zero repairs, name used, concrete fact kept", async () => {
  const conv = converse(77);
  const sent = [];
  const script = [
    "Okay. Noted that down.",
    "Yeah test_hex, I remember you.",
    "Warm night, same couch as always.",
    "You got the Militech gig, choom.",
  ];
  let n = 0;
  const engine = {
    chat: async (msgs) => {
      sent.push(msgs);
      return script[Math.min(n++, script.length - 1)];
    },
  };
  const turns = [
    "call me test_hex",
    "do you remember me at all",
    "what was the night like",
    "what did i tell you about work",
  ];
  const replies = [];
  for (const line of turns) {
    const r = await conv.converse(line, { engine });
    replies.push(r.reply);
  }
  assert.ok(replies.every((_, i) => conv.trainingData()[i].source === "llm"),
    `every turn clean first try: ${conv.trainingData().map((e) => e.source)}`);
  assert.equal(sent.length, 4, "no repair round anywhere");
  assert.match(replies[1], /test_hex/, "name actually used");
  assert.match(replies[3], /Militech/, "concrete fact kept, not a filler");
  const systems = sent.map((msgs) => msgs.find((m) => m.role === "system").content);
  assert.ok(systems[3].includes("recall (optional"), "memory rode along on the last turn");
});

test("farewell: parting openers fail mid-chat, pass when they leave", () => {
  const mid = { userText: "see you at Sakura's stall in ten", move: { speechAct: "assert" } };
  for (const reply of ["Catch you later, Junie.", "See ya, Junie. Perfect.", "Goodbye, choom.", "Later."]) {
    const v = validateReply(reply, mid);
    assert.ok(v.hard.includes("unprompted farewell"), `${reply}: ${JSON.stringify(v.hard)}`);
  }
  const leaving = { userText: "gotta go now, heading out", move: { speechAct: "farewell" } };
  assert.ok(validateReply("Catch you later, Junie.", leaving).ok, "leaving keeps it legal");
  assert.ok(validateReply("Goodbye for now, choom.", leaving).ok, "goodbye legal on exit");
  // Mid-line partings are not openers.
  assert.ok(validateReply("We'll see you later, alligator.", mid).ok, "mid-line passes");
});

test("farewell: an unprompted goodbye repairs instead of passing", async () => {
  const conv = converse();
  const sent = [];
  let n = 0;
  const engine = {
    chat: async (msgs) => {
      sent.push(msgs);
      return n++ === 0 ? "Catch you later, Junie." : "Junie, I'm still here — what's good?";
    },
  };
  const r = await conv.converse("are you still around", { engine });
  assert.equal(r.source, "llm-repaired");
  const repair = sent[1].filter((m) => m.role === "user").at(-1).content;
  assert.match(repair, /only when THEY are leaving/);
});

test("persona: the contract speaks as Johnny to V, never Chole-era lines", async () => {
  const conv = converse();
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return "Okay. Noted that down."; } };
  await conv.converse("hey there friend", { engine });
  const system = sent.at(-1).find((m) => m.role === "system").content;
  assert.match(system, /You are Johnny Silverhand/, "persona in contract");
  assert.match(system, /You call them V/, "listener in contract");
  assert.ok(!system.includes("Chole"), "no Chole-era wording anywhere");
  assert.ok(system.includes("You are Johnny Silverhand; they are not you."), "identity line");
});

test("persona: self-naming the listener repairs with Johnny-aware guidance", async () => {
  const conv = converse();
  const sent = [];
  let n = 0;
  const engine = {
    chat: async (msgs) => {
      sent.push(msgs);
      return n++ === 0 ? "Hey Johnny, what's good?" : "V, listen up a second.";
    },
  };
  const r = await conv.converse("hello there friend", { engine });
  assert.equal(r.source, "llm-repaired");
  assert.ok(r.rejected[0].problems.includes("used your name for them"), JSON.stringify(r.rejected));
  const repair = sent[1].filter((m) => m.role === "user").at(-1).content;
  assert.match(repair, /never use your own name/, "guidance names the fix");
  assert.match(repair, /Johnny Silverhand/, "guidance names the persona");
});
