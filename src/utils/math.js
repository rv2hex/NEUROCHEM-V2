/**
 * Math utilities — zero-dep, deterministic.
 */

export const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));

export const clamp01 = (v) => clamp(v, 0, 1);

export const lerp = (a, b, t) => a + (b - a) * t;

export const sigmoid = (x, k = 1, x0 = 0) => 1 / (1 + Math.exp(-k * (x - x0)));

export const hill = (x, n, k) => {
  const xn = Math.pow(clamp01(x), n);
  return xn / (xn + Math.pow(k, n));
};

export const invertedU = (x, peak = 0.5, width = 0.3) => {
  const d = (x - peak) / width;
  return Math.exp(-0.5 * d * d);
};

export const relax = (current, target, rate, dt = 1) => {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
};

export const mulberry32 = (seed) => {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

export const gaussian = (rng, mean = 0, std = 1) => {
  // Box-Muller
  const u1 = rng();
  const u2 = rng();
  return mean + std * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

export const exponential = (rng, lambda = 1) => -Math.log(rng()) / lambda;

export const weightedPick = (rng, items, weights) => {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
};

export const softmax = (arr, temp = 1) => {
  const max = Math.max(...arr);
  const exps = arr.map(x => Math.exp((x - max) / temp));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
};