import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prefixCandidates } from '../src/candidates.ts'

test('workspace clause retains conjunction and original UTF-16 offsets', () => {
  const draft = '我想知道当前工作区的位置，然后'
  const first = prefixCandidates(draft)[0]!
  assert.equal(draft.slice(0, first.sendEnd), '我想知道当前工作区的位置')
  assert.equal(draft.slice(first.consumeEnd), '然后')
  const emoji = '请解释 👋 的含义，然后'
  const span = prefixCandidates(emoji)[0]!
  assert.equal(emoji.slice(span.consumeEnd), '然后')
})

test('quoted, bracketed and code punctuation does not create internal boundaries', () => {
  for (const draft of ['请解释“你好，然后继续”的含义', '请解释（你好，然后继续）的含义', '请解释 `print("hello, world")` 的含义']) {
    assert.equal(prefixCandidates(draft).length, 1)
    assert.equal(prefixCandidates(draft)[0]!.sendEnd, draft.length)
  }
  assert.deepEqual(prefixCandidates('请解释“尚未结束，然后'), [])
})

test('bounds are unique, bounded, and consume separators only', () => {
  const draft = '第一句话，第二句话，第三句话，第四句话。第五句话'
  const spans = prefixCandidates(draft)
  assert.equal(spans.length, 3)
  for (const span of spans) assert.match(draft.slice(span.sendEnd, span.consumeEnd), /^[\s，,。！？!?；;]*$/u)
})
