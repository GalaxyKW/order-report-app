const test = require('node:test');
const assert = require('node:assert/strict');
const Domain = require('../shared/domain');

const now = '2026-09-14T01:00:00.000Z';
let sequence = 0;
function apply(state, type, payload) {
  return Domain.applyOperation(state, { type, payload }, {
    now, idFactory: (prefix) => `${prefix}_${++sequence}`,
  }).state;
}
function payload(rebate = 100, quantity = 3) {
  return {
    report: { id: 'report', occurredAt: '2026-09-01', originalMessage: '虚构测试数据' },
    items: [{ id: 'item', productName: '测试商品', quantity, actualPaymentCents: 1000, expectedRefundCents: 1200, expectedRebateCents: rebate }],
  };
}
function initial(rebate = 100, quantity = 3) {
  return apply(Domain.emptyState(), 'report.create', payload(rebate, quantity));
}
function adjust(state, amount) {
  return apply(state, 'report.rebate.update', { id: 'report', items: [{ id: 'item', actualRebateCents: amount }] });
}
function ship(state, id, quantity) {
  return apply(state, 'shipment.create', {
    shipment: { id, shippedAt: '2026-09-02', trackingNumber: `TEST-${id}`, shippingCostCents: 0 },
    items: [{ productName: '测试商品', quantity }],
  });
}

test('legacy snapshots dynamically default actual rebate to the full forecast without mutation', () => {
  const state = initial();
  const before = JSON.stringify(state);
  assert.equal(Domain.isStateSnapshot(state), true);
  assert.equal(Domain.actualRebateForItem(state.reportItems[0]), 100);
  assert.equal(Domain.stats(state).actualRebateCents, 100);
  assert.equal(Domain.stats(state).profitCents, 300);
  assert.equal(JSON.stringify(state), before);
  assert.equal(Object.hasOwn(Domain.normalizeState(state).reportItems[0], 'actualRebateCents'), false);
  const edited = apply(state, 'report.update', payload(200));
  assert.equal(Domain.actualRebateForItem(edited.reportItems[0]), 200);
});

test('zero and above-forecast actual rebates change profit but never the forecast or cash settlements', () => {
  for (const amount of [0, 40, 100, 180]) {
    const state = adjust(initial(), amount);
    const summary = Domain.stats(state);
    assert.equal(summary.actualRebateCents, amount);
    assert.equal(summary.expectedRebateCents, 100);
    assert.equal(summary.expectedIncomeCents, 1300);
    assert.equal(summary.returnedCents, 0);
    assert.equal(summary.outstandingCents, 1200);
    assert.equal(summary.profitCents, 200 + amount);
    assert.equal(summary.pureProfitCents, 200 + amount);
    assert.equal(Domain.isStateSnapshot(state), true);
  }
});

test('old report edits preserve a custom zero; reset restores following future forecast edits', () => {
  let state = adjust(initial(), 0);
  state = apply(state, 'report.update', payload(170));
  assert.equal(state.reportItems[0].actualRebateCents, 0);
  state = adjust(state, null);
  assert.equal(Object.hasOwn(state.reportItems[0], 'actualRebateCents'), false);
  assert.equal(Domain.stats(state).actualRebateCents, 170);
  state = apply(state, 'report.update', payload(210));
  assert.equal(Domain.stats(state).actualRebateCents, 210);
});

test('actual rebate can be corrected after shipment closure without reopening or altering locked amounts', () => {
  let state = ship(initial(), 'shipment', 3);
  state = apply(state, 'settlement.create', { settlement: { id: 'payment', shipmentId: 'shipment', amountCents: 1180, settledAt: '2026-09-03' } });
  state = apply(state, 'shipment.close', { id: 'shipment' });
  const closedAt = state.shipments[0].closedAt;
  const settlements = JSON.stringify(state.settlements);
  const allocations = JSON.stringify(state.shipmentItems);
  state = adjust(state, 0);
  const view = Domain.shipmentView(state, state.shipments[0]);
  assert.equal(view.closedAt, closedAt);
  assert.equal(view.actualRebateCents, 0);
  assert.equal(view.expectedRebateCents, 100);
  assert.equal(view.actualPaymentCents, 1000);
  assert.equal(view.returnedCents, 1180);
  assert.equal(Domain.stats(state).profitCents, 180);
  assert.equal(JSON.stringify(state.settlements), settlements);
  assert.equal(JSON.stringify(state.shipmentItems), allocations);
  assert.throws(() => apply(state, 'report.update', payload(150)), /不能修改/);
});

