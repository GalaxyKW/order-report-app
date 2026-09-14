const Domain = require('../shared/domain');

// Entirely invented showcase data. Never import a database, an export, an env
// file, or user settings here: this fixture is safe to publish with the images.
function createDemoStorage() {
  let state = Domain.emptyState();
  let sequence = 0;
  const apply = (type, payload, now) => {
    state = Domain.applyOperation(state, { type, payload }, {
      now, idFactory: (prefix) => `demo-${prefix}-${++sequence}`,
    }).state;
  };
  const reports = [
    { id: 3, date: '2026-09-01T02:00:00.000Z', productName: '方格便签本', note: '奶油白 · 方格内页', quantity: 10, actualPaymentCents: 8000, expectedRefundCents: 10000, expectedRebateCents: 1000 },
    { id: 2, date: '2026-09-02T03:30:00.000Z', productName: '桌面收纳盒', note: '浅蓝色 · 三格款', quantity: 6, actualPaymentCents: 18000, expectedRefundCents: 19800, expectedRebateCents: 1800 },
    { id: 1, date: '2026-09-03T01:20:00.000Z', productName: '便携保温杯', note: '雾白色 · 500ml', quantity: 4, actualPaymentCents: 16000, expectedRefundCents: 17600, expectedRebateCents: 1200 },
  ];
  for (const row of reports) {
    const { id, date, ...item } = row;
    apply('report.create', {
      report: { id: `demo-report-${id}`, occurredAt: date, originalMessage: '演示录入 · 虚构商品与金额' },
      items: [{ id: `demo-item-${id}`, ...item }],
    }, date);
  }
  for (const [id, amount] of [[1, 900], [3, 800]]) {
    apply('report.rebate.update', {
      id: `demo-report-${id}`, items: [{ id: `demo-item-${id}`, actualRebateCents: amount }],
    }, '2026-09-03T04:00:00.000Z');
  }
  apply('shipment.create', {
    shipment: { id: 'demo-shipment-1', trackingNumber: 'DEMO-001', shippingCostCents: 600, shippedAt: '2026-09-04T02:00:00.000Z', note: '演示包裹 · 已完成返款' },
    items: [{ productName: '便携保温杯', quantity: 2 }],
  }, '2026-09-04T02:00:00.000Z');
  apply('settlement.create', {
    settlement: { id: 'demo-settlement-1', shipmentId: 'demo-shipment-1', amountCents: 8600, settledAt: '2026-09-04T08:00:00.000Z', note: '演示返款' },
  }, '2026-09-04T08:00:00.000Z');
  apply('shipment.close', { id: 'demo-shipment-1' }, '2026-09-04T08:01:00.000Z');
  apply('shipment.create', {
    shipment: { id: 'demo-shipment-2', trackingNumber: 'DEMO-002', shippingCostCents: 800, shippedAt: '2026-09-05T02:30:00.000Z', note: '演示包裹 · 分批返款' },
    items: [{ productName: '桌面收纳盒', quantity: 2 }],
  }, '2026-09-05T02:30:00.000Z');
  apply('settlement.create', {
    settlement: { id: 'demo-settlement-2', shipmentId: 'demo-shipment-2', amountCents: 6000, settledAt: '2026-09-05T07:00:00.000Z', note: '演示首笔返款' },
  }, '2026-09-05T07:00:00.000Z');
  apply('refund.create', {
    refund: { id: 'demo-refund-1', reportItemId: 'demo-item-1', quantity: 1, refundedAt: '2026-09-06T02:00:00.000Z', note: '演示退款 · 一件未发货商品' },
  }, '2026-09-06T02:00:00.000Z');
  return {
    state,
    queue: [],
    settings: { apiBase: '', token: '' },
    clientId: 'demo-readme-client',
    localRevision: 0,
    storageRevision: 0,
    hasSynced: false,
  };
}

module.exports = { createDemoStorage };
