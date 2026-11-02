export const PREVIEW_PATH = '/dsh-keyboard-duplex/preview'
export const MAX_DRAFT_LENGTH = 8_000
export const DECISION_INTERVAL_MS = 750
export const DECISION_PER_MINUTE = 40

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface PreviewRequest {
  sessionId: string
  draft: string
  draftRev: number
  contextRevision: number
  model: ModelSelection
  running: boolean
  previousAdvice?: string
}

export interface PreviewMetrics {
  decisionMs: number
  mainMs?: number
  firstTextMs?: number
  totalMs: number
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }
}

export type PreviewResult =
  | { action: 'wait'; metrics: PreviewMetrics }
  | {
    action: 'suggest'
    advice: string
    model: ModelSelection
    metrics: PreviewMetrics
  }

/** Only a complete, nonempty opinion can be displayed. */
export function parseSuggestion(text: string): { advice: string } {
  const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/, '$1'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-suggestion')
  const { advice } = value as Record<string, unknown>
  if (typeof advice !== 'string' || !advice.trim() || advice.length > 600) {
    throw new Error('invalid-suggestion')
  }
  return { advice: advice.trim() }
}

export function sameModel(a: ModelSelection, b: ModelSelection): boolean {
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}
