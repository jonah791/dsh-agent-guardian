# dsh-agent-guardian


<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-guardian"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
> 守卫插件：web 保活——拉起 / 崩溃自愈 / 收养外部 dsh web。
> DeepSeek Harness 自研插件 · v0.1.1（从 dsh-agent-watch 拆分）

## 定位

让 DeepSeek Harness web 服务**永不静默死亡**：端口空闲时拉起、崩溃时自愈、外部启动的 web 被收养（零互踢）。与哨兵（sentinel）分工：guardian 管「活着」，sentinel 管「重启」。

## 功能特性

- **启动时拉起**：端口空闲时自动拉起 web（配合运行时服务 runtime 环境发现）
- **崩溃自愈**：快速退出计数 + 落盘事故，崩溃后自动重启
- **收养外部 web**：检测到外部启动的 dsh web（非本进程 spawn），收养为受管实例（零互踢）
- **预检门控（fail-closed）**：崩溃自愈 / 拉起前调用沙盒预检（`ctx.preflight.run` quick 模式，消费 dsh-agent-preflight 服务）——预检不过**不拉起**，防止带病重启
- **不越权**：不负责哨兵监听与重启协调（归 dsh-agent-sentinel），单一职责

## 安装

```bash
git clone https://github.com/jonah791/dsh-agent-guardian.git self-plugins/dsh-agent-guardian
cd self-plugins/dsh-agent-guardian && pnpm install && pnpm build
```

在 DSH 的 watch profile 添加插件行（与 sentinel / preflight / runtime 同 profile 协作）。

## 使用

- **守护进程模式**：挂载到 watch profile 后自动运行——无需人工干预
- **依赖服务**：`ctx.preflight.run`（dsh-agent-preflight）用于预检门控；`ctx.runtime`（dsh-agent-runtime）用于环境发现

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `quickExitCount` | 配置值 | 快速退出计数阈值（崩溃判定） |

## 技术要点

- **fail-closed 设计**：预检不过不拉起——「旧实例可能有问题，但新实例没验证过更危险」
- **零互踢**：收养外部 web 而非杀掉重启，避免多人/多进程操作同一端口冲突
- 三插件分工（guardian / sentinel / preflight）消除了原 dsh-agent-watch 的单体耦合

## 告警传输（2026-09-11 修正）

Telegram 告警走 `src/alert-transport.ts`：**主通道** spawn node 子进程（注入 `NODE_USE_ENV_PROXY=1`）执行内置 `fetch`，**兜底通道** `curl.exe -x <proxy>`；两条通道的结论都落盘（发送中／送达通道／失败原因），不再有静默分支。

修正原因（本机实测）：`curl.exe` 是 Schannel 版（8.21.0），经 clash 代理时 CONNECT 隧道建立成功（`HTTP/1.1 200 Connection established`）但随后的 TLS 握手一律失败 —— `curl -s -x http://127.0.0.1:16888 https://api.telegram.org` 返回 **exit 35**，`-k`／`--http1.1`／`--tlsv1.2` 各变体同样 35；同一代理、同一时刻 Node `fetch`（OpenSSL）成功（`getMe` ok=true 1.3s，`sendMessage` 实测送达）。即 curl 通道在本环境**结构性不可用**，而它承载的正是「崩溃循环熔断」这类只能靠外部告警告知主人的防线。

为什么不在守护进程内直接 fetch：Node 的 `EnvHttpProxyAgent` 只在**进程启动时**读取 `NODE_USE_ENV_PROXY`（实测进程内设置该变量后 fetch 仍不走代理、12s 超时），而该 flag 只被注入 web 子进程 —— 故用子进程承载。

判据（`judgeTelegramResponse`，离线单测含尸体样本）：**退出码 0 且响应体 `ok === true`** 才算送达；实测存在「exit 0 但 API ok=false」的形态，单看退出码会误报。

## License

MIT
