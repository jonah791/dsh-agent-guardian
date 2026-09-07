/**
 * dsh-agent-guardian：守卫插件（2026-08-26 主人指令：从 dsh-agent-watch 拆分）。
 *
 * 职责：web 保活——启动时端口空闲拉起 web、崩溃自愈（快速退出计数 + 落盘事故）、
 * 收养外部 dsh web（零互踢）。**每次拉起前调用沙盒预检（ctx.preflight.run quick，
 * 消费 dsh-agent-preflight 服务）——预检不过不拉起（fail-closed）**。
 *
 * 职责边界：guardian 只做「保活」；哨兵监听 + 重启协调归 dsh-agent-sentinel。
 * 两者的共同前提都是 preflight 通过（主人 2026-08-26：借鉴「编辑前需要阅读」——
 * 任何启动/重启动作之前必须沙盒预检）。
 * @module dsh-agent-guardian
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, copyFile, mkdir, rm, rename } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import net from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'agent-guardian'

export interface Config {
  dshHome: string
  bin: string
  profile: string
  port: number
  baseUrl: string
  crashWindowMs: number
  maxQuickExits: number
  incidentFile: string
  defaultWorkspace: string
  launchCmd: string[]
  adoptExternal: boolean
  telegramBotToken: string
  telegramChatId: string
  httpProxy: string
  /** 数据健康检查 + 自动恢复（存档点联动，主人 2026-08-28 定调） */
  dataHealth: {
    /** 记忆库目录（storage-domain 落盘） */
    storagesDir: string
    /** 存档点目录（dsh-agent-checkpoint 写入） */
    checkpointDir: string
    /** 灵魂文件 */
    soulFile: string
  }
}

export const Config = z.object({
  dshHome: z.string().default(process.env.DSH_HOME || ''),
  bin: z.string().default(''),
  profile: z.string().default('web'),
  port: z.number().default(3080),
  baseUrl: z.string().default('http://127.0.0.1:3080'),
  crashWindowMs: z.number().default(30000),
  maxQuickExits: z.number().default(3),
  incidentFile: z.string().default(''),
  defaultWorkspace: z.string().default(''),
  launchCmd: z.array(z.string()).default([]),
  adoptExternal: z.boolean().default(true),
  telegramBotToken: z.string().default(''),
  telegramChatId: z.string().default(''),
  httpProxy: z.string().default('http://127.0.0.1:16888'),
  dataHealth: z.object({
    storagesDir: z.string().default(''),
    checkpointDir: z.string().default(''),
    soulFile: z.string().default(''),
  }),
})

// 注入 preflight/runtime/webman 服务（dsh-agent-preflight / dsh-agent-runtime 提供）
// 2026-09-02 重构 D2：进程管理归 ctx.webman，环境归 ctx.agentRuntime——guardian 专注保活状态机
export const inject = ['preflight', 'agentRuntime', 'webman'] as const

/** preflight 服务类型（dsh-agent-preflight 提供）。 */
export interface PreflightService {
  run(workspace: string, mode?: 'full' | 'quick'): Promise<{ pass: boolean; output: string; checks?: Record<string, { ok: boolean; detail: string }> }>
  name: string
}

/** agentRuntime 服务类型（dsh-agent-runtime 提供）。 */
export interface RuntimeService {
  readonly bin: string
  readonly profile: string
  readonly port: number
  readonly baseUrl: string
  readonly dshHome: string
  readonly workspace: string
  readonly launchCmd: string[]
  resolve(): void
}

