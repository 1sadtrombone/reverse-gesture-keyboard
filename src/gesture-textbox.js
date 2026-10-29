// <gesture-textbox>: an editable text box where every word is drawn as the
// swipe a finger would make on a phone keyboard to type it.
//
// A hidden <textarea> owns the real text, selection, undo and IME; this
// element only renders it and maps mouse/caret positions back and forth.
//
// Attributes: sloppiness (0..1), fluency (0..1), seed, show-letters, placeholder
// Property:   value
// Events:     input (from the inner textarea, composed)

import { Glyph, GLYPH_ASPECT } from './glyph.js';
import { keyFor } from './layout.js';

const STYLE = `
:host {
  --gesture-trace: #2f6fed;
  --gesture-key: rgba(127, 127, 127, 0.16);
  --gesture-key-text: rgba(127, 127, 127, 0.7);
  --gesture-caret: currentColor;
  --gesture-selection: rgba(47, 111, 237, 0.22);
  --gesture-h: 1.35em;
  display: block;
  position: relative;
  cursor: text;
  line-height: 1.75;
  min-height: 4lh;
}
.surface { position: relative; outline: none; }
.content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 4;
  user-select: none;
  -webkit-user-select: none;
}
.word { white-space: nowrap; }
.placeholder {
  position: absolute; inset: 0 auto auto 0;
  opacity: 0.45; pointer-events: none;
}
textarea.input {
  position: absolute; left: 0; top: 0;
  width: 1px; height: 1em; padding: 0; border: 0; margin: 0;
  opacity: 0; resize: none; overflow: hidden;
  font: inherit; color: transparent; background: transparent;
  caret-color: transparent; pointer-events: none;
}
.caret {
  display: inline-block;
  width: 0; height: 1.2em;
  margin-right: -2px;
  border-left: 2px solid var(--gesture-caret);
  vertical-align: middle;
  animation: blink 1.1s steps(1) infinite;
}
@keyframes blink { 50% { opacity: 0; } }

.glyph { display: inline-block; vertical-align: middle; line-height: 0; border-radius: 0.2em; }
.glyph svg {
  height: var(--gesture-h);
  width: calc(var(--gesture-h) * ${GLYPH_ASPECT.toFixed(4)});
  overflow: visible;
}
.kb rect { fill: var(--gesture-key); }
.kb text {
  fill: var(--gesture-key-text); font: 0.62px/1 system-ui, sans-serif;
  text-anchor: middle; dominant-baseline: central;
}
.trace, .done {
  fill: none; stroke: var(--gesture-trace); stroke-width: 0.34;
  stroke-linecap: round; stroke-linejoin: round;
}
.start, .tap, .pen { fill: var(--gesture-trace); }
.done, .pen { display: none; }
.progress .trace, .replaying .trace { opacity: 0.28; }
.progress .done, .progress .pen, .replaying .done, .replaying .pen { display: inline; }

.sel { background: var(--gesture-selection); }
:host(:not(:focus-within)) .sel { background: rgba(127, 127, 127, 0.18); }
`;

function* tokenize(text) {
  const re = /\s|\S+/g;
  let m;
  while ((m = re.exec(text))) yield { text: m[0], start: m.index, ws: /\s/.test(m[0]) };
}

// Split a word into leading punctuation, the swipeable core, and trailing
// punctuation: "(hello," -> ["(", "hello", ","].
function splitWord(w) {
  const chars = [...w];
  const first = chars.findIndex((c) => keyFor(c));
  if (first < 0) return null;
  let last = chars.length - 1;
  while (!keyFor(chars[last])) last--;
  const lead = chars.slice(0, first).join('');
  const core = chars.slice(first, last + 1).join('');
  return { lead, core, trail: chars.slice(last + 1).join('') };
}

const clamp01 = (v, d) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

export class GestureTextbox extends HTMLElement {
  static get observedAttributes() {
    return ['sloppiness', 'fluency', 'seed', 'show-letters', 'placeholder'];
  }

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open', delegatesFocus: true });
    root.innerHTML =
      `<style>${STYLE}</style><div class="surface" part="surface">` +
      '<div class="content" aria-hidden="true"></div><div class="placeholder"></div>' +
      '<textarea class="input" wrap="off" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea></div>';
    this._surface = root.querySelector('.surface');
    this._content = root.querySelector('.content');
    this._placeholder = root.querySelector('.placeholder');
    this._input = root.querySelector('textarea');
    this._caret = document.createElement('span');
    this._caret.className = 'caret';
    this._units = [];
    this._glyphs = new Map();
    this._goalX = null;
    this._selFrame = 0;

