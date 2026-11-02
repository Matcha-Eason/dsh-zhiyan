import { DECISION_INTERVAL_MS, DECISION_PER_MINUTE, MAX_DRAFT_LENGTH, type PreviewRequest, type PreviewResult } from '../protocol.ts'

export type PreviewStatus = 'idle' | 'thinking' | 'suggested' | 'error' | 'blocked'

export interface DraftSnapshot {
  sessionId: string
  draft: string
  draftRev: number
  contextRevision: number
  start: number
  end: number
  focused: boolean
  composing: boolean
  running: boolean
  blocked?: string
}

export interface Opinion {
  advice: string
  basis: DraftSnapshot
  earlier: boolean
}

export interface PreviewState {
  enabled: boolean
  status: PreviewStatus
  detail?: string
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

  constructor(private readonly request: (request: PreviewRequest, signal: AbortSignal) => Promise<PreviewResult>) {}

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
      this.cancel()
      this.evaluated = undefined
      this.suppressedDraft = undefined
      this.stable = ''
      this.publish({ status: 'idle', detail: undefined, opinion: undefined, metrics: undefined })
      return
    }
    const opinion = this.state.opinion
    if (opinion) {
      if (!sameContext(opinion.basis, next) || !next.draft.startsWith(opinion.basis.draft)) {
        this.publish({ opinion: undefined })
      } else {
        this.publish({ opinion: {
          ...opinion, earlier: next.draft !== opinion.basis.draft,
        } })
      }
    }
    if (!this.state.enabled || next.blocked || next.running) {
      this.cancel()
      this.publish({ opinion: undefined, status: this.state.enabled ? 'blocked' : 'idle',
        detail: next.blocked ?? (next.running ? '正式任务进行中，讨论暂停' : undefined) })
      return
    }
    if ((previous?.blocked || previous?.running) && !next.blocked && !next.running) this.publish({ status: 'idle', detail: undefined })
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

  /** Unmounting a composer invalidates its caret and abandons its preview, preserving the session's opt-in. */
  detach(): void {
    this.cancel()
    this.current = undefined
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
    if (!this.state.enabled || !input || this.disposed || input.blocked || input.running) return
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
    if (!input || this.flight || !this.state.enabled || input.blocked || input.running || this.disposed) return
    const flight = { input, abort: new AbortController() }
    this.flight = flight
    this.evaluated = input
    this.attempts.push(Date.now())
    this.publish({ status: 'thinking', detail: undefined, requests: this.state.requests + 1 })
    try {
      const result = await this.request({
        sessionId: input.sessionId, draft: input.draft, draftRev: input.draftRev,
        contextRevision: input.contextRevision,
        running: input.running,
        previousAdvice: this.state.opinion?.advice,
      }, flight.abort.signal)
      const latest = this.current
      if (flight.abort.signal.aborted || !latest || !sameContext(input, latest) || !latest.draft.startsWith(input.draft)) return
      this.publish({ metrics: result.metrics })
      this.publish({ status: result.action === 'wait' ? (this.state.opinion ? 'suggested' : 'idle') : 'suggested',
        ...(result.action === 'suggest' ? { opinion: {
          advice: result.advice,
          basis: input, earlier: latest.draft !== input.draft,
        } } : {}),
      })
    } catch (error) {
      if (!flight.abort.signal.aborted) this.publish({ status: 'error', detail: previewError(error), opinion: undefined })
    } finally {
      if (this.flight === flight) this.flight = undefined
      if (this.state.status === 'thinking') this.publish({ status: this.state.opinion ? 'suggested' : 'idle' })
      this.schedule()
    }
  }
}

function sameContext(a: DraftSnapshot, b: DraftSnapshot): boolean {
  return a.sessionId === b.sessionId && a.contextRevision === b.contextRevision
    && a.running === b.running
}

function previewError(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code === 'decision-key-missing') return '请在设置 → 模型 → 知言填写 JEV API Key'
  if (code === 'main-key-missing') return '请在设置 → 模型 → 知言填写 DeepSeek API Key'
  if (code === 'preview-timeout') return '预览超时 · 下次编辑再试'
  if (code === 'preview-rate-limit') return '预览过于频繁 · 下次编辑再试'
  if (code === 'context-changed') return '会话已变化 · 下次编辑再试'
  if (code === 'invalid-suggestion' || code === 'main-incomplete-response') return '主模型未返回完整意见 · 下次编辑再试'
  if (code.startsWith('main-provider-error:')) return `主模型调用失败（${code.slice('main-provider-error:'.length)}）· 下次编辑再试`
  if (code === 'local-only') return '第一版请通过 localhost 打开 DSH'
  if (code === 'persona-unavailable') return '暂时无法读取当前 DSH 人设 · 下次编辑再试'
  return '预览暂不可用 · 下次编辑再试'
}
