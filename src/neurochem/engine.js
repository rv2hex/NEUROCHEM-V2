/**
 * NeurochemEngine — 12 neurotransmitter systems as coupled ODE compartments.
 * 
 * Each NT has: soma (synthesis/storage), synaptic (phasic release), volume (tonic spillover)
 * Receptor binding kinetics per region (handled by CognitiveCycle via gain modulation)
 * Cross-system couplings: cortisol↔DA/5-HT synthesis, DA-5-HT opponency, OXT→amygdala, ECB→DSI/DSE, etc.
 */

import { clamp01, relax, hill, invertedU } from "../utils/math.js";

/** Compartment indices */
const SOMA = 0;
const SYNAPTIC = 1;
const VOLUME = 2;

/** NT system indices */
export const NT = {
  DOPAMINE: 0,
  SEROTONIN: 1,
  NOREPINEPHRINE: 2,
  ACETYLCHOLINE: 3,
  GABA: 4,
  GLUTAMATE: 5,
  OPIOID: 6,
  OXYTOCIN: 7,
  ENDOCANNABINOID: 8,
  OREXIN: 9,
  HISTAMINE: 10,
  MELATONIN: 11,
};

export const NT_NAMES = [
  "dopamine", "serotonin", "norepinephrine", "acetylcholine",
  "gaba", "glutamate", "opioid", "oxytocin",
  "endocannabinoid", "orexin", "histamine", "melatonin",
];

export const NT_COUNT = NT_NAMES.length;

/** Receptor subtypes per NT (simplified for gain modulation) */
export const RECEPTORS = {
  [NT.DOPAMINE]: ["D1", "D2", "D3", "D4", "D5"],
  [NT.SEROTONIN]: ["5HT1A", "5HT2A", "5HT3", "5HT7"],
  [NT.NOREPINEPHRINE]: ["alpha2A", "alpha1", "beta"],
  [NT.ACETYLCHOLINE]: ["M1", "M2", "alpha4beta2", "alpha7"],
  [NT.GABA]: ["GABA_A", "GABA_B"],
  [NT.GLUTAMATE]: ["NMDA", "AMPA", "mGluR"],
  [NT.OPIOID]: ["mu", "kappa", "delta"],
  [NT.OXYTOCIN]: ["OXTR"],
  [NT.ENDOCANNABINOID]: ["CB1", "CB2"],
  [NT.OREXIN]: ["OX1R", "OX2R"],
  [NT.HISTAMINE]: ["H1", "H3"],
  [NT.MELATONIN]: ["MT1", "MT2"],
};

