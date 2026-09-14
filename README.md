<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 守护插件（从 dsh-agent-watch 拆分）：web 保活——端口空闲拉起、崩溃自愈（快速退出计数 + 熔断）、收养外部 dsh web（零互踢）；所有拉起路径前置「数据健康恢复 + 沙盒预检」两道闸门（fail-closed），拉起与唤醒前服从 web 生命周期租约的让位裁决
  inject: 'preflight','agentRuntime','webman' 为硬依赖；sessionWaker 经 ctx.get 可选消费（不得进 inject——sentinel 缺席时保活本身也会被激活门挡住）
  tools: （无，服务型插件）
  runtime: host-only（挂 watch profile；不在 web 进程内运行）
  envDeps: Node 内置（fs/path/child_process/net/crypto/os）；env DSH_HOME；告警主通道 spawn node 子进程并注入 NODE_USE_ENV_PROXY=1；兜底通道需系统 curl.exe（Windows）
  boundary: 只管「web 活着」——哨兵监听与 kill→spawn→唤醒的重启协调归 dsh-agent-sentinel；进程管理底层归 ctx.webman（dsh-agent-runtime）；预检判据归 dsh-agent-preflight；存档点由 dsh-agent-checkpoint 写、本插件只做消费式恢复；不 kill 占用端口的非 dsh 进程（有界等待 + 告警）；不是沙箱、不是权限边界
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-guardian

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-guardian"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-23%20passed-brightgreen" alt="tests">
</p>

**一句话**：DSH web 服务的保活状态机——端口空闲就拉起、异常退出就自愈（两次退出间隔 < 30s 记为「快速退出」，连续 3 次熔断停机）、别人起的 dsh web 就收养；**每一次拉起之前**都要过「数据健康恢复 → 沙盒预检」两道闸门，且在被哨兵持有的重启窗口内主动让位。

**为什么值得用**：没有它，web 静默死掉就只是「没人知道」——它在 `watch` profile 里每 5 秒巡检一次，把「服务不在线」变成一个**会自动修复、且每一步都留证据**的状态；预检 gate 是 fail-closed 的（宁可旧实例可疑，也不放一个没验证过的新实例上去），预检不过时**不拉起**并落事故 + 告警。同时它**不抢权**：端口上已有活 dsh web 时收养而非 kill（零互踢），哨兵正在重启时按租约让位（不重复拉起、不重复唤醒）。

## 能力

本插件**不注册任何 agent 工具**（无 `defineTool`），全部能力是行为侧的运行时机制：

| 功能点 | 行为 | 源码锚点 |
|--------|------|---------|
| 启动自检拉起 | 挂载后延时 1.5s：端口空闲 → 拉起 web；端口被占且 `adoptExternal` → 收养 | `ctx.effect` |
| 崩溃自愈 | `onWebExit` → 端口空闲则 5s 后重新拉起（记录退出码 / signal / 快速退出计数） | `onWebExit` |
| 快速退出熔断 | 两次退出间隔 < `crashWindowMs` 记为 quick，连续 ≥ `maxQuickExits` → **停止自动重启** + 落事故 + 告警 | `onWebExit` |
| 收养外部 web | 端口上是**活 dsh web**（非本进程 spawn）→ 托管 + 5s 轮询自愈；**绝不 kill** | `adoptExternalWeb` / `ensureExternalTimer` |
| 预检 gate（fail-closed） | 每次拉起前 `ctx.preflight.run(workspace,'quick')`；不过 → 落事故 + 告警 + **不拉起** | `spawnWeb` |
| 数据健康 gate | 拉起前扫 `storages/*.json` 的 unit 结构；损坏 → 从最近**健康**存档点恢复（先备份到 `.pre-restore-<ts>/`）→ 再走预检 | `ensureDataHealthy` |
| 生命周期租约让位 | 「拉起前」与「唤醒前」查 `.web-lifecycle-lease.json`：他人持有且新鲜 → 收养而非拉起、**不重复唤醒** | `checkLeaseFor`（`src/lease.ts`） |
| 拉起后唤醒 | 拉起成功后向最近活跃用户会话投递「web 已拉起」；`sessionWaker` 缺席时落证据行跳过 | `notifyWebReady` |
| 双通道告警 | Telegram 告警：主通道 spawn node 子进程 fetch（注入 `NODE_USE_ENV_PROXY=1`）→ 失败则 `curl` 兜底；结论（含所用通道）落盘 | `src/alert-transport.ts` |
| 有界端口等待 | 非 dsh 进程占用时每 5s 轮询、上限 300s；超时 → 落事故 + 告警（**不 kill 别人**） | `waitPortFree` |
| 优雅停止 | `SIGINT`/`SIGTERM` → 置 `manualStop`、清轮询、kill 自己的 child 或被收养者 | `onSig` |
| 证据面 | 事件行追加、事故快照覆盖写（见下节） | `logEvent` / `writeIncident` |

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在 watch profile 的 `package.json` 加 link 行）：

