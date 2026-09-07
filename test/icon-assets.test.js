const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name));

test('app icon exports have real PNG dimensions matching the web manifest', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  for (const [name, size] of [['app-icon.png', 512], ['app-icon-192.png', 192], ['app-icon-64.png', 64]]) {
    const png = read(`public/icons/${name}`);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    if (size > 64) {
      const entry = manifest.icons.find((icon) => icon.src === `icons/${name}`);
      assert.ok(entry);
      assert.equal(entry.sizes, `${size}x${size}`);
      assert.equal(entry.type, 'image/png');
      assert.match(entry.purpose, /maskable/);
    }
  }
});

test('the lightweight header icon and all launcher artwork are bundled locally', () => {
  assert.match(read('public/index.html').toString(), /src="icons\/app-icon-64\.png"/);
  assert.deepEqual(read('android/app/src/main/res/drawable-nodpi/ic_launcher_art.png'), read('public/icons/app-icon.png'));
  assert.match(read('android/app/src/main/res/mipmap-anydpi-v33/ic_launcher.xml').toString(), /@drawable\/ic_launcher_monochrome/);
});
