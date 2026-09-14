const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const Domain = require('../shared/domain');
const { Store } = require('../lib/store');
const { restoreBackup } = require('../scripts/restore-sqlite-backup');

const CREATED_AT = '2026-09-14T00:00:00.000Z';
let sqlPromise;

function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    });
  }
  return sqlPromise;
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-report-rebate-sync-'));
  const dbPath = path.join(directory, 'data.sqlite3');
  const stores = [];
  t.after(async () => {
    for (const store of stores.reverse()) await store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    dbPath,
    open() {
      const store = new Store(dbPath);
      stores.push(store);
      return store;
    },
  };
}

function operation(suffix, type, payload) {
  return { opId: `op_${suffix}`, clientId: 'rebate_test_client', type, payload, createdAt: CREATED_AT };
}

function reportOperation(suffix = 'base', count = 2) {
  return operation(`create_${suffix}`, 'report.create', {
    report: { id: `report_${suffix}`, occurredAt: '2026-09-14', originalMessage: 'Synthetic rebate test' },
    items: Array.from({ length: count }, (_, index) => ({
      id: `item_${suffix}_${index}`,
      productName: `Synthetic item ${index}`,
      quantity: 2,
      actualPaymentCents: 1000,
      expectedRefundCents: 800,
      expectedRebateCents: 100,
    })),
  });
}

function rebateOperation(suffix, items, reportId = 'report_base') {
  return operation(suffix, 'report.rebate.update', { id: reportId, items });
}

async function seed(store, create = reportOperation()) {
  const response = await store.applyOperations([create]);
  assert.deepEqual(response.rejected, []);
  assert.equal(response.accepted.length, 1);
  return response;
}

async function readState(filePath) {
  const SQL = await getSql();
  const database = new SQL.Database(fs.readFileSync(filePath));
  try {
    return JSON.parse(database.exec('SELECT state_json FROM app_state WHERE id = 1')[0].values[0][0]);
  } finally {
    database.close();
  }
}

async function writeLegacySnapshot(filePath, state) {
  const SQL = await getSql();
  const database = new SQL.Database();
  try {
    database.run(`
      CREATE TABLE app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        state_json TEXT NOT NULL
      )
    `);
    database.run(
      'INSERT INTO app_state (id, version, updated_at, state_json) VALUES (1, 1, ?, ?)',
      [CREATED_AT, JSON.stringify(state)],
    );
    fs.writeFileSync(filePath, Buffer.from(database.export()), { mode: 0o600 });
  } finally {
    database.close();
  }
}

test('actual rebates persist across reopen without materializing defaults in legacy rows', async (t) => {
  const setup = fixture(t);
  const store = setup.open();
  await seed(store, reportOperation('base', 3));
  const update = rebateOperation('persist', [
    { id: 'item_base_0', actualRebateCents: 0 },
    { id: 'item_base_1', actualRebateCents: 85 },
  ]);
  const result = await store.applyOperations([update]);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.version, 2);
  assert.equal(Object.hasOwn(result.state.reportItems[2], 'actualRebateCents'), false);
  const beforeClose = await store.snapshot();
  await store.close();

  const reopened = setup.open();
  const snapshot = await reopened.snapshot();
  assert.deepEqual(snapshot, beforeClose);
  assert.deepEqual(snapshot.state.reportItems.map((row) => row.actualRebateCents), [0, 85, undefined]);
  assert.deepEqual(snapshot.state.reportItems.map((row) => row.expectedRebateCents), [100, 100, 100]);
  assert.equal(Object.hasOwn((await readState(setup.dbPath)).reportItems[2], 'actualRebateCents'), false);

  const reset = await reopened.applyOperations([rebateOperation('reset', [
    { id: 'item_base_0', actualRebateCents: null },
  ])]);
  assert.deepEqual(reset.rejected, []);
  await reopened.close();
  const resetSnapshot = await setup.open().snapshot();
  const resetItem = resetSnapshot.state.reportItems[0];
  assert.equal(resetItem.actualRebateCents ?? resetItem.expectedRebateCents, 100);
  assert.equal(resetSnapshot.state.reportItems[1].actualRebateCents, 85);
});

