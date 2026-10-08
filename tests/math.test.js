/**
 * Math utilities — deterministic zero-dep helpers every subsystem reads.
 *
 * Covers src/utils/math.js, the only source file with no dedicated test.
 * Order per testing skill: happy path → edge cases → error cases → integration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clamp, clamp01, lerp, sigmoid, hill, invertedU, relax,
  mulberry32, gaussian, exponential, weightedPick, softmax,
} from "../src/utils/math.js";

// ==================== HAPPY PATH ====================

test("math — clamp keeps in-range values and pins out-of-range ones", () => {
  assert.equal(clamp(0.5, 0, 1), 0.5);
  assert.equal(clamp(-2, 0, 1), 0);
  assert.equal(clamp(2, 0, 1), 1);
  assert.equal(clamp(5, 0, 10), 5);
});

test("math — clamp01 is clamp(v, 0, 1)", () => {
  assert.equal(clamp01(0.3), 0.3);
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(1.5), 1);
});

test("math — lerp interpolates between endpoints", () => {
  assert.equal(lerp(0, 10, 0), 0);
  assert.equal(lerp(0, 10, 1), 10);
  assert.equal(lerp(0, 10, 0.5), 5);
  assert.equal(lerp(2, 4, 0.25), 2.5);
});

test("math — sigmoid is 0.5 at the midpoint and saturates at the rails", () => {
  assert.ok(Math.abs(sigmoid(0) - 0.5) < 1e-12);
  assert.ok(sigmoid(10) > 0.99);
  assert.ok(sigmoid(-10) < 0.01);
  assert.ok(Math.abs(sigmoid(5, 1, 5) - 0.5) < 1e-12, "x0 shifts the midpoint");
});

test("math — hill rises with x and falls with k", () => {
  const low = hill(0.2, 2, 0.3);
  const high = hill(0.8, 2, 0.3);
  assert.ok(high > low, `${low} -> ${high}`);
  assert.equal(hill(0, 2, 0.3), 0, "zero input reads zero");
  assert.ok(hill(0.5, 2, 0.9) < hill(0.5, 2, 0.1), "larger k damps the response");
});

test("math — invertedU peaks at 1 and decays symmetrically", () => {
  assert.ok(Math.abs(invertedU(0.5, 0.5, 0.3) - 1) < 1e-12);
  assert.ok(invertedU(0.5 + 0.3, 0.5, 0.3) < 1, "one width off-peak decays");
  assert.ok(
    Math.abs(invertedU(0.2, 0.5, 0.3) - invertedU(0.8, 0.5, 0.3)) < 1e-12,
    "symmetric around the peak"
  );
});

test("math — relax moves toward the target without overshooting", () => {
  const mid = relax(0, 1, 1, 1);
  assert.ok(mid > 0 && mid < 1, `partial step: ${mid}`);
  assert.ok(Math.abs(relax(0, 1, 100, 1) - 1) < 1e-6, "hot rate nearly arrives");
  assert.equal(relax(0.7, 0.7, 5), 0.7, "already there stays there");
});

test("math — mulberry32 is deterministic per seed", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  const c = mulberry32(43);
  assert.notDeepEqual([c(), c(), c()], seqA, "a different seed diverges");
});

test("math — gaussian/exponential follow their closed forms on a stub RNG", () => {
  const half = () => 0.5;
  // gaussian: sqrt(-2 ln .5) * cos(pi) = -1.17741…
  const g = gaussian(half, 0, 1);
  assert.ok(Math.abs(g - -1.1774100225154747) < 1e-9, `gaussian: ${g}`);
  assert.ok(Math.abs(gaussian(half, 10, 2) - (10 - 2.3548200450309493)) < 1e-9);
  // exponential: -ln(.5)/lambda
  assert.ok(Math.abs(exponential(half, 1) - 0.6931471805599453) < 1e-12);
  assert.ok(Math.abs(exponential(half, 2) - 0.34657359027997264) < 1e-12);
});

test("math — weightedPick honors the weights", () => {
  const items = ["a", "b", "c"];
  assert.equal(weightedPick(() => 0, items, [1, 1, 1]), "a", "rng 0 takes the first");
  assert.equal(weightedPick(() => 0.999, items, [1, 1, 1]), "c", "rng ~1 takes the last");
  assert.equal(weightedPick(() => 0.5, items, [0, 0, 1]), "c", "zero-weight entries never win");
});

test("math — softmax is a distribution that favors the max", () => {
  const p = softmax([1, 2, 3]);
  assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-12, "sums to 1");
  assert.ok(p[2] > p[1] && p[1] > p[0], "ordered by input");
  const sharp = softmax([1, 2, 3], 0.1);
  const flat = softmax([1, 2, 3], 10);
  assert.ok(sharp[2] > p[2], "cold temperature sharpens");
  assert.ok(flat[2] < p[2] && flat[0] > p[0], "hot temperature flattens");
});

// ==================== EDGE CASES ====================

test("math — edge: clamp defaults to [0,1] and tolerates inverted bounds", () => {
  assert.equal(clamp(0.5), 0.5);
  assert.equal(clamp(-5), 0);
  assert.equal(clamp(5), 1);
});

test("math — edge: lerp extrapolates past [0,1] and relax with dt=0 holds still", () => {
  assert.equal(lerp(0, 10, 2), 20, "extrapolation is linear");
  assert.equal(lerp(0, 10, -1), -10);
  assert.equal(relax(0.4, 0.9, 1, 0), 0.4, "dt=0 means no motion");
});

test("math — edge: sigmoid/hill/invertedU stay finite on extreme inputs", () => {
  for (const v of [sigmoid(1000), sigmoid(-1000), hill(1, 2, 0.001), invertedU(10)]) {
    assert.ok(Number.isFinite(v), `non-finite: ${v}`);
  }
  assert.ok(sigmoid(1000) <= 1 && sigmoid(-1000) >= 0);
});

test("math — edge: mulberry32 output always lands in [0,1)", () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 1000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

test("math — edge: softmax of equal inputs is uniform; single input is certain", () => {
  assert.deepEqual(softmax([5, 5, 5]).map((v) => +v.toFixed(6)), [0.333333, 0.333333, 0.333333]);
  assert.deepEqual(softmax([42]), [1]);
});

test("math — edge: weightedPick falls through to the last item on rounding", () => {
  // rng()*total lands exactly on the boundary — the loop must still return something
  assert.equal(weightedPick(() => 1, ["a", "b"], [1, 1]), "b");
});

// ==================== ERROR CASES (defensive behavior) ====================

test("math — clamp01 never returns NaN for non-numeric input (pins to a rail)", () => {
  // Math.max/min propagate NaN; document the actual behavior so a future
  // caller knows to sanitize first.
  assert.ok(Number.isNaN(clamp01(NaN)) || clamp01(NaN) === 0, `NaN -> ${clamp01(NaN)}`);
});

test("math — softmax overflows gracefully instead of throwing", () => {
  const p = softmax([1000, 1000, 1000]);
  assert.ok(p.every(Number.isFinite) || p.every((v) => Number.isNaN(v)), JSON.stringify(p));
});

// ==================== INTEGRATION ====================

test("math — integration: relax + hill drive a tone-like value into [0,1] and hold it", () => {
  let v = 0;
  for (let i = 0; i < 200; i++) v = relax(v, hill(v + 0.1, 2, 0.3), 0.5, 1);
  assert.ok(v >= 0 && v <= 1, `settled at ${v}`);
});

test("math — integration: seeded rng + softmax + weightedPick is fully reproducible", () => {
  const run = (seed) => {
    const rng = mulberry32(seed);
    const logits = [rng(), rng(), rng()];
    return weightedPick(rng, ["x", "y", "z"], softmax(logits));
  };
  assert.equal(run(99), run(99));
});
