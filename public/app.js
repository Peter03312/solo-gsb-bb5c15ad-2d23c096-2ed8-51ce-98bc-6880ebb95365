/* 离心转子配平前端（无框架，原生 JS） */

const $ = (sel) => document.querySelector(sel);
const holesSel = $('#holes');
for (let n = 4; n <= 12; n += 2) {
  const opt = document.createElement('option');
  opt.value = String(n);
  opt.textContent = `${n} 孔`;
  holesSel.appendChild(opt);
}

let state = null; // GET /api/state 的完整响应
// 编辑区本地缓冲
let editorN = null;
let tubeRows = []; // {id, mass, holes:Set}
let weightRows = []; // {mass, quantity}

// ---------- 通用 ----------

function showAlert(msg, kind = 'err') {
  const el = $('#alert');
  el.textContent = msg;
  el.className = `alert ${kind}`;
  el.scrollIntoView({ block: 'nearest' });
}
function clearAlert() {
  $('#alert').className = 'alert hidden';
}
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const list = json.errors && json.errors.length ? json.errors.join('\n') : json.error || '请求失败';
    const err = new Error(list);
    err.status = res.status;
    err.data = json;
    throw err;
  }
  return json;
}
const fmt = (x) => (typeof x === 'number' ? String(Math.round(x * 1e6) / 1e6) : x);

// ---------- 数据刷新 ----------

async function refresh(flash) {
  state = await api('GET', '/api/state');
  renderAll();
  if (flash) showAlert(flash, 'ok');
  else clearAlert();
}

function renderAll() {
  const d = state.data;
  $('#hashline').textContent = state.currentHash
    ? `当前数据指纹 sha256:${state.currentHash.slice(0, 16)}…`
    : '尚未配置转子';

  // 首次或孔位数变化时重建本地编辑缓冲
  const N = d ? d.holes : null;
  if (editorN !== N) {
    editorN = N;
    if (d) {
      holesSel.value = String(d.holes);
      $('#tolerance').value = d.tolerance;
      tubeRows = d.tubes.map((t) => ({
        id: t.id,
        mass: t.mass,
        holes: new Set(t.usableHoles),
      }));
      weightRows = d.weights.map((w) => ({ mass: w.mass, quantity: w.quantity }));
    }
  }

  renderHoleMax(d);
  renderTubeTable(N);
  renderWeightTable();
  renderDraft();
  renderPublications();
  renderVerifications();
}

function renderHoleMax(d) {
  const N = d ? d.holes : Number(holesSel.value);
  const box = $('#holemax');
  if (box.childElementCount !== N) {
    box.innerHTML = '';
    for (let h = 0; h < N; h += 1) {
      const lab = document.createElement('label');
      lab.innerHTML = `孔 ${h}<input data-hole="${h}" type="number" step="0.0001" min="0">`;
      box.appendChild(lab);
    }
  }
  if (d) {
    box.querySelectorAll('input').forEach((inp) => {
      const h = Number(inp.dataset.hole);
      if (document.activeElement !== inp) inp.value = d.holeMaxMass[h];
    });
  }
}

holesSel.addEventListener('change', () => {
  editorN = Number(holesSel.value);
  renderHoleMax(null);
  renderTubeTable(editorN);
});

// ---------- 离心管表 ----------

function renderTubeTable(N) {
  const tbody = $('#tubes-table tbody');
  tbody.innerHTML = '';
  tubeRows.forEach((row, i) => {
    const tr = document.createElement('tr');

    const tdId = document.createElement('td');
    const idInp = document.createElement('input');
    idInp.type = 'text';
    idInp.value = row.id;
    idInp.placeholder = '如 T01';
    idInp.addEventListener('input', () => { row.id = idInp.value.trim(); });
    tdId.appendChild(idInp);

    const tdMass = document.createElement('td');
    const mInp = document.createElement('input');
    mInp.type = 'number';
    mInp.step = '0.0001';
    mInp.min = '0';
    mInp.value = row.mass;
    mInp.addEventListener('input', () => { row.mass = mInp.value; });
    tdMass.appendChild(mInp);

    const tdHoles = document.createElement('td');
    if (N) {
      const wrap = document.createElement('div');
      wrap.className = 'holes-checks';
      for (let h = 0; h < N; h += 1) {
        const lab = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = row.holes.has(h);
        cb.addEventListener('change', () => {
          if (cb.checked) row.holes.add(h);
          else row.holes.delete(h);
        });
        lab.append(cb, document.createTextNode(h));
        wrap.appendChild(lab);
      }
      tdHoles.appendChild(wrap);
    } else {
      tdHoles.textContent = '—';
      tdHoles.className = 'muted';
    }

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', () => { tubeRows.splice(i, 1); renderTubeTable(N); });
    tdDel.appendChild(del);

    tr.append(tdId, tdMass, tdHoles, tdDel);
    tbody.appendChild(tr);
  });
}