test('a failed multi-item rebate update is atomic and blocks later operations in its sync batch', async (t) => {
  const setup = fixture(t);
  const store = setup.open();
  const before = await seed(store);
  const invalid = rebateOperation('atomic_invalid', [
    { id: 'item_base_0', actualRebateCents: 30 },
    { id: 'item_base_1', actualRebateCents: -1 },
  ]);
  const afterInvalid = rebateOperation('after_invalid', [{ id: 'item_base_0', actualRebateCents: 60 }]);

  const response = await store.applyOperations([invalid, afterInvalid]);
  assert.deepEqual(response.accepted, []);
  assert.deepEqual(response.rejected.map((row) => row.opId), [invalid.opId]);
  assert.deepEqual(response.unprocessed.map((row) => row.opId), [afterInvalid.opId]);
  assert.equal(response.version, before.version);
  assert.deepEqual(response.state, before.state);
  assert.deepEqual((await store.snapshot()).state, before.state);
  await store.close();

  const reopened = setup.open();
  const repeated = await reopened.applyOperations([invalid]);
  assert.deepEqual(repeated.accepted, []);
  assert.equal(repeated.rejected[0].error, response.rejected[0].error);
  assert.equal(repeated.version, before.version);
  assert.deepEqual(repeated.state, before.state);
  const following = await reopened.applyOperations([afterInvalid]);
  assert.deepEqual(following.rejected, []);
  assert.equal(following.version, before.version + 1);
  assert.equal(following.state.reportItems[0].actualRebateCents, 60);
});

test('a rebate sync batch commits its accepted prefix but not a failing operation or its suffix', async (t) => {
  const setup = fixture(t);
  const store = setup.open();
  await seed(store);
  const first = rebateOperation('prefix', [{ id: 'item_base_0', actualRebateCents: 0 }]);
  const invalid = rebateOperation('invalid_middle', [
    { id: 'item_base_1', actualRebateCents: 20 },
    { id: 'item_missing', actualRebateCents: 40 },
  ]);
  const last = rebateOperation('suffix', [{ id: 'item_base_0', actualRebateCents: 99 }]);
  const response = await store.applyOperations([first, invalid, last]);

  assert.deepEqual(response.accepted.map((row) => row.opId), [first.opId]);
  assert.deepEqual(response.rejected.map((row) => row.opId), [invalid.opId]);
  assert.deepEqual(response.unprocessed.map((row) => row.opId), [last.opId]);
  assert.equal(response.version, 2);
  assert.equal(response.state.reportItems[0].actualRebateCents, 0);
  assert.equal(Object.hasOwn(response.state.reportItems[1], 'actualRebateCents'), false);
  await store.close();
  assert.deepEqual((await setup.open().snapshot()).state, response.state);
});

test('rebate op IDs remain idempotent across reopen and reject changed payloads', async (t) => {
  const setup = fixture(t);
  const store = setup.open();
  await seed(store);
  const update = rebateOperation('idempotent', [{ id: 'item_base_0', actualRebateCents: 0 }]);
  const first = await store.applyOperations([update]);
  assert.deepEqual(first.rejected, []);
  await store.close();
  const reopened = setup.open();

  // Property order is not part of an operation's canonical payload identity.
  const reordered = {
    ...update,
    payload: { items: [{ actualRebateCents: 0, id: 'item_base_0' }], id: 'report_base' },
  };
  const replay = await reopened.applyOperations([reordered]);
  assert.deepEqual(replay.rejected, []);
  assert.equal(replay.accepted[0].opId, update.opId);
  assert.equal(replay.version, first.version);
  assert.deepEqual(replay.state, first.state);

  const collision = await reopened.applyOperations([{
    ...update,
    payload: { ...update.payload, items: [{ id: 'item_base_0', actualRebateCents: 75 }] },
  }]);
  assert.deepEqual(collision.accepted, []);
  assert.match(collision.rejected[0].error, /不同内容/);
  assert.equal(collision.version, first.version);
  assert.deepEqual(collision.state, first.state);
});

test('old-client report edits preserve actual zero and do not rewrite pending create payloads', async (t) => {
  const setup = fixture(t);
  const store = setup.open();
  const create = reportOperation();
  const originalPayload = JSON.stringify(create);
  await seed(store, create);
  const changed = await store.applyOperations([rebateOperation('zero', [
    { id: 'item_base_0', actualRebateCents: 0 },
  ])]);
  assert.deepEqual(changed.rejected, []);
  const edit = operation('old_client_edit', 'report.update', {
    report: { ...create.payload.report, originalMessage: 'Edited by an older client' },
    items: create.payload.items.map((row) => ({ ...row, expectedRebateCents: 200 })),
  });

  const updated = await store.applyOperations([edit]);
  assert.deepEqual(updated.rejected, []);
  assert.equal(updated.state.reportItems[0].actualRebateCents, 0);
  assert.equal(updated.state.reportItems[0].expectedRebateCents, 200);
  assert.equal(Object.hasOwn(updated.state.reportItems[1], 'actualRebateCents'), false);
  assert.equal(updated.state.reportItems[1].expectedRebateCents, 200);
  assert.equal(JSON.stringify(create), originalPayload);

  const replay = await store.applyOperations([create]);
  assert.deepEqual(replay.rejected, []);
  assert.equal(replay.version, updated.version);
  assert.deepEqual(replay.state, updated.state);
});

