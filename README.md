# 离心转子配平（Rotor Balance）

实验室离心转子装载配平 Web 应用：录入转子参数、本次离心管称重数据与可选配重块，
系统按约束求**可行装载图**，优化目标依次为：

1. **配重块使用数量最少**；
2. **各对对径孔质量差之和最小**；
3. 目标完全相同时，按**孔位编号对应的物件编号序列字典序取小**
   （次序约定：离心管编号 → 配重块 `质量组#组内序号` → 空孔；即小编号离心管优先占据低编号孔位）。

无解时明确列出原因。发布时在**单个数据库事务**内重读当前数据、重新求解并用独立校验器复核，
通过后冻结装载图及其数据依据（哈希）。此后录入数据的任何修改**不会改动旧图**，
但旧图会被标记为「**不可用于当前装载**」。

现场可对**仍可用于当前装载**的发布记录做**装载核验**：按孔位录入实际物件编号与实测质量
（有物件为有限正数，空孔留空、质量 0），可暂存/恢复，携带版本号防止并发覆盖；
完成时在**单个数据库事务**内重读发布快照与当前数据，逐孔核对物件与承重、逐对核对径差
以及发布记录的当前可用性，通过后冻结实测值、判定明细与发布编号。

实验室在不同时段**复用配重块**：操作者凭**批次号**、一张**当前可用的已发布装载图**与
**UTC 起止时间**（左闭右开 `[起点, 终点)`，起点须早于终点）预约所需配重块。
占用量按**冻结图**统计到各质量规格；创建预约在**单个数据库事务**内重读发布图、
当前可选数量与重叠的有效预约，任一时刻同规格预约总量超过当前录入数量即**整单拒绝**
（返回冲突规格与时段，不产生部分占用）。同批次号重复提交：内容一致返回原记录、
内容不同拒绝；仅**未开始**的预约可取消，取消后历史保留、不再占用，同号重试不会重新占用。
录入数量调减或图失效**不改写既有预约**，但后续预约仍按当前数量与图可用性判定，
预约日程中同步展示已有占用与不足。

## 约束模型

- 孔位编号 `0 … N-1`，孔位数 N 为 4–12 的偶数；孔 `i` 与孔 `i + N/2` 对径。
- 每孔**最多一件**物件（一支离心管或一枚配重块），空孔质量按 0 计。
- 全部离心管**必须装入**；每枚配重块**最多使用一次**。
- 任一孔内物件质量不得超过该孔最大承重；离心管只能放入其声明的可用孔位。
- 每对对径孔的质量差不得超过允许对径差（容差）。
- 非法质量（非数、≤0 等）、重复编号、孔位越界一律拒绝，**不留下任何部分数据**
  （整表替换在一个 SQLite 事务中完成，校验失败即回滚）。

求解算法：按对径孔对逐对做动态规划（状态 = 已用离心管位图 + 各配重组已用数量），
同状态只保留目标三元组最优的路径（Pareto 保优），规模上界 N=12。

## 一键启动（Docker Compose）

前置要求：已安装 Docker 与 Docker Compose 插件。

```bash
docker compose up --build -d
```

首次启动会自动：

1. 安装全部依赖（容器内编译 better-sqlite3 原生模块）；
2. 初始化 SQLite 数据库与全部表结构（服务启动时自动建表，无需手工脚本）。

访问地址：

- **http://localhost:8080** （浏览器界面）

停止 / 查看日志：

```bash
docker compose down        # 停止（数据卷保留）
docker compose logs -f     # 查看日志
```

数据持久化在命名卷 `rotor-data`（容器内 `/app/data/rotor.db`）。
如需彻底清空：`docker compose down -v`。

## 本地直接运行（不使用 Docker）

需要 Node.js ≥ 20；better-sqlite3 为原生模块，首次安装需要 Python 3 / make / g++。

```bash
npm install
npm start
```

运行测试：

```bash
npm test
```

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口（容器内）；Compose 中可用同名变量改主机映射端口，如 `PORT=9090 docker compose up -d` |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `./data/rotor.db`（本地）/ `/app/data/rotor.db`（容器） | SQLite 数据库文件路径，目录不存在会自动创建 |

