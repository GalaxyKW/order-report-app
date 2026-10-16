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
    rebateEditor, shipmentRebateEditor, collectRebateForm, updateRebatePreview, reportEditor, reportItemEditorRow, collectReportForm,
    editableMoneyValue, parseMoneyInput, quantityInput, stepQuantity, productNameInput, historicalProductNames,
    collectShipmentForm, settlementEditor, refundEditor, inventoryRenameEditor, collectInventoryRenameForm,
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
  class Event {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  }
  const context = vm.createContext({ window, document, Event });
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

function shipmentRebateState({ multipleReports = false, duplicateSource = false } = {}) {
  let state = Domain.emptyState();
  let serial = 0;
  const apply = (type, payload) => {
    state = Domain.applyOperation(state, {
      type, payload, opId: `shipment-rebate-op-${++serial}`, clientId: 'ui-fixture',
    }, { now: '2026-10-14T10:00:00.000Z', idFactory: (prefix) => `${prefix}-rebate-${++serial}` }).state;
  };
  apply('report.create', {
    report: { id: 'rebate-source-a', occurredAt: '2026-10-01T09:00', originalMessage: '虚构报单甲' },
    items: [
      { id: 'rebate-item-a', productName: '示例笔记本', quantity: 3, actualPaymentCents: 3000, expectedRefundCents: 3600, expectedRebateCents: 600 },
      { id: 'rebate-unrelated', productName: '未随此快递发出的虚构商品', quantity: 1, actualPaymentCents: 500, expectedRefundCents: 500, expectedRebateCents: 100 },
    ],
  });
  if (multipleReports) apply('report.create', {
    report: { id: 'rebate-source-b', occurredAt: '2026-10-02T09:00', originalMessage: '虚构报单乙' },
    items: [{ id: 'rebate-item-b', productName: '示例笔记本', quantity: 2, actualPaymentCents: 2000, expectedRefundCents: 2400, expectedRebateCents: 400 }],
  });
  apply('shipment.create', {
    shipment: { id: 'rebate-closed-shipment', trackingNumber: 'DEMO-CLOSED-ONLY', shippingCostCents: 0, shippedAt: '2026-10-03' },
    items: [{ productName: '示例笔记本', quantity: multipleReports ? 4 : 2 }],
  });
  if (duplicateSource) {
    const allocation = state.shipmentItems[0];
    allocation.quantity -= 1;
    state.shipmentItems.push({ ...allocation, id: 'rebate-duplicate-source', quantity: 1 });
  }
  apply('settlement.create', { settlement: { id: 'rebate-settlement', shipmentId: 'rebate-closed-shipment', amountCents: multipleReports ? 4800 : 2400, settledAt: '2026-10-04' } });
  apply('shipment.close', { id: 'rebate-closed-shipment' });
  assert.equal(Domain.isStateSnapshot(state), true);
  return state;
}

test('closed shipments expose rebate adjustment without unlocking fulfillment or settlement editing', () => {
  const ui = createHarness();
  ui.app.state = shipmentRebateState();
  const before = JSON.stringify(ui.app.state);
  const closed = ui.renderShipments();
  assert.match(closed, /data-action="edit-shipment-rebate" data-id="rebate-closed-shipment"/);
  assert.match(closed, /data-action="reopen-shipment"/);
  for (const action of ['edit-shipment', 'void-shipment', 'add-settlement', 'edit-settlement', 'void-settlement']) {
    assert.ok(!closed.includes(`data-action="${action}"`), `closed shipment must not expose ${action}`);
  }
  assert.equal(JSON.stringify(ui.app.state), before, 'rendering the new action must not mutate the closed shipment');
  ui.app.state.shipments[0].closedAt = null;
  const open = ui.renderShipments();
  assert.match(open, /data-action="edit-shipment-rebate" data-id="rebate-closed-shipment"/);
  assert.match(open, /data-action="edit-shipment"/);
  assert.match(open, /data-action="add-settlement"/);
});

