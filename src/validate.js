// 输入校验。任何一条不合法即抛出 ValidationError（HTTP 400），
// 调用方据此整体回滚，绝不写入部分数据。

export class ValidationError extends Error {
  constructor(errors, detail = null) {
    super(Array.isArray(errors) ? errors.join('；') : errors);
    this.errors = Array.isArray(errors) ? errors : [errors];
    this.status = 400;
    this.detail = detail;
  }
}

// 409：状态冲突（核验草稿已存在 / 版本过期 / 记录已冻结等）
export class ConflictError extends Error {
  constructor(errors, extra = {}) {
    super(Array.isArray(errors) ? errors.join('；') : errors);
    this.errors = Array.isArray(errors) ? errors : [errors];
    this.status = 409;
    Object.assign(this, extra);
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

const WEIGHT_REF_RE = /^配重#\d+-\d+$/;

function assert(cond, errors, msg) {
  if (!cond) errors.push(msg);
}

export function validateConfig(input, currentData) {
  const errors = [];
  assert(input !== null && typeof input === 'object', errors, '请求体必须是对象');
  if (errors.length) throw new ValidationError(errors);

  const { holes, tolerance, holeMaxMass } = input;

  assert(
    isInt(holes) && holes >= 4 && holes <= 12 && holes % 2 === 0,
    errors,
    '孔位数必须是 4 至 12 之间的偶数',
  );

  assert(isNum(tolerance) && tolerance >= 0, errors, '允许对径差必须是非负数');

  assert(Array.isArray(holeMaxMass), errors, '各孔最大质量必须是数组');
  if (Array.isArray(holeMaxMass)) {
    if (isInt(holes) && holes >= 4 && holes <= 12) {
      assert(
        holeMaxMass.length === holes,
        errors,
        `各孔最大质量数组长度必须为 ${holes}`,
      );
    }
    holeMaxMass.forEach((m, i) => {
      assert(isNum(m) && m > 0, errors, `孔 ${i} 的最大质量必须为正数（当前：${m}）`);
    });
  }

  // 缩小孔位范围前，现有离心管的可用孔位不得越界
  if (errors.length === 0 && currentData) {
    for (const t of currentData.tubes) {
      const bad = t.usableHoles.filter((h) => h >= holes);
      if (bad.length > 0) {
        errors.push(
          `缩小孔位至 ${holes} 会使离心管「${t.id}」的可用孔位 ${bad.join(', ')} 越界，请先修改该离心管`,
        );
      }
    }
  }

  if (errors.length) throw new ValidationError(errors);
  return { holes, tolerance, holeMaxMass: holeMaxMass.map(Number) };
}

export function validateTubes(input, N) {
  const errors = [];
  assert(Array.isArray(input), errors, '离心管列表必须是数组');
  if (!Array.isArray(input)) throw new ValidationError(errors);
  if (N === null) throw new ValidationError(['请先配置转子孔位数']);

  const seen = new Set();
  const normalized = input.map((row, i) => {
    const where = `第 ${i + 1} 行离心管`;
    assert(row !== null && typeof row === 'object', errors, `${where}格式不正确`);
    if (!row || typeof row !== 'object') return null;

    const id = typeof row.id === 'string' ? row.id.trim() : '';
    assert(id.length > 0, errors, `${where}编号不能为空`);
    assert(!WEIGHT_REF_RE.test(id), errors, `${where}编号「${id}」为系统保留格式（配重#x-y）`);
    if (id) {
      assert(!seen.has(id), errors, `离心管编号「${id}」重复`);
      seen.add(id);
    }

    assert(isNum(row.mass) && row.mass > 0, errors, `${where}「${id || i}」质量必须为正数（当前：${row.mass}）`);

    assert(Array.isArray(row.usableHoles), errors, `${where}「${id || i}」的可用孔位必须是数组`);
    let usable = [];
    if (Array.isArray(row.usableHoles)) {
      const hset = new Set();
      for (const h of row.usableHoles) {
        assert(isInt(h) && h >= 0 && h < N, errors, `${where}「${id || i}」存在越界孔位 ${h}（允许 0..${N - 1}）`);
        if (isInt(h) && h >= 0 && h < N) {
          assert(!hset.has(h), errors, `${where}「${id}」的可用孔位 ${h} 重复`);
          hset.add(h);
        }
      }
      usable = [...hset].sort((a, b) => a - b);
      assert(usable.length > 0, errors, `${where}「${id || i}」至少要有一个可用孔位`);
    }

    return { id, mass: isNum(row.mass) ? row.mass : NaN, usableHoles: usable };
  });

  if (errors.length) throw new ValidationError(errors);
  return normalized;
}

export function validateWeights(input, N) {
  const errors = [];
  assert(Array.isArray(input), errors, '配重块列表必须是数组');
  if (!Array.isArray(input)) throw new ValidationError(errors);
  if (N === null) throw new ValidationError(['请先配置转子孔位数']);

  const seenMass = new Set();
  const normalized = input.map((row, i) => {
    const where = `第 ${i + 1} 行配重块`;
    assert(row !== null && typeof row === 'object', errors, `${where}格式不正确`);
    if (!row || typeof row !== 'object') return null;

    assert(isNum(row.mass) && row.mass > 0, errors, `${where}质量必须为正数（当前：${row.mass}）`);
    if (isNum(row.mass) && row.mass > 0) {
      const key = row.mass;
      assert(!seenMass.has(key), errors, `配重块质量 ${row.mass} 重复`);
      seenMass.add(key);
    }
    assert(
      isInt(row.quantity) && row.quantity >= 1,
      errors,
      `${where}数量必须为正整数（当前：${row.quantity}）`,
    );

    return { mass: row.mass, quantity: row.quantity };
  });

  if (errors.length) throw new ValidationError(errors);
  return normalized;
}
