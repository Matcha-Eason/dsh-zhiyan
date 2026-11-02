import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { apply } from '../src/index.ts'
import { MAIN_MODEL, PREVIEW_PATH, SETTINGS_PATH } from '../src/protocol.ts'
import { contextProjection } from '../src/host/context.ts'

const request = {
  running: false, sessionId: 'test-session', draft: '我想做一个提醒应用', draftRev: 1, contextRevision: 8,
  model: { provider: 'session-provider', model: 'selected-main', reasoningEffort: 'off' },
}

function host(t: TestContext) {
  const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const records = new Map<string, any>(['deepseek', 'jev'].map(id => ['dsh-keyboard-duplex/' + id, { kind: 'api-key', key: 'test-key-never-log' }]))
  const events = new Map<string, (...args: any[]) => void>()
  const calls: GenerateOptions[] = []
  let disposed = 0
  let decisions = 0
  t.mock.method(globalThis, 'fetch', async () => {
    decisions++
    return Response.json({ answers: { action: { choice: 'suggest' } } })
  })
  const state = {
    busy: false, revision: 8, selected: request.model as typeof request.model | null, delay: false,
    personaPrefix: '你是当前会话的搭档，工作区是 {{cwd}}。', personaSuffix: '称呼用户为队长。', personaError: false,
  }
  const agent = { id: request.sessionId }
  const assemblies: AssembleContext[] = []
  const ctx = {
    sessionProjections: { register() {} },
    agents: { get: () => ({ status: state.busy ? 'running' : 'idle' }) },
    sessionController: { resolveAgent: async (id: string) => {
      assert.equal(id, request.sessionId)
      return state.personaError ? { error: new Error('session unavailable') } : { agent }
    } },
    systemPrompt: { assemble: async (context: AssembleContext) => {
      assert.equal(context.agent, agent)
      assert.equal(context.scope, agent)
      assemblies.push(context)
      return {
        sections: [
          { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
          { name: 'deployment:persona-prefix', text: state.personaPrefix },
          { name: 'tool:bash', text: 'tool instructions must not be inherited' },
          { name: 'deployment:persona-suffix', text: state.personaSuffix },
        ],
        contexts: [{ name: 'runtime', text: 'runtime context must not be inherited' }],
        tools: [], variables: { cwd: '/session/workspace' },
      }
    } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'global', model: 'wrong-model' }) },
    sessionQuery: { observeSession: async () => ({
      projections: { values: { keyboardDuplex: { revision: state.revision, messages: [] }, modelSelection: { next: state.selected } } },
      [Symbol.dispose]() { disposed++ },
    }) },
    credentials: {
      readRecord: async (key: string) => records.get(key),
      describeRecord: async (key: string) => ({ configured: records.has(key), writable: true }),
      modifyRecord: async (key: string, mutate: (record: any) => Promise<any>) => { records.set(key, await mutate(records.get(key))); events.get('credentials/record-updated')?.(key) },
      deleteRecord: async (key: string) => { records.delete(key); events.get('credentials/record-updated')?.(key) },
    },
    inject() {},
    llm: {
      registerAdapter: () => ({ replace() {} }),
      resolveCallConfig: async (selection: object) => selection,
      stream: async function* (options: GenerateOptions): AsyncIterable<StreamChunk> {
        calls.push(options)
        if (state.delay) await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }))
        yield { type: 'text-delta', index: 0, text: '{"advice":"先缩小范围。"}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    logger: { info() {} },
    on: (name: string, listener: (...args: any[]) => void) => { events.set(name, listener) },
    effect: (setup: () => (() => void) | void) => { const dispose = setup(); if (dispose) t.after(dispose) },
    webServer: { register: (route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }) => { handlers.set(route.path, route.handler); return () => {} } },
  }
  apply(ctx as unknown as Context)
  return {
    state, calls, events, assemblies, records,
    get decisions() { return decisions }, get disposed() { return disposed },
    async post(body: unknown = request, headers: Record<string, string> = {}, path = PREVIEW_PATH, method = 'POST') {
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
        headers: { host: 'localhost:3082', 'content-type': 'application/json', ...headers },
        socket: { remoteAddress: '127.0.0.1' }, method,
      })
      let status = 0, result = ''
      const res = Object.assign(new EventEmitter(), {
        destroyed: false, writableEnded: false,
        writeHead(code: number) { status = code },
        end(value: string) { result = value; this.writableEnded = true },
      })
      await handlers.get(path)!(req as unknown as IncomingMessage, res as unknown as ServerResponse)
      return { status, body: JSON.parse(result) }
    },
  }
}

