import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import {
  parseUtc,
  overlaps,
  planUsage,
  usageToMap,
  checkCapacity,
  occupancyTimeline,
} from '../src/reserve.js';

let baseUrl;
let server;
let db;

before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const { SCHEMA } = await import('../src/db.js');
  db.exec(SCHEMA);
  const app = createApp(db);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

const cfg = { holes: 4, tolerance: 1, holeMaxMass: [100, 100, 100, 100] };
const tube = (id, mass) => ({ id, mass, usableHoles: [0, 1, 2, 3] });
// 冻结图固定为：A(50) 对径 配重50、B(60) 对径 配重60 → 占用 50g×1、60g×1
const weights2 = [
  { mass: 50, quantity: 2 },
  { mass: 60, quantity: 2 },
];

async function setupPublished() {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [tube('A', 50), tube('B', 60)]);
  await call('PUT', '/api/weights', weights2);
  const pub = await call('POST', '/api/publish');
  return pub.json.id;
}

const D = '2027-01-01';
const at = (h, m = 0) =>
  `${D}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

// ---------- 纯函数 ----------

test('parseUtc：显式 UTC/偏移合法，本地时间或非法串拒绝', () => {
  assert.equal(parseUtc('2026-10-03T08:00:00Z'), '2026-10-03T08:00:00.000Z');
  assert.equal(parseUtc('2026-10-03T08:00Z'), '2026-10-03T08:00:00.000Z');
  assert.equal(parseUtc('2026-10-03T16:00:00+08:00'), '2026-10-03T08:00:00.000Z');
  assert.equal(parseUtc('2026-10-03 08:00'), null); // 无时区标记
  assert.equal(parseUtc('2026-10-03'), null);
  assert.equal(parseUtc('not-a-time'), null);
  assert.equal(parseUtc('2026-13-01T00:00:00Z'), null);
  assert.equal(parseUtc(123), null);
  assert.equal(parseUtc(''), null);
});

test('overlaps：左闭右开，首尾相接不算重叠', () => {
  assert.equal(overlaps(at(8), at(10), at(10), at(12)), false);
  assert.equal(overlaps(at(10), at(12), at(8), at(10)), false);
  assert.equal(overlaps(at(8), at(10), at(9, 59), at(11)), true);
  assert.equal(overlaps(at(8), at(12), at(9), at(10)), true);
});

test('planUsage：按冻结图统计各质量规格占用', () => {
  const result = {
    arrangement: [
      { kind: 'tube', ref: 'A', mass: 50 },
      { kind: 'weight', ref: '配重#1-1', mass: 50 },
      { kind: 'weight', ref: '配重#2-1', mass: 60 },
      null,
    ],
  };
  assert.deepEqual(planUsage(result), [
    { mass: 50, count: 1 },
    { mass: 60, count: 1 },
  ]);
  assert.deepEqual(planUsage({ arrangement: [null, null] }), []);
});

test('checkCapacity：无既有占用时自身需求超量 → 整窗冲突；空隙段同样判定', () => {
  const q = new Map([[50, 1]]);
  // 自身需求 2 > 可选 1：整窗冲突
  const c1 = checkCapacity({
    start: at(8),
    end: at(10),
    newUsage: new Map([[50, 2]]),
    existing: [],
    quantities: q,
  });
  assert.equal(c1.length, 1);
  assert.deepEqual(c1[0].slots, [
    { start: at(8), end: at(10), occupied: 0, required: 2 },
  ]);
  // 既有占用只占窗口前半，后半空隙同样按 0 + 需求判定（需求 2 > 可选 1）
  const c2 = checkCapacity({
    start: at(8),
    end: at(12),
    newUsage: new Map([[50, 2]]),
    existing: [{ start: at(8), end: at(10), usage: new Map([[50, 1]]) }],
    quantities: q,
  });
  assert.equal(c2.length, 1);
  assert.deepEqual(c2[0].slots, [
    { start: at(8), end: at(10), occupied: 1, required: 3 },
    { start: at(10), end: at(12), occupied: 0, required: 2 },
  ]);
  // 规格未录入（可选 0）也判定不足
  const c3 = checkCapacity({
    start: at(8),
    end: at(9),
    newUsage: new Map([[99, 1]]),
    existing: [],
    quantities: q,
  });
  assert.equal(c3.length, 1);
  assert.equal(c3[0].available, 0);
});

test('occupancyTimeline：分段与峰值（相邻同值合并）', () => {
  const tl = occupancyTimeline({
    from: at(8),
    to: at(12),
    reservations: [
      { start: at(8), end: at(10), usage: [{ mass: 50, count: 1 }] },
      { start: at(9), end: at(11), usage: [{ mass: 50, count: 1 }] },
    ],
    masses: [50],
  });
  assert.deepEqual(tl.get(50), [
    { start: at(8), end: at(9), occupied: 1 },
    { start: at(9), end: at(10), occupied: 2 },
    { start: at(10), end: at(11), occupied: 1 },
  ]);
});

// ---------- HTTP API ----------

let pubId;

test('非法输入被拒绝：缺批次号、非 UTC 时间、起点不早于终点', async () => {
  pubId = await setupPublished();
  let r = await call('POST', '/api/reservations', {
    batchNo: '',
    publicationId: pubId,
    start: at(8),
    end: at(10),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('批次号'));

  r = await call('POST', '/api/reservations', {
    batchNo: 'B0',
    publicationId: pubId,
    start: '2027-01-01 08:00', // 无 UTC 标记
    end: at(10),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('UTC'));

  r = await call('POST', '/api/reservations', {
    batchNo: 'B0',
    publicationId: pubId,
    start: 'not-a-time',
    end: at(10),
  });
  assert.equal(r.status, 400);

  r = await call('POST', '/api/reservations', {
    batchNo: 'B0',
    publicationId: pubId,
    start: at(10),
    end: at(10),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('早于'));

  r = await call('POST', '/api/reservations', {
    batchNo: 'B0',
    publicationId: pubId,
    start: at(12),
    end: at(10),
  });
  assert.equal(r.status, 400);
  // 全部失败，不产生任何预约
  const list = await call('GET', '/api/reservations');
  assert.equal(list.json.length, 0);
});

test('未知图与不可用图被拒绝', async () => {
  let r = await call('POST', '/api/reservations', {
    batchNo: 'BX',
    publicationId: 999,
    start: at(8),
    end: at(10),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('不存在'));

  // 数据变化 → 图失效 → 拒绝；恢复数据 → 重新可用
  await call('PUT', '/api/weights', [{ mass: 1, quantity: 1 }]);
  r = await call('POST', '/api/reservations', {
    batchNo: 'BX',
    publicationId: pubId,
    start: at(8),
    end: at(10),
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('不可用于装载'));
  await call('PUT', '/api/weights', weights2);
});

let r1Id;

test('创建预约成功：按冻结图统计占用，state 同步展示', async () => {
  const r = await call('POST', '/api/reservations', {
    batchNo: 'R1',
    publicationId: pubId,
    start: at(8),
    end: at(10),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  r1Id = r.json.id;
  assert.equal(r.json.batchNo, 'R1');
  assert.equal(r.json.status, 'active');
  assert.deepEqual(r.json.usage, [
    { mass: 50, count: 1 },
    { mass: 60, count: 1 },
  ]);
  assert.equal(r.json.publicationUsable, true);

  const one = await call('GET', `/api/reservations/${r1Id}`);
  assert.equal(one.status, 200);
  assert.equal(one.json.batchNo, 'R1');

  const s = await call('GET', '/api/state');
  assert.ok(Array.isArray(s.json.reservations));
  assert.equal(s.json.reservations.length, 1);
  assert.equal(s.json.reservations[0].batchNo, 'R1');
});

test('左闭右开：首尾相接不冲突；容量内并发允许', async () => {
  // R2 [10,12) 与 R1 [8,10) 首尾相接 → 不重叠
  let r = await call('POST', '/api/reservations', {
    batchNo: 'R2',
    publicationId: pubId,
    start: at(10),
    end: at(12),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  // R3 [9,11) 与 R1、R2 各重叠一半，峰值 2 ≤ 可选 2
  r = await call('POST', '/api/reservations', {
    batchNo: 'R3',
    publicationId: pubId,
    start: at(9),
    end: at(11),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

test('超量冲突：返回冲突规格与时段，不产生部分占用', async () => {
  const before = await call('GET', '/api/reservations');
  // R4 [9:30,10:30)：与 R1+R3、R2+R3 分别叠加至 3 > 可选 2
  const r = await call('POST', '/api/reservations', {
    batchNo: 'R4',
    publicationId: pubId,
    start: at(9, 30),
    end: at(10, 30),
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  const conflicts = r.json.detail.conflicts;
  assert.equal(conflicts.length, 2); // 50g 与 60g 两个规格
  const c50 = conflicts.find((c) => c.mass === 50);
  assert.equal(c50.available, 2);
  assert.equal(c50.needed, 1);
  // 相邻同值段合并：[9:30,10) 与 [10,10:30) 占用同为 2 → 合并展示
  assert.deepEqual(c50.slots, [
    { start: at(9, 30), end: at(10, 30), occupied: 2, required: 3 },
  ]);
  assert.ok(r.json.errors.join(' ').includes('50 g'));
  // 不产生部分占用：预约列表不变
  const after = await call('GET', '/api/reservations');
  assert.equal(after.json.length, before.json.length);
});

test('占用日程：分段、峰值与当前可选对照', async () => {
  const r = await call(
    'GET',
    `/api/reservations/occupancy?from=${at(8)}&to=${at(12)}`,
  );
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const s50 = r.json.specs.find((s) => s.mass === 50);
  assert.equal(s50.quantity, 2);
  assert.equal(s50.peak, 2);
  assert.equal(s50.exceeded, false);
  assert.deepEqual(s50.segments, [
    { start: at(8), end: at(9), occupied: 1 },
    { start: at(9), end: at(11), occupied: 2 }, // 相邻同值段已合并
    { start: at(11), end: at(12), occupied: 1 },
  ]);
  // 非法窗口
  let bad = await call('GET', '/api/reservations/occupancy?from=not-a-time');
  assert.equal(bad.status, 400);
  bad = await call('GET', `/api/reservations/occupancy?from=${at(12)}&to=${at(8)}`);
  assert.equal(bad.status, 400);
});

test('幂等：同批次号同内容返回原记录，不同内容拒绝', async () => {
  const before = await call('GET', '/api/reservations');
  const replay = await call('POST', '/api/reservations', {
    batchNo: 'R1',
    publicationId: pubId,
    start: at(8),
    end: at(10),
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, r1Id);
  assert.equal(replay.json.status, 'active');
  const after = await call('GET', '/api/reservations');
  assert.equal(after.json.length, before.json.length);

  const diff = await call('POST', '/api/reservations', {
    batchNo: 'R1',
    publicationId: pubId,
    start: at(8),
    end: at(11), // 内容不同
  });
  assert.equal(diff.status, 409);
  assert.equal(diff.json.existingId, r1Id);
});

const futureAt = (h) => new Date(Date.now() + h * 3600e3).toISOString();
let f1Id;
let f1Body;

test('取消：未开始可取消并释放占用；重复取消幂等；已开始拒绝', async () => {
  f1Body = {
    batchNo: 'F1',
    publicationId: pubId,
    start: futureAt(2),
    end: futureAt(3),
  };
  let r = await call('POST', '/api/reservations', f1Body);
  assert.equal(r.status, 201);
  f1Id = r.json.id;

  // 未开始 → 取消成功
  r = await call('POST', `/api/reservations/${f1Id}/cancel`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 'cancelled');
  assert.ok(r.json.cancelledAt);

  // 重复取消 → 幂等返回历史记录
  r = await call('POST', `/api/reservations/${f1Id}/cancel`);
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'cancelled');

  // 占用已释放：同时段新批次号可约
  r = await call('POST', '/api/reservations', {
    ...f1Body,
    batchNo: 'F2',
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));

  // 已开始的预约不可取消
  r = await call('POST', '/api/reservations', {
    batchNo: 'P1',
    publicationId: pubId,
    start: '2020-01-01T08:00:00.000Z',
    end: '2020-01-01T10:00:00.000Z',
  });
  assert.equal(r.status, 201);
  r = await call('POST', `/api/reservations/${r.json.id}/cancel`);
  assert.equal(r.status, 409);
  assert.ok(r.json.errors.join(' ').includes('仅未开始'));
});

test('取消后同号重试不重新占用；同号不同内容拒绝', async () => {
  const replay = await call('POST', '/api/reservations', f1Body);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.id, f1Id);
  assert.equal(replay.json.status, 'cancelled'); // 仍是已取消的历史记录

  const diff = await call('POST', '/api/reservations', {
    ...f1Body,
    end: futureAt(4),
  });
  assert.equal(diff.status, 409);
  assert.equal(diff.json.existingId, f1Id);
});

test('数量调减与图失效不改写既有预约；后续预约按当前数量判定并展示不足', async () => {
  // 50g/60g 各减至 1 → 数据指纹变化，旧图失效
  let r = await call('PUT', '/api/weights', [
    { mass: 50, quantity: 1 },
    { mass: 60, quantity: 1 },
  ]);
  assert.equal(r.status, 200);

  // 既有预约保持原样（占用、状态不变），仅展示标记变化
  const list = await call('GET', '/api/reservations');
  const r1 = list.json.find((x) => x.batchNo === 'R1');
  assert.equal(r1.status, 'active');
  assert.deepEqual(r1.usage, [
    { mass: 50, count: 1 },
    { mass: 60, count: 1 },
  ]);
  assert.equal(r1.publicationUsable, false);

  // 占用日程展示不足：峰值 2 > 当前可选 1
  const occ = await call(
    'GET',
    `/api/reservations/occupancy?from=${at(8)}&to=${at(12)}`,
  );
  const s50 = occ.json.specs.find((s) => s.mass === 50);
  assert.equal(s50.quantity, 1);
  assert.equal(s50.peak, 2);
  assert.equal(s50.exceeded, true);

  // 依据当前数据重新发布（新图可用）
  const pub2 = await call('POST', '/api/publish');
  assert.equal(pub2.status, 201);

  // 后续预约按当前数量判定：[8:30,9:30) 内既有占用最高 2 > 当前可选 1 → 拒绝并展示占用
  r = await call('POST', '/api/reservations', {
    batchNo: 'R5',
    publicationId: pub2.json.id,
    start: at(8, 30),
    end: at(9, 30),
  });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  const c50 = r.json.detail.conflicts.find((c) => c.mass === 50);
  assert.equal(c50.available, 1);
  assert.deepEqual(c50.slots, [
    { start: at(8, 30), end: at(9), occupied: 1, required: 2 },
    { start: at(9), end: at(9, 30), occupied: 2, required: 3 },
  ]);

  // 不重叠的时段仍可约（R2 止于 12:00，左闭右开不冲突）
  r = await call('POST', '/api/reservations', {
    batchNo: 'R6',
    publicationId: pub2.json.id,
    start: at(12),
    end: at(13),
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
});

test('usageToMap：数组与 Map 等价，非正数量忽略', () => {
  const m = usageToMap([
    { mass: 50, count: 2 },
    { mass: 60, count: 0 },
    { mass: 50, count: 1 },
  ]);
  assert.equal(m.get(50), 3);
  assert.equal(m.has(60), false);
  assert.deepEqual([...usageToMap(m).entries()], [...m.entries()]);
});
