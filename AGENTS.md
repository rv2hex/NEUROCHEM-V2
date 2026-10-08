# AGENTS.md — operating instructions for AI agents in this repo

You are working in **nightcity-neurochem-v2**, a neurocomputational
conversation agent. Read this before changing anything.

## Stack

- Runtime: Node.js ≥ 20, ES modules, **zero dependencies** (no node_modules).
- Tests: built-in runner — `node --test tests/<file>.test.js`.
- Style: short functions, comment blocks explaining *why* (especially past
  bug fixes marked A–G). Match existing tone; no emojis in code or replies.

## Commands

| Task | Command |
|---|---|
| Talk (NVIDIA) | `npm run dev` (needs `NVIDIA_API_KEY`) |
| Talk (Ollama) | `npm run ollama` |
| Offline REPL | `npm run dev -- --offline` |
| New persona | `npm run soul` |
| Full tests | `npm test` (see note below) |
| Fast gate (no live models) | `node --test tests/math.test.js tests/gaps.test.js tests/identity.test.js tests/nvidia.test.js tests/validate.test.js tests/pillars.test.js tests/emotion.test.js tests/memory.test.js tests/atp.test.js tests/phrase.test.js tests/layers.test.js tests/neurochem.test.js tests/soulmemory.test.js tests/codemode.test.js` |
| Coverage | `node --experimental-test-coverage --test tests/` |

`npm test` includes live-model suites that take minutes and skip without
keys. Prefer the fast gate during development.

## Invariants (do not break)

1. **Candidates are skeletons, never sentences** — `frame + slots + words`,
   no `.text` field. The LLM writes; `validateReply` gates.
2. **Tones, not concentrations** — everything downstream reads the 0–1 tone
   scale (0.5 = rest). Raw volumes only inside `neurochem/engine.js`.
3. **`SOUL.md` stays pristine** — the suite pins its name, traits, likes,
   and diary chapters. Live sessions write to `.sessions/soul.live.md`.
4. **Secrets never touch files** — keys via environment only (`NVIDIA_API_KEY`,
   `OLLAMA_*`). Grep for `nvapi-` before every commit.
5. **`.sessions/` is runtime state** (checkpoints, live soul) — never commit.
6. **Validator changes need test updates** — stub engines in tests return
   short fixed strings; new hard rules can flip their sources. Run the gate.

## Architecture notes

- `converse()` is the whole turn: stimulus → ticks → move → retrieval →
  bridge → engine (3 attempts + repair) → fallback → log → store.
- Repair loop: `repairGuidance()` maps rule names to small-model-actionable
  corrections. Keep guidance imperative and short.
- Prompt block order matters (recency!): diary → known-facts → context →
  memories → recent → THEY JUST SAID THIS last.
- Test naming: `<source>.test.js` or thematic (`gaps`, `identity`,
  `soulmemory`, `codemode`); test names read as `should … when …`.

## Git hygiene

- Commit scope: `src/`, `tests/`, `config/`, docs, `package.json`.
- Never commit: `.sessions/`, `*.log`, `.env*`, personal `SOUL.md` variants,
  `SOUL.new.md`. `git status` must show none of these before committing.
