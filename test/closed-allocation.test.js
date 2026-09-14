const test = require('node:test');
const assert = require('node:assert/strict');
const Domain = require('../shared/domain');

const financialFields = ['actualPaymentCents', 'expectedRefundCents', 'expectedRebateCents', 'actualRebateCents'];
const zeroAmounts = Object.fromEntries(financialFields.map((field) => [field, 0]));
const guardMessage = /改变已结单快递的金额分摊.*先撤销相关快递结单/;

function scenario(items = [{ id: 'lot', productName: '测试商品', quantity: 3, ...zeroAmounts, actualPaymentCents: 100, expectedRefundCents: 100 }]) {
  let counter = 0;
  const apply = (state, type, payload) => Domain.applyOperation(state, { type, payload }, {
    now: '2026-09-14T10:00:00.000Z',
    idFactory: (prefix) => `test-${prefix}-${++counter}`,
  }).state;
  let state = apply(Domain.emptyState(), 'report.create', {
    report: { id: 'report', occurredAt: '2026-09-01', originalMessage: '仅供自动测试的虚构商品' },
    items: items.map(({ actualRebateCents, ...item }) => item),
  });
  const overrides = items.filter((item) => Object.prototype.hasOwnProperty.call(item, 'actualRebateCents'))
    .map((item) => ({ id: item.id, actualRebateCents: item.actualRebateCents }));
  if (overrides.length) state = apply(state, 'report.rebate.update', { id: 'report', items: overrides });
  const lines = items.map((item) => ({ productName: item.productName, quantity: 1 }));
  for (const id of ['earlier', 'later']) {
    state = apply(state, 'shipment.create', {
      shipment: { id, trackingNumber: `TEST-${id}`, shippedAt: '2026-09-02', shippingCostCents: 0 },
      items: lines,
    });
  }
  const view = (current, id = 'later') => Domain.shipmentView(current, current.shipments.find((row) => row.id === id));
  const close = (current, id = 'later') => {
    current = apply(current, 'settlement.create', {
      id: `settlement-${id}`, shipmentId: id, amountCents: view(current, id).expectedRefundCents, settledAt: '2026-09-03',
    });
    return apply(current, 'shipment.close', { id });
  };
  return { state, apply, view, close, lines };
}

function rejectsWithoutMutation(fixture, state, type, payload) {
  const before = Domain.clone(state);
  assert.throws(() => fixture.apply(state, type, payload), guardMessage);
  assert.deepEqual(state, before, 'a rejected operation must not mutate the original state');
  assert.equal(Domain.isStateSnapshot(state), true);
}

for (const field of financialFields) {
  test(`voiding an earlier shipment cannot move a closed allocation's ${field}`, () => {
    const fixture = scenario([{ id: 'lot', productName: '测试商品', quantity: 3, ...zeroAmounts, [field]: 100 }]);
    const state = fixture.close(fixture.state);
    assert.equal(fixture.view(state).items[0][field], 34, 'the middle unit owns the rounding cent');
    rejectsWithoutMutation(fixture, state, 'shipment.void', { id: 'earlier' });
    assert.equal(fixture.view(state).items[0][field], 34);
  });
}

test('changing an earlier shipment quantity cannot silently change a closed shipment or profit', () => {
  const fixture = scenario();
  const state = fixture.close(fixture.state);
  const before = fixture.view(state);
  assert.equal(before.actualPaymentCents, 34);
  assert.equal(before.expectedRefundCents, 34);
  assert.equal(before.refundVarianceCents, 0);
  assert.equal(Domain.stats(state).profitCents, 0);
  rejectsWithoutMutation(fixture, state, 'shipment.update', {
    shipment: { id: 'earlier', note: '新增一件' }, items: [{ productName: '测试商品', quantity: 2 }],
  });
  assert.deepEqual(fixture.view(state), before);
  assert.equal(Domain.stats(state).profitCents, 0);
});

test('the guard compares each closed allocation even when opposite rounding changes cancel in the shipment total', () => {
  const fixture = scenario([
    { id: 'lot-a', productName: '商品A', quantity: 3, ...zeroAmounts, actualPaymentCents: 100 },
    { id: 'lot-b', productName: '商品B', quantity: 3, ...zeroAmounts, actualPaymentCents: 101 },
  ]);
  const state = fixture.close(fixture.state);
  assert.deepEqual(fixture.view(state).items.map((item) => item.actualPaymentCents), [34, 33]);
  assert.equal(fixture.view(state).actualPaymentCents, 67);
  // Removing the earlier allocation would change [34, 33] to [33, 34].
  // Checking only the shipment's total of 67 cents would miss this violation.
  rejectsWithoutMutation(fixture, state, 'shipment.void', { id: 'earlier' });
});