## 使用流程

1. **转子配置**：选择孔位数（4–12 偶数）、允许对径差（g）、各孔最大承重，保存。
2. **离心管**：逐行录入编号、称重质量、可用孔位（勾选），保存后自动配平。
3. **配重块**：按“质量 + 数量”录入每种可选配重规格（同质量自动归为一组），保存后自动配平。
4. **装载图草稿**：保存任一类数据后自动重算；称重或配重数据变化后，旧草稿显示
   「基于旧数据」警示且**禁止直接发布**，须点「按当前数据重算」。
5. **发布**：点「发布并冻结」。服务端在事务内重新读取当前数据 → 重新求解 →
   独立复核（承重、容差、管全装入、配重不超量、孔位可用、质量一致）→ 写入冻结记录。
   无解时拒绝发布并给出原因。
6. **已发布装载图**：列表中每条记录带状态徽标：
   - ✓ 可用于当前装载：记录的数据指纹与当前录入完全一致；
   - ✗ 不可用于当前装载：录入数据已变化；旧图内容保持冻结不变，可点开查看其当时的数据快照。
   仅「✓ 可用于当前装载」的可行发布记录可点「现场核验此图」发起核验。
7. **现场装载核验**：
   1. 点「现场核验此图」建立核验草稿（空孔初始化，同一发布记录只保留一份草稿；
      已完成核验的发布记录不能再建）。
   2. 在弹窗中按孔位录入**实际物件编号**与**实测质量**（有物件必须是有限正数；
      空孔保持为空、质量为 0）。页面实时显示「已录入 / 应录入孔数」进度。
   3. 可随时「暂存录入」后中断，稍后从核验列表恢复；每次暂存版本号 +1，
      提交过期版本会被 409 拒绝，避免覆盖他人的修改。
   4. 「完成核验」在服务端**同一事务**内重读冻结发布快照与当前录入数据，判定：
      - 各孔实际物件编号与冻结图完全一致（不一致定位到**孔位**）；
      - 实测质量不超过该孔最大承重（超重定位到**孔位**）；
      - 各对径孔实测质量差不超过**冻结容差**（超限定位到**孔对**）；
      - 发布记录仍可用于当前装载（数据指纹一致）。
      
      任一不通过：弹窗列出原因并在表中高亮对应孔位/孔对，**草稿保留、不生成完成记录**。
   5. 核验通过后**冻结**实测值、逐孔/逐对判定明细与发布编号；重复完成幂等返回同一份结果，
      不再产生第二份；此后再修改录入会被拒绝，已完成核验不被改写。
7. **配重块预约（时段复用）**：
   1. 在第 7 节填写批次号、选择「✓ 可用于当前装载」的发布图、录入 UTC 起止时间
      （页面输入按 UTC 解释；时段左闭右开，起点须早于终点）。
   2. 提交后服务端在**同一事务**内重读发布图、当前可选数量与重叠有效预约：
      任一时刻同规格总量超当前可选数量即整单拒绝，页面列出冲突规格与时段
      （已有占用 / 叠加后数量），不产生部分占用。
   3. 同批次号重复提交同一内容返回原记录；内容不同被 409 拒绝。
   4. 未开始的预约可「取消预约」：历史保留、占用立即释放；已开始的预约不可取消；
      已取消的批次号重试不会重新占用。
   5. 「预约日程」按质量规格展示窗口内占用分段、峰值与当前可选数量对照，
      数量调减后峰值超限的规格以「✗ 不足」高亮（既有预约不被改写）。