    const sched = () => this._scheduleSelection();
    this._input.addEventListener('input', () => { this._goalX = null; this._render(); });
    this._input.addEventListener('keydown', (e) => this._onKeyDown(e));
    for (const ev of ['keyup', 'select', 'focus', 'blur']) this._input.addEventListener(ev, sched);
    this._onDocSelection = sched;
    this.addEventListener('mousedown', (e) => this._onMouseDown(e));
  }

  connectedCallback() {
    document.addEventListener('selectionchange', this._onDocSelection);
    this._render();
  }

  disconnectedCallback() {
    document.removeEventListener('selectionchange', this._onDocSelection);
  }

  attributeChangedCallback(name) {
    if (name === 'placeholder') this._placeholder.textContent = this.getAttribute('placeholder') ?? '';
    if (this.isConnected) this._render();
  }

  get value() { return this._input.value; }
  set value(v) {
    this._input.value = v;
    this._render();
  }

  focus(opts) { this._input.focus(opts); }

  _settings() {
    return {
      sloppiness: clamp01(parseFloat(this.getAttribute('sloppiness')), 0.4),
      fluency: clamp01(parseFloat(this.getAttribute('fluency')), 0.5),
      seed: this.getAttribute('seed') ?? '0',
      showLetters: this.hasAttribute('show-letters'),
    };
  }

  // ---- rendering ---------------------------------------------------------

  _render() {
    const text = this._input.value;
    const settings = this._settings();
    const settingsKey = `${settings.sloppiness}|${settings.fluency}|${settings.seed}|${settings.showLetters}`;
    const units = [];
    const nodes = [];
    const glyphs = new Map();
    const seen = new Map(); // same word twice gets two different (but stable) traces

    const charUnits = (str, start, parent, kind = 'char') => {
      let i = start;
      for (const ch of str) {
        const el = document.createElement('span');
        el.textContent = ch;
        parent.append(el);
        units.push({ start: i, end: i + ch.length, el, kind });
        i += ch.length;
      }
    };

    for (const tok of tokenize(text)) {
      if (tok.ws) {
        const holder = document.createDocumentFragment();
        charUnits(tok.text, tok.start, holder, tok.text === '\n' ? 'newline' : 'char');
        nodes.push(holder);
        continue;
      }
      const wrap = document.createElement('span');
      wrap.className = 'word';
      nodes.push(wrap);
      const parts = splitWord(tok.text);
      if (!parts) {
        charUnits(tok.text, tok.start, wrap);
        continue;
      }
      const coreStart = tok.start + parts.lead.length;
      charUnits(parts.lead, tok.start, wrap);

      const norm = parts.core.toLowerCase();
      const n = (seen.get(norm) ?? 0) + 1;
      seen.set(norm, n);
      const key = `${parts.core}|${n}|${settingsKey}`;
      const glyph = this._glyphs.get(key) ?? new Glyph(parts.core, { ...settings, seed: `${norm}|${n}|${settings.seed}` });
      glyphs.set(key, glyph);
      wrap.append(glyph.el);
      units.push({ start: coreStart, end: coreStart + parts.core.length, el: glyph.el, kind: 'glyph', glyph });

      charUnits(parts.trail, coreStart + parts.core.length, wrap);
    }

    this._glyphs = glyphs;
    this._units = units;
    this._content.replaceChildren(...nodes);
    this._placeholder.hidden = text.length > 0;
    this._updateSelection();
  }

  _scheduleSelection() {
    if (this._selFrame) return;
    this._selFrame = requestAnimationFrame(() => {
      this._selFrame = 0;
      this._updateSelection();
    });
  }

  _updateSelection() {
    const { selectionStart: s, selectionEnd: e } = this._input;
    const focused = this.shadowRoot.activeElement === this._input;
    this._caret.remove();
    for (const u of this._units) {
      u.el.classList.toggle('sel', s !== e && u.kind !== 'newline' && u.start < e && u.end > s);
      if (u.glyph) u.glyph.setProgress(null);
    }
    if (!focused || s !== e) return this._placeInput();

    const inside = this._units.find((u) => u.glyph && u.start < s && s < u.end);
    if (inside) {
      inside.glyph.setProgress(s - inside.start);
    } else {
      const at = this._units.find((u) => u.start === s);
      if (at) at.el.before(this._caret);
      else this._content.append(this._caret);
      // restart the blink so the caret is visible right after it moves
      this._caret.style.animation = 'none';
      void this._caret.offsetWidth;
      this._caret.style.animation = '';
    }
    this._placeInput();
  }

  // Keep the hidden textarea under the caret so IME popups appear in the right place.
  _placeInput() {
    const r = this._rectForPos(this._focusPos());
    const base = this._surface.getBoundingClientRect();
    this._input.style.left = `${r.x - base.left}px`;
    this._input.style.top = `${r.top - base.top}px`;
  }

  // ---- position mapping --------------------------------------------------

  _focusPos() {
    const t = this._input;
    return t.selectionDirection === 'backward' ? t.selectionStart : t.selectionEnd;
  }

  _anchorPos() {
    const t = this._input;
    return t.selectionDirection === 'backward' ? t.selectionEnd : t.selectionStart;
  }

  // Client-space caret location for text offset pos: { x, top, bottom }.
  _rectForPos(pos) {
    const inside = this._units.find((u) => u.glyph && u.start < pos && pos < u.end);
    if (inside) {
      const p = inside.glyph.clientPoint(pos - inside.start);
      const r = inside.el.getBoundingClientRect();
      return { x: p.x, top: r.top, bottom: r.bottom };
    }
    const at = this._units.find((u) => u.start === pos);
    if (at) {
      const r = at.el.getBoundingClientRect();
      return { x: r.left, top: r.top, bottom: r.bottom };
    }
    const last = this._units[this._units.length - 1];
    if (last && last.kind !== 'newline') {
      const r = last.el.getBoundingClientRect();
      return { x: r.right, top: r.top, bottom: r.bottom };
    }
    const r = (this._caret.isConnected ? this._caret : this._content).getBoundingClientRect();
    return { x: r.left, top: r.top, bottom: r.top + parseFloat(getComputedStyle(this).lineHeight || '24') };
  }

  // Text offset for a client point: nearest line first, then nearest unit on it.
  _posFromPoint(x, y) {
    let best = null;
    let bestV = Infinity;
    let bestH = Infinity;
    for (const u of this._units) {
      const r = u.el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const v = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const h = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (v < bestV - 1 || (v <= bestV + 1 && h < bestH)) {
        best = { u, r };
        bestV = Math.min(v, bestV);
        bestH = h;
      }
    }
    if (!best) return this._input.value.length;
    const { u, r } = best;
    if (u.kind === 'newline') return u.start;
    if (u.glyph) return u.start + u.glyph.offsetFromClient(x, y);
    return x < (r.left + r.right) / 2 ? u.start : u.end;
  }

  _select(anchor, focus) {
    this._input.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus), focus < anchor ? 'backward' : 'forward');
    this._scheduleSelection();
  }

  // ---- interaction -------------------------------------------------------

  _onMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    this._input.focus({ preventScroll: true });
    this._goalX = null;
    const pos = this._posFromPoint(e.clientX, e.clientY);

    if (e.detail === 2) {
      const text = this._input.value;
      let a = pos;
      let b = pos;
      while (a > 0 && !/\s/.test(text[a - 1])) a--;
      while (b < text.length && !/\s/.test(text[b])) b++;
      return this._select(a, b);
    }

    const anchor = e.shiftKey ? this._anchorPos() : pos;
    this._select(anchor, pos);
    const move = (ev) => this._select(anchor, this._posFromPoint(ev.clientX, ev.clientY));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  _onKeyDown(e) {
    if (e.isComposing) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
      this._goalX = null;
      return this._scheduleSelection();
    }
    // The hidden textarea doesn't wrap like the rendered view, so do
    // vertical movement against the rendered layout.
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    const r = this._rectForPos(this._focusPos());
    this._goalX ??= r.x;
    const lineH = parseFloat(getComputedStyle(this).lineHeight) || r.bottom - r.top;
    const y = (r.top + r.bottom) / 2 + dir * lineH;
    const box = this._content.getBoundingClientRect();
    const len = this._input.value.length;
    const pos = y < box.top ? 0 : y > box.bottom ? len : this._posFromPoint(this._goalX, y);
    this._select(e.shiftKey ? this._anchorPos() : pos, pos);
  }
}

customElements.define('gesture-textbox', GestureTextbox);
