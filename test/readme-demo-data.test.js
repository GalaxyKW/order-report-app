const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Domain = require('../shared/domain');
const { createDemoStorage } = require('../scripts/readme-demo-data');

test('README demo data is deterministic, standalone and has no connection credentials', () => {
  const fixture = createDemoStorage();
  assert.deepEqual(fixture, createDemoStorage());
  assert.equal(Domain.isStateSnapshot(fixture.state), true);
  assert.deepEqual(fixture.settings, { apiBase: '', token: '' });
  assert.deepEqual(fixture.queue, []);
  assert.equal(fixture.hasSynced, false);
  for (const collection of Object.values(fixture.state).filter(Array.isArray)) {
    for (const row of collection) assert.match(row.id, /^demo-/);
  }
  for (const shipment of fixture.state.shipments) assert.match(shipment.trackingNumber, /^DEMO-\d{3}$/);
  for (const report of fixture.state.reports) assert.match(report.originalMessage, /演示.*虚构/);
  assert.doesNotMatch(JSON.stringify(fixture), /https?:\/\/|@|(?:gh[pousr]_|github_pat_)/);
});

test('README showcase includes real accounting states and a partial-refund rebate example', () => {
  const { state } = createDemoStorage();
  const stats = Domain.stats(state);
  assert.equal(stats.totalPurchaseCents, 38000);
  assert.equal(stats.outstandingCents, 28200);
  assert.equal(stats.actualRebateCents, 3275);
  assert.equal(stats.profitCents, 8075);
  assert.equal(stats.pureProfitCents, 6675);
  const item = Domain.itemById(state, 'demo-item-1');
  assert.equal(item.expectedRebateCents, 1200);
  assert.equal(item.actualRebateCents, 900);
  assert.equal(Domain.refundQuantity(state, item.id), 1);
  assert.equal(state.shipments.filter((row) => row.closedAt).length, 1);
  assert.equal(state.shipments.filter((row) => !row.closedAt).length, 1);
});

test('a screenshot run cannot mutate the fixture used by another run', () => {
  const first = createDemoStorage();
  first.state.reportItems[0].productName = 'modified only in this test';
  first.settings.token = 'synthetic-test-value';
  const next = createDemoStorage();
  assert.equal(next.state.reportItems[0].productName, '方格便签本');
  assert.equal(next.settings.token, '');
});

test('README references original-sized PNGs without text, EXIF or embedded profile metadata', () => {
  const root = path.join(__dirname, '..');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  for (const [name, width, height] of [
    ['dashboard-desktop.png', 1440, 1100],
    ['dashboard-mobile.png', 390, 900],
    ['reports-mobile.png', 390, 900],
    ['rebate-mobile.png', 390, 900],
  ]) {
    assert.ok(readme.includes(`docs/screenshots/${name}`), `${name} must appear in the showcase`);
    const filename = path.join(root, 'docs', 'screenshots', name);
    assert.equal(fs.lstatSync(filename).isFile(), true);
    const png = fs.readFileSync(filename);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
    let offset = 8;
    let ended = false;
    while (offset < png.length) {
      assert.ok(offset + 12 <= png.length, 'PNG chunk header must be complete');
      const length = png.readUInt32BE(offset);
      const type = png.toString('ascii', offset + 4, offset + 8);
      assert.ok(offset + 12 + length <= png.length, 'PNG chunk must fit within the file');
      assert.ok(!['tEXt', 'zTXt', 'iTXt', 'eXIf', 'iCCP'].includes(type), `${name}: unexpected identifying metadata ${type}`);
      offset += 12 + length;
      if (type === 'IEND') { ended = true; break; }
    }
    assert.equal(ended, true);
    assert.equal(offset, png.length, 'No hidden trailing payload after PNG end');
  }
});