$('#add-tube').addEventListener('click', () => {
  if (!editorN) return showAlert('请先保存转子配置（孔位数）。', 'err');
  const holes = new Set([0]);
  tubeRows.push({ id: '', mass: '', holes });
  renderTubeTable(editorN);
});

// ---------- 配重表 ----------

function renderWeightTable() {
  const tbody = $('#weights-table tbody');
  tbody.innerHTML = '';
  weightRows.forEach((row, i) => {
    const tr = document.createElement('tr');

    const tdMass = document.createElement('td');
    const mInp = document.createElement('input');
    mInp.type = 'number';
    mInp.step = '0.0001';
    mInp.min = '0';
    mInp.value = row.mass;
    mInp.addEventListener('input', () => { row.mass = mInp.value; });
    tdMass.appendChild(mInp);

    const tdQ = document.createElement('td');
    const qInp = document.createElement('input');
    qInp.type = 'number';
    qInp.step = '1';
    qInp.min = '1';
    qInp.value = row.quantity;
    qInp.addEventListener('input', () => { row.quantity = qInp.value; });
    tdQ.appendChild(qInp);

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = '删除';
    del.addEventListener('click', () => { weightRows.splice(i, 1); renderWeightTable(); });
    tdDel.appendChild(del);

    tr.append(tdMass, tdQ, tdDel);
    tbody.appendChild(tr);
  });
}

$('#add-weight').addEventListener('click', () => {
  if (!editorN) return showAlert('请先保存转子配置（孔位数）。', 'err');
  weightRows.push({ mass: '', quantity: 1 });
  renderWeightTable();
});

// ---------- 保存动作 ----------

$('#save-config').addEventListener('click', async () => {
  const holes = Number(holesSel.value);
  const tolerance = Number($('#tolerance').value);
  const holeMaxMass = [...$('#holemax').querySelectorAll('input')].map((i) => Number(i.value));
  try {
    await api('PUT', '/api/config', { holes, tolerance, holeMaxMass });
    await refresh('转子配置已保存。');
  } catch (e) { showAlert(e.message, 'err'); }
});

async function saveTubes() {
  if (!editorN) throw new Error('请先配置转子孔位数。');
  const body = tubeRows.map((r) => ({
    id: r.id,
    mass: Number(r.mass),
    usableHoles: [...r.holes].sort((a, b) => a - b),
  }));
  await api('PUT', '/api/tubes', body);
}

async function saveWeights() {
  if (!editorN) throw new Error('请先配置转子孔位数。');
  const body = weightRows.map((r) => ({ mass: Number(r.mass), quantity: Number(r.quantity) }));
  await api('PUT', '/api/weights', body);
}

$('#save-tubes').addEventListener('click', async () => {
  try {
    await saveTubes();
    const r = await api('POST', '/api/solve');
    await refresh();
    if (r.feasible) showAlert('离心管已保存，装载图已按当前数据重算。', 'ok');
    else showAlert('离心管已保存，但不存在可行装载图：\n' + r.reasons.join('\n'), 'err');
  } catch (e) { showAlert(e.message, 'err'); }
});

$('#save-weights').addEventListener('click', async () => {
  try {
    await saveWeights();
    const r = await api('POST', '/api/solve');
    await refresh();
    if (r.feasible) showAlert('配重块已保存，装载图已按当前数据重算。', 'ok');
    else showAlert('配重块已保存，但不存在可行装载图：\n' + r.reasons.join('\n'), 'err');
  } catch (e) { showAlert(e.message, 'err'); }
});

// ---------- 草稿展示 ----------

function slotHtml(h, slot) {
  if (!slot) {
    return `<div class="slot empty"><span class="hole-no">孔 ${h}</span>
      <span class="ref">空</span><span class="mass">0 g</span></div>`;
  }
  const cls = slot.kind === 'tube' ? 'tube' : 'weight';
  const tag = slot.kind === 'tube' ? '离心管' : '配重块';
  return `<div class="slot ${cls}"><span class="hole-no">孔 ${h}</span>
    <span class="ref">${escapeHtml(slot.ref)}</span>
    <span class="mass">${tag} · ${fmt(slot.mass)} g</span></div>`;
}

