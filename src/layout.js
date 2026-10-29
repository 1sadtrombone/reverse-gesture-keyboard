// Phone-style QWERTY geometry, in key-width units. Keys are taller than wide,
// rows are staggered the way Gboard/iOS stagger them.

export const KEY_H = 1.3;
export const KB_W = 10;
export const KB_H = 3 * KEY_H;

const ROWS = [
  ['qwertyuiop', 0],
  ['asdfghjkl', 0.5],
  ['zxcvbnm', 1.5],
];

// letter -> { x, y } key center
export const KEYS = {};
ROWS.forEach(([letters, offset], row) => {
  [...letters].forEach((ch, col) => {
    KEYS[ch] = { x: offset + col + 0.5, y: (row + 0.5) * KEY_H, row, col };
  });
});

// Map a character to the key it would be swiped on ('É' -> 'e'), or null.
export function keyFor(ch) {
  const base = ch.normalize('NFD')[0]?.toLowerCase();
  return base && KEYS[base] ? base : null;
}
