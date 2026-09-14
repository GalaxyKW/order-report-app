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
    renderShipments, renderInventory, renderRefunds, renderSettings, render, navigateView, shipmentEditor,
    rebateEditor, collectRebateForm, updateRebatePreview, reportItemEditorRow, collectReportForm,
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
  const modal = { innerHTML: '' };
  const window = { OrderDomain: Domain };
  const document = {
    addEventListener() {},
    querySelector(selector) {
      if (selector === '#main-content') return main;
      if (selector === '#modal-root') return modal;
      return null;
    },
    querySelectorAll(selector) { return selector === '.nav-item' ? navigation : []; },
  };
  const context = vm.createContext({ window, document });
  vm.runInContext(presentationSource, context, { filename: appPath });
  return {
    ...window.__ui, navigation, main, modal,
    intrinsicProperties() {
      return vm.runInContext('JSON.stringify([Object.getOwnPropertyNames(Object.prototype), Object.getOwnPropertyNames(Object), Object.getOwnPropertyNames(Object.prototype.toString)])', context);
    },
  };
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

for (const productName of ['普通商品', '__proto__', 'constructor', 'toString']) {
  test(`editing a shipment safely groups the product name ${productName}`, () => {
    const ui = createHarness();
    ui.app.state = sampleState();
    ui.app.state.shipments[0].closedAt = null;
    ui.app.state.reportItems[0].productName = productName;
    // A second allocation for the same product must still become one row.
    ui.app.state.shipmentItems.push({
      ...ui.app.state.shipmentItems[0], id: 'ui_extra_allocation', quantity: 1,
    });
    assert.equal(Domain.isStateSnapshot(ui.app.state), true);
    const stateBefore = JSON.stringify(ui.app.state);
    const intrinsicsBefore = ui.intrinsicProperties();
    ui.shipmentEditor('ui_shipment');
    const rows = ui.modal.innerHTML.match(/<tr class="shipment-item-editor">[\s\S]*?<\/tr>/g) || [];
    assert.equal(rows.length, 1, 'all existing allocations must remain visible');
    assert.ok(rows[0].includes(`<option value="${productName}" selected>`), 'the existing product must stay selected');
    assert.match(rows[0], /data-field="quantity"[^>]*value="3"/);
    assert.equal(ui.intrinsicProperties(), intrinsicsBefore, 'product names must not modify object or function prototypes');
    assert.equal(JSON.stringify(ui.app.state), stateBefore, 'opening the editor must not change business data');
  });
}

function rebateForm(entries = [{ id: 'ui_item', useExpected: true, value: '4.00' }]) {
  const rows = entries.map((entry) => {
    const controls = {
      '[data-field="useExpected"]': { checked: entry.useExpected },
      '[data-field="actualRebateCents"]': { value: entry.value, disabled: entry.useExpected, dataset: {} },
      '[data-rebate-preview]': { className: '', textContent: '' },
    };
    return { dataset: { itemId: entry.id }, controls, querySelector(selector) { return controls[selector] || null; } };
  });
  return {
    elements: { id: { value: 'ui_report' } }, rows,
    querySelectorAll(selector) { return selector === '.rebate-item-editor' ? rows : []; },
  };
}

function applyRebate(state, payload) {
  return Domain.applyOperation(state, {
    type: 'report.rebate.update', payload, opId: 'ui_rebate_op', clientId: 'ui_fixture',
  }, { now: '2026-09-14T10:00:00.000Z' }).state;
}

