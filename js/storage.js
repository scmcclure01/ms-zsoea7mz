// Browser-only storage for settings and the script library, plus backup files.

const SETTINGS_KEY = 'handyctl.settings.v1';
const LIBRARY_KEY = 'handyctl.library.v1';

export const DEFAULT_SETTINGS = {
  connectionKey: '',
  appId: '',
  maxSpeed: 100, // % of device max
  maxSessionMin: 0, // 0 = no limit
  easeInSec: 10,
  strokeMin: 0,
  strokeMax: 100,
  tooClose: { cooldownSec: 20, style: 'stop', rewindSec: 45, slowdownPct: 10 },
};

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadSettings() {
  const s = read(SETTINGS_KEY, {});
  return { ...DEFAULT_SETTINGS, ...s, tooClose: { ...DEFAULT_SETTINGS.tooClose, ...(s.tooClose || {}) } };
}
export const saveSettings = (s) => write(SETTINGS_KEY, s);

export const loadLibrary = () => read(LIBRARY_KEY, []);
export const saveLibrary = (lib) => write(LIBRARY_KEY, lib);

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function download(filename, data) {
  const blob = new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = true;
    inp.onchange = async () => {
      const files = [...inp.files];
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() }))));
    };
    inp.click();
  });
}

// Backup includes the library and settings, but never the connection key or app ID.
export function backupData(settings, library) {
  const { connectionKey, appId, ...safe } = settings;
  return { app: 'handy-control', version: 1, exported: new Date().toISOString(), settings: safe, library };
}
