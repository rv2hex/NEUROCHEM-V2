#!/usr/bin/env node
/**
 * REPL front door for Night City Neurochem V2.
 *
 *   npm run dev            → talk to the persona (NVIDIA NIM Nemotron, falls
 *                            back to candidate skeletons if down / no key)
 *   npm run ollama         → talk via local Ollama instead
 *   npm run dev -- --demo  → stub engine only (no network)
 *   npm run dev -- --offline → never call any engine, skeletons only
 *
 * Commands:  /state /soul /mem /tend /accent /skeletons /remember /spec /save /reset /quit
 *   /remember writes a fact into SOUL.md's owned auto-memory region, so it
 *   travels with the soul file (identity claims persist automatically).
 *   /spec stores a byte-exact text (boilerplates, vows) for verbatim recall.
 *   Sessions checkpoint every turn and resume on boot (except --demo/--offline).
 */

import readline from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { createConversation } from "../interface/converse.js";
import { chat as ollamaChat, ollamaUp, OLLAMA_DEFAULTS } from "../engine/ollama.js";
import { chat as nvidiaChat, nvidiaUp, NVIDIA_DEFAULTS } from "../engine/nvidia.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const useDemo = args.includes("--demo");
const useOllama = args.includes("--ollama");
const offline = args.includes("--offline") || useDemo;

/**
 * Lived soul, not the shipped soul. The repo's SOUL.md stays pristine so
 * tests and fresh clones always start from the same voice; real sessions
 * (memories, names, auto-chapters) accumulate in the git-ignored live copy.
 * SOUL_PATH overrides both (tests and custom personas use this).
 */
function liveSoulPath() {
  if (process.env.SOUL_PATH) return process.env.SOUL_PATH;
  const live = join(ROOT, ".sessions", "soul.live.md");
  const base = join(ROOT, "SOUL.md");
  const soulName = (file) => {
    try {
      const m = readFileSync(file, "utf8").match(/^name:\s*(.+)$/m);
      return m ? m[1].trim() : null;
    } catch {
      return null;
    }
  };
  if (!existsSync(live)) {
    mkdirSync(dirname(live), { recursive: true });
    if (existsSync(base)) copyFileSync(base, live);
  } else if (existsSync(base) && soulName(live) && soulName(base) && soulName(live) !== soulName(base)) {
    // Shipped persona changed under a lived soul (Chole → Johnny): keep the
    // old life aside and re-seed, rather than running Johnny on her memories.
    copyFileSync(live, join(ROOT, ".sessions", "soul.previous.md"));
    copyFileSync(base, live);
  }
  return live;
}

const convo = createConversation({ root: ROOT, seed: 42, soulPersist: !offline, soulPath: liveSoulPath() });

// Crash-safe continuity: the daemon checkpoints every turn and resumes on
// boot, so mood, trust and episodes survive restarts (the soul file carries
// identity + distilled facts). Hermetic in --demo/--offline.
const CHECKPOINT = process.env.NC_CHECKPOINT || join(ROOT, ".sessions", "last.json");

function saveSession(quiet = false) {
  try {
    convo.daemon.saveCheckpoint(CHECKPOINT);
    if (!quiet) console.log(`${COLORS.dim}session saved → ${CHECKPOINT}${COLORS.reset}`);
  } catch (err) {
    if (!quiet) console.log(`${COLORS.gold}! save failed: ${err.message}${COLORS.reset}`);
  }
}

