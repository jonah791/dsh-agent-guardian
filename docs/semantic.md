# 语义文档：守护督导（Guardian Supervision）

> 版本 v0.1 · 2026-09-13 · 作者：爱丽丝 · 状态：**implemented**（16 条验收：11 条已实测 / 5 条待线上验收，见 §7）
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）
> 实现落点：主实现 `self-plugins/dsh-agent-guardian/src/index.ts`；告警传输 `src/alert-transport.ts`；
> 同语义副本 `src/lease.ts`（**主副本在 `dsh-agent-sentinel`**，见 §5.4 与 §8）
> 载体：watch profile 行 `agent-guardian`（与 `dsh-agent-runtime` / `dsh-agent-preflight` / `dsh-agent-sentinel` 同组合）

---

## 1 · 元信息

| 字段 | 值 |
|------|-----|
| 能力名 | 守护督导（guardian-supervision）|
| 主副本 | 本文件（`self-plugins/dsh-agent-guardian/docs/semantic.md`）|
| 版本 / 状态 | v0.1 / implemented（待 5 条线上验收归零可晋升 verified）|
| owners | `dsh-agent-guardian`（消费 `dsh-agent-preflight` / `dsh-agent-runtime` 服务；可选消费 `dsh-agent-sentinel` 的 `sessionWaker`）|
| 同语义副本 | `src/lease.ts` ↔ `dsh-agent-sentinel/src/lease.ts`（互相指认；权威语义在 sentinel 的 web-lifecycle 文档）|
| 关联规则 | AGENTS.md §5.2（watch 重启归主人）/ §5.10（预防性存活）/ §5.13（冷启动不得依赖激活会话）/ §5.18（唤醒投递纪律）/ §5.19（单点所有权）|
| 关联任务 | `t-13d309f3`（冷启动端到端 + 熔断告警尸体测试，未完成）|
| 复核时间 | 2026-09-13 |

## 2 · 定位与反定位

**定位**：让 DSH web 服务**永不静默死亡**——端口空闲时拉起、崩溃时自愈（带上限熔断）、外部启动的 dsh web 被**收养**而非争夺、**任何拉起动作之前强制沙盒预检（fail-closed）**、失败与告警**全程留证据**。一句话：guardian 管「web 活着」，并在「拉起」与「唤醒」两件事上服从生命周期租约的让位裁决。

**反定位（本文不含什么）**：

- **不管重启协调与哨兵监听**——`.hot-reload-flag` 的监听、kill→spawn→唤醒的周期重启归 `dsh-agent-sentinel`；两者靠**租约**交接（见 §5.4）。
- **不定义租约语义**——租约文件格式、裁决表、TTL、边界与信任的**主副本**是 `self-plugins/dsh-agent-sentinel/docs/semantic.md`（条目 `web-lifecycle`）§4.1–§4.5。本文只写**守护侧的角色与调用点**，不复制正文（I6 只存引用）。
- **不管进程管理底层**——`portInUse` / `portOwnerPid` / `isDshWebProcess` / `killWeb` / `spawnWeb` 由 `ctx.webman`（`dsh-agent-runtime`）提供；guardian 只做保活状态机。
- **不管预检的判据**——`ctx.preflight.run(workspace, 'quick')` 归 `dsh-agent-preflight`；guardian 只消费结论（不过即不拉起）。
- **不管数据备份本身**——存档点由 `dsh-agent-checkpoint` 写；guardian 只在拉起前做**消费式恢复**（§5.4）。
- **不是沙箱、不是权限边界**——它是**协作式保活**：防「服务静默死掉没人知道」，不防恶意进程，也不做任何授权。
- **不做「杀掉占用端口的进程」**——非 dsh 进程占用时只**有界等待 + 告警**，从不 kill 别人的进程。

## 3 · 术语表

