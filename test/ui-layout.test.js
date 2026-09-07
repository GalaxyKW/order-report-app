const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Domain = require('../shared/domain');

const publicRoot = path.join(__dirname, '..', 'public');
const browserPath = process.env.ORDER_REPORT_CSS_BROWSER;
const screenshotRoot = process.env.ORDER_REPORT_UI_SCREENSHOTS;
const widths = [320, 390, 620, 768, 1440];

// Use only the packaged public files, never server.js, runtime data, credentials,
// or an existing browser profile. The allowlist also excludes directory traversal.
function publicFiles(directory = publicRoot, prefix = '') {
  const files = new Map();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const item of publicFiles(absolute, relative)) files.set(...item);
    } else if (entry.isFile() && /\.(?:html|css|js|svg|png|jpe?g|webp|ico|webmanifest|woff2?)$/i.test(entry.name)) {
      files.set(relative, fs.readFileSync(absolute));
    }
  }
  return files;
}

async function staticServer() {
  const files = publicFiles();
  const blockedApi = [];
  const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(400).end(); return; }
    if (!['GET', 'HEAD'].includes(request.method) || /(?:^|\/)api(?:\/|$)/.test(pathname) || request.headers['x-sync-token']) {
      blockedApi.push(`${request.method} ${pathname}`);
      response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Business APIs are disabled in UI tests');
      return;
    }
    const filename = pathname === '/' ? '/index.html' : pathname;
    const body = files.get(filename);
    if (!body) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, blockedApi, origin: `http://127.0.0.1:${server.address().port}` };
}

// Chrome's null-delimited CDP pipe avoids a WebSocket or browser-driver package.
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
    child, send,
    on(method, callback) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(callback);
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 1500);
      await exited;
      clearTimeout(force);
    },
  };
}

function previewStorage() {
  const now = '2026-09-01T10:00:00.000Z';
  const op = {
    opId: 'preview-op', clientId: 'preview-client', createdAt: now, type: 'report.create',
    payload: {
      report: { id: 'preview-report', occurredAt: now, originalMessage: '仅供界面测试的虚构报单' },
      items: [{ id: 'preview-item', productName: '示例收纳盒', note: '浅蓝色', quantity: 3, actualPaymentCents: 12800, expectedRefundCents: 13800, expectedRebateCents: 600 }],
    },
  };
  const { state } = Domain.applyOperation(Domain.emptyState(), op, { now, idFactory: (prefix) => `preview-${prefix}` });
  return { state, queue: [], settings: { apiBase: '', token: '' }, clientId: 'preview-client', localRevision: 0, storageRevision: 0, hasSynced: false };
}

function layoutReport() {
  const issues = [];
  const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const textLines = (node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const tops = new Set();
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      for (const rect of range.getClientRects()) if (rect.width && rect.height) tops.add(Math.round(rect.top));
    }
    return tops.size;
  };
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push(`document overflow: ${document.documentElement.scrollWidth}/${innerWidth}`);
  const brand = document.querySelector('.brand img');
  if (!brand || !brand.complete || brand.naturalWidth <= 0 || !visible(brand)) issues.push('brand image failed to load or is invisible');
  const navigation = [...document.querySelectorAll('.nav-item[data-view]')];
  if (navigation.length !== 6) issues.push(`expected six navigation items, found ${navigation.length}`);
  for (const button of navigation) {
    const icon = button.querySelector('svg');
    const label = button.querySelector('.nav-label');
    const bounds = icon && icon.getBoundingClientRect();
    if (!icon || !visible(icon) || bounds.width < 8 || bounds.height < 8 || getComputedStyle(icon).opacity === '0') issues.push(`invisible nav icon: ${button.dataset.view}`);
    if (!label || !visible(label) || textLines(label) !== 1) issues.push(`nav label wraps or is missing: ${button.dataset.view}`);
  }
  for (const button of document.querySelectorAll('button')) {
    if (!visible(button)) continue;
    const rect = button.getBoundingClientRect();
    const label = button.textContent.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (rect.left < -1 || rect.right > innerWidth + 1) issues.push(`button outside viewport: ${label} (${rect.left.toFixed(1)}..${rect.right.toFixed(1)})`);
    if (button.scrollWidth > button.clientWidth + 1) issues.push(`button contents overflow: ${label} (${button.scrollWidth}/${button.clientWidth})`);
    if (button.matches('.button, .link-button') && textLines(button) > 1) issues.push(`short button label wraps: ${label}`);
  }
  return { width: innerWidth, issues };
}