/** Default parameters per NT system */
const DEFAULT_PARAMS = {
  [NT.DOPAMINE]: {
    synthesis_rate: 0.02,      // per second at baseline
    vesicular_release: 0.15,   // fraction per phasic burst
    reuptake_rate: 0.8,        // DAT clearance (synaptic)
    enzymatic_rate: 0.05,      // MAO/COMT (volume)
    volume_diffusion: 0.02,    // synaptic → volume
    autoreceptor_sensitivity: 0.3, // D2 autoreceptor feedback
    baseline_tonic: 0.12,      // volume compartment baseline
  },
  [NT.SEROTONIN]: {
    synthesis_rate: 0.015,
    vesicular_release: 0.12,
    reuptake_rate: 0.6,        // SERT
    enzymatic_rate: 0.04,      // MAO-A
    volume_diffusion: 0.015,
    autoreceptor_sensitivity: 0.4, // 5HT1A
    baseline_tonic: 0.1,
  },
  [NT.NOREPINEPHRINE]: {
    synthesis_rate: 0.018,     // from DA via DBH
    vesicular_release: 0.18,
    reuptake_rate: 0.7,        // NET
    enzymatic_rate: 0.045,     // MAO/COMT
    volume_diffusion: 0.025,
    autoreceptor_sensitivity: 0.35, // alpha2
    baseline_tonic: 0.08,
  },
  [NT.ACETYLCHOLINE]: {
    synthesis_rate: 0.025,
    vesicular_release: 0.2,
    reuptake_rate: 0.0,        // no reuptake, hydrolyzed
    enzymatic_rate: 0.5,       // AChE (very fast)
    volume_diffusion: 0.03,
    autoreceptor_sensitivity: 0.2, // M2
    baseline_tonic: 0.05,
  },
  [NT.GABA]: {
    synthesis_rate: 0.03,
    vesicular_release: 0.25,
    reuptake_rate: 0.4,        // GAT
    enzymatic_rate: 0.03,      // GABA-T
    volume_diffusion: 0.02,
    autoreceptor_sensitivity: 0.25, // GABA_B
    baseline_tonic: 0.3,
  },
  [NT.GLUTAMATE]: {
    synthesis_rate: 0.04,
    vesicular_release: 0.3,
    reuptake_rate: 0.9,        // EAAT (very fast)
    enzymatic_rate: 0.02,
    volume_diffusion: 0.01,
    autoreceptor_sensitivity: 0.2, // mGluR2/3
    baseline_tonic: 0.15,
  },
  [NT.OPIOID]: {
    synthesis_rate: 0.008,
    vesicular_release: 0.1,
    reuptake_rate: 0.0,
    enzymatic_rate: 0.02,
    volume_diffusion: 0.03,
    autoreceptor_sensitivity: 0.15,
    baseline_tonic: 0.04,
  },
  [NT.OXYTOCIN]: {
    synthesis_rate: 0.005,
    vesicular_release: 0.08,
    reuptake_rate: 0.0,
    enzymatic_rate: 0.01,
    volume_diffusion: 0.04,    // wide volume transmission
    autoreceptor_sensitivity: 0.1,
    baseline_tonic: 0.02,
  },
  [NT.ENDOCANNABINOID]: {
    synthesis_rate: 0.0,       // on-demand, not stored
    vesicular_release: 0.0,
    reuptake_rate: 0.0,
    enzymatic_rate: 0.05,      // FAAH/MAGL
    volume_diffusion: 0.05,    // retrograde, very local
    autoreceptor_sensitivity: 0.0,
    baseline_tonic: 0.01,
  },
  [NT.OREXIN]: {
    synthesis_rate: 0.006,
    vesicular_release: 0.1,
    reuptake_rate: 0.0,
    enzymatic_rate: 0.015,
    volume_diffusion: 0.03,
    autoreceptor_sensitivity: 0.1,
    baseline_tonic: 0.03,
  },
  [NT.HISTAMINE]: {
    synthesis_rate: 0.007,
    vesicular_release: 0.12,
    reuptake_rate: 0.0,
    enzymatic_rate: 0.02,
    volume_diffusion: 0.025,
    autoreceptor_sensitivity: 0.2, // H3
    baseline_tonic: 0.04,
  },
  [NT.MELATONIN]: {
    synthesis_rate: 0.0,       // driven by circadian, not tonic
    vesicular_release: 0.0,
    reuptake_rate: 0.0,
    enzymatic_rate: 0.03,
    volume_diffusion: 0.04,
    autoreceptor_sensitivity: 0.0,
    baseline_tonic: 0.0,
  },
};

/**
 * Fraction of a phasic burst that spills straight into the bulk compartment.
 * The cleft clears faster than diffusion can carry a burst across, so without
 * this a reward never moves getTone(). Declared once here rather than twelve
 * times in DEFAULT_PARAMS — merged in below so `config.params[nt].volume_spill`
 * can still override it.
 */
const DEFAULT_VOLUME_SPILL = 0.35;

/** Melatonin's night-time target — it has no tonic baseline by design. */
const MELATONIN_NIGHT_TARGET = 0.2;

/**
 * Floor on phasic-signal clearance in the cleft (per second, τ ≈ 3.3 s).
 * Without it every zero-reuptake system clears at exactly 0.
 */
const MIN_BUFFER_CLEARANCE = 0.3;

for (const p of Object.values(DEFAULT_PARAMS)) {
  if (p.volume_spill == null) p.volume_spill = DEFAULT_VOLUME_SPILL;
}

/**
 * Circadian melatonin drive — peaks at midnight (phase 0 / 1), zero across the
 * day. Used for BOTH the tonic level and the supply rate; the two used to be
 * written out separately and disagreed with each other.
 */
function melatoninDrive(circadianPhase) {
  return Math.max(0, Math.cos(circadianPhase * 2 * Math.PI));
}

/**
 * Create a NeurochemEngine with 12 NT systems × 3 compartments.
 * State: Float32Array[NT_COUNT * 3] — [soma, synaptic, volume] per NT
 *
 * The integration is fully deterministic (coupled ODEs, no RNG), so
 * `config.seed` is accepted for symmetry with the other subsystems and has no
 * effect on the trajectory.
 */