| 术语 | 含义 |
|------|------|
| 保活（keepalive）| 让 web 持续在线的总职责：拉起 + 自愈 + 收养 + 轮询 |
| 拉起（spawn）| 通过 `ctx.webman.spawnWeb` 启动 web 子进程；**唯一**的启动动作入口 `spawnWeb()` |
| 快速退出（quick exit）| 两次退出间隔 < `crashWindowMs`（默认 30000ms）——判为「起来就崩」而非正常运行结束 |
| 熔断（circuit break）| 连续 `maxQuickExits`（默认 3）次快速退出 → **停止自动重启** + 落事故 + 告警；唯一的人工介入信号 |
| 收养（adopt）| 端口上已有**活 dsh web**（非本进程 spawn）时，把它纳入托管并起轮询自愈，**绝不 kill** |
| 让位（hold）| 生命周期租约由他人（哨兵）持有时，guardian 在「拉起前」与「唤醒前」主动放弃动作权 |
| 预检 gate | 拉起前的强制闸门：`preflight.run(quick)` 不过 → 不拉起（fail-closed）|
| 数据健康 gate | 拉起前的数据闸门：`storages/*.json` 结构损坏 → 从最近健康存档点恢复 → 才继续预检 |
| 唤醒（wake）| 拉起/自愈成功后，向最近活跃用户会话投递「web 已拉起」提醒（消费 sentinel 的 `sessionWaker`）|
| 事故文件 | `.watch-incident.json`（默认 `incidentFile`）——熔断/门控拦截/端口超时/数据恢复的落盘记录 |
| 证据行 | 追加写入 `.watch-events.log` 的单行文本：`[ISO 时间] 事件 —— 理由` |

## 4 · 概念模型 + 不变量

```
                    ┌──────────── 触发源（全部收敛到 spawnWeb 入口）────────────┐
启动自检(1.5s) ────┤  崩溃自愈(5s 后重试)   端口释放后重拉   收养轮询自愈   手动信号
                    └───────────────────────────┬──────────────────────────────┘
                                                ▼
                                  ┌── ① 生命周期租约 gate ──┐  他人持有（哨兵重启中）
                                  │   checkLeaseFor()      │────► **_收养而非拉起_**（跳过 spawn）
                                  └───────────┬────────────┘
                                              ▼ 放行
                                  ┌── ② 数据健康 gate ────┐  storages 损坏
                                  │ ensureDataHealthy()   │────► 从最近健康存档点恢复（备份 .pre-restore-*）
                                  └───────────┬───────────┘      → 无健康存档 → 落事故 + 告警（仍不拉起）
                                              ▼
                                  ┌── ③ 预检 gate（fail-closed）┐ 预检不过
                                  │ ctx.preflight.run(quick)   │────► 落事故 + 告警 + **不拉起**
                                  └───────────┬───────────────┘
                                              ▼ 通过
                                  ┌── ④ 端口最终防线 ─────┐  活 dsh web → 收养（起轮询）
                                  │ portOwnerPid + 类型判定 │  非 dsh → 有界等待(≤300s) → 超时落事故+告警
                                  └───────────┬───────────┘
                                              ▼ 空闲
                                  ⑤ ctx.webman.spawnWeb() → ⑥ notifyWebReady()（查租约 → 唤醒）

  并行运行：web 退出回调 onWebExit（快速退出计数 / 熔断）｜收养轮询 ensureExternalTimer（5s 探活）
```

**不变量（invariants）**：

1. **I1 拉起前必过预检（fail-closed）**：任何 `spawnWeb()` 调用都先经 `ctx.preflight.run(workspace,'quick')`；不通过则**不拉起**，且落事故 + 发告警。预检服务调用异常同样视为不通过。
2. **I2 让位不越权（单点所有权）**：`spawnWeb` 入口与 `notifyWebReady` 两处查租约；他人持有且新鲜 → 收养而非拉起、**不重复唤醒**。守护**不取租**（除冷启动自愈场景外不主动充当 owner），也**只释放自己的**租约。
3. **I3 收养不杀**：端口被活 dsh web 占用时，一律收养托管 + 起自愈轮询；guardian 从不 kill 非本进程 spawn 的 web。
4. **I4 自愈有上限**：连续快速退出达 `maxQuickExits` → 停止自动重启 + 落事故 + 告警（不许无限重启把问题掩盖成噪音）。
5. **I5 等待有界**：非 dsh 进程占用端口 → 等待 ≤300s（每 5s 探一次，每 30s 写一行日志），超时落事故 + 告警后放弃本轮。
6. **I6 不静默**：告警发送、让位、租约读取异常、门控拦截、端口超时、数据恢复全部落证据行；告警**送达判据 = 子进程退出码 0 且响应体 `ok === true`**（缺一即判失败）。
7. **I7 闸门顺序不可颠倒**：数据健康 → 预检 → 端口 → spawn。数据损坏会让预检试运行失败，若先预检就永远起不来。
8. **I8 坏数据不锁死**：租约损坏/空/时钟偏移一律按「空闲」放行并落 issue（宁可重复动手，也不停在半路）；storages 损坏时若**无**健康存档点，则落事故 + 告警且不拉起（不接受带病启动）。