function arrangementHtml(result) {
  return `<div class="rotor-layout">${result.arrangement
    .map((s, h) => slotHtml(h, s))
    .join('')}</div>
  <table class="pair-list">
    <thead><tr><th>对径孔对</th><th>A 侧质量</th><th>B 侧质量</th><th>差值</th><th>容差判定</th></tr></thead>
    <tbody>${result.pairs
      .map(
        (p) => `<tr><td>${p.a} ↔ ${p.b}</td><td>${fmt(p.massA)} g</td>
        <td>${fmt(p.massB)} g</td><td>${fmt(p.diff)} g</td>
        <td class="${p.withinTolerance ? 'tag-ok' : 'tag-bad'}">${
          p.withinTolerance ? '✓ 合格' : '✗ 超限'
        }</td></tr>`,
      )
      .join('')}</tbody>
  </table>`;
}

function renderDraft() {
  const draft = state.draft;
  const staleBox = $('#draft-stale');
  const noneBox = $('#draft-none');
  const body = $('#draft-body');
  const pubBtn = $('#publish');

  if (!draft) {
    staleBox.classList.add('hidden');
    noneBox.classList.remove('hidden');
    body.classList.add('hidden');
    pubBtn.disabled = true;
    return;
  }
  noneBox.classList.add('hidden');
  staleBox.classList.toggle('hidden', !draft.stale);
  body.classList.remove('hidden');

  if (!draft.feasible) {
    body.innerHTML = `<div class="banner bad"><b>不存在可行装载图。</b><ul>${draft.reasons
      .map((r) => `<li>${escapeHtml(r)}</li>`)
      .join('')}</ul></div>`;
    pubBtn.disabled = true;
    return;
  }
  const r = draft.result;
  body.innerHTML = `
    <div class="metrics">
      <div>使用配重块：<b>${r.weightCount}</b> 枚（已最小化）</div>
      <div>各对径差之和：<b>${fmt(r.diffSum)}</b> g（同配重数下已最小化）</div>
    </div>
    ${arrangementHtml(r)}`;
  pubBtn.disabled = draft.stale;
}

$('#recompute').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/solve');
    await refresh();
    if (r.feasible) showAlert('已按当前数据重算。', 'ok');
    else showAlert('不存在可行装载图：\n' + r.reasons.join('\n'), 'err');
  } catch (e) { showAlert(e.message, 'err'); }
});

$('#publish').addEventListener('click', async () => {
  try {
    const pub = await api('POST', '/api/publish');
    await refresh(`已发布并冻结装载图 #${pub.id}（发布时基于当前数据复核通过）。`);
  } catch (e) { showAlert(e.message, 'err'); }
});

// ---------- 发布历史 ----------

function renderPublications() {
  const box = $('#pub-list');
  if (state.publications.length === 0) {
    box.innerHTML = '<div class="muted">暂无发布记录。</div>';
    return;
  }
  box.innerHTML = state.publications
    .map(
      (p) => `<div class="pub-row">
        <div>
          <button data-pub="${p.id}" class="pub-view">#${p.id}</button>
          <span class="muted">${p.createdAt}</span>
          ${p.feasible
            ? `<span class="muted">· 配重 ${p.weightCount} 枚 · 对径差和 ${fmt(p.diffSum)} g</span>`
            : '<span class="muted">· 不可行记录</span>'}
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          ${
            p.feasible && p.usable
              ? `<button data-pub-verify="${p.id}" class="primary">现场核验此图</button>`
              : ''
          }
          <span class="badge ${p.usable ? 'ok' : 'stale'}">${
            p.usable ? '✓ 可用于当前装载' : '✗ 不可用于当前装载（数据已变化，旧图冻结不变）'
          }</span>
        </div>
      </div>`,
    )
    .join('');
  box.querySelectorAll('.pub-view').forEach((b) =>
    b.addEventListener('click', () => openPublication(Number(b.dataset.pub))),
  );
  box.querySelectorAll('[data-pub-verify]').forEach((b) =>
    b.addEventListener('click', () => startVerification(Number(b.dataset.pubVerify))),
  );
}

