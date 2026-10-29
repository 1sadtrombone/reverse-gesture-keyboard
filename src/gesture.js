// Synthesizes a finger trajectory through a sequence of keys using the
// Sigma-Lognormal model of rapid human movement (Plamondon's Kinematic Theory).
//
// Each key-to-key hop is one "stroke": a circular arc whose speed over time
// follows a lognormal curve (fast rise, long tail). Strokes are launched
// before the previous one finishes, and their velocities sum, so the finger
// cuts corners and never quite stops on intermediate keys -- the way real
// gesture-typing traces look. Aim points are scattered around key centers,
// arcs get random curvature, and a small physiological tremor rides on top.

import { KB_W, KB_H, KEY_H } from './layout.js';
import { gauss } from './rng.js';

const SAMPLE_HZ = 120; // typical touchscreen report rate

function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

function lognormalCdf(tau, mu, sigma) {
  if (tau <= 0) return 0;
  return 0.5 * (1 + erf((Math.log(tau) - mu) / (sigma * Math.SQRT2)));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Offset along a constant-curvature arc after fraction f of its length D.
function arcOffset(k, f) {
  if (Math.abs(k.dTheta) < 1e-6) {
    return { x: k.D * f * Math.cos(k.thetaS), y: k.D * f * Math.sin(k.thetaS) };
  }
  const r = k.D / k.dTheta;
  const phi = k.thetaS + k.dTheta * f;
  return { x: r * (Math.sin(phi) - Math.sin(k.thetaS)), y: r * (Math.cos(k.thetaS) - Math.cos(phi)) };
}

/**
 * @param targets  key centers [{x, y}] in keyboard units, consecutive duplicates removed
 * @param rng      seeded () => [0, 1)
 * @param sloppiness 0..1  how far aim points and arcs stray
 * @param fluency    0..1  how much consecutive strokes overlap (corner cutting)
 * @returns { points: [{x, y, t}], letterIdx: sample index nearest each target, duration }
 */
export function synthesize(targets, rng, { sloppiness = 0.4, fluency = 0.5 } = {}) {
  const s = sloppiness;
  const aimSd = 0.06 + 0.32 * s;
  // Per-gesture systematic offset: people tend to hit consistently off-center.
  const bias = { x: gauss(rng) * aimSd * 0.5, y: gauss(rng) * aimSd * 0.5 };
  const vias = targets.map((p) => ({
    x: clamp(p.x + bias.x + gauss(rng) * aimSd, 0.1, KB_W - 0.1),
    y: clamp(p.y + bias.y + gauss(rng) * aimSd * KEY_H * 0.8, 0.1, KB_H - 0.1),
  }));

  if (vias.length === 1) {
    return { points: [{ ...vias[0], t: 0 }], letterIdx: [0], duration: 0 };
  }

  const speed = Math.exp(gauss(rng) * 0.12);
  const onsetGap = 0.95 - 0.55 * fluency; // fraction of a stroke's time before the next launches
  const strokes = [];
  let t0 = 0;
  for (let j = 0; j < vias.length - 1; j++) {
    const a = vias[j];
    const b = vias[j + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const chord = Math.hypot(dx, dy);
    const dTheta = clamp(gauss(rng) * (0.04 + 0.45 * s), -1.2, 1.2);
    const half = dTheta / 2;
    // Arc length whose chord exactly spans a -> b, so the gesture still ends on target.
    const D = Math.abs(half) < 1e-6 ? chord : (chord * half) / Math.sin(half);
    // Fitts-like: longer hops take longer, sublinearly.
    const T = (0.1 + 0.075 * Math.log2(1 + chord)) * speed;
    const sigma = 0.2 + 0.08 * rng() + 0.06 * s;
    strokes.push({ t0, D, thetaS: Math.atan2(dy, dx) - half, dTheta, mu: Math.log(0.6 * T), sigma });
    t0 += onsetGap * T * Math.exp(gauss(rng) * 0.08);
  }

  const tremor = [0, 1].map(() => ({
    f1: 8 + 4 * rng(), p1: 2 * Math.PI * rng(),
    f2: 8 + 4 * rng(), p2: 2 * Math.PI * rng(),
  }));
  const tremorAmp = 0.004 + 0.02 * s;
  const shake = (c, t) => tremorAmp * (Math.sin(2 * Math.PI * c.f1 * t + c.p1) + 0.5 * Math.sin(2 * Math.PI * c.f2 * t + c.p2));

  const posAt = (t) => {
    let x = vias[0].x;
    let y = vias[0].y;
    for (const k of strokes) {
      const f = lognormalCdf(t - k.t0, k.mu, k.sigma);
      if (f <= 0) continue;
      const o = arcOffset(k, f);
      x += o.x;
      y += o.y;
    }
    return { x: x + shake(tremor[0], t), y: y + shake(tremor[1], t) };
  };

  const first = strokes[0];
  const last = strokes[strokes.length - 1];
  const tStart = first.t0 + Math.exp(first.mu - 3 * first.sigma);
  const tEnd = last.t0 + Math.exp(last.mu + 3 * last.sigma);
  const points = [];
  for (let t = tStart; t < tEnd; t += 1 / SAMPLE_HZ) points.push({ ...posAt(t), t });
  points.push({ ...posAt(tEnd), t: tEnd });

  // For each target, the sample where the finger passes closest to it, searching
  // forward and no later than the next stroke's velocity peak.
  const letterIdx = [0];
  for (let j = 1; j < vias.length; j++) {
    const windowEnd = j < strokes.length ? strokes[j].t0 + Math.exp(strokes[j].mu - strokes[j].sigma ** 2) : Infinity;
    let best = letterIdx[j - 1];
    let bestD = Infinity;
    for (let i = letterIdx[j - 1]; i < points.length && points[i].t <= windowEnd; i++) {
      const d = Math.hypot(points[i].x - vias[j].x, points[i].y - vias[j].y);
      if (d < bestD) { bestD = d; best = i; }
    }
    letterIdx.push(j === vias.length - 1 ? points.length - 1 : best);
  }

  for (const p of points) p.t -= tStart;
  return { points, letterIdx, duration: tEnd - tStart };
}