## 5 · 契约

### 5.1 配置（watch profile 行 `agent-guardian`）

| 字段 | 默认 | 语义 |
|------|------|------|
| `dshHome` | `process.env.DSH_HOME` | 证据文件、租约、凭据兜底查找的根 |
| `port` / `baseUrl` | `3080` / `http://127.0.0.1:3080` | 保活目标 |
| `crashWindowMs` | `30000` | 快速退出判定窗口 |
| `maxQuickExits` | `3` | 熔断阈值（连续快速退出次数）|
| `incidentFile` | `<dshHome>/.watch-incident.json` | 事故落盘路径 |
| `defaultWorkspace` | `''`（回退 `process.cwd()`）| 首次拉起的 workspace |
| `adoptExternal` | `true` | 启动时端口被占且是 dsh web → 是否收养 |
| `telegramBotToken` / `telegramChatId` | `''` | 告警凭据；空则回退 `<dshHome>/.credentials.yaml` 的 refs（**凭据不写进文档/源码**）|
| `httpProxy` | `http://127.0.0.1:16888` | 兜底通道（curl）使用的代理 |
| `dataHealth.storagesDir` / `.checkpointDir` / `.soulFile` | `<dshHome>/storages` / `<dshHome>/checkpoints` / `<workspace>/AGENTS.md` | 数据健康 gate 的三个落点 |

### 5.2 证据面（可被外部读到的契约）

| 落点 | 形状 | 语义 |
|------|------|------|
| `<dshHome>/.watch-events.log` | 单行：`[ISO] 事件描述` | **追加**写；让位/门控/自愈/收养/告警全部在此留痕（I6）|
| `<dshHome>/.watch-incident.json` | `{ at, code?, signal?, message, ...detail }` | 最后一次事故的**覆盖式**快照（熔断 / 预检拦截 / 端口超时 / 数据恢复 / 无健康存档）|
| `<dshHome>/checkpoints/.pre-restore-<ts>/` | 恢复前备份 | 恢复动作的可回滚证据（永不原地覆盖而不备份）|

### 5.3 纯函数与模块契约

| 符号 | 位置 | 契约 |
|------|------|------|
| `judgeTelegramResponse(code, stdout) → {ok, detail}` | `src/alert-transport.ts` | 送达判据：`stdout` 以 `ERR ` 开头 → 失败；非 JSON → 失败；`code !== 0` → 失败；`parsed.ok !== true` → 失败；否则成功（I6）|
| `sendTelegramAlert(opts) → {ok, channel, detail}` | `src/alert-transport.ts` | 主通道 `node-fetch`（spawn node 子进程 + `NODE_USE_ENV_PROXY=1`）→ 失败则 `curl` 兜底；缺凭据时 `channel:'none'` 且**明确失败**（不静默）|
| `checkLeaseFor(dshHome, role, nowMs) → LeaseGate & {issue?}` | `src/lease.ts`（副本）| 守护侧**唯一**的让位查询入口；语义主副本在 sentinel 文档 §4.2 |

### 5.4 调用点清单 `[MUST]`

守护侧在**这些**调用点生效（漏一处 = 门控形同不存在）：

