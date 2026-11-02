import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId, type LlmAdapter } from '@deepseek-ai/dsh-llm'
import { registerModels } from '../src/host/models.ts'
import { MAIN_MODEL } from '../src/protocol.ts'

test('native adapter sends only official Pro requests with thinking disabled and rereads the saved key', async t => {
  const home = await mkdtemp(join(tmpdir(), 'zhiyan-models-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })
  let adapter: LlmAdapter
  let key = 'first-test-key'
  const requests: { url: string; headers: Headers; body: any }[] = []
  const events = [
    { type: 'message_start', message: { id: 'test-message', type: 'message', role: 'assistant', model: MAIN_MODEL.model, content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"advice":"先做一个闭环。"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ]
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  })
  registerModels({
    inject() {}, on() {}, get() {},
    credentials: { readRecord: async () => ({ kind: 'api-key', key }) },
    llm: { registerAdapter(providers: string[], value: LlmAdapter) { assert.deepEqual(providers, [MAIN_MODEL.provider]); adapter = value; return { replace() {} } } },
    effect(setup: () => void) { setup() },
    webServer: { register() { return () => {} } },
  } as unknown as Context)
  const prepared = await adapter!.prepareCall(MAIN_MODEL.provider, MAIN_MODEL.model)
  assert.deepEqual(prepared.model.reasoning?.efforts.map(effort => effort.id), ['off'])
  for (const expectedKey of ['first-test-key', 'replacement-test-key']) {
    key = expectedKey
    const chunks = []
    for await (const chunk of prepared.stream({
      ...MAIN_MODEL, reasoningEffort: ReasoningEffortId('off'), maxTokens: 1_200, temperature: 0.7,
      messages: [{ role: 'user', content: [{ type: 'text', text: '讨论这个想法。' }] }], tools: [],
    })) chunks.push(chunk)
    assert.ok(chunks.some(chunk => chunk.type === 'text-delta'))
    assert.equal(requests.at(-1)!.headers.get('Authorization'), `Bearer ${expectedKey}`)
  }
  assert.equal(requests[0]!.url, 'https://api.deepseek.com/anthropic/v1/messages')
  assert.equal(requests[0]!.body.model, 'deepseek-v4-pro')
  assert.deepEqual(requests[0]!.body.thinking, { type: 'disabled' })
  assert.equal(requests[0]!.body.max_tokens, 1_200)
  assert.equal(requests[0]!.body.temperature, 0.7)
  await assert.rejects(adapter!.prepareCall(MAIN_MODEL.provider, 'other-model'), /只支持 DeepSeek Pro/)
  assert.equal(requests.length, 2)
})