async function openPublication(id) {
  const p = await api('GET', `/api/publications/${id}`);
  $('#pub-title').textContent = `已冻结装载图 #${p.id}`;
  const badge = p.usable
    ? '<span class="badge ok">✓ 可用于当前装载</span>'
    : '<span class="badge stale">✗ 不可用于当前装载</span>';
  $('#pub-detail').innerHTML = `
    <div class="actions" style="margin-top:0">${badge}
      <span class="muted">发布时间 ${p.createdAt}</span></div>
    <p class="muted" style="font-family:ui-monospace,monospace;font-size:12px">
      数据依据 sha256:${p.basisHash}</p>
    ${p.feasible
      ? `<div class="metrics">
          <div>配重块：<b>${p.weightCount}</b> 枚</div>
          <div>对径差之和：<b>${fmt(p.diffSum)}</b> g</div>
        </div>${arrangementHtml(p.result)}`
      : `<div class="banner bad">${p.reasons.map(escapeHtml).join('<br>')}</div>`}
    <details class="snapshot-block">
      <summary>发布时冻结的录入数据（依据快照）</summary>
      <pre>${escapeHtml(JSON.stringify(p.config, null, 2))}</pre>
    </details>`;
  $('#pub-dialog').showModal();
}
$('#pub-close').addEventListener('click', () => $('#pub-dialog').close());

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- 现场装载核验 ----------

let verDetail = null; // GET /api/verifications/:id 的完整响应（编辑器数据源）

function renderVerifications() {
  const box = $('#verify-list');
  const list = state.verifications || [];
  if (list.length === 0) {
    box.innerHTML =
      '<div class="muted">尚无核验记录。在第 5 节对可用于当前装载的发布记录点「现场核验此图」即可开始。</div>';
    return;
  }
  box.innerHTML = list
    .map(
      (v) => `<div class="pub-row">
        <div>
          <button data-ver="${v.id}" class="pub-view">核验 #${v.id}</button>
          <span class="muted">发布记录 #${v.publicationId} · 更新于 ${v.updatedAt}</span>
          <span class="muted">· 进度 ${v.progress.filled}/${v.progress.total} 孔</span>
          ${v.completed ? `<span class="muted">· 实测对径差和 ${fmt(v.diffSum)} g</span>` : ''}
        </div>
        <span class="badge ${v.completed ? 'ok' : v.usable ? 'stale' : 'bad'}">${
          v.completed
            ? `✓ 已完成核验（${v.completedAt}）`
            : v.usable
              ? '⏳ 核验进行中（草稿可恢复）'
              : '✗ 依据发布已不可用于当前装载'
        }</span>
      </div>`,
    )
    .join('');
  box.querySelectorAll('[data-ver]').forEach((b) =>
    b.addEventListener('click', () => openVerification(Number(b.dataset.ver))),
  );
}

async function startVerification(publicationId) {
  try {
    const v = await api('POST', '/api/verifications', { publicationId });
    await refresh();
    await openVerification(v.id);
  } catch (e) {
    // 同一发布记录已有核验（草稿或已完成）→ 直接恢复
    if (e.status === 409 && e.data && e.data.existingId != null) {
      await refresh();
      await openVerification(e.data.existingId);
      showAlert(e.message, 'ok');
    } else {
      showAlert(e.message, 'err');
    }
  }
}

async function openVerification(id) {
  verDetail = await api('GET', `/api/verifications/${id}`);
  verRows = [];
  verFail = null;
  renderVerificationDialog();
  $('#ver-dialog').showModal();
}

// 编辑器本地缓冲：verRows[h] = {ref, mass}
let verRows = [];
// 最近一次“完成核验”失败时服务端返回的判定明细（用于定位孔位/孔对）
let verFail = null;

