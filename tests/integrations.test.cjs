const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SpotifyApi, normalizePlayback, retryDelay } = require('../lyric-beta/src/spotify.cjs');
const { LyricsProvider, LatestLyrics } = require('../lyric-beta/src/lyrics.cjs');
const track = { id: 'a', title: 'Original Song', primaryArtist: 'Original Artist', album: 'Original Album', duration: 90000 };
const record = { trackName: track.title, artistName: track.primaryArtist, albumName: track.album, duration: 90, syncedLyrics: '[00:01.00]An original sample line', plainLyrics: 'An original sample line' };
test('Spotify retries 401 exactly once with a refreshed token', async () => {
  const tokens = [], auth = { accessToken: async force => force ? 'new' : 'old' };
  const api = new SpotifyApi(auth, { fetchImpl: async (_url, options) => {
    tokens.push(options.headers.Authorization); return tokens.length === 1 ? new Response(null, { status: 401 }) : new Response(null, { status: 204 });
  } });
  assert.equal(await api.request('/me/player'), null); assert.deepEqual(tokens, ['Bearer old', 'Bearer new']);
});
test('Spotify stops at second 401', async () => {
  let calls = 0; const api = new SpotifyApi({ accessToken: async () => 'test' }, { fetchImpl: async () => { calls++; return new Response(null, { status: 401 }); } });
  await assert.rejects(api.request('/me/player'), e => e.code === 'auth'); assert.equal(calls, 2);
});
test('Spotify 429 respects Retry-After across endpoints and recognizes shared quota', async () => {
  let calls = 0; const api = new SpotifyApi({ accessToken: async () => 'test' }, { now: () => 1000, fetchImpl: async () => {
    calls++; return Response.json({ reason: 'QUOTA_EXCEEDED' }, { status: 429, headers: { 'Retry-After': '600' } });
  } });
  await assert.rejects(api.request('/me/player'), e => e.code === 'rate' && e.retryAt === 601000 && /quota/.test(e.message));
  await assert.rejects(api.request('/me/player/play', 'PUT'), e => e.code === 'rate'); assert.equal(calls, 1);
  assert.equal(retryDelay('60', 1000), 60000); assert.equal(retryDelay(null), 30000);
});
test('Spotify requests do not overlap', async () => {
  let active = 0, max = 0;
  const api = new SpotifyApi({ accessToken: async () => 'test' }, { fetchImpl: async () => {
    active++; max = Math.max(active, max); await new Promise(r => setTimeout(r, 5)); active--; return new Response(null, { status: 204 });
  } });
  await Promise.all([api.request('/me/player'), api.request('/me/player/pause', 'PUT')]); assert.equal(max, 1);
});
test('playback handles ads, local tracks, restrictions, and timestamp semantics', () => {
  assert.equal(normalizePlayback(null), null);
  assert.equal(normalizePlayback({ item: { type: 'episode' } }), null);
  assert.equal(normalizePlayback({ item: { type: 'track', is_local: true } }), null);
  const data = normalizePlayback({ item: { id: 'a', type: 'track', duration_ms: 90000 }, progress_ms: 20000, timestamp: 1,
    is_playing: true, device: { is_restricted: false }, actions: { disallows: { seeking: true } } });
  assert.equal(data.position, 20000); assert.ok(data.sampledAt > 10000); assert.equal(data.controls.seek, false); assert.equal(data.controls.pause, true);
});
test('lyrics match all four fields, prefer timestamps, identify client and cache', async () => {
  let calls = 0;
  const provider = new LyricsProvider({ fetchImpl: async (url, options) => {
    calls++; assert.equal(url.searchParams.get('album_name'), track.album); assert.equal(url.searchParams.get('duration'), '90');
    assert.match(options.headers['User-Agent'], /Verse.*github/); return Response.json(record);
  } });
  assert.equal((await provider.get(track)).kind, 'synced'); await provider.get(track); assert.equal(calls, 1);
});
test('lyrics do not accept a mismatched album or duration', async () => {
  for (const change of [{ albumName: 'Other Album' }, { duration: 95 }, { artistName: 'Other Artist' }]) {
    const provider = new LyricsProvider({ fetchImpl: async () => Response.json({ ...record, ...change }) });
    assert.equal((await provider.get(track)).kind, 'unavailable');
  }
});
test('lyrics plain/instrumental/404 responses are distinct; network failure is not cached as missing', async () => {
  for (const [data, kind] of [[{ ...record, syncedLyrics: null }, 'plain'], [{ ...record, instrumental: true }, 'instrumental'], [null, 'unavailable']]) {
    const provider = new LyricsProvider({ fetchImpl: async () => data ? Response.json(data) : new Response(null, { status: 404 }) });
    assert.equal((await provider.get(track)).kind, kind);
  }
  const provider = new LyricsProvider({ fetchImpl: async () => { throw new Error('offline'); } });
  await assert.rejects(provider.get(track)); assert.equal(provider.cache.size, 0);
});
test('LRCLIB handles non-JSON 429 and keeps provider-wide backoff', async () => {
  const provider = new LyricsProvider({ now: () => 1000, fetchImpl: async () => new Response('edge throttle', { status: 429, headers: { 'Retry-After': '20' } }) });
  await assert.rejects(provider.get(track), /busy/); assert.equal(provider.nextAt, 21000);
});
test('late lyrics from an old song cannot replace current lyrics, even if cancellation is ignored', async () => {
  const pending = {}, output = [];
  const latest = new LatestLyrics({ get: t => new Promise(r => { pending[t.id] = r; }) }, (id, result) => output.push([id, result]));
  const a = latest.load({ id: 'a' }), b = latest.load({ id: 'b' });
  pending.b({ kind: 'synced', lines: [] }); await b;
  pending.a({ kind: 'plain', text: 'old' }); await a;
  assert.deepEqual(output.map(x => x[0]), ['b']);
  const c = latest.load({ id: 'c' }); latest.cancel(); pending.c({ kind: 'plain' }); await c;
  assert.equal(output.length, 1);
});
