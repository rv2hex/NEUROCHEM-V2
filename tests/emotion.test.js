/**
 * Emotion taxonomy — every computed label fires on its signals and stays
 * silent at rest; tier-D vocabulary resolves without ever asserting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, resolveDisplayOnly, PRIMARIES, DYADS, FLAVORS, TIER_D } from "../src/cognitive/emotion.js";

const REST = { dopamine: 0.5, serotonin: 0.5, norepinephrine: 0.5, gaba: 0.5, oxytocin: 0.5 };
const REST_BODY = { atp: 1, cortisolLevel: 0.5, sleepPressure: 0 };
const T = (over) => ({ ...REST, ...over });
const B = (over) => ({ ...REST_BODY, ...over });

// ==================== REST SILENCE ====================

test("rest is neutral: nothing fires at 0.5 tones", () => {
  const r = evaluate({ tones: T(), body: B() });
  assert.equal(r.primary, "neutral");
  assert.deepEqual(r.dyads, []);
  assert.deepEqual(r.flavors, []);
  assert.deepEqual(r.labels, []);
});

test("every primary is silent at rest individually", () => {
  for (const p of PRIMARIES) {
    const r = evaluate({ tones: T(), body: B(), event: { intensity: 0.5 } });
    assert.ok(!r.labels.some((l) => p.grades.mild.includes(l) || p.grades.basic.includes(l) || p.grades.intense.includes(l)),
      `${p.id} leaks at rest: ${r.labels.join(",")}`);
  }
});

// ==================== PAPER-MAPPED POLES ====================

test("high serotonin reads happy; low reads sad (Afradi26 5HT)", () => {
  const up = evaluate({ tones: T({ serotonin: 0.75 }), body: B() });
  assert.ok(up.labels.includes("happiness") && up.labels.includes("joy"), `5HT high: ${up.labels.join(",")}`);
  const down = evaluate({ tones: T({ serotonin: 0.15 }), body: B() });
  assert.ok(down.labels.some((l) => ["grief", "despair", "anguish", "agony"].includes(l)), `5HT floor: ${down.labels.join(",")}`);
});

test("GABA calm needs gaba-high AND ne-low (first GABA consumer)", () => {
  const calm = evaluate({ tones: T({ gaba: 0.9, norepinephrine: 0.3 }), body: B() });
  assert.ok(calm.labels.some((l) => ["calm", "serenity", "tranquility", "bliss"].includes(l)), `calm: ${calm.labels.join(",")}`);
  // GABA high alone, with NE still up, is not calm.
  const wired = evaluate({ tones: T({ gaba: 0.9, norepinephrine: 0.8 }), body: B() });
  assert.ok(!wired.labels.some((l) => ["calm", "serenity", "tranquility", "bliss"].includes(l)),
    `wired must not read calm: ${wired.labels.join(",")}`);
});

test("oxytocin reads trust into adoration; crash reads heartbreak (temporal)", () => {
  const bonded = evaluate({ tones: T({ oxytocin: 0.95 }), body: B() });
  assert.ok(bonded.labels.includes("adoration") || bonded.labels.includes("devotion"), `OXT sat: ${bonded.labels.join(",")}`);
  const crash = evaluate({
    tones: T({ oxytocin: 0.3 }), body: B(), prev: { oxt: 0.8, cortisol: 0.5 },
  });
  assert.ok(crash.flavors.includes("heartbreak"), `OXT crash: ${crash.labels.join(",")}`);
  // No history, no phantom delta.
  const flat = evaluate({ tones: T({ oxytocin: 0.3 }), body: B() });
  assert.ok(!flat.flavors.includes("heartbreak"), "heartbreak needs a previous high");
});

test("cortisol elevation reads stress; the comedown reads relief", () => {
  const stressed = evaluate({ tones: T(), body: B({ cortisolLevel: 0.9 }) });
  assert.ok(stressed.labels.includes("stress"), `cort high: ${stressed.labels.join(",")}`);
  const relieved = evaluate({
    tones: T(), body: B({ cortisolLevel: 0.4 }), prev: { cortisol: 0.9, oxt: 0.5 },
  });
  assert.ok(relieved.flavors.includes("relief"), `comedown: ${relieved.labels.join(",")}`);
});

test("dopamine appetite: craving at saturation, desire above 0.7", () => {
  const hot = evaluate({ tones: T({ dopamine: 0.95, serotonin: 0.6 }), body: B() });
  assert.ok(hot.labels.includes("desire") || hot.labels.includes("craving"), `DA sat: ${hot.labels.join(",")}`);
});

// ==================== GRADES ====================

test("intensity grades climb mild → basic → intense", () => {
  const mild = evaluate({ tones: T({ serotonin: 0.15, dopamine: 0.5 }), body: B() });
  // 5HT 0.15 → sadness score 0.5+0.35*1.2 = 0.92 → intense. Check a milder dip:
  const dip = evaluate({ tones: T({ serotonin: 0.38 }), body: B() });
  assert.ok(dip.labels.includes("melancholy") || dip.labels.includes("pensiveness") || dip.labels.includes("gloom"),
    `mild dip: ${dip.labels.join(",")}`);
  assert.ok(mild.labels.some((l) => ["grief", "anguish", "despair"].includes(l)), `floor: ${mild.labels.join(",")}`);
});

// ==================== DYADS ====================

test("love needs joy AND trust together — neither alone suffices", () => {
  // joy = 0.5+(0.7-0.5)+(0.75-0.5) = 0.95 ties trust 0.95, and the tied dyad
  // wins the top slot over either grade word alone.
  const both = evaluate({ tones: T({ dopamine: 0.7, serotonin: 0.75, oxytocin: 0.95 }), body: B() });
  assert.ok(both.dyads.includes("love"), `joint: ${both.dyads.join(",")}`);
  assert.equal(both.primary, "love", "a maxed dyad wins the top slot");
  const joyAlone = evaluate({ tones: T({ dopamine: 0.9, serotonin: 0.9, oxytocin: 0.3 }), body: B() });
  assert.ok(!joyAlone.dyads.includes("love"), "joy without trust is not love");
});

test("remorse, contempt, ambivalence compose from their members", () => {
  const remorse = evaluate({
    tones: T({ serotonin: 0.2, dopamine: 0.5 }), body: B(),
    event: { soulDisliked: true },
  });
  assert.ok(remorse.dyads.includes("remorse"), `sad+disgust: ${remorse.dyads.join(",")}`);
  const torn = evaluate({ tones: T({ dopamine: 0.95, serotonin: 0.95, oxytocin: 0.2 }), body: B() });
  // joy without sadness is not ambivalence (needs sadness too).
  assert.ok(!torn.dyads.includes("ambivalence"), "joy without sadness is not ambivalence");
  // joy needs DA+5HT while sadness needs 5HT low — the overlap is narrow but
  // real: DA 0.9 + 5HT 0.35 gives joy 0.75 with sadness 0.68.
  const bitter = evaluate({ tones: T({ dopamine: 0.9, serotonin: 0.35 }), body: B() });
  assert.ok(bitter.dyads.includes("ambivalence"), `joy+sad: ${bitter.dyads.join(",")}`);
});

// ==================== EVENT / CONTEXT FLAVORS ====================

test("blocked goals frustrate; successes triumph", () => {
  const fail = evaluate({ tones: T(), body: B(), event: { outcome: "failure" } });
  assert.ok(fail.flavors.includes("frustration"), `failure: ${fail.labels.join(",")}`);
  const win = evaluate({ tones: T(), body: B(), event: { outcome: "success" } });
  assert.ok(win.flavors.includes("triumph"), `success: ${win.labels.join(",")}`);
});

test("correction while bonded shames; with a record it guilts", () => {
  const shame = evaluate({ tones: T({ oxytocin: 0.7 }), body: B(), event: { socialConflict: true } });
  assert.ok(shame.flavors.includes("shame"), `correction: ${shame.labels.join(",")}`);
  const guilt = evaluate({
    tones: T({ oxytocin: 0.7 }), body: B(),
    event: { socialConflict: true }, hasMemoryOfAct: true,
  });
  assert.ok(guilt.labels.includes("guilt") && guilt.labels.includes("remorse"), `record: ${guilt.labels.join(",")}`);
  // Correction from a stranger (low OXT) is just conflict, not shame.
  const cold = evaluate({ tones: T({ oxytocin: 0.2 }), body: B(), event: { socialConflict: true } });
  assert.ok(!cold.flavors.includes("shame"), "no bond, no shame");
});

test("same complaint three times exasperates; conflict history resents", () => {
  const ex = evaluate({ tones: T(), body: B(), topicRepeats: 3, scores: undefined });
  assert.ok(ex.flavors.includes("exasperation"), `repeats: ${ex.labels.join(",")}`);
  const re = evaluate({
    tones: T({ norepinephrine: 0.85, dopamine: 0.8 }), body: B({ cortisolLevel: 0.8 }), conflictCount: 2,
  });
  assert.ok(re.labels.includes("resentment"), `history: ${re.labels.join(",")}`);
});

test("old good memories nostalgize; dead air bores; questions curiousize", () => {
  const noz = evaluate({ tones: T(), body: B(), retrievalHit: true, retrievalValence: 0.8 });
  assert.ok(noz.flavors.includes("nostalgia"), `hit: ${noz.labels.join(",")}`);
  const huh = evaluate({ tones: T(), body: B(), retrievalMiss: true });
  assert.ok(huh.flavors.includes("confusion"), `miss: ${huh.labels.join(",")}`);
  const why = evaluate({ tones: T(), body: B(), event: { speechAct: "question" } });
  assert.ok(why.flavors.includes("curiosity"), `question: ${why.labels.join(",")}`);
  const meh = evaluate({ tones: T({ norepinephrine: 0.3, dopamine: 0.35 }), body: B() });
  assert.ok(meh.flavors.includes("boredom"), `dead air: ${meh.labels.join(",")}`);
});

test("comfort context with OXT reads compassion; gratitude needs all three", () => {
  const comp = evaluate({
    tones: T({ oxytocin: 0.75 }), body: B(), event: { speechAct: "comfort" },
  });
  assert.ok(comp.labels.includes("compassion"), `comfort: ${comp.labels.join(",")}`);
  const grat = evaluate({
    tones: T({ dopamine: 0.8, serotonin: 0.8, oxytocin: 0.8 }), body: B(),
    event: { kind: "social", valence: 0.6 },
  });
  assert.ok(grat.flavors.includes("gratitude"), `thanks: ${grat.labels.join(",")}`);
});

// ==================== TIER D HONESTY ====================

test("tier-D vocabulary resolves but never asserts", () => {
  assert.equal(TIER_D.length > 10, true, "a real vocabulary table, not a stub");
  for (const e of TIER_D) {
    assert.ok(e.label && e.nearest && e.why, `entry complete: ${JSON.stringify(e)}`);
    assert.deepEqual(resolveDisplayOnly(e.label), e, `${e.label} resolves`);
    assert.deepEqual(resolveDisplayOnly(e.label.toUpperCase()), e, "case-insensitive");
  }
  assert.equal(resolveDisplayOnly("joy"), null, "computed labels are NOT tier-D");
  assert.equal(resolveDisplayOnly("nope"), null, "unknown words return null");
  // And none of them can ever appear in evaluated output.
  const wide = evaluate({
    tones: T({ dopamine: 0.9, serotonin: 0.9, norepinephrine: 0.9, gaba: 0.9, oxytocin: 0.9 }),
    body: B({ cortisolLevel: 0.9 }),
    event: { intensity: 0.9, soulDisliked: true, outcome: "failure", socialConflict: true, speechAct: "comfort", kind: "social", valence: -0.9 },
    prev: { cortisol: 0.9, oxt: 0.9 }, trust: 0.9, topicRepeats: 5, conflictCount: 5,
    retrievalHit: true, retrievalValence: 0.9, hasMemoryOfAct: true,
  });
  for (const e of TIER_D) {
    assert.ok(!wide.labels.includes(e.label), `${e.label} asserted as felt — tier violation`);
  }
});

// ==================== NON-VACUITY ====================

test("thresholds are load-bearing: inverted cutoffs go quiet", () => {
  // Sadness at 5HT 0.15 scores 0.92 — far above every cutoff. If the module
  // were vacuously labeling, any state would do; demand the actual gulf.
  const low = evaluate({ tones: T({ serotonin: 0.15 }), body: B() });
  const mid = evaluate({ tones: T({ serotonin: 0.45 }), body: B() });
  assert.ok(low.scores.sadness > 0.85, `floor must pin high: ${low.scores.sadness}`);
  assert.ok(mid.scores.sadness < 0.6, `near-rest must stay mild: ${mid.scores.sadness}`);
});

test("the full 120-label user list is covered: felt or tier-D, nothing dropped", () => {
  const listed = "ecstasy,euphoria,elation,exhilaration,jubilation,glee,zest,enthusiasm,exuberance,delight,amusement,thrilled,serenity,contentment,tranquility,relief,ease,equanimity,bliss,placidity,adoration,infatuation,tenderness,compassion,empathy,sympathy,warmth,fondness,attachment,belonging,camaraderie,nurturance,amae,terror,panic,dread,horror,apprehension,agitation,trepidation,consternation,paranoia,vulnerability,unease,fright,rage,fury,outrage,wrath,resentment,exasperation,frustration,irritability,animosity,indignation,spite,vengefulness,bitterness,anguish,agony,grief,despair,melancholy,desolation,dejection,gloom,sorrow,heartbreak,homesickness,lethargy,triumph,hubris,humility,shame,guilt,remorse,regret,embarrassment,humiliation,mortification,self-pity,loathing,revulsion,contempt,scorn,disdain,abhorrence,alienation,ostracization,envy,jealousy,schadenfreude,covetousness,lust,longing,yearning,nostalgia,sehnsucht,astonishment,bewilderment,confusion,curiosity,interest,anticipation,suspense,boredom,apathy,disillusionment,awe,wonder,elevation,transcendence,sublimity,duende,mono-no-aware,saudade,bittersweetness,ambivalence,vulnerability-joy,regretful-gratitude".split(",");
  assert.equal(listed.length, 120, "the audit list itself must stay complete");
  const felt = new Set();
  for (const p of PRIMARIES) Object.values(p.grades).flat().forEach((w) => felt.add(w.toLowerCase()));
  for (const d of DYADS) { felt.add(d.label.toLowerCase()); d.synonyms.forEach((w) => felt.add(w.toLowerCase())); }
  for (const f of FLAVORS) f.labels.forEach((w) => felt.add(w.toLowerCase()));
  const unlisted = listed.filter((w) => !felt.has(w) && !resolveDisplayOnly(w));
  assert.deepEqual(unlisted, [], `dropped labels: ${unlisted.join(", ")}`);
});

test("second-fill flavors fire on their contexts", () => {
  const held = evaluate({ tones: T({ oxytocin: 0.8 }), body: B(), trust: 0.8 });
  assert.ok(held.labels.includes("attachment") && held.labels.includes("belonging"), `held: ${held.labels.join(",")}`);
  const vuln = evaluate({ tones: T({ oxytocin: 0.2, serotonin: 0.3 }), body: B() });
  assert.ok(vuln.labels.includes("vulnerability"), `exposed: ${vuln.labels.join(",")}`);
  const cast = evaluate({ tones: T({ oxytocin: 0.2 }), body: B(), trust: 0.3 });
  assert.ok(cast.labels.includes("alienation") && cast.labels.includes("ostracization"), `cast out: ${cast.labels.join(",")}`);
  const pity = evaluate({ tones: T({ serotonin: 0.25, oxytocin: 0.3 }), body: B() });
  assert.ok(pity.labels.includes("self-pity"), `alone-sad: ${pity.labels.join(",")}`);
  const ache = evaluate({ tones: T({ dopamine: 0.7 }), body: B(), retrievalMiss: true });
  assert.ok(ache.labels.includes("longing") && ache.labels.includes("yearning"), `absent: ${ache.labels.join(",")}`);
  const startled = evaluate({ tones: T({ norepinephrine: 0.85, dopamine: 0.3 }), body: B(), event: { intensity: 0.9 } });
  assert.ok(startled.dyads.includes("consternation"), `sudden dread: ${startled.dyads.join(",")}`);
  const mixed = evaluate({
    tones: T({ dopamine: 0.8, serotonin: 0.45, oxytocin: 0.8 }), body: B(),
    event: { kind: "social", valence: 0.6 },
  });
  // sadness 0.5+(0.05)*1.2 = 0.56 — just under MILD. Nudge lower:
  assert.ok(mixed.flavors.includes("gratitude"), `base gratitude: ${mixed.labels.join(",")}`);
  const rueful = evaluate({
    tones: T({ dopamine: 0.8, serotonin: 0.38, oxytocin: 0.8 }), body: B(),
    event: { kind: "social", valence: 0.6 },
  });
  assert.ok(rueful.labels.includes("regretful-gratitude"), `thankful ache: ${rueful.labels.join(",")}`);
});