```jsonc
"dsh-agent-guardian": "link:<工作区>/self-plugins/dsh-agent-guardian"
```

**2) 挂组合**（watch profile 的 `cordis.patch.yml`，与 runtime / preflight / sentinel 同 profile）：

```yaml
- insert:
    - id: agent-guardian
      name: dsh-agent-guardian
      config:
        dshHome: ${DSH_HOME}
        port: 3080
        maxQuickExits: 3
        adoptExternal: true
```

**3) 30 秒验证**：看证据面有没有就绪行与动作行——

```bash
tail -3 "$DSH_HOME/.watch-events.log"
# 期望看到：[<ISO 时刻>] guardian 就绪 保活:3080
#           [<ISO 时刻>] 端口空闲，guardian 自动拉起 web   （或）端口已被占用——尝试收养外部 dsh web
```

> 前置条件：`dsh-agent-preflight`、`dsh-agent-runtime`（提供 `webman`）必须在同一组合内——它们缺席时 guardian **整插件不激活**（`inject` 是 cordis 激活门），保活也一并消失。这是刻意的取舍：没有预检的保活更危险（[`docs/semantic.md`](docs/semantic.md) §10 U5）。

## 配置

键名与 `export const Config`（`src/index.ts`）逐项一致，默认值取自源码：

| 项 | 默认 | 说明 |
|----|------|------|
| `dshHome` | `process.env.DSH_HOME \|\| ''` | 证据文件、租约、凭据兜底查找的根（空则回落 `process.cwd()`） |
| `port` | `3080` | 保活目标端口 |
| `crashWindowMs` | `30000` | 快速退出判定窗口 |
| `maxQuickExits` | `3` | 熔断阈值（连续快速退出次数） |
| `incidentFile` | `''` → `<dshHome>/.watch-incident.json` | 事故落盘路径 |
| `defaultWorkspace` | `''` → `process.cwd()` | 首次拉起使用的 workspace |
| `adoptExternal` | `true` | 启动时端口被占且是 dsh web → 是否收养 |
| `launchCmd` | `[]` | **遗留字段**：源码中已无引用（进程管理 2026-09-02 移交 `ctx.webman`） |
| `bin` / `profile` / `baseUrl` | `''` / `'web'` / `'http://127.0.0.1:3080'` | **遗留字段**：源码中已无引用（改由 `ctx.agentRuntime` 提供） |
| `telegramBotToken` / `telegramChatId` | `''` | 告警凭据；为空时回退读 `<dshHome>/.credentials.yaml` 的两个具名引用（**凭据不写进本仓库**） |
| `httpProxy` | `http://127.0.0.1:16888` | 兜底通道（curl）使用的 http 代理 |
| `dataHealth.storagesDir` | `''` → `<dshHome>/storages` | 数据健康检查目录（`storage-json` unit） |
| `dataHealth.checkpointDir` | `''` → `<dshHome>/checkpoints` | 存档点目录（`manifest.json` + `files/`） |
| `dataHealth.soulFile` | `''` → `<workspace>/AGENTS.md` | 灵魂文件恢复落点 |

