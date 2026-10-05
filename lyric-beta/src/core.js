(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VerseCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  function parseLrc(source) {
    if (typeof source !== 'string') return [];
    const offset = Number(source.match(/\[offset\s*:\s*([+-]?\d+)\]/i)?.[1] || 0);
    const result = [];
    for (const line of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
      // Enhanced LRC word tags are stripped; Verse synchronizes whole lines.
      const text = line.replace(/\[[^\]]*\]/g, '').replace(/<\d+:\d{2}(?:\.\d+)?>/g, '').trim();
      for (const stamp of stamps) {
        if (Number(stamp[2]) >= 60) continue;
        // LRC's positive global offset makes lyrics appear sooner.
        const time = Number(stamp[1]) * 60000 + Number(stamp[2]) * 1000 + Number((stamp[3] || '').padEnd(3, '0')) - offset;
        result.push({ time: Math.max(0, time), text });
      }
    }
    result.sort((a, b) => a.time - b.time);
    const merged = [];
    for (const line of result) {
      const previous = merged.at(-1);
      if (previous?.time === line.time) {
        if (line.text && line.text !== previous.text) previous.text = [previous.text, line.text].filter(Boolean).join(' / ');
      } else merged.push({ ...line });
    }
    return merged;
  }

  function lineAt(lines, position) {
    let lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= position) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return found;
  }

  class PlaybackClock {
    constructor(now = () => performance.now()) { this.now = now; this.reset(); }
    reset() { this.sync({ position: 0, duration: 0, playing: false, id: null }); }
    sync({ position, duration, playing, id }, age = 0) {
      this.duration = Math.max(0, Number(duration) || 0);
      this.playing = Boolean(playing);
      this.id = id;
      this.base = clamp((Number(position) || 0) + (this.playing ? Math.max(0, age) : 0), 0, this.duration);
      this.anchor = this.now();
    }
    position() { return clamp(this.base + (this.playing ? Math.max(0, this.now() - this.anchor) : 0), 0, this.duration); }
    pause() { this.base = this.position(); this.anchor = this.now(); this.playing = false; }
    resume() { this.anchor = this.now(); this.playing = true; }
    seek(position) { this.base = clamp(position, 0, this.duration); this.anchor = this.now(); }
  }

  function safeBounds(bounds, displays) {
    const fallback = displays[0] || { x: 0, y: 0, width: 1440, height: 900 };
    const b = { width: 280, height: 210, ...bounds };
    const area = displays.find(d => b.x >= d.x && b.x < d.x + d.width && b.y >= d.y && b.y < d.y + d.height) || fallback;
    const width = Math.min(b.width, area.width), height = Math.min(b.height, area.height);
    return { x: Math.round(clamp(Number.isFinite(b.x) ? b.x : area.x + 20, area.x, area.x + area.width - width)),
      y: Math.round(clamp(Number.isFinite(b.y) ? b.y : area.y + 20, area.y, area.y + area.height - height)), width, height };
  }

  // Quantized dominant color; ignore nearly white/black pixels, then cap luminance.
  function artworkColor(rgba) {
    const buckets = new Map();
    for (let i = 0; i < rgba.length; i += 4) {
      const [r, g, b, a] = rgba.slice(i, i + 4);
      if (a < 128 || Math.max(r, g, b) < 24 || Math.min(r, g, b) > 232) continue;
      const key = [r >> 5, g >> 5, b >> 5].join(',');
      const cell = buckets.get(key) || { weight: 0, sum: [0, 0, 0] };
      const weight = 1 + (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      cell.weight += weight;
      [r, g, b].forEach((v, j) => { cell.sum[j] += v * weight; });
      buckets.set(key, cell);
    }
    const best = [...buckets.values()].sort((a, b) => b.weight - a.weight)[0];
    if (!best) return [62, 58, 90];
    const rgb = best.sum.map(v => v / best.weight);
    const luminance = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    const scale = Math.min(1, 90 / Math.max(1, luminance));
    return rgb.map(v => Math.round(clamp(v * scale, 22, 140)));
  }
  return { clamp, parseLrc, lineAt, PlaybackClock, safeBounds, artworkColor };
});
