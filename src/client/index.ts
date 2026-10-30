import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { PREVIEW_PATH, type PreviewResult } from '../protocol.ts'
import { PreviewController } from './controller.ts'
import { ComposerControl, OpinionCard } from './components.tsx'

export const name = 'dsh-keyboard-duplex-client'
export const inject = ['slots', 'sessions', 'shortcuts', 'modelDirectories', 'remote', 'remote.session']

// Host and Client declare different `sessions` services; this package builds both halves.
export function apply(ctx: Omit<Context, 'sessions'> & { sessions: ISessions }): void {
  const controllers = new Map<SessionId, PreviewController>()
  const controllerFor = (sessionId: SessionId): PreviewController => {
    const existing = controllers.get(sessionId)
    if (existing) return existing
    const scope = ctx.sessions.scope(sessionId)
    if (!scope) throw new Error('keyboard-duplex: missing session scope')
    const controller = new PreviewController(async (request, signal) => {
      const response = await fetch(PREVIEW_PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request), signal,
      })
      const body = await response.json() as PreviewResult | { error: string }
      if (!response.ok || 'error' in body) throw new Error('error' in body ? body.error : 'preview-failed')
      return body
    })
    controllers.set(sessionId, controller)
    scope.effect(() => () => { controller.dispose(); controllers.delete(sessionId) }, 'keyboard-duplex: session lifetime')
    return controller
  }
  ctx.effect(() => () => { for (const controller of controllers.values()) controller.dispose(); controllers.clear() }, 'keyboard-duplex: plugin lifetime')
  ctx.effect(() => ctx.shortcuts.registerFixed({
    id: 'keyboard-duplex.accept' as ShortcutCommandId,
    label: () => '采纳边写边聊续写', keys: ['Tab'], bindings: [{ code: 'Tab', modifiers: [] }], group: 'input',
  }), 'keyboard-duplex: Tab shortcut')
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'keyboard-duplex-toggle', order: 25,
    inject: sessionId => ({ controller: controllerFor(sessionId), shortcuts: ctx.shortcuts, directory: ctx.modelDirectories.directoryFor(sessionId) }),
  }, ComposerControl))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'keyboard-duplex-opinion', order: 20,
    inject: sessionId => ({ controller: controllerFor(sessionId) }),
  }, OpinionCard))
}
