import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-query'
import { contextProjection } from './host/context.ts'
import { registerModels } from './host/models.ts'
import { preview } from './host/preview.ts'
import { HttpError, readJson, requireLocalRequest } from './host/http.ts'
import { DECISION_INTERVAL_MS, DECISION_PER_MINUTE, MAX_DRAFT_LENGTH, MAIN_MODEL, PREVIEW_PATH } from './protocol.ts'

export const name = 'dsh-keyboard-duplex'
export const inject = ['webServer', 'credentials', 'llm', 'agents', 'sessions', 'sessionQuery', 'sessionProjections', 'sessionController', 'systemPrompt']

const requestSchema = z.object({
  sessionId: z.string().min(1).max(256),
  draft: z.string().min(4).max(MAX_DRAFT_LENGTH),
  draftRev: z.number().int().nonnegative(),
  contextRevision: z.number().int().min(-1),
  running: z.boolean(),
  previousAdvice: z.string().max(600).optional(),
})

export function apply(ctx: Context): void {
  registerModels(ctx)
  ctx.sessionProjections.register(contextProjection)
  const active = new Map<string, AbortController>()
  const attempts = new Map<string, number[]>()
  const suggestions = new Map<string, number[]>()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'model/selection' || event.type === 'user/message' || event.type === 'assistant/message'
      || event.type === 'request/header' || ('surfaceOp' in event && typeof event.surfaceOp === 'object')) {
      active.get(session.id)?.abort()
    }
  })
  ctx.on('credentials/record-updated', key => {
    if (key === credentialKey(name, 'deepseek') || key === credentialKey(name, 'jev')) {
      for (const controller of active.values()) controller.abort()
    }
  })
  ctx.on('session/disposed', session => {
    active.get(session.id)?.abort()
    attempts.delete(session.id)
    suggestions.delete(session.id)
  })
  ctx.effect(() => () => { for (const controller of active.values()) controller.abort(); active.clear() }, 'keyboard-duplex: cancel previews')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: PREVIEW_PATH,
    async handler(req, res) {
      const controller = new AbortController()
      const disconnected = () => controller.abort()
      req.once('aborted', disconnected)
      res.once('close', disconnected)
      let sessionId: string | undefined
      let outcome = 'rejected'
      const started = performance.now()
      try {
        requireLocalRequest(req)
        if (req.method !== 'POST') throw new HttpError(405, 'post-required')
        const parsed = requestSchema.safeParse(await readJson(req))
        if (!parsed.success) throw new HttpError(400, 'invalid-draft')
        const request = parsed.data
        sessionId = request.sessionId
        const id = SessionId(sessionId)
        if (active.has(id)) throw new HttpError(409, 'preview-in-flight')
        active.set(id, controller)
        if ((ctx.agents.get(id)?.status === 'running') !== request.running) throw new HttpError(409, 'context-changed')
        using observation = await ctx.sessionQuery.observeSession(id, { signal: controller.signal })
        const context = observation.projections?.values.keyboardDuplex
        if (!context || context.revision !== request.contextRevision) throw new HttpError(409, 'context-changed')
        const now = Date.now()
        for (const [key, times] of attempts) {
          if ((times.at(-1) ?? 0) <= now - 60_000) attempts.delete(key)
        }
        const times = (attempts.get(id) ?? []).filter(time => time > now - 60_000)
        if (times.length >= DECISION_PER_MINUTE || (times.length > 0 && now - times.at(-1)! < DECISION_INTERVAL_MS)) throw new HttpError(429, 'preview-rate-limit')
        const credential = await ctx.credentials.readRecord(credentialKey(name, 'jev'))
        if (credential?.kind !== 'api-key' || !credential.key) throw new HttpError(503, 'decision-key-missing')
        const mainKey = await ctx.credentials.readRecord(credentialKey(name, 'deepseek'))
        if (mainKey?.kind !== 'api-key' || !mainKey.key) throw new HttpError(503, 'main-key-missing')
        controller.signal.throwIfAborted()
        attempts.set(id, [...times, now])
        outcome = 'started'
        const result = await preview(request, context, {
          apiKey: credential.key, signal: controller.signal, fetch,
          stream: options => ctx.llm.stream(options),
          persona: async signal => {
            const resolved = await ctx.sessionController.resolveAgent(id)
            if ('error' in resolved) throw new HttpError(503, 'persona-unavailable')
            signal.throwIfAborted()
            const assembly = await ctx.systemPrompt.assemble(assembleContextFor(resolved.agent, signal))
            return renderPrompt({
              ...assembly,
              sections: assembly.sections.filter(section => section.name === 'harness:identity'
                || section.name === PERSONA_PREFIX_SECTION || section.name === PERSONA_SUFFIX_SECTION),
            })
          },
          decisionTimeoutMs: 4_000, mainTimeoutMs: 30_000,
          allowSuggestion: () => {
            const at = Date.now()
            const recent = (suggestions.get(id) ?? []).filter(time => time > at - 60_000)
            if (recent.length >= 6 || at - (recent.at(-1) ?? -Infinity) < 5_000) return false
            suggestions.set(id, [...recent, at])
            return true
          },
        })
        controller.signal.throwIfAborted()
        if ((ctx.agents.get(id)?.status === 'running') !== request.running) throw new HttpError(409, 'context-changed')
        outcome = result.action
        ctx.logger.info('keyboard-duplex metrics %s', JSON.stringify({ sessionId, model: MAIN_MODEL.model, ...result.metrics }))
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(result))
      } catch (error) {
        const code = error instanceof HttpError ? error.message
          : controller.signal.aborted ? 'preview-cancelled'
            : error instanceof Error && /^(decision-http-\d+|decision-invalid-response|main-incomplete-response|main-unexpected-tool-call|main-provider-error:[\w-]+|invalid-suggestion|preview-timeout)$/.test(error.message)
              ? error.message : error instanceof Error && error.name === 'TimeoutError' ? 'preview-timeout' : 'preview-failed'
        outcome = code
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(error instanceof HttpError ? error.status : controller.signal.aborted ? 409 : 502, {
            'Content-Type': 'application/json', 'Cache-Control': 'no-store',
          })
          res.end(JSON.stringify({ error: code }))
        }
      } finally {
        req.off('aborted', disconnected)
        res.off('close', disconnected)
        if (sessionId !== undefined && active.get(sessionId) === controller) active.delete(sessionId)
        ctx.logger.info('keyboard-duplex request %s', JSON.stringify({ sessionId, outcome, totalMs: Math.round(performance.now() - started) }))
      }
    },
  }), 'keyboard-duplex: local draft preview')
}
