'use strict';

// Usage: ORDER_REPORT_CSS_BROWSER=/usr/bin/google-chrome node scripts/capture-readme.js
// This deliberately does not load server.js, runtime data, credentials, or an
// existing browser profile. Only the application shell and a synthetic fixture
// are read. Screenshots are unmodified PNGs returned by Chrome's screenshot API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createDemoStorage } = require('./readme-demo-data');

const projectRoot = path.join(__dirname, '..');
const browserPath = process.env.ORDER_REPORT_CSS_BROWSER;
const outputRoot = path.join(projectRoot, 'docs', 'screenshots');
const shellFiles = [
  'index.html', 'styles.css', 'compat.js', 'client.js', 'manifest.webmanifest', 'sw.js',
  'icons/app-icon.png', 'icons/app-icon-192.png', 'icons/app-icon-64.png',
];
const captures = [
  { filename: 'dashboard-desktop.png', view: 'dashboard', width: 1440, height: 1100 },
  { filename: 'dashboard-mobile.png', view: 'dashboard', width: 390, height: 900 },
  { filename: 'reports-mobile.png', view: 'reports', width: 390, height: 900 },
  { filename: 'rebate-mobile.png', view: 'reports', width: 390, height: 900, rebate: true },
];

async function staticServer() {
  const files = new Map(shellFiles.map((file) => {
    const filename = path.join(projectRoot, 'public', file);
    assert.ok(fs.lstatSync(filename).isFile(), `Not a regular packaged file: ${file}`);
    return [`/${file}`, fs.readFileSync(filename)];
  }));
  const violations = [];
  let servedRequests = 0;
  const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  const pathnameFor = (url) => {
    const pathname = decodeURIComponent(new URL(url).pathname);
    return pathname === '/' ? '/index.html' : pathname;
  };
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = pathnameFor(`http://localhost${request.url}`); }
    catch { response.writeHead(400).end(); return; }
    if (request.method !== 'GET' || !files.has(pathname)
      || Object.prototype.hasOwnProperty.call(request.headers, 'x-sync-token')) {
      violations.push(`${request.method} ${pathname}`);
      response.writeHead(403).end('Only packaged static files are available');
      return;
    }
    servedRequests += 1;
    response.writeHead(200, {
      'Content-Type': mime[path.extname(pathname)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      // Workers must not create a second, uninspected network context. This
      // changes no UI styles or application data; screenshots remain real DOM.
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'none'; child-src 'none'; object-src 'none'; form-action 'none'",
    });
    response.end(files.get(pathname));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    server, files, pathnameFor, violations,
    origin: `http://127.0.0.1:${server.address().port}`,
    servedRequests: () => servedRequests,
  };
}

