const { setTimeout: delay } = require('node:timers/promises');
const { parseLrc } = require('./core.js');
const { retryDelay } = require('./spotify.cjs');
const normalize = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
class LyricsProvider {
  constructor({ fetchImpl = fetch, now = Date.now } = {}) {
    this.fetch = fetchImpl; this.now = now; this.cache = new Map(); this.nextAt = 0; this.tail = Promise.resolve();
  }
  clear() { this.cache.clear(); }
  get(track, signal) {
    const run = () => this.lookup(track, signal);
    const result = this.tail.then(run, run); this.tail = result.catch(() => {}); return result;
  }
  async lookup(track, signal) {
    signal?.throwIfAborted();
    const key = JSON.stringify([track.title, track.primaryArtist, track.album, Math.round(track.duration / 1000)]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached.value;
    const seconds = track.duration / 1000;
    if (seconds < 1 || seconds > 3600 || !track.primaryArtist) return { kind: 'unavailable', lines: [] };
    // Respect provider-wide Retry-After, even if the user changes tracks.
    await delay(Math.max(0, this.nextAt - this.now()), null, { signal });
    signal?.throwIfAborted();
    const url = new URL('https://lrclib.net/api/get');
    url.search = new URLSearchParams({ track_name: track.title, artist_name: track.primaryArtist,
      album_name: track.album, duration: String(seconds) }).toString();
    let response;
    try {
      response = await this.fetch(url, { headers: { 'User-Agent': 'Verse/0.2.0 (https://github.com/ckrfeng/lyrics)', Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    } finally { this.nextAt = this.now() + 350; }
    if (response.status === 429 || response.status === 503) {
      this.nextAt = this.now() + retryDelay(response.headers.get('retry-after'), this.now());
      throw new Error('Lyrics service is busy. Retrying later.');
    }
    let value = { kind: 'unavailable', lines: [] };
    if (response.status !== 404 && response.status !== 204) {
      if (!response.ok) throw new Error('Lyrics service is temporarily unavailable.');
      const raw = await response.text();
      if (raw.length > 500000) throw new Error('Lyrics response is too large.');
      const data = JSON.parse(raw);
      // Avoid selecting another recording merely because a title is similar.
      const matched = normalize(data.trackName) === normalize(track.title) &&
        normalize(data.artistName) === normalize(track.primaryArtist) &&
        (!track.album || normalize(data.albumName) === normalize(track.album)) &&
        Number.isFinite(data.duration) && Math.abs(data.duration - seconds) <= 2;
      if (matched) {
        const lines = parseLrc(data.syncedLyrics).slice(0, 3000);
        if (data.instrumental) value = { kind: 'instrumental', lines: [] };
        else if (lines.some(l => l.text)) value = { kind: 'synced', lines };
        else if (typeof data.plainLyrics === 'string' && data.plainLyrics.trim()) value = { kind: 'plain', text: data.plainLyrics.trim(), lines: [] };
      }
    }
    signal?.throwIfAborted();
    this.cache.delete(key);
    const cacheControl = response.headers.get('cache-control') || '';
    const maxAge = cacheControl.match(/(?:^|,)\s*max-age=(\d+)/i);
    const ttl = Math.min(value.kind === 'unavailable' ? 300000 : 3600000, maxAge ? Number(maxAge[1]) * 1000 : Infinity);
    if (!/no-store|no-cache/i.test(cacheControl)) this.cache.set(key, { value, expires: this.now() + ttl });
    while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value);
    return value;
  }
}
class LatestLyrics {
  constructor(provider, onResult) { this.provider = provider; this.onResult = onResult; this.revision = 0; }
  cancel() { this.revision++; this.controller?.abort(); }
  async load(track) {
    this.cancel();
    const revision = this.revision;
    this.controller = new AbortController();
    try {
      const result = await this.provider.get(track, this.controller.signal);
      if (revision === this.revision) this.onResult(track.id, result);
    } catch {
      if (revision === this.revision) this.onResult(track.id, { kind: 'error', lines: [], message: 'Lyrics temporarily unavailable. Retrying…' });
    }
  }
}
module.exports = { LyricsProvider, LatestLyrics };
