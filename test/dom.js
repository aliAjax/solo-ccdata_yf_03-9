/* 界面冒烟：用 jsdom 真实加载 index.html + app.js，点击完整流程。
 * node test/dom.js （依赖：/tmp/domtest 下的 jsdom） */
const path = require('path');
const fs = require('fs');
const nodeCrypto = require('crypto');
const { JSDOM } = require('/tmp/domtest/node_modules/jsdom');

let pass = 0;
const ok = (n, c) => { if (!c) throw new Error('界面断言失败：' + n); console.log('  ✓ ' + n); pass++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeDom() {
  // jsdom 对 file+http 混合 URL 的外部脚本解析不稳，测试中将 app.js 内联进 HTML
  const root = path.join(__dirname, '..');
  let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const appjs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  html = html.replace(/<script src="app\.js"><\/script>/, '<script>\n' + appjs + '\n</script>');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(window) {
      if (!window.crypto) window.crypto = nodeCrypto.webcrypto;
      else if (!window.crypto.subtle) window.crypto.subtle = nodeCrypto.webcrypto.subtle;
    },
  });
  return dom;
}

(async () => {
  try {
    const dom = makeDom();
    const { window } = dom;
    const { document } = window;
    if (!window.crypto || !window.crypto.subtle) throw new Error('crypto.subtle 不可用');
    window.addEventListener('error', e => { throw new Error('页面脚本错误: ' + e.message); });
    const $ = s => document.querySelector(s);
    await sleep(150); // 等外部 app.js 加载与 init

    /* 1. 初始空态 */
    ok('初始为导入空态', $('#workspace').style.display === 'none');

    /* 2. 示例 → 导入 */
    $('#btnSample').click();
    ok('示例填入', $('#importText').value.includes('13800138000'));
    $('#btnImport').click();
    await sleep(80);
    ok('导入两篇文稿', document.querySelectorAll('.docitem').length === 2);
    const mk = () => document.querySelectorAll('#transcript .mk');
    const types = [...mk()].map(e => ['phone', 'email', 'idcard', 'bankcard', 'address'].find(t => e.classList.contains(t)));
    ok('五类全部高亮', ['phone', 'email', 'idcard', 'bankcard', 'address'].every(t => types.includes(t)));
    ok('高亮带候选代号标签', [...document.querySelectorAll('#transcript .code-tag')].some(e => /^[PMIBA]\d{3}$/.test(e.textContent)));

    /* 3. 压制候选：嵌套手机/相邻合并等 */
    const sup = document.querySelectorAll('#suppressedList .crow');
    ok('被压制候选已列出且有原因', sup.length >= 1 && /嵌套|重叠|相邻/.test($('#suppressedList').textContent));

    /* 4. 代号表：同邮箱大小写规范化后同号（示例二篇大写邮箱） */
    const codeTable = $('#codeTable').textContent;
    ok('代号表渲染', /P001/.test(codeTable) && /M001/.test(codeTable));

    /* 5. 取消 15 位订单号误标 → 撤销 → 重做 */
    const before = mk().length;
    const falseEl = [...document.querySelectorAll('#transcript .mk.idcard')]
      .find(el => el.textContent.replace(/^I\d{3}/, '') === '901234567890123');
    ok('定位到误报订单号', !!falseEl);
    falseEl.click();
    await sleep(20);
    ok('选中后出现编辑器', $('#edDismiss'));
    $('#edDismiss').click();
    await sleep(60);
    ok('取消误标后高亮减少', mk().length === before - 1);
    ok('进入“已取消（误标）”列表', /901234567890123/.test($('#dismissedList').textContent));
    $('#btnUndo').click();
    await sleep(60);
    ok('撤销恢复误标', mk().length === before);
    $('#btnRedo').click();
    await sleep(60);
    ok('重做再次取消', mk().length === before - 1);

    /* 6. 审计徽标完整 */
    ok('审计链徽标显示完整', /审计链完整/.test($('#integrity').textContent));

    /* 7. 确认 → 预览 → 映射自检 */
    $('#btnConfirm').click();
    await sleep(80);
    ok('确认后出现预览', $('#preview').style.display === 'block');
    ok('映射自检通过', /映射自检通过/.test($('#preview').textContent));
    ok('预览稿含代号且敏感原文被替换',
      /〔[PMIBA]\d{3}〕/.test($('.preview-doc').textContent) &&
      !$('.preview-doc').textContent.includes('zhang.wei@example.com'));

    /* 8. 导出按钮存在；localStorage 已持久化 */
    ok('三类导出按钮就位', $('#exMasked') && $('#exMap') && $('#exAudit2'));
    const saved = window.localStorage.getItem('desensitize_console_v1');
    ok('状态已写入 localStorage', !!saved);

    /* 9. 刷新往返：用保存的数据重新跑核心校验（等价页面 init 校验） */
    const DT = require('../app.js');
    const parsed = JSON.parse(saved).state;
    let v = await DT.verifyAudit(parsed);
    ok('刷新数据审计链校验通过', v.ok);
    // 恢复自检：导出清单可逐字还原
    const res = DT.allResolution(parsed);
    const map = {}; Object.entries(res).forEach(([id, r]) => { map[id] = r.active; });
    const pc = DT.planCodes(parsed.registry, parsed.docs, map);
    const built = DT.buildMasked(parsed.docs, map, pc.assignment);
    let round = true;
    parsed.docs.forEach(d => { if (DT.recoverDoc(built[d.id].masked, built[d.id].occurrences) !== d.text) round = false; });
    ok('刷新后映射恢复逐字一致', round);

    /* 10. 篡改刷新数据 → init 校验必报异常 */
    parsed.docs[0].text = parsed.docs[0].text.replace('13800138000', '13900000000');
    v = await DT.verifyAudit(parsed);
    ok('篡改数据后状态指纹校验失败', !v.ok && v.problems.some(p => p.includes('状态指纹')));

    /* 11. 冲突横幅：改判第二篇同号串为银行卡并取消证件 → 确认按钮禁用 */
    // 重新载入干净页面做冲突流
    const dom2 = makeDom();
    await sleep(120);
    const w2 = dom2.window, d2 = w2.document;
    d2.querySelector('#btnSample').click();
    d2.querySelector('#btnImport').click();
    await sleep(80);
    // 切到第二篇
    [...d2.querySelectorAll('.docitem')][1].click();
    await sleep(20);
    // 点第二篇证件高亮，改判为银行卡
    const idEl = [...d2.querySelectorAll('#transcript .mk.idcard')][0];
    idEl.click();
    await sleep(20);
    d2.querySelector('#edType').value = 'bankcard';
    d2.querySelector('#edType').dispatchEvent(new w2.Event('change', { bubbles: true }));
    await sleep(60);
    // 第二篇同号串改判为银行卡，而第一篇仍为证件 → 立即构成同值跨类型冲突
    ok('含义冲突时确认按钮被禁用', d2.querySelector('#btnConfirm').disabled === true);
    ok('冲突横幅显示并列出涉及类型', /冲突/.test(d2.querySelector('#bannerConflict').textContent) &&
      /银行卡/.test(d2.querySelector('#bannerConflict').textContent) &&
      /证件号/.test(d2.querySelector('#bannerConflict').textContent));
    ok('文稿列表出现冲突标记', [...d2.querySelectorAll('.docitem')].some(el => /冲突/.test(el.textContent)));
    // 撤销改判 → 冲突解除、可确认
    d2.querySelector('#btnUndo').click();
    await sleep(60);
    ok('撤销改判后冲突解除', d2.querySelector('#btnConfirm').disabled === false &&
      d2.querySelector('#bannerConflict').textContent.trim() === '');

    console.log('\n界面冒烟全部通过：' + pass + ' 项。');
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
