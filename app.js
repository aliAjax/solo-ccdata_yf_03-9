/* 声纹脱敏审校台 —— 纯前端核心逻辑（无后端、无第三方依赖）
 * 检测 → 固定优先级合并 → 代号登记 → 脱敏/恢复 → 哈希链审计
 * UMD：浏览器挂 window.DT，Node 下 module.exports。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 类型与固定优先级（序号小者优先；顺序即规则，不随检测来源改变） ---------- */
  const TYPES = ['idcard', 'bankcard', 'phone', 'email', 'address'];
  const META = {
    phone:    { label: '手机号', prefix: 'P', color: '#16866d' },
    email:    { label: '邮箱',   prefix: 'M', color: '#2f6fed' },
    idcard:   { label: '证件号', prefix: 'I', color: '#8a4fff' },
    bankcard: { label: '银行卡', prefix: 'B', color: '#d97b17' },
    address:  { label: '地址',   prefix: 'A', color: '#c2418a' },
  };
  const priority = t => TYPES.indexOf(t); // 0 最高
  const REASON_TEXT = {
    nested: '嵌套：高优先级命中覆盖',
    overlap: '重叠：按固定优先级取舍',
    adjacent: '相邻：按固定优先级取舍',
    'adjacent-same': '同类型相邻：合并为一个片段',
  };

  /* ---------- 基础工具 ---------- */
  function luhnOk(num) {
    if (!/^\d{13,19}$/.test(num)) return false;
    let sum = 0;
    for (let i = 0; i < num.length; i++) {
      let d = num.charCodeAt(num.length - 1 - i) - 48;
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return sum % 10 === 0;
  }
  /* 生成一位 Luhn 校验位（测试与补位使用） */
  function luhnCheckDigit(prefix) {
    const num = prefix + '0';
    let sum = 0;
    for (let i = 0; i < num.length; i++) {
      let d = num.charCodeAt(num.length - 1 - i) - 48;
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    return String((10 - sum % 10) % 10);
  }

  /* 规范化：同一原始值的不同书写形式共用代号（如 4111 1111 与 4111-1111） */
  function normalizeValue(type, raw) {
    const v = String(raw).trim();
    if (type === 'phone') {
      let d = v.replace(/[^\d]/g, '');
      if (/^86(1\d{10})$/.test(d)) d = d.slice(2);
      return d;
    }
    if (type === 'email') return v.toLowerCase();
    if (type === 'idcard' || type === 'bankcard') return v.replace(/[\s-]/g, '').toUpperCase();
    return v.replace(/\s+/g, ''); // address：忽略排版空白差异
  }

  /* ================= 1. 自动检测 ================= */
  const RE = {
    phone: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g,
    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    id18: /(?<![\dXx])\d{17}[\dXx](?![\dXx])/g,
    id15: /(?<!\d)\d{15}(?!\d)/g,
    bank: /(?<![\dXx])(\d[\d -]{11,22}\d)(?![\dXx])/g,
  };

  /* 地址扫描：省/市/区(县) 开头，或 路/街/巷/号/楼/室 等门牌后缀收尾的中文片段。
   * 行政通名前允许有一个“在/到/住”等领头字，扫描时把它从起点裁掉。 */
  const ADDR_HEAD = /(?<=^|[，。！？：；、,.!?;: \n住到去往从在是叫有把给约见说聊谈我你他她它们的和与及])(?:北京市|天津市|上海市|重庆市|[一-龥]{2,8}?(?:省|自治区|特别行政区)|[一-龥]{2,10}?市|[一-龥]{2,8}?(?:区|县|旗))/g;
  const ADDR_TAILS = ['号院', '号楼', '号', '室', '单元', '楼层', '楼', '巷', '大街', '大道', '街', '路', '村', '组', '小区', '大厦', '园区'];
  const ADDR_STOP = '，。！？；：、,.!?;\n';
  function scanAddress(text) {
    const raw = [];
    const push = (s, e) => {
      if (e - s < 4) return;
      if (!raw.some(a => a[0] === s && a[1] === e)) raw.push([s, e]);
    };
    /* 从行政区划起向后延伸，记录“最后一个门牌后缀”的结束位置（连续 号院/号楼/室 都吃进来） */
    for (const m of text.matchAll(ADDR_HEAD)) {
      // 非贪婪分支可能把“他在上海市”整段吃入，从最后一个边界字之后才是真正的区划起点
      let s = m.index;
      const lead = '住到去往从在是叫有把给约见说聊谈我你他她它';
      for (let k = 0; k < m[0].length; k++) if (lead.includes(m[0][k])) s = m.index + k + 1;
      let i = m.index + m[0].length, lastTailEnd = -1, guard = 0;
      while (i < text.length && i - s < 60 && guard++ < 90) {
        const c = text[i];
        if (ADDR_STOP.includes(c)) break;
        let hit = null;
        for (const t of ADDR_TAILS) if (text.startsWith(t, i)) { hit = t; break; }
        if (hit) { lastTailEnd = i + hit.length; i += hit.length; continue; }
        i++;
      }
      if (lastTailEnd > 0) push(s, lastTailEnd);
    }
    /* 无行政区划时：以道路/小区通名（路/街/巷/道/村/小区/大厦/园区…）定位，
     * 向前收路名（汉字，遇标点/动词/数字停），向后吃“数字+号院/号楼/室/单元…”门牌。 */
    const ROADS = ['小区', '大厦', '园区', '大街', '大道', '路', '街', '巷', '道', '村'];
    const LEAD = '住到去往从在是叫有把给约见说聊谈我你他她它，。！？：；、,.!?;: \n';
    const DIV = '省市区县旗州'; // 路名反收遇行政区划通名即停
    for (let i = 0; i < text.length; i++) {
      const road = ROADS.find(w => text.startsWith(w, i));
      if (!road || i + road.length > 60) continue;
      let s = i;
      while (s > 0) {
        const c = text[s - 1];
        if (!/[一-龥]/.test(c) || LEAD.includes(c) || DIV.includes(c)) break;
        s--;
      }
      if (i + road.length - s < 2) continue; // 路名至少一个字
      let e = i + road.length;
      // 连续门牌：可选“数字号/号院/号楼/单元/楼层/数字室”
      const m = text.slice(e).match(/^[0-9A-Za-z一二三四五六七八九十百]*(?:号院|号|号楼|栋|幢|座)?(?:[0-9A-Za-z一二三四五六七八九十百]*(?:号楼|单元|楼层|楼|室))?/);
      let tail = m ? m[0] : '';
      // “村/巷/道/街”等单独出现时必须带门牌号才算地址，避免“中关村/农村”类误报
      const needsNum = (road === '村' || road === '巷' || road === '组');
      if (needsNum && !/\d/.test(tail)) continue;
      if (/(号|楼|室|栋|幢|座|单元)/.test(tail)) e += tail.length;
      if (e - s >= 4) push(s, e);
    }
    /* 合并重叠/嵌套候选：省+市+区多级命中或头尾扫描重复时，每簇归一为最大跨度 */
    raw.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]));
    const out = [];
    for (const [s, e] of raw) {
      if (out.some(a => s >= a[0] && e <= a[1])) continue;
      const oi = out.findIndex(a => s < a[1] && a[0] < e);
      if (oi >= 0) out[oi] = [Math.min(s, out[oi][0]), Math.max(e, out[oi][1])];
      else out.push([s, e]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  function detectCandidates(docId, text) {
    const cands = [];
    const add = (type, start, end, extra) => {
      const raw = text.slice(start, end);
      if (!raw) return;
      cands.push(Object.assign({
        id: 'c_' + docId + '_' + cands.length, docId, type, start, end,
        value: raw, origin: 'auto', status: 'active',
      }, extra || {}));
    };
    for (const m of text.matchAll(RE.phone)) add('phone', m.index, m.index + m[0].length);
    for (const m of text.matchAll(RE.email)) add('email', m.index, m.index + m[0].length);
    for (const m of text.matchAll(RE.id18)) add('idcard', m.index, m.index + m[0].length);
    for (const m of text.matchAll(RE.id15)) add('idcard', m.index, m.index + m[0].length, { weak: true });
    for (const m of text.matchAll(RE.bank)) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits))
        add('bankcard', m.index, m.index + m[0].length, { luhn: true });
    }
    for (const [s, e] of scanAddress(text)) add('address', s, e);
    return cands;
  }

  /* ================= 2. 合并：重叠 / 嵌套 / 相邻 → 固定优先级 ================= */
  function overlapOrAdjacent(a, b) {
    return (a.start < b.end && b.start < a.end)   // 重叠或嵌套
        || a.end === b.start || b.end === a.start; // 严格相邻（间隔 0）
  }
  function winnerKey(m) {
    return [
      priority(m.type),                 // ① 固定类型优先级（越小越优先）
      m.origin === 'manual' ? 0 : 1,    // ② 同优先级时人工补标优先
      -(m.end - m.start),               // ③ 更长者优先
      m.start,                          // ④ 位置靠前者优先（确定性兜底）
      m.id,                             // ⑤ 最终兜底，保证可复现
    ];
  }
  function lessWinner(a, b) {
    const ka = winnerKey(a), kb = winnerKey(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i];
    return false;
  }

  /* 对一篇文稿的候选做聚类裁决。
   * 入参 text 用于把合并后 span 的原文统一为并集文本。
   * 返回 { active: 胜出标记, suppressed: 被压制候选（含原因与胜出者） } */
  function resolveMarks(marks, text) {
    const live = marks.filter(m => m.status !== 'dismissed');
    const used = new Array(live.length).fill(false);
    const active = [], suppressed = [];
    for (let i = 0; i < live.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const group = [live[i]];
      let grow = true;
      while (grow) { // 传递闭包：相邻串成的整条链同属一个裁决簇
        grow = false;
        for (let j = 0; j < live.length; j++) {
          if (used[j]) continue;
          if (group.some(g => overlapOrAdjacent(g, live[j]))) { used[j] = true; group.push(live[j]); grow = true; }
        }
      }
      let winner = group[0];
      for (const g of group) if (lessWinner(winner, g)) winner = g;
      const s = Math.min(...group.map(g => g.start));
      const e = Math.max(...group.map(g => g.end));
      active.push(Object.assign({}, winner, { start: s, end: e, value: text ? text.slice(s, e) : winner.value }));
      for (const g of group) {
        if (g.id === winner.id) continue;
        let reason;
        // 相对胜出者的原始跨度判定几何关系（不能用并集，否则重叠会被误判为嵌套）
        if (g.start >= winner.start && g.end <= winner.end) reason = 'nested';     // 被胜出者包含：嵌套
        else if (g.start < winner.end && winner.start < g.end) reason = 'overlap'; // 部分相交：重叠
        else if (g.type === winner.type) reason = 'adjacent-same';                 // 同类型相邻：合并
        else reason = 'adjacent';                                                  // 跨类型相邻：按优先级取舍
        suppressed.push({
          id: g.id, type: g.type, origin: g.origin, start: g.start, end: g.end, value: g.value,
          winnerId: winner.id, winnerType: winner.type, winnerStart: s, winnerEnd: e, reason,
        });
      }
    }
    active.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    suppressed.sort((a, b) => a.start - b.start);
    return { active, suppressed };
  }

  /* ================= 3. 代号登记：同原始值同代号，不同原始值不撞号 ================= */
  function newRegistry() { return { keys: {}, counters: { P: 0, M: 0, I: 0, B: 0, A: 0 } }; }

  /* 预演：不改动登记本。返回 assignment(markId→code) 与同值异类型冲突清单。
   * 当前标记不再引用的旧登记键先剔除（代号计数器只增不减，旧号永不复用、绝不撞号）。 */
  function planCodes(registry, docs, activeByDoc) {
    const reg = JSON.parse(JSON.stringify(registry));
    const ordered = [];
    docs.forEach(d => {
      (activeByDoc[d.id] || []).slice()
        .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || priority(a.type) - priority(b.type))
        .forEach(m => ordered.push(m));
    });
    const liveKeys = new Set(ordered.map(m => m.type + '|' + normalizeValue(m.type, m.value)));
    Object.keys(reg.keys).forEach(k => { if (!liveKeys.has(k)) delete reg.keys[k]; });

    const assignment = {};
    for (const m of ordered) {
      const norm = normalizeValue(m.type, m.value);
      const k = m.type + '|' + norm;
      if (!reg.keys[k]) {
        const prefix = META[m.type].prefix;
        reg.keys[k] = { code: prefix + String(++reg.counters[prefix]).padStart(3, '0'), type: m.type, norm };
      }
      assignment[m.id] = reg.keys[k].code;
    }
    /* 同规范化值却出现多个类型 → 含义冲突，须人工解决后才能确认 */
    const normInfo = {};
    const markIdsByNorm = {};
    Object.values(reg.keys).forEach(v => {
      (normInfo[v.norm] = normInfo[v.norm] || { types: new Set(), codes: new Set() }).types.add(v.type);
      normInfo[v.norm].codes.add(v.code);
    });
    ordered.forEach(m => {
      const norm = normalizeValue(m.type, m.value);
      (markIdsByNorm[norm] = markIdsByNorm[norm] || []).push(m.id);
    });
    const conflicts = Object.entries(normInfo)
      .filter(([, v]) => v.types.size > 1)
      .map(([norm, v]) => ({ norm, types: [...v.types], codes: [...v.codes], markIds: markIdsByNorm[norm] || [] }));
    return { planRegistry: reg, assignment, conflicts };
  }
  function commitCodes(registry, planRegistry) {
    registry.keys = planRegistry.keys;
    registry.counters = planRegistry.counters;
  }

  /* ================= 4. 脱敏与映射恢复 ================= */
  const TOKEN = code => '〔' + code + '〕';
  const TOKEN_RE = /〔([PMIBA]\d{3})〕/g;

  /* masked: 脱敏稿；occurrences: 每处代号的出现队列（恢复按文稿内顺序严格回填） */
  function buildMasked(docs, activeByDoc, assignment, unresolvedIds) {
    const skip = new Set(unresolvedIds || []);
    const result = {};
    docs.forEach(d => {
      const marks = (activeByDoc[d.id] || []).slice().sort((a, b) => a.start - b.start);
      let out = '', last = 0;
      const occurrences = [];
      marks.forEach(m => {
        const code = assignment[m.id];
        if (!code || skip.has(m.id) || m.start < last) return; // 冲突未决不进脱敏稿
        out += d.text.slice(last, m.start) + TOKEN(code);
        occurrences.push({ code, type: m.type, original: d.text.slice(m.start, m.end) });
        last = m.end;
      });
      out += d.text.slice(last);
      result[d.id] = { masked: out, occurrences };
    });
    return result;
  }

  /* 用映射清单恢复原文：逐文稿按出现顺序回填；缺映射/多映射都报错 */
  function recoverDoc(maskedText, occurrences) {
    const queue = {};
    (occurrences || []).forEach(o => { (queue[o.code] = queue[o.code] || []).push(o.original); });
    let i = 0, out = '', m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(maskedText))) {
      out += maskedText.slice(i, m.index);
      const vals = queue[m[1]];
      if (!vals || !vals.length) throw new Error('代号 ' + m[1] + ' 缺少映射，无法恢复');
      out += vals.shift();
      i = m.index + m[0].length;
    }
    out += maskedText.slice(i);
    for (const c of Object.keys(queue)) if (queue[c].length) throw new Error('代号 ' + c + ' 存在多余映射条目');
    return out;
  }

  function mappingExport(docs, activeByDoc, assignment, unresolvedIds) {
    const built = buildMasked(docs, activeByDoc, assignment, unresolvedIds);
    const codeMap = {};
    docs.forEach(d => {
      built[d.id].occurrences.forEach((o, i) => {
        const e = codeMap[o.code] || (codeMap[o.code] = { code: o.code, type: o.type, occurrences: [] });
        e.occurrences.push({ doc: d.name, index: i + 1, original: o.original });
      });
    });
    return {
      version: 1,
      generatedNote: '本清单可恢复原文，请与脱敏稿分开妥善保管',
      codes: Object.values(codeMap).sort((a, b) => a.code < b.code ? -1 : 1),
      docs: docs.map(d => ({ name: d.name, masked: built[d.id].masked, occurrences: built[d.id].occurrences })),
    };
  }

  /* ================= 5. 审计：哈希链 + 状态指纹 ================= */
  const GENESIS = '0'.repeat(64);
  function canon(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  async function sha256Hex(str) {
    const data = typeof str === 'string' ? str : canon(str);
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
      const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return require('crypto').createHash('sha256').update(data).digest('hex'); // Node 兜底
  }
  /* 状态指纹覆盖：文稿、全部标记（含误标/压制状态）、确认态、代号登记本 */
  function stateFingerprint(state) {
    return canon({
      confirmed: !!state.confirmed,
      docs: (state.docs || []).map(d => ({ id: d.id, name: d.name, text: d.text })),
      marks: (state.marks || []).map(m => ({
        id: m.id, docId: m.docId, type: m.type, start: m.start, end: m.end,
        value: m.value, origin: m.origin, status: m.status,
      })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      registry: state.registry || newRegistry(),
    });
  }
  async function appendAudit(state, action, detail) {
    const prev = state.audit.length ? state.audit[state.audit.length - 1].hash : GENESIS;
    const afterHash = await sha256Hex(stateFingerprint(state));
    const entry = { seq: state.audit.length, ts: new Date().toISOString(), action, detail: detail || null, prevHash: prev, afterHash };
    entry.hash = await sha256Hex(canon(entry));
    state.audit.push(entry);
    return entry;
  }
  /* 校验：① 逐条重算哈希链 ② 末条 afterHash 必须等于当前状态指纹 */
  async function verifyAudit(state) {
    const problems = [];
    let prev = GENESIS;
    for (const e of state.audit) {
      if (e.prevHash !== prev) problems.push('第 ' + e.seq + ' 条 prevHash 断链');
      const expect = Object.assign({}, e);
      delete expect.hash;
      if (await sha256Hex(canon(expect)) !== e.hash) problems.push('第 ' + e.seq + ' 条（' + e.action + '）记录内容被改动');
      prev = e.hash;
    }
    const last = state.audit[state.audit.length - 1];
    if (last && last.afterHash !== await sha256Hex(stateFingerprint(state)))
      problems.push('状态指纹与末条审计记录不符（数据在审计之外被改动，或缺少记录）');
    return { ok: problems.length === 0, problems };
  }

  /* ================= 6. 状态与可对称撤销的操作补丁 ================= */
  function newState() { return { docs: [], marks: [], registry: newRegistry(), confirmed: false, audit: [] }; }
  function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function splitTranscripts(raw) {
    // 空行分隔多条。文稿名来源（均不从正文删除，保证零数据丢失）：
    //   ① 显式 “标题：xxx” → 取 xxx 并移除该行；② 短行以冒号收尾 → 取冒号前并移除；
    //   ③ 短而无句读的首行 → 作为显示名，但保留在正文中；④ 否则“转写稿 N”。
    const blocks = raw.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    return blocks.map((b, i) => {
      const nl = b.indexOf('\n');
      if (nl > 0) {
        const first = b.slice(0, nl);
        let mm;
        if (/^标题\s*[：:]\s*(.{1,24})$/.test(first)) mm = first.match(/^标题\s*[：:]\s*(.{1,24})$/);
        else if (/^.{1,24}[：:]$/.test(first)) mm = [null, first.slice(0, -1)];
        if (mm) return { name: mm[1].trim(), text: b.slice(nl + 1).trim() };
        if (/^[一-龥A-Za-z0-9 _\-()（）]{2,16}$/.test(first)) return { name: first, text: b };
      }
      return { name: '转写稿 ' + (i + 1), text: b };
    });
  }
  /* 导入补丁：文稿与其自动检测候选一并入状态（走 applyOp，可对称撤销） */
  function importPatches(blocks) {
    return blocks.map(b => {
      const docId = uid('d_');
      const marks = detectCandidates(docId, b.text);
      return { op: 'addDoc', docId, name: b.name, text: b.text, marks };
    });
  }

  function docResolution(state, docId) {
    const doc = state.docs.find(d => d.id === docId);
    return resolveMarks(state.marks.filter(m => m.docId === docId), doc ? doc.text : '');
  }
  function allResolution(state) {
    const map = {};
    state.docs.forEach(d => { map[d.id] = docResolution(state, d.id); });
    return map;
  }

  /* applyOp 总返回对称逆补丁：undo=执行逆补丁；redo=再执行其逆补丁 */
  const Ops = {
    addDoc(state, p) {
      state.docs.push({ id: p.docId, name: p.name, text: p.text });
      p.marks.forEach(m => state.marks.push(Object.assign({}, m)));
      return { op: 'removeDoc', docId: p.docId };
    },
    removeDoc(state, p) {
      const at = state.docs.findIndex(d => d.id === p.docId);
      const doc = state.docs.splice(at, 1)[0];
      const marks = state.marks.filter(m => m.docId === p.docId);
      state.marks = state.marks.filter(m => m.docId !== p.docId);
      return { op: 'restoreDoc', docId: doc.id, name: doc.name, text: doc.text, at, marks };
    },
    restoreDoc(state, p) {
      state.docs.splice(p.at, 0, { id: p.docId, name: p.name, text: p.text });
      p.marks.forEach(m => state.marks.push(Object.assign({}, m)));
      return { op: 'removeDoc', docId: p.docId };
    },
    addMark(state, p) {
      state.marks.push({
        id: p.id, docId: p.docId, type: p.type, start: p.start, end: p.end,
        value: p.value, origin: p.origin || 'manual', status: 'active',
      });
      return { op: 'removeMark', id: p.id };
    },
    removeMark(state, p) {
      const i = state.marks.findIndex(m => m.id === p.id);
      const [m] = state.marks.splice(i, 1);
      return { op: 'restoreMark', at: i, mark: m };
    },
    restoreMark(state, p) {
      state.marks.splice(p.at, 0, Object.assign({}, p.mark));
      return { op: 'removeMark', id: p.mark.id };
    },
    retype(state, p) {
      const m = state.marks.find(x => x.id === p.id);
      const old = m.type; m.type = p.type;
      return { op: 'retype', id: p.id, type: old };
    },
    resize(state, p) {
      const m = state.marks.find(x => x.id === p.id);
      const old = { start: m.start, end: m.end, value: m.value };
      m.start = p.start; m.end = p.end; m.value = p.value;
      return { op: 'resize', id: p.id, start: old.start, end: old.end, value: old.value };
    },
    setStatus(state, p) {
      const m = state.marks.find(x => x.id === p.id);
      const old = m.status; m.status = p.status;
      return { op: 'setStatus', id: p.id, status: old };
    },
  };
  function applyOp(state, patch) {
    const fn = Ops[patch.op];
    if (!fn) throw new Error('未知操作 ' + patch.op);
    return fn(state, patch);
  }

  return {
    TYPES, META, REASON_TEXT, priority, luhnOk, luhnCheckDigit, normalizeValue,
    detectCandidates, scanAddress, resolveMarks, overlapOrAdjacent,
    newRegistry, planCodes, commitCodes,
    TOKEN, buildMasked, recoverDoc, mappingExport,
    canon, sha256Hex, stateFingerprint, appendAudit, verifyAudit, GENESIS,
    newState, uid, splitTranscripts, importPatches, docResolution, allResolution,
    applyOp, Ops,
  };
});
