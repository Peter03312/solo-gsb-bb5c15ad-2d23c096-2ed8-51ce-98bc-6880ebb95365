// 离心转子配平求解器（纯函数，无数据库依赖，便于测试与发布前独立复核）
//
// 模型：
//   孔位编号 0..N-1（N 为 4..12 的偶数），孔 i 与孔 i+N/2 对径。
//   每孔最多放置一件物件（一支离心管或一枚配重块），也可留空（质量按 0 计）。
//   全部离心管必须装入；每个配重质量组有若干枚，每枚最多使用一次。
//   任一孔内物件质量不得超过该孔最大承重；每对对径孔质量差不得超过容差。
//
// 优化目标（字典序）：
//   1) 使用配重块数量最少
//   2) 各对径孔质量差之和最小
//   3) 按孔位编号排列的物件编号序列字典序最小；
//      物件次序约定：离心管（编号字符串）< 配重块（质量组序号, 组内序号）< 空孔，
//      即同分方案优先让小编号离心管占据低编号孔位。
//
// 算法：按对径对逐对做动态规划。状态 = 已用离心管位图 + 各配重组已用数量；
// 同一状态只保留目标三元组 (配重数, 差和, 孔位物件序列前缀) 最优的路径。

import crypto from 'node:crypto';

export const EPS = 1e-7;

const EMPTY = Object.freeze({ t: 2 });

// ---------- 基础工具 ----------

export function leqDiff(a, b, tol) {
  return Math.abs(a - b) <= tol + EPS;
}

export function canonicalData(data) {
  const canon = (x) => {
    if (Array.isArray(x)) return x.map(canon);
    if (x !== null && typeof x === 'object') {
      return Object.fromEntries(
        Object.keys(x).sort().map((k) => [k, canon(x[k])]),
      );
    }
    return x;
  };
  return canon(data);
}

export function computeHash(data) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalData(data)))
    .digest('hex');
}

// 孔位序列中单个槽位的比较
function cmpSlot(a, b) {
  if (a.t !== b.t) return a.t - b.t;
  if (a.t === 1) {
    if (a.g !== b.g) return a.g - b.g;
    return a.k - b.k;
  }
  if (a.t === 0) {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  }
  return 0;
}

// 槽位序列字典序比较
function cmpKey(ka, kb) {
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i += 1) {
    const c = cmpSlot(ka[i], kb[i]);
    if (c !== 0) return c;
  }
  return ka.length - kb.length;
}

// 目标三元组：<0 表示 a 更优
function cmpObjective(a, b) {
  if (a.wc !== b.wc) return a.wc - b.wc;
  const dd = a.diff - b.diff;
  if (Math.abs(dd) > EPS) return dd;
  return cmpKey(a.key, b.key);
}

// ---------- 求解 ----------

