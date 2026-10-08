/**
 * Validator — the deterministic output gate.
 *
 * Every rule here was written because a specific string escaped into live
 * output first. The observed strings are used verbatim as fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReply, stripWrappingQuotes } from "../src/interface/validate.js";

const reject = (text, ctx = {}) => {
  const v = validateReply(text, ctx);
  assert.equal(v.ok, false, `expected a rejection, got a pass: ${JSON.stringify(text)}`);
  return v;
};

const accept = (text, ctx = {}) => {
  const v = validateReply(text, ctx);
  assert.ok(v.ok, `expected a pass, got ${JSON.stringify(v.hard)}: ${JSON.stringify(text)}`);
  return v;
};

const has = (v, rule) =>
  assert.ok(v.hard.includes(rule), `missing "${rule}" in ${JSON.stringify(v.hard)}`);

// ==================== PARENTHETICAL OPENER ====================

test("validate: a parenthetical instruction opener is a note, not speech", () => {
  has(reject("(acknowledge, then ask back about what they said)"), "parenthetical note, not speech");
  has(reject("!(You're back, baby)"), "parenthetical note, not speech");
  has(reject("! (stage whisper) yeah, right"), "parenthetical note, not speech");
  accept("!Hello there, choom");
  has(reject("(say it in your accent)"), "parenthetical note, not speech");
  has(reject("  (one short line)"), "parenthetical note, not speech");
});

test("validate: a parenthetical mid-line is ordinary speech", () => {
  accept("Solid. (works for me)");
  accept("Damn, that's rough (I've been there).");
});

// ==================== FULLY QUOTED REPLY ====================

test("validate: a reply wrapped whole in quotes was not said", () => {
  has(
    reject('"Got the job at Militech, huh? Nice to hear that!"'),
    "quoted, not speech"
  );
  has(reject("“damn right”"), "quoted, not speech");
  has(reject('"Same as always."'), "quoted, not speech");
});

test("validate: quotes used inside a line stay legal", () => {
  accept('He said "no" and I said "fine" twice.');
  accept('They called it a "gift" — it was not.');
  // Two quoted words inside one wrap is not a full quotation, so it must not
  // be unwrapped into nonsense and rejected.
  accept('"damn" and "hell"');
});

test("stripWrappingQuotes: unwraps one full pair and nothing else", () => {
  assert.equal(stripWrappingQuotes('"damn right"'), "damn right");
  assert.equal(stripWrappingQuotes("“same as always”"), "same as always");
  assert.equal(stripWrappingQuotes('He said "no" twice'), 'He said "no" twice');
  assert.equal(stripWrappingQuotes("no quotes here"), "no quotes here");
  assert.equal(stripWrappingQuotes('"unbalanced'), '"unbalanced');
});

// ==================== ROLE CONFUSION ====================

test("validate: Chole is the agent, never the listener", () => {
  has(reject("You're doing great, Chole."), "addresses them as Chole");
  has(reject("Hey Chole, what's good?"), "addresses them as Chole");
  has(reject("Chole, how was the district?"), "addresses them as Chole");
  has(reject("damn, Chole, that's rough"), "addresses them as Chole");
  has(reject("Right, Chole — we both know how that went."), "addresses them as Chole");
  // not at the opener, and not comma-joined either — the greeting form alone
  // is enough, wherever it lands in the reply
  has(
    reject("Damn, that's good news!\n\nHey Chole, tell me more about the gig."),
    "addresses them as Chole"
  );
});

test("validate: correct self-reference to Chole stays legal", () => {
  accept("I'm Chole. What brings you out here?");
  accept("Chole here — what do you need?");
  accept("Chole would say the district's done for.", { userText: "what do you think" });
  accept("Call me whatever you like, I answer anyway.");
});

// ==================== THE EARLIER RULES STILL FIRE ====================

test("validate: the earlier leak rules still fire", () => {
  has(reject('answer="Six districts"'), "raw key=value, not speech");
  has(reject('{"frame": "greet"}'), "json blob, not speech");
  has(reject('ack_followup "damn, shit, militech"'), "frame label, not speech");
  has(
    reject("I'm sorry, but I cannot fulfill that request."),
    "refusal, not speech"
  );
  has(reject("Acknowledge their line and ask back."), "instruction, not speech");
  has(reject("**solid** work"), "markdown");
  has(reject("damn that was 🔥"), "emoji");
  has(
    reject("As an AI language model, I must inform you that the district is fine."),
    "assistant framing"
  );
});

test("validate: repeats of their line or of its own history are refused", () => {
  has(
    reject("my best friend died last night and i am really sad about it", {
      userText: "my best friend died last night",
    }),
    "echoes their line"
  );
  has(
    reject("Solid. How'd it go?", { userText: "i got the job", history: ["Solid. How'd it go?"] }),
    "verbatim repeat"
  );
  has(
    reject("Is that so?", { userText: "did you hear about the docks?" }),
    "counter-asked instead of answering"
  );
});

test("validate: quoting an EARLIER user line is the same echo", () => {
  const historyUsers = ["hey chole", "i never stopped thinking about you"];
  // Current line is innocent; the reply lifts a 6-word line from 2 turns ago.
  has(
    reject("I never stopped thinking about you. It's good to be back.", {
      userText: "i'm sorry, can you forgive me",
      historyUsers,
    }),
    "echoes their line"
  );
  // ...but short history lines can never trip it ("i love you" is 3 words).
  accept("I love you too, you know that.", {
    userText: "are you still mad at me",
    historyUsers: ["hey there", "i love you"],
  });
  // And a clean reply over a long history still passes.
  accept("Water under the bridge, choom. Sit down.", {
    userText: "i'm sorry, can you forgive me",
    historyUsers,
  });
});

test("validate: a long verbatim run fails even when the full line is not contained", () => {
  // T12 live shape: she dropped the opening clause, so full containment
  // passes — but the 20-word run is unmistakably a lift.
  has(
    reject(
      "yeah, your clinic bleeds you dry, your chooms only call when they need patching. when did anyone give you a thing?",
      {
        userText:
          "they already did it to you. your clinic bleeds you dry, your chooms only call when they need patching. when did anyone give you a thing?",
      }
    ),
    "echoes their line"
  );
  // T19 live shape: one flipped pronoun breaks containment, not the run.
  has(
    reject("that last morning before i left the first time what did you go out to get", {
      userText:
        "tell me honestly that last morning before i left the first time what did i go out to get",
    }),
    "echoes their line"
  );
  // ...while a 7-word shared run stays legal (idiom-length overlap happens).
  accept("yeah, at the afterlife bar last night was wild", {
    userText: "i left my jacket at the afterlife bar last night",
  });
});

// ==================== ORDINARY SPEECH ====================

test("validate: a second paragraph is formatting, not speech", () => {
  const twoParas = "Solid. That's a big one.\n\nHow's it feel?";
  const v = validateReply(twoParas, { userText: "i got the job" });
  assert.equal(v.ok, false, JSON.stringify(v.hard));
  assert.ok(v.hard.includes("paragraph break, not speech"), JSON.stringify(v.hard));
  // a single newline is a wrap artefact, not a decision by the model
  accept("Solid.\nHow'd it go?", { userText: "i got the job" });
});

test("validate: ordinary replies still pass", () => {
  accept("Solid. How'd it go?", { userText: "i got the job" });
  accept(
    "Damn, that's rough. You holding up okay?",
    { userText: "my best friend died last night" }
  );
  accept("Yeah, the rain's unreal tonight.", { userText: "the rain tonight is unreal" });
  accept("Six districts, same as always.");
  accept("Nah, stay put — I'll come to you.", { userText: "should I head over?" });
});

test("validate: empty and over-long replies are refused", () => {
  has(reject(""), "empty reply");
  has(reject("   "), "empty reply");
  const long = "the district goes on ".repeat(40);
  const v = validateReply(long, {});
  assert.equal(v.ok, false, "over-long must fail");
  assert.ok(v.hard.some((h) => h.startsWith("too long")), JSON.stringify(v.hard));
});
