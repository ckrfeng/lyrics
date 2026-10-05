const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLrc, lineAt, PlaybackClock, safeBounds, artworkColor } = require('../lyric-beta/src/core.js');
test('LRC supports fractions, repeated timestamps, metadata and blank musical breaks', () => {
  const lines = parseLrc('[ar:Artist]\r\n[00:03.125]third\n[00:01.2][00:02.34]repeat\n[00:04.000]\n[99:99.10]invalid');
  assert.deepEqual(lines, [{ time: 1200, text: 'repeat' }, { time: 2340, text: 'repeat' }, { time: 3125, text: 'third' }, { time: 4000, text: '' }]);
  assert.equal(lineAt(lines, 0), -1); assert.equal(lineAt(lines, 2340), 1); assert.equal(lineAt(lines, 5000), 3);
});
test('LRC offset, duplicate translations, enhanced word tags and BOM', () => {
  assert.deepEqual(parseLrc('\uFEFF[offset:-500]\n[00:01.000]<00:01.0>Hello\n[00:01.000]你好\n[00:00.200]start'),
    [{ time: 700, text: 'start' }, { time: 1500, text: 'Hello / 你好' }]);
  assert.deepEqual(parseLrc('[offset:500]\n[00:00.200]start\n[00:01.000]early'), [{ time: 0, text: 'start' }, { time: 500, text: 'early' }]);
  assert.deepEqual(parseLrc(null), []); assert.deepEqual(parseLrc('plain lyrics'), []);
});
test('clock handles pause, resume, backward seek, new track, remote corrections and duration', () => {
  let now = 100; const clock = new PlaybackClock(() => now);
  clock.sync({ id: 'a', position: 1000, duration: 10000, playing: true }, 100);
  now += 900; assert.equal(clock.position(), 2000);
  clock.pause(); now += 4000; assert.equal(clock.position(), 2000);
  clock.resume(); now += 300; assert.equal(clock.position(), 2300);
  clock.seek(100); now += 200; assert.equal(clock.position(), 300);
  clock.sync({ id: 'b', position: 0, duration: 2000, playing: false }); now += 10000; assert.equal(clock.position(), 0);
  clock.sync({ id: 'b', position: 1700, duration: 2000, playing: true }); now += 5000; assert.equal(clock.position(), 2000);
  clock.sync({ id: 'b', position: 900, duration: 2000, playing: false }); assert.equal(clock.position(), 900);
});
test('window is clamped after a monitor disappears, at negative coordinates, and on small screens', () => {
  assert.deepEqual(safeBounds({ x: 2000, y: 20, width: 280, height: 200 }, [{ x: 0, y: 25, width: 1440, height: 875 }]), { x: 1160, y: 25, width: 280, height: 200 });
  assert.equal(safeBounds({ x: -500, y: 30, width: 280, height: 200 }, [{ x: -1000, y: 0, width: 1000, height: 900 }]).x, -500);
  assert.equal(safeBounds({ height: 900 }, [{ x: 0, y: 0, width: 800, height: 600 }]).height, 600);
});
test('color extraction handles light, dark, saturated and transparent artwork', () => {
  assert.deepEqual(artworkColor([255, 255, 255, 255]), [62, 58, 90]);
  assert.deepEqual(artworkColor([0, 0, 0, 255]), [62, 58, 90]);
  assert.deepEqual(artworkColor([200, 100, 50, 0]), [62, 58, 90]);
  const color = artworkColor([250, 170, 30, 255, 250, 170, 30, 255, 10, 20, 90, 255]);
  assert.ok(color[0] > color[1] && color[1] > color[2]);
  assert.ok(color[0] * .2126 + color[1] * .7152 + color[2] * .0722 <= 91);
});
