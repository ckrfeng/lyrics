const fs = require('node:fs');
const path = require('node:path');

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
class TokenStore {
  constructor(file, safeStorage) { this.file = file; this.safeStorage = safeStorage; }
  assertSecure() {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Secure OS storage is unavailable. Unlock your keychain and restart Verse.');
    }
  }
  load() {
    if (!fs.existsSync(this.file)) return null;
    this.assertSecure();
    try { return JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.file))); }
    catch { throw new Error('Saved Spotify login could not be unlocked. Disconnect and connect again.'); }
  }
  save(tokens) { this.assertSecure(); atomicWrite(this.file, this.safeStorage.encryptString(JSON.stringify(tokens))); }
  clear() { fs.rmSync(this.file, { force: true }); fs.rmSync(`${this.file}.tmp`, { force: true }); }
}
class Preferences {
  constructor(file) {
    this.file = file;
    this.value = { tint: 42, collapsed: false, mode: 'demo', onboarded: false };
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isFinite(p.tint)) this.value.tint = Math.min(90, Math.max(25, p.tint));
      for (const key of ['collapsed', 'onboarded']) if (typeof p[key] === 'boolean') this.value[key] = p[key];
      if (p.mode === 'spotify') this.value.mode = 'spotify';
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) Object.assign(this.value, { x: p.x, y: p.y });
      if (/^[a-f0-9]{32}$/i.test(p.clientId || '')) this.value.clientId = p.clientId;
    } catch { /* Missing or damaged preferences: safe defaults. */ }
  }
  set(patch) { Object.assign(this.value, patch); atomicWrite(this.file, JSON.stringify(this.value, null, 2)); }
}
module.exports = { TokenStore, Preferences, atomicWrite };