| 触发源 | 调用点（`src/index.ts`）| 经过的闸门（顺序）| 备注 |
|--------|------------------------|------------------|------|
| 启动自检 | `ctx.effect` 内 1.5s 延时后 → `spawnWeb(defaultWorkspace)` | 租约 → 数据健康 → 预检 → 端口 → spawn | `manualStop` / 已有 child 时跳过 |
| 崩溃自愈 | `onWebExit` → 5s 后 → `spawnWeb(lastWorkspace)` | 同上 | 快速退出计数在闸门**之前**判定，熔断优先 |
| 端口释放后重拉 | `onWebExit` → `waitPortFree()` 成功 → `spawnWeb(lastWorkspace)` | 同上 | 等待有界（I5）|
| 收养轮询自愈 | `ensureExternalTimer` 5s 轮询发现被收养者消失 → `spawnWeb(...)` | 同上 | 收养路径**必须**起轮询，否则崩溃后无人拉起（2026-08-27 修复）|
| 唤醒 | `spawnWeb` 成功后 → `notifyWebReady()` | **仅租约**（让位则不唤醒）| 唤醒不重复：持租方负责唤醒（2026-09-12）|
| 优雅停止 | `SIGINT` / `SIGTERM` → `onSig()` | — | 置 `manualStop`、清轮询、kill 自己的 child 或被收养者 |

**服务消费**：`inject = ['preflight', 'agentRuntime', 'webman']`（硬依赖）；`sessionWaker` 用 `ctx.get` **可选**消费——不能进 `inject`，否则 sentinel 缺席时保活本身会被 Cordis 激活门一起挡住（本末倒置）。

## 6 · 边界与信任

- **能力边界 ≠ 沙箱**：guardian 防「静默死亡」与「带病启动」，**不防**恶意进程、不提供任何隔离；租约是**协作式互斥**，不是强制锁。
- **不越界清单**：不 kill 非 dsh 进程；不 kill 被收养的 web；不动 sentinel 的租约；不改预检判据；不自行重启 watch profile（§5.2 归主人）；不在 web 内做任何写入（只做数据恢复的**拷贝**）。
- **失败面**：
  | 场景 | 行为 |
  |------|------|
  | 预检服务调用抛错 | 视为不通过 → 落事故 + 告警 + 不拉起（I1）|
  | 预检不过 | 落事故 + 告警 + 不拉起（I1）|
  | 租约文件损坏/空 | **放行**（按空闲）+ 落 issue 证据行（I8）|
  | 租约读失败/时钟偏移 | 放行 + issue（不锁死服务）|
  | storages 损坏且有健康存档 | 备份当前 → 恢复 → 落事故 + 成功告警 → 继续预检 |
  | storages 损坏且无健康存档 | 落事故 + 告警 → **不拉起**（I8）|
  | 告警凭据缺失 | `channel:'none'` 明确失败并留证据（不静默）|
  | 两条告警通道都失败 | 返回失败详情（含两通道结论）落证据行 |
  | `sessionWaker` 缺席 | 落证据行「跳过唤醒」，保活继续 |
  | 端口等待超时 | 落事故 + 告警 + 放弃本轮（I5）|

## 7 · 可证伪验收清单

（每条都能被一次测量判真假；证据栏最后一个单元格是判定依据。）