test('a single-source shipment opens only its source items and explains original-batch scope', () => {
  const ui = createHarness();
  ui.app.state = shipmentRebateState();
  const before = JSON.stringify(ui.app.state);
  ui.shipmentRebateEditor('rebate-closed-shipment');
  const html = ui.modal.innerHTML;
  assert.match(html, /form data-form="rebate"/);
  assert.match(html, /name="id" value="rebate-source-a"/);
  assert.match(html, /data-item-id="rebate-item-a"/);
  assert.equal((html.match(/class="rebate-item-editor"/g) || []).length, 1);
  assert.ok(!html.includes('rebate-unrelated'), 'unshipped items from the same report must not be editable here');
  assert.ok(!html.includes('未随此快递发出的虚构商品'));
  assert.match(html, /DEMO-CLOSED-ONLY/);
  assert.match(html, /原数量 3 件/);
  assert.match(html, /value="6\.00"/);
  assert.match(html, /同[一批]/);
  assert.match(html, /结单/);
  assert.equal(JSON.stringify(ui.app.state), before, 'opening the editor must not modify settlements or closure');
});

test('repeated allocations from one source item produce one rebate editor row', () => {
  const ui = createHarness();
  ui.app.state = shipmentRebateState({ duplicateSource: true });
  assert.equal(ui.app.state.shipmentItems.length, 2);
  ui.shipmentRebateEditor('rebate-closed-shipment');
  assert.equal((ui.modal.innerHTML.match(/class="rebate-item-editor"/g) || []).length, 1);
  assert.equal((ui.modal.innerHTML.match(/data-item-id="rebate-item-a"/g) || []).length, 1);
  assert.ok(!ui.modal.innerHTML.includes('rebate-unrelated'));
});

test('a multi-report shipment requires a source choice and edits each original batch separately', () => {
  const ui = createHarness();
  ui.app.state = shipmentRebateState({ multipleReports: true });
  const before = JSON.stringify(ui.app.state);
  ui.shipmentRebateEditor('rebate-closed-shipment');
  const picker = ui.modal.innerHTML;
  assert.match(picker, /shipment-rebate-picker/);
  assert.doesNotMatch(picker, /form data-form="rebate"/);
  const buttons = picker.match(/<button\b[^>]*data-action="choose-shipment-rebate"[^>]*>/g) || [];
  assert.equal(buttons.length, 2);
  for (const source of ['a', 'b']) {
    const button = buttons.find((row) => row.includes(`data-id="rebate-source-${source}"`));
    assert.ok(button, `source ${source} must be selectable`);
    assert.ok(button.includes('data-shipment-id="rebate-closed-shipment"'));
    ui.shipmentRebateEditor('rebate-closed-shipment', `rebate-source-${source}`);
    assert.match(ui.modal.innerHTML, /form data-form="rebate"/);
    assert.ok(ui.modal.innerHTML.includes(`name="id" value="rebate-source-${source}"`));
    assert.ok(ui.modal.innerHTML.includes(`data-item-id="rebate-item-${source}"`));
    assert.equal((ui.modal.innerHTML.match(/class="rebate-item-editor"/g) || []).length, 1);
    assert.ok(!ui.modal.innerHTML.includes('rebate-unrelated'));
  }
  assert.equal(JSON.stringify(ui.app.state), before);
});