test('host uses fixed official Pro / Off regardless of the session model', async t => {
  const app = host(t)
  const response = await app.post()
  assert.equal(response.status, 200)
  assert.equal(response.body.advice, '先缩小范围。')
  assert.equal(app.calls[0]!.provider, MAIN_MODEL.provider)
  assert.equal(app.calls[0]!.model, MAIN_MODEL.model)
  assert.equal(app.calls[0]!.reasoningEffort, 'off')
  assert.equal(app.disposed, 1)
  assert.deepEqual(app.calls[0]!.tools, [])
})

test('all generated fields receive the current session persona with rendered variables', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 })
  const app = host(t)
  assert.equal((await app.post()).status, 200)
  const system = app.calls[0]!.system!
  assert.match(system, /你是当前会话的搭档，工作区是 \/session\/workspace。/)
  assert.match(system, /称呼用户为队长。/)
  assert.match(system, /所有用户可见的生成内容/)
  assert.match(system, /只输出 JSON：\{"advice":"\.\.\."\}/)
  assert.doesNotMatch(system, /completion/)
  assert.doesNotMatch(system, /tool instructions|runtime context|你是用户边写边聊的思考伙伴/)
  assert.equal(app.assemblies[0]!.signal!.aborted, false)
  app.state.personaPrefix = '新设定：使用克制的书面语。'
  app.state.personaSuffix = ''
  t.mock.timers.tick(6_000)
  assert.equal((await app.post()).status, 200)
  assert.match(app.calls[1]!.system!, /新设定：使用克制的书面语。/)
  assert.doesNotMatch(app.calls[1]!.system!, /队长|当前会话的搭档/)
})

test('unavailable session persona reports an error without an invented fallback role', async t => {
  const app = host(t)
  app.state.personaError = true
  const response = await app.post()
  assert.equal(response.status, 503)
  assert.equal(response.body.error, 'persona-unavailable')
  assert.equal(app.calls.length, 0)
})

test('stale context is rejected and client model overrides are ignored', async t => {
  const app = host(t)
  assert.equal((await app.post({ ...request, contextRevision: 7 })).body.error, 'context-changed')
  assert.equal(app.decisions, 0)
  const response = await app.post({ ...request, model: { provider: 'foreign', model: 'wrong', reasoningEffort: 'high' } })
  assert.equal(response.status, 200)
  assert.equal(app.calls[0]!.provider, MAIN_MODEL.provider)
  assert.equal(app.calls[0]!.reasoningEffort, 'off')
})

