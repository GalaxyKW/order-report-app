const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Domain = require('../shared/domain');
const { Store } = require('../lib/store');

const CREATED_AT = '2026-10-01T00:00:00.000Z';
const RENAMED_AT = '2026-10-16T00:00:00.000Z';
const OLD_NAME = '演示旧名称';
const NEW_NAME = '演示新名称';

function operation(id, type, payload) {
  return { opId: `inventory_${id}`, clientId: 'inventory_test_client', type, payload, createdAt: CREATED_AT };
}

function createReport(id, productName = OLD_NAME, quantity = 4, occurredAt = '2026-10-02', extras = []) {
  return operation(`create_${id}`, 'report.create', {
    report: { id, occurredAt, originalMessage: `虚构原始消息 ${productName}` },
    items: [{
      id: `${id}_item`, productName, quantity,
      actualPaymentCents: 1001, expectedRefundCents: 1203, expectedRebateCents: 101,
    }, ...extras],
  });
}

function rename(id = 'rename', ids = ['first_item', 'second_item'], productName = OLD_NAME, newName = NEW_NAME) {
  return operation(id, 'inventory.rename', { productName, newName, reportItemIds: ids });
}

function shipment(id, productName = OLD_NAME, quantity = 2) {
  return operation(`ship_${id}`, 'shipment.create', {
    shipment: { id, trackingNumber: `DEMO-${id}`, shippedAt: '2026-10-08', shippingCostCents: 31 },
    items: [{ productName, quantity }],
  });
}

function seedOperations() {
  return [
    createReport('history', OLD_NAME, 1, '2026-10-01'),
    createReport('first', OLD_NAME, 4, '2026-10-02', [{
      id: 'sibling_item', productName: OLD_NAME, quantity: 2,
      actualPaymentCents: 803, expectedRefundCents: 900, expectedRebateCents: 37,
    }]),
    createReport('second', OLD_NAME, 2, '2026-10-03'),
    createReport('destination', NEW_NAME, 3, '2026-10-04'),
    shipment('closed'),
    operation('settlement', 'settlement.create', {
      settlement: { id: 'settlement', shipmentId: 'closed', amountCents: 1507, settledAt: '2026-10-09' },
    }),
    operation('close', 'shipment.close', { id: 'closed' }),
    operation('refund', 'refund.create', {
      refund: { id: 'refund', reportItemId: 'first_item', quantity: 1, refundedAt: '2026-10-10' },
    }),
    operation('rebate', 'report.rebate.update', { id: 'first', items: [{ id: 'first_item', actualRebateCents: 0 }] }),
  ];
}

function initial() {
  let state = Domain.emptyState();
  let sequence = 0;
  for (const op of seedOperations()) {
    state = Domain.applyOperation(state, op, {
      now: CREATED_AT, idFactory: (prefix) => `${prefix}_${++sequence}`,
    }).state;
  }
  return state;
}