export function solve(data) {
  const N = data.holes;
  const m = N / 2;
  const tol = data.tolerance;
  const maxMass = data.holeMaxMass;
  const tubes = data.tubes.map((t) => ({ ...t })).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const T = tubes.length;
  const groups = data.weights
    .map((w, g) => ({ g, mass: w.mass, q: Math.min(w.quantity, N) }))
    .sort((a, b) => a.mass - b.mass)
    .map((w, idx) => ({ ...w, g: idx }));
  const G = groups.length;

  const reasons = [];
  if (T > N) {
    reasons.push(`离心管数量（${T}）超过转子孔位总数（${N}）`);
  }
  for (const t of tubes) {
    const cap = Math.max(...t.usableHoles.map((h) => maxMass[h]));
    if (t.mass > cap + EPS) {
      reasons.push(
        `离心管「${t.id}」质量 ${t.mass} 超过其全部可用孔位的最大承重（${cap}）`,
      );
    }
  }
  if (reasons.length > 0) return { feasible: false, reasons };

  // 配重组混合基数编码
  const stride = new Array(G);
  let wbase = 1;
  for (let g = 0; g < G; g += 1) {
    stride[g] = wbase;
    wbase *= groups[g].q + 1;
  }

  // 某孔位可放置的物件清单
  const fillsAt = (h) => {
    const fills = [{ empty: true, mass: 0, slot: EMPTY }];
    for (let idx = 0; idx < T; idx += 1) {
      const t = tubes[idx];
      if (t.usableHoles.includes(h) && t.mass <= maxMass[h] + EPS) {
        fills.push({
          empty: false,
          kind: 'tube',
          idx,
          ref: t.id,
          mass: t.mass,
          slot: { t: 0, id: t.id },
        });
      }
    }
    for (const grp of groups) {
      if (grp.mass <= maxMass[h] + EPS) {
        for (let k = 0; k < grp.q; k += 1) {
          fills.push({
            empty: false,
            kind: 'weight',
            g: grp.g,
            k,
            ref: weightRef(grp.g, k),
            mass: grp.mass,
            slot: { t: 1, g: grp.g, k },
          });
        }
      }
    }
    return fills;
  };

  const sameInstance = (a, b) => {
    if (a.empty || b.empty) return false;
    if (a.kind === 'tube' && b.kind === 'tube') return a.idx === b.idx;
    if (a.kind === 'weight' && b.kind === 'weight')
      return a.g === b.g && a.k === b.k;
    return false;
  };

  // 每个对径对的合法放置选项
  const pairOptions = [];
  for (let i = 0; i < m; i += 1) {
    const holeA = i;
    const holeB = i + m;
    const opts = [];
    for (const fa of fillsAt(holeA)) {
      for (const fb of fillsAt(holeB)) {
        if (sameInstance(fa, fb)) continue;
        if (!leqDiff(fa.mass, fb.mass, tol)) continue;
        let mask = 0;
        const counts = new Array(G).fill(0);
        const placements = [];
        for (const [hole, f] of [
          [holeA, fa],
          [holeB, fb],
        ]) {
          if (f.empty) continue;
          if (f.kind === 'tube') mask |= 1 << f.idx;
          else counts[f.g] += 1;
          placements.push({
            hole,
            kind: f.kind,
            ref: f.ref,
            mass: f.mass,
            ...(f.kind === 'weight' ? { g: f.g, k: f.k } : {}),
          });
        }
        let wdelta = 0;
        for (let g = 0; g < G; g += 1) wdelta += counts[g] * stride[g];
        opts.push({
          mask,
          counts,
          wdelta,
          wc: placements.filter((p) => p.kind === 'weight').length,
          diff: Math.abs(fa.mass - fb.mass),
          key: [fa.slot, fb.slot],
          placements,
        });
      }
    }
    if (opts.length === 0) {
      reasons.push(
        `对径孔对（${holeA} ↔ ${holeB}）不存在满足承重与容差的放置方式`,
      );
      return { feasible: false, reasons };
    }
    pairOptions.push(opts);
  }

  // DP：stateKey -> 最优路径
  let states = new Map();
  states.set(0, {
    mask: 0,
    wcode: 0,
    counts: new Array(G).fill(0),
    wc: 0,
    diff: 0,
    key: [],
    placements: [],
  });

  for (let i = 0; i < m; i += 1) {
    const next = new Map();
    for (const st of states.values()) {
      for (const opt of pairOptions[i]) {
        if (st.mask & opt.mask) continue;
        let wcode = st.wcode;
        let counts = st.counts;
        let ok = true;
        for (let g = 0; g < G; g += 1) {
          if (opt.counts[g] > 0) {
            const ng = st.counts[g] + opt.counts[g];
            if (ng > groups[g].q) {
              ok = false;
              break;
            }
            if (counts === st.counts) counts = st.counts.slice();
            counts[g] = ng;
            wcode += opt.counts[g] * stride[g];
          }
        }
        if (!ok) continue;

        const candidate = {
          mask: st.mask | opt.mask,
          wcode,
          counts,
          wc: st.wc + opt.wc,
          diff: st.diff + opt.diff,
          key: st.key.concat(opt.key),
          placements: st.placements.concat(opt.placements),
        };
        const stateKey = candidate.mask * wbase + wcode;
        const old = next.get(stateKey);
        if (!old || cmpObjective(candidate, old) < 0) next.set(stateKey, candidate);
      }
    }
    states = next;
    if (states.size === 0) break;
  }

  const fullMask = T === 0 ? 0 : (1 << T) - 1;
  let best = null;
  for (const st of states.values()) {
    if (st.mask !== fullMask) continue;
    if (!best || cmpObjective(st, best) < 0) best = st;
  }

  if (!best) {
    return {
      feasible: false,
      reasons: ['穷举全部放置组合后，不存在满足全部约束的装载图'],
    };
  }

  const arrangement = new Array(N).fill(null);
  // 配重块同质量物理等价，状态只区分“某组用了几枚”；
  // 输出时按孔位升序对每组实际使用的配重重新编号，保证编号唯一（#组-1..k）。
  const wSeen = groups.map(() => 0);
  const byHole = new Map(best.placements.map((p) => [p.hole, p]));
  for (let h = 0; h < N; h += 1) {
    const p = byHole.get(h);
    if (!p) continue;
    let ref = p.ref;
    if (p.kind === 'weight') {
      ref = weightRef(p.g, wSeen[p.g]);
      wSeen[p.g] += 1;
    }
    arrangement[h] = { kind: p.kind, ref, mass: p.mass };
  }
  const pairs = [];
  for (let i = 0; i < m; i += 1) {
    const massA = arrangement[i] ? arrangement[i].mass : 0;
    const massB = arrangement[i + m] ? arrangement[i + m].mass : 0;
    pairs.push({
      a: i,
      b: i + m,
      massA,
      massB,
      diff: Math.abs(massA - massB),
      withinTolerance: leqDiff(massA, massB, tol),
    });
  }

  return {
    feasible: true,
    arrangement,
    pairs,
    weightCount: best.wc,
    diffSum: pairs.reduce((s, p) => s + p.diff, 0),
  };
}