test('stale running state and foreign Origin are refused before any model call', async t => {
  const app = host(t)
  app.state.busy = true
  assert.equal((await app.post()).body.error, 'context-changed')
  app.state.busy = false
  assert.equal((await app.post(request, { origin: 'https://foreign.example' })).status, 403)
  assert.equal((await app.post(request, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal(app.decisions, 0)
})

test('host rate guard also limits a second browser tab', async t => {
  const app = host(t)
  assert.equal((await app.post()).status, 200)
  assert.equal((await app.post()).status, 429)
  assert.equal(app.calls.length, 1)
})

for (const cause of ['session/event'] as const) test(`${cause} aborts the auxiliary call without touching the agent`, async t => {
  const app = host(t)
  app.state.delay = true
  const pending = app.post()
  await setImmediate()
  assert.equal(app.calls.length, 1)
  assert.equal((await app.post()).body.error, 'preview-in-flight')
  app.events.get(cause)!({ id: request.sessionId }, { type: 'model/selection' })
  assert.equal(app.calls[0]!.signal!.aborted, true)
  assert.equal((await pending).body.error, 'preview-cancelled')
  assert.equal(app.disposed, 1)
})

test('a blank session uses the plugin model without requiring a session selection', async t => {
  const app = host(t)
  app.state.selected = null
  assert.equal((await app.post({ ...request, model: { provider: 'global', model: 'wrong-model' } })).status, 200)
  assert.equal(app.calls[0]!.provider, MAIN_MODEL.provider)
  assert.equal(app.calls[0]!.model, MAIN_MODEL.model)
})

test('invalid or oversized draft fails before reading provider credentials', async t => {
  const app = host(t)
  assert.equal((await app.post({ ...request, draft: 'x'.repeat(8_001) })).status, 400)
  assert.equal((await app.post({ ...request, draft: 'x'.repeat(50_000) })).status, 413)
  assert.equal(app.decisions, 0)
})

test('context projection is bounded and never carries reasoning or tool results', () => {
  let state = { revision: -1, messages: [] } as Parameters<typeof contextProjection.apply>[0]
  for (let seq = 0; seq < 9; seq++) {
    state = contextProjection.apply(state, {
      type: 'assistant/message', seq, surfaceOp: 'append',
      data: { message: { content: [{ type: 'text', text: 'x'.repeat(2_000) }, { type: 'reasoning', text: 'private-thinking' }] } },
    } as any)
  }
  assert.equal(state.messages.length, 6)
  assert.equal(state.messages[0]!.seq, 3)
  assert.equal(state.messages[0]!.text.length, 1_200)
  assert.equal(JSON.stringify(state).includes('private-thinking'), false)
  assert.equal(contextProjection.apply(state, { type: 'tool/result', surfaceOp: 'append', data: {} } as any), state)
  const replaced = contextProjection.apply(state, { type: 'system/message', seq: 10, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 8 }, data: {} } as any)
  assert.equal(replaced.messages.length, 0)
  assert.equal(replaced.revision, 10)
})

test('Models settings save keys separately without exposing secrets, and reject foreign writes', async t => {
  const app = host(t)
  app.records.clear()
  const status = await app.post({}, {}, SETTINGS_PATH, 'GET')
  assert.deepEqual(status.body.deepseek, { configured: false, writable: true })
  const foreign = await app.post({ provider: 'deepseek', apiKey: 'secret-for-test' }, { origin: 'https://foreign.example' }, SETTINGS_PATH)
  assert.equal(foreign.status, 403)
  assert.equal(app.records.size, 0)
  const saved = await app.post({ provider: 'deepseek', apiKey: ' secret-for-test ' }, {}, SETTINGS_PATH)
  assert.equal(saved.status, 200)
  assert.equal(saved.body.deepseek.configured, true)
  assert.equal(saved.body.jev.configured, false)
  assert.equal(JSON.stringify(saved.body).includes('secret-for-test'), false)
  assert.equal(app.records.get('dsh-keyboard-duplex/deepseek').key, 'secret-for-test')
  assert.equal((await app.post({ provider: 'deepseek', apiKey: '  ' }, {}, SETTINGS_PATH)).status, 400)
  assert.equal((await app.post({ provider: 'other', apiKey: 'value' }, {}, SETTINGS_PATH)).status, 400)
  assert.equal((await app.post({ provider: 'deepseek', apiKey: 'value', baseURL: 'https://foreign.example' }, {}, SETTINGS_PATH)).status, 400)
  const removed = await app.post({ provider: 'deepseek' }, {}, SETTINGS_PATH, 'DELETE')
  assert.equal(removed.body.deepseek.configured, false)
  assert.equal(app.records.size, 0)
  assert.equal(app.decisions, 0, 'saving credentials does not call models')
})

test('missing official credentials never fall back to ambient or session providers', async t => {
  const app = host(t)
  app.records.delete('dsh-keyboard-duplex/jev')
  assert.equal((await app.post()).body.error, 'decision-key-missing')
  app.records.set('dsh-keyboard-duplex/jev', { kind: 'api-key', key: 'jev-test' })
  app.records.delete('dsh-keyboard-duplex/deepseek')
  assert.equal((await app.post()).body.error, 'main-key-missing')
  assert.equal(app.decisions, 0)
  assert.equal(app.calls.length, 0)
})

test('changing a credential cancels an in-flight opinion', async t => {
  const app = host(t)
  app.state.delay = true
  const pending = app.post()
  await setImmediate()
  assert.equal(app.calls.length, 1)
  const saved = await app.post({ provider: 'jev', apiKey: 'replacement-test' }, {}, SETTINGS_PATH)
  assert.equal(saved.status, 200)
  assert.equal(app.calls[0]!.signal!.aborted, true)
  assert.equal((await pending).body.error, 'preview-cancelled')
})
