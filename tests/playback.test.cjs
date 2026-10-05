const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PlaybackService } = require('../lyric-beta/src/playback.cjs');
const { TokenStore, Preferences } = require('../lyric-beta/src/storage.cjs');
const data = id => ({ item: { type: 'track', id, name: 'Fictional', artists: [{ name: 'Sample' }], duration_ms: 90000 }, progress_ms: 12000, is_playing: true, device: { is_restricted: false } });
function service(request) {
  const s = new PlaybackService({ request, retryAt: 0, auth: { tokens: { scope: 'user-modify-playback-state' } } }, {});
  s.lyrics.load = () => {}; s.fetchArtwork = () => {}; return s;
}
test('stop/disconnect ignore late Spotify snapshots and cancel pending work', async () => {
  let resolve; const s = service(() => new Promise(r => { resolve = r; }));
  s.active = true; const poll = s.poll(); s.disconnect(); resolve(data('old')); await poll;
  assert.equal(s.state.track, null); assert.equal(s.state.status, 'disconnected');
});
test('pause/seek only update clock after successful command, then reconcile', async () => {
  const calls = []; const s = service(async (route, method) => { calls.push([route, method]); return method === 'GET' ? data('a') : null; });
  s.active = true; await s.poll(); clearTimeout(s.timer);
  await s.control({ action: 'pause', trackId: 'a' }); assert.equal(s.state.track.playing, false); clearTimeout(s.timer);
  await s.control({ action: 'seek', trackId: 'a', position: 4000 }); assert.equal(s.state.track.position, 4000); clearTimeout(s.timer);
  assert.deepEqual(calls.slice(1), [['/me/player/pause', 'PUT'], ['/me/player/seek?position_ms=4000', 'PUT']]);
  await assert.rejects(s.control({ action: 'seek', trackId: 'old', position: 1000 }), /changed/); s.stop();
});
test('403 disables controls temporarily while keeping lyrics usable', async () => {
  const s = service(async (_route, method) => { if (method === 'PUT') throw Object.assign(new Error('Denied'), { code: 'access' }); return data('a'); });
  s.active = true; await s.poll();
  await assert.rejects(s.control({ action: 'pause', trackId: 'a' }));
  assert.equal(s.state.track.controls.pause, false); assert.match(s.state.track.controlReason, /Premium/);
  await s.poll(); assert.equal(s.state.track.controls.pause, false); assert.equal(s.state.status, 'ready'); s.stop();
});
test('wake invalidates stale playback and triggers fresh metadata/lyrics fetch', async () => {
  const s = service(async () => data('a')); s.active = true; await s.poll();
  s.suspend(true); assert.equal(s.state.track.playing, false);
  s.suspend(false); assert.equal(s.state.track, null); assert.equal(s.state.status, 'loading'); s.stop();
});
test('a lyrics retry is not restarted by every Spotify poll', async () => {
  const s = service(async () => data('a')); s.active = true;
  await s.poll(); let loads = 0; s.lyrics.load = () => { loads++; };
  s.state.lyrics = { kind: 'error' }; s.lyricsRetryAt = 0;
  await s.poll(); await s.poll(); assert.equal(loads, 1); assert.equal(s.state.lyrics.kind, 'loading'); s.stop();
});
test('OS encryption required; persisted token data is encrypted, private and removed on disconnect', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verse-storage-')), file = path.join(dir, 'tokens.enc');
  const fake = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s).map(v => v ^ 0x9a), decryptString: b => Buffer.from(b).map(v => v ^ 0x9a).toString() };
  const store = new TokenStore(file, fake);
  store.save({ refreshToken: 'fixture-sensitive-value' });
  assert.equal(fs.readFileSync(file).includes('fixture-sensitive-value'), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(store.load().refreshToken, 'fixture-sensitive-value');
  store.clear(); assert.equal(fs.existsSync(file), false);
  assert.throws(() => new TokenStore(file, { isEncryptionAvailable: () => false }).save({}), /Secure OS storage/);
  assert.throws(() => new TokenStore(file, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }).save({}), /Secure OS storage/);
});
test('damaged or out-of-range preferences use safe values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verse-prefs-')), file = path.join(dir, 'prefs.json');
  fs.writeFileSync(file, '{broken'); assert.equal(new Preferences(file).value.tint, 42);
  fs.writeFileSync(file, JSON.stringify({ tint: 999, collapsed: 'false', x: 'bad', y: 20, clientId: 'secret' }));
  const prefs = new Preferences(file); assert.equal(prefs.value.tint, 100); assert.equal(prefs.value.collapsed, false); assert.equal(prefs.value.x, undefined);
});
test('previous/next use real POST commands and wait for the new Spotify snapshot', async () => {
  const calls = []; const s = service(async (route, method) => { calls.push([route, method]); return method === 'GET' ? data('a') : null; });
  s.active = true; await s.poll(); const previous = { ...s.state.track };
  await s.control({ action: 'next', trackId: 'a' });
  assert.equal(s.state.track.position, previous.position); assert.equal(s.state.track.playing, previous.playing);
  await s.control({ action: 'previous', trackId: 'a' });
  assert.deepEqual(calls.slice(1), [['/me/player/next', 'POST'], ['/me/player/previous', 'POST']]); s.stop();
});
test('Spotify skip restrictions block commands without issuing requests', async () => {
  let calls = 0; const s = service(async () => { calls++; return { ...data('a'), actions: { disallows: { skipping_next: true, skipping_prev: true } } }; });
  s.active = true; await s.poll();
  await assert.rejects(s.control({ action: 'next', trackId: 'a' }), /does not allow/);
  await assert.rejects(s.control({ action: 'previous', trackId: 'a' }), /does not allow/);
  assert.equal(calls, 1); s.stop();
});
test('saved tint endpoints survive loading without changing existing settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verse-tint-')), file = path.join(dir, 'prefs.json');
  for (const tint of [0, 42, 100]) {
    const p = new Preferences(file); p.set({ tint, collapsed: true, x: 12, y: 34 });
    const restored = new Preferences(file).value;
    assert.equal(restored.tint, tint); assert.equal(restored.collapsed, true); assert.equal(restored.x, 12);
  }
});
