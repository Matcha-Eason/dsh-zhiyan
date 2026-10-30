import { DECISION_INTERVAL_MS, DECISION_PER_MINUTE, MAX_DRAFT_LENGTH, sameModel, type ModelSelection, type PreviewRequest, type PreviewResult } from '../protocol.ts'
import { prefixCandidates } from '../candidates.ts'

export type PreviewStatus = 'idle' | 'thinking' | 'suggested' | 'sending' | 'accepted' | 'queued' | 'error' | 'blocked'
type SubmitPrefix = (request: { draftRev: number; sendEnd: number; consumeEnd: number; mode: 'queue' | 'steer' }) => Promise<{ kind: 'accepted' | 'skipped' | 'error' | 'disposed' }>

export interface DraftSnapshot {
  sessionId: string
  draft: string
  draftRev: number
  contextRevision: number
  model: ModelSelection | null
  start: number
  end: number
  selectionVersion: number
  focused: boolean
  composing: boolean
  running: boolean
  blocked?: string
}

export interface Opinion {
  advice: string
  completion?: string
  basis: DraftSnapshot
  earlier: boolean
}

export interface PreviewState {
  enabled: boolean
  status: PreviewStatus
  detail?: string
  lastSubmission?: string
  opinion?: Opinion
  metrics?: PreviewResult['metrics']
  requests: number
  cancelled: number
}

const emptyState: PreviewState = { enabled: false, status: 'idle', requests: 0, cancelled: 0 }

/** A session owns one active request and the newest draft, never a keystroke queue. */
export class PreviewController {
  private state: PreviewState = emptyState
  private listeners = new Set<() => void>()
  private current?: DraftSnapshot
  private flight?: { input: DraftSnapshot; abort: AbortController }
  private timer?: ReturnType<typeof setTimeout>
  private due = 0
  private stable = ''
  private stableSince = 0
  private evaluated?: DraftSnapshot
  private suppressedDraft?: string
  private attempts: number[] = []
  private disposed = false
  private submitPrefix?: SubmitPrefix
  private submitting = false
  private draftClearVersion = 0

  constructor(private readonly request: (request: PreviewRequest, signal: AbortSignal) => Promise<PreviewResult>) {}

  bindSubmission(submit: SubmitPrefix | undefined): void { this.submitPrefix = submit }

  getSnapshot = (): PreviewState => this.state
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setEnabled(enabled: boolean): void {
    this.publish({ enabled, status: 'idle', detail: undefined, opinion: undefined })
    this.evaluated = undefined
    this.suppressedDraft = undefined
    this.due = Date.now() + 800
    if (!enabled) this.cancel()
    if (this.current) this.update(this.current)
  }

  update(next: DraftSnapshot): void {
    if (this.disposed) return
    const previous = this.current
    this.current = next
    const changed = !previous || next.draft !== previous.draft || next.draftRev !== previous.draftRev
    const contextChanged = !previous || !sameContext(previous, next)
    if (!next.draft.trim()) {
      if (changed) this.draftClearVersion++
      this.cancel()
      this.evaluated = undefined
      this.suppressedDraft = undefined
      this.stable = ''
      this.publish({ status: 'idle', detail: undefined, opinion: undefined, lastSubmission: undefined, metrics: undefined })
      return
    }
    const opinion = this.state.opinion
    if (opinion) {
      if (!sameContext(opinion.basis, next) || !next.draft.startsWith(opinion.basis.draft)) {
        this.publish({ opinion: undefined })
      } else {
        this.publish({ opinion: {
          ...opinion, earlier: next.draft !== opinion.basis.draft,
          completion: exactCandidate(opinion.basis, next) ? opinion.completion : undefined,
        } })
      }
    }
    if (!this.state.enabled || next.blocked) {
      this.cancel()
      this.publish({ opinion: undefined, status: this.state.enabled && next.blocked ? 'blocked' : 'idle', detail: next.blocked })
      return
    }
    if (previous?.blocked && !next.blocked) this.publish({ status: 'idle', detail: undefined })
    if (this.flight && (!sameContext(this.flight.input, next) || !next.draft.startsWith(this.flight.input.draft))) this.cancel()
    if (changed || contextChanged) {
      const now = Date.now()
      const stable = next.draft.match(/^[\s\S]*[。！？!?；;，,\n]/)?.[0] ?? ''
      if (stable !== this.stable || contextChanged) { this.stable = stable; this.stableSince = now }
      this.due = stable.trim().length >= 8 ? Math.min(now + 800, this.stableSince + 300) : now + 800
      if (this.suppressedDraft !== next.draft) this.suppressedDraft = undefined
    }
    this.schedule()
  }