export function weightRef(g, k) {
  return `配重#${g + 1}-${k + 1}`;
}

// ---------- 独立复核（发布时使用，不信任求解器输出） ----------

export function verify(data, arrangement) {
  const errors = [];
  const N = data.holes;
  const tol = data.tolerance;
  const numEq = (x, y) => Math.abs(x - y) <= EPS;

  if (!Array.isArray(arrangement) || arrangement.length !== N) {
    return { ok: false, errors: ['装载图长度与孔位数不符'], weightCount: 0, diffSum: 0 };
  }

  const tubeMap = new Map(data.tubes.map((t) => [t.id, t]));
  const seenTubes = new Set();
  // 配重组按质量升序编号，与求解器一致
  const groups = data.weights
    .map((w) => ({ mass: w.mass, quantity: w.quantity }))
    .sort((a, b) => a.mass - b.mass);
  const usedWeights = groups.map(() => 0);
  const weightInstances = new Set();
  const usedHoles = new Set();
  let weightCount = 0;

  const refRe = /^配重#(\d+)-(\d+)$/;

  arrangement.forEach((slot, h) => {
    if (slot === null) return;
    if (usedHoles.has(h)) errors.push(`孔 ${h} 放置了多件物件`);
    usedHoles.add(h);
    if (
      typeof slot !== 'object' ||
      (slot.kind !== 'tube' && slot.kind !== 'weight')
    ) {
      errors.push(`孔 ${h} 的物件类型无法识别`);
      return;
    }
    if (typeof slot.mass !== 'number' || !Number.isFinite(slot.mass) || slot.mass < 0) {
      errors.push(`孔 ${h} 的物件质量非法`);
      return;
    }
    if (slot.mass > data.holeMaxMass[h] + EPS) {
      errors.push(`孔 ${h} 物件质量 ${slot.mass} 超过最大承重 ${data.holeMaxMass[h]}`);
    }

    if (slot.kind === 'tube') {
      const t = tubeMap.get(slot.ref);
      if (!t) {
        errors.push(`孔 ${h} 使用了不存在的离心管「${slot.ref}」`);
        return;
      }
      if (seenTubes.has(t.id)) errors.push(`离心管「${t.id}」被重复放置`);
      seenTubes.add(t.id);
      if (!numEq(slot.mass, t.mass)) {
        errors.push(`孔 ${h} 离心管「${t.id}」质量与录入数据不一致`);
      }
      if (!t.usableHoles.includes(h)) {
        errors.push(`离心管「${t.id}」被放入其不可用孔位 ${h}`);
      }
    } else {
      const mt = String(slot.ref).match(refRe);
      if (!mt) {
        errors.push(`孔 ${h} 配重编号「${slot.ref}」无法识别`);
        return;
      }
      const g = Number(mt[1]) - 1;
      const k = Number(mt[2]) - 1;
      if (g < 0 || g >= groups.length) {
        errors.push(`孔 ${h} 配重「${slot.ref}」所属质量组不存在`);
        return;
      }
      if (!numEq(slot.mass, groups[g].mass)) {
        errors.push(`孔 ${h} 配重「${slot.ref}」质量与录入数据不一致`);
      }
      if (k < 0 || k >= groups[g].quantity) {
        errors.push(`孔 ${h} 使用了超出库存数量的配重「${slot.ref}」`);
        return;
      }
      const instKey = `${g}:${k}`;
      if (weightInstances.has(instKey)) {
        errors.push(`配重「${slot.ref}」被重复使用（每枚最多用一次）`);
        return;
      }
      weightInstances.add(instKey);
      usedWeights[g] += 1;
      if (usedWeights[g] > groups[g].quantity) {
        errors.push(`质量 ${groups[g].mass} 的配重块使用数量超过库存`);
      }
      weightCount += 1;
    }
  });

  for (const t of data.tubes) {
    if (!seenTubes.has(t.id)) errors.push(`离心管「${t.id}」未被装入转子`);
  }

  let diffSum = 0;
  const m = N / 2;
  for (let i = 0; i < m; i += 1) {
    const ma = arrangement[i] ? arrangement[i].mass : 0;
    const mb = arrangement[i + m] ? arrangement[i + m].mass : 0;
    const d = Math.abs(ma - mb);
    diffSum += d;
    if (d > tol + EPS) {
      errors.push(`对径孔对（${i} ↔ ${i + m}）质量差 ${d} 超过容差 ${tol}`);
    }
  }

  return { ok: errors.length === 0, errors, weightCount, diffSum };
}
