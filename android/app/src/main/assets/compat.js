/* Keep this startup guard ES5-readable even if the application cannot parse. */
(function () {
  'use strict';
  var ready = false;
  var failed = false;

  function showFailure() {
    if (ready || failed) return;
    failed = true;
    var main = document.getElementById('main-content');
    if (!main) return;
    // Never clear or rewrite localStorage here: an engine/loading error is not
    // evidence that saved business data is corrupt.
    main.innerHTML = '';
    var panel = document.createElement('section');
    panel.className = 'panel';
    panel.style.cssText = 'padding:24px;max-width:640px;margin:24px auto;line-height:1.7;overflow-wrap:break-word';
    var title = document.createElement('h1');
    title.textContent = '页面暂时无法启动';
    var explanation = document.createElement('p');
    explanation.textContent = '本机已保存的数据未被清除。请先重试；若仍无法打开，请检查 Android System WebView 是否启用并更新，或将系统版本和下面的内核信息发给维护人员。请勿清除应用数据或卸载应用。';
    var details = document.createElement('p');
    details.style.cssText = 'font-size:12px;word-break:break-all';
    details.textContent = '内核信息：' + (navigator.userAgent || '无法读取');
    var retry = document.createElement('button');
    retry.className = 'button';
    retry.type = 'button';
    retry.textContent = '重新打开';
    retry.onclick = function () { window.location.reload(); };
    panel.appendChild(title);
    panel.appendChild(explanation);
    panel.appendChild(details);
    panel.appendChild(retry);
    main.appendChild(panel);
  }

  function onStartupError(event) {
    if (!event.target || event.target === window || event.target.tagName === 'SCRIPT') showFailure();
  }

  window.OrderReportBoot = {
    ready: function () {
      ready = true;
      window.removeEventListener('error', onStartupError, true);
      window.removeEventListener('load', showFailure);
    }
  };
  window.addEventListener('error', onStartupError, true);
  window.addEventListener('load', showFailure);

  // CSS.supports('gap', ...) cannot distinguish grid gap from flex gap.
  var probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;display:flex;flex-direction:column;row-gap:1px;visibility:hidden';
  probe.appendChild(document.createElement('div'));
  probe.appendChild(document.createElement('div'));
  document.body.appendChild(probe);
  if (probe.scrollHeight !== 1) document.documentElement.classList.add('no-flex-gap');
  document.body.removeChild(probe);
})();