test('partial refunds, multiple shipments and inventory conserve every cent of actual rebate', () => {
  for (const amount of [0, 1, 2, 5, 100, 101, 10000]) {
    for (let refunded = 0; refunded <= 5; refunded += 1) {
      for (let first = 0; first <= 5 - refunded; first += 1) {
        let state = adjust(initial(37, 5), amount);
        if (first) state = ship(state, 'first', first);
        const second = Math.max(5 - refunded - first - 1, 0);
        if (second) state = ship(state, 'second', second);
        if (refunded) state = apply(state, 'refund.create', {
          refund: { id: 'refund', reportItemId: 'item', quantity: refunded, refundedAt: '2026-09-04' },
        });
        const shippedRebate = state.shipments.reduce((sum, shipment) => sum + Domain.shipmentView(state, shipment).actualRebateCents, 0);
        const stockedRebate = Domain.inventoryLots(state).reduce((sum, lot) => sum + lot.availableActualRebateCents, 0);
        const refundedRebate = Domain.amountForQuantity(amount, 5, refunded);
        assert.equal(shippedRebate + stockedRebate + refundedRebate, amount);
        assert.equal(Domain.stats(state).actualRebateCents, amount - refundedRebate);
        assert.equal(Domain.isStateSnapshot(state), true);
      }
    }
  }
});

test('full refunds remove actual rebate and undoing a refund restores its proportional share', () => {
  let state = adjust(initial(), 7);
  state = apply(state, 'refund.create', { refund: { id: 'refund', reportItemId: 'item', quantity: 3, refundedAt: '2026-09-04' } });
  assert.equal(Domain.stats(state).actualRebateCents, 0);
  state = apply(state, 'refund.void', { id: 'refund' });
  assert.equal(Domain.stats(state).actualRebateCents, 7);
});

for (const amount of [-1, 0.1, '0', '', undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, {}]) {
  test(`invalid actual rebate is rejected atomically (${String(amount)})`, () => {
    const state = initial();
    const before = JSON.stringify(state);
    assert.throws(() => adjust(state, amount), /实际返利/);
    assert.equal(JSON.stringify(state), before);
  });
}

test('rebate operation validates report ownership, duplicates, missing fields and active status', () => {
  const state = initial();
  for (const items of [[], [{ id: 'item' }], [{ id: 'unknown', actualRebateCents: 0 }], [{ id: 'item', actualRebateCents: 0 }, { id: 'item', actualRebateCents: 50 }]]) {
    assert.throws(() => apply(state, 'report.rebate.update', { id: 'report', items }));
  }
  assert.throws(() => apply(state, 'report.rebate.update', { id: 'unknown', items: [{ id: 'item', actualRebateCents: 0 }] }));
  const voided = apply(state, 'report.void', { id: 'report' });
  assert.throws(() => adjust(voided, 0), /作废/);
});

test('malformed actual rebate snapshots are not normalized into apparently valid data', () => {
  for (const amount of [-1, 0.5, '10', true, Number.MAX_SAFE_INTEGER + 1]) {
    const state = initial();
    state.reportItems[0].actualRebateCents = amount;
    assert.equal(Domain.isStateSnapshot(state), false);
    assert.equal(Domain.isStateSnapshot(Domain.normalizeState(state)), false);
  }
});

test('ordinary report endpoints reject misplaced actual fields instead of silently accepting them', () => {
  const data = payload();
  data.items[0].actualRebateCents = 0;
  assert.throws(() => apply(Domain.emptyState(), 'report.create', data), /单独保存/);
  assert.throws(() => apply(initial(), 'report.update', data), /单独保存/);
});