function chrome(profile) {
  const child = spawn(browserPath, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-component-update', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--remote-debugging-pipe',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let nextId = 0;
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  const listeners = new Map();
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  const rejectPending = (error) => {
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); }
    pending.clear();
  };
  child.on('error', rejectPending);
  child.on('exit', (code) => rejectPending(new Error(`Chrome exited (${code}): ${stderr}`)));
  child.stdio[4].setEncoding('utf8');
  child.stdio[4].on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id) {
        const job = pending.get(message.id);
        if (!job) continue;
        pending.delete(message.id);
        clearTimeout(job.timer);
        if (message.error) job.reject(new Error(`${job.method}: ${message.error.message}`));
        else job.resolve(message.result);
      } else {
        for (const callback of listeners.get(message.method) || []) callback(message.params, message.sessionId);
      }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}; ${stderr}`)); }, 15000);
    pending.set(id, { resolve, reject, timer, method });
    child.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
  });
  return {
    send,
    on(method, callback) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(callback);
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      const terminate = setTimeout(() => child.kill('SIGTERM'), 3000);
      const force = setTimeout(() => child.kill('SIGKILL'), 6000);
      try { await send('Browser.close'); }
      catch { /* Chrome may close its pipe before replying to Browser.close. */ }
      await exited;
      clearTimeout(terminate);
      clearTimeout(force);
    },
  };
}

function layoutProblems() {
  const problems = [];
  const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  if (document.documentElement.scrollWidth > innerWidth + 1) problems.push('document has horizontal overflow');
  const brand = document.querySelector('.brand img');
  if (!brand || !brand.complete || brand.naturalWidth <= 0) problems.push('brand image did not load');
  if (document.querySelector('form[data-form="settings"]')) problems.push('settings must never appear in README screenshots');
  for (const node of document.querySelectorAll('button, .rebate-item-editor .input')) {
    if (!visible(node)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.left < -1 || rect.right > innerWidth + 1) problems.push(`control outside viewport: ${node.textContent.trim().slice(0, 40)}`);
    if (node.tagName === 'BUTTON' && node.scrollWidth > node.clientWidth + 1) problems.push('button text overflows');
  }
  return problems;
}

async function main() {
  assert.ok(browserPath, 'Set ORDER_REPORT_CSS_BROWSER to a Chrome executable');
  const fixture = createDemoStorage();
  assert.deepEqual(fixture.settings, { apiBase: '', token: '' }, 'the fixture must have no endpoint or credentials');
  assert.deepEqual(fixture.queue, [], 'the screenshot fixture must not have pending business operations');
  assert.ok(fixture.state.reports.some((row) => row.id === 'demo-report-1'));
  assert.ok(fixture.state.reportItems.some((row) => row.id === 'demo-item-1'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-report-readme-'));
  let host;
  let browser;
  try {
    host = await staticServer();
    browser = chrome(path.join(directory, 'profile'));
    const browserVersion = (await browser.send('Browser.getVersion')).product;
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => browser.send(method, params, sessionId);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setBypassServiceWorker', { bypass: true });
    const errors = [];
    const externalRequests = [];
    let refusedBusinessRequests = 0;
    browser.on('Runtime.exceptionThrown', (event, session) => {
      if (session === sessionId) errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text);
    });
    browser.on('Fetch.requestPaused', (event, session) => {
      if (session !== sessionId) return;
      const request = event.request;
      const url = new URL(request.url);
      const local = url.origin === host.origin;
      const allowed = local && request.method === 'GET' && host.files.has(host.pathnameFor(url.href))
        && !Object.keys(request.headers).some((header) => header.toLowerCase() === 'x-sync-token');
      if (!allowed) {
        if (local && /(?:^|\/)api(?:\/|$)/.test(url.pathname)) refusedBusinessRequests += 1;
        else externalRequests.push(`${request.method} ${url.origin}${url.pathname}`);
      }
      send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed
        ? { requestId: event.requestId } : { requestId: event.requestId, errorReason: 'BlockedByClient' })
        .catch((error) => errors.push(error.message));
    });
    await send('Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }] });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('order-report-local-v1', ${JSON.stringify(JSON.stringify(fixture))});`,
    });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const click = async (selector) => {
      const point = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) throw new Error('Missing screenshot control');
        node.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = node.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    };
    const results = [];
    for (const capture of captures) {
      await send('Emulation.setDeviceMetricsOverride', { width: capture.width, height: capture.height, deviceScaleFactor: 1, mobile: capture.width < 768 });
      await send('Page.navigate', { url: `${host.origin}/index.html?readme=${capture.filename}` });
      let ready = false;
      const deadline = Date.now() + 10000;
      while (!ready && Date.now() < deadline) {
        try { ready = await evaluate(`location.search === ${JSON.stringify(`?readme=${capture.filename}`)} && document.readyState === 'complete' && !!document.querySelector('#main-content h1')`); }
        catch { /* Navigation briefly destroys the preceding JS context. */ }
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(ready, `Application did not render for ${capture.filename}`);
      if (capture.view !== 'dashboard') await click(`.nav-item[data-view="${capture.view}"] svg`);
      assert.equal(await evaluate('document.querySelector(".nav-item.active").dataset.view'), capture.view);
      if (capture.rebate) {
        await click('[data-action="edit-rebate"][data-id="demo-report-1"]');
        assert.ok(await evaluate('!!document.querySelector("form[data-form=rebate]")'));
      }
      await evaluate('window.scrollTo(0, 0); document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
      assert.deepEqual(await evaluate(`(${layoutProblems.toString()})()`), [], `Layout check failed: ${capture.filename}`);
      const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const png = Buffer.from(screenshot.data, 'base64');
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Chrome must return an original PNG');
      assert.equal(png.readUInt32BE(16), capture.width, 'PNG width must match the documented viewport');
      assert.equal(png.readUInt32BE(20), capture.height, 'PNG height must match the documented viewport');
      results.push({ ...capture, png });
    }
    assert.deepEqual(errors, [], 'The screenshot pages must have no uncaught JavaScript errors');
    assert.deepEqual(externalRequests, [], 'Only local packaged assets and refused startup sync may be requested');
    assert.deepEqual(host.violations, [], 'No business request may reach the static HTTP server');
    fs.mkdirSync(outputRoot, { recursive: true });
    assert.ok(fs.lstatSync(outputRoot).isDirectory() && !fs.lstatSync(outputRoot).isSymbolicLink());
    for (const result of results) {
      const filename = path.join(outputRoot, result.filename);
      if (fs.existsSync(filename)) assert.ok(fs.lstatSync(filename).isFile(), 'Refuse to overwrite a non-regular screenshot target');
      fs.writeFileSync(filename, result.png);
    }
    process.stdout.write(`${JSON.stringify({
      source: 'isolated static public/ + scripts/readme-demo-data.js; original Page.captureScreenshot PNGs',
      browser: browserVersion,
      clientSha256: createHash('sha256').update(host.files.get('/client.js')).digest('hex'),
      syntheticDataOnly: true,
      servedStaticRequests: host.servedRequests(),
      refusedBusinessRequests,
      businessRequestsReachedServer: host.violations.length,
      uncaughtJavaScriptErrors: errors.length,
      screenshots: results.map(({ filename, width, height, png }) => ({ path: `docs/screenshots/${filename}`, width, height, bytes: png.length })),
    }, null, 2)}\n`);
  } finally {
    if (browser) await browser.close();
    if (host) {
      host.server.closeAllConnections();
      await new Promise((resolve) => host.server.close(resolve));
    }
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
