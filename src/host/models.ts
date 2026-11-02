import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { catalogModelInfo, registerDeepSeekProvider, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { z } from 'zod'
import { MAIN_MODEL, SETTINGS_PATH } from '../protocol.ts'
import { HttpError, readJson, requireLocalRequest } from './http.ts'

const owner = 'dsh-keyboard-duplex'
const providerSchema = z.enum(['deepseek', 'jev'])
const saveSchema = z.object({ provider: providerSchema, apiKey: z.string().trim().min(1).max(4_096) }).strict()
const removeSchema = z.object({ provider: providerSchema }).strict()

/** Own the fixed official route and its API-key-only Models settings surface. */
export function registerModels(ctx: Context): void {
  const connection = resolveAdapterOptions({
    baseURL: 'https://api.deepseek.com/anthropic',
    thinking: 'disabled', reasoningEffort: 'off', maxTokens: 8_192,
    streamIdleTimeoutMs: 30_000, retryPolicy: { mode: 'normal', maxRetries: 0 },
    models: [{ id: MAIN_MODEL.model, name: 'DeepSeek Pro · 知言', inputModalities: ['text'] }],
  })
  registerDeepSeekProvider(ctx, MAIN_MODEL.provider, {
    options: () => connection,
    providerName: '知言 · DeepSeek 官方',
    discoverModels: async provider => connection.models.map(model => catalogModelInfo(provider, model)),
    admit: (_connection, model) => {
      if (model !== MAIN_MODEL.model) throw new LlmError('知言只支持 DeepSeek Pro', 'UNKNOWN_MODEL')
    },
    resolveAuth: async () => {
      const record = await ctx.credentials.readRecord(credentialKey(owner, 'deepseek'))
      if (record?.kind !== 'api-key' || !record.key) throw new HttpError(503, 'main-key-missing')
      return { headers: { Authorization: `Bearer ${record.key}` } }
    },
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: SETTINGS_PATH,
    async handler(req, res) {
      try {
        requireLocalRequest(req)
        if (req.method === 'POST' || req.method === 'DELETE') {
          const body = await readJson(req)
          if (req.method === 'POST') {
            const parsed = saveSchema.safeParse(body)
            if (!parsed.success) throw new HttpError(400, 'invalid-credential')
            await ctx.credentials.modifyRecord(credentialKey(owner, parsed.data.provider), async () => ({ kind: 'api-key', key: parsed.data.apiKey }))
          } else {
            const parsed = removeSchema.safeParse(body)
            if (!parsed.success) throw new HttpError(400, 'invalid-credential')
            await ctx.credentials.deleteRecord(credentialKey(owner, parsed.data.provider))
          }
        } else if (req.method !== 'GET') {
          throw new HttpError(405, 'method-not-allowed')
        }
        const [deepseek, jev] = await Promise.all([
          ctx.credentials.describeRecord(credentialKey(owner, 'deepseek')),
          ctx.credentials.describeRecord(credentialKey(owner, 'jev')),
        ])
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ deepseek, jev }))
      } catch (error) {
        res.writeHead(error instanceof HttpError ? error.status : 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ error: error instanceof HttpError ? error.message : 'credential-save-failed' }))
      }
    },
  }), 'keyboard-duplex: model credentials')
}