## REST API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 当前录入数据、数据指纹、草稿（含是否过期）、发布列表、预约列表、核验列表 |
| PUT | `/api/config` | 整体替换转子配置（孔位数、容差、各孔最大承重），事务 |
| PUT | `/api/tubes` | 整体替换全部离心管，事务，校验失败回滚 |
| PUT | `/api/weights` | 整体替换全部配重规格，事务，校验失败回滚 |
| POST | `/api/solve` | 按当前数据重算草稿 |
| POST | `/api/publish` | 事务内求解 + 独立复核 + 冻结发布；无解返回 400 |
| GET | `/api/publications` | 发布记录列表（含当前可用性标记） |
| GET | `/api/publications/:id` | 单条冻结记录详情（含发布时数据快照） |
| GET | `/api/reservations` | 预约列表（状态、各规格占用、依据图当前可用性） |
| POST | `/api/reservations` | 创建预约：事务内重读图/数量/重叠预约；同批次号幂等（201 新建 / 200 重放 / 409 内容不同或数量不足） |
| GET | `/api/reservations/occupancy` | 预约日程：窗口 `from`/`to`（UTC，缺省覆盖全部有效预约）内各规格占用分段、峰值与当前可选对照 |
| GET | `/api/reservations/:id` | 单条预约详情 |
| POST | `/api/reservations/:id/cancel` | 取消未开始的预约（重复取消幂等 200；已开始 409） |
| POST | `/api/verifications` | 对当前可用的发布记录建立核验草稿（同一发布仅一份）；重复返回 409 + `existingId` |
| GET | `/api/verifications` | 核验列表（进度、版本、是否完成、依据发布当前是否可用） |
| GET | `/api/verifications/:id` | 核验详情（冻结快照、暂存/冻结录入；完成后附判定明细） |
| PUT | `/api/verifications/:id` | 暂存孔位录入（整表替换），须携带 `version`；过期返回 409 |
| POST | `/api/verifications/:id/complete` | 事务内重读快照与当前数据完成判定；不通过 400（原因定位孔位/孔对，草稿保留）；重复完成幂等 200 |

错误统一返回 `400 {"error","errors":[...]}`；状态冲突（草稿已存在、版本过期、核验已冻结、
批次号内容不同、预约数量不足、预约已开始不可取消等）返回 `409` 并附带
`existingId` / `currentVersion` / `detail` 等字段。核验完成失败时 400 响应的
`detail.checks` 内带逐孔（`objectMatch`、`withinCapacity`）与逐对（`withinTolerance`）判定，
可直接用于前端高亮定位；预约数量不足时 409 响应的 `detail.conflicts` 内带
冲突规格（`mass`、`available`、`needed`）与冲突时段（`slots`）。

## 现场核验 HTTP API 调用示例

```bash
BASE=http://localhost:8080

# 1) 查看可用发布记录（usable=true 才可发起核验）
curl -s $BASE/api/publications

# 2) 对发布记录 #1 建立核验草稿（重复建立返回 409，body 中含 existingId，可直接恢复）
curl -s -X POST $BASE/api/verifications \
  -H 'Content-Type: application/json' \
  -d '{"publicationId":1}'
# -> {"id":1,"version":1,"completed":false,"progress":{"filled":0,"total":2},
#     "entries":[{"hole":0,"ref":"","mass":0}, ...], "publication":{...冻结快照...}}

# 3) 按孔位暂存（空孔 ref:""、mass:0；有物件 ref 为编号、mass 为有限正数）
#    entries 也可写成稀疏形式 [{"hole":0,"ref":"A","mass":50.1}, ...]
curl -s -X PUT $BASE/api/verifications/1 \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"entries":[
        {"hole":0,"ref":"A","mass":50.1},
        {"hole":1,"ref":"","mass":0},
        {"hole":2,"ref":"B","mass":50.4},
        {"hole":3,"ref":"","mass":0}]}'
# -> {"version":2,"progress":{"filled":2,"total":2}, ...}
# 并发覆盖时：HTTP 409 {"errors":[...],"currentVersion":2}

# 4) 完成核验（事务内重读发布快照 + 当前数据指纹；不通过返回 400 且草稿保留）
curl -s -X POST $BASE/api/verifications/1/complete
# 201（首次通过）/ 200（重复完成，幂等返回冻结结果）
# -> {"completed":true,"completedAt":"...","frozenEntries":[...],
#     "diffSum":0.3,"checks":{"holes":[{hole,expectedRef,actualRef,
#        measuredMass,objectMatch,withinCapacity}...],
#        "pairs":[{a,b,massA,massB,diff,withinTolerance}...]}}

# 5) 不通过示例：原因定位孔位/孔对，草稿仍可 GET 恢复
# HTTP 400 {"errors":["核验不通过…：","孔 0 物件不一致：…","对径孔对（0 ↔ 2）…"],
#           "detail":{"version":2,"checks":{...}}}

# 6) 核验列表 / 单条恢复
curl -s $BASE/api/verifications
curl -s $BASE/api/verifications/1
```

