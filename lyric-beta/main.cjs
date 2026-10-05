const { app, BrowserWindow, ipcMain, screen, globalShortcut, Tray, Menu, nativeImage, nativeTheme,
  safeStorage, shell, powerMonitor } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Preferences, TokenStore } = require('./src/storage.cjs');
const { SpotifyAuth, REDIRECT_URI } = require('./src/auth.cjs');
const { SpotifyApi } = require('./src/spotify.cjs');
const { PlaybackService } = require('./src/playback.cjs');
const { safeBounds } = require('./src/core.js');

app.setName('Verse');
if (!app.isPackaged && process.env.VERSE_TEST_USER_DATA) app.setPath('userData', process.env.VERSE_TEST_USER_DATA);
const forceDemo = process.argv.includes('--demo');
let win, setupWin, tray, prefs, auth, service, quitting = false, saveTimer, storageMessage = '';
let mode = 'demo';
const nativeGlass = process.platform === 'darwin' && process.env.VERSE_DISABLE_VIBRANCY !== '1';
let shortcutAvailable = false;
const overlayUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const setupUrl = pathToFileURL(path.join(__dirname, 'onboarding.html')).href;
const workAreas = () => screen.getAllDisplays().map(d => d.workArea);
function secureWindow(window) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
}
function validSender(event, window, url) {
  return window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === url;
}
function guard(event, type = 'overlay') {
  if (!(type === 'overlay' ? validSender(event, win, overlayUrl) : validSender(event, setupWin, setupUrl))) throw new Error('Untrusted IPC sender');
}
const result = async fn => { try { await fn(); return { ok: true }; } catch (error) { return { ok: false, message: error.message || 'Could not complete this action.' }; } };
function state() { return mode === 'demo' ? { mode: 'demo' } : service.state; }
function broadcast() { if (win && !win.isDestroyed()) win.webContents.send('verse:state', state()); }
function keepOnScreen() { if (win) win.setBounds(safeBounds(win.getBounds(), workAreas())); }
function savePosition() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (win && !win.isDestroyed()) { const { x, y } = win.getBounds(); prefs.set({ x, y }); } }, 250);
}
function visible(show) {
  if (show) { keepOnScreen(); win.showInactive(); } else win.hide();
  service.visibility(!show, prefs.value.collapsed);
  win.webContents.send('verse:visibility', show);
  if (show) broadcast();
  rebuildMenu();
}
function setMode(next, persist = true) {
  mode = next;
  if (persist) prefs.set({ mode, onboarded: true });
  service.stop();
  if (mode === 'spotify' && auth.connected) service.start();
  broadcast(); rebuildMenu();
}
function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) { setupWin.show(); setupWin.focus(); return; }
  setupWin = new BrowserWindow({ width: 420, height: 600, resizable: false, title: 'Connect Spotify · Verse',
    backgroundColor: '#16151f', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  secureWindow(setupWin); setupWin.loadFile(path.join(__dirname, 'onboarding.html'));
  setupWin.on('closed', () => { auth.cancel(); setupWin = null; });
}
function rebuildMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: win?.isVisible() ? 'Hide Verse' : 'Show Verse', click: () => visible(!win.isVisible()) },
    { type: 'separator' },
    { label: auth?.connected ? 'Reconnect Spotify…' : 'Connect Spotify…', click: openSetup },
    ...(auth?.connected || storageMessage ? [{ label: 'Disconnect Spotify', click: () => {
      auth.disconnect(); service.disconnect(); storageMessage = ''; setMode('spotify');
    } }] : []),
    ...(auth?.pending ? [{ label: 'Cancel Spotify login', click: () => auth.cancel() }] : []),
    { label: 'Demo mode · fictional songs', type: 'checkbox', checked: mode === 'demo', click: () => setMode(mode === 'demo' && auth.connected ? 'spotify' : 'demo') },
    ...(auth?.connected && mode === 'demo' ? [{ label: 'Use Spotify playback', click: () => setMode('spotify') }] : []),
    { label: 'Reset window position', click: () => { const d = screen.getPrimaryDisplay().workArea; win.setPosition(d.x + 20, d.y + 20); visible(true); } },
    { type: 'separator' },
    { label: 'Quit Verse', accelerator: 'CommandOrControl+Q', click: () => app.quit() }
  ]));
}
function environmentClientId() {
  if (process.env.SPOTIFY_CLIENT_ID) return process.env.SPOTIFY_CLIENT_ID.trim();
  if (app.isPackaged) return '';
  for (const file of [path.join(__dirname, '../.env'), path.join(__dirname, '.env')]) {
    try { const match = fs.readFileSync(file, 'utf8').match(/^\s*SPOTIFY_CLIENT_ID\s*=\s*["']?([a-f0-9]{32})["']?\s*$/im); if (match) return match[1]; } catch { /* optional */ }
  }
  return '';
}
function registerIpc() {
  ipcMain.handle('verse:init', event => { guard(event); return { preferences: { tint: prefs.value.tint, collapsed: prefs.value.collapsed }, state: state(), nativeGlass }; });
  ipcMain.on('verse:resize', (event, value) => {
    if (!validSender(event, win, overlayUrl) || !value || typeof value.collapsed !== 'boolean' || !Number.isFinite(value.height)) return;
    const width = value.collapsed ? 190 : 280;
    const height = Math.ceil(Math.max(value.collapsed ? 44 : 120, Math.min(value.height, 900)));
    win.setBounds(safeBounds({ ...win.getBounds(), width, height }, workAreas()));
    service.visibility(!win.isVisible(), value.collapsed);
  });
  ipcMain.handle('verse:preferences', (event, patch) => {
    guard(event);
    if (!patch || Object.keys(patch).some(k => !['tint', 'collapsed'].includes(k))) return { ok: false };
    const clean = {};
    if (typeof patch.collapsed === 'boolean') clean.collapsed = patch.collapsed;
    if (Number.isFinite(patch.tint) && patch.tint >= 25 && patch.tint <= 90) clean.tint = Math.round(patch.tint);
    prefs.set(clean); return { ok: true };
  });
  ipcMain.handle('verse:control', (event, command) => {
    guard(event);
    if (!command || typeof command.trackId !== 'string' || !['play', 'pause', 'seek'].includes(command.action) || mode !== 'spotify') return { ok: false, message: 'Invalid playback command.' };
    return result(() => service.control(command));
  });
  ipcMain.handle('verse:open-track', event => {
    guard(event);
    const url = service.state.track?.url;
    if (mode === 'spotify' && /^https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]+$/.test(url || '')) return result(() => shell.openExternal(url));
    return { ok: false };
  });
  ipcMain.handle('setup:init', event => { guard(event, 'setup'); return { clientId: auth.clientId || '', redirectUri: REDIRECT_URI, connected: auth.connected, message: storageMessage, shortcutAvailable }; });
  ipcMain.handle('setup:connect', (event, clientId) => {
    guard(event, 'setup');
    if (typeof clientId !== 'string' || !/^[a-f0-9]{32}$/i.test(clientId.trim())) return { ok: false, message: 'Enter the 32-character Client ID from your Spotify app.' };
    return result(async () => {
      if (auth.pending) throw new Error('Login is already open in your browser.');
      service.stop();
      if (auth.clientId !== clientId.trim()) auth.disconnect();
      auth.clientId = clientId.trim(); prefs.set({ clientId: auth.clientId });
      const pending = auth.connect(); rebuildMenu();
      try { await pending; storageMessage = ''; setMode('spotify'); visible(true); setupWin?.close(); }
      finally { rebuildMenu(); if (mode === 'spotify' && auth.connected && !service.active) service.start(); }
    });
  });
  ipcMain.handle('setup:cancel', event => { guard(event, 'setup'); auth.cancel(); return { ok: true }; });
  ipcMain.handle('setup:demo', event => { guard(event, 'setup'); auth.cancel(); setMode('demo'); visible(true); setupWin.close(); return { ok: true }; });
  ipcMain.handle('setup:help', (event, kind) => {
    guard(event, 'setup');
    if (kind === 'dashboard') return result(() => shell.openExternal('https://developer.spotify.com/dashboard'));
    if (kind === 'privacy') {
      const privacy = new BrowserWindow({ width: 520, height: 560, title: 'Verse privacy', backgroundColor: '#16151f', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      secureWindow(privacy); privacy.loadFile(path.join(__dirname, 'privacy.html')); return { ok: true };
    }
    return { ok: false };
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) visible(true); });
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'dark';
    prefs = new Preferences(path.join(app.getPath('userData'), 'preferences.json'));
    auth = new SpotifyAuth({ clientId: prefs.value.clientId || environmentClientId(),
      store: new TokenStore(path.join(app.getPath('userData'), 'spotify-tokens.enc'), safeStorage), openExternal: url => shell.openExternal(url) });
    if (!forceDemo) { try { auth.load(); } catch (error) { storageMessage = error.message; } }
    service = new PlaybackService(new SpotifyApi(auth), nativeImage);
    service.on('state', broadcast); service.on('auth-required', rebuildMenu);
    const bounds = safeBounds({ x: prefs.value.x, y: prefs.value.y, width: prefs.value.collapsed ? 190 : 280, height: prefs.value.collapsed ? 44 : 190 }, workAreas());
    win = new BrowserWindow({ ...bounds, frame: false, transparent: true, alwaysOnTop: true, resizable: false,
      maximizable: false, fullscreenable: false, hasShadow: false, roundedCorners: true, show: false,
      backgroundColor: '#00000000', ...(nativeGlass ? { vibrancy: 'hud', visualEffectState: 'active' } : {}),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: true } });
    secureWindow(win); win.setAlwaysOnTop(true, 'floating');
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on('move', savePosition);
    win.on('close', event => { if (!quitting) { event.preventDefault(); visible(false); } });
    screen.on('display-removed', keepOnScreen); screen.on('display-metrics-changed', keepOnScreen); screen.on('display-added', keepOnScreen);
    powerMonitor.on('suspend', () => service.suspend(true)); powerMonitor.on('resume', () => service.suspend(false));
    powerMonitor.on('lock-screen', () => service.suspend(true)); powerMonitor.on('unlock-screen', () => service.suspend(false));
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets/trayTemplate.png'));
    icon.setTemplateImage(true); tray = new Tray(icon); tray.setToolTip('Verse');
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Verse', submenu: [{ label: 'Connect Spotify…', click: openSetup }, { label: 'Show / Hide Verse', accelerator: 'CommandOrControl+Shift+L', click: () => visible(!win.isVisible()) }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }
    ]));
    registerIpc(); mode = forceDemo ? 'demo' : prefs.value.mode; setMode(mode, false);
    win.once('ready-to-show', () => {
      visible(true); if (!prefs.value.onboarded && !forceDemo) openSetup();
      if (process.platform === 'darwin') app.dock.hide();
    });
    win.loadFile(path.join(__dirname, 'index.html'));
    shortcutAvailable = globalShortcut.register('CommandOrControl+Shift+L', () => visible(!win.isVisible()));
    app.on('activate', () => visible(true));
  }).catch(() => { console.error('Verse could not start. Check file permissions and reinstall dependencies.'); app.quit(); });
}
app.on('before-quit', () => {
  quitting = true; clearTimeout(saveTimer);
  if (win && !win.isDestroyed() && prefs) { const { x, y } = win.getBounds(); prefs.set({ x, y }); }
  auth?.cancel(); service?.stop(); tray?.destroy();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
