import { useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '../host/context.ts'
import { PreviewController, type DraftSnapshot, type PreviewStatus } from './controller.ts'

const statuses: Record<PreviewStatus, { icon: string; label: string }> = {
  idle: { icon: '', label: '' },
  thinking: { icon: '👀', label: '正在看你的草稿' },
  suggested: { icon: '💡', label: '有一条意见' },
  error: { icon: '⚠️', label: '需要留意' },
  blocked: { icon: '⏸️', label: '暂不可用' },
}

const buttonStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border-l3, #ccc)', borderRadius: 7,
  background: 'transparent', color: 'inherit', padding: '3px 8px', cursor: 'pointer', font: 'inherit', fontSize: 12,
}

export interface ComposerInjected {
  controller: PreviewController
  shortcuts: Shortcuts
}

/** Native state supplies text; the scoped DOM bridge supplies focus, composition and selection only. */
export function ComposerControl({
  controller, shortcuts, sessionId, useInput, useSession, useProjection, inputActions,
}: ComposerInjected & PropsRuntime<'conversation.input.right'>) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const input = useInput(value => value)
  const session = useSession(value => value)
  const context = useProjection('keyboardDuplex')
  const anchor = useRef<HTMLButtonElement>(null)
  const read = useRef<(() => DraftSnapshot) | null>(null)
  const latest = useRef({ input, session, context })
  latest.current = { input, session, context }

  useLayoutEffect(() => {
    const card = anchor.current?.closest('[data-composer-card]')
    const editor = card?.querySelector<HTMLElement>('[data-composer-input]')
    if (!editor) return
    const snapshot = (): DraftSnapshot => {
      const { input, session, context } = latest.current
      const span = inputActions.captureInsertion()
      const selection = document.getSelection()
      const focused = document.activeElement === editor && selection !== null
        && editor.contains(selection.anchorNode) && editor.contains(selection.focusNode)
      const composing = editor.hasAttribute('data-composer-composing')
      const blocked = session.removed || session.openState !== 'open' ? '等待会话就绪'
          : session.subagent !== null ? '第一版仅支持主会话'
            : input.phase !== 'plain' ? '原生输入交互中，预览暂停'
              : input.attachmentIds.length > 0 || input.occurrences.length > 0 ? '第一版只分析纯文本，请移除附件或引用'
                : !context ? '等待预览服务就绪' : undefined
      return {
        sessionId, draft: input.draft, draftRev: input.draftRev,
        contextRevision: context?.revision ?? -1,
        start: span.start, end: span.end, focused, composing, running: session.running, blocked,
      }
    }
    read.current = snapshot
    const update = () => controller.update(snapshot())
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || editor.hasAttribute('data-composer-composing')) return
      if (event.key === 'Enter' && !event.shiftKey) controller.dismiss()
    }
    const observer = new MutationObserver(update)
    observer.observe(editor, { attributes: true, attributeFilter: ['data-composer-composing'] })
    editor.addEventListener('keydown', keydown, true)
    editor.addEventListener('focus', update)
    editor.addEventListener('blur', update)
    document.addEventListener('selectionchange', update)
    const offKeys = shortcuts.observeFixedInput(event => {
      if (event.type !== 'keydown' || event.context.modal !== null || !editor.contains(event.context.target)) return
      const key = event.gesture
      if (key.composing || key.defaultPrevented || key.repeat || key.shift || key.control || key.alt || key.meta) return
      if (key.code === 'Escape' && controller.getSnapshot().opinion) {
        controller.dismiss()
        event.consume()
      }
    })
    update()
    return () => {
      read.current = null
      observer.disconnect()
      editor.removeEventListener('keydown', keydown, true)
      editor.removeEventListener('focus', update)
      editor.removeEventListener('blur', update)
      document.removeEventListener('selectionchange', update)
      offKeys()
      controller.detach()
    }
  }, [controller, inputActions, sessionId, shortcuts])

  useLayoutEffect(() => { if (read.current) controller.update(read.current()) }, [controller, input, session, context])

  return <button ref={anchor} type="button" style={buttonStyle} aria-pressed={state.enabled}
    title="开启后主模型会对草稿给出意见、建议或吐槽。按 Enter 或点击发送后，DSH 才会收到正式任务。"
    onMouseDown={event => event.preventDefault()}
    onClick={() => controller.setEnabled(!state.enabled)}>
    {state.enabled ? '● 边写边聊' : '边写边聊'}
  </button>
}

export function OpinionCard({ controller }: { controller: PreviewController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  if (!state.enabled && state.status !== 'error') return null
  const opinion = state.opinion
  const status = statuses[state.status]
  const label = state.detail ?? status.label
  return <div data-keyboard-duplex role="region" aria-label="边写边聊提示" style={{
    border: '1px solid var(--dsw-alias-border-l3, #ddd)', borderRadius: 10,
    padding: '8px 12px', minHeight: 76, margin: '4px auto', fontSize: 13, lineHeight: 1.6,
    boxSizing: 'border-box', width: 'calc(100% - 32px)', maxWidth: 'var(--dsh-chat-content-width, 900px)',
    background: 'var(--dsw-alias-bg-l1, Canvas)', color: 'var(--dsw-alias-text-primary, CanvasText)',
  }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 24, fontSize: 14 }}>
      {status.icon && <span role="status" aria-live="polite" aria-label={label}
        title={[label, opinion?.earlier ? '基于上一句' : '',
          state.metrics ? `本次 ${state.metrics.totalMs} ms · System 1 ${state.metrics.decisionMs} ms · 本会话 ${state.requests} 次判断` : '',
        ].filter(Boolean).join('\n')}>
        <span aria-hidden="true">{status.icon}</span>
      </span>}
      <span style={{ flex: 1 }} />
      {opinion && <button type="button" style={buttonStyle} onMouseDown={event => event.preventDefault()} onClick={() => controller.dismiss()} aria-label="清除本条意见" title="清除意见，保留提示框">×</button>}
    </div>
    {opinion && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 3 }}>{opinion.advice}</div>}
    {state.status === 'error' && state.detail && <details style={{ fontSize: 12 }}><summary aria-label="查看错误详情" title={state.detail}>⋯</summary>{state.detail}</details>}
  </div>
}
