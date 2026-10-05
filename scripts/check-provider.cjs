// Optional real-network check using metadata from LRCLIB's public documentation.
// Prints no lyrics and requires no Spotify credentials.
const { LyricsProvider } = require('../lyric-beta/src/lyrics.cjs');
new LyricsProvider().get({ title: 'I Want to Live', primaryArtist: 'Borislav Slavov',
  album: "Baldur's Gate 3 (Original Game Soundtrack)", duration: 233000 }).then(result => {
  console.log(`Live LRCLIB result: ${result.kind}; ${result.lines.length} timestamped lines.`);
  if (result.kind !== 'synced') process.exitCode = 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });
