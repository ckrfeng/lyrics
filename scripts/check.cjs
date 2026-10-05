const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function check(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) check(file);
    else if (/\.(c?js)$/.test(file)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}
check(path.resolve(__dirname, '..'));
console.log('JavaScript syntax checks passed.');