/** webman 服务类型（dsh-agent-runtime 提供）。 */
export interface WebmanService {
  spawnWeb(workspace: string, onExit?: (code: number | null, signal: string | null) => void): Promise<ChildProcess | null>
  killWeb(pid: number): Promise<boolean>
  portOwnerPid(): Promise<number | null>
  isDshWebProcess(pid: number): Promise<boolean>
  portInUse(port?: number): Promise<boolean>
  waitPortFree(maxWaitMs?: number): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    preflight: PreflightService
    agentRuntime: RuntimeService
    webman: WebmanService
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('guardian')
  const dshHome = config.dshHome || process.env.DSH_HOME || process.cwd()
  // telegram 告警凭据单一来源（2026-09-06）：config 优先 → .credentials.yaml refs.TELEGRAM_BOT_TOKEN 兜底
  if (!config.telegramBotToken || !config.telegramChatId) {
    try {
      const cred = readFileSync(join(dshHome, '.credentials.yaml'), 'utf8')
      const m = cred.match(/^\s*TELEGRAM_BOT_TOKEN:\s*(\S+)/m)
      if (m && m[1] && !config.telegramBotToken) config.telegramBotToken = m[1]
      const mc = cred.match(/^\s*TELEGRAM_CHAT_ID:\s*(\S+)/m)
      if (mc && mc[1] && !config.telegramChatId) config.telegramChatId = mc[1]
    } catch { /* 无凭据文件 */ }
  }

  const logEvent = (msg: string) => {
    try {
      writeFileSync(join(dshHome, '.watch-events.log'), '[' + new Date().toISOString() + '] ' + msg + '\n', { flag: 'a' })
    } catch { /* 忽略 */ }
  }

