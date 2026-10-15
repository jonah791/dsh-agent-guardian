/**
 * 拉起后唤醒去重单测（2026-10-15）
 *
 * 关键样本是**尸体样本**：用线上真实成对记录的时刻表喂进去——
 * `2026-10-15T02:58:53.609Z` 与 `.620Z`（间隔 11ms）是 8 次成对之一，
 * 第二条**必须被拦**。若这条不成立，本次修复就是假的。
 *
 * 对照组：窗口设 0 时同一条尸体**必须放行**——证明「拦住」是窗口的功劳，
 * 不是判据恒 false（SOUL §5.9：恒为空的输出不是证据）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { shouldDeliverWake, WAKE_DEDUP_MS } from '../lib/wake-dedup.js'

// 线上真实成对（.watch-events.log 2026-10-15T02:58:53.609Z / .620Z）
const T_DUP_1 = Date.parse('2026-10-15T02:58:53.609Z')
const T_DUP_2 = Date.parse('2026-10-15T02:58:53.620Z')
// 正常两次拉起（02:45:53 与 02:57:06，相隔 11 分钟）
const T_NORMAL_1 = Date.parse('2026-10-15T02:45:53.285Z')
const T_NORMAL_2 = Date.parse('2026-10-15T02:57:06.449Z')

describe('shouldDeliverWake · 纯判据', () => {
  test('尸体样本：11ms 内成对的第二条必须被拦', () => {
    assert.equal(shouldDeliverWake(T_DUP_1, 0), true, '首条放行')
    assert.equal(shouldDeliverWake(T_DUP_2, T_DUP_1), false, '11ms 后第二条被拦')
  })

  test('金标准：相隔 11 分钟的正常唤醒必须放行', () => {
    assert.equal(shouldDeliverWake(T_NORMAL_2, T_NORMAL_1), true)
  })

  test('对照组：窗口=0 时同一条尸体必须放行（证明判据有区分力）', () => {
    assert.equal(shouldDeliverWake(T_DUP_2, T_DUP_1, 0), true)
  })

  test('边界：恰好等于窗口放行，差 1ms 拦截', () => {
    assert.equal(shouldDeliverWake(10_000, 5_000, 5_000), true)
    assert.equal(shouldDeliverWake(9_999, 5_000, 5_000), false)
  })

  test('从未投递（0）放行', () => {
    assert.equal(shouldDeliverWake(1_000, 0), true)
  })

  test('时钟回拨走保守侧（跳过，不阻塞保活）', () => {
    assert.equal(shouldDeliverWake(1_000, 5_000), false)
  })

  test('缺省窗口就是 WAKE_DEDUP_MS', () => {
    assert.equal(WAKE_DEDUP_MS, 5_000)
    assert.equal(shouldDeliverWake(WAKE_DEDUP_MS + 1, 1), true)
    assert.equal(shouldDeliverWake(WAKE_DEDUP_MS - 1, 1), false)
  })
})
