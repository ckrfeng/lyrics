const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'verse-ui-'));
fs.mkdirSync(output, { recursive: true });
const errors = [];
let app;
async function launch(args = ['--demo']) {
  app = await electron.launch({ args: [path.join(root, 'lyric-beta'), ...args],
    env: { ...process.env, VERSE_TEST_USER_DATA: profile, ELECTRON_ENABLE_LOGGING: '0' } });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.getElementById('current')?.textContent.length > 0);
  return page;
}
async function fit(page) {
  await page.waitForTimeout(150);
  const actual = await page.evaluate(() => ({ h: window.innerHeight, content: Math.ceil(document.getElementById('overlay').getBoundingClientRect().height), width: window.innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.equal(actual.h, actual.content, JSON.stringify(actual)); assert.equal(actual.width, actual.scroll);
}
(async () => {
  let page = await launch();
  await fit(page);
  assert.match(await page.locator('#artist').textContent(), /demo/);
  await page.locator('#play').click();
  assert.equal(await page.locator('#play').getAttribute('aria-label'), 'Play demo');
  await require('./verify-controls.cjs')(app, page, output);
  await page.screenshot({ path: path.join(output, 'demo.png'), omitBackground: true });
  await page.locator('#settings-button').click(); await fit(page);
  assert.equal(await page.locator('#settings input').count(), 1);
  assert.equal(await page.locator('#settings button').count(), 0);
  await page.locator('#opacity').fill('73'); await page.locator('#opacity').dispatchEvent('input');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#opacity-value').textContent(), '73%');
  await page.screenshot({ path: path.join(output, 'tint.png'), omitBackground: true });
  await page.locator('#collapse').click(); await fit(page);
  assert.equal(await page.evaluate(() => innerWidth), 190); assert.equal(await page.evaluate(() => innerHeight), 44);
  await page.screenshot({ path: path.join(output, 'pill.png'), omitBackground: true });
  await app.close(); app = null;
  page = await launch();
  assert.equal(await page.locator('#overlay').evaluate(e => e.classList.contains('collapsed')), true);
  assert.equal(await page.locator('#opacity').inputValue(), '73');
  await page.locator('#pill').click(); await fit(page);
  await page.locator('#play').click();
  await page.evaluate(() => { window.VerseDemo.forEach(song => { song.lines = song.lines.map(() => 'We keep a little daylight here, carrying every color of the evening all the way home together.'); }); });
  await fit(page);
  assert.ok(await page.locator('#current').evaluate(e => e.getBoundingClientRect().height > 100));
  await page.screenshot({ path: path.join(output, 'wrapped.png'), omitBackground: true });
  // Real renderer + native window, with explicitly fictional API fixtures.
  const fixture = { mode: 'spotify', status: 'ready', message: '', artwork: null,
    track: { id: 'fixture', title: 'Fictional test track', artist: 'Test fixture', duration: 90000, position: 1000,
      playing: false, sampledAt: Date.now(), controls: { play: true, pause: true, seek: true, previous: true, next: true }, controlReason: '' } };
  async function sendFixture(patch) {
    await app.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('verse:state', state), { ...fixture, ...patch });
    await fit(page);
  }
  await sendFixture({ lyrics: { kind: 'plain', text: 'Original sample words\n'.repeat(40), lines: [] } });
  assert.equal(await page.locator('#plain').isVisible(), true);
  assert.match(await page.locator('#status').textContent(), /Unsynchronized/);
  assert.ok(await page.locator('#plain').evaluate(e => e.scrollHeight > e.clientHeight));
  await page.screenshot({ path: path.join(output, 'plain-fixture.png'), omitBackground: true });
  await sendFixture({ lyrics: { kind: 'instrumental', lines: [] } });
  assert.equal(await page.locator('#current').textContent(), 'Instrumental');
  await sendFixture({ lyrics: { kind: 'unavailable', lines: [] } });
  assert.equal(await page.locator('#current').textContent(), 'No lyrics found');
  await sendFixture({ status: 'network', message: 'Connection interrupted. Retrying Spotify…', lyrics: { kind: 'synced', lines: [{ time: 0, text: 'Original sample words' }] } });
  assert.equal(await page.locator('#play').isDisabled(), true);
  assert.equal(await page.locator('#seek').isDisabled(), true);
  assert.match(await page.locator('#status').textContent(), /Connection interrupted/);
  await sendFixture({ status: 'disconnected', track: null, lyrics: null, message: 'Connect Spotify from the menu bar.' });
  assert.match(await page.locator('#following').textContent(), /Connect Spotify/);
  const security = await app.evaluate(({ BrowserWindow, globalShortcut }) => {
    const w = BrowserWindow.getAllWindows()[0], p = w.webContents.getLastWebPreferences();
    return { sandbox: p.sandbox, isolated: p.contextIsolation, node: p.nodeIntegration, alwaysOnTop: w.isAlwaysOnTop(), shortcut: globalShortcut.isRegistered('CommandOrControl+Shift+L') };
  });
  assert.deepEqual(security, { sandbox: true, isolated: true, node: false, alwaysOnTop: true, shortcut: true });
  assert.equal(await page.evaluate(() => typeof require), 'undefined');
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(i => i.label === 'Show / Hide Verse').click());
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(i => i.label === 'Show / Hide Verse').click());
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items.find(i => i.label === 'Connect Spotify…').click());
  const setup = app.windows().find(w => w !== page) || await app.waitForEvent('window');
  await setup.waitForSelector('#client-id'); await setup.screenshot({ path: path.join(output, 'onboarding.png') });
  assert.equal(await setup.locator('#redirect').textContent(), 'http://127.0.0.1:43821/callback');
  assert.equal(await page.evaluate(async () => { try { await window.verseSetup.init(); return false; } catch { return true; } }), true);
  await setup.locator('#demo').click();
  assert.deepEqual(errors, []);
  console.log('Electron UI verified: demo, play/pause, tint-only settings, 190×44 pill, persistence, wrapped/plain/instrumental/unavailable lyrics, network/disconnected states, resizing, show/hide, onboarding, sandbox and IPC guards.');
  console.log(`Screenshots: ${output}`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (app) {
    // Explicitly quit on a failed assertion too: Verse intentionally hides on window-close.
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close();
  }
});