  const writeIncident = (detail: Record<string, unknown>) => {
    try {
      const file = config.incidentFile || join(dshHome, '.watch-incident.json')
      mkdirSync(join(file, '..'), { recursive: true })
      writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...detail }, null, 2), 'utf8')
      logger.error('事故已落盘: ' + file)
    } catch (err) {
      logger.error('事故落盘失败: ' + String(err))
    }
  }

  const sendTelegram = async (text: string): Promise<void> => {
    const token = config.telegramBotToken
    const chat = config.telegramChatId
    if (!token || !chat) return
    const body = JSON.stringify({ chat_id: Number(chat), text, disable_notification: false })
    try {
      const child = spawn('curl.exe', [
        '-s', '--max-time', '15', '-x', config.httpProxy || 'http://127.0.0.1:16888',
        '-H', 'Content-Type: application/json', '-d', body,
        'https://api.telegram.org/bot' + token + '/sendMessage',
      ], { windowsHide: true })
      child.on('error', () => { /* 忽略 */ })
    } catch { /* 忽略 */ }
  }

  // ── 数据健康检查 + 存档点自动恢复（主人 2026-08-28：恢复与守卫联动）──
  // 保活闭环：checkpoint 插件（web 内）创建存档点 → guardian（watch 内）拉起前
  // 检查 storages 健康 → 损坏则从最近健康存档点恢复 → 再走 preflight → 拉起。
  // 顺序关键：数据损坏会让 preflight 试运行失败（fail-closed 拒绝拉起），必须先恢复。
  const dshHomeForHealth = config.dshHome || process.env.DSH_HOME || process.cwd()
  const healthStoragesDir = resolve(config.dataHealth?.storagesDir || join(dshHomeForHealth, 'storages'))
  const healthCheckpointDir = resolve(config.dataHealth?.checkpointDir || join(dshHomeForHealth, 'checkpoints'))
  const healthSoulFile = resolve(config.dataHealth?.soulFile || join(config.defaultWorkspace || process.cwd(), 'AGENTS.md'))

  const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

  /** storage-json unit 结构校验（对齐 checkpoint 插件：valid JSON / object / unit header / tables） */
  const validateStorageUnit = (text: string): string | null => {
    try {
      const doc = JSON.parse(text) as unknown
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'not a JSON object'
      const d = doc as Record<string, unknown>
      if (typeof d.unit !== 'object' || d.unit === null) return 'missing unit header'
      if (typeof d.tables !== 'object' || d.tables === null) return 'tables is not an object'
      return null
    } catch (err) { return 'invalid JSON: ' + (err as Error).message }
  }

  /** 检查当前 storages 健康：返回损坏文件清单（空 = 健康） */
  const checkStoragesHealth = async (): Promise<string[]> => {
    const issues: string[] = []
    if (!existsSync(healthStoragesDir)) return []
    for (const f of await readdir(healthStoragesDir)) {
      if (!f.endsWith('.json')) continue
      try {
        const err = validateStorageUnit(await readFile(join(healthStoragesDir, f), 'utf8'))
        if (err) issues.push(f + ': ' + err)
      } catch (err) { issues.push(f + ': 读取失败 ' + (err as Error).message) }
    }
    return issues
  }

  /** 验证单个存档点（manifest + SHA-256 + storage 结构） */
  const verifyCheckpoint = async (id: string): Promise<{ healthy: boolean; issue: string }> => {
    const dir = join(healthCheckpointDir, id)
    let manifest: { files?: Record<string, { sha256: string; size: number }> }
    try {
      manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as typeof manifest
    } catch (err) { return { healthy: false, issue: 'manifest 损坏: ' + (err as Error).message } }
    for (const [rel, meta] of Object.entries(manifest.files ?? {})) {
      let buf: Buffer
      try { buf = await readFile(join(dir, 'files', rel)) } catch { return { healthy: false, issue: rel + ': 文件缺失' } }
      if (sha256(buf) !== meta.sha256) return { healthy: false, issue: rel + ': SHA-256 不匹配' }
    }
    return { healthy: true, issue: '' }
  }

  /** 找最近健康存档点 id */
  const latestHealthyCheckpoint = async (): Promise<string | null> => {
    if (!existsSync(healthCheckpointDir)) return null
    const dirs: Array<{ id: string; ts: string }> = []
    for (const e of await readdir(healthCheckpointDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      let created = ''
      try {
        const m = JSON.parse(await readFile(join(healthCheckpointDir, e.name, 'manifest.json'), 'utf8')) as { createdAt?: string }
        created = m.createdAt ?? ''
      } catch { continue }
      dirs.push({ id: e.name, ts: created })
    }
    dirs.sort((a, b) => b.ts.localeCompare(a.ts))
    for (const d of dirs) {
      if ((await verifyCheckpoint(d.id)).healthy) return d.id
    }
    return null
  }

  /**
   * 数据健康守卫：storages 损坏 → 从最近健康存档点恢复（备份当前到 .pre-restore-*）。
   * 返回 { restored } 表示发生恢复；{ issues } 表示检查发现但无法恢复（不阻断，记录）。
   */
  const ensureDataHealthy = async (): Promise<{ restored: string | null; issues: string[] }> => {
    try {
      const bad = await checkStoragesHealth()
      if (bad.length === 0) return { restored: null, issues: [] }
      logEvent('数据健康检查 FAIL: ' + bad.join('; ') + '——尝试从存档点恢复')
      const cp = await latestHealthyCheckpoint()
      if (!cp) {
        const msg = '数据损坏且无健康存档点可恢复: ' + bad.join('; ')
        writeIncident({ message: msg, storages: bad })
        await sendTelegram('⚠ [守护] ' + msg.slice(0, 400))
        return { restored: null, issues: bad }
      }
      const manifest = JSON.parse(await readFile(join(healthCheckpointDir, cp, 'manifest.json'), 'utf8')) as { files?: Record<string, { sha256: string; size: number }> }
      const backupDir = join(healthCheckpointDir, '.pre-restore-' + Date.now())
      await mkdir(backupDir, { recursive: true })
      const restored: string[] = []
      for (const rel of Object.keys(manifest.files ?? {})) {
        const src = join(healthCheckpointDir, cp, 'files', rel)
        let dst: string
        if (rel.startsWith('storages/')) dst = join(healthStoragesDir, rel.slice('storages/'.length))
        else if (rel === 'AGENTS.md') dst = healthSoulFile
        else continue
        try {
          await mkdir(dirname(dst), { recursive: true })
          if (existsSync(dst)) await copyFile(dst, join(backupDir, rel.replaceAll('/', '__')))
          await copyFile(src, dst)
          restored.push(rel)
        } catch (err) { logEvent('恢复失败 ' + rel + ': ' + (err as Error).message) }
      }
      const msg = '数据损坏已自动恢复（存档 ' + cp + '）：' + restored.join(', ') + '；损坏项: ' + bad.join('; ')
      writeIncident({ message: 'data recovered from checkpoint', checkpoint: cp, restored, bad })
      logEvent(msg)
      await sendTelegram('✅ [守护] ' + msg.slice(0, 400))
      return { restored: cp, issues: bad }
    } catch (err) {
      return { restored: null, issues: ['ensureDataHealthy 异常: ' + (err as Error).message] }
    }
  }

  // 2026-09-02 重构 D2：进程管理抽到 dsh-agent-runtime 的 ctx.webman——
  // portInUse/portOwnerPid/isDshWebProcess/killWeb 直接用服务；waitPortFree 保留本地带日志封装
  const portInUse = ctx.webman.portInUse
  const portOwnerPid = ctx.webman.portOwnerPid
  const isDshWebProcess = ctx.webman.isDshWebProcess
  const killWeb = ctx.webman.killWeb

  const waitPortFree = async (maxWaitMs = 300000): Promise<boolean> => {
    const deadline = Date.now() + maxWaitMs
    let waited = 0
    while (await ctx.webman.portInUse(ctx.agentRuntime.port)) {
      if (Date.now() > deadline) {
        logEvent('端口 ' + String(ctx.agentRuntime.port) + ' 等待超时（' + Math.round(maxWaitMs / 1000) + 's），放弃等待')
        return false
      }
      waited += 1
      if (waited % 6 === 1) logEvent('端口 ' + String(ctx.agentRuntime.port) + ' 仍被占用（已等 ' + String(waited * 5) + 's）')
      await sleep(5000)
    }
    return true
  }

  const state: {
    child: ChildProcess | null
    quickExitCount: number
    lastExitAt: number
    manualStop: boolean
    lastWorkspace: string
    externalPid: number | null
    externalTimer: NodeJS.Timeout | null
  } = {
    child: null,
    quickExitCount: 0,
    lastExitAt: 0,
    manualStop: false,
    lastWorkspace: '',
    externalPid: null,
    externalTimer: null,
  }

  /**
   * 拉起 web（统一入口）。【preflight gate】：每次拉起前调 ctx.preflight.run(quick)
   * ——快速静态+磁盘+会话日志检查，预检不过不拉起（fail-closed，主人 2026-08-26）。
   */
  const spawnWeb = (workspace: string): Promise<void> =>
    new Promise((resolvePromise) => {
      void (async () => {
        // 【数据健康 gate · 主人 2026-08-28】所有拉起路径前置：storages 损坏 →
        // 从最近健康存档点恢复（存档点联动），再走 preflight。顺序关键：数据损坏会让
        // preflight 试运行失败（fail-closed 拒绝拉起）→ 永远起不来。
        const dh = await ensureDataHealthy()
        if (dh.restored) {
          logEvent('数据健康已恢复（存档 ' + dh.restored + '），继续 preflight')
        } else if (dh.issues.length > 0) {
          logEvent('数据健康检查未解决（不阻断拉起，记录）: ' + dh.issues.join('; '))
        }
        // 【强制 preflight gate】所有拉起路径统一前置（quick：静态+磁盘+会话日志，毫秒级）
        let gate: { pass: boolean; output: string }
        try {
          gate = await ctx.preflight.run(workspace, 'quick')
        } catch (e) {
          gate = { pass: false, output: '[guardian] preflight 服务调用失败: ' + String(e) }
        }
        if (!gate.pass) {
          writeIncident({ message: 'preflight gate failed; web NOT started', workspace, detail: gate.output.slice(-1500) })
          logEvent('预检 gate FAIL，拒绝拉起 web: ' + gate.output.slice(-300))
          await sendTelegram('⚠ [守护] 拉起被预检 gate 拦截（' + new Date().toLocaleTimeString() + '）：\n' + gate.output.slice(-400))
          resolvePromise()
          return
        }
        // 端口最终防线
        const owner = await portOwnerPid()
        if (owner !== null) {
          if (await isDshWebProcess(owner)) {
            logEvent('端口被活 dsh web 占用（PID ' + owner + '）——收养接管，跳过拉起')
            state.externalPid = owner
            ensureExternalTimer(owner) // 2026-08-27 修复：收养也必须启动自愈轮询（否则崩溃后不拉起）
            return
          }
          logEvent('端口 ' + String(config.port) + ' 被非 dsh 进程占用，等待释放...')
          const freed = await waitPortFree()
          if (state.manualStop) return
          if (!freed) {
            logEvent('端口等待超时，写事故并告警（占用者未能释放，跳过拉起）')
            writeIncident({ message: '端口 ' + String(config.port) + ' 等待超时，占用者未能释放，跳过拉起' })
            void sendTelegram('⚠ [守护] 端口 ' + String(config.port) + ' 等待超时（非 dsh 进程占用未释放）——请人工检查占用进程')
            return
          }
        }
        // 2026-09-02 重构 D2：底层 spawn 归 ctx.webman；guardian 保留 state 跟踪（崩溃自愈需要）
        state.lastWorkspace = workspace
        let spawned: ChildProcess | null = null
        spawned = await ctx.webman.spawnWeb(workspace, (code, signal) => {
          if (state.child !== null && spawned !== null && state.child.pid === spawned.pid) state.child = null
          onWebExit(code, signal)
        })
        state.child = spawned
        resolvePromise()
      })()
    })

  const onWebExit = (code: number | null, signal: string | null) => {
    const now = Date.now()
    const quick = now - state.lastExitAt < config.crashWindowMs
    state.lastExitAt = now
    if (state.manualStop) return
    void (async () => {
      if (await portInUse(ctx.agentRuntime.port)) {
        // 端口被占用：先判断占用者类型（2026-08-31 修复：不再无脑无限等待）
        const owner = await portOwnerPid()
        if (owner !== null && await isDshWebProcess(owner)) {
          logEvent('web 退出但端口被活 dsh web 占用（PID ' + owner + '）——收养接管，跳过拉起')
          state.externalPid = owner
          ensureExternalTimer(owner)
          return
        }
        logEvent('web 退出且端口被非 dsh 进程占用——进入端口等待模式（含 ' + Math.round(300000 / 1000) + 's 超时）')
        const freed = await waitPortFree()
        if (state.manualStop) return
        if (!freed) {
          logEvent('端口等待超时，写事故并告警（占用者未能释放）')
          writeIncident({ code, signal: String(signal), message: '端口 ' + String(config.port) + ' 等待超时，占用者未能释放' })
          void sendTelegram('⚠ [守护] 端口 ' + String(config.port) + ' 等待超时（占用者未释放）——请人工检查占用进程')
          return
        }
        logEvent('端口已释放，重新拉起 web')
        void spawnWeb(state.lastWorkspace)
        return
      }
      state.quickExitCount = quick ? state.quickExitCount + 1 : 0
      logger.warn('web 退出（code=' + String(code) + ' signal=' + String(signal) + '）quick=' + String(quick) + ' count=' + String(state.quickExitCount))
      logEvent('web 退出 code=' + String(code) + ' signal=' + String(signal) + ' quickCount=' + String(state.quickExitCount))
      if (state.quickExitCount >= config.maxQuickExits) {
        logger.error('连续 ' + String(config.maxQuickExits) + ' 次快速退出——停止自动重启')
        writeIncident({ code, signal: String(signal), message: 'web 连续 ' + String(config.maxQuickExits) + ' 次快速退出，已停止自动重启' })
        void sendTelegram('⚠ [守护] web 连续 ' + String(config.maxQuickExits) + ' 次快速退出，已停止自动重启——请人工检查 web 启动日志')
        return
      }
      setTimeout(() => {
        if (!state.manualStop && state.child === null && state.lastWorkspace) {
          void spawnWeb(state.lastWorkspace)
        }
      }, 5000)
    })()
  }

  // 收养外部 dsh web（启动时端口被占且是 dsh web → 托管 + 轮询自愈）
  // 2026-08-27 修复竞态：抽 ensureExternalTimer 统一入口——spawnWeb 收养与 adoptExternalWeb 共用，
  // 避免「spawnWeb 设置 externalPid 但无 timer → 收养的 web 崩溃后不拉起」。
  const ensureExternalTimer = (pid: number): void => {
    if (state.externalTimer) clearInterval(state.externalTimer)
    state.externalTimer = setInterval(() => {
      if (state.manualStop || state.externalPid === null) return
      try { process.kill(state.externalPid, 0) } catch {
        logEvent('收养的 web（PID ' + String(state.externalPid) + '）已退出——由守护拉起')
        state.externalPid = null
        void (async () => {
          if (state.child !== null) return
          const owner = await portOwnerPid()
          if (owner !== null) {
            if (await isDshWebProcess(owner)) { state.externalPid = owner; ensureExternalTimer(owner); return }
            const freed = await waitPortFree()
            if (!freed) {
              logEvent('收养 web 退出后端口等待超时，写事故并告警')
              writeIncident({ message: '收养 web 退出后端口 ' + String(config.port) + ' 等待超时，占用者未能释放' })
              void sendTelegram('⚠ [守护] 收养 web 退出后端口 ' + String(config.port) + ' 等待超时——请人工检查占用进程')
              return
            }
          }
          if (state.manualStop) return
          void spawnWeb(state.lastWorkspace || config.defaultWorkspace || process.cwd())
        })()
      }
    }, 5000)
  }

  const adoptExternalWeb = async (): Promise<void> => {
    const pid = await portOwnerPid()
    if (!pid) return
    if (state.externalPid === pid) return
    if (!(await isDshWebProcess(pid))) {
      logEvent('端口被非 dsh web 进程占用（PID ' + pid + '），不收养不拉起')
      return
    }
    state.externalPid = pid
    logEvent('收养外部 dsh web（PID ' + pid + '）：此后由守护托管')
    ensureExternalTimer(pid)
  }

  const onSig = () => {
    state.manualStop = true
    logger.info('收到停止信号，关闭 web ...')
    if (state.externalTimer) { clearInterval(state.externalTimer); state.externalTimer = null }
    if (state.child) {
      if (state.child.pid) void killWeb(state.child.pid)
    } else if (state.externalPid !== null) {
      void killWeb(state.externalPid)
    }
  }
  process.on('SIGINT', onSig)
  process.on('SIGTERM', onSig)

  ctx.effect(() => {
    logger.info('dsh-agent-guardian 就绪：保活 web @ :' + String(config.port) + '，拉起前强制 preflight(quick)')
    logEvent('guardian 就绪 保活:' + String(config.port))
    void (async () => {
      await sleep(1500)
      if (state.manualStop || state.child) return
      if (!(await portInUse(config.port))) {
        logger.info('端口 ' + String(config.port) + ' 未被占用，自动拉起 web...')
        logEvent('端口空闲，guardian 自动拉起 web')
        await spawnWeb(config.defaultWorkspace || process.cwd())
      } else if (config.adoptExternal) {
        logEvent('端口已被占用——尝试收养外部 dsh web')
        await adoptExternalWeb()
      } else {
        logger.info('端口 ' + String(config.port) + ' 已有服务在跑（不重复拉起）')
      }
    })()
    return () => {
      process.removeListener('SIGINT', onSig)
      process.removeListener('SIGTERM', onSig)
      if (state.child) state.child.kill()
    }
  })
}
