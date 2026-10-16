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
      // Give Chrome's storage processes time to flush and exit, rather than
      // terminating the browser while those children are still using its files.
      const terminate = setTimeout(() => child.kill('SIGTERM'), 3000);
      const force = setTimeout(() => child.kill('SIGKILL'), 6000);
      try { await send('Browser.close'); }
      catch { /* Closing the browser may close the CDP pipe before its reply. */ }
      await exited;
      clearTimeout(terminate);
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
      items: [
        { id: 'preview-item', productName: '示例收纳盒', note: '浅蓝色', quantity: 3, actualPaymentCents: 12800, expectedRefundCents: 13800, expectedRebateCents: 600 },
        { id: 'preview-unrelated-item', productName: '尚未发货的示例便签', quantity: 2, actualPaymentCents: 400, expectedRefundCents: 400, expectedRebateCents: 0 },
      ],
    },
  };
  let { state } = Domain.applyOperation(Domain.emptyState(), op, { now, idFactory: (prefix) => `preview-${prefix}` });
  let serial = 0;
  const apply = (type, payload) => {
    state = Domain.applyOperation(state, {
      opId: `preview-closed-op-${++serial}`, clientId: 'preview-client', createdAt: now, type, payload,
    }, { now, idFactory: (prefix) => `preview-closed-${prefix}-${++serial}` }).state;
  };
  apply('shipment.create', {
    shipment: { id: 'preview-closed-shipment', trackingNumber: 'DEMO-CLOSED-ONLY', shippedAt: '2026-09-02', shippingCostCents: 0 },
    items: [{ productName: '示例收纳盒', quantity: 2 }],
  });
  apply('settlement.create', { settlement: { id: 'preview-settlement', shipmentId: 'preview-closed-shipment', amountCents: 9200, settledAt: '2026-09-03' } });
  apply('shipment.close', { id: 'preview-closed-shipment' });
  apply('report.create', {
    report: { id: 'preview-second-report', occurredAt: '2026-09-02T10:00', originalMessage: '另一笔仅供测试的虚构报单' },
    items: [{ id: 'preview-second-item', productName: '示例文件袋', quantity: 1, actualPaymentCents: 500, expectedRefundCents: 500, expectedRebateCents: 0 }],
  });
  apply('shipment.create', {
    shipment: { id: 'preview-multi-shipment', trackingNumber: 'DEMO-MULTI-SOURCE', shippedAt: '2026-09-04', shippingCostCents: 0 },
    items: [{ productName: '示例收纳盒', quantity: 1 }, { productName: '示例文件袋', quantity: 1 }],
  });
  apply('settlement.create', { settlement: { id: 'preview-multi-settlement', shipmentId: 'preview-multi-shipment', amountCents: 5100, settledAt: '2026-09-05' } });
  apply('shipment.close', { id: 'preview-multi-shipment' });
  apply('report.create', {
    report: { id: 'preview-duplicate-report', occurredAt: '2026-09-06T10:00', originalMessage: '同名合并与输入交互专用虚构报单' },
    items: [
      { id: 'preview-duplicate-item', productName: '尚未发货的示例便签', quantity: 3, actualPaymentCents: 0, expectedRefundCents: 0, expectedRebateCents: 0 },
      { id: 'preview-usb-item', productName: 'USB 示例收纳袋', quantity: 3, actualPaymentCents: 0, expectedRefundCents: 0, expectedRebateCents: 0 },
    ],
  });
  assert.equal(Domain.isStateSnapshot(state), true);
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
    // Tablet tables deliberately scroll inside their bounded panel. Their
    // clipped columns are not page overflow; the interaction helper still
    // scrolls each action into view and proves the click hits that control.
    const scroller = button.closest('.table-wrap');
    const scrollBounds = scroller && scroller.getBoundingClientRect();
    const horizontallyScrollable = scroller && /^(auto|scroll)$/.test(getComputedStyle(scroller).overflowX)
      && scroller.scrollWidth > scroller.clientWidth + 1
      && scrollBounds.left >= -1 && scrollBounds.right <= innerWidth + 1;
    if ((rect.left < -1 || rect.right > innerWidth + 1) && !horizontallyScrollable) issues.push(`button outside viewport: ${label} (${rect.left.toFixed(1)}..${rect.right.toFixed(1)})`);
    if (button.scrollWidth > button.clientWidth + 1) issues.push(`button contents overflow: ${label} (${button.scrollWidth}/${button.clientWidth})`);
    if (button.matches('.button, .link-button') && textLines(button) > 1) issues.push(`short button label wraps: ${label}`);
  }
  for (const label of document.querySelectorAll('.rebate-default > span, .rebate-item-meta > span, .rebate-item-editor .field > label')) {
    if (visible(label) && textLines(label) > 1) issues.push(`short rebate label wraps: ${label.textContent.trim()}`);
  }
  for (const input of document.querySelectorAll('.rebate-item-editor .input')) {
    const rect = input.getBoundingClientRect();
    if (visible(input) && (rect.left < -1 || rect.right > innerWidth + 1)) issues.push('rebate amount input outside viewport');
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
      const point = await evaluate(`(async () => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
        element.scrollIntoView({block:'center', inline:'center'});
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !element.contains(hit)) throw new Error('Control is obstructed: ' + ${JSON.stringify(selector)} + '; bounds ' + JSON.stringify({x,y,width:rect.width,height:rect.height}) + '; hit ' + (hit ? hit.outerHTML.slice(0, 300) : 'nothing'));
        return { x, y };
      })()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
    };
    const fill = async (selector, value) => {
      await click(selector);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
      // A browser input event, not a direct assignment to application state.
      await send('Input.insertText', { text: value });
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
        const rebateRow = '.rebate-item-editor[data-item-id="preview-item"]';
        const defaultCheckbox = `${rebateRow} [data-field="useExpected"]`;
        const amountInput = `${rebateRow} [data-field="actualRebateCents"]`;
        const rebateEditorState = () => evaluate(`(() => {
          const row = document.querySelector(${JSON.stringify(rebateRow)});
          const input = row.querySelector('[data-field="actualRebateCents"]');
          return { useExpected: row.querySelector('[data-field="useExpected"]').checked,
            disabled: input.disabled, value: input.value, preview: row.querySelector('[data-rebate-preview]').textContent };
        })()`);
        const checkProfit = async (expected) => {
          await click('.nav-item[data-view="dashboard"] svg');
          const value = await evaluate(`(() => {
            const card = [...document.querySelectorAll('.stat-card')].find(node => node.querySelector('.stat-label').textContent === '利润');
            return card && card.querySelector('.stat-value').textContent;
          })()`);
          assert.equal(value, `¥${expected}`, 'the rendered profit must reflect the saved actual rebate');
          await checkLayout(`profit-${expected}`);
        };
        const openRebate = async () => {
          await click('.nav-item[data-view="reports"] svg');
          await click('[data-action="edit-rebate"][data-id="preview-report"]');
          assert.ok(await evaluate('!!document.querySelector("form[data-form=rebate]")'), 'the report rebate entry must open its editor');
        };
        const saveRebate = async () => {
          await click('form[data-form="rebate"] button[type="submit"]');
          assert.equal(await evaluate('!!document.querySelector(".modal")'), false, 'saving the rebate must close the dialog');
        };
        const persistedRebate = () => evaluate(`(() => {
          const stored = JSON.parse(localStorage.getItem('order-report-local-v1'));
          const item = stored.state.reportItems.find(row => row.id === 'preview-item');
          const lastOperation = stored.queue[stored.queue.length - 1];
          return { hasOverride: Object.prototype.hasOwnProperty.call(item, 'actualRebateCents'),
            value: item.actualRebateCents == null ? null : item.actualRebateCents,
            operationType: lastOperation.type, operationValue: lastOperation.payload.items[0].actualRebateCents };
        })()`);
        const closedFinancials = () => evaluate(`(() => {
          const state = JSON.parse(localStorage.getItem('order-report-local-v1')).state;
          return { shipments: state.shipments, shipmentItems: state.shipmentItems, settlements: state.settlements };
        })()`);
        const originalClosedFinancials = await closedFinancials();
        assert.ok(originalClosedFinancials.shipments[0].closedAt, 'the private-data-free fixture must start with a closed shipment');
        assert.equal(originalClosedFinancials.settlements.length, 2);

        await checkProfit('16.00');
        await openRebate();
        assert.deepEqual(await rebateEditorState(), {
          useExpected: true, disabled: true, value: '6.00', preview: '计入利润：¥6.00（已扣除退款部分）',
        });
        await checkLayout('rebate-default');
        await screenshot(`${width}-rebate-default`);
        await click(defaultCheckbox);
        assert.equal((await rebateEditorState()).disabled, false);
        await fill(amountInput, '0');
        assert.equal((await rebateEditorState()).preview, '计入利润：¥0.00（已扣除退款部分）');
        await checkLayout('rebate-zero-draft');
        await screenshot(`${width}-rebate-zero`);
        await saveRebate();
        assert.deepEqual(await persistedRebate(), {
          hasOverride: true, value: 0, operationType: 'report.rebate.update', operationValue: 0,
        });
        await checkProfit('10.00');
        await openRebate();
        assert.deepEqual(await rebateEditorState(), {
          useExpected: false, disabled: false, value: '', preview: '计入利润：¥0.00（已扣除退款部分）',
        }, 'reopening must preserve an explicitly saved zero, not substitute the forecast');
        await checkLayout('rebate-zero-reopened');
        await click(defaultCheckbox);
        assert.deepEqual(await rebateEditorState(), {
          useExpected: true, disabled: true, value: '6.00', preview: '计入利润：¥6.00（已扣除退款部分）',
        });
        await saveRebate();
        assert.deepEqual(await persistedRebate(), {
          hasOverride: false, value: null, operationType: 'report.rebate.update', operationValue: null,
        });
        await checkProfit('16.00');
        await openRebate();
        assert.equal((await rebateEditorState()).useExpected, true, 'restoring the default must survive reopening');
        await click('.modal-heading [data-action="close-modal"]');
        assert.equal(await evaluate('!!document.querySelector(".modal")'), false);

        const openClosedShipmentRebate = async () => {
          await click('.nav-item[data-view="shipments"] svg');
          assert.equal(await evaluate(`!!document.querySelector('[data-action="edit-shipment"][data-id="preview-closed-shipment"], [data-action="add-settlement"][data-id="preview-closed-shipment"], [data-action="edit-settlement"][data-shipment-id="preview-closed-shipment"]')`), false, 'closed fulfillment and settlements must remain locked');
          await click('[data-action="edit-shipment-rebate"][data-id="preview-closed-shipment"]');
          assert.ok(await evaluate('!!document.querySelector("form[data-form=rebate]")'), 'closed shipment entry must open the rebate editor directly for one source');
          assert.equal(await evaluate('document.querySelectorAll(".rebate-item-editor").length'), 1);
          assert.ok(await evaluate('document.querySelector(".modal").textContent.includes("DEMO-CLOSED-ONLY")'), 'the source dialog must identify the originating shipment');
        };
        await openClosedShipmentRebate();
        await checkLayout('closed-shipment-rebate-default');
        await screenshot(`${width}-closed-shipment-rebate`);
        await click(defaultCheckbox);
        await fill(amountInput, '0');
        await saveRebate();
        assert.deepEqual(await persistedRebate(), {
          hasOverride: true, value: 0, operationType: 'report.rebate.update', operationValue: 0,
        });
        assert.deepEqual(await closedFinancials(), originalClosedFinancials, 'saving zero from a closed shipment must not reopen it or rewrite the final return');
        await checkProfit('10.00');
        await openClosedShipmentRebate();
        assert.equal((await rebateEditorState()).value, '');
        await fill(amountInput, '2.35');
        await checkLayout('closed-shipment-custom-rebate');
        await saveRebate();
        assert.deepEqual(await persistedRebate(), {
          hasOverride: true, value: 235, operationType: 'report.rebate.update', operationValue: 235,
        });
        assert.deepEqual(await closedFinancials(), originalClosedFinancials, 'a custom amount must leave the closed shipment and settlement exactly unchanged');
        await checkProfit('12.35');
        await openClosedShipmentRebate();
        assert.equal((await rebateEditorState()).value, '2.35');
        await click(defaultCheckbox);
        await saveRebate();
        assert.deepEqual(await persistedRebate(), {
          hasOverride: false, value: null, operationType: 'report.rebate.update', operationValue: null,
        });
        assert.deepEqual(await closedFinancials(), originalClosedFinancials, 'restoring the rebate default must preserve closure and the settlement ledger');
        await checkProfit('16.00');
        for (const [reportId, itemId] of [['preview-report', 'preview-item'], ['preview-second-report', 'preview-second-item']]) {
          await click('.nav-item[data-view="shipments"] svg');
          await click('[data-action="edit-shipment-rebate"][data-id="preview-multi-shipment"]');
          assert.ok(await evaluate('!!document.querySelector(".shipment-rebate-picker")'), 'mixed-source shipment must let the user choose the original report');
          assert.equal(await evaluate('document.querySelectorAll("[data-action=choose-shipment-rebate]").length'), 2);
          await checkLayout('closed-multi-source-picker');
          if (reportId === 'preview-report') await screenshot(`${width}-closed-multi-source-picker`);
          await click(`[data-action="choose-shipment-rebate"][data-id="${reportId}"][data-shipment-id="preview-multi-shipment"]`);
          assert.deepEqual(await evaluate('[...document.querySelectorAll(".rebate-item-editor")].map(row => row.dataset.itemId)'), [itemId], 'selected original report must expose only the items shipped in this parcel');
          assert.equal(await evaluate('document.querySelector("form[data-form=rebate]").elements.id.value'), reportId);
          await checkLayout(`closed-multi-source-${reportId}`);
          await click('.modal-heading [data-action="close-modal"]');
        }
        assert.deepEqual(await closedFinancials(), originalClosedFinancials, 'choosing sources must not mutate either closed shipment');

        // All following interactions use only the fictitious isolated profile.
        // Real mouse/keyboard events catch blur-before-click, accidental form
        // submissions, obscured steppers, and broken dependent previews.
        await click('.nav-item[data-view="reports"] svg');
        await click('[data-action="new-report"]');
        const productInput = '.report-item-editor [data-field="productName"]';
        const quantityInput = '.report-item-editor [data-field="quantity"]';
        const increase = '.report-item-editor [data-action="step-quantity"][data-step="1"]';
        const decrease = '.report-item-editor [data-action="step-quantity"][data-step="-1"]';
        const getValue = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).value`);
        assert.deepEqual(await evaluate(`[...document.querySelectorAll('form[data-form="report"] input[inputmode="decimal"]')].map(input => ({value:input.value, placeholder:input.placeholder, required:input.required}))`), [
          { value: '', placeholder: '0.00', required: false },
          { value: '', placeholder: '0.00', required: false },
          { value: '', placeholder: '0.00', required: false },
        ]);
        await fill(productInput, '便签');
        assert.equal(await evaluate(`document.querySelectorAll('.product-suggestions:not([hidden]) [data-action="choose-product-name"]').length`), 1, 'duplicate historic names must appear once');
        await click(quantityInput);
        await evaluate('new Promise(resolve => setTimeout(resolve, 20))');
        assert.equal(await evaluate('document.querySelectorAll(".product-suggestions:not([hidden])").length'), 0, 'moving focus outside the product field must close history');
        await fill(productInput, '便签');
        await checkLayout('product-history-open');
        await screenshot(`${width}-product-history`);
        await click('.product-suggestions:not([hidden]) [data-action="choose-product-name"]');
        assert.equal(await getValue(productInput), '尚未发货的示例便签', 'mouse selection must survive input blur');
        assert.ok(await evaluate('!!document.querySelector("form[data-form=report]")'), 'choosing history must not submit the form');
        await click(increase);
        assert.equal(await getValue(quantityInput), '2');
        await click(decrease);
        await click(decrease);
        assert.equal(await getValue(quantityInput), '1', 'quantity must stop at its minimum');
        await fill(quantityInput, '4');
        await click(increase);
        assert.equal(await getValue(quantityInput), '5', 'manual typing and stepping must cooperate');
        await fill(productInput, 'usb');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        assert.equal(await evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(productInput)});
          const event = new KeyboardEvent('keydown', {key:'Enter', code:'Enter', isComposing:true, bubbles:true, cancelable:true});
          return input.dispatchEvent(event);
        })()`), true, 'IME confirmation must not be prevented or choose a historical name');
        assert.equal(await getValue(productInput), 'usb');
        assert.ok(await evaluate('!!document.querySelector("form[data-form=report]")'));
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        assert.equal(await getValue(productInput), 'USB 示例收纳袋');
        assert.ok(await evaluate('!!document.querySelector("form[data-form=report]")'), 'Enter must choose history rather than save');
        await click('[data-action="add-report-item"]');
        assert.equal(await evaluate('document.querySelectorAll(".report-item-editor .quantity-control").length'), 2, 'new rows must include their quantity controls');
        const secondProductInput = '.report-item-editor:nth-child(2) [data-field="productName"]';
        await fill(secondProductInput, '便签');
        await click('.product-suggestions:not([hidden]) [data-action="choose-product-name"]');
        assert.equal(await getValue(secondProductInput), '尚未发货的示例便签');
        assert.equal(await getValue(productInput), 'USB 示例收纳袋', 'history selection must affect only its own row');
        await fill(secondProductInput, '不存在的名字');
        assert.equal(await evaluate('document.querySelectorAll(".product-suggestions:not([hidden]) [data-action=choose-product-name]").length'), 0);
        await fill(secondProductInput, '便签');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        assert.equal(await evaluate('document.querySelectorAll(".product-suggestions:not([hidden])").length'), 0);
        assert.ok(await evaluate('!!document.querySelector("form[data-form=report]")'), 'Escape should dismiss history before closing its editor');
        await click('.report-item-editor:nth-child(2) [data-action="remove-report-item"]');
        await fill(productInput, 'DEMO 新增零金额商品');
        await checkLayout('quantity-controls');
        await click('form[data-form="report"] button[type="submit"]');
        assert.equal(await evaluate('!!document.querySelector(".modal")'), false, 'blank zero-amount inputs must pass native validation and save');
        const savedZero = await evaluate(`(() => {
          const state = JSON.parse(localStorage.getItem('order-report-local-v1')).state;
          const item = state.reportItems.find(row => row.productName === 'DEMO 新增零金额商品');
          return item && {quantity:item.quantity, actualPaymentCents:item.actualPaymentCents, expectedRefundCents:item.expectedRefundCents, expectedRebateCents:item.expectedRebateCents};
        })()`);
        assert.deepEqual(savedZero, { quantity: 5, actualPaymentCents: 0, expectedRefundCents: 0, expectedRebateCents: 0 });

        await click('.nav-item[data-view="shipments"] svg');
        await click('[data-action="new-shipment"]');
        await evaluate(`(() => {
          const input = document.querySelector('.shipment-item-editor [data-field="productName"]');
          input.value = '尚未发货的示例便签';
          input.dispatchEvent(new Event('change', {bubbles:true}));
        })()`);
        const initialShipmentPreview = await evaluate('document.querySelector("#shipment-financial-preview").textContent');
        await click('.shipment-item-editor [data-action="step-quantity"][data-step="1"]');
        assert.equal(await getValue('.shipment-item-editor [data-field="quantity"]'), '2');
        assert.notEqual(await evaluate('document.querySelector("#shipment-financial-preview").textContent'), initialShipmentPreview, 'quantity clicks must refresh shipment financial totals');
        await checkLayout('shipment-quantity-stepper');
        await click('.modal-heading [data-action="close-modal"]');
        await click('.nav-item[data-view="inventory"] svg');
        await click('.inventory-group[data-product-name="尚未发货的示例便签"] details summary');
        await click('[data-action="new-refund"][data-id="preview-unrelated-item"]');
        const initialRefundAmount = await getValue('form[data-form="refund"] [name="amount"]');
        await click('form[data-form="refund"] [data-action="step-quantity"][data-step="1"]');
        assert.equal(await getValue('form[data-form="refund"] [name="quantity"]'), '2');
        assert.notEqual(await getValue('form[data-form="refund"] [name="amount"]'), initialRefundAmount, 'quantity clicks must recompute the read-only refund amount');
        await click('form[data-form="refund"] [data-action="step-quantity"][data-step="1"]');
        assert.equal(await getValue('form[data-form="refund"] [name="quantity"]'), '2', 'refund stepping must respect currently refundable stock');
        await checkLayout('refund-quantity-stepper');
        await click('.modal-heading [data-action="close-modal"]');

        const inventoryGroup = '.inventory-group[data-product-name="尚未发货的示例便签"]';
        assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(inventoryGroup)}).length`), 1, 'same-named inventory must share one product group');
        await click('[data-action="rename-inventory"][data-product-name="尚未发货的示例便签"]');
        assert.ok(await evaluate('!!document.querySelector("form[data-form=inventory-rename]")'));
        await fill('form[data-form="inventory-rename"] [name="newName"]', 'USB 示例收纳袋');
        await checkLayout('inventory-rename');
        await screenshot(`${width}-inventory-rename`);
        await click('form[data-form="inventory-rename"] button[type="submit"]');
        // A merge confirmation may intentionally intervene before dispatch.
        if (await evaluate('!!document.querySelector("[data-action=confirm-action]")')) await click('[data-action="confirm-action"]');
        assert.equal(await evaluate('!!document.querySelector(".modal")'), false, `renaming inventory must finish cleanly: ${await evaluate('JSON.stringify({modal:document.querySelector(".modal")?.textContent, toasts:[...document.querySelectorAll(".toast")].map(node=>node.textContent)})')}`);
        const renamed = await evaluate(`(() => {
          const stored = JSON.parse(localStorage.getItem('order-report-local-v1'));
          return { names:stored.state.reportItems.filter(item => ['preview-unrelated-item','preview-duplicate-item'].includes(item.id)).map(item => item.productName), op:stored.queue[stored.queue.length-1].type };
        })()`);
        assert.deepEqual(renamed, { names: ['USB 示例收纳袋', 'USB 示例收纳袋'], op: 'inventory.rename' });
        assert.equal(await evaluate('document.querySelectorAll(".inventory-group[data-product-name=\\"USB 示例收纳袋\\"]").length'), 1, 'renaming to an existing product must merge its visual inventory group');
        assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(inventoryGroup)}).length`), 0);
        await checkLayout('inventory-merged');
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
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
