/**
 * Night City Neurochem V2 — public API.
 *
 *   import { createConversation, createDaemon } from "nightcity-neurochem-v2";
 *
 * Architecture: three pillars (NeurochemEngine, EnergySystem, MemoryStore)
 * driven by a continuous daemon. Conversation is one input modality.
 * Language = Layer 7 PhraseEngine candidates; LLM reranks/edits.
 */

export { createNeurochemEngine, NT, NT_NAMES, RECEPTORS } from "./neurochem/engine.js";
export { createEnergySystem } from "./energy/system.js";
export { createMemoryStore } from "./memory/store.js";
export { createCognitiveCycle } from "./cognitive/cycle.js";
export { createPhraseEngine } from "./phrase/engine.js";
export { createDaemon } from "./daemon/index.js";
export { createConversation } from "./interface/converse.js";
export { validateReply, stripWrappingQuotes, sentences, normalize } from "./interface/validate.js";
export { loadSoul, parseSoulText, buildAccentPack, matchPreferences, VOICE_DEFAULTS } from "./personality/soul.js";
export { chat, ollamaUp, OllamaError, OLLAMA_DEFAULTS } from "./engine/ollama.js";