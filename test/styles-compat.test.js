const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const stylesheet = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

// This is a layout regression test, not an emulator. Remove declarations that
// Chromium 61 cannot parse; grid-gap intentionally survives as the old alias.
function legacyStyles(source) {
  return source
    .replace(/(?<![\w-])(?:gap|inset|margin-inline|(?:-webkit-)?backdrop-filter)\s*:[^;{}]*;/g, '')
    .replace(/--safe-[a-z]+\s*:\s*env\([^;]*;/g, '')
    .replace(/[\w-]+\s*:\s*[^;{}]*(?:\d+dvh|\bmin\(|\bclamp\()[^;{}]*;/g, '')
    .replace(/overflow-wrap:\s*anywhere;/g, '')
    .replace(/font-weight:\s*\d[1-9]\d;/g, '');
}

const fixture = `
<div class="app-shell">
  <header class="topbar">
    <div class="brand"><span class="brand-mark">报</span><span class="brand-name">报单管家</span><span class="status-pill local">仅本地</span></div>
    <div class="top-actions"><button class="button button-quiet">同步</button><button class="button button-quiet">设置</button></div>
  </header>
  <div class="layout">
    <aside class="sidebar"><nav class="nav-list">${['总览', '报单', '快递', '仓库', '退款', '设置'].map((label) => `<button class="nav-item">${label}</button>`).join('')}</nav></aside>
    <main class="main-content">
      <div class="page-heading"><div><h1>总览</h1><p class="page-subtitle">收入、库存和返款状态</p></div><button class="button">新增报单</button></div>
      <section class="card-grid"><article class="stat-card"><div class="stat-label">累计商品付款</div><div class="stat-value money">¥12345.67</div></article><article class="stat-card"><div class="stat-label">预计未返款</div><div class="stat-value money">¥12345.67</div></article></section>
      <div class="toolbar"><div class="toolbar-group"><input class="input search-input" placeholder="搜索商品、原消息、时间"></div><div class="toolbar-group"><span class="small">1 笔有效报单</span></div></div>
      <section class="panel table-panel"><div class="table-wrap"><table class="mobile-table report-table"><tbody><tr><td class="number">2026/9/6 20:00:00</td><td><strong>测试商品</strong></td><td class="money">¥123.45</td><td class="money">¥150.00</td><td class="money">¥5.00</td><td>短句保持完整</td><td><div class="inline-actions"><button class="link-button">打印单子</button><button class="link-button">编辑</button><button class="link-button">撤销</button></div></td></tr></tbody></table></div></section>
      <div class="backup-actions"><button class="button button-quiet">导出本机数据</button><button class="button button-quiet">导出服务器数据</button></div>
      <div class="print-actions"><button class="button button-quiet">复制内容</button><button class="button">打印</button></div>
    </main>
  </div>
</div>
<div id="modal-root"><div class="modal-backdrop"><section class="modal"><div class="modal-heading"><h2>新增报单</h2><button class="close-button">×</button></div><div class="modal-body"><div class="form-grid"><div class="field"><label>实际返款金额</label><input class="input" value="123.45"></div><div class="field"><label>报单时间</label><input class="input" type="datetime-local"></div></div><div class="form-actions"><button class="button button-quiet">取消</button><button class="button">保存报单</button></div></div></section></div></div>
<div id="toast-root"><div class="toast">连接失败：${'example'.repeat(30)}</div></div>`;

// The browser is optional in the ordinary unit suite. Run with an explicitly
// available Chrome/Chromium binary to check real computed styles and geometry.
test('modern and legacy CSS keep phone controls and dialogs reachable', {
  skip: !process.env.ORDER_REPORT_CSS_BROWSER,
  timeout: 30000,
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-report-css-'));
  try {
    const cases = [320, 390, 768, 1440].flatMap((width) => [false, true].map((legacy) => ({ width, legacy })));
    const documents = cases.map(({ legacy }) => `<!doctype html><html class="${legacy ? 'no-flex-gap' : ''}"><meta charset="utf-8"><style>${legacy ? legacyStyles(stylesheet) : stylesheet}</style><body>${fixture}</body></html>`);
    const script = `
      const cases = ${JSON.stringify(cases)};
      const documents = ${JSON.stringify(documents)};
      const reports = [];
      cases.forEach((entry, index) => {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'display:block;border:0;width:' + entry.width + 'px;height:800px';
        frame.onload = () => {
          const win = frame.contentWindow;
          const doc = frame.contentDocument;
          // Modern Chrome treats grid-gap as a gap alias in Flex too. Old
          // Chromium only applies that alias to Grid, so model that distinction.
          if (entry.legacy) Array.from(doc.querySelectorAll('*')).forEach(node => {
            if (/^(?:inline-)?flex$/.test(win.getComputedStyle(node).display)) node.style.gap = '0px';
          });
          const one = selector => doc.querySelector(selector);
          const rect = selector => { const b = one(selector).getBoundingClientRect(); return { x:b.x, y:b.y, width:b.width, height:b.height, right:b.right, bottom:b.bottom }; };
          const style = selector => win.getComputedStyle(one(selector));
          const brand = Array.from(doc.querySelectorAll('.brand > *')).filter(node => win.getComputedStyle(node).display !== 'none');
          const first = brand[0].getBoundingClientRect();
          const second = brand[1].getBoundingClientRect();
          const cards = Array.from(doc.querySelectorAll('.card-grid > *')).map(node => node.getBoundingClientRect());
          const actions = Array.from(doc.querySelectorAll('.mobile-table .inline-actions > *')).map(node => ({ margin:win.getComputedStyle(node).margin, whiteSpace:win.getComputedStyle(node).whiteSpace, width:node.clientWidth, scrollWidth:node.scrollWidth }));
          const prints = Array.from(doc.querySelectorAll('.print-actions > *')).map(node => node.getBoundingClientRect());
          reports[index] = {
            ...entry, viewportWidth:doc.documentElement.clientWidth, backdrop:rect('.modal-backdrop'), main:rect('.main-content'), toast:rect('.toast'),
            padding:parseFloat(style('.main-content').paddingLeft), brandGap:second.left-first.right,
            gridGap:entry.width<=460 ? cards[1].top-cards[0].bottom : cards[1].left-cards[0].right,
            printGap:entry.width<=620 ? prints[0].top-prints[1].bottom : prints[1].left-prints[0].right,
            actions, safeTop:style('html').getPropertyValue('--safe-top').trim(),
            controls:Array.from(doc.querySelectorAll('.top-actions button, .backup-actions button, .form-actions button, .field input')).map(node => ({right:node.getBoundingClientRect().right, left:node.getBoundingClientRect().left, width:node.clientWidth, scrollWidth:node.scrollWidth})),
          };
          if (reports.filter(Boolean).length === cases.length) document.getElementById('result').textContent = JSON.stringify(reports);
        };
        frame.srcdoc = documents[index];
        document.body.appendChild(frame);
      });`;
    const filename = path.join(directory, 'layout.html');
    fs.writeFileSync(filename, `<!doctype html><meta charset="utf-8"><pre id="result"></pre><script>${script}</script>`);
    const browser = spawnSync(process.env.ORDER_REPORT_CSS_BROWSER, [
      '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--disable-background-networking', `--user-data-dir=${path.join(directory, 'profile')}`,
      '--virtual-time-budget=1500', '--dump-dom', `file://${filename}`,
    ], { encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(browser.status, 0, browser.stderr || String(browser.error));
    const match = browser.stdout.match(/<pre id="result">([^<]+)<\/pre>/);
    assert.ok(match, 'browser did not finish all layout fixtures');
    const reports = JSON.parse(match[1]);
    assert.equal(reports.length, cases.length);
    for (const report of reports) {
      const label = `${report.width}px ${report.legacy ? 'legacy fallback' : 'modern'}`;
      const near = (value, expected, what) => assert.ok(Math.abs(value - expected) < 1, `${label}: ${what}: ${value}, expected ${expected}`);
      near(report.backdrop.x, 0, 'dialog left edge');
      near(report.backdrop.y, 0, 'dialog top edge');
      near(report.backdrop.width, report.viewportWidth, 'dialog width');
      near(report.backdrop.height, 800, 'dialog height');
      near(report.brandGap, report.width <= 620 ? 7 : 10, 'brand spacing');
      near(report.gridGap, report.width <= 620 ? 9 : 14, 'grid spacing');
      near(report.printGap, 9, 'print button spacing');
      assert.ok(report.padding >= 12, `${label}: main padding must survive missing env()`);
      assert.ok(report.toast.x >= 0 && report.toast.right <= report.viewportWidth, `${label}: long toast overflow`);
      assert.equal(report.safeTop, '0px', `${label}: safe area fallback`);
      for (const control of report.controls) {
        assert.ok(control.left >= 0 && control.right <= report.viewportWidth + 1, `${label}: control outside viewport`);
        assert.ok(control.scrollWidth <= control.width + 1, `${label}: clipped short control text`);
      }
      for (const action of report.actions) {
        assert.equal(action.whiteSpace, 'nowrap', `${label}: short action label must stay intact`);
        if (report.width <= 620) assert.equal(action.margin, '0px', `${label}: mobile Grid must not inherit flex margins`);
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
