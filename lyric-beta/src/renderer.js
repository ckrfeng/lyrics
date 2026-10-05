'use strict';
const { PlaybackClock, lineAt } = window.VerseCore;
const el = id => document.getElementById(id);
const overlay = el('overlay'), clock = new PlaybackClock();
let snapshot = { mode: 'demo' }, songIndex = 0, collapsed = false, busy = false, seeking = false, visible = true;
let sampledAt = null, lastTrack = null, tintTimer, resizeFrame, lastSize = '', demoStarted = false;
function sizeWindow() {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    const height = Math.ceil(overlay.getBoundingClientRect().height);
    const key = `${height}:${collapsed}`;
    if (key !== lastSize) { lastSize = key; window.verse?.resize(height, collapsed); }
  });
}
function tint(value) {
  overlay.style.setProperty('--tint', Number(value) / 100);
  el('opacity').value = value; el('opacity-value').textContent = `${value}%`;
}
function collapse(value, persist = true) {
  collapsed = value; overlay.classList.toggle('collapsed', value);
  if (persist) void window.verse?.preferences({ collapsed: value });
  (value ? el('pill') : el('collapse')).focus({ preventScroll: true }); sizeWindow();
}
function startDemo() {
  const song = window.VerseDemo[songIndex];
  demoStarted = true; sampledAt = null; lastTrack = null;
  clock.sync({ id: `demo-${songIndex}`, position: 0, duration: 90000, playing: true });
  el('title').textContent = song.title; el('artist').textContent = `${song.artist} · demo`;
  el('pill-title').textContent = song.title; el('art').style.background = song.art;
  el('art-image').hidden = true; el('art-placeholder').hidden = false;
  overlay.style.setProperty('--tone', song.tone.replaceAll(',', ' '));
  el('source').hidden = true; el('pill-demo').hidden = false;
  el('plain').hidden = true; el('current').hidden = false; el('following').hidden = false;
  el('lyrics').setAttribute('aria-label', 'Fictional demo lyrics');
  update();
}
function accept(next) {
  const wasDemo = snapshot.mode === 'demo'; snapshot = next;
  if (next.mode === 'demo') { if (!wasDemo || !demoStarted) startDemo(); return; }
  el('pill-demo').hidden = true;
  const track = next.track;
  if (track && (sampledAt !== track.sampledAt || lastTrack !== track.id)) {
    clock.sync(track, Math.min(30000, Math.max(0, Date.now() - track.sampledAt)));
    sampledAt = track.sampledAt; lastTrack = track.id;
  } else if (!track) { clock.reset(); lastTrack = null; sampledAt = null; }
  el('title').textContent = track?.title || 'Spotify'; el('artist').textContent = track?.artist || 'Verse';
  el('pill-title').textContent = track?.title || 'Waiting for Spotify';
  el('title').title = track?.title || ''; el('artist').title = track?.artist || '';
  el('lyrics').setAttribute('aria-label', 'Lyrics from LRCLIB');
  el('source').hidden = !track;
  el('art').style.background = 'linear-gradient(140deg,#6864a5,#272140)';
  if (next.artwork) {
    if (el('art-image').src !== next.artwork.image) el('art-image').src = next.artwork.image;
    el('art-image').hidden = false; el('art-placeholder').hidden = true;
    overlay.style.setProperty('--tone', next.artwork.color.join(' '));
  } else {
    el('art-image').hidden = true; el('art-image').removeAttribute('src'); el('art-placeholder').hidden = false;
    overlay.style.setProperty('--tone', '62 58 90');
  }
  const plain = next.lyrics?.kind === 'plain';
  el('plain').hidden = !plain; el('current').hidden = plain; el('following').hidden = plain;
  if (plain && el('plain').textContent !== next.lyrics.text) { el('plain').textContent = next.lyrics.text; el('plain').scrollTop = 0; }
  update();
}
function update() {
  const demo = snapshot.mode === 'demo';
  let position = clock.position(), current = '', following = '', status = '';
  if (demo && position >= 90000) { songIndex = (songIndex + 1) % window.VerseDemo.length; startDemo(); return; }
  if (demo) {
    const song = window.VerseDemo[songIndex], index = Math.min(song.lines.length - 1, Math.floor(position / 12000));
    current = song.lines[index]; following = song.lines[index + 1] || '♪';
  } else if (!snapshot.track) {
    current = snapshot.status === 'loading' ? 'Finding your song…' : snapshot.status === 'auth' ? 'Connect again' : 'Ready when you are';
    following = snapshot.message || 'Play a song in Spotify.';
  } else {
    const lyrics = snapshot.lyrics;
    if (lyrics?.kind === 'synced') {
      const index = lineAt(lyrics.lines, position);
      current = lyrics.lines[index]?.text || '♪'; following = lyrics.lines[index + 1]?.text || '♪';
    } else if (lyrics?.kind === 'instrumental') { current = 'Instrumental'; following = 'Let the music speak.'; }
    else if (lyrics?.kind === 'plain') status = 'Unsynchronized lyrics · scroll to read';
    else if (lyrics?.kind === 'unavailable') { current = 'No lyrics found'; following = 'Enjoy the music.'; }
    else if (lyrics?.kind === 'error') { current = 'Lyrics unavailable'; following = 'Trying again shortly…'; }
    else { current = 'Finding the words…'; following = ' '; }
    status = [snapshot.message || snapshot.track.controlReason, status].filter(Boolean).join(' · ');
    if (!status && !(snapshot.track.controls[clock.playing ? 'pause' : 'play'] && snapshot.track.controls.seek)) status = 'Some controls are unavailable for this playback.';
  }
  if (el('current').textContent !== current) el('current').textContent = current;
  if (el('following').textContent !== following) el('following').textContent = following;
  el('status').textContent = status; el('status').hidden = !status;
  el('play').textContent = clock.playing ? 'Ⅱ' : '▶'; overlay.classList.toggle('paused', !clock.playing);
  const action = clock.playing ? 'pause' : 'play';
  el('play').disabled = busy || (!demo && (snapshot.status !== 'ready' || !snapshot.track?.controls[action]));
  el('seek').disabled = busy || (!demo && (snapshot.status !== 'ready' || !snapshot.track?.controls.seek));
  el('play').setAttribute('aria-label', `${clock.playing ? 'Pause' : 'Play'} ${demo ? 'demo' : 'Spotify'}`);
  el('play').title = el('play').disabled ? (snapshot.track?.controlReason || snapshot.message || 'Spotify control unavailable') : el('play').getAttribute('aria-label');
  el('seek').title = el('seek').disabled ? (snapshot.track?.controlReason || snapshot.message || 'Seeking unavailable') : 'Seek';
  el('seek').setAttribute('aria-label', `${demo ? 'Demo' : 'Spotify'} playback position`);
  if (!seeking) { el('seek').max = Math.max(1, clock.duration - 1); el('seek').value = position; }
  const displayedPosition = seeking ? Number(el('seek').value) : position;
  el('seek').style.setProperty('--played', `${clock.duration ? displayedPosition / clock.duration * 100 : 0}%`);
  el('seek').setAttribute('aria-valuetext', `${Math.floor(displayedPosition / 1000)} seconds of ${Math.floor(clock.duration / 1000)}`);
  sizeWindow();
}
async function control(command) {
  busy = true; update();
  try {
    const response = await window.verse.control({ ...command, trackId: snapshot.track.id });
    if (!response.ok) { snapshot = { ...snapshot, message: response.message }; }
  } catch { snapshot = { ...snapshot, message: 'Playback control failed. Try again.' }; }
  finally { busy = false; update(); }
}
el('collapse').onclick = () => collapse(true); el('pill').onclick = () => collapse(false);
el('settings-button').onclick = () => {
  el('settings').hidden = !el('settings').hidden;
  el('settings-button').setAttribute('aria-expanded', String(!el('settings').hidden)); sizeWindow();
};
el('opacity').oninput = event => {
  tint(event.target.value); clearTimeout(tintTimer);
  tintTimer = setTimeout(() => window.verse?.preferences({ tint: Number(event.target.value) }), 120);
};
el('opacity').onchange = () => { clearTimeout(tintTimer); void window.verse?.preferences({ tint: Number(el('opacity').value) }); };
el('play').onclick = () => {
  if (snapshot.mode === 'demo') { clock.playing ? clock.pause() : clock.resume(); update(); }
  else void control({ action: clock.playing ? 'pause' : 'play' });
};
el('seek').oninput = () => { seeking = true; update(); };
el('seek').onchange = () => {
  const position = Number(el('seek').value); seeking = false;
  if (snapshot.mode === 'demo') { clock.seek(position); update(); }
  else void control({ action: 'seek', position });
};
el('seek').onpointercancel = () => { seeking = false; update(); };
el('spotify-link').onclick = () => window.verse?.openTrack();
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !el('settings').hidden) {
    el('settings').hidden = true; el('settings-button').setAttribute('aria-expanded', 'false'); el('settings-button').focus(); sizeWindow();
  }
});
new ResizeObserver(sizeWindow).observe(overlay);
setInterval(() => { if (visible && !document.hidden) update(); }, 100);
if (window.verse) {
  window.verse.onState(accept);
  window.verse.onVisibility(value => { visible = value; if (value) update(); });
  window.verse.init().then(initial => {
    document.body.classList.toggle('fallback', !initial.nativeGlass);
    tint(initial.preferences.tint); collapse(initial.preferences.collapsed, false); accept(initial.state);
  }).catch(() => { el('current').textContent = 'Please restart Verse'; });
} else {
  document.body.classList.add('preview'); el('preview-note').hidden = false; startDemo();
}
