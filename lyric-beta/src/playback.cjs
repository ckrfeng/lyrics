const { EventEmitter } = require('node:events');
const { normalizePlayback, ApiError } = require('./spotify.cjs');
const { LyricsProvider, LatestLyrics } = require('./lyrics.cjs');
const { loadArtwork } = require('./artwork.cjs');
class PlaybackService extends EventEmitter {
  constructor(api, nativeImage) {
    super(); this.api = api; this.nativeImage = nativeImage; this.active = false;
    this.hidden = false; this.collapsed = false; this.suspended = false; this.revision = 0;
    this.provider = new LyricsProvider();
    this.lyrics = new LatestLyrics(this.provider, (id, lyrics) => {
      if (this.state.track?.id !== id || !this.active) return;
      this.lyricsRetryAt = Date.now() + 30000; this.patch({ lyrics });
    });
    this.state = { mode: 'spotify', status: 'disconnected', message: 'Connect Spotify from the menu bar.', track: null, lyrics: null, artwork: null };
  }
  patch(value) { Object.assign(this.state, value); this.emit('state', this.state); }
  start() { this.stop(); this.active = true; this.patch({ status: 'loading', message: 'Finding your Spotify playback…', track: null, lyrics: null, artwork: null }); this.schedule(0); }
  stop() {
    this.active = false; this.revision++; clearTimeout(this.timer); this.requestController?.abort();
    this.commandController?.abort(); this.lyrics.cancel(); this.artController?.abort();
  }
  disconnect() {
    this.stop(); this.provider.clear(); this.controlBlockedUntil = 0;
    this.patch({ status: 'disconnected', message: 'Connect Spotify from the menu bar.', track: null, lyrics: null, artwork: null });
  }
  schedule(ms) { clearTimeout(this.timer); if (this.active && !this.suspended) this.timer = setTimeout(() => this.poll(), ms); }
  interval() { return this.hidden ? 30000 : this.collapsed ? 10000 : this.state.track?.playing ? 5000 : 12000; }
  visibility(hidden, collapsed) {
    const changed = this.hidden !== hidden || this.collapsed !== collapsed;
    this.hidden = hidden; this.collapsed = collapsed;
    if (this.active && changed) this.schedule(hidden ? this.interval() : 0);
  }
  suspend(value) {
    this.suspended = value;
    if (value) { clearTimeout(this.timer); this.revision++; this.requestController?.abort(); this.commandController?.abort(); this.lyrics.cancel(); this.artController?.abort(); this.freeze('Waiting for your Mac to wake…'); }
    else if (this.active) { this.patch({ status: 'loading', message: 'Resynchronizing Spotify…', track: null, lyrics: null, artwork: null }); this.schedule(0); }
  }
  freeze(message) {
    const track = this.state.track;
    if (track) this.state.track = { ...track, position: Math.min(track.duration, track.position + (track.playing ? Math.max(0, Date.now() - track.sampledAt) : 0)), playing: false, sampledAt: Date.now() };
    this.patch({ message });
  }
  async poll() {
    if (!this.active || this.suspended) return;
    if (this.polling || this.commanding) { this.schedule(500); return; }
    this.polling = true;
    const revision = this.revision;
    this.requestController = new AbortController();
    let delay = this.interval();
    try {
      const data = await this.api.request('/me/player', 'GET', this.requestController.signal);
      if (revision !== this.revision || !this.active) return;
      const track = normalizePlayback(data);
      if (!track) {
        this.lyrics.cancel(); this.artController?.abort();
        this.patch({ status: 'unavailable', message: data?.item ? 'Lyrics are available for music tracks. Play a song in Spotify.' : 'Open Spotify and play a song.', track: null, lyrics: null, artwork: null });
      } else {
        const changed = track.id !== this.state.track?.id;
        if (changed) this.controlBlockedUntil = 0;
        if (Date.now() < (this.controlBlockedUntil || 0)) { track.controls = { play: false, pause: false, seek: false }; track.controlReason = this.controlError; }
        if (!(this.api.auth.tokens?.scope || '').split(' ').includes('user-modify-playback-state')) {
          track.controls = { play: false, pause: false, seek: false }; track.controlReason = 'Reconnect Spotify to allow playback controls.';
        }
        this.patch({ status: 'ready', message: '', track, ...(changed ? { lyrics: { kind: 'loading', lines: [] }, artwork: null } : {}) });
        if (changed || (this.state.lyrics?.kind === 'error' && Date.now() >= this.lyricsRetryAt)) {
          this.patch({ lyrics: { kind: 'loading', lines: [] } });
          void this.lyrics.load(track);
        }
        if (changed) this.fetchArtwork(track);
      }
      delay = this.interval();
    } catch (error) {
      if (revision !== this.revision || !this.active) return;
      const code = error.code || 'network';
      this.freeze(error.message || 'Connection interrupted. Retrying…'); this.patch({ status: code });
      delay = code === 'rate' ? Math.max(1000, error.retryAt - Date.now()) : code === 'access' ? 60000 : 15000;
      if (code === 'auth') { this.active = false; this.emit('auth-required'); }
    } finally { this.polling = false; if (this.active) this.schedule(delay); }
  }
  fetchArtwork(track) {
    this.artController?.abort(); this.artController = new AbortController();
    const signal = this.artController.signal;
    if (!track.artworkUrl) return;
    loadArtwork(track.artworkUrl, this.nativeImage, signal).then(artwork => {
      if (!signal.aborted && this.active && this.state.track?.id === track.id) this.patch({ artwork });
    }).catch(() => {});
  }
  async control({ action, position, trackId }) {
    const track = this.state.track;
    if (this.commanding || !this.active || this.suspended || this.state.status !== 'ready' || !track || track.id !== trackId) throw new ApiError('Playback changed. Try again.', 'unavailable');
    if (!['play', 'pause', 'seek'].includes(action) || !track.controls[action]) throw new ApiError(track.controlReason || 'Spotify does not allow this control right now.', 'access');
    if (action === 'seek' && (!Number.isFinite(position) || position < 0 || position >= track.duration)) throw new ApiError('Invalid playback position.', 'unavailable');
    this.commanding = true; this.revision++; this.requestController?.abort(); clearTimeout(this.timer);
    const controller = new AbortController(); this.commandController = controller;
    const revision = this.revision;
    try {
      const route = action === 'seek' ? `/me/player/seek?position_ms=${Math.round(position)}` : `/me/player/${action}`;
      await this.api.request(route, 'PUT', controller.signal);
      if (revision !== this.revision || !this.active) return;
      const elapsed = track.playing ? Math.max(0, Date.now() - track.sampledAt) : 0;
      this.patch({ track: { ...track, position: action === 'seek' ? position : Math.min(track.duration, track.position + elapsed), playing: action === 'seek' ? track.playing : action === 'play', sampledAt: Date.now() }, message: '' });
    } catch (error) {
      if (revision !== this.revision || !this.active) return;
      if (error.code === 'access') {
        this.controlBlockedUntil = Date.now() + 60000; this.controlError = 'Controls need Premium and an API-enabled Spotify device. Retry in a minute.';
        this.patch({ track: { ...track, controls: { play: false, pause: false, seek: false }, controlReason: this.controlError } });
      }
      this.patch({ message: error.message }); throw error;
    } finally { this.commanding = false; if (this.active) this.schedule(Math.max(600, this.api.retryAt - Date.now())); }
  }
}
module.exports = { PlaybackService };