## 落盘与自证（出问题时先看这里）

**本插件有持久产物，且是「追加式证据流 + 覆盖式快照」两种形状**（都在 `${DSH_HOME}`）：

| 落点 | 形状 | 字段 / 语义 |
|------|------|------------|
| `${DSH_HOME}/.watch-events.log` | 追加，单行 `[ISO 时刻] 事件描述` | 唯一的过程证据流：就绪 / 拉起 / 收养 / 让位 / 预检拦截 / 端口等待 / 退出 / 唤醒 / 告警结论全部在此 |
| `${DSH_HOME}/.watch-incident.json`（或 `incidentFile`） | **覆盖式**快照，JSON | `{ at, code?, signal?, message, ...detail }`——最后一次事故（熔断 / 预检拦截 / 端口超时 / 数据损坏且无健康存档 / 数据已恢复） |
| `${DSH_HOME}/checkpoints/.pre-restore-<ts>/` | 恢复前备份 | 自动恢复**永不原地覆盖**：被替换的文件先复制到这里（可回滚证据） |
| `${DSH_HOME}/.web-lifecycle-lease.json` | **只读**（写入方是 sentinel） | `{ owner: 'sentinel'\|'guardian', atMs, ttlMs, note? }`；guardian 只查不取、不释放 |

事件行的**阶段枚举**（源码 `logEvent` 文案，可直接 grep 定位断点）：

| 阶段 | 关键字 |
|------|--------|
| 就绪 | `guardian 就绪 保活:` |
| 启动自检 | `端口空闲，guardian 自动拉起 web` / `端口已被占用——尝试收养外部 dsh web` |
| 收养 | `收养外部 dsh web（PID …）：此后由守护托管` / `收养的 web（PID …）已退出——由守护拉起` |
| 租约让位 | `生命周期租约：held-by-sentinel(…note=…) ——跳过唤醒` / `——收养而非拉起（跳过 spawn）` / `生命周期租约读取异常（按空闲处理）: …` |
| 门控 | `预检 gate FAIL，拒绝拉起 web: …` / `数据健康检查 FAIL: …——尝试从存档点恢复` / `数据损坏已自动恢复（存档 …）` |
| 端口 | `端口 <p> 被非 dsh 进程占用，等待释放...` / `端口 <p> 仍被占用（已等 Ns）` / `端口已释放，重新拉起 web` / `端口 <p> 等待超时（Ns），放弃等待` |
| 退出与自愈 | `web 退出 code=… signal=… quickCount=…` / `web 退出但端口被活 dsh web 占用（PID …）——收养接管，跳过拉起` |
| 唤醒 | `拉起后唤醒已发送: session-…` / `拉起后唤醒未发送: <reason>（候选=[…]）` / `sessionWaker 服务不可用（sentinel 未挂载？）——跳过唤醒` |
| 告警 | `telegram 告警发送中: …` / `telegram 告警已送达（node-fetch\|curl）— …` / `telegram 告警失败（<通道>）：<原因> — …` |

**一条命令尽量答五问**：

```bash
tail -5 "$DSH_HOME/.watch-events.log"
# ① 跑的是哪个构建 → 事件行不含 build 字段（已知缺口）；改用 mtime 对照：stat -c %y lib/index.js 与 watch 进程启动时间比
# ② 谁发起 / 投给谁 → 行首 ISO 时刻 = 发起时刻；`拉起后唤醒已发送: session-…` 即被唤醒的目标会话
# ③ 断在哪一段     → 用上表关键字对号：停在「端口空闲，guardian 自动拉起 web」之后没有后续行 ⇒ 卡在闸门/端口段；有 `预检 gate FAIL` 即明确结论
# ④ 结果质量       → 计数取证：grep -c '预检 gate FAIL' / '生命周期租约' / '停止自动重启' / '已送达' 各是什么量级
# ⑤ 耗时与预算     → 相邻两行时间差即该段耗时（预检 quick 为毫秒级；端口等待 5000ms/轮、预算 300s）
```

