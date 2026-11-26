import { spawn, type ChildProcess } from 'node:child_process';

const SYSTEM_ENV = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'PROGRAMFILES',
  'PROGRAMFILES(X86)', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP',
  'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CACHE_HOME',
  'PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_DOWNLOAD_HOST', 'PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
]);

export function runnerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => SYSTEM_ENV.has(key.toUpperCase())));
}

export function stopRunner(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
