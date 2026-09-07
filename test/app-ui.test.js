const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Domain = require('../shared/domain');

const appPath = path.join(__dirname, '..', 'public', 'app.js');
const source = fs.readFileSync(appPath, 'utf8');
const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const startupIndex = source.lastIndexOf('\n  localStorageRead();\n  render();');
assert.notEqual(startupIndex, -1, 'presentation harness must stop before storage/network startup');
const presentationSource = `${source.slice(0, startupIndex)}
  window.__ui = {
    app, icon, emptyState, dashboardQuickActions, renderDashboard, renderReports,
    renderShipments, renderInventory, renderRefunds, renderSettings, render, navigateView,
  };
})();`;
const views = ['dashboard', 'reports', 'shipments', 'inventory', 'refunds', 'settings'];
const labels = ['总览', '报单', '快递', '仓库', '退款', '设置'];

function createHarness() {
  const navigation = views.map((view) => {
    const attributes = new Map();
    return {
      dataset: { view },
      attributes,
      active: false,
      classList: { toggle(name, active) { if (name === 'active') navigation.find((item) => item.dataset.view === view).active = active; } },
      setAttribute(name, value) { attributes.set(name, value); },
      removeAttribute(name) { attributes.delete(name); },
    };
  });
  const main = { innerHTML: '' };
  const window = { OrderDomain: Domain };
  const document = {
    addEventListener() {},
    querySelector(selector) { return selector === '#main-content' ? main : null; },
    querySelectorAll(selector) { return selector === '.nav-item' ? navigation : []; },
  };
  vm.runInNewContext(presentationSource, { window, document }, { filename: appPath });
  return { ...window.__ui, navigation, main };
}

function sampleState() {
  let state = Domain.emptyState();
  let id = 0;
  const apply = (type, payload) => {
    state = Domain.applyOperation(state, {
      opId: `ui_op_${++id}`, clientId: 'ui_fixture', type, payload,
      createdAt: '2026-09-01T10:00:00.000Z',
    }, { idFactory: (prefix) => `${prefix}_${++id}`, now: '2026-09-01T10:00:00.000Z' }).state;
  };
  apply('report.create', {
    report: { id: 'ui_report', occurredAt: '2026-09-01T09:00', originalMessage: '测试报单' },
    items: [{ id: 'ui_item', productName: '测试商品', quantity: 4, actualPaymentCents: 4000, expectedRefundCents: 4800, expectedRebateCents: 400 }],
  });
  apply('shipment.create', {
    shipment: { id: 'ui_shipment', trackingNumber: 'UI-TEST-001', shippingCostCents: 300, shippedAt: '2026-09-01' },
    items: [{ productName: '测试商品', quantity: 2 }],
  });
  apply('settlement.create', { settlement: { id: 'ui_settlement', shipmentId: 'ui_shipment', amountCents: 2200, settledAt: '2026-09-01' } });
  apply('shipment.close', { id: 'ui_shipment' });
  apply('refund.create', { refund: { id: 'ui_refund', reportItemId: 'ui_item', quantity: 1, refundedAt: '2026-09-01' } });
  return state;
}

