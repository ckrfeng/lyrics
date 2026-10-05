const crypto = require('node:crypto');
const http = require('node:http');
const REDIRECT_URI = 'http://127.0.0.1:43821/callback';
const SCOPES = 'user-read-playback-state user-modify-playback-state';
class AuthError extends Error { constructor(message, code = 'auth') { super(message); this.code = code; } }
const sameState = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function createPkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), state: crypto.randomBytes(24).toString('hex') };
}
class SpotifyAuth {
  constructor({ clientId, store, openExternal, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { clientId, store, openExternal, fetch: fetchImpl, now });
    this.tokens = null; this.generation = 0; this.refreshing = null; this.pending = null;
  }
  load() { const saved = this.store.load(); this.tokens = saved?.clientId === this.clientId ? saved : null; }
  get connected() { return Boolean(this.tokens?.refreshToken); }
  cancel() { this.pending?.cancel(); }
  disconnect() { this.generation++; this.cancel(); this.tokens = null; this.refreshing = null; this.store.clear(); }
  async exchange(params, generation) {
    if (this.now() < (this.retryAt || 0)) throw this.rateError();
    let response;
    try {
      response = await this.fetch('https://accounts.spotify.com/api/token', { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.clientId, ...params }), signal: AbortSignal.timeout(15000) });
    } catch { throw new AuthError('Spotify login service is unreachable. Try again.', 'network'); }
    const body = await response.json().catch(() => ({}));
    if (generation !== this.generation) throw new AuthError('Login cancelled.', 'cancelled');
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      const seconds = header === null ? NaN : Number(header);
      const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - this.now();
      this.retryAt = this.now() + Math.max(1000, Number.isFinite(wait) ? wait : 30000);
      throw this.rateError();
    }
    if (!response.ok) {
      if (body.error === 'invalid_grant') { this.tokens = null; this.store.clear(); throw new AuthError('Spotify login expired. Connect again.'); }
      if (response.status >= 500) throw new AuthError('Spotify login service is temporarily unavailable. Try again later.', 'network');
      throw new AuthError('Spotify rejected this login. Check the Client ID and registered redirect URI.');
    }
    if (!body.access_token || !Number.isFinite(body.expires_in) || !(body.refresh_token || this.tokens?.refreshToken)) throw new AuthError('Spotify returned an incomplete login response.');
    const tokens = { clientId: this.clientId, accessToken: body.access_token,
      refreshToken: body.refresh_token || this.tokens.refreshToken,
      expiresAt: this.now() + body.expires_in * 1000, scope: body.scope ?? this.tokens?.scope ?? SCOPES };
    this.store.save(tokens);
    this.tokens = tokens;
    return tokens.accessToken;
  }
  rateError() {
    const error = new AuthError('Spotify login service is limiting requests. Wait before trying again.', 'rate');
    error.retryAt = this.retryAt; return error;
  }
  async accessToken(force = false, rejectedToken = null) {
    if (!this.tokens) throw new AuthError('Connect Spotify from the menu bar.');
    if (rejectedToken && rejectedToken !== this.tokens.accessToken) return this.tokens.accessToken;
    if (!force && this.tokens.expiresAt > this.now() + 60000) return this.tokens.accessToken;
    if (!this.refreshing) {
      const generation = this.generation;
      const operation = this.exchange({ grant_type: 'refresh_token', refresh_token: this.tokens.refreshToken }, generation);
      this.refreshing = operation;
      operation.finally(() => { if (this.refreshing === operation) this.refreshing = null; }).catch(() => {});
    }
    return this.refreshing;
  }
  connect() {
    if (this.pending) return this.pending.promise;
    this.store.assertSecure();
    if (!/^[a-f0-9]{32}$/i.test(this.clientId || '')) throw new AuthError('Enter your Spotify Client ID first.');
    const pkce = createPkce(), generation = ++this.generation;
    let resolve, reject, timer, settled = false, exchanging = false;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); server.close(); server.closeAllConnections();
      this.pending = null;
      if (error) reject(error); else resolve();
    };
    const server = http.createServer(async (request, response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      const url = new URL(request.url, REDIRECT_URI);
      if (request.method !== 'GET' || url.pathname !== '/callback' || request.headers.host !== '127.0.0.1:43821') { response.writeHead(404).end('Not found'); return; }
      if (!sameState(url.searchParams.get('state'), pkce.state)) { response.writeHead(400).end('Invalid login state. Return to Verse and try again.'); return; }
      if (exchanging) { response.writeHead(409).end('Login already in progress.'); return; }
      if (url.searchParams.has('error')) { response.end('Login cancelled. You can return to Verse.'); finish(new AuthError('Spotify login cancelled.', 'cancelled')); return; }
      const code = url.searchParams.get('code');
      if (!code || code.length > 4096) { response.writeHead(400).end('Missing authorization code.'); return; }
      exchanging = true;
      try {
        await this.exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: pkce.verifier }, generation);
        response.end('Spotify connected. You can close this tab and return to Verse.'); finish();
      } catch (error) { response.writeHead(400).end('Could not connect. Return to Verse for details.'); finish(error); }
    });
    server.on('error', () => finish(new AuthError('Login callback port 43821 is busy. Close another Verse instance and try again.')));
    this.pending = { promise, cancel: () => { this.generation++; finish(new AuthError('Spotify login cancelled.', 'cancelled')); } };
    timer = setTimeout(() => this.pending?.cancel(), 180000);
    server.listen(43821, '127.0.0.1', async () => {
      const url = new URL('https://accounts.spotify.com/authorize');
      url.search = new URLSearchParams({ client_id: this.clientId, response_type: 'code', redirect_uri: REDIRECT_URI,
        scope: SCOPES, state: pkce.state, code_challenge_method: 'S256', code_challenge: pkce.challenge }).toString();
      try { await this.openExternal(url.toString()); }
      catch { finish(new AuthError('Could not open your browser. Try connecting again.')); }
    });
    return promise;
  }
}
module.exports = { SpotifyAuth, AuthError, REDIRECT_URI, SCOPES, createPkce, sameState };
