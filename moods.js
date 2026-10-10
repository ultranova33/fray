// ==========================================================================
// Fray: the mood deck
// Ten light palettes. A different one is dealt on every launch (never the
// same twice in a row) unless the user pins one in their profile.
// Every text/background pair here passes WCAG AA (4.5:1) for normal text.
// ==========================================================================

export const MOODS = [
  { id: 'masterpiece', name: 'Masterpiece', bg: '#EFE9E9', surface: '#FFFFFF', ink: '#5A2132', primary: '#5A2132', onPrimary: '#EFE9E9', pop: '#FE8254', onPop: '#5A2132', cats: ['#FE8254', '#E8C4CC', '#F3D9A4', '#C9D8C5', '#D6CCE8'], catInk: '#3A1420' },
  { id: 'atlantic', name: 'Atlantic', bg: '#C4F8FF', surface: '#FFFFFF', ink: '#0F4B70', primary: '#0F4B70', onPrimary: '#C4F8FF', pop: '#FFD21F', onPop: '#0F4B70', cats: ['#FFD21F', '#8EE3F0', '#FFB5A7', '#B9F0C2', '#D8C8FF'], catInk: '#0B3550' },
  { id: 'peach-steel', name: 'Peach Steel', bg: '#EDE0C8', surface: '#FFF8EC', ink: '#24363C', primary: '#3F5A62', onPrimary: '#FFF8EC', pop: '#FE8254', onPop: '#1E2B30', cats: ['#FE8254', '#A9C3C9', '#F5C98B', '#C9D9B0', '#E8B9A8'], catInk: '#1E2B30' },
  { id: 'balcony', name: 'Balcony', bg: '#ACCAB2', surface: '#F6EFE2', ink: '#2B211B', primary: '#B83A17', onPrimary: '#FFF4E6', pop: '#E9A752', onPop: '#2B211B', cats: ['#E9A752', '#F0B49E', '#D9E6D2', '#C9B6A3', '#F3DDA0'], catInk: '#2B211B' },
  { id: 'pop-folder', name: 'Pop Folder', bg: '#FFD21F', surface: '#FFFCF5', ink: '#111111', primary: '#6A4FF0', onPrimary: '#FFFFFF', pop: '#FF7A9C', onPop: '#111111', cats: ['#C6F25E', '#FF7A9C', '#9FB5FF', '#FFB36B', '#7EE0C3'], catInk: '#111111' },
  { id: 'ink-widget', name: 'Ink Widget', bg: '#E6E6E6', surface: '#F7F7F7', ink: '#1D1D1D', primary: '#1D1D1D', onPrimary: '#F7F7F7', pop: '#3B5BA9', onPop: '#FFFFFF', cats: ['#D0D0D0', '#BFCBEA', '#E9E2C9', '#CFE0D2', '#E6CFD6'], catInk: '#1D1D1D' },
  { id: 'lime-soda', name: 'Lime Soda', bg: '#E6F3C8', surface: '#FBFFF2', ink: '#1F0E06', primary: '#1F0E06', onPrimary: '#C6E385', pop: '#C6E385', onPop: '#1F0E06', cats: ['#C6E385', '#FFC9A8', '#F6E08A', '#BFE3DA', '#E9C8DC'], catInk: '#1F0E06' },
  { id: 'retro-tech', name: 'Retro Tech', bg: '#F2EBDD', surface: '#FFFFFF', ink: '#141414', primary: '#E9A15E', onPrimary: '#141414', pop: '#DD6450', onPop: '#141414', cats: ['#E9A15E', '#A9C7A4', '#D2D2D2', '#EF9C8E', '#E5D3A1'], catInk: '#141414' },
  { id: 'lilac', name: 'Lilac', bg: '#ECE6FF', surface: '#FFFFFF', ink: '#2D1B69', primary: '#2D1B69', onPrimary: '#ECE6FF', pop: '#FF9F6B', onPop: '#2D1B69', cats: ['#FF9F6B', '#C9BCFF', '#FFD6E0', '#BDEBD6', '#FFE7A3'], catInk: '#2D1B69' },
  { id: 'bubblegum', name: 'Bubblegum', bg: '#FFD9E8', surface: '#FFFFFF', ink: '#4A0D2B', primary: '#FF4D8D', onPrimary: '#2A0614', pop: '#FFE066', onPop: '#4A0D2B', cats: ['#FFE066', '#FF8FB8', '#B8E8FF', '#D7C4FF', '#FFC9A3'], catInk: '#4A0D2B' },
];

const LAST_KEY = 'fray.lastMood';

function readLast() { try { return localStorage.getItem(LAST_KEY); } catch { return null; } }
function writeLast(id) { try { localStorage.setItem(LAST_KEY, id); } catch { /* private mode */ } }

// Deal a mood: the pinned one if set, else a random one that isn't the last.
export function dealMood(pinnedId = null) {
  const pinned = pinnedId && MOODS.find((m) => m.id === pinnedId);
  if (pinned) { writeLast(pinned.id); return pinned; }
  const last = readLast();
  const pool = MOODS.filter((m) => m.id !== last);
  const mood = pool[Math.floor(Math.random() * pool.length)];
  writeLast(mood.id);
  return mood;
}

export function moodById(id) {
  return MOODS.find((m) => m.id === id) || null;
}

// Write a mood's colors onto :root as CSS variables.
// The done-task scribble, stretched across each line of a title. Must match the
// pen path drawn in app.js (scribblePath) so the drawn-in strike hands off cleanly.
export const SCRIBBLE = [[0, 7], [0.18, 4.6], [0.36, 7.4], [0.55, 5.2], [0.74, 6.6], [0.9, 4.4], [1, 5.6]];
function strikeImage(color) {
  const d = 'M' + SCRIBBLE.map(([x, y]) => `${(x * 100).toFixed(1)} ${y}`).join(' L');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 12' preserveAspectRatio='none'><path d='${d}' fill='none' stroke='${color}' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round' vector-effect='non-scaling-stroke'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function applyMood(mood, root = document.documentElement) {
  const set = (k, v) => root.style.setProperty(k, v);
  set('--bg', mood.bg);
  set('--surface', mood.surface);
  set('--ink', mood.ink);
  set('--muted', mood.ink + 'B3');
  set('--faint', mood.ink + '26');
  set('--line', mood.ink);
  set('--shadow', mood.ink);
  set('--primary', mood.primary);
  set('--on-primary', mood.onPrimary);
  set('--pop', mood.pop);
  set('--on-pop', mood.onPop);
  set('--strike', strikeImage(mood.pop));
  set('--cat-ink', mood.catInk);
  mood.cats.forEach((c, i) => set(`--cat${i + 1}`, c));
  root.dataset.mood = mood.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', mood.bg);
}