function renderVerificationDialog() {
  const v = verDetail;
  $('#ver-title').textContent = `现场核验 #${v.id}（发布记录 #${v.publicationId}）`;
  const frozen = v.publication.result.arrangement;
  const N = frozen.length;

  // 首次载入时用服务端数据初始化本地缓冲（避免覆盖正在编辑的内容）
  if (!verRows.length || verRows._verId !== v.id || verRows._version !== v.version) {
    verRows = v.entries.map((e) => ({ ref: e.ref, mass: e.mass === 0 ? '' : e.mass }));
    verRows._verId = v.id;
    verRows._version = v.version;
  }

  const badge = v.completed
    ? '<span class="badge ok">✓ 核验已完成并冻结</span>'
    : v.usable
      ? '<span class="badge ok">✓ 发布记录可用于当前装载</span>'
      : '<span class="badge bad">✗ 发布记录已不可用于当前装载（不能完成核验）</span>';

  let body = `
    <div class="actions" style="margin-top:0">${badge}
      <span class="muted">版本 v${v.version} · 进度 ${v.progress.filled}/${v.progress.total} 孔</span>
    </div>
    <p class="muted" style="font-family:ui-monospace,monospace;font-size:12px">
      依据发布 sha256:${v.publication.basisHash} · 冻结容差 ${v.publication.config.tolerance} g</p>
    <div id="ver-msg"></div>`;

  const holeChecks = new Map();
  if (v.completed && v.checks) {
    for (const h of v.checks.holes) holeChecks.set(h.hole, h);
  } else if (verFail && verFail.checks) {
    for (const h of verFail.checks.holes) holeChecks.set(h.hole, h);
  }
  const pairChecks = v.completed
    ? v.checks.pairs
    : verFail && verFail.checks
      ? verFail.checks.pairs
      : null;

  body += `<div class="table-wrap"><table class="ver-table">
    <thead><tr>
      <th>孔位</th><th>冻结图应放物件</th><th>孔承重 (g)</th>
      <th>现场实际物件编号</th><th>实测质量 (g)</th>${v.completed ? '<th>判定</th>' : ''}
    </tr></thead><tbody>`;

  for (let h = 0; h < N; h += 1) {
    const slot = frozen[h];
    const expected = slot ? slot.ref : '空';
    const isEmpty = !slot;
    const row = verRows[h];
    const chk = holeChecks.get(h);
    const holeBad = chk && !(chk.objectMatch && chk.withinCapacity);
    let verdict = '';
    if (v.completed) {
      const ok = chk && chk.objectMatch && chk.withinCapacity;
      verdict = `<td class="${ok ? 'tag-ok' : 'tag-bad'}">${ok ? '✓' : '✗'}</td>`;
    }
    body += `<tr${holeBad ? ' class="row-bad"' : ''}>
      <td>孔 ${h}</td>
      <td>${escapeHtml(expected)}</td>
      <td>${fmt(v.publication.config.holeMaxMass[h])}</td>
      <td>${
        v.completed
          ? escapeHtml(row.ref || '（空）')
          : isEmpty
            ? '<span class="muted">空孔（保持为空）</span>'
            : `<input type="text" data-ver-ref="${h}" value="${escapeHtml(row.ref)}" placeholder="${escapeHtml(expected)}" class="${chk && !chk.objectMatch ? 'inp-bad' : ''}">`
      }</td>
      <td>${
        v.completed
          ? fmt(row.mass || 0)
          : isEmpty
            ? '<span class="muted">0</span>'
            : `<input type="number" step="0.0001" min="0" data-ver-mass="${h}" value="${row.mass === '' || row.mass == null ? '' : Number(row.mass)}" class="${chk && !chk.withinCapacity ? 'inp-bad' : ''}">`
      }</td>
      ${verdict}
    </tr>`;
  }
  body += '</tbody></table></div>';

  if (!v.completed) {
    if (verFail) {
      body += `<div class="banner bad" id="ver-fail-banner">
        <b>核验不通过（草稿已保留，未生成完成记录）：</b>
        <ul>${(verFail.errors || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      </div>`;
    }
    if (pairChecks) {
      body += `<table class="pair-list">
        <thead><tr><th>对径孔对</th><th>A 侧实测</th><th>B 侧实测</th><th>差值</th><th>冻结容差判定</th></tr></thead>
        <tbody>${pairChecks
          .map(
            (p) => `<tr><td>${p.a} ↔ ${p.b}</td><td>${fmt(p.massA)} g</td>
            <td>${fmt(p.massB)} g</td><td>${fmt(p.diff)} g</td>
            <td class="${p.withinTolerance ? 'tag-ok' : 'tag-bad'}">${
              p.withinTolerance ? '✓ 合格' : '✗ 超限'
            }</td></tr>`,
          )
          .join('')}</tbody></table>`;
    }
    body += `<div class="actions">
      <button id="ver-save">暂存录入</button>
      <button id="ver-complete" class="primary" ${v.usable ? '' : 'disabled'}>
        完成核验（事务内重读快照与当前数据判定）
      </button>
    </div>
    <p class="muted">提示：暂存可随时中断、稍后从本页恢复；完成须全部孔位录入合格（有物件填正数质量，空孔留空）。</p>`;
  } else {
    const allOk =
      v.checks.holes.every((c) => c.objectMatch && c.withinCapacity) &&
      v.checks.pairs.every((p) => p.withinTolerance);
    body += `<div class="banner ${allOk ? 'ok' : 'bad'}">
      <b>${allOk ? '✓ 核验通过' : '✗ 核验不通过（冻结记录保留）'}</b>
      实测各对径差之和：${fmt(v.diffSum)} g · 完成时间：${v.completedAt}
    </div>`;
    body += `<table class="pair-list">
      <thead><tr><th>对径孔对</th><th>A 侧实测</th><th>B 侧实测</th><th>差值</th><th>冻结容差判定</th></tr></thead>
      <tbody>${v.checks.pairs
        .map(
          (p) => `<tr><td>${p.a} ↔ ${p.b}</td><td>${fmt(p.massA)} g</td>
          <td>${fmt(p.massB)} g</td><td>${fmt(p.diff)} g</td>
          <td class="${p.withinTolerance ? 'tag-ok' : 'tag-bad'}">${
            p.withinTolerance ? '✓ 合格' : '✗ 超限'
          }</td></tr>`,
        )
        .join('')}</tbody></table>`;
  }

  $('#ver-detail').innerHTML = body;

  // 绑定输入
  $('#ver-detail').querySelectorAll('[data-ver-ref]').forEach((inp) => {
    inp.addEventListener('input', () => {
      verRows[Number(inp.dataset.verRef)].ref = inp.value.trim();
      clearVerFail();
    });
  });
  $('#ver-detail').querySelectorAll('[data-ver-mass]').forEach((inp) => {
    inp.addEventListener('input', () => {
      verRows[Number(inp.dataset.verMass)].mass = inp.value;
      clearVerFail();
    });
  });

  const saveBtn = $('#ver-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveVerification(false));
  }
  const completeBtn = $('#ver-complete');
  if (completeBtn) {
    completeBtn.addEventListener('click', () => saveVerification(true));
  }
}