再看事故快照（覆盖式，只保留最后一次）：`cat "$DSH_HOME/.watch-incident.json"`。

**已知缺口**：事件行与事故文件都**不带 build 指纹**（版本 + 模块 mtime），所以「线上跑的是哪个构建」只能靠文件 mtime 与进程启动时间间接推断——这违反生态的可维护性纪律（[`docs/semantic.md`](docs/semantic.md) §10）。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. **进程级**：`lib/index.js` 的 mtime ≤ watch 进程启动时间，且 `src/index.ts` 不新于 `lib/index.js`（源码改了没构建 = 跑的还是旧产物）；
2. **行为级**（最直接）：挂载后 ≤ 1.5s 内 `${DSH_HOME}/.watch-events.log` 追加 `guardian 就绪 保活:<port>`；端口空闲时随后出现拉起/收养行；
3. **交互级**：预检或数据损坏工况下出现 `预检 gate FAIL，拒绝拉起 web` + `.watch-incident.json` 被写——证明闸门真的在生效（而不是只有代码里有）。

> **重新构建 ≠ 生效**：`lib/` 的 mtime 新只证明「构建过」，只有**进程启动时间晚于产物 mtime** 才算「在跑它」（AGENTS.md §5.11 §6）。watch 侧**没有** web 侧那种 `hasUnverifiedBuilds()` 预检兜底——构建完必须重启 watch 才会生效。
>
> 另注意：守护类改动受 §5.2 约束，**watch profile 的重启由主人执行**；本插件不自行重启宿住它的父进程。`npm test` 脚本**不含构建步骤**，改完源码务必先 `npm run build`。

**回退**（三档）：
- 源码级：`git revert <commit>`（或 `git checkout <上一提交>`）→ `npm run build` → 预检 → 由主人重启 watch；回退后用同一判据复验（就绪行消失 / 旧文案出现）；
- 组合级：watch profile patch 给该行加 `disabled: true`（或经插件管理面停用）→ 保活消失、端口空闲时**不再有人拉起 web**（此时保活真空，需先确认 sentinel 的周期重启是否足以覆盖）；
- 运行期：无状态可清——本插件不持有需要清理的持久状态；`.watch-events.log` / `.watch-incident.json` 是纯证据，可保留可删除；`.web-lifecycle-lease.json` **不属本插件**，删它会破坏哨兵的交接留痕（有 TTL 兜底，但仍不该动别人的文件）。

## 测试

```bash
npm run build && npm test     # npm test = node --test "tests/*.test.mjs"
```

**23 例离线测试、3 个 suite，全部 `pass`**（实测输出：`# tests 23 / # suites 3 / # pass 23 / # fail 0`，耗时 ~176ms），**跑的是构建产物**（`tests/*.test.mjs` 从 `../lib/*.js` 导入，改源码必须先构建）：

- `tests/alert-transport.test.mjs`（6 例）——告警**送达判据** `judgeTelegramResponse`：好样本（exit 0 + `ok:true`）+ **4 条尸体样本**（curl TLS 失败 exit 35 空响应体 / exit 0 但 API `ok:false` / 子进程 spawn 失败写 `ERR ` 前缀 / 非 JSON 的 HTML 网关页）+ 缺凭据时 `channel==='none'` 且给出明确原因（不许静默放弃）。
- `tests/lease.test.mjs`（17 例）——租约**裁决表与文件层**：**真实时刻表尸体样本**（哨兵 22:33:13 取租 → 守护 22:33:35 巡检必须 `hold`）、持租方自己不受影响、过期接管、无租约放行、边界（`age === ttlMs` 即过期）、时钟偏移（`atMs` 在未来）放行、`note` 保留、取租 → 让位 → 持租方自清 → 恢复空闲、**不得夺权**（guardian 清不掉 sentinel 的租约）、损坏/空/缺租约文件一律不锁死、释放写「已释放」证据而非删文件。

