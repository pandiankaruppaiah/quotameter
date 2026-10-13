// Small helpers shared by the analysis modules.

export const HOUR = 3600000;
export const DAY = 24 * HOUR;

export const sum = (xs, f = (x) => x) => xs.reduce((a, x) => a + (f(x) || 0), 0);
export const tokensOf = (m) => m.in + m.out + m.cw5 + m.cw1h + m.cr;
export const round = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export function percentile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * p;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
}
