const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_PATH = path.join(__dirname, '..', 'public', 'sw.js');
const SW_SOURCE = fs.readFileSync(SW_PATH, 'utf8');

function createHarness({ source = SW_SOURCE, offline = false } = {}) {
  const listeners = new Map();
  const cacheWrites = [];
  const fetches = [];
  const installedAssets = [];
  const cacheEntries = new Map();
  const absoluteUrl = (value) => new URL(typeof value === 'string' ? value : value.url, self.location.href).href;
  const cache = {
    async addAll(urls) {
      installedAssets.push(...urls);
      for (const url of urls) cacheEntries.set(absoluteUrl(url), { ok: true, cachedUrl: absoluteUrl(url) });
    },
    async match(request) { return cacheEntries.get(absoluteUrl(request)) || null; },
    async put(request, response) {
      cacheWrites.push(request.url);
      cacheEntries.set(absoluteUrl(request), response);
    },
  };
  const self = {
    location: new URL('https://app.example.test/app/sw.js?v=11'),
    clients: { async claim() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
    skipWaiting() {},
  };
  const context = vm.createContext({
    caches: {
      async delete() {},
      async keys() { return []; },
      async open() { return cache; },
    },
    fetch: async (request) => {
      fetches.push(request.url);
      if (offline) throw new Error('Synthetic offline network');
      return {
        ok: true,
        clone() { return this; },
      };
    },
    Response: { error() { return { ok: false }; } },
    self,
    Set,
    URL,
  });
  vm.runInContext(source, context, { filename: SW_PATH });
  return { cacheWrites, fetches, listeners, installedAssets };
}

function request(url, headers = []) {
  const names = new Set(headers.map((name) => name.toLowerCase()));
  return {
    url,
    method: 'GET',
    mode: 'cors',
    headers: { has(name) { return names.has(String(name).toLowerCase()); } },
  };
}

async function dispatchFetch(harness, targetRequest) {
  let responsePromise = null;
  const background = [];
  harness.listeners.get('fetch')({
    request: targetRequest,
    respondWith(promise) { responsePromise = Promise.resolve(promise); },
    waitUntil(promise) { background.push(Promise.resolve(promise)); },
  });
  if (responsePromise) await responsePromise;
  await Promise.all(background);
  return responsePromise;
}

test('the service worker never handles or caches a sync API under a same-origin apiBase subpath', async () => {
  const harness = createHarness();
  const handled = await dispatchFetch(harness, request(
    'https://app.example.test/app/backend/api/sync/pull',
    ['X-Sync-Token'],
  ));

  assert.equal(handled, null);
  assert.deepEqual(harness.fetches, []);
  assert.deepEqual(harness.cacheWrites, []);
});

test('the service worker ignores every non-shell same-origin GET even without an auth header', async () => {
  const harness = createHarness();
  const handled = await dispatchFetch(
    harness,
    request('https://app.example.test/app/backend/api/sync/pull'),
  );

  assert.equal(handled, null);
  assert.deepEqual(harness.fetches, []);
  assert.deepEqual(harness.cacheWrites, []);
});

test('the service worker still refreshes and caches an explicit shell asset', async () => {
  const harness = createHarness();
  const handled = await dispatchFetch(harness, request('https://app.example.test/app/client.js?v=11'));

  assert.notEqual(handled, null);
  assert.deepEqual(harness.fetches, ['https://app.example.test/app/client.js?v=11']);
  assert.deepEqual(harness.cacheWrites, ['https://app.example.test/app/client.js?v=11']);
});

test('launcher and header icons are part of the offline shell', async () => {
  for (const name of ['app-icon.png', 'app-icon-192.png', 'app-icon-64.png']) {
    const harness = createHarness();
    const url = `https://app.example.test/app/icons/${name}`;
    assert.notEqual(await dispatchFetch(harness, request(url)), null);
    assert.deepEqual(harness.cacheWrites, [url]);
  }
});

async function install(harness) {
  let installing;
  harness.listeners.get('install')({ waitUntil(promise) { installing = promise; } });
  await installing;
}

test('HTML core asset versions, worker registration and precache URLs stay aligned', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="((?:styles\.css|compat\.js|client\.js)(?:\?[^\"]*)?)"/g)]
    .map((match) => match[1]);
  assert.equal(assets.length, 3);
  const registration = app.match(/serviceWorker\.register\('([^']+)'\)/);
  assert.ok(registration, 'service worker registration must have a versioned URL');
  const workerUrl = new URL(registration[1], 'https://app.example.test/app/');
  assert.equal(workerUrl.pathname, '/app/sw.js');
  const version = workerUrl.searchParams.get('v');
  assert.ok(version, 'service worker registration must bypass stale CDN caches');
  assert.ok(SW_SOURCE.includes(`order-report-shell-v${version}'`), 'cache namespace must match the code version');
  const harness = createHarness();
  await install(harness);
  for (const asset of assets) {
    assert.equal(new URL(asset, workerUrl).search, `?v=${version}`, `${asset} must share the worker version`);
    assert.ok(harness.installedAssets.includes(`./${asset}`), `${asset} must be precached for offline use`);
  }
  const codeAssets = harness.installedAssets.filter((url) => /\.(?:js|css)(?:\?|$)/.test(url));
  assert.deepEqual(codeAssets.slice().sort(), assets.map((url) => `./${url}`).sort());
});

test('versioned core assets remain available offline after installation', async () => {
  const harness = createHarness({ offline: true });
  await install(harness);
  for (const name of ['styles.css', 'compat.js', 'client.js']) {
    const url = `https://app.example.test/app/${name}?v=11`;
    const response = await dispatchFetch(harness, request(url));
    assert.equal(response.cachedUrl, url);
  }
  assert.deepEqual(harness.cacheWrites, [], 'offline fallbacks must not replace cached assets');
});

test('an older exact-whitelist worker does not intercept the new versioned code URLs', async () => {
  const legacySource = SW_SOURCE.split('?v=11').join('');
  const harness = createHarness({ source: legacySource });
  for (const name of ['styles.css', 'compat.js', 'client.js']) {
    assert.equal(await dispatchFetch(harness, request(`https://app.example.test/app/${name}?v=11`)), null);
  }
  assert.deepEqual(harness.fetches, []);
  assert.deepEqual(harness.cacheWrites, []);
});

test('current workers do not intercept stale or unversioned code or authenticated shell requests', async () => {
  const harness = createHarness();
  for (const suffix of ['', '?v=10', '?v=12', '?v=11&extra=1']) {
    assert.equal(await dispatchFetch(harness, request(`https://app.example.test/app/client.js${suffix}`)), null);
  }
  assert.equal(await dispatchFetch(harness, request('https://app.example.test/app/client.js?v=11', ['X-Sync-Token'])), null);
  assert.deepEqual(harness.fetches, []);
  assert.deepEqual(harness.cacheWrites, []);
});