function apply(state, op = rename()) {
  return Domain.applyOperation(state, op, { now: RENAMED_AT });
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-report-inventory-rename-'));
  const dbPath = path.join(directory, 'test.sqlite3');
  const stores = [];
  t.after(async () => {
    for (const store of stores.reverse()) await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    open() {
      const store = new Store(dbPath);
      stores.push(store);
      return store;
    },
  };
}

test('same-name inventory aggregates display quantities while retaining independent FIFO batches', () => {
  const state = initial();
  const oldGroup = Domain.aggregateInventory(state).find((row) => row.productName === OLD_NAME);
  assert.equal(oldGroup.availableQuantity, 6);
  assert.deepEqual(oldGroup.lots.map((lot) => lot.reportItemId), ['first_item', 'sibling_item', 'second_item']);
  assert.deepEqual(Domain.allocateFifo(state, [{ productName: OLD_NAME, quantity: 5 }]), [
    { reportItemId: 'first_item', quantity: 2 },
    { reportItemId: 'sibling_item', quantity: 2 },
    { reportItemId: 'second_item', quantity: 1 },
  ]);
});

test('inventory rename synchronizes only explicit source report items and merges existing names without merging records', () => {
  const before = initial();
  const original = JSON.stringify(before);
  const { state, result } = apply(before);
  assert.equal(JSON.stringify(before), original, 'the caller snapshot must not be mutated');
  assert.deepEqual(result, {
    productName: OLD_NAME, newName: NEW_NAME,
    itemIds: ['first_item', 'second_item'], reportIds: ['first', 'second'],
  });
  const expected = JSON.parse(original);
  for (const item of expected.reportItems.filter((row) => result.itemIds.includes(row.id))) {
    item.productName = NEW_NAME;
    item.updatedAt = RENAMED_AT;
  }
  for (const report of expected.reports.filter((row) => result.reportIds.includes(row.id))) report.updatedAt = RENAMED_AT;
  assert.deepEqual(state, expected, 'only selected names and their item/report timestamps may change');
  const merged = Domain.aggregateInventory(state).find((row) => row.productName === NEW_NAME);
  assert.equal(merged.availableQuantity, 7);
  assert.deepEqual(merged.lots.map((lot) => lot.reportItemId), ['first_item', 'second_item', 'destination_item']);
  assert.equal(Domain.aggregateInventory(state).find((row) => row.productName === OLD_NAME).availableQuantity, 2);
  assert.equal(state.reportItems.find((row) => row.id === 'history_item').productName, OLD_NAME);
  assert.equal(state.reportItems.find((row) => row.id === 'sibling_item').productName, OLD_NAME);
  assert.equal(Domain.isStateSnapshot(state), true);
});

test('renaming a batch with closed shipment and refund references preserves money, allocations, refunds and closure', () => {
  const before = initial();
  const { state } = apply(before);
  for (const key of ['shipments', 'shipmentItems', 'settlements', 'refunds']) assert.deepEqual(state[key], before[key]);
  assert.deepEqual(Domain.stats(state), Domain.stats(before));
  const originalView = Domain.shipmentView(before, before.shipments[0]);
  const renamedView = Domain.shipmentView(state, state.shipments[0]);
  const normalizedView = {
    ...renamedView,
    items: renamedView.items.map((item) => ({ ...item, productName: OLD_NAME })),
  };
  assert.deepEqual(normalizedView, originalView);
  assert.equal(renamedView.items.find((item) => item.reportItemId === 'first_item').productName, NEW_NAME);
  assert.equal(renamedView.items.find((item) => item.reportItemId === 'history_item').productName, OLD_NAME);
  assert.equal(state.reportItems.find((item) => item.id === 'first_item').actualRebateCents, 0);
});

test('renamed inventory keeps original FIFO ordering and fractional-cent batch amounts', () => {
  const before = initial();
  const renamed = apply(before).state;
  assert.deepEqual(Domain.allocateFifo(renamed, [{ productName: NEW_NAME, quantity: 5 }]), [
    { reportItemId: 'first_item', quantity: 2 },
    { reportItemId: 'second_item', quantity: 2 },
    { reportItemId: 'destination_item', quantity: 1 },
  ]);
  const withoutName = (lot) => { const { productName, ...rest } = lot; return rest; };
  assert.deepEqual(Domain.inventoryLots(renamed).map(withoutName), Domain.inventoryLots(before).map(withoutName));
  const state = apply(renamed, shipment('after_rename', NEW_NAME, 5)).state;
  const view = Domain.shipmentView(state, state.shipments.find((row) => row.id === 'after_rename'));
  assert.deepEqual(view.items.map(({ reportItemId, quantity }) => ({ reportItemId, quantity })), [
    { reportItemId: 'first_item', quantity: 2 },
    { reportItemId: 'second_item', quantity: 2 },
    { reportItemId: 'destination_item', quantity: 1 },
  ]);
  assert.equal(Domain.isStateSnapshot(state), true);
});

test('inventory rename trims names, safely accepts prototype-like names, and same-name requests do not rewrite timestamps', () => {
  const state = initial();
  assert.deepEqual(apply(state, rename('same', ['first_item'], ` ${OLD_NAME} `, ` ${OLD_NAME} `)).state, state);
  for (const name of ['__proto__', 'constructor', '<商品 & "示例">']) {
    const renamed = apply(state, rename('special', ['first_item'], OLD_NAME, ` ${name} `)).state;
    const group = Domain.aggregateInventory(renamed).find((row) => row.productName === name);
    assert.equal(group.availableQuantity, 2);
    assert.equal(group.lots[0].reportItemId, 'first_item');
  }
});

test('inventory rename rejects missing, duplicate and malformed batch IDs without partial mutation', () => {
  const state = initial();
  const original = JSON.stringify(state);
  for (const ids of [undefined, null, [], 'first_item', ['first_item', 'first_item'], ['first_item', 'missing'], ['first_item', null], ['first_item', 1], ['first_item', {}], ['first_item', ' ']]) {
    const invalid = rename('invalid');
    invalid.payload.reportItemIds = ids;
    assert.throws(() => apply(state, invalid), /批次|商品/);
    assert.equal(JSON.stringify(state), original);
  }
});

test('inventory rename rejects invalid names and stale-name conflicts atomically', () => {
  const state = initial();
  const original = JSON.stringify(state);
  for (const value of [null, 42, {}, [], '', '  ']) {
    assert.throws(() => apply(state, rename('invalid_old', ['first_item'], value)), /名称/);
    assert.throws(() => apply(state, rename('invalid_new', ['first_item'], OLD_NAME, value)), /名称/);
  }
  assert.throws(() => apply(state, rename('mixed', ['first_item', 'destination_item'])), /名称已变化/);
  assert.throws(() => apply(state, rename('stale', ['first_item'], '过时名称')), /名称已变化/);
  assert.equal(JSON.stringify(state), original);
});

test('inventory rename refuses sold-out, void-item and void-report batches rather than rewriting history', () => {
  const state = initial();
  assert.throws(() => apply(state, rename('sold', ['first_item', 'history_item'])), /已无库存/);
  const voidItemState = JSON.parse(JSON.stringify(state));
  voidItemState.reportItems.find((row) => row.id === 'sibling_item').status = 'void';
  assert.equal(Domain.isStateSnapshot(voidItemState), true);
  assert.throws(() => apply(voidItemState, rename('void_item', ['first_item', 'sibling_item'])), /不存在、已作废/);
  const voidReportState = apply(state, operation('void_report', 'report.void', { id: 'second' })).state;
  assert.throws(() => apply(voidReportState, rename('void_report')), /不存在、已作废/);
  const depleted = apply(state, shipment('depleted', OLD_NAME, 6)).state;
  const snapshot = JSON.stringify(depleted);
  assert.throws(() => apply(depleted), /已无库存/);
  assert.equal(JSON.stringify(depleted), snapshot);
});

test('offline rename scope does not silently absorb same-name batches added on another client', () => {
  const state = initial();
  const pendingRename = rename();
  const otherClient = apply(state, createReport('concurrent', OLD_NAME, 3, '2026-10-05')).state;
  const renamed = apply(otherClient, pendingRename).state;
  assert.equal(renamed.reportItems.find((row) => row.id === 'concurrent_item').productName, OLD_NAME);
  assert.equal(Domain.aggregateInventory(renamed).find((row) => row.productName === OLD_NAME).availableQuantity, 5);
});

test('inventory rename persists across reopen and exact op-ID replay is idempotent even after stock ships', async (t) => {
  const setup = fixture(t);
  const store = setup.open();
  const seeded = await store.applyOperations(seedOperations());
  assert.deepEqual(seeded.rejected, []);
  const update = rename();
  const renamed = await store.applyOperations([update]);
  assert.deepEqual(renamed.rejected, []);
  assert.equal(renamed.version, seeded.version + 1);
  assert.deepEqual(Domain.stats(renamed.state), Domain.stats(seeded.state));
  const shipped = await store.applyOperations([shipment('remaining', NEW_NAME, 7)]);
  assert.deepEqual(shipped.rejected, []);
  const beforeClose = await store.snapshot();
  await store.close();
  const reopened = setup.open();
  assert.deepEqual(await reopened.snapshot(), beforeClose);
  const replay = await reopened.applyOperations([{
    ...update,
    payload: { reportItemIds: update.payload.reportItemIds, newName: NEW_NAME, productName: OLD_NAME },
  }]);
  assert.deepEqual(replay.rejected, []);
  assert.equal(replay.version, beforeClose.version);
  assert.deepEqual(replay.state, beforeClose.state);
  const collision = await reopened.applyOperations([{ ...update, payload: { ...update.payload, newName: '其他名称' } }]);
  assert.deepEqual(collision.accepted, []);
  assert.match(collision.rejected[0].error, /不同内容/);
  assert.deepEqual(collision.state, beforeClose.state);
});

test('a failed inventory rename is atomic, persists its rejection, and leaves later offline operations unprocessed', async (t) => {
  const setup = fixture(t);
  const store = setup.open();
  const before = await store.applyOperations(seedOperations());
  assert.deepEqual(before.rejected, []);
  const bad = rename('invalid_mixed', ['first_item', 'destination_item']);
  const following = shipment('after_bad', NEW_NAME, 1);
  const response = await store.applyOperations([bad, following]);
  assert.deepEqual(response.accepted, []);
  assert.deepEqual(response.rejected.map((row) => row.opId), [bad.opId]);
  assert.deepEqual(response.unprocessed.map((row) => row.opId), [following.opId]);
  assert.equal(response.version, before.version);
  assert.deepEqual(response.state, before.state);
  await store.close();
  const reopened = setup.open();
  assert.deepEqual((await reopened.snapshot()).state, before.state);
  const replay = await reopened.applyOperations([bad]);
  assert.equal(replay.version, before.version);
  assert.equal(replay.rejected[0].error, response.rejected[0].error);
  assert.deepEqual(replay.state, before.state);
  const corrected = await reopened.applyOperations([rename('corrected'), following]);
  assert.deepEqual(corrected.rejected, []);
  assert.equal(corrected.version, before.version + 2);
});

test('offline create, rename, then shipment replay in order with report names synchronized', async (t) => {
  const setup = fixture(t);
  const store = setup.open();
  const operations = [
    createReport('offline', OLD_NAME, 2),
    rename('offline_rename', ['offline_item']),
    shipment('offline_shipment', NEW_NAME, 1),
  ];
  const result = await store.applyOperations(operations);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.accepted.map((row) => row.opId), operations.map((op) => op.opId));
  assert.equal(result.version, 3);
  assert.equal(result.state.reportItems[0].productName, NEW_NAME);
  assert.equal(Domain.inventoryLots(result.state)[0].availableQuantity, 1);
  assert.equal(Domain.shipmentView(result.state, result.state.shipments[0]).items[0].productName, NEW_NAME);
  const replay = await store.applyOperations(operations);
  assert.deepEqual(replay.rejected, []);
  assert.equal(replay.version, 3);
  assert.deepEqual(replay.state, result.state);
});
