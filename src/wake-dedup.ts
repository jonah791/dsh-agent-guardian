/**
 * wake-dedup.ts — 拉起后唤醒去重（纯判据）
 *
 * 2026-10-15 线上实测驱动：`拉起后唤醒已发送` 72 条里 **8 次成对**（≈11%），
 * 最近 `2026-10-15T02:57:06Z`（两条间隔 11ms）。
 *
 * 事故形状：`spawnWeb` 全程无并发互斥，两次并发调用各自走完「查租约 → preflight →
 * 端口防线 → spawn」——都在端口还空着时通过防线、都 spawn 成功 ⇒ `notifyWebReady`
 * 被调两次。租约闸门只拦得住 guardian vs sentinel（守护自己不取租），
 * **拦不住 guardian vs guardian**。
 *
 * 为什么单独成模块：判据要能被离线测（SOUL §5.9 §2「防线必须有尸体测试」）——
 * 内联在 apply 闭包里的比较喂不进坏样本，等于没有防线。
 *
 * 窗口标定依据：成对的两条间隔是**毫秒级**（并发指纹），而正常两次拉起相隔
 * **分钟级** ⇒ 5s 窗口有巨大余量。**不动 spawnWeb**：锁泄漏会让 web 永远起不来
 * （致命），而去重最坏只漏一条提醒（非致命）——两侧代价不对称时，取严在
 * 「不碰生命线」这一侧。
 */

/** 去重窗口（ms） */
export const WAKE_DEDUP_MS = 5_000

/**
 * 本次唤醒是否应当投递。
 *
 * @param nowMs 本次投递时刻（epoch ms）
 * @param lastDeliveredAtMs 上次投递时刻；`0` 表示「从未投递」
 * @param windowMs 去重窗口（缺省 `WAKE_DEDUP_MS`）
 * @returns `true` = 放行；`false` = 落在窗口内，跳过
 *
 * 时钟回拨（`nowMs < lastDeliveredAtMs`）时差值为负 ⇒ 判 false（跳过）——
 * 保守侧是「少发一条提醒」，不阻塞保活。
 */
export const shouldDeliverWake = (
  nowMs: number,
  lastDeliveredAtMs: number,
  windowMs: number = WAKE_DEDUP_MS,
): boolean => {
  if (lastDeliveredAtMs === 0) return true
  return nowMs - lastDeliveredAtMs >= windowMs
}