test('an earlier shipment can still change notes or tracking without moving a closed rounding cent', () => {
  const fixture = scenario();
  let state = fixture.close(fixture.state);
  const closedBefore = fixture.view(state);
  state = fixture.apply(state, 'shipment.update', {
    shipment: { id: 'earlier', note: '可编辑备注', trackingNumber: 'TEST-UPDATED', shippedAt: '2026-09-04' },
    items: fixture.lines,
  });
  assert.equal(state.shipments.find((row) => row.id === 'earlier').note, '可编辑备注');
  assert.deepEqual(fixture.view(state), closedBefore);
});

test('earlier quantity changes and voids remain allowed when every closed amount stays unchanged', () => {
  const fixture = scenario([{
    id: 'lot', productName: '测试商品', quantity: 4,
    actualPaymentCents: 400, expectedRefundCents: 480, expectedRebateCents: 40, actualRebateCents: 80,
  }]);
  let state = fixture.close(fixture.state);
  const closedBefore = fixture.view(state);
  state = fixture.apply(state, 'shipment.update', {
    shipment: { id: 'earlier' }, items: [{ productName: '测试商品', quantity: 2 }],
  });
  assert.deepEqual(fixture.view(state), closedBefore);
  state = fixture.apply(state, 'shipment.void', { id: 'earlier' });
  assert.deepEqual(fixture.view(state), closedBefore);
});

test('later open shipments can change quantity or be voided without touching an earlier closed shipment', () => {
  const fixture = scenario();
  let state = fixture.close(fixture.state, 'earlier');
  const closedBefore = fixture.view(state, 'earlier');
  state = fixture.apply(state, 'shipment.update', {
    shipment: { id: 'later' }, items: [{ productName: '测试商品', quantity: 2 }],
  });
  assert.deepEqual(fixture.view(state, 'earlier'), closedBefore);
  state = fixture.apply(state, 'shipment.void', { id: 'later' });
  assert.deepEqual(fixture.view(state, 'earlier'), closedBefore);
});

test('reopening the affected closed shipment explicitly permits the reallocation', () => {
  const fixture = scenario();
  let state = fixture.close(fixture.state);
  state = fixture.apply(state, 'shipment.reopen', { id: 'later' });
  state = fixture.apply(state, 'shipment.void', { id: 'earlier' });
  assert.equal(fixture.view(state).closed, false);
  assert.equal(fixture.view(state).actualPaymentCents, 33);
  assert.equal(fixture.view(state).expectedRefundCents, 33);
  assert.equal(fixture.view(state).returnedCents, 34, 'reopening does not erase the recorded return');
});

test('refunds and refund reversals keep the closed suffix allocation unchanged', () => {
  const fixture = scenario();
  let state = fixture.close(fixture.state);
  const closedBefore = fixture.view(state);
  state = fixture.apply(state, 'refund.create', {
    id: 'refund', reportItemId: 'lot', quantity: 1, refundedAt: '2026-09-04',
  });
  assert.deepEqual(fixture.view(state), closedBefore);
  state = fixture.apply(state, 'refund.void', { id: 'refund' });
  assert.deepEqual(fixture.view(state), closedBefore);
});

test('an explicit rebate correction remains allowed after closing without changing costs, returns or the close state', () => {
  const fixture = scenario([{
    id: 'lot', productName: '测试商品', quantity: 3,
    actualPaymentCents: 100, expectedRefundCents: 100, expectedRebateCents: 100,
  }]);
  let state = fixture.close(fixture.state);
  const before = fixture.view(state);
  assert.equal(before.actualRebateCents, 34);
  for (const actualRebateCents of [0, 101, null]) {
    state = fixture.apply(state, 'report.rebate.update', { id: 'report', items: [{ id: 'lot', actualRebateCents }] });
    const changed = fixture.view(state);
    assert.equal(changed.closedAt, before.closedAt);
    assert.deepEqual(changed.settlements, before.settlements);
    for (const field of financialFields.filter((field) => field !== 'actualRebateCents')) {
      assert.equal(changed[field], before[field]);
    }
    const total = actualRebateCents === null ? 100 : actualRebateCents;
    const shipped = state.shipments.reduce((sum, shipment) => sum + Domain.shipmentView(state, shipment).actualRebateCents, 0);
    const inventory = Domain.inventoryLots(state).reduce((sum, lot) => sum + lot.availableActualRebateCents, 0);
    assert.equal(shipped + inventory, total);
    assert.equal(Domain.stats(state).actualRebateCents, total);
  }
});