test('the rebate editor explains original-batch amounts and remains available after shipment closure', () => {
  const ui = createHarness();
  ui.app.state = sampleState();
  assert.ok(ui.app.state.shipments[0].closedAt);
  assert.match(ui.renderReports(), /data-action="edit-rebate" data-id="ui_report"/);
  const before = JSON.stringify(ui.app.state);
  ui.rebateEditor('ui_report');
  assert.match(ui.modal.innerHTML, /form data-form="rebate"/);
  assert.match(ui.modal.innerHTML, /data-field="useExpected" checked/);
  assert.match(ui.modal.innerHTML, /data-field="actualRebateCents"[^>]*value="4\.00"[^>]*disabled/);
  assert.match(ui.modal.innerHTML, /原数量 4 件/);
  assert.match(ui.modal.innerHTML, /已退款 1 件/);
  assert.match(ui.modal.innerHTML, /整批预计 ¥4\.00/);
  assert.match(ui.modal.innerHTML, /计入利润：¥3\.00/);
  assert.match(ui.modal.innerHTML, /原始整批商品的总返利/);
  assert.match(ui.modal.innerHTML, /出库或快递结单后仍可调整/);
  assert.equal(JSON.stringify(ui.app.state), before);
});

test('custom zero survives reopening and a default reset restores forecast-based profit', () => {
  const ui = createHarness();
  ui.app.state = sampleState();
  const originalProfit = Domain.stats(ui.app.state).profitCents;
  const custom = ui.collectRebateForm(rebateForm([{ id: 'ui_item', useExpected: false, value: '0.00' }]));
  assert.equal(custom.items[0].actualRebateCents, 0);
  ui.app.state = applyRebate(ui.app.state, custom);
  assert.equal(Domain.stats(ui.app.state).profitCents, originalProfit - 300);
  assert.equal(Domain.stats(ui.app.state).expectedRebateCents, 300);
  ui.rebateEditor('ui_report');
  assert.match(ui.modal.innerHTML, /data-field="actualRebateCents"[^>]*value="0\.00"/);
  assert.doesNotMatch(ui.modal.innerHTML, /data-field="useExpected" checked/);
  assert.match(ui.modal.innerHTML, /计入利润：¥0\.00/);
  const reset = ui.collectRebateForm(rebateForm([{ id: 'ui_item', useExpected: true, value: 'ignored disabled input' }]));
  assert.equal(reset.items[0].actualRebateCents, null);
  ui.app.state = applyRebate(ui.app.state, reset);
  assert.equal(Object.prototype.hasOwnProperty.call(ui.app.state.reportItems[0], 'actualRebateCents'), false);
  assert.equal(Domain.stats(ui.app.state).profitCents, originalProfit);
});

test('rebate form collects multiple items as integer cents without changing the original report form', () => {
  const ui = createHarness();
  const payload = ui.collectRebateForm(rebateForm([
    { id: 'ui_item', useExpected: false, value: '1.23' },
    { id: 'ui_second_item', useExpected: true, value: '' },
  ]));
  assert.equal(JSON.stringify(payload), JSON.stringify({
    id: 'ui_report', items: [{ id: 'ui_item', actualRebateCents: 123 }, { id: 'ui_second_item', actualRebateCents: null }],
  }));
  const item = sampleState().reportItems[0];
  assert.doesNotMatch(ui.reportItemEditorRow({ ...item, actualRebateCents: 0 }), /data-field="actualRebateCents"/);
  const fields = { productName: '测试商品', note: '', quantity: '4', actualPaymentCents: '40.00', expectedRefundCents: '48.00', expectedRebateCents: '4.00' };
  const row = {
    dataset: { itemId: 'ui_item' },
    querySelector(selector) { return { value: fields[selector.match(/data-field="([^\"]+)"/)[1]] }; },
  };
  const reportForm = {
    elements: { id: { value: 'ui_report' }, occurredAt: { value: '2026-09-01T09:00' }, originalMessage: { value: '' } },
    querySelectorAll() { return [row]; },
  };
  assert.equal(Object.prototype.hasOwnProperty.call(ui.collectReportForm(reportForm).items[0], 'actualRebateCents'), false);
});