| # | 可证伪命题 | 证据 / 状态 |
|---|-----------|------------|
| A1 | 端口空闲时启动自检会拉起 web | ✅ 已实测：线上 `.watch-events.log` 有 `端口空闲，guardian 自动拉起 web` **59** 条（最近 2026-09-12T14:14:08Z）；`guardian 就绪` 73 条 |
| A2 | 拉起成功后向最近活跃用户会话投递唤醒 | ✅ 已实测：`拉起后唤醒已发送: session-879c4ae1-…` **21** 条（最近 2026-09-13T00:55:34Z）|
| A3 | 预检不过时不拉起（fail-closed）+ 落事故 + 告警 | ✅ 已实测：线上 `预检 gate FAIL，拒绝拉起 web` **6** 条（最近 2026-09-05T09:32:45Z），伴随事故文件写入 |
| A4 | 端口被活 dsh web 占用时收养而非 kill/拉起 | ✅ 已实测：`web 退出但端口被活 dsh web 占用（PID …）——收养接管，跳过拉起`（最近 2026-09-12T14:34:29Z）；`收养的 web（PID 23456）已退出——由守护拉起`（2026-09-13T00:55:00Z）|
| A5 | 非 dsh 进程占用时等待释放后重新拉起（有界等待） | ✅ 已实测：`端口 3080 被非 dsh 进程占用，等待释放…` + `端口已释放，重新拉起 web` **17** 条 |
| A6 | 崩溃后自愈重启（记录退出码与快速退出计数） | ✅ 已实测：`web 退出 code=1 signal=null quickCount=0`（**646** 条退出记录，最近 2026-09-12T14:26:36Z）|
| A7 | 连续 3 次快速退出后**停止自动重启**（熔断）| **待线上验收**：线上 `停止自动重启` / `连续 … 次快速退出` 命中 **0** 次（从未触发）；该路径亦无单测——见 U1 |
| A8 | storages 损坏时从最近健康存档点恢复（含 `.pre-restore-*` 备份）| **待线上验收**：线上 `数据健康` 命中 **0** 次；该路径无单测——见 U1 |
| A9 | 租约裁决：哨兵持租时守护必须让位；过期/自持/无租约放行；损坏不锁死 | ✔ 单测已实测：`tests/lease.test.mjs` **17/17 通过**，含**尸体样本**「哨兵 22:33:13 取租 → 守护 22:33:35 查 → 必须 `hold`」、`lease-expired`、`self-held`、`lease-json-invalid`、`clock-skew`、`not-owner` |
| A10 | 让位在**线上**发生并留证据行 | **待线上验收**：`生命周期租约` 在事件日志命中 **0** 次（尚未遇到「哨兵重启窗口内守护也要动手」的工况）——见 U2 |
| A11 | 告警送达判据 = 退出码 0 **且** `ok === true` | ✔ 单测已实测：`tests/alert-transport.test.mjs` **6/6 通过**，含 4 条尸体样本（curl exit 35 空响应 / exit 0 但 `ok:false` / `ERR spawn EPERM` / HTML 网关页）+ 好样本不误报 |
| A12 | 告警通道在真实网络下可用（主通道 node-fetch）| ✅ 已实测：2026-09-11 零副作用分层验证（`getMe` 可达 1.3s）+ 尸体测试实测 **9 秒送达**；同刻 `curl`(Schannel) 经代理 TLS 必失败 exit 35——**双判据必需**（exit 0 但 `ok:false` 会误报「已送达」）|
| A13 | 缺凭据时不发送且给出明确原因（不许静默放弃）| ✔ 单测已实测：`缺凭据 → 不发送且给出明确原因` 断言 `channel==='none'` 且 `detail` 匹配 `/未配置/` |
| A14 | 熔断告警端到端（真实崩溃循环 → 主人手机上收到）| **待线上验收**：需真实熔断触发，且有外部副作用（真发消息给主人）——归 `t-13d309f3` 待办 B，见 U3 |
| A15 | 收到 SIGINT/SIGTERM 后不再自动拉起 | **待线上验收**：代码路径存在（`manualStop`）+ 信号处理器在 `ctx.effect` 回滚中移除，但无单测、无线下样本——见 U1 |
| A16 | 只释放自己的租约（不得夺权）；释放留「已释放」痕迹 | ✔ 单测已实测：`不得夺权：guardian 清不掉 sentinel 的租约`（`not-owner`）+ `释放写证据而非删文件`（读回 `ttlMs=1`、`note=released-at-<ts>`）|

**验收计数**：total **16** / proven **11** / pending **5**（其中显式标「待线上验收」5 条）。

## 8 · 与实现的关系

- **主实现**：`src/index.ts`（保活状态机、四道闸门、证据面、唤醒）——本文 §4/§5 与之逐条对应。
- **告警传输**：`src/alert-transport.ts`（双通道 + 判据 `judgeTelegramResponse`）。
- **同语义副本（双胞胎，互相指认）**：`src/lease.ts` 是 `dsh-agent-sentinel/src/lease.ts` 的副本——两侧各有单测守护语义一致；**权威语义（文件格式/裁决表/TTL/边界）主副本在仓库 `dsh-agent-sentinel`**。改任一侧必须同步另一侧。
- **依赖而非自研**：进程管理归 `dsh-agent-runtime`（`ctx.webman`）；预检归 `dsh-agent-preflight`（`ctx.preflight`）；唤醒实现归 `dsh-agent-sentinel`（`ctx.sessionWaker`）——guardian 只保留保活状态机与门控顺序。
- **未实现 / 未验证（显式）**：① 熔断路径与数据健康恢复路径**无单测**（逻辑内联在 `apply()` 中，未抽纯函数）——这是 §7 A7/A8/A15 无法离线取证的原因；② 让位的线上观测（A10）、熔断告警端到端（A14）未完成；③ watchdog 自身崩溃目前**无兜底**（历史上由 watch 上层心跳覆盖，该心跳已于 2026-09-11 停用）。
- **测试入口**：`npm test` = `node --test "tests/*.test.mjs"`（跑 `lib/` 产物；WSL 与 Windows 均可跑通，23/23）。

