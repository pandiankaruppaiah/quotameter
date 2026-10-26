// The one place that knows model families: names, display labels and the
// colour series the report uses for each. Prices live in pricing.js.

const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// Family by keyword, so both "claude-opus-5-5" and older "claude-3-5-sonnet" work.
export function familyOf(m) {
  const f = FAMILIES.find((x) => (m || '').includes(x));
  return f ? cap(f) : 'Other';
}

// "claude-opus-5-5" -> "Opus 5.5", "claude-3-5-sonnet" -> "Sonnet 3.5".
export function prettyModel(m) {
  if (!m) return 'unknown';
  const f = FAMILIES.find((x) => m.includes(x));
  if (!f) return m;
  const version = m.replace(/^claude-/, '').split('-').filter((p) => p !== f && /^\d+$/.test(p)).join('.');
  return `${cap(f)} ${version}`.trim();
}

// Colour series per family, matched against the model name. The page reads
// this from the summary, so adding a family here is the whole change.
export const SERIES = { opus: 1, sonnet: 2, haiku: 4, fable: 5, mythos: 5 };