test('real packaged pages keep responsive navigation, actions and dialogs usable', {
  skip: !browserPath,
  timeout: 120000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-report-ui-'));
  let browser;
  let host;
  try {
    host = await staticServer();
    browser = chrome(path.join(directory, 'profile'));
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => browser.send(method, params, sessionId);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Network.setBypassServiceWorker', { bypass: true });
    const errors = [];
    const externalRequests = [];
    const blockedBusinessRequests = [];
    browser.on('Runtime.exceptionThrown', (event, session) => {
      if (session === sessionId) errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text);
    });
    browser.on('Fetch.requestPaused', (event, session) => {
      if (session !== sessionId) return;
      const url = new URL(event.request.url);
      const local = url.origin === host.origin;
      const businessApi = /(?:^|\/)api(?:\/|$)/.test(url.pathname);
      const allowed = local && ['GET', 'HEAD'].includes(event.request.method) && !businessApi;
      const request = `${event.request.method} ${url.origin}${url.pathname}`;
      // Startup sync is expected even without a token. Refuse it before it
      // reaches the static server; never provide or contact a business backend.
      if (local && businessApi) blockedBusinessRequests.push(request);
      else if (!allowed) externalRequests.push(request);
      send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed
        ? { requestId: event.requestId } : { requestId: event.requestId, errorReason: 'BlockedByClient' })
        .catch((error) => errors.push(error.message));
    });
    await send('Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }] });
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('order-report-local-v1', ${JSON.stringify(JSON.stringify(previewStorage()))});`,
    });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const click = async (selector) => {
      const point = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
        element.scrollIntoView({block:'center', inline:'center'});
        const rect = element.getBoundingClientRect();
        return { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 };
      })()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    };
    const screenshot = async (name) => {
      if (!screenshotRoot) return;
      fs.mkdirSync(screenshotRoot, { recursive: true });
      const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(screenshotRoot, `${name}.png`), Buffer.from(result.data, 'base64'));
    };
    for (const width of widths) {
      await t.test(`${width}px layout and interactions`, async () => {
        await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width <= 768 });
        await send('Page.navigate', { url: `${host.origin}/index.html?ui-layout=${width}` });
        let ready = false;
        const deadline = Date.now() + 10000;
        while (!ready && Date.now() < deadline) {
          try { ready = await evaluate(`location.search === '?ui-layout=${width}' && document.readyState === 'complete' && !!document.querySelector('#main-content h1')`); }
          catch { /* Navigation briefly destroys the preceding JS context. */ }
          if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(ready, 'the real application did not render');
        await evaluate('document.fonts.ready.then(() => true)');
        const issues = [];
        const checkLayout = async (view) => {
          const report = await evaluate(`(${layoutReport.toString()})()`);
          assert.equal(report.width, width, 'viewport emulation must use CSS pixels');
          issues.push(...report.issues.map((issue) => `${view}: ${issue}`));
        };
        await checkLayout('dashboard');
        await screenshot(`${width}-dashboard`);
        for (const action of ['new-report', 'new-shipment', 'new-refund']) {
          await click(`.quick-actions .quick-action[data-action="${action}"]`);
          assert.ok(await evaluate('!!document.querySelector(".modal[role=dialog]")'), `${action} must open a dialog`);
          await checkLayout(action);
          if (action === 'new-report' && [390, 768, 1440].includes(width)) await screenshot(`${width}-report-dialog`);
          await click('.modal-heading [data-action="close-modal"]');
          assert.equal(await evaluate('!!document.querySelector(".modal")'), false, 'the dialog close button must work');
        }
        await click('.quick-actions .quick-action[data-view="inventory"]');
        assert.equal(await evaluate('document.querySelector(".nav-item.active").dataset.view'), 'inventory');
        for (const view of ['dashboard', 'reports', 'shipments', 'inventory', 'refunds', 'settings']) {
          await click(`.nav-item[data-view="${view}"] svg`);
          assert.deepEqual(await evaluate('[...document.querySelectorAll(".nav-item.active")].map(node => node.dataset.view)'), [view]);
          assert.equal(await evaluate(`document.querySelector('.nav-item[data-view="${view}"]').getAttribute('aria-current')`), 'page');
          await checkLayout(view);
          if (['reports', 'settings'].includes(view) && [320, 390, 1440].includes(width)) {
            await evaluate('window.scrollTo(0,0)');
            await screenshot(`${width}-${view}`);
          }
        }
        assert.deepEqual(issues, [], issues.join('\n'));
      });
    }
    assert.deepEqual(errors, [], 'the page must not throw JavaScript errors');
    assert.deepEqual(externalRequests, [], 'the fixture must not attempt external services or non-static requests');
    assert.deepEqual(host.blockedApi, [], 'the fixture must not reach a business API');
    t.diagnostic(`Intercepted and refused ${blockedBusinessRequests.length} automatic local sync requests before HTTP access`);
    if (screenshotRoot) t.diagnostic(`Screenshots: ${path.resolve(screenshotRoot)}`);
  } finally {
    if (browser) await browser.close();
    if (host) {
      host.server.closeAllConnections();
      await new Promise((resolve) => host.server.close(resolve));
    }
    // Chrome's child processes can finish writing the isolated profile just
    // after the main process exits. Retry removal of this known temp tree.
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