## 9 · 实践修订记录

（I3：事故暴露的语义缺口当场回写。本节同时是这条防线的「事故史」——每条都对应一次真实事故或实测。）

- **2026-08-26 / 08-27 拆分与「能力未迁移」**
  - 语义**被确认**：guardian 与 sentinel 职责分离（保活 vs 重启）成立，四件套（runtime/preflight/sentinel/guardian）组合可用。
  - 语义**被补充**：拆分时**能力清单必须逐项核对**——原 `dsh-agent-watch` 的「自动拉起后补齐唤醒」在拆分中丢失，直到 2026-09-10 主人实测「重启后没收到提醒」才被发现（§5.18 的由来）。
  - 教训：**职责迁移要核对能力清单**，不是「新插件能跑起来」就算迁移完成。
- **2026-08-27 收养竞态**
  - 语义**被修正**：`spawnWeb` 内的收养分支原先只设 `externalPid` 而未起轮询 → 被收养的 web 崩溃后**无人拉起**。修法：抽出唯一入口 `ensureExternalTimer`，收养与轮询绑定（I3）。
  - 教训：**同一个语义（「托管」）出现在多条路径时必须收敛到一个函数**，否则必有一条漏。
- **2026-08-28 数据健康联动（主人定调「恢复与守卫联动」）**
  - 语义**被补充**：新增**数据健康 gate**，并确立**顺序语义**（数据 → 预检 → 端口 → spawn，I7）——数据损坏会让预检试运行失败，若先预检就永远起不来。
- **2026-08-31 端口占用分类**
  - 语义**被修正**：原「端口被占用 → 无脑无限等待」改为**按占用者类型分流**（dsh web → 收养；非 dsh → 有界等待 + 超时告警，I5）。
- **2026-09-02 重构 D2（进程管理外移）**
  - 语义**被补充**：`portInUse/portOwnerPid/isDshWebProcess/killWeb/spawnWeb` 统一改由 `ctx.webman`（`dsh-agent-runtime`）提供，消除与 sentinel 的重复实现；guardian 保留状态跟踪（自愈需要）。
- **2026-09-05 熔断推演（主人「推理重启失败后会发生什么」）**
  - 语义**被确认**：连续快速退出必须**停手上报**（I4），并补了 init 脚本兜底（桌面启动脚本最后一道）。
  - 线上证据：`预检 gate FAIL，拒绝拉起 web` 6 条（同日 09:32:45Z 最新），证明门控真的会拦。
- **2026-09-08 → 09-10 告警静默（三处缺口）**
  - 语义**被修正**：告警原实现有三处静默（未配置即 return / spawn 失败被吞 / 不等结论），导致 09-08 熔断告警**是否送达无法从日志回答**。修法：全程落证据（发起/送达/失败+原因），**只加证据链、不改告警行为**（`6c0e5e4`）。
  - 教训：**「提醒类机制必须有存活证据」**（§5.10 §3）——没有证据的防线等于不存在的防线。
- **2026-09-10 / 09-11 上层保活误杀（相邻机制）**
  - 语义**被补充**：watch 上层保活心跳（每 30 分钟）曾**误杀健康服务**，已于 2026-09-11 停用。guardian 侧吸收的纪律是 **「收养而非杀」「不重复拉起」「让位」**——同一个健康实例只能被一个 owner 动（§5.19）。