test('schema-1 backups without actual rebates restore with defaults left implicit', async (t) => {
  const setup = fixture(t);
  const backupDir = path.join(setup.directory, 'backups');
  fs.mkdirSync(backupDir, { mode: 0o700 });
  const legacyPath = path.join(backupDir, 'legacy-schema-1.sqlite3');
  const legacyState = Domain.applyOperation(Domain.emptyState(), reportOperation(), { now: CREATED_AT }).state;
  assert.equal(legacyState.schemaVersion, 1);
  assert.ok(legacyState.reportItems.every((row) => !Object.hasOwn(row, 'actualRebateCents')));
  await writeLegacySnapshot(legacyPath, legacyState);

  await restoreBackup({ databasePath: setup.dbPath, inputPath: legacyPath });
  const store = setup.open();
  const snapshot = await store.snapshot();
  assert.equal(snapshot.version, 1);
  assert.deepEqual(snapshot.state, legacyState);
  assert.ok(snapshot.state.reportItems.every((row) => !Object.hasOwn(row, 'actualRebateCents')));
  const result = await store.applyOperations([rebateOperation('legacy_zero', [
    { id: 'item_base_0', actualRebateCents: 0 },
  ])]);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.state.reportItems[0].actualRebateCents, 0);
});

test('actual rebates survive JSON snapshot export and validated SQLite backup restoration', async (t) => {
  const setup = fixture(t);
  const store = setup.open();
  await seed(store, reportOperation('base', 3));
  const updated = await store.applyOperations([rebateOperation('backup_values', [
    { id: 'item_base_0', actualRebateCents: 0 },
    { id: 'item_base_1', actualRebateCents: 85 },
    { id: 'item_base_2', actualRebateCents: null },
  ])]);
  assert.deepEqual(updated.rejected, []);
  const snapshot = await store.snapshot();
  // /api/export serializes Store.snapshot() directly, without a field whitelist.
  const exported = JSON.parse(JSON.stringify(snapshot));
  assert.equal(Domain.isStateSnapshot(exported.state), true);
  assert.deepEqual(exported.state, snapshot.state);
  assert.equal(exported.state.reportItems[0].actualRebateCents, 0);
  assert.equal(exported.state.reportItems[1].actualRebateCents, 85);

  const backup = await store.backupDaily('2026-08-31');
  assert.deepEqual(await readState(backup.path), exported.state);
  const later = await store.applyOperations([rebateOperation('after_backup', [
    { id: 'item_base_0', actualRebateCents: 77 },
  ])]);
  assert.deepEqual(later.rejected, []);
  await store.close();

  const restored = await restoreBackup({ databasePath: setup.dbPath, inputPath: backup.path });
  assert.ok(restored.beforeRestorePath);
  assert.equal((await readState(restored.beforeRestorePath)).reportItems[0].actualRebateCents, 77);
  const restoredSnapshot = await setup.open().snapshot();
  assert.deepEqual(restoredSnapshot, exported);
});

test('invalid stored actual rebates cannot be normalized into a valid live state or backup', async (t) => {
  const setup = fixture(t);
  const store = setup.open();
  const valid = await seed(store);
  await store.close();
  const before = fs.readFileSync(setup.dbPath);
  const invalidState = JSON.parse(JSON.stringify(valid.state));
  invalidState.reportItems[0].actualRebateCents = -1;
  const backupPath = path.join(setup.directory, 'backups', 'invalid-rebate.sqlite3');
  await writeLegacySnapshot(backupPath, invalidState);

  await assert.rejects(
    restoreBackup({ databasePath: setup.dbPath, inputPath: backupPath }),
    /state_json 不是兼容/,
  );
  assert.deepEqual(fs.readFileSync(setup.dbPath), before);
  assert.equal(fs.readdirSync(setup.directory).some((name) => name.includes('.before-restore-')), false);

  const invalidDirectory = path.join(setup.directory, 'invalid-live');
  fs.mkdirSync(invalidDirectory, { mode: 0o700 });
  const invalidLivePath = path.join(invalidDirectory, 'data.sqlite3');
  await writeLegacySnapshot(invalidLivePath, invalidState);
  const invalidBefore = fs.readFileSync(invalidLivePath);
  const invalidStore = new Store(invalidLivePath);
  try {
    await assert.rejects(invalidStore.ready, /应用状态结构不兼容/);
    assert.deepEqual(fs.readFileSync(invalidLivePath), invalidBefore);
  } finally {
    await invalidStore.close();
  }
});
