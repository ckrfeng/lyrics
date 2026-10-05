const path = require('node:path');
(async () => {
  const { packager } = await import('@electron/packager');
  const allowed = ['/package.json', '/main.cjs', '/preload.cjs', '/index.html', '/onboarding.html', '/privacy.html', '/src', '/assets'];
  const paths = await packager({
    dir: path.resolve(__dirname, '../lyric-beta'), name: 'Verse', platform: 'darwin', arch: process.arch,
    out: path.resolve(__dirname, '../dist'), overwrite: true, asar: true,
    appBundleId: 'com.ckrfeng.verse', appCategoryType: 'public.app-category.music',
    electronVersion: require('electron/package.json').version,
    download: { cacheRoot: process.env.ELECTRON_CACHE },
    ignore: file => file !== '' && !allowed.some(p => file === p || file.startsWith(`${p}/`)),
    prune: false
  });
  console.log(`Local unsigned macOS build: ${paths.join(', ')}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
