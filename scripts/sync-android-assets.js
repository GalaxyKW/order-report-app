const fs = require('node:fs');
const path = require('node:path');
const { buildWebAssets } = require('./build-web-assets');

const root = path.resolve(__dirname, '..');
const sourcePublic = path.join(root, 'public');
const sourceApp = path.join(sourcePublic, 'app.js');
const target = path.join(root, 'android', 'app', 'src', 'main', 'assets');

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    // The Android page loads client.js. Do not also ship untransformed sources.
    if (from === sourceApp) continue;
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}

// Compile before touching the existing APK assets, so syntax/build failures do
// not replace a working bundle with an incomplete one.
buildWebAssets();
fs.rmSync(target, { recursive: true, force: true });
copyDirectory(sourcePublic, target);
console.log(`Android assets synced to ${target}`);