  /** Enter and explicit dismissal stop preview work without touching the native submission. */
  dismiss(): void {
    this.suppressedDraft = this.current?.draft
    this.cancel()
    this.publish({ opinion: undefined, status: 'idle', detail: undefined })
  }

  accept(span: { start: number; end: number; draftRev: number }, insert: (text: string, span: { start: number; end: number; draftRev: number }) => boolean): boolean {
    const input = this.current
    const opinion = this.state.opinion
    if (!input || !this.state.enabled || !opinion?.completion || !exactCandidate(opinion.basis, input)
      || input.draftRev !== span.draftRev || input.start !== span.start || input.end !== span.end) return false
    this.suppressedDraft = input.draft + opinion.completion
    const inserted = insert(opinion.completion, span)
    if (!inserted) this.suppressedDraft = undefined
    this.cancel()
    this.publish({ opinion: opinion ? { ...opinion, completion: undefined } : undefined, status: 'idle', detail: undefined })
    return inserted
  }

  /** Unmounting a composer invalidates its caret and abandons its preview, preserving the session's opt-in. */
  detach(): void {
    this.cancel()
    this.current = undefined
    this.submitPrefix = undefined
    this.publish({ opinion: undefined, status: 'idle', detail: undefined })
  }

  dispose(): void {
    this.detach()
    this.disposed = true
    this.listeners.clear()
  }

