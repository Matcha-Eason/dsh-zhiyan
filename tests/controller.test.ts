import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { PreviewController, type DraftSnapshot } from '../src/client/controller.ts'
import type { PreviewRequest, PreviewResult } from '../src/protocol.ts'

function draft(text = '我想做个提醒应用', overrides: Partial<DraftSnapshot> = {}): DraftSnapshot {
  return {
    sessionId: 's1', draft: text, draftRev: 1, contextRevision: -1,
    start: text.length, end: text.length, focused: true, composing: false, running: false, ...overrides,
  }
}
const suggestion: PreviewResult = {
  action: 'suggest', advice: '先想清楚是谁设置提醒，别把所有功能塞进第一版。',
  model: { provider: 'chosen-provider', model: 'chosen-model' }, metrics: { decisionMs: 40, mainMs: 60, totalMs: 100 },
}

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 })
  const calls: { request: PreviewRequest; signal: AbortSignal; resolve: (value: PreviewResult) => void; reject: (error: Error) => void }[] = []
  const controller = new PreviewController((request, signal) => new Promise((resolve, reject) => { calls.push({ request, signal, resolve, reject }) }))
  t.after(() => controller.dispose())
  return { controller, calls, async advance(ms: number) { t.mock.timers.tick(ms); await setImmediate() } }
}

test('opt-in, idle debounce and semantic sentence trigger', async t => {
  const { controller, calls, advance } = setup(t)
  controller.update(draft())
  await advance(1_000)
  assert.equal(calls.length, 0)
  controller.setEnabled(true)
  await advance(799)
  assert.equal(calls.length, 0)
  await advance(1)
  assert.equal(calls.length, 1)
  calls[0]!.resolve({ action: 'wait', metrics: { decisionMs: 1, totalMs: 1 } })
  await advance(60_000)
  assert.equal(calls.length, 1, 'unchanged draft must not poll')
  controller.update(draft('我想做个提醒应用，', { draftRev: 2 }))
  await advance(200)
  controller.update(draft('我想做个提醒应用，主要', { draftRev: 3 }))
  await advance(100)
  assert.equal(calls.length, 2, 'a stable sentence can trigger while the user continues typing')
})

test('append preserves opinion; latest snapshot replaces the queue', async t => {
  const { controller, calls, advance } = setup(t)
  controller.update(draft())
  controller.setEnabled(true)
  await advance(800)
  controller.update(draft('我想做个提醒应用，给老人用', { draftRev: 2 }))
  controller.update(draft('我想做个提醒应用，给老人用，不接硬件', { draftRev: 3 }))
  await advance(9_000)
  assert.equal(calls.length, 1, 'one in flight even after multiple edits')
  assert.equal(calls[0]!.signal.aborted, false)
  calls[0]!.resolve(suggestion)
  await advance(0)
  assert.equal(controller.getSnapshot().opinion?.advice, suggestion.advice)
  assert.equal(controller.getSnapshot().opinion?.earlier, true)
  await advance(0)
  assert.equal(calls.length, 2)
  assert.match(calls[1]!.request.draft, /不接硬件$/)
})

test('backspace aborts and late results never surface; next request waits for cancellation settlement', async t => {
  const { controller, calls, advance } = setup(t)
  controller.update(draft())
  controller.setEnabled(true)
  await advance(800)
  controller.update(draft('换个完全不同的想法', { draftRev: 2 }))
  assert.equal(calls[0]!.signal.aborted, true)
  await advance(5_000)
  assert.equal(calls.length, 1)
  calls[0]!.resolve(suggestion)
  await advance(0)
  assert.equal(controller.getSnapshot().opinion, undefined)
  await advance(0)
  assert.equal(calls.length, 2)
})

test('clearing the draft removes the opinion, emoji and metrics while keeping opt-in', async t => {
  const { controller, calls, advance } = setup(t)
  controller.update(draft())
  controller.setEnabled(true)
  await advance(800)
  calls[0]!.resolve(suggestion)
  await advance(0)
  assert.equal(controller.getSnapshot().status, 'suggested')
  controller.update(draft('  \n', { draftRev: 2 }))
  assert.equal(controller.getSnapshot().enabled, true)
  assert.equal(controller.getSnapshot().status, 'idle')
  assert.equal(controller.getSnapshot().opinion, undefined)
  assert.equal(controller.getSnapshot().metrics, undefined)
  await advance(60_000)
  assert.equal(calls.length, 1)
})

test('clearing during a decision cancels it and does not revive a late opinion', async t => {
  const { controller, calls, advance } = setup(t)
  controller.update(draft())
  controller.setEnabled(true)
  await advance(800)
  controller.update(draft('', { draftRev: 2 }))
  assert.equal(calls[0]!.signal.aborted, true)
  assert.equal(controller.getSnapshot().status, 'idle')
  calls[0]!.resolve(suggestion)
  await advance(0)
  assert.equal(controller.getSnapshot().opinion, undefined)
  controller.update(draft('我想先做一个小工具', { draftRev: 3 }))
  await advance(800)
  assert.equal(calls.length, 2)
})