/**
 * The autoreceptor brake bottoms out here rather than at zero, so a saturated
 * system still releases a trickle. See releasePhasic().
 */
const BRAKE_FLOOR = 0.1;

export function createNeurochemEngine(config = {}) {
  // Deep per-system copy: a shallow spread would leave every untouched NT
  // sharing DEFAULT_PARAMS' inner object, so fromJSON/params mutation would
  // leak across engine instances.
  const params = {};
  for (const [nt, p] of Object.entries(DEFAULT_PARAMS)) params[nt] = { ...p };
  if (config.params) {
    for (const [nt, p] of Object.entries(config.params)) {
      params[nt] = { ...(params[nt] ?? {}), ...p };
    }
  }

  // State: [NT][compartment]
  const state = new Float32Array(NT_COUNT * 3);
  const phasicBuffers = new Float32Array(NT_COUNT); // pending phasic releases
  const receptorOccupancy = new Float32Array(NT_COUNT); // simplified: volume occupancy
  // Receptor density (trafficking). 1.0 = set point; chronic high tone
  // downregulates, chronic low tone upregulates, sleep restores it faster.
  const receptorDensity = new Float32Array(NT_COUNT).fill(1);

  /**
   * Per-system calibration, derived from `params`:
   *
   *   toneRef         concentration that reads as neutral (0.5) on the tone scale
   *   bufferClearance phasic-signal clearance in the cleft, floored > 0
   *   cleftSource     tonic source making the resting cleft level exact
   *   bulkSource      tonic source making baseline_tonic the exact fixed point
   *
   * Re-run whenever params change (i.e. after a checkpoint restore).
   */
  const toneRef = new Float32Array(NT_COUNT);
  const bufferClearance = new Float32Array(NT_COUNT);
  const cleftSource = new Float32Array(NT_COUNT);
  const bulkSource = new Float32Array(NT_COUNT);

  function deriveCalibration() {
    for (let nt = 0; nt < NT_COUNT; nt++) {
      const p = params[nt];

      // TONE reference. For every tonic system this is baseline_tonic; for
      // melatonin it is its night-time target, because baseline_tonic is 0 by
      // design. getTone() used to fall back to the raw concentration when
      // baseline_tonic was 0, which pegged melatonin at 0.200 at midnight while
      // everything else sat at 0.500 — an off-scale read (bug D).
      toneRef[nt] = nt === NT.MELATONIN ? MELATONIN_NIGHT_TARGET : p.baseline_tonic;

      // Phasic-signal clearance. It used to be `reuptake_rate × 5`, which is
      // exactly 0 for ACh, opioid, OXT, ECB, orexin, histamine and melatonin —
      // their buffers grew without bound (OXT reached 3.6 after 600 ticks) and
      // were serialized into every checkpoint (bug B).
      bufferClearance[nt] = Math.max(
        p.buffer_clearance ?? 0,
        p.reuptake_rate,
        p.enzymatic_rate,
        MIN_BUFFER_CLEARANCE
      );

      /**
       * Calibrated tonic sources — the resting steady state, solved once.
       *
       * Synthesis fills the soma reserve, but the soma has no transfer into the
       * cleft: without an explicit source the compartments only ever drain, and
       * every level decays to zero within seconds of simulation. So instead of
       * hoping the ODEs land on the reference level, we solve for the sources
       * that make it the EXACT fixed point:
       *
       *   cleft:  0 = src_s - s*ks - (s - v)*vd
       *   bulk:   0 = src_v + (s - v)*vd - v*en
       *
       * where v = toneRef, s = the cleft level it can actually sustain
       * (s >= v*vd/(ks+vd), which is what fast-clearing systems like glutamate
       * settle on). `drive` then modulates both sources, so energy, orexin,
       * stress and opponent tone move tonic levels the way they should.
       */
      const v0 = toneRef[nt];
      if (v0 <= 0) continue;
      const isHydrolyzed =
        nt === NT.ACETYLCHOLINE || nt === NT.GLUTAMATE || nt === NT.ENDOCANNABINOID;
      const ks = isHydrolyzed ? p.enzymatic_rate : p.reuptake_rate;
      const s0 = Math.max(v0 * 0.1, (v0 * p.volume_diffusion) / (ks + p.volume_diffusion));
      cleftSource[nt] = Math.max(0, s0 * ks + (s0 - v0) * p.volume_diffusion);
      bulkSource[nt] = Math.max(0, v0 * p.enzymatic_rate - (s0 - v0) * p.volume_diffusion);
    }
  }

  // Per-step drive for each system, resolved from the PRE-step state so the
  // DA↔5-HT opponent coupling is symmetric across the pair.
  const drives = new Float32Array(NT_COUNT);

  // Initialize to baselines
  for (let nt = 0; nt < NT_COUNT; nt++) {
    const base = params[nt].baseline_tonic;
    state[nt * 3 + VOLUME] = base;
    state[nt * 3 + SYNAPTIC] = base * 0.1;
    state[nt * 3 + SOMA] = 1.0; // synthesis capacity
    // Occupancy used to stay 0 until the first step() — anything reading gains
    // at t=0 got an exact zero.
    receptorOccupancy[nt] = hill(base, 2, 0.3);
  }

  deriveCalibration();

  // Cross-coupling coefficients (from literature)
  const couplings = {
    // Cortisol → supply: suppresses how fast the vesicular reserve refills
    cortisol_to_da_synthesis: -0.3,
    cortisol_to_5ht_synthesis: -0.25,
    /**
     * DA ↔ 5-HT opponency — DIMENSIONLESS gain on the opponent's tonic drive.
     *
     * This used to be added straight onto `synthesis` as an absolute rate
     * (−0.15 × volume ≈ −0.015 against a rate of 0.02 = −75%). The autoreceptor
     * then drained the soma faster than it refilled, so 5-HT's reserve hit
     * 0.000 after ~30 simulated minutes and every later burst was capped at the
     * dregs — the agent's response to punishment decayed the longer it ran
     * (bug A). Keyed off TONE (0-1) instead, it rests at exactly 1.0 when both
     * systems sit at baseline, and is bounded to [0.7, 1.3].
     */
    da_inhibits_5ht: 0.3,
    ht5_inhibits_da: 0.3,
    // Orexin → wakefulness → all monoamine tonic level
    orexin_to_monoamine: 0.1,
    // Sustained load → tonic LC (NE) drive. A level, not a burst-per-tick.
    stress_to_ne: 0.5,
  };

  // Phasic burst schedules (for reward/punishment/novelty)
  const phasicSchedule = [];

  function get(nt, compartment = VOLUME) {
    return state[nt * 3 + compartment];
  }

  function set(nt, compartment, value) {
    state[nt * 3 + compartment] = clamp01(value);
  }

  function getVolume(nt) {
    return state[nt * 3 + VOLUME];
  }

  function getAllVolumes() {
    const out = {};
    for (let nt = 0; nt < NT_COUNT; nt++) {
      out[NT_NAMES[nt]] = state[nt * 3 + VOLUME];
    }
    return out;
  }

  /**
   * TONE — concentration rescaled to an effect scale for cognition/phrasing.
   *
   * Volume compartments are concentrations (DA sits ~0.12, OXT ~0.02 at rest),
   * so raw volumes read as "depleted" against a 0-1 axis. Tone maps each
   * system's own reference concentration to 0.5 (neutral), rising toward 1.0
   * as the concentration climbs:
   *
   *     tone = volume² / (volume² + toneRef[nt]²)
   *
   * This is Weber–Fechner: taking logs, `logit(tone) = 2·log(volume / ref)` —
   * perceived intensity proportional to the log of the stimulus, bounded so it
   * can never leave [0,1].
   *
   * The exponent is what makes it a drop-in replacement rather than a
   * rescaling. Expanding about rest, `v²/(v² + ref²) = v/(2·ref) + O((v-ref)²)`,
   * so at and around neutral it reproduces the old linear
   * `clamp01(volume / (2 * toneRef[nt]))` — same slope, same neutral point,
   * same downstream magnitudes. What differs is above the clip: the old map
   * read every volume past 2× ref as exactly 1.0, and one reward carries DA
   * to roughly 4× ref. So the autoreceptor brake locked on and a second
   * reward was indistinguishable from the first — the reward channel blind
   * precisely when saturated. This curve keeps bending, so the top of the
   * scale still resolves.
   *
   * toneRef is per-system, so melatonin (no tonic baseline, driven to 0.2 at
   * night) lands on the same scale as everything else.
   *
   * Everything downstream (tendencies, narrative, skeleton choice) reads tone,
   * never raw concentration.
   */
  function getTone(nt) {
    const volume = state[nt * 3 + VOLUME];
    const ref = toneRef[nt];
    if (!(ref > 0)) return clamp01(volume);
    return clamp01((volume * volume) / (volume * volume + ref * ref));
  }

  /** The concentration this system reads as neutral on the tone scale. */
  function getToneRef(nt) {
    return toneRef[nt];
  }

  function getAllTones() {
    const out = {};
    for (let nt = 0; nt < NT_COUNT; nt++) {
      out[NT_NAMES[nt]] = getTone(nt);
    }
    return out;
  }

  function getToneByName(name) {
    const nt = NT_NAMES.indexOf(name);
    return nt < 0 ? 0.5 : getTone(nt);
  }

  function getAllSynaptics() {
    const out = {};
    for (let nt = 0; nt < NT_COUNT; nt++) {
      out[NT_NAMES[nt]] = state[nt * 3 + SYNAPTIC];
    }
    return out;
  }

  function getAllSomas() {
    const out = {};
    for (let nt = 0; nt < NT_COUNT; nt++) {
      out[NT_NAMES[nt]] = state[nt * 3 + SOMA];
    }
    return out;
  }

  /** Schedule a phasic burst (e.g., reward → DA burst) */
  function schedulePhasic(nt, magnitude, delay = 0) {
    phasicSchedule.push({ nt, magnitude: clamp01(magnitude), time: delay });
  }

  /**
   * Trigger immediate phasic release.
   *
   * The autoreceptor BRAKES release — that is what a presynaptic D2/5HT1A
   * actually does: high tonic level in the cleft means "ease off". It used to
   * drain the storage pool in proportion to tonic volume instead, which is bug
   * A (see step()). Braking release keeps the feedback loop while leaving the
   * reserve itself intact.
   *
   * BRAKE_FLOOR keeps that loop from closing shut. `1 - tone*sens*2` reaches
   * exactly zero once sensitivity hits 0.5 at full tone, and release with it —
   * so the reward channel would go blind precisely when the system is
   * saturated, which is when it most needs to register one. A saturated system
   * still releases, just quietly. Default params top out at 0.4 sensitivity
   * (brake 0.2), so the floor only binds under an override.
   */
  function releasePhasic(nt, magnitude) {
    const p = params[nt];
    const brake =
      p.autoreceptor_sensitivity > 0
        ? Math.max(BRAKE_FLOOR, clamp01(1 - getTone(nt) * p.autoreceptor_sensitivity * 2))
        : 1;
    const available = state[nt * 3 + SOMA];
    const release = Math.min(available, magnitude * p.vesicular_release * brake);
    state[nt * 3 + SOMA] -= release;
    state[nt * 3 + SYNAPTIC] += release;
    phasicBuffers[nt] += release;
    // Volume transmission: a burst spills into the extracellular compartment,
    // which is the one getTone() reads. Without this a reward never moves the
    // tone — the cleft clears too fast for diffusion to carry it across.
    state[nt * 3 + VOLUME] = clamp01(state[nt * 3 + VOLUME] + release * p.volume_spill);
  }

  /**
   * Drive factor for the tonic sources — how far above/below its calibrated
   * resting rate this system is currently expressed. 1.0 = exactly baseline.
   *
   *   global:      energy × orexin (permissive — low energy lowers everything)
   *   DA ↔ 5-HT:   opponent tone, dimensionless, rests at exactly 1.0
   *   DA/5-HT:     cortisol suppresses supply (one term — the dead second
   *                copy in step() used to disagree with this one by a ×2)
   *   NE:          sustained load raises tonic LC drive
   *   melatonin:   circadian (pineal), high overnight, zero by day
   *   orexin:      wakefulness (collapses during sleep)
   *
   * Deliberately NOT clamped to [0,1] — drive > 1 means a genuinely elevated
   * tonic level, and clamping it would make every upward coupling inert. Bounded
   * at 2 instead, and the resulting concentration is clamped separately.
   */
  function driveFor(nt, ctx) {
    const { energyFactor, orexinFactor, circadianPhase, wakefulness, stress, cortisol } = ctx;

    if (nt === NT.MELATONIN) return melatoninDrive(circadianPhase);
    if (nt === NT.OREXIN) return wakefulness;

    let drive = energyFactor * orexinFactor;

    // DA ↔ 5-HT opponency, keyed off the opponent's TONE. Both sides read the
    // pre-step state (see drives[] in step), so neither gets a head start.
    if (nt === NT.DOPAMINE) {
      drive *= 1 - couplings.da_inhibits_5ht * (getTone(NT.SEROTONIN) - 0.5) * 2;
      drive *= 1 + couplings.cortisol_to_da_synthesis * (cortisol - 0.5);
    } else if (nt === NT.SEROTONIN) {
      drive *= 1 - couplings.ht5_inhibits_da * (getTone(NT.DOPAMINE) - 0.5) * 2;
      drive *= 1 + couplings.cortisol_to_5ht_synthesis * (cortisol - 0.5);
    } else if (nt === NT.NOREPINEPHRINE) {
      drive *= 1 + couplings.stress_to_ne * stress;
    }

    return Math.max(0, Math.min(2, drive));
  }

  /** Main integration step (dt in seconds) */
  function step(dt, context = {}) {
    const {
      cortisol = 0.5,
      energy = 1.0,
      circadian_phase = 0.5, // 0-1
      stress = 0,
      wakefulness = 1,
    } = context;

    // Process scheduled phasic bursts
    for (let i = phasicSchedule.length - 1; i >= 0; i--) {
      const item = phasicSchedule[i];
      item.time -= dt;
      if (item.time <= 0) {
        releasePhasic(item.nt, item.magnitude);
        phasicSchedule.splice(i, 1);
      }
    }

    // Phasic events (reward / punishment / novelty / social contact) are
    // EVENTS and enter through schedulePhasic() — the daemon's onStimulus does
    // exactly that. The four auto-trigger branches that used to live here were
    // unreachable from the daemon (it passed 0 / 0.1 against thresholds of
    // 0.3-0.5) and, worse, would have re-fired on every tick their condition
    // held: an unbounded burst train in a 1 Hz loop. Removed rather than tuned.

    // Energy modulates supply globally; orexin is a permissive monoamine gain.
    const energyFactor = clamp01(energy * 1.2);
    const orexinFactor = 1 + couplings.orexin_to_monoamine * getVolume(NT.OREXIN);

    // Resolve every system's drive from the PRE-step state, so the DA↔5-HT
    // opponent coupling is symmetric (DA is index 0 and would otherwise read
    // 5-HT's already-updated level).
    const driveCtx = {
      energyFactor,
      orexinFactor,
      circadianPhase: circadian_phase,
      wakefulness,
      stress,
      cortisol,
    };
    for (let nt = 0; nt < NT_COUNT; nt++) drives[nt] = driveFor(nt, driveCtx);

    // Step each NT system
    for (let nt = 0; nt < NT_COUNT; nt++) {
      const p = params[nt];
      const soma = state[nt * 3 + SOMA];
      const synaptic = state[nt * 3 + SYNAPTIC];
      const volume = state[nt * 3 + VOLUME];

      // Synthesis (soma compartment)
      let synthesis = p.synthesis_rate * energyFactor * orexinFactor;
      
      // Cortisol coupling for DA and 5-HT
      if (nt === NT.DOPAMINE) synthesis *= (1 + couplings.cortisol_to_da_synthesis * (cortisol - 0.5));
      if (nt === NT.SEROTONIN) synthesis *= (1 + couplings.cortisol_to_5ht_synthesis * (cortisol - 0.5));
      
      // Opponent coupling lives in driveFor() — it acts on the tonic LEVEL,
      // not on this supply rate. Adding it here as an absolute rate is what
      // put the reserve out of reach (bug A).

      // Melatonin driven by circadian (pineal) — same helper that sets its
      // tonic level, so the two can't drift apart.
      if (nt === NT.MELATONIN) synthesis = melatoninDrive(circadian_phase) * 0.02;

      // Orexin driven by wakefulness
      if (nt === NT.OREXIN) {
        synthesis = wakefulness * 0.01;
      }

      /**
       * Supply: the vesicular reserve refills at the synthesis rate and is
       * drawn down ONLY by an actual burst (releasePhasic). It used to be
       * drained every single step in proportion to tonic volume, which with
       * the opponent term added onto synthesis settled 5-HT's reserve at an
       * equilibrium of 0.015 and DA's at 0.135 — see bug A.
       */
      state[nt * 3 + SOMA] = clamp01(soma + synthesis * dt);

      /**
       * Compartment update.
       *
       * Two bugs lived here: the assignments read the pre-diffusion locals
       * (`synaptic`/`volume`), so the diffusion applied one line earlier was
       * silently discarded; and reuptake — a cleft process — was charged 30%
       * against the volume, which drains it permanently. Each compartment now
       * loses only what actually acts on it, and both get their source.
       */
      const drive = drives[nt];

      // Cleft sinks: reuptake (DAT/SERT/NET), plus extracellular hydrolysis
      // for the fast-clearing transmitters.
      const isHydrolyzed =
        nt === NT.ACETYLCHOLINE || nt === NT.GLUTAMATE || nt === NT.ENDOCANNABINOID;
      const cleftLoss = synaptic * (isHydrolyzed ? p.enzymatic_rate : p.reuptake_rate);
      // Bulk sink: enzymatic degradation (MAO/COMT and friends)
      const bulkLoss = volume * p.enzymatic_rate;
      // Diffusion down the gradient; positive → cleft → volume
      const diffusion = (synaptic - volume) * p.volume_diffusion;

      const dCleft = cleftSource[nt] * drive - cleftLoss - diffusion;
      const dBulk = bulkSource[nt] * drive + diffusion - bulkLoss;

      state[nt * 3 + SYNAPTIC] = clamp01(synaptic + dCleft * dt);
      state[nt * 3 + VOLUME] = clamp01(volume + dBulk * dt);

      // Autoreceptor feedback now BRAKES RELEASE (see releasePhasic) rather
      // than draining the storage pool — draining it here is bug A.

      // Receptor occupancy: ligand level × receptor density. Density drifts
      // with chronic tone and is pulled back to its set point, faster during
      // sleep (applyReceptorHomeostasis).
      const currentVolume = state[nt * 3 + VOLUME];
      receptorOccupancy[nt] = clamp01(hill(currentVolume, 2, 0.3) * receptorDensity[nt]);

      // Chronic tone up/down-regulates receptors: sustained high tone
      // downregulates, sustained low tone upregulates.
      const targetDensity = Math.max(0.4, Math.min(1.6, 1 + (0.5 - getTone(nt)) * 0.6));
      receptorDensity[nt] = relax(receptorDensity[nt], targetDensity, 0.005 * dt);

      // Phasic-signal clearance in the cleft. Every system clears — including
      // the seven with no reuptake transporter, which used to leak without
      // bound (bug B).
      if (phasicBuffers[nt] > 0) {
        const decay = phasicBuffers[nt] * bufferClearance[nt] * dt;
        phasicBuffers[nt] = Math.max(0, phasicBuffers[nt] - decay);
      }
    }

    return getSnapshot();
  }

  /**
   * Sleep-time receptor homeostasis.
   *
   * The old version in the daemon walked a COPY returned by getSnapshot() and
   * wrote to it, so it never reached the engine and did nothing at all. This
   * writes the engine's own state: density relaxes back to its 1.0 set point,
   * at whatever rate the sleep stage allows.
   */
  function applyReceptorHomeostasis(rate) {
    const k = clamp01(rate) * 100;
    for (let nt = 0; nt < NT_COUNT; nt++) {
      receptorDensity[nt] = relax(receptorDensity[nt], 1.0, k);
    }
    return [...receptorDensity];
  }

  function getReceptorDensity() {
    return [...receptorDensity];
  }

  /**
   * Effective tone — what the cognitive layer should FEEL, not the raw tone.
   *
   * This is what makes receptorDensity an output rather than bookkeeping.
   * Nothing outside this file read it, so a system that had chronically
   * downregulated responded exactly as hard as a fresh one and sleep-time
   * receptor homeostasis changed nothing anyone could observe.
   *
   * Density enters as a factor on the DEVIATION from neutral, clamped to ±50%
   * around its 1.0 set point:
   *
   *   - bounded, unlike `tone * density`, which spans 0.4–1.6 and lets an
   *     upregulated system shout or a saturated one fall off the scale;
   *   - neutral stays neutral: at tone 0.5 the deviation is zero, so no amount
   *     of receptor drift can invent a signal out of rest;
   *   - tone 1.0 with density 1.0 is still 1.0, so a fresh system behaves
   *     exactly as it did before this existed.
   *
   * Sustained high tone → density falls → gain shrinks (tolerance). Sleep
   * calls applyReceptorHomeostasis → density returns to 1.0 → the same input
   * moves utility again.
   */
  function getGain(nt) {
    const factor = Math.max(0.5, Math.min(1.5, receptorDensity[nt]));
    return clamp01(0.5 + (getTone(nt) - 0.5) * factor);
  }

  /** Same, addressed by name — the shape cognitive/cycle.js works with. */
  function getGainByName(name) {
    const nt = NT_NAMES.indexOf(name);
    return nt < 0 ? 0.5 : getGain(nt);
  }

  function getSnapshot() {
    return {
      volumes: getAllVolumes(),
      tones: getAllTones(),
      synaptics: getAllSynaptics(),
      somas: getAllSomas(),
      receptorOccupancy: [...receptorOccupancy],
      receptorDensity: [...receptorDensity],
      phasicBuffers: [...phasicBuffers],
    };
  }

  /**
   * Everything that is NOT derivable: the ODE state, pending phasic work, and
   * the calibrated parameters (a checkpoint taken under an overridden
   * `config.params` used to restore into a default-configured engine).
   */
  function toJSON() {
    const paramsCopy = {};
    for (const [nt, p] of Object.entries(params)) paramsCopy[nt] = { ...p };
    return {
      state: [...state],
      phasicBuffers: [...phasicBuffers],
      phasicSchedule: phasicSchedule.map(s => ({ ...s })),
      receptorDensity: [...receptorDensity],
      params: paramsCopy,
    };
  }

  function fromJSON(data) {
    if (data.state) state.set(data.state);
    if (data.phasicBuffers) phasicBuffers.set(data.phasicBuffers);
    if (data.phasicSchedule) {
      phasicSchedule.length = 0;
      phasicSchedule.push(...data.phasicSchedule);
    }
    if (data.receptorDensity) receptorDensity.set(data.receptorDensity);
    if (data.params) {
      for (const [nt, p] of Object.entries(data.params)) {
        params[nt] = { ...DEFAULT_PARAMS[nt], ...p };
      }
      // toneRef / clearance / tonic sources all derive from params, so they
      // have to be re-solved or a restored baseline_tonic would be inert.
      deriveCalibration();
    }
    // Occupancy is derived state but is read before the first step after a
    // restore; recompute rather than hand back the pre-serialize value.
    for (let nt = 0; nt < NT_COUNT; nt++) {
      receptorOccupancy[nt] = hill(state[nt * 3 + VOLUME], 2, 0.3) * receptorDensity[nt];
    }
  }

  // Gain modulation helpers (used by CognitiveCycle)
  function getD1Gain() { return receptorOccupancy[NT.DOPAMINE] * invertedU(getVolume(NT.DOPAMINE), 0.4, 0.2); }
  function getD2Gain() { return receptorOccupancy[NT.DOPAMINE] * (1 - invertedU(getVolume(NT.DOPAMINE), 0.4, 0.2)); }
  function getAlpha2Gain() { return receptorOccupancy[NT.NOREPINEPHRINE] * invertedU(getVolume(NT.NOREPINEPHRINE), 0.3, 0.15); }
  function getAlpha1Gain() { return receptorOccupancy[NT.NOREPINEPHRINE] * (1 - invertedU(getVolume(NT.NOREPINEPHRINE), 0.3, 0.15)); }
  function get5HT1AGain() { return receptorOccupancy[NT.SEROTONIN] * 0.8; }
  function get5HT2AGain() { return receptorOccupancy[NT.SEROTONIN] * 0.6; }
  function getM1Gain() { return receptorOccupancy[NT.ACETYLCHOLINE] * 0.7; }
  function getCB1Gain() { return receptorOccupancy[NT.ENDOCANNABINOID]; }
  function getMuOpioidGain() { return receptorOccupancy[NT.OPIOID] * 0.8; }
  function getOXTRGain() { return receptorOccupancy[NT.OXYTOCIN]; }

  return {
    NT,
    NT_NAMES,
    RECEPTORS,
    state,
    params,
    step,
    get,
    set,
    getVolume,
    getAllVolumes,
    getTone,
    getToneRef,
    getAllTones,
    getToneByName,
    getAllSynaptics,
    getAllSomas,
    schedulePhasic,
    releasePhasic,
    getSnapshot,
    toJSON,
    fromJSON,
    applyReceptorHomeostasis,
    getReceptorDensity,
    getGain,
    getGainByName,
    // Gain accessors
    getD1Gain,
    getD2Gain,
    getAlpha2Gain,
    getAlpha1Gain,
    get5HT1AGain,
    get5HT2AGain,
    getM1Gain,
    getCB1Gain,
    getMuOpioidGain,
    getOXTRGain,
  };
}