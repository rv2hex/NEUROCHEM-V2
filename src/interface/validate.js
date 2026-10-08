/**
 * Validator — deterministic output gate (port from V1, simplified).
 * The agent exposes candidates; the LLM's pick/edit must pass these checks.
 */

const MAX_SENTENCES = 4;
const MAX_CHARS = 520;

const MARKDOWN = /(^|\s)([#*_]{1,3}\S)/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const STUTTER_WORD = /\b([a-z']{2,})\s+\1\b/i;
const STUTTER_LETTER = /(.)\1{3,}/;
const FYI = /\bfyi\b|\bas an ai\b/i;
const LITERAL_ESCAPE = /\\n|\\t/;

export function sentences(text) {
  return String(text || "")
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Longest verbatim run (in words) shared contiguously by two normalized
 * strings. Powers both the run-based echo rule below and the repair
 * guidance that names the offending run.
 */
export function longestRun(aWords, bWords) {
  return longestRunWords(aWords, bWords).length;
}

/** Same search, but returns the winning run itself (for repair guidance). */
export function longestRunWords(aWords, bWords) {
  let best = [];
  for (let i = 0; i < aWords.length; i++) {
    for (let j = 0; j < bWords.length; j++) {
      if (aWords[i] !== bWords[j]) continue;
      let k = 0;
      while (i + k < aWords.length && j + k < bWords.length && aWords[i + k] === bWords[j + k]) k++;
      if (k > best.length) best = aWords.slice(i, i + k);
    }
  }
  return best;
}

// An 8-word verbatim run is never coincidence in a 1-3 sentence register —
// live turns proved the model clears the full-containment bar by dropping
// just the opening clause (T12) or flipping one pronoun (T19).
export const ECHO_RUN_WORDS = 8;

export function validateReply(text, ctx = {}) {
  const hard = [];
  const soft = [];
  const trimmed = String(text || "").trim();

  if (!trimmed) return { ok: false, hard: ["empty reply"], soft: [] };

  // Code mode (ctx.allowCode from converse isCodeRequest): split speech from
  // artifact. The fenced block is reproduction from memory — the echo,
  // paragraph and sentence rules that keep chat honest would nuke it, so
  // they (and the length cap) run on the spoken lines only. The block
  // itself must exist, be non-empty, and stay short. Empty speech (a
  // code-only reply) passes the speech checks trivially.
  let check = trimmed;
  if (ctx.allowCode) {
    const parts = trimmed.split("```");
    if (parts.length < 2) {
      hard.push("dodged the code");
    } else {
      const codeText = parts.filter((_, i) => i % 2 === 1).join("\n");
      const codeLines = codeText.split("\n").filter((l) => l.trim()).length;
      if (!codeText.trim()) hard.push("empty code block");
      else if (codeLines > 40) hard.push(`code too long (${codeLines} lines)`);
      check = parts.filter((_, i) => i % 2 === 0).join("\n").trim();
    }
  }

  if (check.length > MAX_CHARS) hard.push(`too long (${check.length})`);
  const sents = sentences(check);
  if (sents.length > MAX_SENTENCES) hard.push(`${sents.length} sentences`);
  else if (sents.length > 3) soft.push("target ≤3 sentences");

  if (MARKDOWN.test(check)) hard.push("markdown");
  if (EMOJI.test(check)) hard.push("emoji");
  if (FYI.test(check)) hard.push("FYI/AI tic");
  if (LITERAL_ESCAPE.test(check)) hard.push("literal escape");
  if (STUTTER_WORD.test(check) || STUTTER_LETTER.test(check)) hard.push("stutter");

  // Verbatim repeat of recent replies
  const norm = normalize(check);
  for (const prev of ctx.history || []) {
    const pn = normalize(prev);
    if (pn && pn === norm) hard.push("verbatim repeat");
  }

  // Echo of the user's words (5+ words) — the CURRENT line or any recent
  // one. The prompt exposes every user line three times over (they-said,
  // RECENT, MEMORIES), and live turns proved the model quotes EARLIER lines
  // once the current one is guarded, so each recent line gets the same
  // containment test. ctx.historyUsers is oldest→newest; the floor stays at
  // 5 words so short lines ("i love you") can never trip it.
  //
  // Plus the run rule: full containment is cleared by dropping one clause
  // or flipping one pronoun, so any long verbatim run fails on its own.
  const replyWords = norm.split(" ").filter(Boolean);
  const userNorms = [ctx.userText, ...(ctx.historyUsers || [])]
    .filter(Boolean)
    .map(normalize)
    .filter((u) => u && u.split(" ").length >= 5);
  const echoHit = userNorms.some((u) => norm.includes(u));
  if (echoHit) {
    hard.push("echoes their line");
  } else if (userNorms.some((u) => longestRun(replyWords, u.split(" ")) >= ECHO_RUN_WORDS)) {
    hard.push("echoes their line");
  }

  // Assistant framing — a chatbot tic, not how a person starts a line.
  // Only unambiguous signals: a natural "Of course." must still pass.
  if (/^(as an ai|here (is|'s) (my|the)|sure[!,] |great question|certainly[!,] )/i.test(check)) {
    hard.push("assistant framing");
  }

  // The model occasionally emits the instruction instead of the speech:
  //   "Acknowledge that you might want to ask for more details..."
  //   "Greeting in my street slang, just back at it."
  //   answer="Six districts"
  // Openers chosen to be impossible as natural speech — deliberately NOT
  // "start by"/"respond", which a person can legitimately say.
  if (/^[a-z_]+="\S/i.test(check)) hard.push("raw key=value, not speech");
  if (/^[{[]/.test(check)) hard.push("json blob, not speech");
  // A skeleton frame name leaked ("ack_followup \"...\") — no spoken line
  // opens with snake_case.
  if (/^[a-z]+_[a-z]+/i.test(check)) hard.push("frame label, not speech");
  // The model refusing to role-play is a system message, not Chole talking.
  if (/^(i'?m sorry,? but i |i can'?t (help|assist|fulfill|provide|comply)|i cannot|i'?m unable to)/i.test(check)) {
    hard.push("refusal, not speech");
  }
  if (/^(acknowledge|greeting|describe|state that|note:|instruction|as requested|as directed)\b/i.test(check)) {
    hard.push("instruction, not speech");
  }
  // A parenthetical note instead of speech: "(acknowledge, then ask back
  // about what they said)". No line of dialogue opens in parentheses — and
  // neither does one that hides the paren behind a bang ("!(...)" walked
  // straight past the old anchor live).
  if (/^!?\s*\(/.test(check)) hard.push("parenthetical note, not speech");
  // The whole reply wrapped in one pair of quotes — the model wrote its answer
  // as a quotation rather than saying it. Quotes still inside after unwrapping
  // mean it was not a single wrap (e.g. `"damn" and "hell"`), so leave it be.
  const unwrapped = stripWrappingQuotes(check);
  if (unwrapped !== check && !/["“”]/.test(unwrapped)) hard.push("quoted, not speech");

  // The agent IS Chole; the listener is not. Only the ADDRESSING forms are
  // wrong — "I'm Chole." and "Chole here —" are correct self-reference.
  const CHOLE_VOCATIVE = [
    /^chole\s*[,;:]/i,                                           // "Chole, …"
    /[,;:]\s*chole\b/i,                                          // "… , Chole"
    /\byou('re| are)\b[^.!?]{0,60}\bchole\b/i,                   // "You're doing great, Chole."
    /\b(hey|hi|yo|hello|sup)\s+chole\b/i,                        // "Hey Chole, …" — anywhere
  ];
  if (CHOLE_VOCATIVE.some((re) => re.test(check))) {
    hard.push("addresses them as Chole");
  }
  // Two paragraphs in a one-breath contract: the model formatted rather than
  // spoke. (A single newline is a wrap artefact and is left alone.)
  if (/\n[ \t]*\n/.test(check)) hard.push("paragraph break, not speech");

  // Questions get answered, not bounced
  if (ctx.userText && ctx.userText.trim().endsWith("?")) {
    if (sents.length > 0 && sents.every((s) => s.endsWith("?"))) {
      hard.push("counter-asked instead of answering");
    }
  }

  // Unprompted farewells — parting words ("Catch you later", "See ya")
  // when THEY aren't leaving read as a conversation-ending glitch, and
  // live turns proved the model opens with them mid-chat. Only the opener
  // counts ("We'll see you later" mid-line is fine), and any leave-taking
  // in their line ("gotta go", "heading out") keeps it legal.
  if (
    /^(catch you later|see ya|goodbye|goodnight|take care|later)\b/i.test(check) &&
    !/\b(bye|goodbye|goodnight|gotta go|got to go|gtg|leaving|heading out|head out)\b/i.test(ctx.userText || "")
  ) {
    hard.push("unprompted farewell");
  }

  // Grunts are not replies. A bare "No." / "Depends" / "Damn, okay." emits a
  // skeleton slot word instead of speech — live turns proved a terse model
  // answers real questions this way ("u know my name?" → "Honestly, no.").
  // Greetings/farewells ("Yo.", "Later.") and questions are legitimate short
  // registers and stay legal, as does a truly clipped (terse ≥ 0.8) state.
  // Active ONLY when the caller passes ctx.move — bare validateReply calls
  // keep their old behavior.
  const act = ctx.move?.speechAct;
  if (act && act !== "greet" && act !== "farewell" && !check.endsWith("?")) {
    if (sents.length === 1 && replyWords.length <= 4 && (ctx.terse ?? 0.5) < 0.8 && !ctx.allowCode) {
      hard.push("grunt, not speech");
    }
  }

  return { ok: hard.length === 0, hard, soft };
}

export function stripWrappingQuotes(text) {
  const t = String(text || "").trim();
  const m = t.match(/^(["“])(.+)(["”])$/s);
  if (!m) return t;
  const closeOk = (m[1] === '"' && m[3] === '"') || (m[1] === "“" && m[3] === "”");
  if (!closeOk) return t;
  return m[2].trim() || t;
}