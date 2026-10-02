// 配重块时段预约（纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 时段一律按左闭右开 [start, end) 计算：终点与起点相接的两个预约互不重叠；
//   - 每条预约按其所依据的冻结装载图统计各质量规格的占用量；
//   - 任一时刻、任一质量规格，全部生效中（未取消）预约的占用总量不得超过
//     当前录入的可选数量；
//   - 判定一律使用「当前录入数量」与「当前图可用性」；既有预约不因数量减少
//     或图失效而被改写，只在日程中把超限区段标记为「不足」。

// ISO 8601 形状（允许日期型、空格分隔、省略秒、省略时区——省略时区按 UTC 处理）
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:\s*(?:Z|z|[+-]\d{2}:?\d{2}))?)?$/;

// 解析 UTC 时间字符串 → 毫秒时间戳；非法返回 null。
export function parseUtcMs(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!ISO_RE.test(v)) return null;
  let norm = v.replace(' ', 'T');
  if (!/[T]/.test(norm)) norm += 'T00:00:00';
  if (!/(?:Z|z|[+-]\d{2}:?\d{2})$/.test(norm)) norm += 'Z';
  const ms = Date.parse(norm);
  return Number.isNaN(ms) ? null : ms;
}

export function toIso(ms) {
  return new Date(ms).toISOString();
}

// ---------- 冻结图占用统计 ----------
// publication: getPublication 返回的冻结记录（含 result.arrangement）。
// 返回 [{mass, count}]（按质量升序），仅含配重块；纯离心管图为空数组。
export function planUsage(publication) {
  const counts = new Map();
  const arrangement =
    publication && publication.result && Array.isArray(publication.result.arrangement)
      ? publication.result.arrangement
      : [];
  for (const slot of arrangement) {
    if (slot && slot.kind === 'weight' && typeof slot.mass === 'number') {
      counts.set(slot.mass, (counts.get(slot.mass) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([mass, count]) => ({ mass, count }))
    .sort((a, b) => a.mass - b.mass);
}

// ---------- 扫描线：时段内分段常量占用 ----------
// intervals: [{startMs, endMs, count}]（调用前不要求裁剪，函数内裁剪到 [s,e)）。
// 返回 [{startMs, endMs, used}]：在 [s,e) 上占用量分段恒定，相邻段 used 不同；
// 左闭右开语义由「同一时刻先处理结束事件再处理开始事件」保证。
export function occupancySegments(intervals, s, e) {
  const events = [];
  for (const it of intervals) {
    const a = Math.max(it.startMs, s);
    const b = Math.min(it.endMs, e);
    if (a < b && it.count > 0) {
      events.push({ t: a, d: it.count });
      events.push({ t: b, d: -it.count });
    }
  }
  // 同一时刻：结束（负增量）先于开始（正增量）——左闭右开
  events.sort((x, y) => x.t - y.t || x.d - y.d);

  const segments = [];
  let cur = 0;
  let i = 0;
  let prev = s;
  while (i < events.length && events[i].t <= s) {
    cur += events[i].d;
    i += 1;
  }
  while (i < events.length) {
    const t = events[i].t;
    if (t > prev) segments.push({ startMs: prev, endMs: t, used: cur });
    while (i < events.length && events[i].t === t) {
      cur += events[i].d;
      i += 1;
    }
    prev = t;
  }
  if (prev < e) segments.push({ startMs: prev, endMs: e, used: cur });
  return segments;
}

// ---------- 容量判定 ----------
// usage:       本次预约各规格占用 [{mass, count}]
// capacityOf:  (mass) => 当前录入可选数量（无该规格返回 0）
// overlapping: 与 [startMs,endMs) 重叠的生效中预约 [{startMs, endMs, usage:[{mass,count}]}]
// 返回 { ok, conflicts }；conflicts 元素：
//   { mass, required, capacity, peak, windows:[{start,end,used}] }
//   windows 为「既有占用 + 本次需求 > 当前数量」的合并时段（ISO 字符串）。
export function checkCapacity({ usage, capacityOf, overlapping, startMs, endMs }) {
  const conflicts = [];
  for (const u of usage) {
    if (!(u.count > 0)) continue;
    const capacity = capacityOf(u.mass);
    const intervals = [];
    for (const r of overlapping) {
      const ru = (r.usage || []).find((x) => x.mass === u.mass);
      if (ru && ru.count > 0) {
        intervals.push({ startMs: r.startMs, endMs: r.endMs, count: ru.count });
      }
    }
    const segments = occupancySegments(intervals, startMs, endMs);
    const peak = segments.reduce((m, seg) => Math.max(m, seg.used), 0);
    if (peak + u.count <= capacity) continue;

    // 超限时窗：used > capacity - required 的连续段（相邻合并，used 取段内峰值）
    const limit = capacity - u.count;
    const windows = [];
    for (const seg of segments) {
      if (seg.used <= limit) continue;
      const last = windows[windows.length - 1];
      if (last && last.endMs === seg.startMs) {
        last.endMs = seg.endMs;
        last.used = Math.max(last.used, seg.used);
      } else {
        windows.push({ startMs: seg.startMs, endMs: seg.endMs, used: seg.used });
      }
    }
    conflicts.push({
      mass: u.mass,
      required: u.count,
      capacity,
      peak,
      windows: windows.map((w) => ({
        start: toIso(w.startMs),
        end: toIso(w.endMs),
        used: w.used,
      })),
    });
  }
  return { ok: conflicts.length === 0, conflicts };
}

// ---------- 日程（展示已有占用及不足） ----------
// reservations: 生效中预约 [{startMs, endMs, usage:[{mass,count}]}]
// masses:       需要展示的规格集合（当前录入规格 ∪ 预约涉及规格）
// capacityOf:   (mass) => 当前录入可选数量
// 返回 specs: [{mass, capacity, peak, shortage, segments:[{start,end,used,shortage}]}]
// segments 仅保留 used>0 的区段；shortage 表示该时刻占用超过当前数量（不足）。
export function buildSchedule({ reservations, masses, capacityOf, fromMs, toMs }) {
  const specs = [];
  for (const mass of masses) {
    const capacity = capacityOf(mass);
    const intervals = [];
    for (const r of reservations) {
      const ru = (r.usage || []).find((x) => x.mass === mass);
      if (ru && ru.count > 0) {
        intervals.push({ startMs: r.startMs, endMs: r.endMs, count: ru.count });
      }
    }
    const segments = occupancySegments(intervals, fromMs, toMs)
      .filter((seg) => seg.used > 0)
      .map((seg) => ({
        start: toIso(seg.startMs),
        end: toIso(seg.endMs),
        used: seg.used,
        shortage: seg.used > capacity,
      }));
    const peak = segments.reduce((m, seg) => Math.max(m, seg.used), 0);
    specs.push({
      mass,
      capacity,
      peak,
      shortage: peak > capacity,
      segments,
    });
  }
  return specs;
}
