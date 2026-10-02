// Express 服务：REST API + 静态前端。
// 启动时自动建表；所有集合替换/发布均在 SQLite 事务中完成。

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  loadData,
  currentHash,
  getDraft,
  saveDraft,
  listPublications,
  getPublication,
  insertPublication,
  insertReservation,
  getReservationRowJoined,
  getReservationByBatch,
  listReservationRows,
  cancelReservation,
  getVerificationRow,
  getVerificationRowByPublication,
  createVerification,
  updateVerificationEntries,
  completeVerification,
  listVerificationRows,
} from './db.js';
import { solve, verify, computeHash } from './solver.js';
import { normalizeEntries, measureProgress, verifyMeasurements } from './verify.js';
import {
  parseUtc,
  overlaps,
  planUsage,
  usageToMap,
  checkCapacity,
  occupancyTimeline,
} from './reserve.js';
import {
  ValidationError,
  ConflictError,
  validateConfig,
  validateTubes,
  validateWeights,
} from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // ---------- 状态 ----------

  app.get('/api/state', (req, res) => {
    const data = loadData(db);
    const hash = data ? computeHash(data) : null;
    const rawDraft = getDraft(db);
    let draft = null;
    if (rawDraft) {
      draft = {
        ...rawDraft,
        stale: hash === null || rawDraft.basisHash !== hash,
      };
    }
    const publications = listPublications(db).map((p) => ({
      ...p,
      usable: hash !== null && p.feasible && p.basisHash === hash,
    }));
    res.json({
      data,
      currentHash: hash,
      draft,
      publications,
      reservations: listReservationRows(db).map((r) => serializeReservation(r, hash)),
      verifications: serializeVerifications(db, hash),
    });
  });

  // ---------- 转子配置（整体替换，事务） ----------

  app.put('/api/config', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const clean = validateConfig(body, current);
        db.prepare('DELETE FROM hole_max').run();
        db.prepare('DELETE FROM config').run();
        db.prepare('INSERT INTO config (id, hole_count, tolerance) VALUES (1, ?, ?)').run(
          clean.holes,
          clean.tolerance,
        );
        const ins = db.prepare('INSERT INTO hole_max (hole, max_mass) VALUES (?, ?)');
        clean.holeMaxMass.forEach((m, h) => ins.run(h, m));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 离心管（整表替换，事务） ----------

  app.put('/api/tubes', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const N = current ? current.holes : null;
        const clean = validateTubes(body, N);
        db.prepare('DELETE FROM tube_holes').run();
        db.prepare('DELETE FROM tubes').run();
        const insTube = db.prepare('INSERT INTO tubes (id, mass, ord) VALUES (?, ?, ?)');
        const insHole = db.prepare('INSERT INTO tube_holes (tube_id, hole) VALUES (?, ?)');
        clean.forEach((t, i) => {
          insTube.run(t.id, t.mass, i);
          for (const h of t.usableHoles) insHole.run(t.id, h);
        });
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 配重块（整表替换，事务） ----------

  app.put('/api/weights', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const N = current ? current.holes : null;
        const clean = validateWeights(body, N);
        db.prepare('DELETE FROM weights').run();
        const ins = db.prepare('INSERT INTO weights (mass, quantity) VALUES (?, ?)');
        clean.forEach((w) => ins.run(w.mass, w.quantity));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 重算草稿 ----------

  app.post('/api/solve', (req, res, next) => {
    try {
      const data = loadData(db);
      if (!data) throw new ValidationError(['请先配置转子（孔位数、各孔最大质量、容差）']);
      const hash = computeHash(data);
      const result = solve(data);
      saveDraft(db, {
        basisHash: hash,
        feasible: result.feasible,
        reasons: result.feasible ? [] : result.reasons,
        result,
      });
      res.json({
        basisHash: hash,
        feasible: result.feasible,
        reasons: result.feasible ? [] : result.reasons,
        result,
      });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 发布：事务内重读当前数据 → 求解 → 独立复核 → 冻结 ----------

  app.post('/api/publish', (req, res, next) => {
    try {
      let pubId;
      const tx = db.transaction(() => {
        const data = loadData(db);
        if (!data) throw new ValidationError(['请先配置转子（孔位数、各孔最大质量、容差）']);
        const hash = computeHash(data);
        const result = solve(data);
        if (!result.feasible) {
          throw new ValidationError([
            '当前数据不存在可行装载图，无法发布：',
            ...result.reasons,
          ]);
        }
        // 独立复核：不信任求解器输出本身
        const check = verify(data, result.arrangement);
        if (!check.ok) {
          throw new Error(`发布前独立复核失败：${check.errors.join('；')}`);
        }
        pubId = insertPublication(db, {
          basisHash: hash,
          feasible: true,
          weightCount: check.weightCount,
          diffSum: check.diffSum,
          config: data,
          result,
          reasons: [],
        });
      });
      tx();
      res.status(201).json(getPublication(db, pubId));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/publications', (req, res) => {
    const hash = currentHash(db);
    res.json(
      listPublications(db).map((p) => ({
        ...p,
        usable: hash !== null && p.feasible && p.basisHash === hash,
      })),
    );
  });

  app.get('/api/publications/:id', (req, res, next) => {
    const pub = getPublication(db, Number(req.params.id));
    if (!pub) return res.status(404).json({ error: '发布记录不存在' });
    const hash = currentHash(db);
    res.json({ ...pub, usable: pub.feasible && pub.basisHash === hash });
  });

  // ---------- 配重块预约（时段复用） ----------
  //
  // 语义：批次号为幂等键；时段为 UTC、左闭右开 [start, end)；占用量按冻结图统计。
  // 创建在单个事务内重读发布图、当前可选数量与重叠有效预约：任一规格在任一时刻
  // 超量即整体拒绝（不产生部分占用）。录入数量调减或图失效不改写既有预约，
  // 但后续预约仍按当前数量与图可用性判定；仅未开始的预约可取消，
  // 取消后历史保留、不再计入占用，同批次号重试不会重新占用。

  function serializeReservation(row, hash) {
    return {
      id: row.id,
      batchNo: row.batch_no,
      publicationId: row.publication_id,
      start: row.start_utc,
      end: row.end_utc,
      usage: JSON.parse(row.usage_json),
      status: row.status, // active | cancelled
      createdAt: row.created_at,
      cancelledAt: row.cancelled_at,
      // 仅展示：依据图当前是否仍可用于装载（不影响既有预约本身）
      publicationUsable:
        hash !== null && !!row.pub_feasible && row.pub_basis_hash === hash,
    };
  }

  app.get('/api/reservations', (req, res) => {
    const hash = currentHash(db);
    res.json(listReservationRows(db).map((r) => serializeReservation(r, hash)));
  });

  // 占用日程：窗口 [from, to) 内各质量规格的占用分段 vs 当前可选数量（含不足标记）。
  // from/to 缺省时覆盖全部有效预约的时间跨度；无预约时以当前时刻为空窗口。
  app.get('/api/reservations/occupancy', (req, res, next) => {
    try {
      const errors = [];
      let from = null;
      let to = null;
      if (req.query.from !== undefined) {
        from = parseUtc(String(req.query.from));
        if (!from) errors.push('from 必须是合法 UTC 时间（如 2026-10-03T00:00:00Z）');
      }
      if (req.query.to !== undefined) {
        to = parseUtc(String(req.query.to));
        if (!to) errors.push('to 必须是合法 UTC 时间（如 2026-10-08T00:00:00Z）');
      }
      if (errors.length) throw new ValidationError(errors);

      const active = listReservationRows(db).filter((r) => r.status === 'active');
      const explicit = req.query.from !== undefined || req.query.to !== undefined;
      if (!from || !to) {
        if (active.length > 0) {
          if (!from) from = active.map((r) => r.start_utc).sort()[0];
          if (!to) to = active.map((r) => r.end_utc).sort()[active.length - 1];
        } else {
          const now = new Date().toISOString();
          if (!from) from = now;
          if (!to) to = now;
        }
      }
      if (explicit && !(from < to)) {
        throw new ValidationError(['from 必须早于 to（时段按左闭右开 [from, to) 计算）']);
      }

      const data = loadData(db);
      const quantities = new Map(
        (data ? data.weights : []).map((w) => [w.mass, w.quantity]),
      );
      const prepared = active.map((r) => ({
        start: r.start_utc,
        end: r.end_utc,
        usage: usageToMap(JSON.parse(r.usage_json)),
      }));
      const massSet = new Set(quantities.keys());
      for (const r of prepared) {
        for (const m of r.usage.keys()) massSet.add(m);
      }
      const masses = [...massSet].sort((a, b) => a - b);

      const timeline = occupancyTimeline({ from, to, reservations: prepared, masses });
      const specs = masses.map((mass) => {
        const segments = timeline.get(mass) || [];
        const peak = segments.reduce((mx, s) => Math.max(mx, s.occupied), 0);
        const quantity = quantities.has(mass) ? quantities.get(mass) : 0;
        return { mass, quantity, peak, exceeded: peak > quantity, segments };
      });
      res.json({ from, to, specs });
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/reservations/:id', (req, res, next) => {
    const row = getReservationRowJoined(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '预约不存在' });
    res.json(serializeReservation(row, currentHash(db)));
  });

  // 创建预约：事务内重读图 / 当前数量 / 重叠预约；同批次号幂等。
  app.post('/api/reservations', (req, res, next) => {
    try {
      const body = req.body || {};
      const errors = [];
      const batchNo = typeof body.batchNo === 'string' ? body.batchNo.trim() : '';
      if (!batchNo) errors.push('批次号不能为空');
      const publicationId = Number(body.publicationId);
      if (!Number.isInteger(publicationId)) {
        errors.push('publicationId 必须是发布记录编号（整数）');
      }
      const start = parseUtc(body.start);
      const end = parseUtc(body.end);
      if (!start) {
        errors.push('开始时间必须是合法 UTC 时间（如 2026-10-03T08:00:00Z）');
      }
      if (!end) {
        errors.push('结束时间必须是合法 UTC 时间（如 2026-10-03T12:00:00Z）');
      }
      if (start && end && !(start < end)) {
        errors.push('开始时间必须早于结束时间（时段按左闭右开 [start, end) 计算）');
      }
      if (errors.length) throw new ValidationError(errors);

      let status = 201;
      let detail;
      const tx = db.transaction(() => {
        // 幂等：同批次号重复提交 —— 内容一致返回原记录（含已取消的，不重新占用），
        // 内容不同直接拒绝。
        const existing = getReservationByBatch(db, batchNo);
        if (existing) {
          const same =
            existing.publication_id === publicationId &&
            existing.start_utc === start &&
            existing.end_utc === end;
          if (!same) {
            throw new ConflictError(
              [
                `批次号「${batchNo}」已用于预约 #${existing.id}（发布图 #${existing.publication_id}，` +
                  `${existing.start_utc} – ${existing.end_utc}），本次内容不同，已拒绝`,
              ],
              { existingId: existing.id },
            );
          }
          detail = serializeReservation(
            getReservationRowJoined(db, existing.id),
            currentHash(db),
          );
          status = 200;
          return;
        }

        // 原子重读：发布图（须当前可用）、当前可选数量、重叠的有效预约
        const pub = getPublication(db, publicationId);
        if (!pub) throw new ValidationError([`发布记录 #${publicationId} 不存在（未知装载图）`]);
        if (!pub.feasible) {
          throw new ValidationError([`发布记录 #${publicationId} 不含可行装载图，不能据此预约`]);
        }
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ValidationError([
            `发布记录 #${publicationId} 当前不可用于装载（录入数据已变化），不能据此预约`,
          ]);
        }

        const usage = planUsage(pub.result);
        const data = loadData(db);
        const quantities = new Map(data.weights.map((w) => [w.mass, w.quantity]));
        const overlapping = listReservationRows(db)
          .filter(
            (r) =>
              r.status === 'active' && overlaps(r.start_utc, r.end_utc, start, end),
          )
          .map((r) => ({
            start: r.start_utc,
            end: r.end_utc,
            usage: usageToMap(JSON.parse(r.usage_json)),
          }));
        const conflicts = checkCapacity({
          start,
          end,
          newUsage: usageToMap(usage),
          existing: overlapping,
          quantities,
        });
        if (conflicts.length > 0) {
          const msgs = conflicts.map((c) => {
            const slots = c.slots
              .map((s) => `${s.start} – ${s.end} 已占用 ${s.occupied} 枚`)
              .join('；');
            return (
              `质量 ${c.mass} g 的配重块不足：本次需 ${c.needed} 枚、` +
              `当前可选 ${c.available} 枚（${slots}）`
            );
          });
          throw new ConflictError(
            ['配重块可选数量不足，未产生任何占用：', ...msgs],
            { detail: { conflicts } },
          );
        }

        const id = insertReservation(db, { batchNo, publicationId, start, end, usage });
        detail = serializeReservation(getReservationRowJoined(db, id), hash);
      });
      tx();
      res.status(status).json(detail);
    } catch (e) {
      next(e);
    }
  });

  // 取消：仅未开始的预约可取消；重复取消幂等返回历史记录。
  app.post('/api/reservations/:id/cancel', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getReservationRowJoined(db, id);
      if (!existed) return res.status(404).json({ error: '预约不存在' });

      let detail;
      const tx = db.transaction(() => {
        const row = getReservationRowJoined(db, id);
        if (row.status === 'cancelled') {
          // 幂等：已取消的预约直接返回历史记录，不重新占用
          detail = serializeReservation(row, currentHash(db));
          return;
        }
        const now = new Date().toISOString();
        if (!(now < row.start_utc)) {
          throw new ConflictError([
            `预约 #${id} 已开始（${row.start_utc}），仅未开始的预约可取消`,
          ]);
        }
        const updated = cancelReservation(db, id, now);
        if (!updated) throw new Error('预约取消写入失败');
        detail = serializeReservation(getReservationRowJoined(db, id), currentHash(db));
      });
      tx();
      res.json(detail);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 现场装载核验 ----------
  //
  // 流程：POST 选择可用发布记录建立草稿（同一发布记录只保留一份）→
  //       PUT 按孔位暂存实际物件编号/实测质量（携带 version 乐观锁，可反复暂存恢复）→
  //       POST .../complete 在单事务内重读发布快照与当前数据做最终判定。
  // 完成后结果冻结：重复完成不产生第二份结果，后续 PUT 被拒绝。

  // 列表项：进度 + 完成状态 + 发布记录当前可用性
  function verificationSummary(row, hash) {
    const pub = getPublication(db, row.publication_id);
    const entries = JSON.parse(row.entries_json);
    const progress = measureProgress(
      { config: pub.config, result: pub.result },
      entries,
    );
    const completed = !!row.completed_at;
    return {
      id: row.id,
      publicationId: row.publication_id,
      version: row.version,
      completed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      progress,
      usable: hash !== null && !!row.pub_basis_hash && row.pub_basis_hash === hash,
      ...(completed
        ? { diffSum: row.diff_sum, massSum: row.mass_sum }
        : {}),
    };
  }

  function serializeVerifications(dbArg, hash) {
    return listVerificationRows(dbArg).map((row) => verificationSummary(row, hash));
  }

  // 详情（草稿或完成均返回；完成时附冻结的判定明细与冻结实测值）
  function verificationDetail(row) {
    const pub = getPublication(db, row.publication_id);
    const hash = currentHash(db);
    const entries = JSON.parse(row.entries_json);
    const completed = !!row.completed_at;
    const progress = measureProgress(
      { config: pub.config, result: pub.result },
      entries,
    );
    const detail = {
      id: row.id,
      publicationId: row.publication_id,
      version: row.version,
      completed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      progress,
      usable: hash !== null && pub.feasible && pub.basisHash === hash,
      publication: {
        id: pub.id,
        createdAt: pub.createdAt,
        basisHash: pub.basisHash,
        config: pub.config,
        result: pub.result,
      },
      // 草稿阶段为当前暂存录入；完成后即为冻结实测值
      entries,
    };
    if (completed) {
      detail.diffSum = row.diff_sum;
      detail.massSum = row.mass_sum;
      detail.checks = JSON.parse(row.checks_json);
      detail.frozenEntries = JSON.parse(row.result_json);
    }
    return detail;
  }

  // 建立核验草稿：仅允许针对「当前仍可用」的可行发布记录
  app.post('/api/verifications', (req, res, next) => {
    try {
      const publicationId = Number(req.body && req.body.publicationId);
      if (!Number.isInteger(publicationId)) {
        throw new ValidationError(['publicationId 必须是发布记录编号（整数）']);
      }
      let detail;
      const tx = db.transaction(() => {
        const pub = getPublication(db, publicationId);
        if (!pub) throw new ValidationError(['发布记录不存在']);
        if (!pub.feasible) {
          throw new ValidationError([`发布记录 #${publicationId} 不含可行装载图，无法核验`]);
        }
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ValidationError([
            `发布记录 #${publicationId} 当前不可用于装载（录入数据已变化），请选择仍可用的发布记录`,
          ]);
        }
        const existing = getVerificationRowByPublication(db, publicationId);
        if (existing) {
          throw new ConflictError(
            [
              existing.completed_at
                ? `发布记录 #${publicationId} 的核验已完成（结果已冻结），不能再建草稿`
                : `发布记录 #${publicationId} 已存在未完成核验，请直接恢复该草稿`,
            ],
            { existingId: existing.id, completed: !!existing.completed_at },
          );
        }
        const N = pub.config.holes;
        const emptyEntries = Array.from({ length: N }, (_, h) => ({
          hole: h,
          ref: '',
          mass: 0,
        }));
        const row = createVerification(db, publicationId, emptyEntries);
        detail = verificationDetail(row);
      });
      tx();
      res.status(201).json(detail);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/verifications', (req, res) => {
    res.json(serializeVerifications(db, currentHash(db)));
  });

  app.get('/api/verifications/:id', (req, res, next) => {
    const row = getVerificationRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '核验记录不存在' });
    res.json(verificationDetail(row));
  });

  // 暂存：整表替换孔位录入；version 不匹配（他人已改）→ 409，拒绝覆盖
  app.put('/api/verifications/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const row0 = getVerificationRow(db, id);
      if (!row0) return res.status(404).json({ error: '核验记录不存在' });
      if (row0.completed_at) {
        throw new ConflictError(['核验已完成，实测值与判定结果已冻结，不能再修改']);
      }
      const expectedVersion = req.body && req.body.version;
      if (!Number.isInteger(expectedVersion)) {
        throw new ValidationError(['更新核验必须携带整数 version（用于防止覆盖他人修改）']);
      }
      if (expectedVersion !== row0.version) {
        throw new ConflictError(
          [`核验数据已被他人更新（当前版本 ${row0.version}），请先恢复最新草稿再提交`],
          { currentVersion: row0.version },
        );
      }
      const pub = getPublication(db, row0.publication_id);
      const { errors, entries } = normalizeEntries(req.body && req.body.entries, pub.config.holes);
      if (errors.length) throw new ValidationError(errors);

      const row = updateVerificationEntries(db, id, expectedVersion, entries);
      if (!row) {
        // 并发情况下版本/状态已被其他事务抢先改变
        const fresh = getVerificationRow(db, id);
        throw new ConflictError(
          [fresh && fresh.completed_at ? '核验刚被完成并冻结' : '核验版本已变化，请恢复最新草稿后再提交'],
          { currentVersion: fresh ? fresh.version : null },
        );
      }
      res.json(verificationDetail(row));
    } catch (e) {
      next(e);
    }
  });

  // 完成核验：同一事务内重读发布快照与当前数据并独立判定
  app.post('/api/verifications/:id/complete', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getVerificationRow(db, id);
      if (!existed) return res.status(404).json({ error: '核验记录不存在' });

      let status = 200;
      let detail;
      const tx = db.transaction(() => {
        const row = getVerificationRow(db, id);

        // 幂等：重复完成不产生第二份结果，直接返回冻结结果
        if (row.completed_at) {
          detail = verificationDetail(row);
          status = 200;
          return;
        }

        const pub = getPublication(db, row.publication_id);
        if (!pub || !pub.feasible) {
          throw new ValidationError([
            `发布记录 #${row.publication_id} 不含可行冻结装载图，无法完成核验`,
          ]);
        }
        // 发布记录仍可用于当前装载？
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ValidationError([
            `发布记录 #${pub.id} 已不可用于当前装载（录入数据已变化），核验不能完成；草稿已保留`,
          ]);
        }

        // 重读当前暂存录入并做结构规整（不合法也保留草稿）
        const entries = JSON.parse(row.entries_json);
        const N = pub.config.holes;
        if (!Array.isArray(entries) || entries.length !== N) {
          throw new ValidationError(['暂存的核验录入与冻结图孔位数不符，草稿已保留']);
        }
        for (const e of entries) {
          const m = e && e.mass;
          const hasRef = e && typeof e.ref === 'string' && e.ref !== '';
          if (
            !e ||
            typeof m !== 'number' ||
            !Number.isFinite(m) ||
            (hasRef ? !(m > 0) : m !== 0)
          ) {
            throw new ValidationError([
              `孔 ${e ? e.hole : '?'} 录入不完整或质量非法：有物件时质量须为有限正数，空孔质量须为 0`,
            ]);
          }
        }

        // 独立判定：物件一致性、孔承重、对径容差（全部定位到孔位/孔对）
        const verdict = verifyMeasurements(
          { config: pub.config, result: pub.result },
          entries,
        );
        if (!verdict.ok) {
          throw new ValidationError(
            ['核验不通过，草稿已保留、未生成完成记录：', ...verdict.errors],
            { checks: verdict.checks, version: row.version },
          );
        }

        const updated = completeVerification(db, id, {
          checks: verdict.checks,
          diffSum: verdict.diffSum,
          massSum: verdict.massSum,
        });
        if (!updated) throw new Error('核验完成写入失败');
        detail = verificationDetail(updated);
        status = 201;
      });
      tx();
      res.status(status).json(detail);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 静态前端 ----------

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- 错误处理 ----------

  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) {
      return res
        .status(400)
        .json({ error: err.message, errors: err.errors, ...(err.detail ? { detail: err.detail } : {}) });
    }
    if (err instanceof ConflictError) {
      return res.status(409).json({
        error: err.message,
        errors: err.errors,
        ...(err.existingId != null ? { existingId: err.existingId } : {}),
        ...(err.completed != null ? { completed: err.completed } : {}),
        ...(err.currentVersion != null ? { currentVersion: err.currentVersion } : {}),
        ...(err.detail ? { detail: err.detail } : {}),
      });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: '请求体不是合法 JSON', errors: ['请求体不是合法 JSON'] });
    }
    console.error(err);
    res.status(500).json({ error: '服务器内部错误', errors: [String(err && err.message)] });
  });

  return app;
}

function start() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'rotor.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const app = createApp(db);
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`离心转子配平服务已启动: http://localhost:${port}  (数据库: ${dbPath})`);
  });
}

// 仅在直接运行时监听端口（测试中 import 不触发）
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  start();
}
