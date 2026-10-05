const assert = require('node:assert/strict');
const path = require('node:path');
module.exports = async function verifyControls(app, page, output) {
  const screenshot = name => page.screenshot({ path: path.join(output, `${name}.png`), omitBackground: true });
  const geometry = () => page.evaluate(() => Object.fromEntries(['header', '.song-info', '#lyrics', '#play', '#overlay'].map(selector => {
    const r = document.querySelector(selector).getBoundingClientRect(); return [selector, [r.x, r.y, r.width, r.height]];
  })));
  const idle = async () => { await page.evaluate(() => document.activeElement.blur()); await page.mouse.move(-20, -20); await page.waitForTimeout(220); };
  await idle();
  const original = await geometry();
  assert.equal(await page.locator('#seek').evaluate(e => getComputedStyle(e).opacity), '0');
  await screenshot('idle');
  const glyph = await page.locator('#play svg').boundingBox();
  // Click the glyph's idle position as it starts moving. Its hit target must not move.
  await page.mouse.move(glyph.x + glyph.width / 2, glyph.y + glyph.height / 2);
  await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up();
  assert.equal(await page.locator('#play').getAttribute('aria-label'), 'Pause demo');
  await page.locator('#play').click();
  assert.equal(await page.locator('#play').getAttribute('aria-label'), 'Play demo');
  await page.locator('#lyrics').hover(); await page.waitForTimeout(220);
  assert.deepEqual(await geometry(), original, 'Hover must not move text, hit areas or resize the window');
  assert.equal(await page.locator('#seek').evaluate(e => getComputedStyle(e).opacity), '1');
  for (const id of ['previous-song', 'play', 'next-song']) {
    assert.equal(await page.locator(`#${id}`).evaluate(e => {
      const r = e.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === e;
    }), true, `${id} is clickable without overlap`);
  }
  await screenshot('hover');
  await idle(); await page.keyboard.press('Tab'); await page.waitForTimeout(220);
  assert.equal(await page.locator('#seek').evaluate(e => getComputedStyle(e).opacity), '1');
  assert.deepEqual(await geometry(), original);
  await screenshot('keyboard');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('#play svg').evaluate(e => getComputedStyle(e).transitionDuration), '0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await idle();
  assert.equal(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches), true);
  assert.equal(await page.locator('#seek').evaluate(e => getComputedStyle(e).opacity), '1');
  await screenshot('touch');
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await cdp.detach();
  await page.locator('#settings-button').click();
  for (const tint of [0, 100, 42]) {
    await page.locator('#opacity').fill(String(tint)); await page.locator('#opacity').dispatchEvent('input');
    await page.locator('#opacity').dispatchEvent('change'); await page.waitForTimeout(400);
    assert.equal(await page.locator('#opacity-value').textContent(), `${tint}%`);
    assert.equal(await page.locator('#current').evaluate(e => getComputedStyle(e).opacity), '1');
    const profile = await app.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(JSON.parse(require('node:fs').readFileSync(path.join(profile, 'preferences.json'))).tint, tint);
    await screenshot(`tint-${tint}`);
  }
  assert.equal((await page.locator('#settings').innerText()).replace(/\s+/g, ' '), 'Glass tint 42%');
  await page.locator('#settings-button').click();
  await page.locator('#collapse').click();
  assert.equal(await page.locator('#pill').textContent().then(s => s.includes('↗')), false);
  await page.locator('#pill').click();
  console.log('Reference UI verified: stable idle/hover/focus geometry, moving-glyph clicks, touch, reduced motion, 0–100 tint, saved endpoints and arrow-free pill.');
};
