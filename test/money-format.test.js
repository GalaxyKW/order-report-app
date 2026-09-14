const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Domain = require('../shared/domain');

test('integer-cent money formatting preserves ordinary amounts and negative profits', () => {
  for (const [cents, expected] of [
    [0, '0.00'], [-0, '0.00'], [1, '0.01'], [9, '0.09'], [10, '0.10'],
    [99, '0.99'], [100, '1.00'], [101, '1.01'], [123456, '1234.56'],
    [-1, '-0.01'], [-10, '-0.10'], [-99, '-0.99'], [-100, '-1.00'], [-123456, '-1234.56'],
    [Number.MAX_SAFE_INTEGER, '90071992547409.91'],
    [Number.MAX_SAFE_INTEGER - 1, '90071992547409.90'],
    [Number.MIN_SAFE_INTEGER, '-90071992547409.91'],
    [Number.MIN_SAFE_INTEGER + 1, '-90071992547409.90'],
  ]) assert.equal(Domain.formatMoney(cents), expected, `${cents} cents`);
});

test('safe-integer boundaries round trip through editable money text without losing a cent', () => {
  const cases = new Set([0, 1, 99, 100, 101, 123456, 1000000000000000]);
  for (let offset = 0; offset < 2048; offset += 1) cases.add(Number.MAX_SAFE_INTEGER - offset);
  for (const magnitude of cases) {
    for (const sign of [1, -1]) {
      const cents = magnitude * sign;
      const formatted = Domain.formatMoney(cents);
      assert.match(formatted, /^-?\d+\.\d{2}$/);
      const parsedMagnitude = Domain.parseMoney(formatted.replace(/^-/, ''), '金额');
      const parsed = formatted.startsWith('-') ? -parsedMagnitude : parsedMagnitude;
      assert.equal(parsed, cents || 0, `round trip changed ${cents} cents via ${formatted}`);
    }
  }
});

test('money formatting works without BigInt or String.padStart', () => {
  const context = vm.createContext({ BigInt: undefined });
  vm.runInContext('delete String.prototype.padStart', context);
  vm.runInContext(fs.readFileSync(require.resolve('../shared/domain'), 'utf8'), context);
  assert.equal(context.OrderDomain.formatMoney(Number.MAX_SAFE_INTEGER - 1), '90071992547409.90');
  assert.equal(context.OrderDomain.formatMoney(Number.MIN_SAFE_INTEGER + 1), '-90071992547409.90');
  assert.equal(context.OrderDomain.formatMoney(0), '0.00');
  assert.equal(context.OrderDomain.formatMoney(-1), '-0.01');
});

test('non-safe-integer inputs retain the previous formatting behavior', () => {
  for (const value of [undefined, null, '', '123', 'not a number', NaN, Infinity, -Infinity, 1.5, -1.5, Number.MAX_SAFE_INTEGER + 1, 1e25]) {
    const previous = (Number(value || 0) / 100).toFixed(2);
    assert.equal(Domain.formatMoney(value), previous, String(value));
  }
});