function collectVerEntries() {
  return verRows.map((r, h) => ({
    hole: h,
    ref: r.ref || '',
    mass: r.ref ? Number(r.mass) : 0,
  }));
}

async function saveVerification(andComplete) {
  try {
    const saved = await api('PUT', `/api/verifications/${verDetail.id}`, {
      version: verDetail.version,
      entries: collectVerEntries(),
    });
    verDetail = saved;
    verRows._version = saved.version;
    verFail = null;
    if (!andComplete) {
      renderVerificationDialog();
      verDialogMsg(`核验草稿已暂存（版本 v${saved.version}，进度 ${saved.progress.filled}/${saved.progress.total}）。`, 'ok');
      await refresh();
      return;
    }
    const done = await api('POST', `/api/verifications/${saved.id}/complete`);
    verDetail = done;
    verRows = [];
    verFail = null;
    renderVerificationDialog();
    await refresh();
    verDialogMsg('核验已完成：实测值与判定明细已冻结。', 'ok');
  } catch (e) {
    // 完成失败：草稿仍在；若服务端附带判定明细则缓存以定位孔位/孔对
    verFail = e.data && e.data.detail ? e.data.detail : null;
    try {
      verDetail = await api('GET', `/api/verifications/${verDetail.id}`);
      verRows._version = verDetail.version;
    } catch (_) { /* 忽略二次刷新失败 */ }
    renderVerificationDialog();
    verDialogMsg(e.message, 'err');
  }
}

// 对话框内消息（顶部 alert 在模态框之外、不可见）
function verDialogMsg(msg, kind = 'err') {
  const el = $('#ver-msg');
  if (!el) return;
  el.innerHTML = `<div class="banner ${kind === 'ok' ? 'ok' : 'bad'}" style="margin:0 0 12px">
    ${escapeHtml(msg).replace(/\n/g, '<br>')}</div>`;
  el.scrollIntoView({ block: 'nearest' });
}

// 任一字段改动后清掉上一轮失败高亮，避免误导（不整体重渲染以保留焦点）
function clearVerFail() {
  if (!verFail) return;
  verFail = null;
  $('#ver-detail').querySelectorAll('.inp-bad').forEach((el) => el.classList.remove('inp-bad'));
  $('#ver-detail').querySelectorAll('tr.row-bad').forEach((el) => el.classList.remove('row-bad'));
  const banner = $('#ver-fail-banner');
  if (banner) banner.remove();
}

$('#ver-close').addEventListener('click', () => {
  $('#ver-dialog').close();
  verRows = [];
  refresh().catch(() => {});
});

// ---------- 启动 ----------

refresh().catch((e) => showAlert('初始化失败：' + e.message, 'err'));