test('all navigation items retain visible labels and matching decorative inline icons', () => {
  const ui = createHarness();
  const items = [...shell.matchAll(/<button class="nav-item[^\"]*"[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
  assert.equal(items.length, 6);
  items.forEach((item, index) => {
    assert.ok(item.includes(`data-view="${views[index]}"`));
    assert.ok(item.includes(`<span class="nav-label">${labels[index]}</span>`));
    assert.ok(item.includes(ui.icon(views[index])), `static and dynamic ${views[index]} icons must match`);
    assert.match(item, /type="button"/);
    assert.match(item, /aria-controls="main-content"/);
    assert.equal(item.includes('aria-current="page"'), index === 0);
  });
  for (const name of ['sync', 'settings']) assert.ok(shell.includes(ui.icon(name)));
  assert.match(shell, /data-action="sync" aria-label="同步"/);
  assert.match(shell, /data-action="open-settings" aria-label="设置"/);
});

test('the brand keeps readable text alongside its small decorative image', () => {
  assert.match(shell, /<img class="brand-mark brand-icon" src="icons\/app-icon-64\.png" alt="" width="36" height="36">/);
  assert.match(shell, /<span class="brand-name">报单管家<\/span>/);
  assert.match(shell, /rel="icon" type="image\/png" href="icons\/app-icon-64\.png"/);
  assert.match(shell, /rel="apple-touch-icon" href="icons\/app-icon-192\.png"/);
});

test('changing views updates exactly one aria-current navigation item', () => {
  const ui = createHarness();
  for (const view of views) {
    ui.navigateView(view);
    ui.render();
    const active = ui.navigation.filter((item) => item.active);
    const current = ui.navigation.filter((item) => item.attributes.get('aria-current') === 'page');
    assert.equal(active.length, 1);
    assert.equal(current.length, 1);
    assert.equal(active[0].dataset.view, view);
    assert.equal(current[0].dataset.view, view);
    assert.match(ui.main.innerHTML, /<h1>/);
  }
});

test('dashboard shortcuts reuse the existing operation and navigation hooks', () => {
  const ui = createHarness();
  const shortcuts = ui.dashboardQuickActions();
  assert.equal((shortcuts.match(/class="quick-action"/g) || []).length, 4);
  for (const action of ['new-report', 'new-shipment', 'new-refund']) assert.ok(shortcuts.includes(`data-action="${action}"`));
  assert.ok(shortcuts.includes('data-view="inventory"'));
  for (const label of ['新增报单', '新增快递', '查看仓库', '登记退款']) assert.ok(shortcuts.includes(`<strong>${label}</strong>`));
  assert.equal((shortcuts.match(/class="quick-action-copy"/g) || []).length, 4);
  const dashboard = ui.renderDashboard();
  assert.ok(dashboard.indexOf('quick-actions-section') < dashboard.indexOf('card-grid'));
  assert.ok(dashboard.indexOf('stat-card-featured') < dashboard.indexOf('累计商品付款'));
});

test('all seven dashboard values retain the domain formulas for empty and populated data', () => {
  const ui = createHarness();
  for (const state of [Domain.emptyState(), sampleState()]) {
    ui.app.state = state;
    const before = JSON.stringify(state);
    const summary = Domain.stats(state);
    const expected = {
      '预计未返款': `¥${Domain.formatMoney(summary.outstandingCents)}`,
      '累计商品付款': `¥${Domain.formatMoney(summary.totalPurchaseCents)}`,
      '累计快递费用': `¥${Domain.formatMoney(summary.totalShippingCents)}`,
      '已返款': `¥${Domain.formatMoney(summary.returnedCents)}`,
      '利润': `¥${Domain.formatMoney(summary.profitCents)}`,
      '纯利润': `¥${Domain.formatMoney(summary.pureProfitCents)}`,
      '利率': `${(Number(summary.rate || 0) * 100).toFixed(2)}%`,
    };
    const html = ui.renderDashboard();
    const cards = [...html.matchAll(/<article class="stat-card[^\"]*">([\s\S]*?)<\/article>/g)].map((match) => match[1]);
    assert.equal(cards.length, 7);
    cards.forEach((card) => {
      const label = card.match(/<div class="stat-label">([^<]+)<\/div>/)[1];
      const value = card.match(/<div class="stat-value[^\"]*">([^<]+)<\/div>/)[1];
      assert.equal(value, expected[label], `${label} formula changed`);
      assert.match(card, /class="stat-icon"/);
    });
    for (const renderer of ['renderReports', 'renderShipments', 'renderInventory', 'renderRefunds', 'renderSettings']) ui[renderer]();
    assert.equal(JSON.stringify(ui.app.state), before, 'presentation must not mutate business data');
  }
});

test('empty states offer appropriate next steps without mistaking a search miss for missing data', () => {
  const ui = createHarness();
  assert.match(ui.renderReports(), /empty-state-actions[\s\S]*data-action="new-report"/);
  assert.match(ui.renderShipments(), /empty-state-actions[\s\S]*data-action="new-shipment"/);
  assert.match(ui.renderInventory(), /empty-state-actions[\s\S]*data-action="new-report"/);
  assert.match(ui.renderRefunds(), /empty-state-actions[\s\S]*data-view="inventory"/);
  ui.app.search = '没有这个商品';
  assert.match(ui.renderReports(), /data-icon="search"[\s\S]*没有匹配的报单/);
  assert.match(ui.renderShipments(), /data-icon="search"[\s\S]*没有匹配的快递/);
});

test('display helpers keep untrusted labels and product text escaped', () => {
  const ui = createHarness();
  const unsafe = '<img src=x onerror=alert(1)>';
  assert.ok(!ui.emptyState(unsafe, unsafe).includes(unsafe));
  assert.equal(ui.icon(unsafe), ui.icon('reports'));
  assert.equal(ui.icon('__proto__'), ui.icon('reports'));
  ui.app.state = sampleState();
  ui.app.state.reportItems[0].productName = unsafe;
  const html = ui.renderDashboard();
  assert.ok(!html.includes(unsafe));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});
