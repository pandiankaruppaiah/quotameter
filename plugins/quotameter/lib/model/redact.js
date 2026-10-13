// Copies of the report summary with personal details taken out.
//
// Session titles are written by Claude Code from your first prompt, so they
// can hold anything you typed. Branch names and project folder names can name
// clients or unreleased work.
//
// forModel: what the optional Haiku summary reads (summary.json). Titles and
//   branch names are removed; project names stay so findings stay useful.
// share: for screenshots and posts (`report --share`). Project names become
//   "Project 1", "Project 2", and Claude's written findings are dropped
//   because they may quote names.

const CHAT = 'Chat and other devices';

export function redact(summary, { share = false } = {}) {
  const s = structuredClone(summary);
  const names = new Map();
  const project = (n) => {
    if (!share || !n || n === CHAT) return n;
    if (!names.has(n)) names.set(n, `Project ${names.size + 1}`);
    return names.get(n);
  };
  for (const b of Object.values(s.breakdown || {})) {
    b.projects?.forEach((p) => {
      p.name = project(p.name);
      delete p.branch;
    });
    b.sessions?.forEach((x, i) => (x.title = `Session ${i + 1}`));
  }
  for (const x of s.insights?.branches || []) {
    x.project = project(x.project);
    x.branch = null;
  }
  if (s.insights?.sessionLength) s.insights.sessionLength.longestTitle = null;
  if (share) delete s.findings;
  s.redacted = share ? 'share' : 'model';
  return s;
}
