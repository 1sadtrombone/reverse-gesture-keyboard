// One word rendered as a tiny keyboard with its swipe trace.

import { KEYS, KB_W, KB_H, KEY_H, keyFor } from './layout.js';
import { synthesize } from './gesture.js';
import { rngFrom } from './rng.js';

const PAD = 0.15;
const VB = { x: -PAD, y: -PAD, w: KB_W + 2 * PAD, h: KB_H + 2 * PAD };
export const GLYPH_ASPECT = VB.w / VB.h;

const keyboardCache = {};
function keyboardMarkup(showLetters) {
  if (keyboardCache[showLetters]) return keyboardCache[showLetters];
  let out = '<g class="kb">';
  for (const [ch, k] of Object.entries(KEYS)) {
    out += `<rect x="${k.x - 0.45}" y="${k.y - KEY_H / 2 + 0.06}" width="0.9" height="${KEY_H - 0.12}" rx="0.16"/>`;
    if (showLetters) out += `<text x="${k.x}" y="${k.y}">${ch}</text>`;
  }
  return (keyboardCache[showLetters] = out + '</g>');
}

const fmt = (v) => v.toFixed(2);
const pathD = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${fmt(p.x)} ${fmt(p.y)}`).join('');
const escapeXml = (s) => s.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);

// Collapse a word into the key sequence a finger visits. Repeated letters
// ("ll") are one visit; characters with no key ("don't") ride along with the
// previous key. charToKey[i] is the visit index for word char i.
export function mapWord(word) {
  const seq = [];
  const charToKey = [];
  for (const ch of word) {
    const key = keyFor(ch);
    if (key && key !== seq[seq.length - 1]) seq.push(key);
    for (let i = 0; i < ch.length; i++) charToKey.push(Math.max(0, seq.length - 1));
  }
  return { seq, charToKey };
}

export class Glyph {
  constructor(word, { seed, sloppiness, fluency, showLetters }) {
    this.word = word;
    const { seq, charToKey } = mapWord(word);
    this.charToKey = charToKey;
    this.gesture = synthesize(seq.map((k) => KEYS[k]), rngFrom(seed), { sloppiness, fluency });
    const pts = this.gesture.points;

    const trace = pts.length === 1
      ? `<circle class="tap" cx="${fmt(pts[0].x)}" cy="${fmt(pts[0].y)}" r="0.42"/>`
      : `<path class="trace" d="${pathD(pts)}"/><circle class="start" cx="${fmt(pts[0].x)}" cy="${fmt(pts[0].y)}" r="0.3"/>`;

    this.el = document.createElement('span');
    this.el.className = 'glyph';
    this.el.innerHTML =
      `<svg viewBox="${VB.x} ${VB.y} ${VB.w} ${VB.h}"><title>${escapeXml(word)}</title>` +
      keyboardMarkup(showLetters) + trace +
      '<path class="done"/><circle class="pen" r="0.36"/></svg>';
    this.svg = this.el.firstChild;
    this.done = this.svg.querySelector('.done');
    this.pen = this.svg.querySelector('.pen');

    this._progress = null;
    this._raf = 0;
    if (pts.length > 1) {
      this.el.addEventListener('mouseenter', () => this._startReplay());
      this.el.addEventListener('mouseleave', () => this._stopReplay());
    }
  }

  // Sample index reached after typing the first k characters of the word.
  sampleFor(k) {
    return k <= 0 ? 0 : this.gesture.letterIdx[this.charToKey[k - 1]];
  }

  // Show the caret inside the word: trace drawn up to char k, the rest faded.
  setProgress(k) {
    this._progress = k;
    if (this._raf) return;
    if (k == null) {
      this.el.classList.remove('progress');
      return;
    }
    this._drawTo(this.sampleFor(k));
    this.el.classList.add('progress');
  }

  _drawTo(i) {
    const pts = this.gesture.points;
    this.done.setAttribute('d', pathD(pts.slice(0, i + 1)));
    this.pen.setAttribute('cx', fmt(pts[i].x));
    this.pen.setAttribute('cy', fmt(pts[i].y));
  }

  // Client-space position of the finger after typing k chars.
  clientPoint(k) {
    const p = this.gesture.points[this.sampleFor(k)];
    const r = this.svg.getBoundingClientRect();
    return { x: r.left + ((p.x - VB.x) / VB.w) * r.width, y: r.top + ((p.y - VB.y) / VB.h) * r.height };
  }

  // Caret offset (0..word.length) for a click at client (x, y).
  offsetFromClient(x, y) {
    const r = this.svg.getBoundingClientRect();
    const fx = (x - r.left) / r.width;
    if (fx < 0.1) return 0;
    if (fx > 0.9) return this.word.length;
    let best = this.word.length;
    let bestD = Infinity;
    for (let k = 1; k <= this.word.length; k++) {
      const p = this.clientPoint(k);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) { bestD = d; best = k; }
    }
    return best;
  }

  // Hovering replays the gesture at the speed a finger would actually move.
  _startReplay() {
    const { points, duration } = this.gesture;
    const hold = 0.5;
    const t0 = performance.now();
    this.el.classList.add('replaying');
    const frame = (now) => {
      const t = ((now - t0) / 1000) % (duration + hold);
      let i = 0;
      while (i < points.length - 1 && points[i + 1].t <= t) i++;
      this._drawTo(i);
      this._raf = requestAnimationFrame(frame);
    };
    this._raf = requestAnimationFrame(frame);
  }

  _stopReplay() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.el.classList.remove('replaying');
    this.setProgress(this._progress);
  }
}