const COLORS = {
  dim: "\x1b[2m",
  gold: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function stubReply(messages) {
  const last = messages[messages.length - 1]?.content || "";
  const said = last.match(/they said:\s*"(.*)"/)?.[1] ?? "";
  const words = last.match(/words: (.*)/)?.[1] ?? "";
  const first = words.match(/="?([A-Za-z']+)/)?.[1] ?? "Yeah";
  if (/\?$/.test(said.trim())) return `${first} — straight answer.`;
  return `${first.charAt(0).toUpperCase()}${first.slice(1)}. Tell me more.`;
}

const engine = useDemo
  ? { chat: async (messages) => stubReply(messages) }
  : useOllama
    ? { chat: (messages, opts) => ollamaChat(messages, { ...OLLAMA_DEFAULTS, ...opts }) }
    : { chat: (messages, opts) => nvidiaChat(messages, { ...NVIDIA_DEFAULTS, ...opts }) };

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Lines can arrive while no question is pending (piped input, fast typing).
// Buffer them so none are dropped.
const lineQueue = [];
let waiting = null;
let booted = false; // boot() finished — the queue is safe to drain
let eof = false;    // stdin ended; no further lines will arrive

rl.on("line", (line) => {
  if (waiting) {
    const cb = waiting;
    waiting = null;
    cb(line);
  } else {
    lineQueue.push(line);
  }
});

// Piped input reaches EOF while boot() is still awaiting its first round trip
// (the engine liveness probe). Exiting here killed the session before a single
// line was read, so `npm run dev` with piped stdin only ever worked in
// --offline mode — the default path exited silently at the banner. Defer the
// exit until boot() has drained what was queued.
rl.on("close", () => {
  if (booted) process.exit(0);
  eof = true;
});

function askLine() {
  process.stdout.write(`${COLORS.cyan}> ${COLORS.reset}`);
  return new Promise((resolve) => {
    if (lineQueue.length) {
      const line = lineQueue.shift();
      // echo buffered input (piped sessions)
      process.stdout.write(`${line}\n`);
      return resolve(line);
    }
    // Nothing buffered and no more coming — the session is over.
    if (eof) process.exit(0);
    waiting = resolve;
  });
}

console.log(
  `${COLORS.gold}NIGHT CITY NEUROCHEM V2${COLORS.reset} ${COLORS.dim}— /state /tend /accent /mem /soul /skeletons /remember /spec /save /reset /quit${COLORS.reset}`
);
boot();

async function boot() {
  if (offline) {
    console.log(`${COLORS.dim}offline — candidate skeletons only${COLORS.reset}`);
  } else if (useOllama) {
    if (await ollamaUp()) {
      console.log(`${COLORS.dim}ollama up — model ${process.env.OLLAMA_MODEL || OLLAMA_DEFAULTS.model}${COLORS.reset}`);
    } else {
      console.log(`${COLORS.gold}ollama down — falling back to skeletons${COLORS.reset}`);
    }
  } else {
    const model = process.env.NVIDIA_MODEL || NVIDIA_DEFAULTS.model;
    if (!process.env.NVIDIA_API_KEY) {
      console.log(`${COLORS.gold}NVIDIA_API_KEY missing — falling back to skeletons${COLORS.reset}`);
    } else if (await nvidiaUp()) {
      console.log(`${COLORS.dim}nvidia up — model ${model}${COLORS.reset}`);
    } else {
      console.log(`${COLORS.gold}nvidia down — falling back to skeletons${COLORS.reset}`);
    }
  }
  // Resume a previous session when there is one. The checkpoint may carry a
  // stale voice (prose from before the soul file changed), so the soul is
  // reloaded fresh right after — file on disk always wins.
  if (!offline && convo.daemon.loadCheckpoint(CHECKPOINT)) {
    convo.daemon.phrase.setSoul(ROOT);
    const mem = convo.daemon.memory.getStats();
    console.log(
      `${COLORS.dim}resumed session — tick ${convo.daemon.tickCount}, ` +
        `${mem.episodic} episodes, ${mem.social} people known${COLORS.reset}`
    );
  }
  printStateBrief();
  booted = true;
  ask();
}

function printProactive(items) {
  for (const item of items || []) {
    const top = item.candidates?.[0];
    if (!top) continue;
    console.log(
      `${COLORS.dim}… (she was thinking: ${convo.daemon.phrase.renderSkeleton(top)})${COLORS.reset}`
    );
  }
}

function printStateBrief() {
  const s = convo.snapshot();
  const t = s.tendencies;
  // TONE, not concentration — this line sits next to `energy 1.00` and
  // `certain 0.4`, both 0-1. Raw DA reads 0.12 at rest, which looks depleted
  // when it is exactly neutral.
  const da = (s.tones?.dopamine ?? 0.5).toFixed(2);
  console.log(
    `${COLORS.dim}[${s.mode}] tick ${s.tick} · energy ${s.energy.atp.toFixed(2)} · ` +
      `sleep ${(s.energy.sleepPressure * 100) | 0}% · DA ${da} · ` +
      `warm ${t.warm} · certain ${t.certain}${COLORS.reset}`
  );
}

async function ask() {
  const text = (await askLine()).trim();
  if (!text) return ask();

  if (text.startsWith("/")) {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    try {
      await handleCommand(cmd, text.slice(cmd.length).trim());
    } catch (err) {
      console.log(`${COLORS.gold}! ${err.message}${COLORS.reset}`);
    }
    return ask();
  }

  try {
    const t0 = Date.now();
    // Live token display: repair attempts continue the same stream with a
    // visible seam, so what you watched arrive is what got judged.
    let streamedOut = false;
    let lastAttempt = -1;
    const onToken = offline
      ? undefined
      : (tok, attempt) => {
          if (attempt !== lastAttempt) {
            lastAttempt = attempt;
            if (attempt === 0) process.stdout.write(`${COLORS.gold}◆ ${COLORS.reset}`);
            else process.stdout.write(`\n${COLORS.dim}…repairing…${COLORS.reset} `);
          }
          streamedOut = true;
          process.stdout.write(tok);
        };
    const result = await convo.converse(text, offline ? {} : { engine, onToken });
    const ms = Date.now() - t0;
    if (streamedOut) process.stdout.write("\n");
    else console.log(`${COLORS.gold}◆ ${COLORS.reset}${result.reply}`);
    console.log(
      `${COLORS.dim}  (${result.source}, ${result.prompt.tokens} tok, ${ms}ms · ` +
        `move=${result.candidates[0]?.frame ?? "-"} · warm ${result.tendencies.warm} · uncertain ${result.tendencies.uncertain})${COLORS.reset}`
    );
    printProactive(result.proactive);
    // Sleep is when learning consolidates: distill the session into the soul
    // file, decay the stores, and checkpoint — the full forever-memory loop.
    if (convo.daemon.mode === "sleeping") {
      const promoted = convo.promoteMemories();
      convo.daemon.memory.consolidate(Date.now());
      console.log(
        `${COLORS.dim}  (sleep consolidation — ${promoted.added} memories distilled to soul)${COLORS.reset}`
      );
    }
    if (!offline) saveSession(true);
  } catch (err) {
    console.log(`${COLORS.gold}! ${err.message}${COLORS.reset}`);
  }
  ask();
}

async function handleCommand(cmd, rest) {
  switch (cmd) {
    case "/quit":
    case "/exit":
      if (!offline) saveSession(true);
      rl.close();
      return;
    case "/state":
    case "/s": {
      const s = convo.snapshot();
      console.log(`${COLORS.bold}STATE${COLORS.reset} ${COLORS.dim}(tick ${s.tick}, ${s.mode})${COLORS.reset}`);
      console.log(`  narrative: ${s.narrative}`);
      console.log(
        `  energy: atp ${s.energy.atp.toFixed(2)} · sleep pressure ${(s.energy.sleepPressure * 100) | 0}% · ` +
          `stage ${s.energy.sleepStage} · cortisol ${s.energy.cortisolLevel.toFixed(2)}`
      );
      const n = s.neurochem;
      const tones = convo.daemon.neurochem.getAllTones();
      console.log(
        `  neurochem: DA ${n.dopamine.toFixed(2)} · 5HT ${n.serotonin.toFixed(2)} · NE ${n.norepinephrine.toFixed(2)} · ` +
          `OXT ${n.oxytocin.toFixed(2)} · ACh ${n.acetylcholine.toFixed(2)}`
      );
      console.log(
        `${COLORS.dim}  tones (effect scale, .5 = resting): DA ${tones.dopamine.toFixed(2)} · ` +
          `5HT ${tones.serotonin.toFixed(2)} · NE ${tones.norepinephrine.toFixed(2)} · OXT ${tones.oxytocin.toFixed(2)}${COLORS.reset}`
      );
      console.log(`${COLORS.dim}  turn ${s.turn ?? convo.turn} · memories ${s.memory.episodic}${COLORS.reset}`);
      break;
    }
    case "/tend":
    case "/tendencies": {
      const t = convo.snapshot().tendencies;
      console.log(`${COLORS.bold}ACTION TENDENCIES${COLORS.reset}`);
      for (const [k, v] of Object.entries(t)) {
        const bar = "█".repeat(Math.round(v * 10)).padEnd(10, "·");
        console.log(`  ${k.padEnd(11)} ${bar} ${v.toFixed(2)}`);
      }
      break;
    }
    case "/accent": {
      const a = convo.snapshot().accent;
      console.log(`${COLORS.bold}ACCENT${COLORS.reset} ${COLORS.dim}(from SOUL)${COLORS.reset}`);
      console.log(`  dialect: ${a.dialect} (${a.dialectKey}) — use ${a.density}`);
      console.log(`  cadence: ${a.cadence}`);
      console.log(`  sample:  "${a.sample}"`);
      break;
    }
    case "/mem": {
      const mem = convo.daemon.memory;
      const lines = mem.retrieveEpisodic({ content: rest }, { limit: 20, minActivation: -5 });
      console.log(`${COLORS.bold}MEMORIES${COLORS.reset} ${COLORS.dim}(${lines.length})${COLORS.reset}`);
      if (!lines.length) console.log(`${COLORS.dim}  (none yet — tell me something worth keeping)${COLORS.reset}`);
      for (const m of lines) console.log(`  ${m.activation.toFixed(2)}  ${m.content}`);
      break;
    }
    case "/skeletons": {
      const r = await convo.converse(rest || "show me", offline ? {} : { engine });
      console.log(`${COLORS.bold}SKELETONS${COLORS.reset}`);
      for (const c of r.candidates) {
        const words = c.slots.map((s) => `${s}="${c.words[s]}"`).join(" · ");
        console.log(`  [${c.frame}] conf ${c.confidence.toFixed(2)}  ${words}`);
        console.log(`      ${COLORS.magenta}${c.hint}${COLORS.reset}`);
      }
      break;
    }
    case "/soul": {
      if (!rest) {
        console.log(`${COLORS.dim}usage: /soul <path-to-SOUL.md>${COLORS.reset}`);
        break;
      }
      const v = convo.daemon.phrase.setSoul(rest, true);
      console.log(`${COLORS.bold}loaded soul: ${v.name} ${COLORS.dim}(${v.source})${COLORS.reset}`);
      printStateBrief();
      break;
    }
    case "/save": {
      saveSession();
      break;
    }
    case "/spec": {
      // /spec <name> :: <exact text> — byte-exact spec (boilerplates,
      // addresses, vows). Surfaced verbatim on exact tasks, never paraphrased.
      const cut = rest.indexOf("::");
      const name = (cut < 0 ? rest.split(/\s+/).slice(0, 3).join(" ") : rest.slice(0, cut)).trim();
      const text = (cut < 0 ? rest.split(/\s+/).slice(3).join(" ") : rest.slice(cut + 2)).trim();
      if (!name || !text) {
        console.log(`${COLORS.dim}usage: /spec <name> :: <exact text>${COLORS.reset}`);
        break;
      }
      convo.rememberSpec(name, text);
      console.log(`${COLORS.bold}spec stored: ${name} ${COLORS.dim}(${text.length} chars, exact)${COLORS.reset}`);
      break;
    }
    case "/reset": {
      convo.history.length = 0;
      convo.daemon.phrase.clearRecent();
      console.log(`${COLORS.dim}conversation reset${COLORS.reset}`);
      break;
    }
    case "/remember": {
      if (!rest) {
        console.log(`${COLORS.dim}usage: /remember <fact worth keeping forever>${COLORS.reset}`);
        break;
      }
      const title = rest.split(/\s+/).slice(0, 5).join(" ");
      const r = convo.rememberFact(title, rest);
      console.log(
        r.ok
          ? `${COLORS.bold}remembered: ${title} ${COLORS.dim}(${r.path})${COLORS.reset}`
          : `${COLORS.gold}! ${r.reason}${COLORS.reset}`
      );
      break;
    }
    default:
      console.log(`${COLORS.dim}unknown command: ${cmd}${COLORS.reset}`);
  }
}
