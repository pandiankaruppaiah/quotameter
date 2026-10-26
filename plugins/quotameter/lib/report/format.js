// Number, money and time formatting shared by the terminal summary and the
// HTML report. Kept free of imports so render.js can embed it in the page.

export const fmt = (n) => n == null ? 'n/a' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K' : String(Math.round(n));
export const money = (n) => n == null ? 'n/a' : '$' + (n >= 100 ? n.toFixed(0) : n.toFixed(2));
export const pt = (n) => n == null ? 'n/a' : (Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(1));
export const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const dayTime = (iso) => { const d = new Date(iso); const today = new Date(); return d.toDateString() === today.toDateString() ? time(iso) + ' today' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' + time(iso); };
export function dur(ms) { if (ms == null) return 'n/a'; const m = Math.round(ms / 60000); if (m < 60) return m + ' m'; const h = Math.floor(m / 60); if (h < 48) return h + ' h ' + (m % 60) + ' m'; const d = Math.floor(h / 24); return d + ' d ' + (h % 24) + ' h'; }
// 'in 3 h 5 m', or 'already reset' when an old report is reopened.
export const until = (iso) => Date.parse(iso) <= Date.now() ? 'already reset' : 'in ' + dur(Date.parse(iso) - Date.now());
