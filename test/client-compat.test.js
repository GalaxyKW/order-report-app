const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const { compileClient, CLIENT_PATH } = require('../scripts/build-web-assets');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const domain = read('shared/domain.js');
const app = read('public/app.js');
const boot = read('public/compat.js');
const compiled = compileClient(domain, app);

function harness({ legacy = false, flexGap = true } = {}) {
  const listeners = new Map();
  const classes = new Set();
  let writes = 0;
  let reloads = 0;
  class Element {
    constructor() {
      this.children = [];
      this.style = {};
      this.innerHTML = '';
      this.textContent = '';
      this.dataset = {};
      this.scrollHeight = flexGap ? 1 : 0;
      this.classList = { add() {}, remove() {}, toggle() {} };
    }
    appendChild(child) { this.children.push(child); return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    remove() {}
    setAttribute() {}
    removeAttribute() {}
  }
  const elements = new Map(['main-content', 'modal-root', 'toast-root', 'sync-state']
    .map((name) => [name, new Element()]));
  const document = {
    body: new Element(),
    documentElement: { classList: { add(name) { classes.add(name); } } },
    createElement() { return new Element(); },
    getElementById(id) { return elements.get(id) || null; },
    querySelector(selector) { return selector[0] === '#' ? elements.get(selector.slice(1)) || null : null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const sandbox = {
    document,
    Element,
    navigator: { userAgent: 'Compatibility test WebView' },
    location: { protocol: 'file:', origin: 'null', reload() { reloads += 1; } },
    localStorage: { getItem() { return null; }, setItem() { writes += 1; } },
    setTimeout() { return 1; },
    clearTimeout() {},
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { if (listeners.has(type)) listeners.get(type).delete(callback); },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  if (legacy) vm.runInContext(`
    delete String.prototype.replaceAll;
    delete Array.prototype.flatMap;
    delete Promise.prototype.finally;
    this.BigInt = undefined;
    this.globalThis = undefined;
  `, context);
  return {
    context, classes, elements,
    writes: () => writes,
    reloads: () => reloads,
    emit(type, event = {}) { for (const listener of listeners.get(type) || []) listener(event); },
    run(source) { return vm.runInContext(source, context); },
  };
}

test('the generated browser client is current and uses ES2017-readable syntax', () => {
  assert.equal(fs.readFileSync(CLIENT_PATH, 'utf8'), compiled, 'Run npm run build:web before shipping');
  acorn.parse(compiled, { ecmaVersion: 2017 });
  acorn.parse(read('public/sw.js'), { ecmaVersion: 2017 });
  acorn.parse(boot, { ecmaVersion: 5 });
  const html = read('public/index.html');
  assert.ok(html.indexOf('src="compat.js"') < html.indexOf('src="client.js"'));
  assert.doesNotMatch(html, /src="(?:app\.js|shared\/domain\.js)"/);
});

for (const legacy of [false, true]) {
  test(`packaged client cold-starts with ${legacy ? 'old' : 'modern'} runtime features`, () => {
    const env = harness({ legacy, flexGap: !legacy });
    env.run(boot);
    env.run(compiled);
    const main = env.elements.get('main-content');
    assert.match(main.innerHTML, /总览/);
    assert.match(main.innerHTML, /累计/);
    assert.equal(env.run('window.OrderDomain.amountForQuantity(100, 3, 1)'), 33);
    const before = main.innerHTML;
    env.emit('load');
    env.emit('error', { target: env.context });
    assert.equal(main.innerHTML, before, 'startup guard must not replace a successfully rendered app');
    assert.equal(env.classes.has('no-flex-gap'), legacy);
  });
}

test('startup load failure offers a retry without reading or clearing saved data', () => {
  const env = harness({ legacy: true, flexGap: false });
  env.run(boot);
  env.emit('error', { target: { tagName: 'SCRIPT' } });
  env.emit('load');
  const main = env.elements.get('main-content');
  assert.equal(main.children.length, 1, 'repeated failure events do not duplicate the fallback');
  const panel = main.children[0];
  assert.equal(panel.children[0].textContent, '页面暂时无法启动');
  assert.match(panel.children[1].textContent, /请勿清除应用数据/);
  assert.equal(env.writes(), 0);
  panel.children[3].onclick();
  assert.equal(env.reloads(), 1);
});

test('an unrelated image error does not trigger the startup fallback', () => {
  const env = harness();
  env.run(boot);
  env.emit('error', { target: { tagName: 'IMG' } });
  assert.equal(env.elements.get('main-content').children.length, 0);
});