## 配重块预约 HTTP API 调用示例

```bash
BASE=http://localhost:8080

# 1) 查看当前可用的发布图（usable=true 才可据此预约）
curl -s $BASE/api/publications

# 2) 创建预约：批次号 + 发布图 + UTC 起止时间（左闭右开，须显式带 Z 或时区偏移）
curl -s -X POST $BASE/api/reservations \
  -H 'Content-Type: application/json' \
  -d '{"batchNo":"RUN-2026-10-03-A","publicationId":1,
       "start":"2026-10-03T08:00:00Z","end":"2026-10-03T10:00:00Z"}'
# 201 -> {"id":1,"batchNo":"RUN-2026-10-03-A","publicationId":1,
#         "start":"2026-10-03T08:00:00.000Z","end":"2026-10-03T10:00:00.000Z",
#         "usage":[{"mass":50,"count":1},{"mass":60,"count":1}],
#         "status":"active","publicationUsable":true, ...}

# 3) 幂等：同批次号同内容重发 → 200 返回原记录（不新增、不重复占用）；
#    同批次号不同内容 → 409 {"existingId":1}
curl -s -X POST $BASE/api/reservations \
  -H 'Content-Type: application/json' \
  -d '{"batchNo":"RUN-2026-10-03-A","publicationId":1,
       "start":"2026-10-03T08:00:00Z","end":"2026-10-03T10:00:00Z"}'

# 4) 数量不足：409，detail.conflicts 列出冲突规格与时段，未产生任何占用
# {"error":"配重块可选数量不足，未产生任何占用：…","errors":[...],
#  "detail":{"conflicts":[{"mass":50,"available":2,"needed":1,
#    "slots":[{"start":"…","end":"…","occupied":2,"required":3}]}]}}

# 5) 预约日程：各质量规格占用分段 vs 当前可选数量（exceeded=true 即不足）
curl -s "$BASE/api/reservations/occupancy?from=2026-10-03T00:00:00Z&to=2026-10-04T00:00:00Z"
# -> {"from":"…","to":"…","specs":[{"mass":50,"quantity":2,"peak":2,
#      "exceeded":false,"segments":[{"start":"…","end":"…","occupied":2},…]},…]}
# from/to 缺省时覆盖全部有效预约的时间跨度

# 6) 取消：仅未开始的预约可取消；重复取消幂等返回历史记录
curl -s -X POST $BASE/api/reservations/1/cancel
# -> {"id":1,"status":"cancelled","cancelledAt":"…", ...}
# 取消后同批次号重试仍返回该已取消记录（200），不会重新占用

# 7) 预约列表 / 单条查询
curl -s $BASE/api/reservations
curl -s $BASE/api/reservations/1
```

## 目录结构

```
src/
  server.js     Express 服务与路由、原子发布/核验/预约事务
  db.js         SQLite 连接、建表、数据访问
  solver.js     求解器、独立复核、数据指纹（纯函数，含测试）
  verify.js     现场核验：录入规整、进度、完成判定（纯函数，含测试）
  reserve.js    配重块预约：UTC 时段解析、占用扫描线、容量判定（纯函数，含测试）
  validate.js   输入校验（非法质量/重复编号/越界）、400/409 错误类型
public/         浏览器界面（原生 HTML/CSS/JS，无需构建）
test/           node --test 测试（求解器 + HTTP API + 核验 + 预约，共 58 项）
Dockerfile / docker-compose.yml
```
