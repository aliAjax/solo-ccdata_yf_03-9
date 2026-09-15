/* 端到端验证：node test/run.js
 * 1) 重叠/嵌套/相邻片段合并 + 被压制候选清单
 * 2) 相同文本不同含义（跨类型冲突）+ 同值同号/异值不撞号
 * 3) 误标回滚（取消→撤销→重做）
 * 4) 映射恢复原文（含缺映射/多映射报错）
 * 另：哈希链篡改检出、状态指纹外改检出、刷新序列化往返。 */
const assert = require('assert');
const DT = require('../app.js');

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }
async function section(name, fn) { console.log('\n『' + name + '】'); await fn(); }

/* 18 位身份证校验位 */
function id18(prefix17) {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const code = '10X98765432';
  let s = 0;
  for (let i = 0; i < 17; i++) s += +prefix17[i] * w[i];
  return prefix17 + code[s % 11];
}

let state = DT.newState();
async function op(patch, action, detail) {
  const inv = DT.applyOp(state, patch);
  await DT.appendAudit(state, action, Object.assign({ patch: redact(patch) }, detail || {}));
  return inv;
}
/* 审计明细只存定位信息，不抄写大段原文 */
function redact(p) {
  const r = Object.assign({}, p);
  if (r.text) { r.textLen = r.text.length; delete r.text; }
  if (r.marks) { r.markCount = r.marks.length; delete r.marks; }
  if (r.value) { r.valueLen = r.value.length; delete r.value; }
  return r;
}
const activeMap = st => {
  const out = {};
  const res = DT.allResolution(st);
  Object.entries(res).forEach(([docId, r]) => { out[docId] = r.active; });
  return out;
};

