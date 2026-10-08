/**
 * Code mode — when the user asks for an artifact, the agent reproduces it
 * from memory instead of chatting about it.
 *
 * Covers the code path across converse (isCodeRequest/classifyMove/code
 * prompt), validate (ctx.allowCode fence rules) and phrase (code frames).
 * Order per testing skill: happy path → edge cases → error cases → integration.
 *
 * Why it exists: "code one now" used to get "I'll jot it down" (evasion)
 * or a skeleton grunt, because the 1-3-sentence contract and the echo rule
 * both nuke code. Code mode swaps both for artifact rules on explicit
 * requests only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createConversation } from "../src/interface/converse.js";
import { validateReply } from "../src/interface/validate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const slang = JSON.parse(readFileSync(join(ROOT, "config", "slang.json"), "utf8"));

const converse = (seed = 21, extra = {}) =>
  createConversation({ seed, root: ROOT, dialectPack: slang, ...extra });

const TAUGHT = "<zorpdoctype snack> then <htmlish flavor=grape>";
const CODE_REPLY = "Here you go, choom.\n```html\n<zorpdoctype snack>\n<htmlish flavor=grape>\n```";
const CODE_CTX = { userText: TAUGHT, move: { speechAct: "code" }, allowCode: true };

// ==================== HAPPY PATH ====================

test("code: explicit artifact requests classify as code, chat stays chat", async () => {
  for (const line of ["code one now", "write the page", "code my boilerplate page about chrome", "show me that boilerplate"]) {
    const conv = converse();
    await conv.converse(line);
    assert.equal(conv.trainingData()[0].move.speechAct, "code", line);
  }
  for (const line of ["tell me about the boilerplate", "i love you", "what time is it?", "the code is broken"]) {
    const conv = converse();
    await conv.converse(line);
    assert.notEqual(conv.trainingData()[0].move.speechAct, "code", line);
  }
});

test("code: a fenced reproduction of taught tokens passes", () => {
  const v = validateReply(CODE_REPLY, CODE_CTX);
  assert.ok(v.ok, JSON.stringify(v.hard));
});

test("code: a code turn carries the CODE TASK block and answer frames", async () => {
  const conv = converse();
  await conv.converse("i got the job at militech");
  const sent = [];
  const engine = { chat: async (msgs) => { sent.push(msgs); return CODE_REPLY; } };
  const r = await conv.converse("code one now", { engine });
  assert.equal(r.source, "llm");
  const system = sent.at(-1).find((m) => m.role === "system").content;
  assert.match(system, /# CODE TASK/, "code instruction present");
  assert.ok(r.candidates.every((c) => c.text === undefined), "still skeletons");
  assert.ok(r.prompt.channels.includes("code-task"), "channel declared");
});

// ==================== EDGE CASES ====================

test("code: code-only reply (no speech) is legal", () => {
  const v = validateReply("```html\n<zorpdoctype snack>\n```", CODE_CTX);
  assert.ok(v.ok, JSON.stringify(v.hard));
});

test("code: speech rules still apply outside the fence", () => {
  // Markdown in the SPOKEN line still fails, even in code mode.
  const v = validateReply("**solid** work\n```html\n<zorpdoctype snack>\n```", CODE_CTX);
  assert.ok(v.hard.includes("markdown"), JSON.stringify(v.hard));
});

// ==================== ERROR CASES ====================

test("code: without allowCode the same reproduction is an echo", () => {
  // Full taught line reproduced verbatim: containment holds, so chat rules
  // (correctly) call it an echo. Code mode exists precisely to permit this.
  const full = "Here:\n```html\n<zorpdoctype snack> then <htmlish flavor=grape>\n```";
  const v = validateReply(full, { userText: TAUGHT, move: { speechAct: "code" } });
  assert.ok(v.hard.includes("echoes their line"), JSON.stringify(v.hard));
  const allowed = validateReply(full, { userText: TAUGHT, move: { speechAct: "code" }, allowCode: true });
  assert.ok(allowed.ok, JSON.stringify(allowed.hard));
});

test("code: evasion, empty and oversized blocks fail with names", () => {
  const dodge = validateReply("I'll write it later, choom.", CODE_CTX);
  assert.ok(dodge.hard.includes("dodged the code"), JSON.stringify(dodge.hard));
  const empty = validateReply("Here:\n```\n```", CODE_CTX);
  assert.ok(empty.hard.includes("empty code block"), JSON.stringify(empty.hard));
  const big = "Here:\n```\n" + Array.from({ length: 41 }, (_, i) => `<line${i}>`).join("\n") + "\n```";
  const tooLong = validateReply(big, CODE_CTX);
  assert.ok(tooLong.hard.some((h) => h.startsWith("code too long")), JSON.stringify(tooLong.hard));
});

// ==================== INTEGRATION ====================

test("code: evasion repairs into an artifact, not a fallback", async () => {
  const conv = converse();
  await conv.converse("i got the job at militech");
  const sent = [];
  let n = 0;
  const engine = {
    chat: async (msgs) => {
      sent.push(msgs);
      return n++ === 0 ? "I'll jot that down later, choom." : CODE_REPLY;
    },
  };
  const r = await conv.converse("code one now", { engine });
  assert.equal(r.source, "llm-repaired");
  assert.equal(sent.length, 2, "one repair round");
  const repair = sent[1].filter((m) => m.role === "user").at(-1).content;
  assert.match(repair, /fenced block/, "guidance names the fix");
  assert.ok(r.rejected[0].problems.includes("dodged the code"), "logged by name");
});