test('shipment rebate context keeps source labels and tracking numbers escaped', () => {
  const ui = createHarness();
  ui.app.state = shipmentRebateState({ multipleReports: true });
  const unsafe = '<img src=x onerror=alert(1)>';
  ui.app.state.reportItems.forEach((item) => { item.productName = unsafe; });
  ui.app.state.shipments[0].trackingNumber = unsafe;
  ui.shipmentRebateEditor('rebate-closed-shipment');
  assert.ok(!ui.modal.innerHTML.includes(unsafe));
  assert.ok(ui.modal.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
  ui.shipmentRebateEditor('rebate-closed-shipment', 'rebate-source-a');
  assert.ok(!ui.modal.innerHTML.includes(unsafe));
  assert.ok(ui.modal.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('the ordinary report editor points closed orders to the separate actual-rebate operation', () => {
  const ui = createHarness();
  ui.app.state = shipmentRebateState();
  const before = JSON.stringify(ui.app.state);
  ui.reportEditor('rebate-source-a');
  assert.match(ui.modal.innerHTML, /预计返利保留原始预估/);
  assert.match(ui.modal.innerHTML, /报单或快递列表点击「调整返利」/);
  assert.match(ui.modal.innerHTML, /已结单也可修改，无需撤销结单/);
  assert.doesNotMatch(ui.modal.innerHTML, /data-field="actualRebateCents"/);
  assert.match(ui.modal.innerHTML, /data-field="expectedRebateCents"/);
  assert.equal(JSON.stringify(ui.app.state), before);
});

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
  assert.match(ui.modal.innerHTML, /data-field="actualRebateCents"[^>]*value=""/);
  assert.match(ui.modal.innerHTML, /data-field="actualRebateCents"[^>]*placeholder="0\.00"/);
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

test('blank custom rebates mean zero while malformed or negative amounts remain rejected', () => {
  const ui = createHarness();
  ui.app.state = sampleState();
  const before = JSON.stringify(ui.app.state);
  for (const value of ['', ' ', '\t\n']) {
    assert.equal(ui.collectRebateForm(rebateForm([{ id: 'ui_item', useExpected: false, value }])).items[0].actualRebateCents, 0);
  }
  for (const value of ['-1', '1.001', 'NaN', '1e2', '90071992547409.92']) {
    assert.throws(() => ui.collectRebateForm(rebateForm([{ id: 'ui_item', useExpected: false, value }])), /实际返利/);
  }
  assert.equal(JSON.stringify(ui.app.state), before);
});

test('editable money shows a zero placeholder without hiding existing nonzero amounts', () => {
  const ui = createHarness();
  assert.equal(ui.editableMoneyValue(0), '');
  assert.equal(ui.editableMoneyValue(123), '1.23');
  for (const value of ['', ' ', '\t\n', '0', '0.00']) assert.equal(ui.parseMoneyInput(value, '测试金额'), 0);
  assert.equal(ui.parseMoneyInput(' 1.23 ', '测试金额'), 123);
  ui.reportEditor();
  const reportMoney = [...ui.modal.innerHTML.matchAll(/<input\b[^>]*data-field="(?:actualPaymentCents|expectedRefundCents|expectedRebateCents)"[^>]*>/g)].map((match) => match[0]);
  assert.equal(reportMoney.length, 3);
  for (const input of reportMoney) {
    assert.match(input, /value=""/);
    assert.match(input, /placeholder="0\.00"/);
    assert.doesNotMatch(input, /\brequired\b/);
  }
  ui.app.state = sampleState();
  ui.shipmentEditor();
  assert.match(ui.modal.innerHTML, /name="shippingCost"(?=[^>]*value="")(?=[^>]*placeholder="0\.00")/);
  ui.app.state.shipments[0].closedAt = null;
  ui.settlementEditor('ui_shipment');
  assert.match(ui.modal.innerHTML, /name="amount"(?=[^>]*value="")(?=[^>]*placeholder="0\.00")/);
  ui.refundEditor('', 'ui_item');
  assert.match(ui.modal.innerHTML, /name="amount"[^>]*readonly/);
  assert.doesNotMatch(ui.modal.innerHTML, /name="amount"[^>]*placeholder="0\.00"/);
});

test('blank report and shipment amounts collect as exact integer zero cents', () => {
  const ui = createHarness();
  const fields = { productName: '测试商品', note: '', quantity: '1', actualPaymentCents: '', expectedRefundCents: ' ', expectedRebateCents: '' };
  const row = {
    dataset: { itemId: 'blank-item' },
    querySelector(selector) { return { value: fields[selector.match(/data-field="([^\"]+)"/)[1]] }; },
  };
  const form = {
    elements: {
      id: { value: 'blank-record' }, occurredAt: { value: '2026-10-16T10:00' }, originalMessage: { value: '' },
      trackingNumber: { value: 'DEMO-BLANK' }, shippingCost: { value: ' ' }, shippedAt: { value: '2026-10-16' }, note: { value: '' },
    },
    querySelectorAll() { return [row]; },
  };
  const item = ui.collectReportForm(form).items[0];
  for (const key of ['actualPaymentCents', 'expectedRefundCents', 'expectedRebateCents']) assert.equal(item[key], 0);
  assert.equal(ui.collectShipmentForm(form).shipment.shippingCostCents, 0);
});

test('all editable quantity inputs include named non-submit increment and decrement buttons', () => {
  const ui = createHarness();
  ui.app.state = sampleState();
  for (const render of [() => ui.reportEditor(), () => ui.shipmentEditor(), () => ui.refundEditor('', 'ui_item')]) {
    render();
    const html = ui.modal.innerHTML;
    const quantities = html.match(/<input\b[^>]*type="number"[^>]*>/g) || [];
    const buttons = html.match(/<button\b[^>]*data-action="step-quantity"[^>]*>/g) || [];
    assert.ok(quantities.length > 0);
    assert.equal(buttons.length, quantities.length * 2);
    for (const input of quantities) {
      assert.match(input, /min="1"/);
      assert.match(input, /step="1"/);
    }
    for (const button of buttons) {
      assert.match(button, /type="button"/);
      assert.match(button, /aria-label="[^\"]+"/);
    }
    assert.equal(buttons.filter((button) => button.includes('data-step="1"')).length, quantities.length);
    assert.equal(buttons.filter((button) => button.includes('data-step="-1"')).length, quantities.length);
  }
});

test('quantity stepping respects safe bounds and emits the events used by financial previews', () => {
  const ui = createHarness();
  const events = [];
  const input = { value: '2', min: '1', max: '3', disabled: false, readOnly: false, dispatchEvent(event) { events.push([event.type, event.bubbles]); } };
  const group = { querySelector(selector) { return selector === 'input' ? input : null; } };
  const button = { dataset: { step: '1' }, closest() { return group; } };
  ui.stepQuantity(button);
  assert.equal(input.value, '3');
  assert.deepEqual(events, [['input', true], ['change', true]]);
  ui.stepQuantity(button);
  assert.equal(input.value, '3');
  for (const value of ['', ' ', 'not-a-number', '1.5', '9007199254740992']) {
    input.value = value;
    ui.stepQuantity(button);
    assert.equal(input.value, '1', `invalid quantity ${JSON.stringify(value)} must recover to its minimum`);
  }
  input.max = String(Number.MAX_SAFE_INTEGER);
  input.value = input.max;
  ui.stepQuantity(button);
  assert.equal(input.value, String(Number.MAX_SAFE_INTEGER));
  input.value = '1';
  button.dataset.step = '-1';
  ui.stepQuantity(button);
  assert.equal(input.value, '1');
  input.max = '0';
  events.length = 0;
  input.value = '2';
  ui.stepQuantity(button);
  assert.equal(input.value, '1', 'a decrement must still correct overbooked duplicate shipment rows');
  assert.deepEqual(events, [['input', true], ['change', true]]);
  events.length = 0;
  button.dataset.step = '1';
  ui.stepQuantity(button);
  assert.equal(input.value, '1', 'increment must not manufacture available stock');
  assert.deepEqual(events, []);
  input.max = '3';
  for (const property of ['disabled', 'readOnly']) {
    input[property] = true;
    input.value = '2';
    ui.stepQuantity(button);
    assert.equal(input.value, '2');
    assert.deepEqual(events, []);
    input[property] = false;
  }
  button.dataset.step = '999';
  ui.stepQuantity(button);
  assert.equal(input.value, '2');
  assert.deepEqual(events, []);
});

function historyState() {
  let state = sampleState();
  let serial = 0;
  for (const productName of ['USB 收纳盒', 'USB 收纳盒', 'USB 文件袋', '__proto__', 'constructor', '<img src=x onerror=alert(1)>', 'toString', '已作废的历史商品']) {
    const id = `history-${++serial}`;
    state = Domain.applyOperation(state, {
      type: 'report.create', opId: `history-op-${serial}`, clientId: 'history-test',
      payload: { report: { id, occurredAt: '2026-10-16' }, items: [{ id: `${id}-item`, productName, quantity: 1, actualPaymentCents: 0, expectedRefundCents: 0, expectedRebateCents: 0 }] },
    }, { now: '2026-10-16T10:00:00.000Z' }).state;
  }
  state = Domain.applyOperation(state, { type: 'report.void', opId: 'history-void', clientId: 'history-test', payload: { id: 'history-8' } }, { now: '2026-10-16T10:00:00.000Z' }).state;
  return state;
}

test('product history is deduplicated, case-insensitive and excludes void reports without mutating state', () => {
  const ui = createHarness();
  ui.app.state = historyState();
  const before = JSON.stringify(ui.app.state);
  assert.deepEqual([...ui.historicalProductNames('usb')].sort(), ['USB 收纳盒', 'USB 文件袋']);
  assert.deepEqual([...ui.historicalProductNames('usb 收纳')], ['USB 收纳盒']);
  assert.deepEqual([...ui.historicalProductNames('已作废')], []);
  assert.deepEqual([...ui.historicalProductNames('不存在的名称')], []);
  for (const name of ['__proto__', 'constructor', 'toString']) assert.deepEqual([...ui.historicalProductNames(name)], [name]);
  assert.ok(ui.historicalProductNames('').length <= 8);
  assert.equal(new Set(ui.historicalProductNames('')).size, ui.historicalProductNames('').length);
  assert.equal(JSON.stringify(ui.app.state), before);
});

test('product inputs provide an escaped and accessible local-history combobox', () => {
  const ui = createHarness();
  ui.app.state = historyState();
  const unsafe = '<img src=x onerror=alert(1)>"';
  const html = ui.productNameInput(unsafe);
  assert.ok(!html.includes(unsafe));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;/);
  assert.match(html, /data-product-history/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /class="product-suggestions"[^>]*hidden/);
});

test('inventory groups same names while rename captures only in-stock source ids and escapes special names', () => {
  const ui = createHarness();
  ui.app.state = historyState();
  ui.app.state = Domain.applyOperation(ui.app.state, {
    type: 'shipment.create', opId: 'history-sold-out', clientId: 'history-test',
    payload: { shipment: { id: 'history-shipment', trackingNumber: 'DEMO-HISTORY-ONLY', shippingCostCents: 0, shippedAt: '2026-10-16' }, items: [{ productName: 'USB 收纳盒', quantity: 1 }] },
  }, { now: '2026-10-16T10:00:00.000Z', idFactory: (prefix) => `history-sold-out-${prefix}` }).state;
  const before = JSON.stringify(ui.app.state);
  const inventory = ui.renderInventory();
  assert.equal((inventory.match(/class="panel inventory-group" data-product-name="USB 收纳盒"/g) || []).length, 1);
  ui.inventoryRenameEditor('USB 收纳盒');
  assert.match(ui.modal.innerHTML, /form data-form="inventory-rename"/);
  const encodedIds = ui.modal.innerHTML.match(/name="reportItemIds" value="([^\"]+)"/)[1];
  const ids = JSON.parse(encodedIds.replace(/&quot;/g, '"'));
  assert.deepEqual(ids, ['history-2-item'], 'sold-out source batches must not be silently included in rename scope');
  const form = { elements: { productName: { value: 'USB 收纳盒' }, newName: { value: '  USB 文件袋  ' }, reportItemIds: { value: JSON.stringify(ids) } } };
  assert.deepEqual(JSON.parse(JSON.stringify(ui.collectInventoryRenameForm(form))), { productName: 'USB 收纳盒', newName: 'USB 文件袋', reportItemIds: ['history-2-item'] });
  for (const productName of ['__proto__', 'constructor', '<img src=x onerror=alert(1)>']) {
    ui.inventoryRenameEditor(productName);
    assert.match(ui.modal.innerHTML, /form data-form="inventory-rename"/);
    assert.doesNotMatch(ui.modal.innerHTML, /<img src=x/);
  }
  assert.equal(JSON.stringify(ui.app.state), before, 'rendering and preparing a rename must not mutate data');
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

test('unsupported inventory renames explain server upgrade while preserving the local rename operation', () => {
  const ui = createHarness();
  ui.app.state = historyState();
  ui.app.queue = [{
    opId: 'rename_rejected', type: 'inventory.rename', createdAt: '2026-10-16T10:00:00.000Z',
    payload: { productName: 'USB 收纳盒', newName: 'USB 文件袋', reportItemIds: ['history-1-item', 'history-2-item'] },
    syncError: '不支持的操作类型: inventory.rename',
  }];
  const before = JSON.stringify({ state: ui.app.state, queue: ui.app.queue });
  const settings = ui.renderSettings();
  assert.match(settings, /服务器版本尚不支持/);
  assert.match(settings, /升级(?:并重启)?服务器/);
  assert.match(settings, /换新编号重试/);
  assert.match(settings, /不要通过下载覆盖/);
  assert.match(settings, /仓库商品改名/);
  assert.equal(JSON.stringify({ state: ui.app.state, queue: ui.app.queue }), before);
});
