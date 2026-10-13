import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const home = os.homedir();

export function quotameterHome() {
  return process.env.QUOTAMETER_HOME || path.join(home, '.quotameter');
}

// Claude Code honours CLAUDE_CONFIG_DIR; default is ~/.claude.
export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

export function claudeProjectsDir() {
  return path.join(claudeConfigDir(), 'projects');
}

// Folder the /usage poller runs in, so its own session logs are easy to recognise.
export function pollDir() {
  return path.join(quotameterHome(), 'poll');
}

// Claude Desktop keeps its data in a different place per platform. The Windows
// Store (MSIX) build virtualises %APPDATA% under its package folder.
export function desktopDataDirs() {
  // Override for tests and the demo; an empty value turns Desktop off.
  if (process.env.QUOTAMETER_DESKTOP_DIR != null) {
    const d = process.env.QUOTAMETER_DESKTOP_DIR;
    return d && fs.existsSync(d) ? [d] : [];
  }
  const dirs = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const pkgs = path.join(local, 'Packages');
    try {
      for (const name of fs.readdirSync(pkgs)) {
        if (/(^|[.])Claude_/i.test(name)) dirs.push(path.join(pkgs, name, 'LocalCache', 'Roaming', 'Claude'));
      }
    } catch {}
    dirs.push(path.join(roaming, 'Claude'));
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'Claude'));
  } else {
    dirs.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude'));
  }
  return dirs.filter((d) => fs.existsSync(d));
}
