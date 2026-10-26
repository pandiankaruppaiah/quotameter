// The file guard: a PreToolUse hook on the Read tool. It looks at one thing
// in the tool call, the file path, checks the file's size, and asks before a
// read that would eat a large share of the window. Nothing is stored.

import fs from 'node:fs';
import path from 'node:path';
import { priceFor } from './model/pricing.js';
import { fmt } from './report/format.js';

const TOKENS_PER_BYTE = 1 / 4; // a rough average for code and prose

// input: the hook's stdin JSON. k: { h5, model } from the last analysis.
// Returns the hook's JSON output, or null to let the read through.
export function guardDecision(input, { fileGuardKB = 512 } = {}, k = null) {
  if (!(fileGuardKB > 0)) return null;
  if (input?.tool_name !== 'Read') return null;
  let file = input.tool_input?.file_path;
  if (typeof file !== 'string' || !file) return null;
  if (!path.isAbsolute(file) && input.cwd) file = path.resolve(input.cwd, file);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null; // missing or unreadable: Claude Code will report that itself
  }
  if (!st.isFile() || st.size <= fileGuardKB * 1024) return null;
  const size = st.size;
  const tokens = Math.round(size * TOKENS_PER_BYTE);
  const price = priceFor(k?.model || 'claude-opus-5-5');
  const cost = price ? (tokens * price.input) / 1e6 : null;
  const pts = cost != null && k?.h5 ? cost * k.h5 : null;
  const mb = (size / 1048576).toFixed(size >= 10485760 ? 0 : 1);
  const name = file.split(/[\\/]/).pop();
  const share = pts != null ? `, roughly ${pts >= 10 ? pts.toFixed(0) : pts.toFixed(1)}% of your 5-hour window` : cost != null ? `, about $${cost.toFixed(2)} at list price` : '';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `quotameter: ${name} is ${mb} MB, about ${fmt(tokens)} tokens${share}. Read part of it with offset and limit, or let it through.`,
    },
  };
}
