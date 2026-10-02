// 配重块预约：UTC 时段占用统计与容量判定（纯函数，无数据库依赖，便于测试）。
//
// 语义约定：
//   - 时段一律按左闭右开 [start, end) 计算，起点须早于终点；
//   - 时间统一为 UTC ISO 字符串（Date.prototype.toISOString 的定长格式，
//     字典序即时间序，可直接比较与排序）；
//   - 占用量按冻结装载图统计（图中每枚配重块计入其质量规格 ×1）；
//   - 容量规则：任一时刻，同一质量规格的「有效预约占用总量」不得超过
//     当前录入的该规格可选数量；既有预约不因数量调减或图失效而被改写，
//     但后续预约一律按当前数量与图可用性判定。

// 解析 UTC 时间：要求显式携带 Z 或 ±HH:MM 时区偏移（避免本地时区歧义）。
// 合法 → 规范 ISO 字符串（toISOString）；非法 → null。
export function parseUtc(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

// 半开区间重叠判定：[aStart,aEnd) 与 [bStart,bEnd) 是否共有时刻（首尾相接不算重叠）
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// 冻结装载图 → 各质量规格占用 [{mass, count}]（按质量升序）
export function planUsage(result) {
  const counts = new Map();
  if (result && Array.isArray(result.arrangement)) {
    for (const slot of result.arrangement) {
      if (slot && slot.kind === 'weight' && typeof slot.mass === 'number') {
        counts.set(slot.mass, (counts.get(slot.mass) || 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([mass, count]) => ({ mass, count }))
    .sort((a, b) => a.mass - b.mass);
}

// 占用数组 [{mass,count}] → Map<mass, count>（输入为 Map 时返回副本）
export function usageToMap(usage) {
  if (usage instanceof Map) return new Map(usage);
  const m = new Map();
  if (Array.isArray(usage)) {
    for (const u of usage) {
      if (u && typeof u.mass === 'number' && u.count > 0) {
        m.set(u.mass, (m.get(u.mass) || 0) + u.count);
      }
    }
  }
  return m;
}

// 扫描线：窗口 [from, to) 内各质量规格的占用分段。
//   reservations: [{start, end, usage}]（usage 为数组或 Map；状态/重叠由调用方过滤）
//   返回 Map<mass, [{start, end, occupied}]>，相邻同值段已合并；
//   includeZero=true 时保留占用为 0 的段（容量判定用），默认只返回有占用的段（展示用）。
export function occupancyTimeline({ from, to, reservations, masses, includeZero = false }) {
  const prepared = reservations.map((r) => ({
    start: r.start,
    end: r.end,
    usage: usageToMap(r.usage),
  }));
  const result = new Map();
  for (const mass of masses) {
    const points = new Set([from, to]);
    const rel = [];
    for (const r of prepared) {
      const u = r.usage.get(mass) || 0;
      if (u <= 0) continue;
      const s = r.start < from ? from : r.start;
      const e = r.end > to ? to : r.end;
      if (s < e) {
        rel.push({ s, e, count: u });
        points.add(s);
        points.add(e);
      }
    }
    const pts = [...points].sort();
    const segs = [];
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      if (a >= b) continue;
      let occ = 0;
      for (const r of rel) {
        if (r.s <= a && a < r.e) occ += r.count;
      }
      if (occ === 0 && !includeZero) continue;
      const last = segs[segs.length - 1];
      if (last && last.occupied === occ && last.end === a) last.end = b;
      else segs.push({ start: a, end: b, occupied: occ });
    }
    result.set(mass, segs);
  }
  return result;
}

// 容量判定：在 [start, end) 加入新占用 newUsage（Map）后，任一时刻
// 「既有占用 + 本次需求」不得超过 quantities（Map）中的当前可选数量。
// 返回冲突明细数组（[] 表示可约）：
//   [{ mass, available, needed, slots: [{start, end, occupied, required}] }]
export function checkCapacity({ start, end, newUsage, existing, quantities }) {
  const masses = [...newUsage.keys()].filter((m) => newUsage.get(m) > 0);
  const timeline = occupancyTimeline({
    from: start,
    to: end,
    reservations: existing,
    masses,
    includeZero: true,
  });
  const conflicts = [];
  for (const mass of masses) {
    const need = newUsage.get(mass);
    const available = quantities.has(mass) ? quantities.get(mass) : 0;
    const slots = [];
    for (const seg of timeline.get(mass) || []) {
      const required = seg.occupied + need;
      if (required > available) {
        slots.push({
          start: seg.start,
          end: seg.end,
          occupied: seg.occupied,
          required,
        });
      }
    }
    if (slots.length > 0) conflicts.push({ mass, available, needed: need, slots });
  }
  return conflicts;
}
