const { artworkColor } = require('./core.js');
async function loadArtwork(url, nativeImage, signal) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !(parsed.hostname === 'i.scdn.co' || parsed.hostname.endsWith('.scdn.co'))) throw new Error('Unsupported artwork host');
  const response = await fetch(parsed, { signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), redirect: 'error' });
  if (!response.ok) throw new Error('Artwork unavailable');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Artwork too large');
    chunks.push(chunk);
  }
  const image = nativeImage.createFromBuffer(Buffer.concat(chunks));
  if (image.isEmpty()) throw new Error('Invalid artwork');
  const bitmap = image.resize({ width: 32, height: 32 }).toBitmap();
  // nativeImage bitmaps use BGRA on the supported little-endian desktops.
  const rgba = Uint8Array.from(bitmap);
  for (let i = 0; i < rgba.length; i += 4) [rgba[i], rgba[i + 2]] = [rgba[i + 2], rgba[i]];
  return { image: image.resize({ width: 96 }).toDataURL(), color: artworkColor(rgba) };
}
module.exports = { loadArtwork };
