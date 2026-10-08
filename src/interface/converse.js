/**
 * ConversationInterface — reads daemon state, writes episodes, exposes
 * 5-channel neurochem bridge to the LLM.
 *
 * The agent NEVER generates final language. It exposes:
 *   1. Rich directive (move + behavioral guidance)
 *   2. State narrative (first-person somatic description)
 *   3. Action tendency vector
 *   4. Layer 7 candidates (neurochem-shaped, 3-5 per move)
 *   5. Adapter dataset logging (for future fine-tune)
 *
 * The LLM picks/edits a candidate or writes from scratch; validator gates.
 */

import { createDaemon } from "../daemon/index.js";
import { evaluate as evaluateEmotion } from "../cognitive/emotion.js";
import { validateReply, normalize, longestRunWords, sentences } from "./validate.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { upsertSoulMemory } from "../personality/soul.js";

export function createConversation(config = {}) {
  const daemon =
    config.daemon ||
    createDaemon({
      seed: config.seed,
      root: config.root,
      soulPath: config.soulPath,
      dialectPack: config.dialectPack,
      era: config.era,
      ...(config.productions !== undefined ? { productions: config.productions } : {}),
    });
  let history = []; // [{user, reply, act, at}]
  let turn = 0;

  // Automatic soul-file writes (identity claims persisting forever) only
  // happen when explicitly enabled — otherwise every test run against the
  // repo SOUL.md would graffiti it. Explicit rememberFact()/promoteMemories()
  // calls write whenever a soul file backs the voice, flag or not.
  const soulPersist = config.soulPersist ?? false;

  // Adapter training log (E.5)
  const trainingLog = [];

  // ---- Instruction: what the LLM must respect ----
  const OUTPUT_CONTRACT = [
    "You write ONE reply — 1-3 sentences, plain text, no quotes, no actions.",
    "A SKELETON is given: frame + slot words + your accent. Pick ONE skeleton and",
    "write it out as natural speech in your accent — fill the words into real sentences.",
    "You may swap a slot word if it doesn't fit, but keep the frame's structure and intent.",
    "The skeleton words carry your neurochemistry and accent. Do not invent a different style.",
    "A skeleton may also show: carry-over (optional) — the subject still in play",
    "from what you discussed before. OPTIONAL: weave it in if it lands naturally,",
    "otherwise ignore it completely. Never force it into the reply.",
    "Never restate their words back — not from this line, not from earlier ones. Never repeat yourself.",
    "If you agree, say it in your OWN words — never repeat their exact phrase.",
    "If they shared news or feelings: acknowledge first, then ask back.",
    "If they asked a question: answer directly, then stop.",
    "Never say goodbye unless THEY are leaving.",
    "",
    "This output IS the reply — never a description of it. No labels, no JSON,",
    "no notes on how to speak, no stage directions, no third person.",
    "Never open with an instruction (\"Acknowledge...\", \"Start by...\") — just say it.",
    "Answer THEIR LINE. If the history is about something else, drop it.",
    "The prompt's labels (they said / them / you / memories) and the skeleton",
    "block are scaffolding — never echo them, never write them back, never nest",
    "them inside each other. Write speech, not a copy of the prompt.",
    "You are Chole; they are not you.",
    "Never call them Chole — that is YOUR name, not theirs.",
    "KNOWN FACTS names them if you have learned it — use their name sometimes,",
    "never as a greeting opener, never for anyone else, and never invent one.",
    "A recall line is something said before, in THEIR words — use it only to",
    "stay consistent, in your own words. Never quote it back.",
    "Never answer with a grunt — one full sentence minimum (greetings excepted).",
  ].join("\n");

  /**
   * One turn.
   * @param {string} text user line
   * @param {object} opts { engine, personId, neurochem overrides }
   * @returns result object with prompt, candidates, and (if engine) reply
   */
  async function converse(text, opts = {}) {
    const raw = String(text || "").trim();
    if (!raw) throw new Error("text is required");

    // 1. Feed the daemon the stimulus (appraisal → neurochem)
    const personId = opts.personId || "default";
    const valence = guessValence(raw);
    const threat = /\b(kill|threat|hate|danger|scared|attack|afraid)\b/i.test(raw);
    const social = /\b(hey|hi|hello|thanks|love|friend|choom)\b/i.test(raw);
    daemon.onStimulus({
      type: threat ? "threat" : social ? "social" : valence > 0.3 ? "reward" : "neutral",
      intensity: threat ? 0.8 : social ? 0.6 : 0.5,
      valence,
      text: raw,
      personId,
    });

    // 1b. Identity claim — "call me test_hex", "i'm V", "my name is ...".
    // Persisted onto the per-person social model + a high-importance episode,
    // so a later "do you remember me?" has something true to reach for.
    // (Without this the name is never written anywhere and every such
    // question can only ever be answered "no".)
    const claimedName = extractName(raw);
    if (claimedName) {
      daemon.memory.addEvent({
        type: "social",
        personId,
        name: claimedName,
        valence: 0.4,
      });
      const epId = daemon.memory.addEvent({
        type: "episodic",
        content: `their name is ${claimedName}`,
        valence: 0.4,
        importance: 8,
        person: personId,
        tags: ["identity"],
      });
      // Forever-memory: the name follows the soul file, not the checkpoint.
      if (soulPersist) {
        const r = rememberFact(`About ${claimedName}`, `Their name is ${claimedName}.`);
        if (r.ok) {
          const rec = daemon.memory._episodicIndex.get(epId);
          if (rec) rec.promoted = true;
        }
      }
    }
    const knownName = claimedName || daemon.memory.retrieveSocial(personId)?.name || null;

    // 2. Run a few ticks so appraisal lands
    daemon.tickFor(3);

    // 3. Determine move (minimal intent: question vs statement vs share)
    const move = classifyMove(raw);
    // Code tasks switch the contract AND the validator: reproduction of
    // recalled tokens is the job, so the echo/paragraph rules that keep
    // chat honest would nuke the artifact. Scoped to explicit requests.
    const codeMode = move.speechAct === "code";

    // 4. Memory retrieval for content. A memory-seeking line ("do you
    // remember?", "what did I tell you") pulls double width plus a deeper
    // diary read — this is the agent reaching for memory on demand, so the
    // recall path gets first-class material instead of the default top-5.
    const seeking = isMemorySeeking(raw);
    const memories = daemon.memory.retrieveEpisodic(
      { content: raw },
      { limit: seeking ? 10 : 5, minActivation: -5 }
    );

    // 5. Build the 5-channel bridge
    const tendencies = daemon.phrase.actionTendencies();
    const narrative = daemon.phrase.stateNarrative();
    const feeling = buildFeeling();
    const guidance = daemon.phrase.behavioralGuidance(move, tendencies);
    const candidates = daemon.phrase.generateCandidates(
      {
        speechAct: move.speechAct,
        content: { text: memories[0]?.content || "", valence },
        topic: move.topic,
      },
      {
        seed: turn,
        userText: raw,
        speechAct: move.speechAct,
        // Literal previous line — this is what makes the skeleton remember
        // the last chat rather than only cue-matching against episodic.
        remembered: history.length ? history[history.length - 1].user : null,
      }
    );

    // Exact spec lookup for code tasks: topic + carried subjects + content
    // words as cues. Topic alone is unreliable ("code one now" → "code"),
    // so every content word gets a vote — first hit wins.
    let spec = null;
    if (codeMode) {
      const contentCues = String(raw || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4)
        .slice(0, 8);
      const cues = [
        move.topic,
        ...new Set(candidates.flatMap((c) => (c.carry ? [c.carry] : []))),
        ...contentCues,
      ].filter(Boolean);
      for (const q of cues) {
        spec = daemon.memory.recallSpec(q);
        if (spec) break;
      }
    }

    // 6. Assemble prompt (accent comes straight from the SOUL voice profile)
    const prompt = assemblePrompt({
      voice: opts.voice || buildVoiceBlock(),
      accent: daemon.phrase.accent,
      narrative,
      tendencies,
      guidance,
      candidates,
      move,
      codeMode,
      spec,
      // Diary rides the prompt as background truth, never as today's input —
      // so it sits FIRST in the context block, far from the recency slot.
      diary: seeking ? daemon.phrase.diary(2500) : daemon.phrase.diary(),
      feeling,
      knownFacts: buildKnownFacts(personId),
      memories: memories.map((m) => m.content),
      history: history.slice(-6),
      userText: raw,
    });

    let reply = null;
    let source = "candidates-only";
    const rejected = []; // every failed engine attempt, for tuning (item 4)

    // Streaming display: when the caller passes onToken AND the engine can
    // stream, tokens flow to the UI live; validation still runs on the full
    // text at the end. Engines without chatStream keep the classic path, and
    // a stream-only engine works silently when nobody listens.
    const chatFn = typeof opts.engine?.chat === "function" ? opts.engine.chat : null;
    const streamFn = typeof opts.engine?.chatStream === "function" ? opts.engine.chatStream : null;
    const forward = typeof opts.onToken === "function" ? opts.onToken : null;
    const canStream = !!streamFn && !!forward;
    let streamUsed = false;

    // 7. Engine call (LLM) if provided — first try plus two corrective
    // rewrites. A single repair meant one bad guess dropped the turn to a
    // candidate even though the engine was healthy.
    if (chatFn || streamFn) {
      const seen = history.map((h) => h.reply);
      const seenUsers = history.map((h) => h.user);
      let problems = [];
      let lastOut = null; // rejected output the repair guidance may name
      for (let attempt = 0; attempt < 3 && !reply; attempt++) {
        const msgs =
          attempt === 0
            ? prompt.messages
            : [
                ...prompt.messages,
                { role: "assistant", content: `(rejected: ${problems.join("; ")})` },
                {
                  role: "user",
                  content:
                    `That reply was rejected. ${problems.map((r) => repairGuidance(r, { userText: raw, historyUsers: seenUsers, reply: lastOut, knownName })).join(". ")}. ` +
                    (codeMode
                      ? `Output the artifact in ONE fenced \`\`\` block, then at most one spoken line. Use recalled tokens exactly as remembered.`
                      : `Write ONE reply — 1-3 sentences, plain text, starting mid-thought like speech. ` +
                        `Answer THEIR line in your own words: do not quote, label, or narrate anything.`),
                },
              ];

        let out;
        try {
          out = canStream
            ? await streamFn(msgs, opts, (tok) => {
                streamUsed = true;
                forward(tok, attempt);
              })
            : await (chatFn ?? streamFn)(msgs, opts);
        } catch {
          rejected.push({ attempt, problems: ["engine error"], output: null });
          reply = pickBestCandidate(candidates);
          source = "engine-down";
          break;
        }
        lastOut = out;

        // move + terse arm the grunt rule (single-word answers to real
        // questions get repaired into sentences instead of passing), and
        // codeMode swaps the validator into artifact rules (see validate).
        const v = validateReply(out, { userText: raw, history: seen, historyUsers: seenUsers, move, terse: tendencies.terse, allowCode: codeMode });
        if (v.ok) {
          reply = out;
          source = attempt === 0 ? "llm" : "llm-repaired";
        } else {
          problems = v.hard;
          rejected.push({ attempt, problems: [...v.hard], output: out });
        }
      }
      if (!reply) {
        reply = pickBestCandidate(candidates);
        source = "candidate-fallback";
      }
    } else {
      reply = pickBestCandidate(candidates);
      source = "candidate";
    }

    // 8. Log adapter training data (E.5)
    trainingLog.push({
      turn,
      move,
      // Volumes are concentrations; tones are the 0-1 scale the model's
      // tendencies/narrative were actually derived from, so an adapter
      // trained on this log needs both.
      neurochem: daemon.neurochem.getAllVolumes(),
      tones: daemon.neurochem.getAllTones(),
      tendencies,
      candidates,
      chosen: reply,
      source,
      rejected,
      userText: raw,
      at: Date.now(),
    });

    // 9. Record
    history.push({ user: raw, reply, act: move.speechAct, at: Date.now() });
    if (history.length > 12) history.shift();

    // 10. Store exchange as episode — BOTH sides. User-only episodes meant
    // that past the 6-turn RECENT window the model could never see what IT
    // said, only what was said to it ("remember anything?" had half the
    // conversation missing). The `||` split is stripped at render time.
    daemon.memory.addEvent({
      type: "episodic",
      content: `you said: ${raw.slice(0, 80)} || you replied: ${String(reply || "").slice(0, 80)}`,
      valence,
      importance: 3,
      person: personId,
      tags: ["exchange"],
    });

    turn++;
    // Proactive asides are returned, not discarded — the caller (CLI)
    // prints them. In active chat the queue is usually empty; after real
    // idle time the daemon may have queued spontaneity worth voicing.
    const proactive = daemon.drainProactive();

    return {
      reply,
      source,
      rejected,
      proactive,
      // True only when tokens actually flowed AND the turn stayed on-model.
      // On fallback the UI may hold partial stream text; it prints the final
      // reply line itself instead of pretending the stream was the answer.
      streamed: streamUsed && (source === "llm" || source === "llm-repaired"),
      prompt: prompt.debug,
      candidates,
      tendencies,
      narrative,
      guidance,
      snapshot: daemon.snapshot(),
      turn,
    };
  }

  // ---- Move classification (minimal V2) ----
  /**
   * One stored exchange, both sides, in the RECENT shape. Old episodes only
   * carry the user half (no `||` part) and render exactly as before.
   */
  function renderExchange(content) {
    const parts = String(content || "").split(/\s*\|\|\s*/);
    const user = parts[0].replace(/^you said:\s*/i, "").trim();
    const agent = parts
      .slice(1)
      .join(" ")
      .replace(/^you replied:\s*/i, "")
      .trim();
    return agent ? `them: ${user} / you: ${agent}` : user;
  }

  /**
   * Whether this line asks the agent to PRODUCE an artifact (code, a page,
   * the boilerplate) rather than chat. Narrow by design: verb + object, so
   * "tell me about the boilerplate" stays chat while "code one" switches
   * the contract and the validator into code mode.
   */
  function isCodeRequest(raw) {
    const t = String(raw || "").toLowerCase();
    if (/```/.test(t)) return true;
    return /\b(code|write|draft|show|paste|type)\b[^.!?]{0,40}\b(one|it|that|this|page|boilerplate|code|file|them)\b/.test(t);
  }

  function classifyMove(raw) {
    const lower = raw.toLowerCase();
    if (isCodeRequest(raw)) return { speechAct: "code", topic: extractTopic(raw) };
    if (/^(yo|hi|hey|hello|sup)\b/.test(lower)) return { speechAct: "greet", topic: null };
    if (/\b(bye|goodbye|later|see ya|goodnight)\b/.test(lower)) return { speechAct: "farewell", topic: null };
    if (raw.trim().endsWith("?") || /^(what|who|where|when|why|how)\b/.test(lower)) {
      return { speechAct: "question", topic: extractTopic(raw) };
    }
    if (/\b(died|lost|broke|fired|dumped|hurt|sad|scared|alone)\b/.test(lower)) {
      return { speechAct: "comfort", topic: extractTopic(raw) };
    }
    if (/\b(thanks|thank you|appreciate)\b/.test(lower)) return { speechAct: "comfort", topic: null };
    if (/\b(kill|hate|fight|shut up|fuck you)\b/.test(lower)) return { speechAct: "refuse", topic: null };
    return { speechAct: "assert", topic: extractTopic(raw) };
  }

  function extractTopic(raw) {
    const stop = new Set(["the", "a", "an", "is", "are", "was", "were", "i", "you", "we", "they", "it", "that", "this", "to", "of", "in", "on", "for", "and", "but", "with", "my", "your", "just", "got", "went", "have", "has", "about", "from", "at", "by"]);
    const words = raw.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter((w) => w.length > 3 && !stop.has(w));
    return words[0] || null;
  }

  // Words that look like a name claim but aren't: states, fillers, generic
  // addresses ("call me maybe", "i'm breaking up", "call me dude").
  const NAME_STOP = new Set([
    "breaking", "leaving", "sorry", "tired", "hungry", "scared", "happy", "sad",
    "glad", "mad", "sick", "busy", "late", "back", "here", "there", "good",
    "bad", "fine", "ok", "okay", "done", "lost", "hurt", "drunk", "high",
    "broke", "fired", "coming", "going", "working", "looking", "talking",
    "thinking", "kidding", "joking", "lying", "dying", "crying", "laughing",
    "asking", "telling", "saying", "not", "never", "still", "just", "really",
    "very", "so", "too", "now", "then", "again", "maybe", "baby", "honey",
    "sweetie", "dude", "man", "bro", "choom", "friend", "buddy", "chief",
    "boss", "pal", "twin", "bitch", "sure", "right", "wrong", "alive", "dead",
    "chole", "all", "one", "it", "this", "that",
  ]);

  /**
   * A claimed handle/name in this line, or null. Explicit introductions
   * only ("call me test_hex", "i'm V", "my name is ...") — never bare
   * vocabulary, so "i'm breaking up with you" yields "breaking" and is
   * stopped, not stored.
   */
  function extractName(raw) {
    const pats = [
      /\bmy name is\s+([a-zA-Z0-9_'-]{1,20})/i,
      /\bcall me\s+([a-zA-Z0-9_'-]{1,20})/i,
      /\bi(?:'m|\s+am|\s*m)\s+([a-zA-Z0-9_'-]{1,20})/i,
      /\bthis is\s+([a-zA-Z0-9_'-]{1,20})/i,
    ];
    for (const re of pats) {
      const m = String(raw || "").match(re);
      if (!m) continue;
      const cand = m[1].replace(/^['"]|['"]$/g, "");
      // Single letters only count as initials ("i'm V", not "i'm a mess").
      if (cand.length === 1 && !/[A-Z]/.test(cand)) continue;
      if (cand.length < 1 || NAME_STOP.has(cand.toLowerCase())) continue;
      return cand;
    }
    return null;
  }

  /**
   * One prescriptive feeling line from the live state. The narrative says
   * what the body feels like; this says what to DO with it — models skim
   * description but obey instruction, and description-only state is how
   * every reply comes out level ("boring fillers"). Emotion labels come
   * from the shared taxonomy, so buffers and speech can never disagree.
   * Empty at true rest, so neutral turns stay uncluttered.
   */
  function buildFeeling() {
    const tones = daemon.neurochem.getAllTones();
    const e = daemon.energy.getState();
    const emo = evaluateEmotion({ tones, body: { atp: e.atp, cortisolLevel: e.cortisolLevel } });
    if (emo.primary && emo.primary !== "neutral") {
      return `Right now you feel ${emo.primary}. Don't announce it — let it bend your word choice (sharper if it's hot, softer if it's tender, heavier if it's low).`;
    }
    const t = daemon.phrase.actionTendencies();
    if (t.warm > 0.65) return "You feel warm toward them — let it soften your edges, not your spine.";
    if (t.uncertain > 0.65) return "You're unsure of yourself — hedge, hesitate, feel your way forward.";
    if (t.terse > 0.7) return "You're clipped and dry — short sentences, no decoration.";
    if (t.impulsive > 0.7) return "You're wired and fast — let it run, don't tidy it up.";
    return "";
  }

  /**
   * Whether this line is the user reaching for memory ("do you remember?",
   * "what did I tell you", "who am I"). Widens retrieval and deepens the
   * diary read for the turn — the pull half of remembering.
   */
  function isMemorySeeking(raw) {
    const t = String(raw || "").toLowerCase();
    return /\b(remember|recall|remind|forget|forgot|forgotten)\b/.test(t) ||
      /who am i\b/.test(t) ||
      /what('s| is) my name\b/.test(t) ||
      /what did i (tell|say|teach|ask) you\b/.test(t);
  }

  /** Short background truth about the person talking to you (or ""). */
  function buildKnownFacts(personId) {    const model = daemon.memory.retrieveSocial(personId);
    if (!model) return "";
    const lines = [];
    if (model.name) lines.push(`their name: ${model.name} (use it sometimes — never Chole, never anyone else's)`);
    const talks = model.sharedHistory.length;
    if (talks) {
      lines.push(
        `you have talked ${talks} time${talks === 1 ? "" : "s"} before · trust ${model.trust.toFixed(2)} · good ${model.positiveCount} / bad ${model.conflictCount}`
      );
    }
    return lines.join("\n");
  }

  function guessValence(raw) {    const lower = raw.toLowerCase();
    // Leave/breakup vocabulary scores sad: without it a breakup reads as
    // `neutral` and trust/chemistry never move. Only you-directed forms —
    // bare "leaving"/"goodbye" stays neutral ("leaving for work, back soon"
    // must not nuke trust), and "not/never coming back" is already caught
    // by the no|not|never alternatives below. Guilt/remorse/forgiveness-
    // seeking reads sad too (confession, not attack); bare "sorry" is
    // excluded — "sorry, say again?" is a clarification, not a feeling.
    // Injustice/betrayal lands sad as well.
    const neg = /\b(sad|bad|hate|kill|angry|scared|alone|died|lost|broken|fired|dumped|hurt|broke up|break up|breaking up|leave you|leaving you|guilt|guilty|remorse|forgive|apolog|ashamed|unfair|injustice|betrayed|failed|sick|divorce|dead|depressed|anxious|no|not|never)\b/i.test(raw);
    // Laughter and beauty read glad: high-frequency, low-ambiguity signals
    // (a sarcastic "funny" is accepted noise in a keyword heuristic).
    const pos =
      /\b(good|great|love|happy|won|passed|thanks|nice|awesome|yes|yeah|promoted|hired|engaged|married|pregnant|graduated|accepted|celebrat|laugh|funny|hilarious|beautiful|gorgeous)\b/i.test(raw) ||
      /\b(got the job|got a job|got the gig|made it|it worked|said yes)\b/i.test(lower);
    if (neg && !pos) return -0.6;
    if (pos && !neg) return 0.6;
    if (pos && neg) return 0; // mixed
    return 0;
  }

  // ---- Prompt assembly ----
  function assemblePrompt(p) {
    const codeTask = p.codeMode
      ? [
          `# CODE TASK — they asked for an artifact, not chat. Output it in ONE fenced block, then at most one spoken line.`,
          `Use the recalled tokens EXACTLY as remembered — this is reproduction from memory, not quotation: reword nothing inside the block.`,
          `Ignore the skeletons' slot words for this reply; the frames don't apply. Keep the block under 30 lines.`,
          ...(p.spec
            ? [
                `# EXACT SPEC — ${p.spec.name}: reproduce the block below BYTE-FOR-BYTE inside your fence. Do not paraphrase, improve, or reorder it.`,
                "```",
                p.spec.text,
                "```",
              ]
            : []),
          ``,
        ]
      : [];
    const system = [
      `# VOICE`,
      p.voice,
      ``,
      ...codeTask,
      `# INTERNAL STATE — what you're feeling right now`,
      p.narrative,
      ``,
      ...(p.feeling
        ? [
            `# FEELING — prescriptive, not background: let this bend your word choice`,
            p.feeling,
            ``,
          ]
        : []),
      `# ACTION TENDENCIES (0=somewhat, 1=fully; inverses sum to 1)`,
      JSON.stringify(p.tendencies, null, 1),
      ``,
      `# DIRECTIVE — what this reply must do`,
      JSON.stringify(p.guidance, null, 1),
      ``,
      `# YOUR ACCENT (from your SOUL — speak like this)`,
      `dialect: ${p.accent?.dialect} — use ${p.accent?.density}`,
      `cadence: ${p.accent?.cadence}`,
      p.accent?.sample ? `how you talk: "${p.accent.sample}"` : "",
      p.accent?.sample
        ? `(an example of your voice — never quote it back, put it in your own words)`
        : "",
      ``,
      `# SKELETONS (word sets in your accent — pick ONE and write it out as your reply)`,
      p.candidates.map((c, i) =>
        [
          `${i + 1}. [${c.frame}] ${c.hint}`,
          `   words: ${c.slots.map((s) => `${s}="${c.words[s]}"`).join(" · ")}`,
          // Optional: rendered on its own line, clearly separate from the
          // required slot words, so the model can tell it may skip it.
          ...(c.carry
            ? [`   carry-over (optional — use it only if it lands): ${c.carry}`]
            : []),
          // Recall: what was actually said before, in THEIR words. Never a
          // slot and never quoted back — reword or ignore, per the contract.
          ...(c.recall
            ? [`   recall (optional — said before, reword it, never quote it): ${c.recall}`]
            : []),
        ].join("\n")
      ).join("\n"),
      ``,
      `# OUTPUT CONTRACT`,
      OUTPUT_CONTRACT,
    ].join("\n");

    const memoryBlock = p.memories.length
      ? // Strip storage prefixes (`you said:` on every episode once handed
        // the model a mantra it looped back verbatim). Both sides render in
        // the same them:/you: shape as RECENT, so no new mantra shape exists.
        `# MEMORIES\n${p.memories
          .map((m) => `- ${renderExchange(m)}`)
          .join("\n")}`
      : "";

    const historyBlock = p.history.length
      ? `# RECENT\n${p.history.map((h) => `them: ${h.user}\nyou: ${h.reply}`).join("\n")}`
      : "";

    // The current line goes LAST — right before generation. Recency decides
    // what a 1.5b model answers: when "they said" preceded MEMORIES and
    // RECENT, it replied to its own history ("friend died" -> "how's the
    // Militech job?"). Everything else is context; this is the input.
    const context = [
      p.diary
        ? `# YOUR DIARY — things that happened to you, written in your own book. Background truth, NOT today's input — answer THEIR LINE below, not this.`
          + `\n${p.diary}`
        : "",
      // Who is talking to you — a learned name and how far the history goes.
      // Background truth like the diary, so it sits just as far from recency.
      p.knownFacts
        ? `# KNOWN FACTS ABOUT THEM — background truth about the person talking to you, NOT today's input.`
          + `\n${p.knownFacts}`
        : "",
      `# CONTEXT`,
      `move: ${p.move.speechAct}`,
      `topic: ${p.move.topic || "none"}`,
      memoryBlock,
      historyBlock,
    ].filter(Boolean).join("\n\n");

    const userContent = [
      context,
      `# THEY JUST SAID THIS — answer THIS line, not the history`,
      `they said: ${JSON.stringify(p.userText)}`,
    ].join("\n\n");

    return {
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      debug: {
        channels: ["directive", "narrative", "feeling", "tendencies", "candidates", "memories", "known-facts", ...(p.codeMode ? ["code-task"] : [])],
        candidateCount: p.candidates.length,
        tokens: Math.ceil((system + userContent).length / 4),
      },
    };
  }

  /**
   * Turn a validator rule name into something a small model can act on.
   * "5 sentences" and "echoes their line" describe what went wrong; a 1.5b
   * model does much better with the correction than the diagnosis.
   */
  /**
   * Longest verbatim run of the user's normalized words that also appears
   * contiguously in the rejected reply — scanned across the current line AND
   * recent history, since the guard covers both. Capped at 6 words: enough
   * to point at, never the whole line handed back as a mantra.
   */
  function longestOverlap(userText, historyUsers, replyText, maxWords = 6) {
    const sources = [userText, ...(historyUsers || [])]
      .filter(Boolean)
      .map((s) => normalize(s).split(" ").filter(Boolean))
      .filter((w) => w.length >= 5);
    const r = normalize(replyText).split(" ").filter(Boolean);
    if (!sources.length || !r.length) return "";
    let best = [];
    for (const u of sources) {
      const run = longestRunWords(u, r);
      if (run.length > best.length) best = run;
    }
    if (!best.length) return "";
    const shown = best.slice(0, maxWords);
    return shown.join(" ") + (best.length > maxWords ? " …" : "");
  }

  function repairGuidance(reason, ctx = {}) {
    if (reason === "echoes their line") {
      const overlap = longestOverlap(ctx.userText, ctx.historyUsers, ctx.reply);
      if (overlap) {
        return (
          `you repeated "${overlap}" — say that part differently: break up ` +
          `that run of their words, reword the whole line, then add your own take`
        );
      }
      return (
        "you echoed their sentence — agree with DIFFERENT words: break up any run " +
        "of their words in a row, reword the whole line, then add your own take"
      );
    }
    const over = /^(\d+) sentences$/.exec(reason);
    if (over) return `too long: you wrote ${over[1]} sentences — compress it into 1-3`;
    if (reason === "instruction, not speech") {
      return "you copied a line of instructions instead of talking — drop it and speak plainly";
    }
    if (reason === "counter-asked instead of answering") {
      return "they asked a question — answer it plainly, then stop";
    }
    if (reason === "unprompted farewell") {
      return "you said goodbye out of nowhere — parting words only when THEY are leaving; otherwise just answer";
    }
    if (reason === "frame label, not speech") {
      return "you output a frame label instead of talking — drop the label, just say the line";
    }
    if (reason === "quoted, not speech") {
      return "the whole reply was inside quotation marks — say it directly, with no quotes around it";
    }
    if (reason === "parenthetical note, not speech") {
      return "you wrote a note in brackets — delete the brackets and say the line itself";
    }
    if (reason === "addresses them as Chole") {
      return "you called THEM Chole — never use your own name for them; Chole is YOUR name, not theirs" + (ctx.knownName ? ` (they are ${ctx.knownName} — use that instead, but never as an opener)` : "");
    }
    if (reason === "grunt, not speech") {
      return "that was a grunt, not a reply — answer in one full sentence in your own words" + (ctx.knownName ? `, using their name (${ctx.knownName}) if it lands` : "") + ", then stop";
    }
    if (reason === "paragraph break, not speech") {
      return "you split it into two paragraphs — say it as one short spoken line";
    }
    if (reason === "dodged the code") {
      return "they asked for code — output it in ONE fenced block, then at most one spoken line; use the recalled tokens exactly";
    }
    if (reason === "empty code block") {
      return "the fenced block is empty — write the artifact inside it";
    }
    const codeLong = /^code too long/.exec(reason);
    if (codeLong) {
      return "the block is too long — compress it under 30 lines";
    }
    return `fix: ${reason}`;
  }

  /**
   * Offline fallback: best skeleton rendered as text. Ranked by memory
   * anchoring + substance, not raw confidence — top-confidence is often a
   * bare frame whose render ("Damn, fair.", "Six districts.") reads as a
   * shrug precisely when the engine is down and no repair loop can save it.
   * Grunt-like renders are skipped while anything better exists.
   */
  function pickBestCandidate(candidates) {
    if (!candidates || !candidates.length) return "Yeah.";
    const scored = [...candidates].map((c) => ({
      c,
      score:
        (c.confidence ?? 0.5) +
        (c.recall ? 0.3 : 0) +
        (c.carry ? 0.2 : 0) +
        Math.min(0.2, 0.1 * Math.max(0, (c.slots?.length || 0) - 1)),
    }));
    scored.sort((a, b) => b.score - a.score);
    for (const { c } of scored) {
      const text = daemon.phrase.applyDisfluency(c);
      if (!isGruntLike(text)) return text;
    }
    return daemon.phrase.applyDisfluency(scored[0].c); // all grunts: best of a bad lot
  }

  /** A rendered fallback shaped like a grunt ("Damn, fair.", "No."). */
  function isGruntLike(text) {
    const t = String(text || "").trim();
    if (!t) return true;
    const words = normalize(t).split(" ").filter(Boolean);
    return sentences(t).length <= 1 && words.length <= 4;
  }

  /** VOICE block straight from the SOUL: identity + prose + accent. */
  function buildVoiceBlock() {
    const v = daemon.phrase.voice || {};
    const lines = [
      `You are ${v.name || "a person"}, on the streets of Night City. You are NOT an assistant — you're a person with a history in this city.`,
    ];
    if (v.prose) lines.push(`Who you are:\n${v.prose.slice(0, 2400)}`);
    lines.push(`Your accent: ${daemon.phrase.accent?.dialect} — ${v.warmthLabel}. Say it like: "${daemon.phrase.accent?.sample}"`);
    return lines.join("\n");
  }

  // ---- Commands ----
  function snapshot() {
    return daemon.snapshot();
  }

  /** Soul file backing this voice, or null (baseline/inline voices). */
  function soulFilePath() {
    const src = daemon.phrase.voice?.source;
    if (typeof src !== "string") return null;
    if (!src.endsWith(".md") && !src.endsWith(".txt")) return null;
    return existsSync(src) ? src : null;
  }

  /**
   * Write one fact into the soul file's owned auto-memory region (forever
   * memory — it travels wherever SOUL.md goes). Manual prose is untouched;
   * same title updates in place; the region is size-capped. The voice
   * reloads so diary()/accent see it without a restart.
   */
  function rememberFact(title, text) {
    const path = soulFilePath();
    if (!path) return { ok: false, reason: "no soul file backing this voice" };
    try {
      writeFileSync(path, upsertSoulMemory(readFileSync(path, "utf8"), title, text), "utf8");
      daemon.phrase.setSoul(path, true);
      return { ok: true, path };
    } catch (err) {
      return { ok: false, reason: String(err?.message || err) };
    }
  }

  /**
   * Distill what this session learned into the soul file: identity facts,
   * explicit "remember this" lines, and importance-≥9 episodes. Each
   * episode promotes once (flagged, so re-runs add nothing).
   */
  function promoteMemories() {
    let added = 0;
    for (const ep of daemon.memory._episodicIndex.values()) {
      if (ep.promoted) continue;
      const content = String(ep.content || "");
      const tags = ep.tags || [];
      const isIdentity = tags.includes("identity");
      const isExplicit = /\bremember this\b/i.test(content);
      if (!isIdentity && !isExplicit && !(ep.importance >= 9)) continue;
      let title;
      let text;
      if (isIdentity) {
        const nm = ((content.match(/their name is\s+(.+)/i) || [])[1] || "").trim().split(/\s+/)[0];
        if (!nm) continue;
        title = `About ${nm}`;
        text = `Their name is ${nm}.`;
      } else {
        const clean = content
          .replace(/^\s*you said:\s*/i, "")
          .replace(/\s*\|\|.*$/s, "")
          .replace(/^remember this[,:]?\s*/i, "")
          .trim()
          .slice(0, 280);
        if (clean.length < 10) continue;
        title = clean.split(/\s+/).slice(0, 5).join(" ").slice(0, 60);
        text = clean;
      }
      const res = rememberFact(title, text);
      if (!res.ok) break; // no file backing — leave unflagged, retry next time
      ep.promoted = true;
      added++;
    }
    return { added };
  }

  function drainProactive() {
    return daemon.drainProactive();
  }

  function trainingData() {
    return trainingLog;
  }

  return {
    converse,
    snapshot,
    drainProactive,
    trainingData,
    rememberFact,
    promoteMemories,
    rememberSpec: (name, text) => daemon.memory.rememberSpec(name, text),
    recallSpec: (query) => daemon.memory.recallSpec(query),
    daemon,
    get history() { return history; },
    get turn() { return turn; },
  };
}