for (const [name, change] of [
  ['context', { contextRevision: 25 }],
  ['session', { sessionId: 's2' }],
  ['formal task', { blocked: '正式任务进行中，预览暂停' }],
] as const) test(`${name} change cancels stale output`, async t => {
  const { controller, calls, advance } = setup(t)
  controller.update(draft())
  controller.setEnabled(true)
  await advance(800)
  controller.update(draft(undefined, change))
  assert.equal(calls[0]!.signal.aborted, true)
  calls[0]!.resolve(suggestion)
  await advance(0)
  assert.equal(controller.getSnapshot().opinion, undefined)
  controller.update(draft('', { draftRev: 2 }))
  assert.equal(controller.getSnapshot().status, 'idle')
  assert.equal(controller.getSnapshot().detail, undefined)
})

test('IME confirmation, selection and focus gate new previews', async t => {
  const { controller, calls, advance } = setup(t)
  controller.update(draft(undefined, { composing: true }))
  controller.setEnabled(true)
  await advance(5_000)
  assert.equal(calls.length, 0)
  controller.update(draft(undefined, { focused: false }))
  await advance(5_000)
  assert.equal(calls.length, 0)
  controller.update(draft(undefined, { start: 0 }))
  await advance(5_000)
  assert.equal(calls.length, 0)
  controller.update(draft())
  await advance(0)
  assert.equal(calls.length, 1)
})

test('Enter/dismiss cancels immediately and does not retry the same draft', async t => {
  const { controller, calls, advance } = setup(t)
  controller.update(draft())
  controller.setEnabled(true)
  await advance(800)
  controller.dismiss()
  assert.equal(calls[0]!.signal.aborted, true)
  calls[0]!.resolve(suggestion)
  await advance(60_000)
  assert.equal(calls.length, 1)
  assert.equal(controller.getSnapshot().opinion, undefined)
})

test('decision budget is independent from the six-per-minute opinion budget', async t => {
  const { controller, calls, advance } = setup(t)
  controller.update(draft())
  controller.setEnabled(true)
  await advance(800)
  for (let i = 1; i <= 40; i++) {
    assert.equal(calls.length, i)
    calls[i - 1]!.resolve({ action: 'wait', metrics: { decisionMs: 1, totalMs: 1 } })
    await advance(0)
    controller.update(draft(`我想做一个计划，编号是${i}`, { draftRev: i + 1 }))
    await advance(750)
  }
  assert.equal(calls.length, 40)
  await advance(30_000)
  assert.equal(calls.length, 41)
})

test('failure has no automatic retry and preserves editor ownership', async t => {
  const { controller, calls, advance } = setup(t)
  controller.update(draft())
  controller.setEnabled(true)
  await advance(800)
  calls[0]!.reject(new Error('invalid-suggestion'))
  await advance(0)
  assert.match(controller.getSnapshot().detail!, /未返回完整意见/)
  await advance(60_000)
  assert.equal(calls.length, 1)
  assert.equal(controller.getSnapshot().opinion, undefined)
  controller.update(draft('', { draftRev: 2 }))
  assert.equal(controller.getSnapshot().status, 'idle')
  assert.equal(controller.getSnapshot().detail, undefined)
})

test('complete task drafts stay intact and Enter dismisses discussion work', async t => {
  const { controller, calls, advance } = setup(t)
  const text = '我想知道当前工作区的位置，然后'
  const input = draft(text)
  controller.update(input)
  controller.setEnabled(true)
  await advance(800)
  assert.equal(calls[0]!.request.draft, text)
  calls[0]!.resolve({ action: 'wait', metrics: { decisionMs: 10, totalMs: 10 } })
  await advance(60_000)
  assert.equal(input.draft, text)
  assert.equal(controller.getSnapshot().status, 'idle')
  assert.equal(calls.length, 1)
  controller.update(draft(text + '用一句话解释它', { draftRev: 2 }))
  controller.dismiss()
  await advance(60_000)
  assert.equal(calls.length, 1, 'manual submission cancels the pending discussion')
})

test('running tasks pause discussions without requesting a decision, then resume when idle', async t => {
  const { controller, calls, advance } = setup(t)
  controller.update(draft('等等，只查 src 目录，', { running: true }))
  controller.setEnabled(true)
  await advance(60_000)
  assert.equal(calls.length, 0)
  assert.equal(controller.getSnapshot().status, 'blocked')
  controller.update(draft('等等，只查 src 目录，', { running: false }))
  await advance(800)
  assert.equal(calls.length, 1)
  assert.equal(controller.getSnapshot().detail, undefined)
})

test('task start cancels an in-flight discussion and its late reply', async t => {
  const { controller, calls, advance } = setup(t)
  controller.update(draft())
  controller.setEnabled(true)
  await advance(800)
  controller.update(draft(undefined, { running: true }))
  assert.equal(calls[0]!.signal.aborted, true)
  calls[0]!.resolve(suggestion)
  await advance(60_000)
  assert.equal(controller.getSnapshot().opinion, undefined)
  assert.equal(calls.length, 1)
})