test('invalid custom rebate input is rejected without treating an empty amount as zero', () => {
  const ui = createHarness();
  ui.app.state = sampleState();
  const before = JSON.stringify(ui.app.state);
  for (const value of ['', ' ', '-1', '1.001', 'NaN', '1e2', '90071992547409.92']) {
    assert.throws(() => ui.collectRebateForm(rebateForm([{ id: 'ui_item', useExpected: false, value }])), /实际返利/);
  }
  assert.equal(JSON.stringify(ui.app.state), before);
});

test('rebate previews honor refunds, preserve custom drafts across toggles and show invalid amounts', () => {
  const ui = createHarness();
  ui.app.state = sampleState();
  const form = rebateForm([{ id: 'ui_item', useExpected: false, value: '2.00' }]);
  const controls = form.rows[0].controls;
  const input = controls['[data-field="actualRebateCents"]'];
  const checkbox = controls['[data-field="useExpected"]'];
  const preview = controls['[data-rebate-preview]'];
  ui.updateRebatePreview(form);
  assert.match(preview.textContent, /计入利润：¥1\.50/);
  checkbox.checked = true;
  ui.updateRebatePreview(form);
  assert.equal(input.disabled, true);
  assert.equal(input.value, '4.00');
  assert.match(preview.textContent, /计入利润：¥3\.00/);
  checkbox.checked = false;
  ui.updateRebatePreview(form);
  assert.equal(input.disabled, false);
  assert.equal(input.value, '2.00');
  input.value = '0';
  ui.updateRebatePreview(form);
  assert.match(preview.textContent, /计入利润：¥0\.00/);
  input.value = '-2';
  ui.updateRebatePreview(form);
  assert.equal(preview.className, 'rebate-preview rebate-preview-error');
  assert.match(preview.textContent, /实际返利/);
});

test('actual rebate changes update existing statistics and keep forecasts visible', () => {
  const ui = createHarness();
  ui.app.state = applyRebate(sampleState(), { id: 'ui_report', items: [{ id: 'ui_item', actualRebateCents: 200 }] });
  const dashboard = ui.renderDashboard();
  assert.equal((dashboard.match(/<article class="stat-card /g) || []).length, 7);
  assert.match(dashboard, /实际返利 ¥1\.50/);
  assert.match(dashboard, /<span class="phrase">\+ 实际返利<\/span>/);
  assert.doesNotMatch(dashboard, /<span class="phrase">\+ 预计返利<\/span>/);
  const report = ui.renderReports();
  assert.match(report, /<th>返利（整批）<\/th>/);
  assert.match(report, /预计 <span class="money">¥4\.00<\/span>/);
  assert.match(report, /实际 <span class="money">¥2\.00<\/span>/);
  const shipment = ui.renderShipments();
  assert.match(shipment, /<th>返利<\/th>/);
  assert.match(shipment, /实际 <span class="money">¥1\.00<\/span>/);
  assert.match(ui.renderInventory(), /剩余实际返利 <span class="money">¥0\.50<\/span>/);
});

test('unsupported rebate operations explain server upgrade and fresh-id retry without changing local data', () => {
  const ui = createHarness();
  ui.app.state = applyRebate(sampleState(), { id: 'ui_report', items: [{ id: 'ui_item', actualRebateCents: 0 }] });
  ui.app.queue = [{
    opId: 'rebate_rejected', type: 'report.rebate.update', createdAt: '2026-09-14T10:00:00.000Z',
    payload: { id: 'ui_report', items: [{ id: 'ui_item', actualRebateCents: 0 }] },
    syncError: '不支持的操作类型: report.rebate.update',
  }];
  const before = JSON.stringify({ state: ui.app.state, queue: ui.app.queue });
  const settings = ui.renderSettings();
  assert.match(settings, /服务器版本尚不支持实际返利/);
  assert.match(settings, /请先升级服务器/);
  assert.match(settings, /换新编号重试/);
  assert.match(settings, /不要通过下载覆盖/);
  assert.match(settings, /调整实际返利/);
  assert.equal(JSON.stringify({ state: ui.app.state, queue: ui.app.queue }), before);
});