(async () => {
  /* ---- 夹具：18 位 Luhn 合法卡号，显示为“6213006-13800138000”，内嵌手机号 13800138000 ---- */
  const idNo = id18('11010519900307123');            // 11010519900307123X
  const phone = '13800138000';
  let card = null;
  for (let n = 6213000; n <= 6213999 && !card; n++) {
    const digits = String(n) + phone;               // 7 位前缀 + 11 位手机 = 18 位
    if (DT.luhnOk(digits)) card = digits.slice(0, 7) + '-' + digits.slice(7);
  }
  assert.ok(card && DT.luhnOk(card.replace(/\D/g, '')), '夹具银行卡应通过 Luhn');
  assert.ok(card.includes(phone), '夹具银行卡应内嵌手机号');
  const otherPhone = '13911112222';
  const email = 'zhang.wei@example.com';
  const addr = '北京市海淀区中关村南大街27号院3号楼1502室';

  /* ---------- 导入两篇 ---------- */
  const raw1 =
`客服来电
喂您好，我的联系号码是${phone}，邮箱${email}。
我住在${addr}，身份证号是${idNo}。
刚才说的银行卡号是${card}，从工资卡里扣。
订单号是901234567890123，别搞错了。`;
  const raw2 =
`回访记录
再确认一下，备用号码还是${phone}对吧？另一个号是${otherPhone}。
对了系统里那个编号${idNo}你再核一下。`;

  const patches = DT.importPatches(DT.splitTranscripts(raw1 + '\n\n' + raw2));
  assert.strictEqual(patches.length, 2, '空行分隔出两条转写稿');
  ok('块首行作为文稿名（客服来电/回访记录）', patches[0].name === '客服来电' && patches[1].name === '回访记录');
  for (const p of patches) await op(p, 'import', { name: p.name, auto: p.marks.length });

  /* ================= 场景 1：重叠 / 嵌套 / 相邻 ================= */
  await section('场景1 重叠·嵌套·相邻合并', () => {
    const d0 = state.docs[0];
    const res0 = DT.docResolution(state, d0.id);
    const types = res0.active.map(m => m.type);
    ok('自动检出五类（手机/邮箱/地址/证件/银行卡）',
      ['phone', 'email', 'address', 'idcard', 'bankcard'].every(t => types.includes(t)));

    // 银行卡内含手机号 → 嵌套，银行卡（优先级更高）胜出
    const bank = res0.active.find(m => m.type === 'bankcard');
    const nested = res0.suppressed.find(s => s.type === 'phone' && s.reason === 'nested');
    ok('手机号嵌套于银行卡中被压制', !!nested);
    ok('压制记录指向胜出银行卡', nested.winnerType === 'bankcard');
    ok('胜出片段为并集（整段带分隔符卡号）', bank.value === card);
    ok('压制原因文案正确', DT.REASON_TEXT[nested.reason].includes('嵌套'));

    // 纯函数构造：部分重叠（非包含）→ overlap
    const r = DT.resolveMarks([
      { id: 'x1', docId: 'd', type: 'idcard', start: 0, end: 10, value: '0123456789', origin: 'auto', status: 'active' },
      { id: 'x2', docId: 'd', type: 'bankcard', start: 5, end: 15, value: '5678901234', origin: 'auto', status: 'active' },
    ], '012345678901234');
    ok('部分重叠：证件号优先级高于银行卡', r.active.length === 1 && r.active[0].id === 'x1');
    ok('部分重叠判为 overlap（不误判为嵌套），并集为 [0,15)',
      r.suppressed[0].reason === 'overlap' && r.active[0].start === 0 && r.active[0].end === 15);

    // 同类型严格相邻 → adjacent-same
    const r2 = DT.resolveMarks([
      { id: 'p1', docId: 'd', type: 'phone', start: 0, end: 11, value: phone, origin: 'auto', status: 'active' },
      { id: 'p2', docId: 'd', type: 'phone', start: 11, end: 22, value: otherPhone, origin: 'auto', status: 'active' },
    ], phone + otherPhone);
    ok('同类型相邻合并为一条', r2.active.length === 1 && r2.suppressed[0].reason === 'adjacent-same');

    ok('间隔一个字符不算相邻', DT.overlapOrAdjacent({ start: 0, end: 11 }, { start: 12, end: 23 }) === false);
    ok('地址吃到连续门牌后缀（…号院…号楼…室）', res0.active.some(m => m.type === 'address' && m.value === addr));
  });

  /* ================= 场景 2：相同文本不同含义 + 代号规则 ================= */
  await section('场景2 同值同号·异值不撞号·跨类型冲突', async () => {
    // 无冲突基线：同手机号跨文稿同号，异号不同号
    let plan = DT.planCodes(state.registry, state.docs, activeMap(state));
    const p001Marks = Object.entries(plan.assignment).filter(([, c]) => c === 'P001').length;
    ok('同一原始值跨文稿使用同一代号（P001 命中两篇文稿）', p001Marks === 2);
    // 不同 (类型,规范化值) 必须拿到不同代号：建立 value→code 映射检查双射
    const valToCode = {}, codeToVal = {};
    let bijection = true;
    Object.entries(DT.allResolution(state)).forEach(([docId, r]) => {
      const text = state.docs.find(d => d.id === docId).text;
      r.active.forEach(m => {
        const norm = DT.normalizeValue(m.type, m.value);
        const code = plan.assignment[m.id];
        const vk = m.type + '|' + norm;
        if (valToCode[vk] && valToCode[vk] !== code) bijection = false;
        if (codeToVal[code] && codeToVal[code] !== vk) bijection = false;
        valToCode[vk] = code; codeToVal[code] = vk;
        void text;
      });
    });
    ok('不同原始值不能撞号（值↔代号为双射）', bijection);
    ok('代号格式为 类型前缀+3 位序号', Object.values(plan.assignment).every(c => /^[PMIBA]\d{3}$/.test(c)));
    ok('基线无冲突', plan.conflicts.length === 0);

    // 文稿2中同一 18 位串：自动判证件，人工再补标银行卡且重叠 → 高优先级证件胜出，人工标进压制清单
    const d1 = state.docs[1];
    const idx = d1.text.indexOf(idNo);
    const manualId = DT.uid('m_');
    await op({ op: 'addMark', id: manualId, docId: d1.id, type: 'bankcard', start: idx, end: idx + idNo.length, value: idNo, origin: 'manual' }, 'add-mark');
    const supManual = DT.docResolution(state, d1.id).suppressed
      .find(s => s.type === 'bankcard' && s.origin === 'manual' && s.winnerType === 'idcard');
    ok('同段文字的人工补标被更高优先级类型压制（证件>银行卡），记录可查', !!supManual);

    // 真冲突：审校误把文稿2该串改判为银行卡（取消自动证件），而文稿1仍为证件 → 同值跨类型
    const autoId2 = state.marks.find(m => m.docId === d1.id && m.type === 'idcard' && m.value === idNo);
    const dim = await op({ op: 'setStatus', id: autoId2.id, status: 'dismissed' }, 'dismiss-mark');
    const res2 = DT.allResolution(state);
    plan = DT.planCodes(state.registry, state.docs, activeMap(state));
    ok('相同原文跨文稿含义不同 → 检出冲突并列出类型/代号/涉及标记',
      plan.conflicts.length === 1 &&
      plan.conflicts[0].types.slice().sort().join(',') === 'bankcard,idcard' &&
      plan.conflicts[0].markIds.length === 2);
    const unresolved = new Set(plan.conflicts.flatMap(c => c.markIds));
    const built = DT.buildMasked(state.docs, activeMap(state), plan.assignment, unresolved);
    ok('冲突未决 → 冲突片段在两篇文稿均保持原文（绝不静默写错代号）',
      built[d1.id].masked.includes(idNo) && built[state.docs[0].id].masked.includes(idNo));

    // 撤销误取消（恢复证件判定）并移除人工银行卡 → 冲突解除
    await op(dim, 'undo', { undoes: 'dismiss-mark' });
    const rmInv = await op({ op: 'removeMark', id: manualId }, 'remove-mark');
    const planClean = DT.planCodes(state.registry, state.docs, activeMap(state));
    ok('撤销改判并移除误补标后冲突解除', planClean.conflicts.length === 0);

    // 再来一次：重做删除人工标不应让冲突复活
    const redoRm = await op(rmInv, 'undo', { undoes: 'remove-mark' }); // 撤销删除=人工标回来且证件在 → 仍被压制
    ok('人工标回来但证件在位 → 胜出集合无冲突', DT.planCodes(state.registry, state.docs, activeMap(state)).conflicts.length === 0);
    await op(redoRm, 'redo', { redoes: 'remove-mark' });
  });

  /* ================= 场景 3：误标取消 + 撤销/重做 ================= */
  await section('场景3 误标取消·撤销·重做', async () => {
    const d0 = state.docs[0];
    const falseMark = state.marks.find(m => m.docId === d0.id && m.type === 'idcard' && m.weak);
    ok('弱证件规则对 15 位订单号产生误报候选', !!falseMark && falseMark.value === '901234567890123');
    const before = DT.docResolution(state, d0.id).active.length;
    const inv1 = await op({ op: 'setStatus', id: falseMark.id, status: 'dismissed' }, 'dismiss-mark');
    ok('取消误标后该片段退出胜出集合',
      DT.docResolution(state, d0.id).active.every(m => m.id !== falseMark.id) &&
      DT.docResolution(state, d0.id).active.length === before - 1);
    const inv2 = await op(inv1, 'undo', { undoes: 'dismiss-mark' });
    ok('撤销后误标候选恢复', state.marks.find(m => m.id === falseMark.id).status === 'active');
    await op(inv2, 'redo', { redoes: 'dismiss-mark' });
    ok('重做后再次取消', state.marks.find(m => m.id === falseMark.id).status === 'dismissed');

    // 边界调整回滚
    const addrMark = state.marks.find(m => m.type === 'address');
    const full = addrMark.value;
    const resizeInv = await op({
      op: 'resize', id: addrMark.id, start: addrMark.start, end: addrMark.end - 3,
      value: state.docs[0].text.slice(addrMark.start, addrMark.end - 3),
    }, 'resize');
    ok('边界调整生效（截掉“150”后）', DT.docResolution(state, d0.id).active.find(m => m.id === addrMark.id).value === full.slice(0, -3));
    await op(resizeInv, 'undo', { undoes: 'resize' });
    ok('边界调整可撤销还原', DT.docResolution(state, d0.id).active.find(m => m.id === addrMark.id).value === full);
  });

  /* ================= 确认 + 场景 4：脱敏与映射恢复 ================= */
  const resFinal = DT.allResolution(state);
  const plan = DT.planCodes(state.registry, state.docs, activeMap(state));
  assert.strictEqual(plan.conflicts.length, 0, '确认前须无未决冲突');
  DT.commitCodes(state.registry, plan.planRegistry);
  state.confirmed = true;
  await DT.appendAudit(state, 'confirm', { docCount: state.docs.length, codeCount: Object.keys(state.registry.keys).length });

  let exported;
  await section('场景4 预览脱敏稿与映射恢复', () => {
    exported = DT.mappingExport(state.docs, activeMap(state), plan.assignment);
    const m1 = exported.docs[0].masked;
    ok('手机号替换为代号 P001 且原文消失', m1.includes('〔P001〕') && !m1.includes(phone));
    ok('身份证/银行卡/地址/邮箱分别替换为 I/B/A/M 代号',
      m1.includes('〔I001〕') && m1.includes('〔B001〕') && m1.includes('〔A001〕') && m1.includes('〔M001〕'));
    ok('同手机号在文稿2仍为 P001', exported.docs[1].masked.includes('〔P001〕'));

    let allRecovered = true;
    for (const d of exported.docs) {
      if (DT.recoverDoc(d.masked, d.occurrences) !== state.docs.find(x => x.name === d.name).text) allRecovered = false;
    }
    ok('逐文稿用映射清单恢复，与原文逐字一致', allRecovered);

    assert.throws(() => DT.recoverDoc('〔P001〕', []), /缺少映射/);
    ok('缺映射条目 → 拒绝恢复并报错', true);
    assert.throws(() => DT.recoverDoc('无代号文本', [{ code: 'P001', original: 'x' }]), /多余映射/);
    ok('多余映射条目 → 拒绝恢复并报错', true);

    const codes = exported.codes.map(c => c.code);
    ok('代号全局唯一不撞号', new Set(codes).size === codes.length);
    ok('映射按代号归集且记录每处出处（P001 出现 2 次）',
      exported.codes.find(c => c.code === 'P001').occurrences.length === 2);
  });

  /* ================= 审计：校验、刷新往返、篡改检出 ================= */
  await section('审计链 校验·刷新·篡改检出', async () => {
    let v = await DT.verifyAudit(state);
    ok('当前审计链校验通过（' + state.audit.length + ' 条）', v.ok);

    const reloaded = JSON.parse(JSON.stringify(state));
    v = await DT.verifyAudit(reloaded);
    ok('刷新后序列化往返，审计链仍通过', v.ok);
    const reMap = activeMap(reloaded);
    const rePlan = DT.planCodes(reloaded.registry, reloaded.docs, reMap);
    const reExport = DT.mappingExport(reloaded.docs, reMap, rePlan.assignment);
    let round = true;
    for (const d of reExport.docs) {
      if (DT.recoverDoc(d.masked, d.occurrences) !== reloaded.docs.find(x => x.name === d.name).text) round = false;
    }
    ok('刷新后映射恢复依然逐字一致', round);

    let t = JSON.parse(JSON.stringify(state));
    t.audit[2].action = 'hacked';
    v = await DT.verifyAudit(t);
    ok('改动历史审计记录内容 → 被发现', !v.ok && v.problems.some(p => p.includes('记录内容被改动')));

    t = JSON.parse(JSON.stringify(state));
    t.audit.splice(2, 1);
    v = await DT.verifyAudit(t);
    ok('删除一条审计记录 → 断链被发现', !v.ok && v.problems.some(p => p.includes('断链')));

    t = JSON.parse(JSON.stringify(state));
    t.docs[0].text = t.docs[0].text.replace(phone, otherPhone);
    v = await DT.verifyAudit(t);
    ok('审计之外偷改文稿原文 → 状态指纹不符被发现', !v.ok && v.problems.some(p => p.includes('状态指纹')));

    t = JSON.parse(JSON.stringify(state));
    t.marks[0].start += 1;
    v = await DT.verifyAudit(t);
    ok('审计之外偷改标记边界 → 被发现', !v.ok);

    // 合规追加导入
    t = JSON.parse(JSON.stringify(state));
    const np = DT.importPatches(DT.splitTranscripts('补充稿\n新号码是13700001111。'))[0];
    DT.applyOp(t, np);
    await DT.appendAudit(t, 'import', { name: np.name });
    v = await DT.verifyAudit(t);
    ok('合规追加导入并写审计 → 链仍通过', v.ok && t.docs.length === 3);
    t.docs[2].name = '偷偷改名';
    v = await DT.verifyAudit(t);
    ok('导入后无记录地改动 → 仍被指纹捕获', !v.ok);

    // 篡改映射清单 → 恢复结果必然与原文不符；删掉一条则恢复直接报错
    const bad = JSON.parse(JSON.stringify(exported));
    bad.docs[0].occurrences[0].original = '11111111111';
    const rec = DT.recoverDoc(bad.docs[0].masked, bad.docs[0].occurrences);
    ok('映射清单被改 → 恢复结果与原文不一致（恢复即校验）', rec !== state.docs[0].text);
    const missing = JSON.parse(JSON.stringify(exported));
    missing.docs[0].occurrences.shift();
    assert.throws(() => DT.recoverDoc(missing.docs[0].masked, missing.docs[0].occurrences), /缺少映射|多余映射/);
    ok('映射清单缺失 → 恢复被拒绝', true);
  });

  console.log('\n全部通过：' + pass + ' 项断言。');
})().catch(e => { console.error('\n✗ 验证失败：', e); process.exit(1); });
