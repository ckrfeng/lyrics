const { AuthError } = require('./auth.cjs');
class ApiError extends Error {
  constructor(message, code, retryAt = 0) { super(message); this.code = code; this.retryAt = retryAt; }
}
function retryDelay(header, now = Date.now()) {
  if (!header) return 30000;
  const seconds = Number(header);
  return Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : (Date.parse(header) - now || 30000));
}
class SpotifyApi {
  constructor(auth, { fetchImpl = fetch, now = Date.now } = {}) {
    this.auth = auth; this.fetch = fetchImpl; this.now = now; this.retryAt = 0; this.tail = Promise.resolve();
  }
  request(route, method = 'GET', signal) {
    // All player reads and writes share a queue, including token refresh and retry.
    const run = () => this.perform(route, method, signal);
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => {});
    return result;
  }
  async perform(route, method, signal) {
    if (signal?.aborted) throw signal.reason;
    if (this.now() < this.retryAt) throw new ApiError('Spotify is limiting requests. Waiting to retry.', 'rate', this.retryAt);
    let token = await this.auth.accessToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await this.fetch(`https://api.spotify.com/v1${route}`, { method,
          headers: { Authorization: `Bearer ${token}` },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new ApiError('Connection interrupted. Retrying Spotify…', 'network');
      }
      if (response.status === 401) {
        if (attempt === 0) { token = await this.auth.accessToken(true, token); continue; }
        throw new AuthError('Spotify authorization was rejected. Connect again.');
      }
      if (response.status === 429) {
        const body = await response.json().catch(() => ({}));
        const quota = (body.reason || body.error?.reason) === 'QUOTA_EXCEEDED';
        this.retryAt = this.now() + Math.max(retryDelay(response.headers.get('retry-after'), this.now()), quota ? 300000 : 0);
        throw new ApiError(quota ? 'Spotify developer quota reached. Waiting to retry.' : 'Spotify rate limit reached. Waiting to retry.', 'rate', this.retryAt);
      }
      if (response.status === 403) throw new ApiError('Spotify denied access. Check Premium, allowed users, and app access.', 'access');
      if (response.status === 404) throw new ApiError('Open Spotify and play a song on an active device.', 'unavailable');
      if (!response.ok) throw new ApiError('Spotify is temporarily unavailable. Retrying…', 'network');
      if (response.status === 204) return null;
      return response.json().catch(() => { throw new ApiError('Spotify returned an unreadable response. Retrying…', 'network'); });
    }
  }
}
function normalizePlayback(data) {
  const item = data?.item;
  if (!item || item.type !== 'track' || data.currently_playing_type === 'ad' || item.is_local) return null;
  const disallows = data.actions?.disallows || data.actions || {};
  const restricted = !data.device || data.device.is_restricted;
  const art = item.album?.images?.find(i => i.width >= 64 && i.width <= 640) || item.album?.images?.[0];
  return {
    id: item.id || item.uri, title: String(item.name || 'Unknown track'),
    artist: (item.artists || []).map(a => a.name).filter(Boolean).join(', ') || 'Unknown artist',
    primaryArtist: item.artists?.[0]?.name || '', album: item.album?.name || '',
    artworkUrl: art?.url || '', url: item.external_urls?.spotify || '',
    duration: Math.max(0, Number(item.duration_ms) || 0), position: Math.max(0, Number(data.progress_ms) || 0),
    playing: Boolean(data.is_playing), sampledAt: Date.now(),
    controls: { play: !restricted && !disallows.resuming, pause: !restricted && !disallows.pausing,
      previous: !restricted && !disallows.skipping_prev, next: !restricted && !disallows.skipping_next,
      seek: !restricted && !disallows.seeking && Number.isFinite(data.progress_ms) },
    controlReason: restricted ? 'This Spotify device does not allow remote controls.' : ''
  };
}
module.exports = { SpotifyApi, ApiError, retryDelay, normalizePlayback };