**不需要网络，也不需要真实外部依赖**：telegram 只测判据纯函数与「缺凭据」分支（不真发）；租约测试用临时目录。

**未覆盖（显式）**：熔断路径、数据健康自动恢复路径、`SIGINT`/`SIGTERM` 优雅停止**都没有单测**——它们的逻辑内联在 `apply()` 闭包里，未抽纯函数，这是离线无法取证的根本原因；让位的**线上**观测、熔断告警端到端（真发消息）亦未完成。四条都在 [`docs/semantic.md`](docs/semantic.md) §10 登记为未决问题。

## 设计要点

- **四道闸门顺序不可换**：租约 → 数据健康 → 预检 → 端口。数据健康必须**在预检之前**——数据损坏会让 `preflight` 的试运行失败，fail-closed 于是拒绝拉起，服务**永远起不来**。
- **唯一拉起入口**：所有路径（启动自检 / 崩溃自愈 / 端口释放重拉 / 收养轮询）都走同一个 `spawnWeb()`——一处设卡处处生效；新增拉起路径若不经过它 = 闸门形同不存在（`docs/semantic.md` §5.4 调用点清单 `[MUST]`）。
- **fail-closed 是取舍不是口号**：预检不过就不拉起。旧实例可能有问题，但一个新实例没验证过更危险。
- **`sessionWaker` 不进 `inject`**：cordis 的 `inject` 是**激活门**，把可选服务写进去，sentinel 缺席时会连保活本身一起被挡住（本末倒置）。故用 `ctx.get('sessionWaker')` 可选消费，缺席时落证据行跳过。
- **零互踢**：端口被非 dsh 进程占用时只做有界等待（5s/轮、300s 上限）+ 超时告警，**从不 kill 别人的进程**；被 dsh web 占用时收养（含起自愈轮询——否则收养的实例崩了没人拉，2026-08-27 修过的竞态）。
- **租约是「同语义副本」不是跨包依赖**：`src/lease.ts` 是 `dsh-agent-sentinel/src/lease.ts` 的副本（跨包 `file:` 依赖会在消费方产生陈旧副本），**语义主副本在 sentinel 仓的语义文档**；改任一侧必须同步另一侧，两侧各有单测守护一致。guardian 侧只**读**租约（不取租不释放）。
- **告警通道为什么不直接 fetch**：Node 的 `EnvHttpProxyAgent` 只在**进程启动时**读 `NODE_USE_ENV_PROXY`（进程内设置无效），该 flag 只被注入 web 子进程——守护用它承载告警，只能 spawn 一个带 env 的 node 子进程；`curl.exe`（Schannel 版）经同一代理时 CONNECT 成功但 TLS 握手必失败（实测 exit 35），故只作兜底。子进程输出写临时文件而非管道：Windows 沙箱下管道 stdio 的 spawn 会 EPERM。
- **反定位**：不是重启协调器（归 sentinel）、不是进程管理底层（归 runtime）、不是预检判据真源（归 preflight）、不是备份器（只做消费式恢复）、**不是沙箱或权限边界**——它防「服务静默死掉没人知道」，不防恶意进程。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语表、概念模型与不变量、契约（配置 / 证据面 / 纯函数 / 调用点清单）、边界与信任、可证伪验收清单（16 条：proven 11 / pending 5）、实践修订记录、未决问题 6 条 |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `guardian-lifecycle` | 守护型进程的安全替换/重启（先新后旧、验证再杀、自愈闭环验证） |
| 技能 `guardian-robustness-audit` | 守护链健壮性审计：8 项清单（无超时/静默失败/误杀/假活/事件丢弃/上层保活语义错配） |
| 技能 `preventive-lifecycle` | 预防性存活：启动自检、冷启动自救、能力迁移核对、告警证据链 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