  private publish(patch: Partial<PreviewState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.flight && !this.flight.abort.signal.aborted) {
      this.flight.abort.abort()
      this.publish({ cancelled: this.state.cancelled + 1 })
    }
    // Keep the slot occupied until its promise settles, including adapters slow to abort.
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const input = this.current
    if (!this.state.enabled || !input || this.disposed || input.blocked || this.submitting) return
    if (input.composing || !input.focused || input.start !== input.end || input.end !== input.draft.length) {
      return
    }
    if (input.draft.length > MAX_DRAFT_LENGTH || !/[\p{L}\p{N}]/u.test(input.draft) || input.draft.trim().length < 4 || input.draft.trimStart().startsWith('/')) {
      if (input.draft.length > MAX_DRAFT_LENGTH) this.publish({ status: 'blocked', detail: '草稿超过 8,000 字' })
      return
    }
    if (input.draft === this.suppressedDraft || (this.evaluated && sameContext(this.evaluated, input)
      && input.draft === this.evaluated.draft && input.draftRev === this.evaluated.draftRev)) return
    if (this.flight) return
    const now = Date.now()
    this.attempts = this.attempts.filter(at => at > now - 60_000)
    const earliest = Math.max(this.due, (this.attempts.at(-1) ?? -Infinity) + DECISION_INTERVAL_MS,
      this.attempts.length >= DECISION_PER_MINUTE ? this.attempts[0]! + 60_000 : 0)
    this.timer = setTimeout(() => { this.timer = undefined; void this.run() }, Math.max(0, earliest - now))
  }

  private async run(): Promise<void> {
    const input = this.current
    if (!input?.model || this.flight || !this.state.enabled || input.blocked || this.disposed) return
    const flight = { input, abort: new AbortController() }
    this.flight = flight
    this.evaluated = input
    this.attempts.push(Date.now())
    this.publish({ status: 'thinking', detail: undefined, requests: this.state.requests + 1 })
    try {
      const result = await this.request({
        sessionId: input.sessionId, draft: input.draft, draftRev: input.draftRev,
        contextRevision: input.contextRevision, model: input.model,
        running: input.running,
        previousAdvice: this.state.opinion?.advice,
      }, flight.abort.signal)
      const latest = this.current
      if (flight.abort.signal.aborted || !latest || !sameContext(input, latest) || !latest.draft.startsWith(input.draft)) return
      this.publish({ metrics: result.metrics })
      if (result.action === 'submit_prefix' || result.action === 'steer') {
        if (!exactCandidate(input, latest)) return
        const candidate = prefixCandidates(latest.draft).find(item => item.id === result.candidate.id
          && item.sendEnd === result.candidate.sendEnd && item.consumeEnd === result.candidate.consumeEnd)
        if (!candidate || (result.action === 'steer' && !latest.running)) return
        if (!this.submitPrefix) { this.publish({ status: 'blocked', detail: '请重建 DSH，当前输入接口不支持前句提交' }); return }
        const clearVersion = this.draftClearVersion
        this.submitting = true
        this.publish({ opinion: undefined, status: 'sending', lastSubmission: input.draft.slice(0, candidate.sendEnd) })
        const outcome = await this.submitPrefix({ ...candidate, draftRev: input.draftRev, mode: result.action === 'steer' ? 'steer' : 'queue' })
        if (this.disposed || !this.state.enabled || this.current?.sessionId !== input.sessionId) return
        if (outcome.kind === 'error') {
          // Explicit re-enable is required after a failed admission; restored text must not auto-resubmit.
          this.cancel()
          this.publish({ enabled: false, status: 'error', detail: '发送未成功，已保留文字；自动发送已暂停，请检查 DSH 提示后手动发送或重新开启' })
        } else if (clearVersion === this.draftClearVersion) {
          this.publish({ status: outcome.kind === 'accepted' ? (input.running && result.action === 'submit_prefix' ? 'queued' : 'accepted') : 'idle', detail: undefined })
        }
        return
      }
      this.publish({ status: result.action === 'wait' ? (this.state.opinion ? 'suggested' : 'idle') : 'suggested',
        ...(result.action === 'suggest' ? { opinion: {
          advice: result.advice, completion: exactCandidate(input, latest) ? result.completion : undefined,
          basis: input, earlier: latest.draft !== input.draft,
        } } : {}),
      })
    } catch (error) {
      if (!flight.abort.signal.aborted) this.publish({ status: 'error', detail: previewError(error), opinion: undefined })
    } finally {
      this.submitting = false
      if (this.flight === flight) this.flight = undefined
      if (this.state.status === 'thinking') this.publish({ status: this.state.opinion ? 'suggested' : 'idle' })
      this.schedule()
    }
  }
}

function sameContext(a: DraftSnapshot, b: DraftSnapshot): boolean {
  return a.sessionId === b.sessionId && a.contextRevision === b.contextRevision
    && a.running === b.running
    && a.model !== null && b.model !== null && sameModel(a.model, b.model)
}

export function exactCandidate(a: DraftSnapshot, b: DraftSnapshot): boolean {
  return sameContext(a, b) && a.draft === b.draft && a.draftRev === b.draftRev
    && a.start === b.start && a.end === b.end && b.end === b.draft.length && b.start === b.end
    && a.selectionVersion === b.selectionVersion && b.focused && !b.composing && !b.blocked
}

function previewError(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code === 'decision-key-missing') return '请配置 System 1 的 Token Plan 密钥'
  if (code === 'preview-timeout') return '预览超时 · 下次编辑再试'
  if (code === 'preview-rate-limit') return '预览过于频繁 · 下次编辑再试'
  if (code === 'model-changed' || code === 'context-changed') return '会话已变化 · 下次编辑再试'
  if (code === 'invalid-suggestion' || code === 'main-incomplete-response') return '主模型未返回完整意见 · 下次编辑再试'
  if (code.startsWith('main-provider-error:')) return `主模型调用失败（${code.slice('main-provider-error:'.length)}）· 下次编辑再试`
  if (code === 'local-only') return '第一版请通过 localhost 打开 DSH'
  if (code === 'persona-unavailable') return '暂时无法读取当前 DSH 人设 · 下次编辑再试'
  return '预览暂不可用 · 下次编辑再试'
}
