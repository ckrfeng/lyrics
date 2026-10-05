const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { SpotifyAuth, createPkce, sameState, SCOPES } = require('../lyric-beta/src/auth.cjs');
function fixture(fetchImpl) {
  const store = { value: null, assertSecure() {}, save(x) { this.value = x; }, clear() { this.value = null; } };
  const auth = new SpotifyAuth({ clientId: 'a'.repeat(32), store, fetchImpl, now: () => 100000 });
  auth.tokens = { accessToken: 'old', refreshToken: 'refresh', expiresAt: 0, scope: SCOPES };
  return { auth, store };
}
test('PKCE is high-entropy S256 and state checking handles malformed unicode', () => {
  const p = createPkce(); assert.ok(p.verifier.length >= 43 && p.verifier.length <= 128);
  assert.equal(p.challenge, crypto.createHash('sha256').update(p.verifier).digest('base64url'));
  assert.notEqual(createPkce().state, p.state); assert.ok(sameState(p.state, p.state));
  assert.equal(sameState(null, p.state), false); assert.equal(sameState('é'.repeat(48), p.state), false);
});
test('concurrent refresh is single-flight and preserves omitted refresh token', async () => {
  let calls = 0, sent;
  const { auth, store } = fixture(async (_url, options) => {
    calls++; sent = options.body;
    await new Promise(resolve => setTimeout(resolve, 5));
    return Response.json({ access_token: 'new', expires_in: 3600 });
  });
  assert.deepEqual(await Promise.all([auth.accessToken(), auth.accessToken()]), ['new', 'new']);
  assert.equal(calls, 1); assert.equal(store.value.refreshToken, 'refresh');
  assert.equal(sent.get('client_id'), 'a'.repeat(32)); assert.equal(sent.has('client_secret'), false);
  assert.equal(store.value.expiresAt, 3700000);
});
test('token rotation is saved and invalid_grant disconnects without leaking response', async () => {
  const { auth, store } = fixture(async () => Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }));
  await auth.accessToken(); assert.equal(store.value.refreshToken, 'rotated');
  auth.fetch = async () => Response.json({ error: 'invalid_grant', secret: 'never print' }, { status: 400 });
  await assert.rejects(auth.accessToken(true), /expired/); assert.equal(auth.connected, false); assert.equal(store.value, null);
});
test('disconnect during refresh cannot restore credentials', async () => {
  let resolve;
  const { auth, store } = fixture(() => new Promise(r => { resolve = r; }));
  const refreshing = auth.accessToken(); auth.disconnect();
  resolve(Response.json({ access_token: 'late', refresh_token: 'late-refresh', expires_in: 3600 }));
  await assert.rejects(refreshing, /cancelled/); assert.equal(store.value, null); assert.equal(auth.connected, false);
});
test('network failures preserve refresh credentials for retry', async () => {
  const { auth } = fixture(async () => { throw new Error('network'); });
  await assert.rejects(auth.accessToken(), error => error.code === 'network'); assert.equal(auth.connected, true);
});
test('loopback login rejects wrong state and supports explicit cancellation', async () => {
  const store = { assertSecure() {}, save() {}, clear() {} };
  let opened;
  const auth = new SpotifyAuth({ clientId: 'a'.repeat(32), store, openExternal: async url => { opened = new URL(url); } });
  const pending = auth.connect(); const rejected = assert.rejects(pending, /cancelled/);
  for (let i = 0; !opened && i < 400; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(opened, 'Could not bind the loopback callback; run with local networking allowed');
  const response = await fetch('http://127.0.0.1:43821/callback?state=wrong&code=bad');
  assert.equal(response.status, 400); assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
  auth.cancel(); await rejected; assert.equal(auth.pending, null);
});
test('loopback successful PKCE exchange saves tokens only in the main-process store', async () => {
  let opened, saved, exchanged;
  const auth = new SpotifyAuth({ clientId: 'a'.repeat(32), store: { assertSecure() {}, save(x) { saved = x; } },
    openExternal: async url => { opened = new URL(url); }, fetchImpl: async (_url, options) => {
      exchanged = options.body; return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 });
    } });
  const pending = auth.connect(); pending.catch(() => {});
  for (let i = 0; !opened && i < 400; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(opened, 'Could not bind the loopback callback; run with local networking allowed');
  const callback = new URL(opened.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ code: 'fixture-code', state: opened.searchParams.get('state') }).toString();
  const response = await fetch(callback); assert.equal(response.status, 200); await pending;
  assert.equal(exchanged.get('code'), 'fixture-code'); assert.ok(exchanged.get('code_verifier'));
  assert.equal(saved.refreshToken, 'fixture-refresh'); assert.equal(auth.pending, null);
});
test('token endpoint Retry-After blocks repeated refresh attempts', async () => {
  let calls = 0;
  const { auth } = fixture(async () => { calls++; return new Response('slow down', { status: 429, headers: { 'Retry-After': '60' } }); });
  await assert.rejects(auth.accessToken(), e => e.code === 'rate' && e.retryAt === 160000);
  await assert.rejects(auth.accessToken(), e => e.code === 'rate'); assert.equal(calls, 1);
});