- **2026-09-11 告警通道结构性失效（实测）**
  - 语义**被修正**：本机 `curl.exe` 是 Schannel 版，经 clash 代理时 CONNECT 成功但 TLS 握手必失败（`exit 35`，`-k/--http1.1/--tlsv1.2` 各变体同样失败），而**同刻 Node fetch（OpenSSL）成功**。改法：主通道 spawn node 子进程（注入 `NODE_USE_ENV_PROXY=1`）执行 `fetch`，curl 降为兜底（`6a583a4`）；判据定为**退出码 0 且 `ok===true`**（实测存在「exit 0 但 `ok:false`」的误报形态）。
  - 子进程输出走**临时文件而非管道**：DSH Windows 沙箱下捕获管道 stdio 的 spawn 会 EPERM。
- **2026-09-12 双重重启事故 → 生命周期租约**
  - 语义**被补充**：守护与哨兵**都在管 web 生命周期**且无交接 → 一次重部署拉起两个实例（多出的绑定端口失败退出）+ 唤醒发两遍。修法：**租约**（谁发起谁取租；守护在两处查租让位），本条能力侧新增 **I2**，实现 `1a0a1ed`。
  - 教训：**同一资源的生命周期只能有一个 owner**（§5.19）；让位只针对「拉起」与「唤醒」，不改其他行为。
- **2026-09-12 `npm test` 假红**
  - 语义**被补充**：`node --test tests/` 在 node24 把目录当模块 → 套件必红；修为 `node --test "tests/*.test.mjs"`（`a3672cc`）。测试入口写进 §8。
- **2026-09-13 本文首次成文（实践回修）**
  - 语义**被确认**：四道闸门 + 收养 + 熔断 + 证据面与实现一致；验收 11/16 已取得证据。
  - 语义**被补充**：新增「证据面」作为**外部契约**（§5.2）与「调用点清单」（§5.4）；把「熔断/数据健康路径无单测」显式登记为缺口（§8 + U1），不再让它们藏在 `implemented` 后面。
  - 语义**被修正**：本文与 `web-lifecycle` 的边界按 **I6 只存引用** 处理——租约正文不复制，仅写守护侧角色与调用点（§5.4 末尾）。

## 10 · 未决问题

- **U1 熔断与数据健康路径要不要抽纯函数 + 补单测？** 二者目前内联在 `apply()`，是 A7/A8/A15 无法离线取证的根本原因。倾向：抽出 `decideCircuitBreak(quickExits, maxQuickExits)` 与 `selectHealthyCheckpoint(manifests)` 两个纯函数，配尸体测试（喂真实损坏 manifest）。需要一次 watch profile 重启窗口（§5.2 归主人）。
- **U2 让位（A10）怎么拿到线上证据？** 只有「哨兵重启窗口内守护恰好也要动手」才产生证据行，属不可人为制造的工况。倾向：在下一次真实重部署时由我盯 `.watch-events.log`，并在 `web-lifecycle` 的 A8/A9 一并收口。
- **U3 熔断告警尸体测试（A14）与谁做、何时做？** 真发消息给主人 = 外部副作用，且与 coldstart 告警尸体测试**不可合并**（合并后无法区分是哪条链路送达）。倾向：主人清醒在场时做一次，且只做一次（§5.14 §5 破坏性实验去重）。
- **U4 watchdog 自身崩溃无人兜底**：曾由 watch 上层心跳覆盖，该心跳 2026-09-11 停用后成为空白。倾向：把「watch 进程存活」并入 guardian 的职责清单（或恢复一个不误杀的守卫版），但需先有 U1 的纯函数骨架。
- **U5 门控的服务缺失语义**：`preflight`/`webman` 现在是**硬依赖**（`inject`）——服务缺席时 guardian **整插件不激活**，于是「保活」也一起没了。是否改为「缺席即拒绝拉起并告警」的软降级？倾向：保持硬依赖（缺预检的保活更危险），但把该取舍写进 §6 失败面。
- **U6 与 `web-lifecycle` 的文档边界**：租约目前「语义主副本在 sentinel，代码副本在两仓」。若将来第三个组件也要查租约，是否需要独立的 lifecycle 主文档？倾向：等第三个消费方出现再拆，避免现在过度设计。
