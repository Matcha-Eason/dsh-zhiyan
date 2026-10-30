import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { preview } from '../src/host/preview.ts'
import { parseSuggestion, type PreviewRequest } from '../src/protocol.ts'

const request: PreviewRequest = {
  running: false, sessionId: 's1', draft: '我想同时做十个功能，第一周全部上线。', draftRev: 1, contextRevision: -1,
  model: { provider: 'session-provider', model: 'selected-main', reasoningEffort: 'off' },
}
const context = { revision: -1, messages: [] }
const options = {
  apiKey: 'test-only', signal: new AbortController().signal, decisionTimeoutMs: 1_000, mainTimeoutMs: 1_000,
  persona: async () => '你是 DSH 会话里设定的简洁搭档。',
  fetch: async () => Response.json({ answers: { action: { type: 'choice', choice: 'suggest' } } }),
  stream: async function* (call: GenerateOptions): AsyncIterable<StreamChunk> {
    assert.equal(call.provider, request.model.provider)
    assert.equal(call.model, request.model.model)
    assert.equal(call.reasoningEffort, 'off')
    assert.deepEqual(call.tools, [])
    assert.equal(call.messages.length, 1)
    assert.match(call.system!, /advice 必填/)
    assert.ok(call.system!.startsWith('你是 DSH 会话里设定的简洁搭档。'))
    yield { type: 'text-delta', index: 0, text: '{"advice":"十个功能一周上线，是在排工期还是在许愿？先选一个闭环。"}' }
    yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 30 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

test('opinion-only response is valid; selected main route is used, with no tools', async () => {
  const result = await preview(request, context, options)
  assert.equal(result.action, 'suggest')
  if (result.action !== 'suggest') return
  assert.match(result.advice, /闭环/)
  assert.equal(result.completion, undefined)
  assert.equal(result.metrics.usage?.outputTokens, 30)
})

test('mandatory opinion, optional continuation and exact leading spaces', () => {
  assert.deepEqual(parseSuggestion('{"advice":"先缩小范围。","completion":" 先只做一件事。"}'), { advice: '先缩小范围。', completion: ' 先只做一件事。' })
  assert.deepEqual(parseSuggestion('```json\n{"advice":"先缩小范围。","completion":null}\n```'), { advice: '先缩小范围。' })
  for (const value of ['{}', '{"completion":"只有续写"}', '{"advice":"  ","completion":"续写"}', '{"advice":false}', 'not json']) {
    assert.throws(() => parseSuggestion(value))
  }
})

test('System 1 wait never calls main model', async () => {
  const result = await preview(request, context, {
    ...options,
    fetch: async () => Response.json({ answers: { action: { choice: 'wait' } } }),
    persona: async () => { throw new Error('must not assemble persona for wait') },
    stream: async function* () { throw new Error('must not call'); yield {} as StreamChunk },
  })
  assert.equal(result.action, 'wait')
})

test('bad decision response and provider error never fall back to another model', async () => {
  for (const response of [Response.json({ answers: { action: { choice: 'submit' } } }), new Response('', { status: 401 })]) {
    await assert.rejects(preview(request, context, {
      ...options, fetch: async () => response,
      stream: async function* () { throw new Error('must not call'); yield {} as StreamChunk },
    }), /decision-/)
  }
})

for (const finish of ['missing', 'max-tokens', 'tool-calls'] as const) test(`rejects ${finish} terminal response`, async () => {
  await assert.rejects(preview(request, context, {
    ...options,
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '{"advice":"有意见"}' } as StreamChunk
      if (finish !== 'missing') yield { type: 'finish', reason: { kind: finish } } as StreamChunk
    },
  }), /main-incomplete-response/)
})

test('aborted call cannot publish a completed response', async () => {
  const abort = new AbortController()
  await assert.rejects(preview(request, context, {
    ...options, signal: abort.signal,
    stream: async function* () {
      abort.abort()
      yield { type: 'text-delta', index: 0, text: '{"advice":"迟到意见"}' } as StreamChunk
    },
  }), { name: 'AbortError' })
})

for (const action of ['submit_prefix', 'steer'] as const) test(`${action} selects original span without an auxiliary answer`, async () => {
  const input = { ...request, draft: '我想知道当前工作区的位置，然后', running: action === 'steer' }
  const result = await preview(input, context, {
    ...options,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.ok(body.questions.action.criteria[action])
      assert.equal(body.state.running, input.running)
      return Response.json({ answers: { action: { choice: action, confidence: 0.98 } } })
    },
    stream: async function* () { throw new Error('must not call auxiliary model'); yield {} as StreamChunk },
    persona: async () => { throw new Error('must not assemble persona for submission') },
  })
  assert.equal(result.action, action)
  if (result.action !== 'submit_prefix' && result.action !== 'steer') return
  assert.equal(input.draft.slice(0, result.candidate.sendEnd), '我想知道当前工作区的位置')
  assert.equal(input.draft.slice(result.candidate.consumeEnd), '然后')
})

test('a capped opinion budget still permits decisions, but no extra opinion generation', async () => {
  const result = await preview(request, context, {
    ...options, allowSuggestion: () => false,
    stream: async function* () { throw new Error('must not call auxiliary model'); yield {} as StreamChunk },
  })
  assert.equal(result.action, 'wait')
})

test('unoffered candidates and idle steer are rejected', async () => {
  for (const choice of ['submit_prefix_c999', 'steer']) {
    await assert.rejects(preview(request, context, { ...options, fetch: async () => Response.json({ answers: { action: { choice } } }) }), /decision-invalid-response/)
  }
})

test('unfinished questions and explicit withdrawal never reach the classifier or main model', async () => {
  for (const draft of ['我想知道当前工作区的位置是否', '请查当前目录，但先别执行', '先删除这些文件，然后，不对……']) {
    const result = await preview({ ...request, draft }, context, { ...options, fetch: async () => { throw new Error('must wait locally') } })
    assert.equal(result.action, 'wait')
  }
})

test('automatic submission requires a finite confidence above the configured threshold', async () => {
  for (const confidence of [undefined, 0.3, 0.89, 1.1]) {
    const result = await preview({ ...request, draft: '请告诉我当前工作区的位置，然后' }, context, {
      ...options, fetch: async () => Response.json({ answers: { action: { choice: 'submit_prefix', confidence } } }),
    })
    assert.equal(result.action, 'wait')
  }
})
