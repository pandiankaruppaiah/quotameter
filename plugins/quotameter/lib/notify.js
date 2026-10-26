// OS notifications without dependencies, and the reset alarm that uses them.
//
// `quotameter alarm <resetsAt>` is spawned detached by the prompt hook once a
// window reaches 95%. It sleeps until the reset, shows one notification, and
// exits. No daemon: if the machine slept through the reset, the timer fires
// at wake, which is exactly when the user is back.

import { spawn } from 'node:child_process';

// A missing notifier must not crash the alarm process.
const quiet = (child) => {
  child.on('error', () => {});
  child.unref();
};

export function notify(title, body) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  try {
    if (process.platform === 'win32') {
      // A balloon from a throwaway tray icon: works on Windows 10 and 11 with
      // nothing installed. The text is passed as arguments, not interpolated
      // into the script, so it cannot change the script.
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$n = New-Object System.Windows.Forms.NotifyIcon',
        '$n.Icon = [System.Drawing.SystemIcons]::Information',
        '$n.Visible = $true',
        '$n.ShowBalloonTip(10000, $args[0], $args[1], [System.Windows.Forms.ToolTipIcon]::Info)',
        'Start-Sleep -Seconds 12',
        '$n.Dispose()',
      ].join('; ');
      quiet(spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `& { ${ps} }`, title, body], opts));
    } else if (process.platform === 'darwin') {
      const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      quiet(spawn('osascript', ['-e', `display notification "${q(body)}" with title "${q(title)}"`], opts));
    } else {
      quiet(spawn('notify-send', [title, body], opts)); // absent on a headless box: ignored
    }
    return true;
  } catch {
    return false;
  }
}

const STEP = 30000; // short sleeps, so waking from OS sleep is noticed within 30 s
const STALE = 30 * 60000; // woke up this long after the reset: say nothing

// Wait until `at` (ms since epoch), then notify. Resolves true when it
// notified, false when it gave up (too far away, or stale at wake).
export function alarm(at, { kind = '5-hour', now = Date.now(), notifyFn = notify, step = STEP, clock = Date.now } = {}) {
  return new Promise((resolve) => {
    if (at - now > 8 * 24 * 3600000) {
      resolve(false); // further away than any window: not ours to wait for
      return;
    }
    const tick = () => {
      const t = clock();
      if (t >= at) {
        if (t - at > STALE) {
          resolve(false);
          return;
        }
        notifyFn('quotameter', `Your Claude ${kind} limit has reset. The window is open again.`);
        resolve(true);
        return;
      }
      setTimeout(tick, Math.min(at - t, step));
    };
    tick();
  });
}
