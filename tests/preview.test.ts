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
  assert.equal('completion' in result, false)
  assert.equal(result.metrics.usage?.outputTokens, 30)
})

test('requires an opinion and discards legacy continuation fields', () => {
  assert.deepEqual(parseSuggestion('{"advice":"先缩小范围。","completion":" 先只做一件事。"}'), { advice: '先缩小范围。' })
  assert.deepEqual(parseSuggestion('```json\n{"advice":" 先缩小范围。 "}\n```'), { advice: '先缩小范围。' })
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

test('a capped opinion budget still permits decisions, but no extra opinion generation', async () => {
  const result = await preview(request, context, {
    ...options, allowSuggestion: () => false,
    stream: async function* () { throw new Error('must not call auxiliary model'); yield {} as StreamChunk },
  })
  assert.equal(result.action, 'wait')
})

test('legacy execution decisions are rejected even at full confidence', async () => {
  for (const choice of ['submit_prefix', 'submit_prefix_c0', 'steer']) {
    await assert.rejects(preview(request, context, {
      ...options,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        assert.deepEqual(Object.keys(body.questions.action.criteria), ['wait', 'suggest'])
        assert.equal(body.state.candidate, undefined)
        return Response.json({ answers: { action: { choice, confidence: 1 } } })
      },
      stream: async function* () { throw new Error('must not generate'); yield {} as StreamChunk },
    }), /decision-invalid-response/)
  }
})

test('unfinished ideas and requests not to execute can still receive discussion', async () => {
  for (const draft of ['我想一周做完聊天和社区，我还想', '先别执行，我在想是否该先只做聊天']) {
    const result = await preview({ ...request, draft }, context, options)
    assert.equal(result.action, 'suggest')
  }
})

test('running tasks skip both decision and auxiliary generation', async () => {
  const result = await preview({ ...request, running: true }, context, {
    ...options,
    fetch: async () => { throw new Error('must not classify while busy') },
    persona: async () => { throw new Error('must not assemble persona while busy') },
    stream: async function* () { throw new Error('must not generate'); yield {} as StreamChunk },
  })
  assert.equal(result.action, 'wait')
})
