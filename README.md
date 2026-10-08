# Night City Neurochem V2

A neurocomputational conversation agent: 12 neurotransmitter systems, an ATP
energy economy, and 4-mode memory drive a skeleton-based phrase engine, with
an LLM filling the frames into speech. Deterministic core, zero dependencies.

## Quick start

```bash
npm run dev          # talk (NVIDIA NIM Nemotron; needs NVIDIA_API_KEY)
npm run ollama       # talk via local Ollama instead
npm run dev -- --offline   # skeletons only, no network, no writes
npm run soul         # interactive wizard: write a new SOUL.md persona
npm test             # full suite (live-model tests skip without keys)
```

Environment (never commit these — see `.gitignore`):

```bash
export NVIDIA_API_KEY='...'   # 7-day keys work; required for npm run dev
# optional overrides:
export NVIDIA_MODEL='nvidia/nemotron-3-super-120b-a12b'
export OLLAMA_MODEL='qwen2.5:1.5b' OLLAMA_ENDPOINT='http://localhost:11434'
export SOUL_PATH='/path/to/alt-SOUL.md'   # persona override for any script
export NC_CHECKPOINT='/path/to/state.json' # checkpoint override (default .sessions/last.json)
```

## How it works (30 seconds)

- `src/neurochem/engine.js` — 12 NT systems × 3 compartments, tone scale (0.5 = rest).
- `src/energy/system.js` — ATP/ADP/AMP, glycogen, sleep pressure, circadian.
- `src/memory/store.js` — episodic + semantic + procedural + social + verbatim specs.
- `src/cognitive/` — ACT-R-style cycle + Plutchik/GoEmotions taxonomy.
- `src/phrase/engine.js` — word-skeleton candidates in the SOUL's accent.
- `src/interface/converse.js` — the 5-channel bridge: directive, narrative,
  tendencies, candidates, memories. The LLM writes; `validate.js` gates.
- `src/engine/ollama.js`, `src/engine/nvidia.js` — engine clients (OpenAI-compatible).

## Souls and memory

- `SOUL.md` is the **shipped default voice** (fictional). Keep it pristine —
  the test suite pins it.
- Live sessions write to `.sessions/soul.live.md` (auto-created copy):
  claimed names, `/remember` facts, distilled chapters. Delete it for amnesia.
- `/soul <path>` loads any persona file; `npm run soul` generates one.
- Checkpoints (`.sessions/last.json`) hold tones, energy, and episodes across
  restarts. Never commit `.sessions/` — it contains real conversation data.

## CLI commands

`/state /tend /accent /mem /soul /skeletons /remember /spec /save /reset /quit`

## Tests

```bash
node --test tests/validate.test.js   # single file
node --experimental-test-coverage --test tests/   # coverage (target >80% lines)
```

Live-model tests (`ollama.test.js`, `nvidia.test.js`) run for real when the
endpoint/key is present, otherwise skip. They cost minutes; the rest of the
suite runs in seconds.
