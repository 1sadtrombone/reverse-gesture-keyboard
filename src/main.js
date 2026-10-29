import './gesture-textbox.js';

const box = document.getElementById('box');
const form = document.getElementById('controls');
const STORE = 'rgk:v1';

const load = () => {
  try { return JSON.parse(localStorage.getItem(STORE)) ?? {}; } catch { return {}; }
};
const save = (state) => {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {}
};

const state = {
  text: 'the quick brown fox jumps over the lazy dog\nHello, world! gesture typing is fun',
  sloppiness: 0.4,
  fluency: 0.5,
  size: 24,
  letters: false,
  seed: 1,
  ...load(),
};

function apply() {
  box.setAttribute('sloppiness', state.sloppiness);
  box.setAttribute('fluency', state.fluency);
  box.setAttribute('seed', state.seed);
  box.toggleAttribute('show-letters', state.letters);
  box.style.fontSize = `${state.size}px`;
  save(state);
}

form.sloppiness.value = state.sloppiness;
form.fluency.value = state.fluency;
form.size.value = state.size;
form.letters.checked = state.letters;
box.value = state.text;
apply();

form.addEventListener('input', () => {
  state.sloppiness = +form.sloppiness.value;
  state.fluency = +form.fluency.value;
  state.size = +form.size.value;
  state.letters = form.letters.checked;
  apply();
});
document.getElementById('reroll').addEventListener('click', () => {
  state.seed = (Math.random() * 1e9) | 0;
  apply();
});
box.addEventListener('input', () => {
  state.text = box.value;
  save(state);
});
box.focus();
